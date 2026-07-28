import { Resend } from "resend";
import { renderEmail, paragraph, mutedParagraph, codeBox, button } from "@/lib/email-template";

// gntai.dev is verified in Resend (DKIM/SPF/DMARC records live) -- this is
// a real sending address, not the onboarding@resend.dev placeholder that
// only delivers to the account owner. Overridable via RESEND_FROM_EMAIL.
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL ?? "gnt.ai <notifications@gntai.dev>";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// AuthScreen shows a "check your terminal" hint on the code step when this
// is false, instead of leaving a visitor staring at "code sent" with
// nothing arriving and no indication why — the RESEND_API_KEY-unset
// fallback below is intentional (see apps/web/README), but only obvious
// from a server log, not from the page itself.
export function isEmailConfigured(): boolean {
  return resend !== null;
}

// inviterName/organizationName/etc. below are user-controlled (a display
// name, an org name someone typed in) — interpolating them into an HTML
// body directly would let one person's chosen name inject markup into an
// email another person receives.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function sendEmail(params: { to: string; subject: string; html: string; logFallback: string }): Promise<void> {
  if (!resend) {
    // Safe no-op, not a silent failure — same pattern configuredSocialProviders
    // uses for an unconfigured OAuth provider: light up the real integration
    // only once its env vars are actually set, log clearly until then.
    console.log(`[email] ${params.logFallback} (RESEND_API_KEY not set, not actually sent)`);
    return;
  }

  const { error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: [params.to],
    subject: params.subject,
    html: params.html,
  });

  if (error) {
    // Deliberately not surfaced to the caller as a failure (Better Auth's
    // own docs: don't let email-send outcome affect response timing/shape
    // for auth endpoints, or the response becomes an oracle for "does this
    // address have an account" — see sendVerificationOTP's callers in
    // lib/auth.ts, neither awaits this for its result). Logged here is as
    // far as a real delivery failure can surface without reintroducing
    // that side channel.
    console.error(`[email] failed to send to ${params.to}:`, error);
  }
}

export async function sendOrganizationInvitationEmail(params: {
  to: string;
  inviteLink: string;
  organizationName: string;
  inviterName: string;
  role: string;
}): Promise<void> {
  const inviterName = escapeHtml(params.inviterName);
  const organizationName = escapeHtml(params.organizationName);
  const role = escapeHtml(params.role);

  const html = renderEmail({
    preheader: `${params.inviterName} invited you to join ${params.organizationName} on gnt.ai`,
    bodyHtml: [
      paragraph(
        `<strong>${inviterName}</strong> invited you to join <strong>${organizationName}</strong> on <a href="https://gntai.dev" style="color:#201d1d;text-decoration:none;">gnt.ai</a> as ${role}.`,
      ),
      `<div style="margin:24px 0;">${button("Accept invitation", params.inviteLink)}</div>`,
      mutedParagraph("If you weren't expecting this, you can ignore this email."),
    ].join(""),
  });

  await sendEmail({
    to: params.to,
    subject: `${params.inviterName} invited you to ${params.organizationName} on gnt.ai`,
    html,
    logFallback: `invitation email: ${params.to} invited to ${params.organizationName} as ${params.role}`,
  });
}

export async function sendOtpEmail(params: { to: string; otp: string }): Promise<void> {
  const html = renderEmail({
    preheader: `${params.otp} is your gnt.ai sign-in code`,
    bodyHtml: [
      paragraph(
        'Your <a href="https://gntai.dev" style="color:#201d1d;text-decoration:none;">gnt.ai</a> sign-in code:',
      ),
      codeBox(params.otp),
      mutedParagraph("Expires in 5 minutes. If you didn't request this, you can ignore this email."),
    ].join(""),
  });

  await sendEmail({
    to: params.to,
    subject: `${params.otp} is your gnt.ai sign-in code`,
    html,
    // The code itself in a dev-only console log is fine — this branch only
    // runs when RESEND_API_KEY is unset, i.e. never in production.
    logFallback: `sign-in code for ${params.to}: ${params.otp}`,
  });
}
