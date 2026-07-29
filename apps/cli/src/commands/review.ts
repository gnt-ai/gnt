import { emitKeypressEvents, type Key } from "node:readline";
import { API_URL } from "../config.js";
import { loadApiKey } from "../credentials.js";
import { bold, box, confidenceColor, dim, error as errorColor, fail, muted, success, text, wrapText } from "../theme.js";

interface Rule {
  id: string;
  title: string;
  body: string;
  confidence: number;
  tags: string[];
  version: number;
}

const REQUEST_TIMEOUT_MS = 10_000;
const MIN_BOX_WIDTH = 40;
const MAX_BOX_WIDTH = 76;

// A hung API/store means a hung keypress handler in the review loop below —
// there's no deadline anywhere else here to fall back on, so every request
// needs its own bound.
function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function fetchPending(key: string): Promise<Rule[]> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${API_URL}/v1/rules?status=in_review`, {
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch {
    console.error(fail("Timed out fetching rules for review."));
    process.exit(1);
  }
  if (!res.ok) {
    console.error(fail(`Failed to fetch rules for review (${res.status}).`));
    process.exit(1);
  }
  return res.json();
}

interface ActionResult {
  error: string | null;
  prUrl?: string;
}

function describeErrorDetail(detail: unknown, status: number): string {
  if (typeof detail === "string" && detail) return detail;
  // FastAPI's own generic validation-error responses put a list of issue
  // objects in `detail`, not a string — stringify rather than letting a
  // template literal render it as "[object Object]".
  if (detail !== undefined && detail !== null) return JSON.stringify(detail);
  return `request failed (${status})`;
}

async function actOnRule(
  key: string,
  id: string,
  action: "propose" | "reject",
): Promise<ActionResult> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${API_URL}/v1/rules/${id}/${action}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: action === "reject" ? JSON.stringify({}) : undefined,
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    return { error: timedOut ? "request timed out" : err instanceof Error ? err.message : String(err) };
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    return { error: describeErrorDetail(body?.detail, res.status) };
  }
  const prUrl = typeof body?.pr_url === "string" && body.pr_url ? body.pr_url : undefined;
  if (action === "propose" && !prUrl) {
    return { error: "server accepted the proposal but returned no PR url" };
  }
  return { error: null, prUrl };
}

function boxWidth(): number {
  const columns = process.stdout.columns ?? 80;
  // MIN_BOX_WIDTH is a preferred floor, not an absolute one — on a
  // genuinely narrow terminal (e.g. 20 columns) preferring it anyway
  // would overflow the box past the actual window.
  const available = Math.max(columns - 4, 10);
  const preferred = Math.max(MIN_BOX_WIDTH, Math.min(available, MAX_BOX_WIDTH));
  return Math.min(preferred, available);
}

type Message = { kind: "ok" | "error"; text: string } | null;

function render(rules: Rule[], index: number, message: Message): void {
  console.clear();
  const rule = rules[index];
  const width = boxWidth();

  const lines: string[] = [];
  lines.push(muted(`[${index + 1}/${rules.length}] in review · v${rule.version}`));
  lines.push("");
  lines.push(bold(rule.title));
  lines.push(...wrapText(rule.body, width).map((line) => text(line)));
  lines.push("");
  const confidencePct = `${Math.round(rule.confidence * 100)}%`;
  // Confidence is a model-assigned estimate, never
  // independently verified, same "(estimate)" labeling stale.ts already
  // applies to freshness.
  lines.push(
    `${muted("confidence")} ${confidenceColor(rule.confidence)(confidencePct)} ${muted("(estimate)")}   ${muted("tags")} ${dim(rule.tags.join(", ") || "none")}`,
  );
  if (message) {
    lines.push("");
    lines.push(message.kind === "ok" ? success(message.text) : errorColor(message.text));
  }

  console.log(box(lines, width));
  console.log();
  console.log(
    `${dim("j/k")} ${muted("navigate")}   ${dim("a")} ${muted("propose (opens a PR)")}   ${dim("r")} ${muted("reject")}   ${dim("q")} ${muted("quit")}`,
  );
}

export async function review(): Promise<void> {
  const key = loadApiKey();
  const rules = await fetchPending(key);

  if (rules.length === 0) {
    console.log(muted("Nothing to review."));
    return;
  }

  // Raw single-keypress input needs a real TTY — there's no sensible
  // line-based fallback for a j/k navigator, so this is the one hard
  // requirement rather than something worth degrading gracefully for.
  // Both stdin and stdout: the render loop uses console.clear() and box
  // drawing, which are just as meaningless piped as raw keypress input
  // would be without a real input TTY.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(fail("gnt review needs an interactive terminal."));
    process.exit(1);
  }

  let index = 0;

  await new Promise<void>((resolve) => {
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    let busy = false;

    const finish = () => {
      process.stdin.removeListener("keypress", onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve();
    };

    const onKeypress = (_str: string, keyInfo: Key) => {
      if (busy) return;

      if ((keyInfo.ctrl && keyInfo.name === "c") || keyInfo.name === "q") {
        console.log();
        finish();
        return;
      }
      if (keyInfo.name === "j") {
        index = Math.min(index + 1, rules.length - 1);
        render(rules, index, null);
        return;
      }
      if (keyInfo.name === "k") {
        index = Math.max(index - 1, 0);
        render(rules, index, null);
        return;
      }
      if (keyInfo.name === "a" || keyInfo.name === "r") {
        const action = keyInfo.name === "a" ? "propose" : "reject";
        const rule = rules[index];
        busy = true;
        actOnRule(key, rule.id, action)
          .then(({ error: actionError, prUrl }) => {
            busy = false;
            if (actionError) {
              render(rules, index, { kind: "error", text: `Failed to ${action}: ${actionError}` });
              return;
            }
            rules.splice(index, 1);
            // actOnRule already turned a missing prUrl into an error above,
            // so a successful propose here always has one.
            const messageText = action === "propose" ? `Opened PR: ${prUrl}` : `Rejected: ${rule.title}`;
            if (rules.length === 0) {
              console.clear();
              console.log(`${success(messageText)}\n${muted("All caught up.")}`);
              finish();
              return;
            }
            index = Math.min(index, rules.length - 1);
            render(rules, index, { kind: "ok", text: messageText });
          })
          .catch((err) => {
            busy = false;
            const detail = err instanceof Error ? err.message : String(err);
            render(rules, index, { kind: "error", text: `Failed to ${action}: ${detail}` });
          });
      }
    };

    process.stdin.on("keypress", onKeypress);
    render(rules, index, null);
  });
}
