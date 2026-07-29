import { betterAuth } from "better-auth";
import { organization, jwt, emailOTP, twoFactor, bearer } from "better-auth/plugins";
import { APIError } from "better-auth/api";
import { headers } from "next/headers";
import { Pool } from "pg";
import { cache } from "react";
import { sendOrganizationInvitationEmail, sendOtpEmail } from "@/lib/email";
import { canInviteAcrossOrgs } from "@/lib/invite-eligibility";

// Same physical Postgres database apps/api's Alembic migrations manage —
// Better Auth owns its own tables (user, session, account, organization,
// member, invitation, jwks, ...) via its own migration tool (`pnpm exec
// auth migrate`), coexisting with Alembic's tables, not replacing them.
// Deliberately NOT the restricted gnt_app role apps/api's runtime uses —
// gnt_app has no DDL rights, and Better Auth needs to create its own
// schema. See apps/web/README (once written) for the production role
// this should use instead of a superuser.
export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Only registers a provider if its credentials are actually configured —
// an empty clientId/clientSecret pair would otherwise silently ship a
// broken "Sign in with X" button rather than just not showing one.
function configuredSocialProviders() {
  const providers: Record<string, { clientId: string; clientSecret: string }> = {};
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    providers.google = {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    };
  }
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    providers.github = {
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
    };
  }
  return providers;
}

// Client components can't read server-only env vars directly — a page
// server component calls this and passes the plain booleans down, instead
// of duplicating GOOGLE_CLIENT_ID/GITHUB_CLIENT_ID into NEXT_PUBLIC_ vars
// just to answer "should this button render".
export function enabledOAuthProviders(): { google: boolean; github: boolean } {
  const providers = configuredSocialProviders();
  return { google: "google" in providers, github: "github" in providers };
}

// BETTER_AUTH_URL was found set to an empty string in production (a
// deploy-config slip, not a code bug) -- every invite link built by
// interpolating it directly came out as a bare "/accept-invitation/<id>"
// with no host, which mail clients can't resolve to anything. This falls
// back to the real production domain instead of trusting the env var
// blindly a second time, same posture as email.ts's FROM_EMAIL fallback.
function siteUrl(): string {
  return process.env.BETTER_AUTH_URL || "https://gntai.dev";
}


