// Tests the pure text-patching logic behind `gnt connect hermes` --
// see src/hermes-config.ts's own doc comment
// for why this edits config.yaml as text instead of round-tripping it
// through a YAML library, and why the Authorization header is always the
// literal ${GNT_MCP_KEY} placeholder rather than a real key.
import { expect, test } from "bun:test";
import { MCP_URL } from "../src/config.js";
import { GNT_KEY_ENV_VAR, planAddGntServer } from "../src/hermes-config.js";

test("adds a fresh mcp_servers block to an empty config", () => {
  const plan = planAddGntServer("");
  if (plan.status !== "ready") throw new Error("expected ready");

  const written = plan.apply();
  expect(written).toContain("mcp_servers:");
  expect(written).toContain("  gnt:");
  expect(written).toContain(`url: "${MCP_URL}"`);
  expect(written).toContain(`Authorization: "Bearer \${${GNT_KEY_ENV_VAR}}"`);
  expect(written).toContain("include: [check_action, search_rules, get_rule, list_skill_packs, get_skill_pack]");
  expect(written).toContain("resources: false");
  expect(written).toContain("prompts: false");
  // Every inserted line must parse as valid, well-formed YAML text --
  // spot check there's no stray blank line splitting the block.
  expect(written.endsWith("\n")).toBe(true);
});

test("appends a new mcp_servers block after other top-level config, two-space default indent", () => {
  const existing = 'model:\n  name: "some-model"\n';
  const plan = planAddGntServer(existing);
  if (plan.status !== "ready") throw new Error("expected ready");

  const written = plan.apply();
  expect(written.startsWith(existing.trimEnd())).toBe(true);
  expect(written).toContain("\nmcp_servers:\n  gnt:\n");
});

test("inserts into an existing mcp_servers block as a sibling server, matching its indentation", () => {
  const existing = ['mcp_servers:', '  other:', '    command: "npx"', '    args: ["-y", "some-server"]', ""].join("\n");
  const plan = planAddGntServer(existing);
  if (plan.status !== "ready") throw new Error("expected ready");

  const written = plan.apply();
  // The original server entry is untouched, byte for byte.
  expect(written).toContain('  other:\n    command: "npx"\n    args: ["-y", "some-server"]');
  // The new entry is a sibling at the same two-space indent, not nested
  // under "other".
  expect(written).toContain("  gnt:\n    url:");
});

test("matches an existing block's four-space indentation instead of assuming two", () => {
  const existing = ["mcp_servers:", '    other:', '        command: "npx"', ""].join("\n");
  const plan = planAddGntServer(existing);
  if (plan.status !== "ready") throw new Error("expected ready");

  const written = plan.apply();
  expect(written).toContain("    gnt:\n        url:");
});

test("stops before a later top-level key instead of eating the rest of the file", () => {
  const existing = ['mcp_servers:', '  other:', '    command: "npx"', "", "model:", '  name: "x"', ""].join("\n");
  const plan = planAddGntServer(existing);
  if (plan.status !== "ready") throw new Error("expected ready");

  const written = plan.apply();
  const modelIndex = written.indexOf("model:");
  const gntIndex = written.indexOf("  gnt:");
  expect(gntIndex).toBeGreaterThan(-1);
  expect(modelIndex).toBeGreaterThan(-1);
  expect(gntIndex).toBeLessThan(modelIndex);
});

test("reports already-connected instead of duplicating an existing gnt entry", () => {
  const existing = ['mcp_servers:', '  gnt:', '    url: "https://example.com/mcp"', '    headers:', '      Authorization: "Bearer gnt_live_old"', ""].join("\n");
  const plan = planAddGntServer(existing);
  expect(plan.status).toBe("already-connected");
});

test("does not false-positive on a differently-named server", () => {
  const existing = ['mcp_servers:', '  gnt-mirror:', '    url: "https://mirror.example.com"', ""].join("\n");
  const plan = planAddGntServer(existing);
  expect(plan.status).toBe("ready");
});

test("never inlines a real key -- preview and the written file both use the env-var placeholder", () => {
  const plan = planAddGntServer("");
  if (plan.status !== "ready") throw new Error("expected ready");

  const previewText = plan.preview.join("\n");
  const writtenText = plan.apply();

  // Only ever the literal reference, in both what's shown for consent and
  // what's actually written -- there is no code path that can produce a
  // plaintext key, since apply() takes no key argument at all.
  expect(previewText).toContain(`\${${GNT_KEY_ENV_VAR}}`);
  expect(writtenText).toContain(`\${${GNT_KEY_ENV_VAR}}`);
  expect(previewText).toBe(writtenText.trim());
});
