// Tests the wired-up pipeline `gnt prebrain` runs after chunk collection:
// privacy gate -> extraction -> topic grouping ->
// create/submit/batch-propose. See prebrain.test.ts for the earlier
// walker/chunk-collection stage this file doesn't re-test.
//
// GNT_CONFIG_DIR is set before saveApiKey runs (same pattern as
// gaps.test.ts) so this never touches a real user's ~/.gnt/. No real
// extraction model call and no real HTTP call to API_URL happens anywhere
// in this file: `extract` is always a fake passed via PrebrainDeps, and
// every network call goes through a mocked globalThis.fetch.
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveApiKey } from "../src/credentials.js";
import { runPrebrain } from "../src/commands/prebrain.js";
import type { PrebrainDeps } from "../src/commands/prebrain.js";
import type { ExtractedRule, PrebrainChunk } from "../src/prebrain/extraction/index.js";
import { ExtractionError } from "../src/prebrain/extraction/index.js";
import type { CompanyProfile } from "../src/prebrain/profile.js";

let repoRoot: string;
let originalCwd: string;
let testConfigDir: string;
let logs: string[];
let originalLog: typeof console.log;
let originalFetch: typeof fetch;

const FIXED_PROFILE: CompanyProfile = {
  description: "fintech ops",
  agentFunctions: [],
  primaryFunction: null,
  decisionSource: "other",
};

function write(base: string, relPath: string, content: string) {
  const fullPath = join(base, relPath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content);
}

function extractedRule(overrides: Partial<ExtractedRule>): ExtractedRule {
  return {
    title: "Untitled rule",
    body: "Body text.",
    confidence: 0.7,
    tags: [],
    source: "README.md:1",
    sourceCitations: [],
    ...overrides,
  };
}

beforeEach(() => {
  originalCwd = process.cwd();
  repoRoot = mkdtempSync(join(tmpdir(), "gnt-prebrain-pipeline-repo-"));
  process.chdir(repoRoot);

  testConfigDir = mkdtempSync(join(tmpdir(), "gnt-prebrain-pipeline-config-"));
  process.env.GNT_CONFIG_DIR = testConfigDir;
  saveApiKey("gnt_live_test_key", "key-id");

  logs = [];
  originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };

  originalFetch = globalThis.fetch;
});

afterEach(() => {
  process.chdir(originalCwd);
  console.log = originalLog;
  globalThis.fetch = originalFetch;
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(testConfigDir, { recursive: true, force: true });
});

test("the privacy gate masks a detected secret before extraction ever sees it", async () => {
  write(
    repoRoot,
    "README.md",
    "Refunds over 15% require manager sign-off; contact ops@acme-secret-co.com to confirm.\n",
  );

  let capturedChunks: PrebrainChunk[] = [];
  const deps: PrebrainDeps = {
    collectProfile: () => Promise.resolve(FIXED_PROFILE),
    extract: (chunks) => {
      capturedChunks = chunks;
      return Promise.resolve([]);
    },
  };

  await runPrebrain({}, deps);

  expect(capturedChunks.length).toBeGreaterThan(0);
  const allText = capturedChunks.map((c) => c.text).join("\n");
  // The masked value never reaches the (mocked) model call -- asserted
  // directly on what extract actually received, not just on wiring order.
  expect(allText).not.toContain("ops@acme-secret-co.com");
  expect(allText).toMatch(/\[EMAIL_\d+\]/);
});

