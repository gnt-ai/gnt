import type { NextConfig } from "next";

// Better Auth runs entirely in our own server process against our own DB —
// no third-party script/frame/connect domains to allow the way Clerk
// needed (clerk.accounts.dev, clerk.com, Cloudflare Turnstile challenges).
// OAuth sign-in (Google/GitHub) is a top-level redirect, not a CSP-governed
// fetch/frame, so no provider domains need allowlisting here either.
const apiOrigin = process.env.NEXT_PUBLIC_API_URL
  ? new URL(process.env.NEXT_PUBLIC_API_URL).origin
  : "";

// React dev mode wants eval() to reconstruct stack traces across bundles —
// never used in production builds, so only relax the policy in dev.
const devEval = process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'";

const csp = [
  `default-src 'self'`,
  `script-src 'self' 'unsafe-inline'${devEval}`,
  `style-src 'self' 'unsafe-inline'`,
  `img-src 'self' data:`,
  `font-src 'self' data:`,
  // No localhost/127.0.0.1 allowance here: /cli-login used to deliver a
  // freshly-minted key to a local server the CLI ran on an ephemeral port,
  // but apps/cli/src/commands/login.ts now polls the real API instead
  // (Chrome's Local Network Access permission prompt broke the old
  // loopback POST) — cli-login-client.tsx only ever fetches apiOrigin.
  // Allowing arbitrary localhost ports in a production CSP is a real gap
  // regardless (XSS could pivot into whatever's running on the visitor's
  // own machine), so this isn't carried forward now that nothing needs it.
  `connect-src 'self' ${apiOrigin}`.trim(),
  `frame-src 'self'`,
  `worker-src 'self' blob:`,
  `frame-ancestors 'none'`,
  `base-uri 'self'`,
  `form-action 'self'`,
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
