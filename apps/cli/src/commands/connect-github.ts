import { createInterface, emitKeypressEvents, type Key } from "node:readline";
import open from "open";
import { API_URL } from "../config.js";
import { loadApiKey } from "../credentials.js";
import { dim, fail, muted, ok, spinner, text } from "../theme.js";

function readLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// No prompt/masked-input library in this CLI's dependencies (matches its
// zero-dependency stance) — extends review.ts's raw-mode keypress pattern,
// but line-buffered (Enter submits, backspace edits) rather than
// single-keypress dispatch.
function readMaskedLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("gnt connect github --pat needs an interactive terminal."));
      return;
    }

    let buffer = "";
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const cleanup = () => {
      process.stdin.removeListener("keypress", onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };

    const onKeypress = (str: string, keyInfo: Key) => {
      if (keyInfo.ctrl && keyInfo.name === "c") {
        cleanup();
        console.log();
        reject(new Error("aborted"));
        return;
      }
      if (keyInfo.name === "return" || keyInfo.name === "enter") {
        cleanup();
        console.log();
        resolve(buffer);
        return;
      }
      if (keyInfo.name === "backspace") {
        if (buffer.length > 0) {
          buffer = buffer.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }
      if (str && !keyInfo.ctrl) {
        buffer += str;
        process.stdout.write("*");
      }
    };

    process.stdin.on("keypress", onKeypress);
  });
}

// The legacy per-org PAT flow (routers/github.py's POST /v1/settings/github)
// — kept reachable via `--pat`, not removed, but no longer the default: the
// GitHub App below is the connect path going forward. Everything from here
// down is unchanged from before the App migration.
async function connectGithubPat(key: string): Promise<void> {
  console.log(
    muted(
      "Create a fine-grained token at github.com/settings/personal-access-tokens/new, scoped to " +
        "just this one repo, with repository permissions Contents (read/write), Pull requests " +
        "(read/write), Issues (read/write), and Webhooks (read/write).",
    ),
  );

  let repoUrl: string;
  let pat: string;
  try {
    repoUrl = await readLine(muted("Repo URL (https://github.com/<owner>/<repo>): "));
    pat = await readMaskedLine(muted("Personal access token: "));
  } catch (err) {
    console.error(fail(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  let res: Response;
  try {
    res = await fetch(`${API_URL}/v1/settings/github`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ repo_url: repoUrl, pat }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    console.error(fail(`Failed to reach ${API_URL}: ${err instanceof Error ? err.message : err}`));
    process.exit(1);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    console.error(fail(`Failed to connect (${res.status}): ${body?.detail ?? "unknown error"}`));
    process.exit(1);
  }
  const data = await res.json();
  console.log(ok(`Connected to ${data.repo_url} (${dim(data.default_branch)}).`));
}

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The GitHub App flow: fine-grained permissions, an auto-managed webhook,
// hourly-expiring installation tokens instead of a long-lived PAT sitting in
// gnt's database. No login_id/state round-trip needed on this side at all —
// unlike `gnt login` (which is minting the very credential this CLI needs),
// this command already holds a working API key, so it just opens the
// browser to GitHub's own install page (server-signed state binds the
// install to this key's org — see apps/api/src/gnt/github/app_auth.py) and
// polls the ordinary GET /v1/settings/github endpoint for the connection to
// show up.
async function connectGithubApp(key: string, { upgrade }: { upgrade: boolean }): Promise<void> {
  const wait = spinner(upgrade ? "Upgrading to the GitHub App…" : "Connecting GitHub…");
  try {
    let res: Response;
    try {
      res = await fetch(`${API_URL}/v1/settings/github/app/install-url?origin=cli`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new Error(`Failed to reach ${API_URL}: ${err instanceof Error ? err.message : err}`);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(`Failed to start the GitHub App install (${res.status}): ${body?.detail ?? "unknown error"}`);
    }
    const { url } = (await res.json()) as { url: string };
    wait.stop();
    console.log(dim(url));
    open(url).catch(() => {
      console.log(text("Couldn't open a browser automatically — open the URL above manually."));
    });

    const wait2 = spinner("Waiting for you to finish the install in your browser…");
    const deadline = Date.now() + INSTALL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const statusRes = await fetch(`${API_URL}/v1/settings/github`, {
        headers: { Authorization: `Bearer ${key}` },
      }).catch(() => undefined);
      if (statusRes?.ok) {
        const data = await statusRes.json();
        if (data.connected && data.connection_type === "app") {
          wait2.stop(ok(`Connected to ${data.repo_url} via the GitHub App (${dim(data.default_branch)}).`));
          return;
        }
      }
      await sleep(POLL_INTERVAL_MS);
    }
    wait2.stop();
    throw new Error("Timed out waiting for the GitHub App install to complete.");
  } catch (err) {
    wait.stop();
    console.error(fail(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
}

export async function connectGithub(options: { upgrade?: boolean; pat?: boolean } = {}): Promise<void> {
  const key = loadApiKey();
  if (options.pat) {
    await connectGithubPat(key);
    return;
  }
  await connectGithubApp(key, { upgrade: Boolean(options.upgrade) });
}
