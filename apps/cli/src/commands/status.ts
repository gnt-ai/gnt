import { API_URL } from "../config.js";
import { loadApiKey, loadMcpToken } from "../credentials.js";
import { mcpConnectorHealth } from "../prebrain/mcp-framework/index.js";
import { AIRTABLE_TOKEN_ID, GITLAB_TOKEN_ID, HUBSPOT_TOKEN_ID, hasStoredAirtableConnection } from "../prebrain/index.js";
import { error, fail, keyValueLines, muted, success, text } from "../theme.js";

function yesNo(value: boolean): string {
  return value ? success("yes") : error("no");
}

// A 200 response with a body that parses fine but isn't the shape we
// expect (null, an array, a bare string/number, or an object missing the
// field these commands actually key off of) is a malformed response too,
// just not one JSON.parse itself catches -- the JSON output path below
// assigns billing/roi straight onto `result` with no further checking, so
// a schema-invalid body would otherwise land in the CLI's machine-readable
// output as-is instead of being omitted like every other malformed-
// response case here. Checks one field each, not the full shape both
// routers return -- enough to reject {}/[]/null without re-deriving the
// whole response schema client-side.
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBillingShape(value: unknown): value is Record<string, unknown> {
  return isPlainRecord(value) && typeof value.entitled === "boolean";
}

function isRoiShape(value: unknown): value is Record<string, unknown> {
  return isPlainRecord(value) && typeof value.window_days === "number";
}

// "N (+M vs. last week)" / "N (flat vs. last week)",
// same shape gnt.email.render_weekly_digest uses for the email version of
// these same numbers (apps/api/src/gnt/email.py's own _delta helper) --
// one definition of what "moving" looks like, not two independently
// invented ones.
function withDelta(current: number, prior: number): string {
  const diff = current - prior;
  if (diff === 0) return `${text(String(current))} ${muted("(flat vs. last week)")}`;
  const sign = diff > 0 ? "+" : "";
  return `${text(String(current))} ${muted(`(${sign}${diff} vs. last week)`)}`;
}

