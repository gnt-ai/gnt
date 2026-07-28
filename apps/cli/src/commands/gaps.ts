import { API_URL } from "../config.js";
import { loadApiKey } from "../credentials.js";
import { bold, dim, fail, muted, text } from "../theme.js";

interface Gap {
  tool: "search_rules" | "check_action";
  query: string;
  count: number;
  last_seen: string;
}

const REQUEST_TIMEOUT_MS = 10_000;

function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function toolLabel(tool: Gap["tool"]): string {
  return tool === "search_rules" ? "search_rules — no results" : "check_action — no coverage";
}

// Wraps an already-JSON-stringified curl -d payload in single quotes safe
// for a POSIX shell, even if the underlying query text (which ends up in
// that JSON) contains a literal apostrophe.
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// gnt gaps prints a ready-to-run curl pair (create draft, then submit for
// review) per gap rather than an interactive drafting flow — there's no
// guided capture UX in this CLI yet (see ONBOARD_FOR_AGENTS.md's Step 5,
// which uses the same two-curl shape), and drafting a rule's actual body
// needs the operator's own judgment, not something this command should
// invent. A full "propose a rule" UX is a separate piece of work.
function proposeHint(gap: Gap): string[] {
  const payload = JSON.stringify({
    title: gap.query.length > 200 ? `${gap.query.slice(0, 197)}...` : gap.query,
    body: "<fill in the actual policy>",
  });
  return [
    `   curl -s -X POST "${API_URL}/v1/rules" -H "Authorization: Bearer $API_KEY" ` +
      `-H "Content-Type: application/json" -d ${shellSingleQuote(payload)}`,
    `   # then, with the "id" from that response:`,
    `   curl -s -X POST "${API_URL}/v1/rules/<id>/submit" -H "Authorization: Bearer $API_KEY"`,
  ];
}

export async function gaps(): Promise<void> {
  const key = loadApiKey();
  let res: Response;
  try {
    res = await fetchWithTimeout(`${API_URL}/v1/gaps`, {
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch {
    console.error(fail("Timed out fetching coverage gaps."));
    process.exit(1);
  }
  if (!res.ok) {
    console.error(fail(`Failed to fetch coverage gaps (${res.status}).`));
    process.exit(1);
  }
  const gapsList: Gap[] = await res.json();

  if (gapsList.length === 0) {
    console.log(muted("No coverage gaps logged yet."));
    return;
  }

  console.log(bold(`Top uncovered queries (${gapsList.length}):`));
  console.log(muted("Set once: run `gnt keys create` to mint a key, then export API_KEY=<that key> in your shell."));
  console.log();

  gapsList.forEach((gap, index) => {
    const lastSeen = new Date(gap.last_seen).toLocaleString();
    console.log(`${dim(`${index + 1}.`)} ${text(gap.query)}`);
    console.log(`   ${muted(toolLabel(gap.tool))} · ${muted(`asked ${gap.count}x`)} · ${muted(`last seen ${lastSeen}`)}`);
    console.log(muted("   Propose a rule for this:"));
    for (const line of proposeHint(gap)) {
      console.log(dim(line));
    }
    console.log();
  });
}