export const auth = betterAuth({
  database: db,
  // Default storage is in-memory, which doesn't work as a real limit on
  // Vercel — each serverless invocation can land on a fresh isolate with
  // its own empty counter, so a brute-force loop against the OTP verify
  // endpoint would barely be slowed down. Database storage shares the
  // counter the same way the org/session tables already do.
  rateLimit: {
    enabled: true,
    storage: "database",
  },
  // No password auth at all — OAuth (Google/GitHub) plus email OTP below
  // cover both "already has an identity provider" and "just wants email"
  // without owning a password database, password-reset flow, or breach
  // surface. Zero real users at the point this was decided, so there was
  // no migration to design around either.
  socialProviders: configuredSocialProviders(),
  plugins: [
    emailOTP({
      // Both the returning-user and brand-new-user paths always use
      // "sign-in" — the plugin auto-registers on first verified OTP, so
      // sign-in and sign-up are the same request from here. See
      // components/auth-screen.tsx, which is the one caller.
      async sendVerificationOTP({ email, otp }) {
        await sendOtpEmail({ to: email, otp });
      },
      // This plugin bakes in its own rate limit
      // on /email-otp/send-verification-otp (keyed by IP+path, same
      // mechanism as the top-level rateLimit block above — see Better
      // Auth's rate-limit docs). That's the real signup/sign-in abuse
      // surface here (no password auth at all, so this send is the only
      // per-request cost/spam vector), but Better Auth's rate limiter has
      // no concept of "how many real distinct people share this IP" —
      // office wifi, a shared dev machine, or (as happened while shipping
      // this) one person legitimately testing the flow a handful of times
      // all look identical to a bot loop under a flat per-IP cap. 3 per 5
      // minutes turned out too tight for real use, not just bots — bumped
      // to 8 per 10 minutes (~48/hour sustained ceiling, up from ~36, but
      // the real change is headroom *within* a session: someone fixing a
      // typo, hitting resend, and letting a stale code lapse before
      // trying again now fits comfortably instead of getting locked out
      // by their third legitimate attempt).
      rateLimit: {
        window: 600,
        max: 8,
      },
    }),
    organization({
      // Without this, nothing stops one person from creating a second org
      // to get a second repo connection and a second 14-day trial on the
      // same subscription's worth of usage — github_connections.org_id is
      // unique (one repo per org), so an org, not a person, is where that
      // limit actually lives. A person who's already a member of one org
      // (owner or otherwise) can't create another.
      //
      // Known gap, not introduced here: org_offboarding.py only hard-deletes
      // gnt's own org_id-scoped application tables -- it never touches
      // Better Auth's own organization/member rows, so a person who fully
      // offboards would stay permanently blocked from ever creating a new
      // org, since their stale membership row never actually goes away.
      // Pre-existing (offboarding didn't clean this up before this check
      // existed either), but this check is what makes the consequence real
      // for the first time. Needs offboarding to also delete the Better
      // Auth organization/member rows, not a fix for this hook itself.
      async allowUserToCreateOrganization(user) {
        const { rows } = await db.query('select 1 from "member" where "userId" = $1 limit 1', [user.id]);
        return rows.length === 0;
      },
      // Better Auth generates no invitation URL itself — this is the
      // documented pattern (id in the path, resolved by
      // app/accept-invitation/[id]/page.tsx).
      async sendInvitationEmail(data) {
        const inviteLink = `${siteUrl()}/accept-invitation/${data.id}`;
        await sendOrganizationInvitationEmail({
          to: data.email,
          inviteLink,
          organizationName: data.organization.name,
          inviterName: data.inviter.user.name,
          role: data.role,
        });
      },
      organizationHooks: {
        // orgs.plan_tier lives in apps/api's Alembic-managed schema (same
        // physical database, see this file's own top comment), kept in
        // sync by apps/api's Stripe webhook handler (gnt/billing.py) --
        // "pro" ($149/mo, gnt/plan_limits.py) is the only tier that allows
        // a person to belong to more than one org at once.
        async beforeCreateInvitation({ invitation }) {
          const { rows: existingUsers } = await db.query('select id from "user" where email = $1 limit 1', [
            invitation.email,
          ]);
          const existingUserId = existingUsers[0]?.id;
          if (!existingUserId) return;

          const { rows: otherMemberships } = await db.query(
            'select 1 from "member" where "userId" = $1 and "organizationId" != $2 limit 1',
            [existingUserId, invitation.organizationId],
          );
          const hasOtherMembership = otherMemberships.length > 0;
          if (!hasOtherMembership) return;

          const { rows: orgRows } = await db.query("select plan_tier from orgs where id = $1", [
            invitation.organizationId,
          ]);
          if (!canInviteAcrossOrgs({ hasOtherMembership, planTier: orgRows[0]?.plan_tier ?? null })) {
            throw new APIError("BAD_REQUEST", {
              message:
                "That person already belongs to another organization on gnt.ai. " +
                "Upgrade to the pro plan to invite people who are already on another team.",
            });
          }
        },
      },
    }),
    // apps/api verifies these via JWKS (/api/auth/jwks), a zero-Node
    // pattern (jwt.py's PyJWKClient) matching what Clerk's own JWKS
    // verification used before — see auth/better_auth.py. RS256 (not the
    // EdDSA default) to match PyJWT's broadest compatibility; confirmed
    // empirically that Better Auth's own docs show "RSA256" in one
    // RSA-specific example, which isn't a real JOSE algorithm identifier —
    // RS256 is the one `jose` (Better Auth's underlying JWT library)
    // recognizes.
    jwt({
      jwt: {
        expirationTime: "15m",
        definePayload: async (session) => {
          const orgId = session.session.activeOrganizationId;
          // Present regardless of org state (including the early return
          // below) -- apps/api/src/gnt/auth/better_auth.py's
          // require_platform_admin checks this against an env-var
          // allowlist and isn't org-scoped, so a platform admin with no
          // active org selected still needs a usable token.
          if (!orgId) return { email: session.user.email };
          // definePayload only gets {session, user}, not the caller's org
          // membership row — the member table (role: owner/admin/member,
          // see the organization plugin's default roles) is a direct
          // query away since we already hold the same pg.Pool. Compact "o"
          // claim ({id, rol}) matches the shape auth/better_auth.py's
          // _ADMIN_ROLES check expects.
          const { rows } = await db.query(
            'select role from "member" where "organizationId" = $1 and "userId" = $2 limit 1',
            [orgId, session.user.id],
          );
          return { o: { id: orgId, rol: rows[0]?.role ?? null }, email: session.user.email };
        },
      },
      jwks: {
        keyPairConfig: {
          alg: "RS256",
        },
      },
    }),
    // Required for owner/admin (see the enrollment
    // UI at app/(account)/settings/security/page.tsx and the sign-in gate at
    // app/verify-2fa/page.tsx for the rest of this feature).
    //
    // allowPasswordless is not optional here: this app never creates a
    // credential (password) account for anyone (see the no-password-auth
    // comment above), and better-auth's own shouldRequirePassword() helper
    // unconditionally requires a password on /two-factor/enable and
    // /two-factor/disable unless this is set — checked its actual
    // installed source (node_modules/better-auth/dist/utils/password.mjs)
    // rather than guess, since getting this wrong would mean the enable
    // endpoint 400s forever asking for a password nobody could ever supply.
    // With allowPasswordless: true it still requires one IF the user
    // somehow has a credential account (defense in depth, not reachable
    // here) — see shouldRequirePassword's own logic.
    twoFactor({
      issuer: "gnt.ai",
      allowPasswordless: true,
    }),
    // Lets a server-side, non-browser caller authenticate an internal
    // auth.api.* call via `Authorization: Bearer <session token>` instead
    // of a signed cookie -- exactly the "mobile/desktop client" case
    // Better Auth's own docs describe it for. Used by
    // app/api/cli/org/*'s routes: gnt org's CLI commands verify a cli-key
    // against apps/api first (that key carries no Better Auth identity of
    // its own -- see auth/better_auth.py's OrgContext.user_id comment for
    // why), then mint a short-lived session for one of the target org's
    // real admins here and act through Better Auth's own organization
    // endpoints under that session, so the normal role/permission checks
    // still apply for real instead of being reimplemented by hand.
    bearer(),
  ],
});

// Server-component pages that render MarketingHeader call this and pass
// the result down as a prop, so the correct Sign in/Sign up/Sign out
// state is in the initial HTML instead of a client-side useSession()
// fetch flashing a skeleton first. cache() dedupes repeat calls within
// the same request (there's normally just one caller per page, but this
// is free insurance if that changes). better-auth's client-side
// useSession() has no seed/initialData option (checked its session atom
// source), so MarketingHeader still runs its own useSession() and only
// uses this initial value until that resolves.
export const getServerSession = cache(async () => auth.api.getSession({ headers: await headers() }));

// Same jwt() plugin, same "/token" endpoint authClient.token() hits
// client-side (lib/auth-client.ts) -- minted server-side instead so
// page.tsx server components can call apps/api themselves and hand
// dashboard content down already-rendered, instead of every dashboard
// page shipping an empty shell that mounts, mints its own token, and
// shows "Loading…" while it fetches. cache()'d for the same reason
// getServerSession is: one mint per request, not one per fetch.
export const getServerApiToken = cache(async () => {
  const { token } = await auth.api.getToken({ headers: await headers() });
  return token;
});
