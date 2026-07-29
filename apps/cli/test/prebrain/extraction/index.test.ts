// extractRules: the single entry point both modes implement behind one
// interface. No real network call is ever made -- globalThis.fetch is
// mocked, same boundary as cloud.test.ts / local.test.ts.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { DEFAULT_LOCAL_CONCURRENCY, ExtractionError, extractRules } from "../../../src/prebrain/extraction/index.js";
import type { PrebrainChunk } from "../../../src/prebrain/extraction/types.js";

function textResponse(parsed: unknown): Response {
  const body = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    content: [{ type: "text", text: JSON.stringify(parsed) }],
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function chatResponse(content: string): Response {
  return new Response(JSON.stringify({ message: { role: "assistant", content } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const readmeChunk: PrebrainChunk = {
  text: "Refunds over $50 require manager sign-off before processing.",
  sourcePath: "README.md",
  startLine: 42,
  endLine: 58,
  walker: "repo-scan",
};

const boilerplateChunk: PrebrainChunk = {
  text: "This project is licensed under the MIT license.",
  sourcePath: "LICENSE",
  startLine: 1,
  endLine: 1,
  walker: "repo-scan",
};

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("cloud mode: builds a fully-shaped ExtractedRule with provenance attached from the chunk", async () => {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      textResponse({
        rules: [
          {
            title: "Refunds over $50 need manager sign-off",
            body: "Refunds over $50 require manager approval before processing.",
            confidence: 0.85,
            tags: ["refunds", "approvals"],
          },
        ],
      }),
    ),
  ) as unknown as typeof fetch;

  const rules = await extractRules([readmeChunk], { mode: "cloud", apiKey: "sk-ant-test-key" }); // gitleaks:allow

  expect(rules).toHaveLength(1);
  const rule = rules[0]!;
  expect(rule.title).toBe("Refunds over $50 need manager sign-off");
  expect(rule.body).toBe("Refunds over $50 require manager approval before processing.");
  expect(rule.confidence).toBe(0.85);
  expect(rule.tags).toEqual(["refunds", "approvals"]);
  // "README.md:42-58" -- the citation format the downstream pipeline
  // expects so it can pass it straight through as CreateRuleRequest.source.
  expect(rule.source).toBe("README.md:42-58");
  expect(rule.sourceCitations).toHaveLength(1);
  expect(rule.sourceCitations[0]).toMatchObject({
    sourcePath: "README.md",
    startLine: 42,
    endLine: 58,
    walker: "repo-scan",
  });
  expect(rule.sourceCitations[0]?.excerpt).toContain("Refunds over $50");
});

test("a single-line chunk's source string has no line range, just one number", async () => {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      textResponse({
        rules: [{ title: "t", body: "b", confidence: 0.5, tags: [] }],
      }),
    ),
  ) as unknown as typeof fetch;

  const rules = await extractRules([boilerplateChunk], { mode: "cloud", apiKey: "sk-ant-test-key" }); // gitleaks:allow

  expect(rules[0]?.source).toBe("LICENSE:1");
});

test("a chunk with no real decision-prose produces no ExtractedRule at all, not a fabricated one", async () => {
  globalThis.fetch = mock(() => Promise.resolve(textResponse({ rules: [] }))) as unknown as typeof fetch;

  const rules = await extractRules([boilerplateChunk], { mode: "cloud", apiKey: "sk-ant-test-key" }); // gitleaks:allow

  expect(rules).toEqual([]);
});

test("mixed batch: chunks with no rule contribute nothing, chunks with a rule contribute exactly their own rules", async () => {
  const fetchMock = mock((url: string, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? "{}");
    const userText = JSON.stringify(body.messages);
    const isBoilerplate = userText.includes("LICENSE") || userText.includes("MIT license");
    return Promise.resolve(
      textResponse({
        rules: isBoilerplate
          ? []
          : [{ title: "Refunds need sign-off", body: "Refunds over $50 need manager approval.", confidence: 0.8, tags: ["refunds"] }],
      }),
    );
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const rules = await extractRules([readmeChunk, boilerplateChunk], {
    mode: "cloud",
    apiKey: "sk-ant-test-key", // gitleaks:allow
  });

  expect(rules).toHaveLength(1);
  expect(rules[0]?.source).toBe("README.md:42-58");
});

test("local mode dispatches to Ollama's /api/chat instead of Anthropic's API", async () => {
  const fetchMock = mock(() => Promise.resolve(chatResponse(JSON.stringify({ rules: [] }))));
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  await extractRules([readmeChunk], { mode: "local" });

  const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("http://localhost:11434/api/chat");
});

test("a chunk-level failure is surfaced as ExtractionError, not silently turned into 'no rules found'", async () => {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response("service unavailable", { status: 503 })),
  ) as unknown as typeof fetch;

  const failure = extractRules([readmeChunk], { mode: "cloud", apiKey: "sk-ant-test-key" }); // gitleaks:allow
  await expect(failure).rejects.toBeInstanceOf(ExtractionError);
});