function billingLine(billingStatus: {
  entitled: boolean;
  subscription_status: string | null;
  trial_ends_at: string | null;
}): string {
  if (billingStatus.subscription_status) {
    return billingStatus.entitled
      ? success(billingStatus.subscription_status)
      : error(billingStatus.subscription_status);
  }
  if (!billingStatus.trial_ends_at) return muted("unknown");
  const daysLeft = Math.ceil(
    (new Date(billingStatus.trial_ends_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000),
  );
  if (!billingStatus.entitled) return error("trial expired — run `gnt billing`");
  return text(`trial, ${daysLeft} day${daysLeft === 1 ? "" : "s"} left`);
}

export async function status(opts: { json?: boolean } = {}): Promise<void> {
  const key = loadApiKey();
  // allSettled, not all -- a network failure fetching billing/onboarding/
  // staleness/roi status (separate concerns from brain/summary) must not
  // reject the whole Promise.all and hide an otherwise-working summary.
  const [summaryResult, billingResult, onboardingResult, staleResult, roiResult] = await Promise.allSettled([
    fetch(`${API_URL}/v1/brain/summary`, { headers: { Authorization: `Bearer ${key}` } }),
    fetch(`${API_URL}/v1/billing/status`, { headers: { Authorization: `Bearer ${key}` } }),
    fetch(`${API_URL}/v1/onboarding/status`, { headers: { Authorization: `Bearer ${key}` } }),
    fetch(`${API_URL}/v1/rules/staleness/due?limit=1`, { headers: { Authorization: `Bearer ${key}` } }),
    fetch(`${API_URL}/v1/roi/summary`, { headers: { Authorization: `Bearer ${key}` } }),
  ]);
  if (summaryResult.status === "rejected" || !summaryResult.value.ok) {
    const detail =
      summaryResult.status === "fulfilled" ? String(summaryResult.value.status) : "network error";
    console.error(fail(`Failed to fetch status (${detail}).`));
    process.exit(1);
  }
  const data = await summaryResult.value.json();

  if (opts.json) {
    const connectors: Record<string, boolean> = {};
    for (const connector of mcpConnectorHealth()) {
      connectors[connector.label] = connector.connected;
    }
    connectors["GitLab threads"] = loadMcpToken(GITLAB_TOKEN_ID) !== undefined;
    connectors.HubSpot = loadMcpToken(HUBSPOT_TOKEN_ID) !== undefined;
    connectors.Airtable = hasStoredAirtableConnection(loadMcpToken(AIRTABLE_TOKEN_ID));

    const result: Record<string, unknown> = {
      pack_version: data.pack_version ?? null,
      slack_connected: data.slack_connected,
      mcp_key_exists: data.mcp_key_exists,
      connectors,
    };
    // Same best-effort treatment as the human-readable path below: a
    // hiccup on any one of these omits its key from the JSON rather than
    // failing the whole command.
    if (billingResult.status === "fulfilled" && billingResult.value.ok) {
      try {
        const billing = await billingResult.value.json();
        if (isBillingShape(billing)) result.billing = billing;
      } catch {
        // malformed billing response body -- omit the key, not the command
      }
    }
    if (onboardingResult.status === "fulfilled" && onboardingResult.value.ok) {
      try {
        const onboarding = await onboardingResult.value.json();
        result.github_connected = onboarding.connected_github;
        result.github_needs_upgrade = onboarding.github_needs_upgrade;
        result.rules_approved = onboarding.rules_approved;
        result.rules_proposed = onboarding.rules_proposed;
      } catch {
        // malformed onboarding response body -- omit the keys, not the command
      }
    }
    if (staleResult.status === "fulfilled" && staleResult.value.ok) {
      try {
        const { count } = await staleResult.value.json();
        result.rules_due_for_revalidation = count;
      } catch {
        // malformed staleness response body -- omit the key, not the command
      }
    }
    if (roiResult.status === "fulfilled" && roiResult.value.ok) {
      try {
        const roi = await roiResult.value.json();
        if (isRoiShape(roi)) result.roi = roi;
      } catch {
        // malformed roi summary response body -- omit the key, not the command
      }
    }

    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const lines: Array<[string, string]> = [
    ["Skill pack version", text(data.pack_version ? String(data.pack_version) : "none yet")],
    ["Slack connected", yesNo(data.slack_connected)],
    ["MCP key exists", yesNo(data.mcp_key_exists)],
  ];
  // MCP-in connector health: each registered adapter
  // contributes its own line the same way Slack/GitHub do above. Read from
  // this device's local token store, not the API -- these tokens never
  // reach gnt's servers -- so no fetch and nothing to fail here. A new
  // connector shows up automatically by registering its adapter; status
  // doesn't hardcode any of them.
  for (const connector of mcpConnectorHealth()) {
    lines.push([`${connector.label} connected`, yesNo(connector.connected)]);
  }
  // GitLab threads is a direct-REST connector, not
  // an MCP-in adapter, so it isn't in MCP_IN_ADAPTERS and mcpConnectorHealth
  // above never sees it -- same local-token-presence definition of
  // "connected" as that loop uses, read straight off this device's own
  // mcp-tokens.json.
  lines.push(["GitLab threads connected", yesNo(loadMcpToken(GITLAB_TOKEN_ID) !== undefined)]);
  // HubSpot notes: not an MCP-in adapter (see
  // prebrain/hubspot-notes.ts's own doc comment for why), so it isn't in
  // MCP_IN_ADAPTERS/mcpConnectorHealth above -- same local-token-presence
  // check, added by hand for this one connector.
  lines.push(["HubSpot connected", yesNo(loadMcpToken(HUBSPOT_TOKEN_ID) !== undefined)]);
  // Airtable: a direct-REST connector, not an
  // MCP-in adapter, so it isn't in MCP_IN_ADAPTERS and doesn't come out of
  // mcpConnectorHealth() above -- same reason figma-comments.ts/
  // datadog-notebooks.ts's own connectors aren't in that registry either.
  // Same local-token-store read as the loop above, just addressed by hand:
  // "connected" means a saved base + token parses, which is exactly what
  // `gnt prebrain --airtable` itself requires to run.
  lines.push(["Airtable connected", yesNo(hasStoredAirtableConnection(loadMcpToken(AIRTABLE_TOKEN_ID)))]);
  // Shown on a best-effort basis -- a hiccup or malformed body here
  // shouldn't hide the rest of an otherwise-working status command.
  if (billingResult.status === "fulfilled" && billingResult.value.ok) {
    try {
      lines.push(["Billing", billingLine(await billingResult.value.json())]);
    } catch {
      // malformed billing response body -- omit the line, not the command
    }
  }
  // Same best-effort treatment as billing -- onboarding/status is a
  // separate lightweight aggregation, not required for the rest of
  // `gnt status` to be useful.
  if (onboardingResult.status === "fulfilled" && onboardingResult.value.ok) {
    try {
      const onboarding = await onboardingResult.value.json();
      lines.push(["GitHub connected", yesNo(onboarding.connected_github)]);
      // GitHub App migration — an org still on the legacy PAT flow gets a
      // nudge here rather than silently staying on the less-secure
      // connect path forever. Only shown when actually connected: an org
      // with no GitHub connection at all has nothing to upgrade.
      if (onboarding.github_needs_upgrade) {
        lines.push(["GitHub connection", error("PAT-based -- run `gnt connect github --upgrade`")]);
      }
      lines.push(
        ["Rules approved", text(`${onboarding.rules_approved} (${onboarding.rules_proposed} proposed)`)],
      );
    } catch {
      // malformed onboarding response body -- omit the lines, not the command
    }
  }
  // Same best-effort treatment. limit=1 above since
  // this only needs the count; `gnt stale` has the full list.
  if (staleResult.status === "fulfilled" && staleResult.value.ok) {
    try {
      const { count } = await staleResult.value.json();
      lines.push([
        "Rules due for re-validation",
        count > 0 ? error(`${count} (run \`gnt stale\`)`) : success("0"),
      ]);
    } catch {
      // malformed staleness response body -- omit the line, not the command
    }
  }
  // ROI/acceptance-gate numbers, same best-effort treatment as
  // billing/onboarding/staleness above: a hiccup here omits these lines,
  // not the rest of `gnt status`.
  if (roiResult.status === "fulfilled" && roiResult.value.ok) {
    try {
      const roi = await roiResult.value.json();
      lines.push([`Rules served (${roi.window_days}d)`, withDelta(roi.rules_served, roi.rules_served_prior)]);
      lines.push([
        `Actions checked (${roi.window_days}d)`,
        withDelta(roi.actions_checked, roi.actions_checked_prior),
      ]);
      lines.push(["  blocked", withDelta(roi.actions_blocked, roi.actions_blocked_prior)]);
      lines.push(["  needs human", withDelta(roi.actions_needs_human, roi.actions_needs_human_prior)]);
      lines.push([`Coverage gaps (${roi.window_days}d)`, withDelta(roi.gap_count, roi.gap_count_prior)]);
    } catch {
      // malformed roi summary response body -- omit the lines, not the command
    }
  }

  for (const line of keyValueLines(lines)) {
    console.log(line);
  }
}