test("the privacy gate masks a detected secret in Gmail-export chunks too, with zero special-casing", async () => {
  // Real email content is exactly the kind of source likely to carry PII
  // (a signature with a phone number, here) -- this confirms gmail-export
  // chunks go through the exact same gateChunks() call every other
  // walker's chunks do, not a parallel or skipped path.
  const mboxPath = join(repoRoot, "takeout.mbox");
  writeFileSync(
    mboxPath,
    [
      "From alice@example.com Mon Jan 05 09:00:00 2026",
      "Message-ID: <pipeline-fixture-1@example.com>",
      "Date: Mon, 05 Jan 2026 09:00:00 -0800",
      "From: Alice <alice@example.com>",
      "Subject: Refund approvals",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "Refunds over $500 need manager approval. Call me at 415-555-0100 with questions.",
      "",
    ].join("\n"),
  );

  let capturedChunks: PrebrainChunk[] = [];
  const deps: PrebrainDeps = {
    collectProfile: () => Promise.resolve(FIXED_PROFILE),
    extract: (chunks) => {
      capturedChunks = chunks;
      return Promise.resolve([]);
    },
  };

  await runPrebrain({ gmail: mboxPath }, deps);

  const gmailChunks = capturedChunks.filter((c) => c.walker === "gmail-export");
  expect(gmailChunks.length).toBeGreaterThan(0);
  const allText = gmailChunks.map((c) => c.text).join("\n");
  expect(allText).not.toContain("415-555-0100");
  expect(allText).toMatch(/\[PHONE_\d+\]/);
});

test("groups extracted rules into batches by dominant (first) tag", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");

  const rules: ExtractedRule[] = [
    extractedRule({ title: "R1", tags: ["refunds"] }),
    extractedRule({ title: "R2", tags: ["refunds"] }),
    extractedRule({ title: "R3", tags: ["escalation"] }),
    extractedRule({ title: "R4", tags: ["refunds"] }),
    extractedRule({ title: "R5", tags: ["escalation"] }),
    extractedRule({ title: "R6", tags: [] }),
  ];

  const idToTitle = new Map<string, string>();
  const batchCalls: string[][] = [];
  let nextId = 1;

  globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/v1/rules") && init?.method === "POST") {
      const body = JSON.parse(init.body as string);
      const id = `id-${nextId++}`;
      idToTitle.set(id, body.title);
      return Promise.resolve(new Response(JSON.stringify({ id }), { status: 201 }));
    }
    if (url.includes("/submit")) {
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }
    if (url.endsWith("/v1/rules/batch-propose")) {
      const body = JSON.parse(init?.body as string);
      batchCalls.push(body.rule_ids.map((id: string) => idToTitle.get(id) ?? id));
      return Promise.resolve(
        new Response(
          JSON.stringify({ pr_number: 1, pr_url: "https://github.com/acme/rules/pull/1", rules: [] }),
          { status: 200 },
        ),
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;

  const deps: PrebrainDeps = {
    collectProfile: () => Promise.resolve(FIXED_PROFILE),
    extract: () => Promise.resolve(rules),
  };

  await runPrebrain({ yes: true }, deps);

  const sizes = batchCalls.map((titles) => titles.length).sort((a, b) => b - a);
  expect(sizes).toEqual([3, 2, 1]);

  const refundsBatch = batchCalls.find((titles) => titles.includes("R1"));
  expect(refundsBatch?.sort()).toEqual(["R1", "R2", "R4"]);
  const escalationBatch = batchCalls.find((titles) => titles.includes("R3"));
  expect(escalationBatch?.sort()).toEqual(["R3", "R5"]);
  const untaggedBatch = batchCalls.find((titles) => titles.includes("R6"));
  expect(untaggedBatch).toEqual(["R6"]);
});

// --yes/confirmOpenPrs (the "31 PRs opened with zero warning" fix): the
// preview + gate sits between grouping and the create/submit/batch-propose
// loop, so these exercise it directly through the injectable confirmOpenPrs
// seam (same treatment as collectProfile above) rather than a real
// terminal -- see prebrain.ts's own confirmOpenPrs doc comment.

function ruleCreateFetchMock(calls: { url: string; method: string | undefined; body: string | undefined }[]) {
  return mock((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, method: init?.method, body: init?.body as string | undefined });
    if (url.endsWith("/v1/rules") && init?.method === "POST") {
      return Promise.resolve(new Response(JSON.stringify({ id: "rule-1" }), { status: 201 }));
    }
    if (url.endsWith("/rule-1/submit")) {
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }
    if (url.endsWith("/v1/rules/batch-propose")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ pr_number: 42, pr_url: "https://github.com/acme/rules/pull/42", rules: [] }),
          { status: 200 },
        ),
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

