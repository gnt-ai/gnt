import { API_URL } from "@/lib/api-url";

// GitHub's own registered callback URL for the App (github.com/settings/
// apps/<slug> -> "Callback URL") -- fixed at https://gntai.dev/api/github/
// callback, not something this route can change. GitHub redirects the
// BROWSER here after an install, carrying installation_id/setup_action and
// (for every install this app itself started, via /v1/settings/github/app/
// install-url) a signed state token.
//
// This route does no auth/DB work itself -- it's a thin proxy to apps/api's
// GET /v1/settings/github/app/callback, which does the real work and whose only
// "auth" IS that state token (see gnt/github/app_auth.py's
// verify_install_state for why: GitHub's redirect carries no session of
// its own, and a CLI-initiated install may land in a browser that was
// never signed in to gntai.dev at all). The state token, not this route's
// own session check, is what proves which org the install belongs to.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const installationId = url.searchParams.get("installation_id");
  const setupAction = url.searchParams.get("setup_action");
  const state = url.searchParams.get("state");

  if (setupAction !== "install" || !installationId || !state) {
    return htmlPage(
      "GitHub connection failed",
      "That install link looks incomplete or already used. Run `gnt connect github` again, or click Connect GitHub from your organization settings.",
    );
  }

  let apiRes: Response;
  try {
    apiRes = await fetch(
      `${API_URL}/v1/settings/github/app/callback?${new URLSearchParams({ installation_id: installationId, setup_action: setupAction, state })}`,
      { cache: "no-store" },
    );
  } catch {
    return htmlPage("GitHub connection failed", "Could not reach gnt's servers to finish connecting. Try again.");
  }

  if (!apiRes.ok) {
    const body = await apiRes.json().catch(() => null);
    return htmlPage("GitHub connection failed", body?.detail ?? "Something went wrong. Run `gnt connect github` again.");
  }

  const data = (await apiRes.json()) as { origin: "web" | "cli"; repo_url: string };

  // A CLI-initiated install (`gnt connect github`) has no reason to land
  // the browser in the dashboard -- the CLI is already polling
  // GET /v1/settings/github on its own and will report success in the
  // terminal. A web-initiated one (the organization settings page) sends
  // the browser back there to see the connection reflected.
  if (data.origin === "cli") {
    return htmlPage("Connected", `Connected to ${data.repo_url}. You can close this tab and return to your terminal.`);
  }
  return Response.redirect(new URL("/settings/organization?github=connected", url.origin), 302);
}

function htmlPage(title: string, message: string): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>gnt.ai</title></head>` +
      `<body style="font-family: system-ui, sans-serif; padding: 3rem; text-align: center;">` +
      `<p><strong>${escapeHtml(title)}</strong></p><p>${escapeHtml(message)}</p></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
