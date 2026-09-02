// Same GNT_CONFIG_DIR-before-import pattern as test/gaps.test.ts -- avoids
// touching a real user's actual ~/.gnt/credentials.json. `open` is mocked
// the same way test/connect-slack.test.ts mocks it, so a passing test never
// actually pops a browser.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testConfigDir = mkdtempSync(join(tmpdir(), "gnt-billing-test-"));
process.env.GNT_CONFIG_DIR = testConfigDir;

const openMock = mock(() => Promise.resolve());
mock.module("open", () => ({ default: openMock }));

const { saveApiKey } = await import("../src/credentials.js");
const { billing } = await import("../src/commands/billing.js");

const credentialsPath = join(testConfigDir, "credentials.json");

let originalFetch: typeof fetch;
let logs: string[];
let originalLog: typeof console.log;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  saveApiKey("gnt_live_test_key", "key-id");
  openMock.mockClear();
  logs = [];
  originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  rmSync(credentialsPath, { force: true });
});

function stubExit() {
  const originalExit = process.exit;
  const exitCalls: number[] = [];
  // @ts-expect-error -- stubbing process.exit for the test
  process.exit = (code?: number) => {
    exitCalls.push(code ?? 0);
    throw new Error("process.exit called");
  };
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };
  return {
    exitCalls,
    errors,
    restore: () => {
      process.exit = originalExit;
      console.error = originalError;
    },
  };
}

test("goes through checkout when there's no subscription yet", async () => {
  const fetchMock = mock((url: string) => {
    if (url.includes("/v1/billing/status")) {
      return Promise.resolve(
        new Response(JSON.stringify({ subscription_status: null }), { status: 200 }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ url: "https://checkout.stripe.com/session" }), { status: 200 }),
    );
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  await billing();

  const calls = fetchMock.mock.calls as [string, RequestInit][];
  expect(calls[1][0]).toContain("/v1/billing/checkout");
  expect(logs.join("\n")).toContain("https://checkout.stripe.com/session");
});

test("goes through the portal once a subscription exists", async () => {
  const fetchMock = mock((url: string) => {
    if (url.includes("/v1/billing/status")) {
      return Promise.resolve(
        new Response(JSON.stringify({ subscription_status: "active" }), { status: 200 }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ url: "https://billing.stripe.com/portal" }), { status: 200 }),
    );
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  await billing();

  const calls = fetchMock.mock.calls as [string, RequestInit][];
  expect(calls[1][0]).toContain("/v1/billing/portal");
  expect(logs.join("\n")).toContain("https://billing.stripe.com/portal");
});

test("prints JSON without opening a browser when requested", async () => {
  const fetchMock = mock((url: string) => {
    if (url.includes("/v1/billing/status")) {
      return Promise.resolve(
        new Response(JSON.stringify({ subscription_status: null }), { status: 200 }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ url: "https://checkout.stripe.com/session" }), { status: 200 }),
    );
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  await billing({ json: true });

  expect(JSON.parse(logs.join(""))).toEqual({
    type: "checkout",
    url: "https://checkout.stripe.com/session",
  });
  expect(openMock).not.toHaveBeenCalled();
});

test("exits with a failure message on a non-ok status response", async () => {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response("", { status: 500 })),
  ) as unknown as typeof fetch;
  const { exitCalls, errors, restore } = stubExit();

  try {
    await expect(billing()).rejects.toThrow("process.exit called");
  } finally {
    restore();
  }

  expect(exitCalls).toEqual([1]);
  expect(errors.join("\n")).toContain("Failed to fetch billing status (500).");
});

test("exits with a failure message when the status fetch throws", async () => {
  globalThis.fetch = mock(() => Promise.reject(new Error("network down"))) as unknown as typeof fetch;
  const { exitCalls, errors, restore } = stubExit();

  try {
    await expect(billing()).rejects.toThrow("process.exit called");
  } finally {
    restore();
  }

  expect(exitCalls).toEqual([1]);
  expect(errors.join("\n")).toContain("Failed to fetch billing status.");
});

test("exits with a failure message when the checkout/portal fetch throws", async () => {
  const fetchMock = mock((url: string) => {
    if (url.includes("/v1/billing/status")) {
      return Promise.resolve(
        new Response(JSON.stringify({ subscription_status: null }), { status: 200 }),
      );
    }
    return Promise.reject(new Error("network down"));
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const { exitCalls, errors, restore } = stubExit();

  try {
    await expect(billing()).rejects.toThrow("process.exit called");
  } finally {
    restore();
  }

  expect(exitCalls).toEqual([1]);
  expect(errors.join("\n")).toContain("Failed to start billing.");
});