test("previews every PR's topic, size, and rule titles before asking to confirm", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");

  const calls: { url: string; method: string | undefined; body: string | undefined }[] = [];
  globalThis.fetch = ruleCreateFetchMock(calls);

  let confirmPrompt = "";
  const deps: PrebrainDeps = {
    collectProfile: () => Promise.resolve(FIXED_PROFILE),
    extract: () => Promise.resolve([extractedRule({ title: "Refund window", tags: ["refunds"] })]),
    confirmOpenPrs: (prompt) => {
      confirmPrompt = prompt;
      return Promise.resolve(true);
    },
  };

  await runPrebrain({}, deps);

  const output = logs.join("\n");
  expect(output).toContain("About to open 1 PR for 1 rule:");
  expect(output).toContain("PR 1/1");
  expect(output).toContain("refunds (1 rule)");
  expect(output).toContain("- Refund window");
  expect(confirmPrompt).toContain("Open 1 PR?");
  // Confirmed via the injected seam, so the run still proceeds all the way
  // through to batch-propose.
  expect(calls.some((c) => c.url.endsWith("/v1/rules/batch-propose"))).toBe(true);
});

test("declining the confirmation prompt aborts before anything is created or opened", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");

  const calls: { url: string; method: string | undefined; body: string | undefined }[] = [];
  globalThis.fetch = ruleCreateFetchMock(calls);

  const deps: PrebrainDeps = {
    collectProfile: () => Promise.resolve(FIXED_PROFILE),
    extract: () => Promise.resolve([extractedRule({ title: "Refund window", tags: ["refunds"] })]),
    confirmOpenPrs: () => Promise.resolve(false),
  };

  await runPrebrain({}, deps);

  expect(calls.length).toBe(0);
  const output = logs.join("\n");
  expect(output).toContain("Aborted -- nothing created or opened.");
  expect(output).not.toContain("Opened PR:");
});

test("a non-interactive terminal that can't even ask exits 1, not a silent success", async () => {
  // Distinct from "declining the confirmation prompt" above: that's a
  // human genuinely saying no (exit 0 is correct there, matches
  // connect-hermes.ts's own choice not to exit(1) on a real decline).
  // This is confirmOpenPrs throwing (no TTY to ask at all) -- a plain
  // return here previously left a scripted/CI caller seeing exit code 0
  // while zero PRs were actually created.
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");

  const calls: { url: string; method: string | undefined; body: string | undefined }[] = [];
  globalThis.fetch = ruleCreateFetchMock(calls);

  const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);

  const deps: PrebrainDeps = {
    collectProfile: () => Promise.resolve(FIXED_PROFILE),
    extract: () => Promise.resolve([extractedRule({ title: "Refund window", tags: ["refunds"] })]),
    confirmOpenPrs: () => Promise.reject(new Error("gnt prebrain needs an interactive terminal")),
  };

  await runPrebrain({}, deps);

  expect(exitSpy).toHaveBeenCalledWith(1);
  expect(calls.length).toBe(0);
  const output = logs.join("\n");
  expect(output).toContain("needs an interactive terminal");

  exitSpy.mockRestore();
});

test("--yes skips the confirmation prompt entirely, without calling confirmOpenPrs", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");

  const calls: { url: string; method: string | undefined; body: string | undefined }[] = [];
  globalThis.fetch = ruleCreateFetchMock(calls);

  const deps: PrebrainDeps = {
    collectProfile: () => Promise.resolve(FIXED_PROFILE),
    extract: () => Promise.resolve([extractedRule({ title: "Refund window", tags: ["refunds"] })]),
    confirmOpenPrs: () => Promise.reject(new Error("confirmOpenPrs should not be called when --yes is set")),
  };

  await runPrebrain({ yes: true }, deps);

  const output = logs.join("\n");
  expect(output).toContain("Skipping confirmation (--yes).");
  expect(output).toContain("Opened PR: https://github.com/acme/rules/pull/42");
});

