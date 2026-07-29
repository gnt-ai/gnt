import { API_URL } from "../config.js";
import { loadApiKey } from "../credentials.js";
import { bold, dim, fail, muted, text } from "../theme.js";

interface StaleRule {
  rule_id: string;
  title: string;
  age_days: number;
  freshness_score: number;
  estimate: boolean;
  computed_at: string;
}

interface StaleResponse {
  count: number;
  rules: StaleRule[];
}

const REQUEST_TIMEOUT_MS = 10_000;

function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// A stopgap for the re-validation prompt that ideally belongs in a weekly
// digest — that digest doesn't exist yet, so this is the CLI-visibility
// substitute for now. There's no dedicated "mark revalidated" endpoint —
// confirming a rule is still true or refreshing it goes through the
// existing edit/deprecate flow, same as any other rule change.
export async function stale(): Promise<void> {
  const key = loadApiKey();
  let res: Response;
  try {
    res = await fetchWithTimeout(`${API_URL}/v1/rules/staleness/due`, {
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch {
    console.error(fail("Timed out fetching rules due for re-validation."));
    process.exit(1);
  }
  if (!res.ok) {
    console.error(fail(`Failed to fetch rules due for re-validation (${res.status}).`));
    process.exit(1);
  }
  const { count, rules }: StaleResponse = await res.json();

  if (count === 0) {
    console.log(muted("No rules are due for re-validation."));
    return;
  }

  console.log(bold(`Rules due for re-validation (${count}):`));
  console.log(muted("Every number below is a decay estimate, not a verified fact."));
  console.log();

  rules.forEach((rule, index) => {
    const freshnessPct = `${Math.round(rule.freshness_score * 100)}%`;
    console.log(`${dim(`${index + 1}.`)} ${text(rule.title)}`);
    console.log(
      `   ${muted(`~${Math.round(rule.age_days)} days old`)} · ${muted(`freshness ${freshnessPct} (estimate)`)}`,
    );
    console.log(muted("   Confirm it's still true, or refresh/deprecate it:"));
    console.log(
      dim(
        `   curl -X POST "${API_URL}/v1/rules/${rule.rule_id}/deprecate" -H "Authorization: Bearer $API_KEY"   # if it's no longer accurate`,
      ),
    );
    console.log(
      dim(`   Otherwise: POST /v1/rules/${rule.rule_id}/edit with the refreshed content, then \`gnt review\` to re-propose it.`),
    );
    console.log();
  });
}
