import { createAuthClient } from "better-auth/react";
import {
  organizationClient,
  jwtClient,
  emailOTPClient,
  twoFactorClient,
} from "better-auth/client/plugins";

export const authClient = createAuthClient({
  // No onTwoFactorRedirect/twoFactorPage here — better-auth's own built-in
  // 2FA sign-in hook only fires for /sign-in/email, /sign-in/username, and
  // /sign-in/phone-number (confirmed in its installed source, dist/plugins/
  // two-factor/index.mjs), none of which this app ever calls — sign-in is
  // exclusively email OTP and OAuth (see lib/auth.ts). Both land the caller
  // in a real, already-authenticated session with no twoFactorRedirect
  // response to catch. The gate for those two paths lives at the
  // application layer instead — components/two-factor-gate.tsx, mounted on
  // every page reachable right after sign-in — which still verifies the
  // code through this same plugin's real /two-factor/verify-totp endpoint
  // (confirmed that endpoint checks the submitted code against the
  // session's own user even when a full session already exists, not just
  // the pre-session cookie flow the built-in hook uses).
  plugins: [organizationClient(), jwtClient(), emailOTPClient(), twoFactorClient()],
});

export const { useSession, signIn, signOut } = authClient;