test("runs create -> submit -> batch-propose end to end and prints the opened PR", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");

  const calls: { url: string; method: string | undefined; body: string | undefined }[] = [];
  globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, method: init?.method, body: init?.body as string | undefined });
    if (url.endsWith("/v1/rules") && init?.method === "POST") {
      return Promise.resolve(new Response(JSON.stringify({ id: "rule-1" }), { status: 201 }));
    }
    if (url.endsWith("/rule-1/submit")) {
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }
    if (url.endsWith("/v1/rules/batch-propose")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ pr_number: 42, pr_url: "https://github.com/acme/rules/pull/42", rules: [] }),
          { status: 200 },
        ),
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;

  const deps: PrebrainDeps = {
    collectProfile: () => Promise.resolve(FIXED_PROFILE),
    extract: () => Promise.resolve([extractedRule({ title: "Refund window", tags: ["refunds"] })]),
  };

  await runPrebrain({ yes: true }, deps);

  expect(calls.some((c) => c.url.endsWith("/v1/rules") && c.method === "POST")).toBe(true);
  expect(calls.some((c) => c.url.endsWith("/rule-1/submit"))).toBe(true);
  expect(calls.some((c) => c.url.endsWith("/v1/rules/batch-propose"))).toBe(true);

  const createCall = calls.find((c) => c.url.endsWith("/v1/rules") && c.method === "POST");
  const createBody = JSON.parse(createCall?.body ?? "{}");
  expect(createBody.title).toBe("Refund window");
  expect(createBody.source_citations).toBeDefined();

  const output = logs.join("\n");
  expect(output).toContain("Opened PR: https://github.com/acme/rules/pull/42");
  expect(output).toContain("1 PR opened");
});

test("a rule that fails to create is reported and excluded, without blocking its siblings", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");

  globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/v1/rules") && init?.method === "POST") {
      const body = JSON.parse(init.body as string);
      if (body.title === "Bad rule") {
        return Promise.resolve(new Response(JSON.stringify({ detail: "sanitize rejected this body" }), { status: 400 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ id: "rule-good" }), { status: 201 }));
    }
    if (url.endsWith("/rule-good/submit")) {
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }
    if (url.endsWith("/v1/rules/batch-propose")) {
      const body = JSON.parse(init?.body as string);
      expect(body.rule_ids).toEqual(["rule-good"]); // the failed rule never reaches batch-propose
      return Promise.resolve(
        new Response(
          JSON.stringify({ pr_number: 5, pr_url: "https://github.com/acme/rules/pull/5", rules: [] }),
          { status: 200 },
        ),
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;

  const deps: PrebrainDeps = {
    collectProfile: () => Promise.resolve(FIXED_PROFILE),
    extract: () =>
      Promise.resolve([
        extractedRule({ title: "Bad rule", tags: ["refunds"] }),
        extractedRule({ title: "Good rule", tags: ["refunds"] }),
      ]),
  };

  await runPrebrain({ yes: true }, deps);

  const output = logs.join("\n");
  expect(output).toContain("Bad rule");
  expect(output).toContain("sanitize rejected this body");
  expect(output).toContain("Opened PR: https://github.com/acme/rules/pull/5");
  expect(output).toContain("1 failure");
});

test("keeps rules extraction DID succeed when some chunks fail extraction outright", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");

  globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/v1/rules") && init?.method === "POST") {
      return Promise.resolve(new Response(JSON.stringify({ id: "rule-1" }), { status: 201 }));
    }
    if (url.endsWith("/rule-1/submit")) {
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }
    if (url.endsWith("/v1/rules/batch-propose")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ pr_number: 9, pr_url: "https://github.com/acme/rules/pull/9", rules: [] }),
          { status: 200 },
        ),
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;

  const deps: PrebrainDeps = {
    collectProfile: () => Promise.resolve(FIXED_PROFILE),
    extract: () =>
      Promise.reject(
        new ExtractionError([extractedRule({ title: "Survived rule", tags: ["refunds"] })], [
          "other-chunk.md:1: simulated model timeout",
        ]),
      ),
  };

  const summary = await runPrebrain({ yes: true }, deps);

  const output = logs.join("\n");
  expect(output).toContain("1 chunk failed extraction");
  expect(output).toContain("simulated model timeout");
  expect(output).toContain("Opened PR: https://github.com/acme/rules/pull/9");

  // The failure count is real, returned data, not only a console line -- a
  // caller (e.g. a pre-PR confirmation gate) can act on it without
  // re-parsing terminal output.
  expect(summary.chunkFailureCount).toBe(1);
  expect(summary.chunkErrors).toEqual(["other-chunk.md:1: simulated model timeout"]);
});