test("ExtractionError carries both the chunks that succeeded and which chunks failed", async () => {
  const fetchMock = mock((url: string, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? "{}");
    const userText = JSON.stringify(body.messages);
    if (userText.includes("LICENSE") || userText.includes("MIT license")) {
      return Promise.resolve(new Response("service unavailable", { status: 503 }));
    }
    return Promise.resolve(
      textResponse({
        rules: [{ title: "Refunds need sign-off", body: "Refunds over $50 need manager approval.", confidence: 0.8, tags: [] }],
      }),
    );
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  let caught: ExtractionError | undefined;
  try {
    await extractRules([readmeChunk, boilerplateChunk], { mode: "cloud", apiKey: "sk-ant-test-key" }); // gitleaks:allow
  } catch (err) {
    caught = err as ExtractionError;
  }

  expect(caught).toBeInstanceOf(ExtractionError);
  expect(caught?.partialRules).toHaveLength(1);
  expect(caught?.partialRules[0]?.source).toBe("README.md:42-58");
  expect(caught?.chunkErrors).toHaveLength(1);
  expect(caught?.chunkErrors[0]).toContain("LICENSE:1");
});

test("an empty chunk list returns an empty rule list without calling fetch", async () => {
  const fetchMock = mock(() => Promise.resolve(textResponse({ rules: [] })));
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const rules = await extractRules([], { mode: "cloud", apiKey: "sk-ant-test-key" }); // gitleaks:allow

  expect(rules).toEqual([]);
  expect(fetchMock).not.toHaveBeenCalled();
});

// Regression coverage for the reported bug: a real prebrain run against a
// local Ollama daemon fired every chunk's request at once, overwhelming a
// single local model instance -- 48 chunks timed out in one tester's run.
// These pin the fix: local mode is bounded to DEFAULT_LOCAL_CONCURRENCY
// in-flight requests at a time, cloud mode still fans every chunk out at
// once (a provider built to take that load, not a customer's own laptop).
function manyChunks(count: number): PrebrainChunk[] {
  return Array.from({ length: count }, (_, i) => ({
    text: `chunk body ${i}`,
    sourcePath: `docs/${i}.md`,
    startLine: 1,
    endLine: 1,
    walker: "docs-dir" as const,
  }));
}

// A fetch mock that never resolves on its own -- the test drives exactly
// when each in-flight call completes, so it can observe the concurrency
// cap directly instead of racing real timers. `makeResponse` is mode-
// specific: cloud mode goes through the real Anthropic SDK's
// `messages.parse`, which needs an actual Anthropic-message-shaped body
// (textResponse), not Ollama's `{ message: { content } }` shape
// (chatResponse) -- a shape mismatch there makes the SDK's own retry/parse
// handling do unrelated things, not a clean, fast settle.
function controllableFetch(makeResponse: () => Response) {
  let inFlight = 0;
  let maxInFlight = 0;
  const pending: (() => void)[] = [];
  const fetchMock = mock(() => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise<Response>((resolve) => {
      pending.push(() => {
        inFlight--;
        resolve(makeResponse());
      });
    });
  });
  // Resolves every call currently in flight.
  function releaseWave(): void {
    for (const release of pending.splice(0)) release();
  }
  return { fetchMock, releaseWave, maxInFlight: () => maxInFlight };
}

// The Anthropic SDK (cloud mode) and the plain fetch call (local mode)
// both take an unknown number of real microtask ticks between a worker
// starting and its fetch call actually landing -- polling on the mock's
// own call count, rather than guessing a tick count, is what makes this
// deterministic instead of flaky.
async function waitUntilCalled(fetchMock: ReturnType<typeof mock>, count: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (fetchMock.mock.calls.length < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${count} fetch calls, got ${fetchMock.mock.calls.length}`);
    }
    await new Promise((r) => setTimeout(r, 1));
  }
}

// Drives a concurrency-limited run to completion: waits for each wave of
// up to `waveSize` in-flight calls to actually land, then releases them,
// until `totalCount` calls have been made and released in total.
async function drainInWaves(
  fetchMock: ReturnType<typeof mock>,
  releaseWave: () => void,
  waveSize: number,
  totalCount: number,
): Promise<void> {
  let released = 0;
  while (released < totalCount) {
    const target = Math.min(released + waveSize, totalCount);
    await waitUntilCalled(fetchMock, target);
    releaseWave();
    released = target;
  }
}

test("local mode never has more than DEFAULT_LOCAL_CONCURRENCY chunks in flight against Ollama at once", async () => {
  const chunkCount = DEFAULT_LOCAL_CONCURRENCY * 3;
  const { fetchMock, releaseWave, maxInFlight } = controllableFetch(() =>
    chatResponse(JSON.stringify({ rules: [] })),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const resultPromise = extractRules(manyChunks(chunkCount), { mode: "local" });

  await drainInWaves(fetchMock, releaseWave, DEFAULT_LOCAL_CONCURRENCY, chunkCount);
  const rules = await resultPromise;

  expect(rules).toEqual([]);
  expect(fetchMock).toHaveBeenCalledTimes(chunkCount);
  expect(maxInFlight()).toBeLessThanOrEqual(DEFAULT_LOCAL_CONCURRENCY);
  expect(maxInFlight()).toBeGreaterThan(0);
});

test("cloud mode still fans every chunk out at once, unlike local mode's bounded pool", async () => {
  const chunkCount = DEFAULT_LOCAL_CONCURRENCY * 3;
  const { fetchMock, releaseWave, maxInFlight } = controllableFetch(() => textResponse({ rules: [] }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const resultPromise = extractRules(manyChunks(chunkCount), { mode: "cloud", apiKey: "sk-ant-test-key" }); // gitleaks:allow

  await drainInWaves(fetchMock, releaseWave, chunkCount, chunkCount);
  const rules = await resultPromise;

  expect(rules).toEqual([]);
  expect(fetchMock).toHaveBeenCalledTimes(chunkCount);
  // Every chunk's call was in flight simultaneously, not staggered behind
  // local mode's cap.
  expect(maxInFlight()).toBe(chunkCount);
});