// Regression coverage for the reported bug: a real run had 48 chunks fail
// extraction (Ollama overwhelmed by concurrency) and the CLI opened PRs
// from whatever partial results it got with no clear warning of how much
// was dropped. This pins the fix: the failure message names both the
// failure count and the total, and says plainly that the run is
// proceeding on partial results, instead of just listing failures with no
// framing.
test("a partial-failure run clearly states how many of the total chunks failed and that it's proceeding anyway", async () => {
  // Two real repo-scan targets so chunks.length in the message is coherent
  // with the two simulated chunk failures below (repo-scan only walks
  // README/CONTRIBUTING/CODEOWNERS/PR-template/lint-config/ci-config --
  // see repo-scan.ts -- so both need to be files it actually picks up).
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");
  write(repoRoot, "CONTRIBUTING.md", "Escalate any outage over 30 minutes to the on-call lead.\n");

  globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/v1/rules") && init?.method === "POST") {
      return Promise.resolve(new Response(JSON.stringify({ id: "rule-1" }), { status: 201 }));
    }
    if (url.endsWith("/rule-1/submit")) {
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }
    if (url.endsWith("/v1/rules/batch-propose")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ pr_number: 12, pr_url: "https://github.com/acme/rules/pull/12", rules: [] }),
          { status: 200 },
        ),
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;

  const deps: PrebrainDeps = {
    collectProfile: () => Promise.resolve(FIXED_PROFILE),
    extract: () =>
      Promise.reject(
        new ExtractionError([extractedRule({ title: "Survived rule", tags: ["refunds"] })], [
          "README.md:1: simulated Ollama timeout (1)",
          "CONTRIBUTING.md:1: simulated Ollama timeout (2)",
        ]),
      ),
  };

  const summary = await runPrebrain({ yes: true }, deps);

  const output = logs.join("\n");
  expect(output).toContain("2 of 2 chunks failed extraction -- proceeding with partial results");
  expect(summary.chunkFailureCount).toBe(2);
  expect(summary.chunksScanned).toBe(2);
});

// --starter-packs: curated starter-pack rules join the
// exact same create -> submit -> batch-propose pipeline real extraction
// output goes through, for orgs whose local sources are too thin to
// extract much from. See test/prebrain/starter-packs.test.ts for the pack
// data itself (loads, required fields, honesty-framing heuristic).

test("starter-pack rules flow through create -> submit -> batch-propose when local sources are thin", async () => {
  // repoRoot stays empty -- no write() call -- so real chunk collection
  // yields zero chunks, exercising the actual "local sources are thin"
  // scenario 2.5 exists for.
  const calls: { url: string; method: string | undefined; body: string | undefined }[] = [];
  let nextId = 1;

  globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, method: init?.method, body: init?.body as string | undefined });
    if (url.endsWith("/v1/rules") && init?.method === "POST") {
      return Promise.resolve(new Response(JSON.stringify({ id: `id-${nextId++}` }), { status: 201 }));
    }
    if (url.includes("/submit")) {
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }
    if (url.endsWith("/v1/rules/batch-propose")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ pr_number: 7, pr_url: "https://github.com/acme/rules/pull/7", rules: [] }),
          { status: 200 },
        ),
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;

  const deps: PrebrainDeps = {
    collectProfile: () => Promise.resolve(FIXED_PROFILE),
    // Real extraction must never run when there are zero real chunks --
    // a rejection here would surface loudly (as a failed run) if that
    // invariant broke.
    extract: () => Promise.reject(new Error("extract should not be called with zero real chunks")),
  };

  await runPrebrain({ starterPacks: "expense-approval", yes: true }, deps);

  const createCalls = calls.filter((c) => c.url.endsWith("/v1/rules") && c.method === "POST");
  expect(createCalls.length).toBe(4); // expense-approval pack has 4 rules
  for (const call of createCalls) {
    const body = JSON.parse(call.body ?? "{}");
    expect(body.source).toBe("gnt.ai starter pack: expense-approval");
    expect(body.tags).toContain("expense-approval");
  }

  expect(calls.some((c) => c.url.endsWith("/v1/rules/batch-propose"))).toBe(true);

  const output = logs.join("\n");
  expect(output).toContain("Added 4 starter-pack rules from 1 pack: expense-approval");
  expect(output).toContain("Opened PR: https://github.com/acme/rules/pull/7");
});

test("combines real extraction output with starter-pack rules in one run, batching and proposing both", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");

  const idToTitle = new Map<string, string>();
  const batchCalls: string[][] = [];
  let nextId = 1;

  globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/v1/rules") && init?.method === "POST") {
      const body = JSON.parse(init.body as string);
      const id = `id-${nextId++}`;
      idToTitle.set(id, body.title);
      return Promise.resolve(new Response(JSON.stringify({ id }), { status: 201 }));
    }
    if (url.includes("/submit")) {
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }
    if (url.endsWith("/v1/rules/batch-propose")) {
      const body = JSON.parse(init?.body as string);
      batchCalls.push(body.rule_ids.map((id: string) => idToTitle.get(id) ?? id));
      return Promise.resolve(
        new Response(
          JSON.stringify({ pr_number: 3, pr_url: "https://github.com/acme/rules/pull/3", rules: [] }),
          { status: 200 },
        ),
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;

  const deps: PrebrainDeps = {
    collectProfile: () => Promise.resolve(FIXED_PROFILE),
    extract: () => Promise.resolve([extractedRule({ title: "Custom local policy", tags: ["custom-local-topic"] })]),
  };

  await runPrebrain({ starterPacks: "incident-response,expense-approval", yes: true }, deps);

  // 3 topic buckets: the real extraction's own tag, plus each requested
  // starter pack's own tag (starter-pack rules tag themselves with their
  // own pack id -- see starter-packs/index.ts) -- no special-casing in
  // groupByTopic itself, same bucketing logic either output goes through.
  expect(batchCalls.length).toBe(3);

  const realBatch = batchCalls.find((titles) => titles.includes("Custom local policy"));
  expect(realBatch).toEqual(["Custom local policy"]);

  const incidentBatch = batchCalls.find((titles) => titles.includes("Sev1 incidents page the on-call engineer immediately"));
  expect(incidentBatch?.length).toBe(6); // incident-response pack has 6 rules

  const expenseBatch = batchCalls.find((titles) => titles.includes("Company cards have a default spend limit"));
  expect(expenseBatch?.length).toBe(4); // expense-approval pack has 4 rules

  const output = logs.join("\n");
  // The whole point of the separate summary lines: nobody reading this
  // output can mistake generic starter content for something prebrain
  // found in the customer's own README.
  expect(output).toContain("1 candidate rule extracted from your own sources");
  expect(output).toContain("10 starter-pack rules added (incident-response, expense-approval)");
  expect(output).toContain("Grouped into 3 batches for review.");
});

test("an unknown --starter-packs id is reported but doesn't block the valid packs in the same run", async () => {
  globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/v1/rules") && init?.method === "POST") {
      return Promise.resolve(new Response(JSON.stringify({ id: "id-1" }), { status: 201 }));
    }
    if (url.includes("/submit")) {
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }
    if (url.endsWith("/v1/rules/batch-propose")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ pr_number: 11, pr_url: "https://github.com/acme/rules/pull/11", rules: [] }),
          { status: 200 },
        ),
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;

  const deps: PrebrainDeps = {
    collectProfile: () => Promise.resolve(FIXED_PROFILE),
    extract: () => Promise.reject(new Error("extract should not be called with zero real chunks")),
  };

  await runPrebrain({ starterPacks: "expense-approval,not-a-real-pack", yes: true }, deps);

  const output = logs.join("\n");
  expect(output).toContain("Unknown starter pack id, skipping: not-a-real-pack");
  expect(output).toContain("Added 4 starter-pack rules from 1 pack: expense-approval");
  expect(output).toContain("Opened PR: https://github.com/acme/rules/pull/11");
});
