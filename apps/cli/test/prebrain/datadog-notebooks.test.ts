// Tests the direct-REST Datadog notebooks client against a fake fetch -- no
// real network call, no MCP client, no child process, ever runs in this
// file. Fixtures are shaped like Datadog's own published Notebooks API
// response (docs.datadoghq.com/api/latest/notebooks/), including a
// timeseries cell whose definition carries a real metric query and an
// author object with a real name/email, so the field-discipline tests
// below have something real to prove is stripped.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  DATADOG_ENDPOINTS,
  DatadogApiError,
  MissingDatadogCredentialsError,
  resolveDatadogCredentials,
  serializeDatadogCredentials,
  validateDatadogCredentials,
  walkDatadogNotebooks,
} from "../../src/prebrain/datadog-notebooks.js";

let originalApiKeyEnv: string | undefined;
let originalAppKeyEnv: string | undefined;
let originalSiteEnv: string | undefined;

beforeEach(() => {
  originalApiKeyEnv = process.env.GNT_DATADOG_API_KEY;
  originalAppKeyEnv = process.env.GNT_DATADOG_APP_KEY;
  originalSiteEnv = process.env.GNT_DATADOG_SITE;
  delete process.env.GNT_DATADOG_API_KEY;
  delete process.env.GNT_DATADOG_APP_KEY;
  delete process.env.GNT_DATADOG_SITE;
});

afterEach(() => {
  if (originalApiKeyEnv === undefined) delete process.env.GNT_DATADOG_API_KEY;
  else process.env.GNT_DATADOG_API_KEY = originalApiKeyEnv;
  if (originalAppKeyEnv === undefined) delete process.env.GNT_DATADOG_APP_KEY;
  else process.env.GNT_DATADOG_APP_KEY = originalAppKeyEnv;
  if (originalSiteEnv === undefined) delete process.env.GNT_DATADOG_SITE;
  else process.env.GNT_DATADOG_SITE = originalSiteEnv;
});

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
}

// Shaped like Datadog's own GET /api/v1/notebooks/{notebook_id} response:
// a markdown cell (the only cell type this connector ever reads) sitting
// alongside a timeseries cell (a real metric query, never read), an author
// object (a real name/email, never read), and status/timestamps (never
// read).
function fixtureNotebook(name: string, markdownText: string) {
  return {
    data: {
      id: "998877",
      type: "notebooks",
      attributes: {
        name,
        status: "published",
        created: "2026-07-01T12:00:00Z",
        modified: "2026-07-02T09:30:00Z",
        author: { name: "Jordan Lee", handle: "jordan.lee", email: "jordan.lee@acme-corp-fake.test" },
        time: { live: false, start: "2026-07-01T00:00:00Z", end: "2026-07-01T06:00:00Z" },
        cells: [
          {
            id: "cell-1",
            type: "notebook_cells",
            attributes: { definition: { type: "markdown", text: markdownText } },
          },
          {
            id: "cell-2",
            type: "notebook_cells",
            attributes: {
              definition: {
                type: "timeseries",
                requests: [{ q: "avg:trace.express.request.duration{service:checkout-api,env:prod}" }],
              },
            },
          },
          {
            id: "cell-3",
            type: "notebook_cells",
            attributes: {
              definition: {
                type: "log_stream",
                query: "service:checkout-api status:error",
              },
            },
          },
        ],
      },
    },
  };
}

function fakeFetch(
  respond: (url: string) => { body: unknown; status?: number },
  calls: RecordedCall[] = [],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers });
    const { body, status } = respond(url);
    return new Response(JSON.stringify(body), { status: status ?? 200 });
  }) as unknown as typeof fetch;
}

test("reads a notebook's title and markdown cell text into a chunk tagged datadog-notebooks, with the notebook's app URL as sourcePath", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl = fakeFetch(
    () => ({ body: fixtureNotebook("Incident 4821 postmortem", "## Root cause\n\nA bad deploy rolled back late.") }),
    calls,
  );

  const chunks = await walkDatadogNotebooks({
    apiKey: "dd-api-key",
    appKey: "dd-app-key",
    notebookIds: ["998877"],
    fetchImpl,
  });

  expect(chunks.length).toBeGreaterThan(0);
  for (const chunk of chunks) {
    expect(chunk.walker).toBe("datadog-notebooks");
    expect(chunk.sourcePath).toBe("https://app.datadoghq.com/notebook/998877");
  }
  const combined = chunks.map((c) => c.text).join("\n");
  expect(combined).toContain("Incident 4821 postmortem");
  expect(combined).toContain("A bad deploy rolled back late.");
});

test("calls only the documented notebook endpoint with both auth headers, never in the URL", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl = fakeFetch(() => ({ body: fixtureNotebook("Runbook: checkout outage", "Steps to mitigate.") }), calls);

  await walkDatadogNotebooks({ apiKey: "dd-api-key", appKey: "dd-app-key", notebookIds: ["998877"], fetchImpl });

  expect(calls.length).toBe(1);
  expect(calls[0].url).toBe("https://api.datadoghq.com/api/v1/notebooks/998877");
  expect(calls[0].url).not.toContain("dd-api-key");
  expect(calls[0].url).not.toContain("dd-app-key");
  expect(calls[0].headers["DD-API-KEY"]).toBe("dd-api-key");
  expect(calls[0].headers["DD-APPLICATION-KEY"]).toBe("dd-app-key");
});

test("strips author identity, status, timestamps, and every non-markdown cell's definition -- a fixture with a real metric query and a real author never leaks into a chunk", async () => {
  const fetchImpl = fakeFetch(() => ({
    body: fixtureNotebook("Checkout latency postmortem", "The regression traced back to a connection pool leak."),
  }));

  const chunks = await walkDatadogNotebooks({
    apiKey: "dd-api-key",
    appKey: "dd-app-key",
    notebookIds: ["998877"],
    fetchImpl,
  });

  const serialized = JSON.stringify(chunks);
  expect(serialized).not.toContain("Jordan Lee");
  expect(serialized).not.toContain("jordan.lee@acme-corp-fake.test");
  expect(serialized).not.toContain("jordan.lee");
  expect(serialized).not.toContain("published");
  expect(serialized).not.toContain("2026-07-01T12:00:00Z");
  expect(serialized).not.toContain("2026-07-02T09:30:00Z");
  expect(serialized).not.toContain("trace.express.request.duration");
  expect(serialized).not.toContain("checkout-api");
  expect(serialized).not.toContain("status:error");
  expect(serialized).not.toContain("timeseries");
  expect(serialized).not.toContain("log_stream");
});

test("the exhaustive endpoint list never references metrics, monitors, or logs, and matches the exact two paths this file ever fetches", () => {
  for (const endpoint of DATADOG_ENDPOINTS) {
    expect(endpoint.path.toLowerCase()).not.toMatch(/metric|monitor|log/);
    expect(endpoint.description.toLowerCase()).not.toMatch(/metric|monitor|log/);
  }
  expect(DATADOG_ENDPOINTS.map((e) => e.path)).toEqual([
    "GET /api/v1/notebooks/{notebook_id}",
    "GET /api/v1/notebooks",
  ]);
});

test("reads across multiple notebook ids, one request per id", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl = fakeFetch((url) => {
    if (url.endsWith("/notebooks/111")) {
      return { body: fixtureNotebook("Notebook A", "Ship the read-replica fix.") };
    }
    return { body: fixtureNotebook("Notebook B", "Keep the old retry policy for now.") };
  }, calls);

  const chunks = await walkDatadogNotebooks({
    apiKey: "k",
    appKey: "a",
    notebookIds: ["111", "222"],
    fetchImpl,
  });

  expect(calls.length).toBe(2);
  const sourcePaths = new Set(chunks.map((c) => c.sourcePath));
  expect(sourcePaths.has("https://app.datadoghq.com/notebook/111")).toBe(true);
  expect(sourcePaths.has("https://app.datadoghq.com/notebook/222")).toBe(true);
});

test("returns [] and never calls fetch when notebookIds is empty, even with no credentials available", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const chunks = await walkDatadogNotebooks({ notebookIds: [], fetchImpl });

  expect(chunks).toEqual([]);
  expect(called).toBe(false);
});

test("throws MissingDatadogCredentialsError when either key is missing, and never attempts to fetch", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  await expect(walkDatadogNotebooks({ appKey: "a", notebookIds: ["998877"], fetchImpl })).rejects.toThrow(
    MissingDatadogCredentialsError,
  );
  await expect(walkDatadogNotebooks({ apiKey: "k", notebookIds: ["998877"], fetchImpl })).rejects.toThrow(
    MissingDatadogCredentialsError,
  );
  expect(called).toBe(false);
});

test("resolveDatadogCredentials: explicit values win over env vars, which win over stored credentials, applied per field", () => {
  process.env.GNT_DATADOG_API_KEY = "env-api-key";
  process.env.GNT_DATADOG_SITE = "datadoghq.eu";
  const stored = serializeDatadogCredentials({ apiKey: "stored-api-key", appKey: "stored-app-key", site: "us3.datadoghq.com" });

  const resolved = resolveDatadogCredentials({ appKey: "explicit-app-key", storedCredentials: stored });
  expect(resolved).toEqual({ apiKey: "env-api-key", appKey: "explicit-app-key", site: "datadoghq.eu" });

  delete process.env.GNT_DATADOG_API_KEY;
  delete process.env.GNT_DATADOG_SITE;
  const resolvedFromStore = resolveDatadogCredentials({ storedCredentials: stored });
  expect(resolvedFromStore).toEqual({ apiKey: "stored-api-key", appKey: "stored-app-key", site: "us3.datadoghq.com" });

  expect(() => resolveDatadogCredentials({})).toThrow(MissingDatadogCredentialsError);
});

test("resolveDatadogCredentials defaults site to datadoghq.com when nothing names one", () => {
  const resolved = resolveDatadogCredentials({ apiKey: "k", appKey: "a" });
  expect(resolved.site).toBe("datadoghq.com");
});

test("a malformed notebook payload degrades gracefully -- no attributes, no cells, or a cell missing a definition, yield no chunks and never throw", async () => {
  const fetchImplNoAttrs = fakeFetch(() => ({ body: { data: { id: "1" } } }));
  const chunksNoAttrs = await walkDatadogNotebooks({
    apiKey: "k",
    appKey: "a",
    notebookIds: ["1"],
    fetchImpl: fetchImplNoAttrs,
  });
  expect(chunksNoAttrs).toEqual([]);

  const fetchImplEmptyName = fakeFetch(() => ({
    body: { data: { id: "1", attributes: { name: "", cells: [{ attributes: {} }, "not-an-object", null] } } },
  }));
  const chunksEmptyName = await walkDatadogNotebooks({
    apiKey: "k",
    appKey: "a",
    notebookIds: ["1"],
    fetchImpl: fetchImplEmptyName,
  });
  expect(chunksEmptyName).toEqual([]);
});

test("a notebook with only non-markdown cells produces no chunks, even though the notebook has a title", async () => {
  const fetchImpl = fakeFetch(() => ({
    body: {
      data: {
        id: "1",
        attributes: {
          name: "",
          cells: [{ attributes: { definition: { type: "timeseries", requests: [] } } }],
        },
      },
    },
  }));

  const chunks = await walkDatadogNotebooks({ apiKey: "k", appKey: "a", notebookIds: ["1"], fetchImpl });
  expect(chunks).toEqual([]);
});

test("an HTTP error response throws DatadogApiError naming the notebook id and status, and never leaks either credential into the message", async () => {
  const fetchImpl = fakeFetch(() => ({ body: { errors: ["Forbidden"] }, status: 403 }));

  try {
    await walkDatadogNotebooks({ apiKey: "dd-api-key-secret", appKey: "dd-app-key-secret", notebookIds: ["998877"], fetchImpl });
    throw new Error("expected walkDatadogNotebooks to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(DatadogApiError);
    const message = err instanceof Error ? err.message : String(err);
    expect(message).toContain("998877");
    expect(message).toContain("403");
    expect(message).not.toContain("dd-api-key-secret");
    expect(message).not.toContain("dd-app-key-secret");
  }
});

test("a network-level failure surfaces as DatadogApiError, not a raw rejection", async () => {
  const fetchImpl = (async () => {
    throw new Error("ECONNRESET");
  }) as unknown as typeof fetch;

  await expect(
    walkDatadogNotebooks({ apiKey: "k", appKey: "a", notebookIds: ["998877"], fetchImpl }),
  ).rejects.toThrow(DatadogApiError);
});

test("validateDatadogCredentials calls the list-notebooks endpoint with count=1 and resolves on success", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl = fakeFetch(() => ({ body: { data: [], meta: { page: { total_count: 0 } } } }), calls);

  await validateDatadogCredentials({ apiKey: "k", appKey: "a", site: "datadoghq.com" }, fetchImpl);

  expect(calls.length).toBe(1);
  expect(calls[0].url).toBe("https://api.datadoghq.com/api/v1/notebooks?count=1&start=0");
  expect(calls[0].headers["DD-API-KEY"]).toBe("k");
  expect(calls[0].headers["DD-APPLICATION-KEY"]).toBe("a");
});

test("validateDatadogCredentials throws DatadogApiError on a non-200 response, without leaking either credential", async () => {
  const fetchImpl = fakeFetch(() => ({ body: { errors: ["Forbidden"] }, status: 403 }));

  try {
    await validateDatadogCredentials({ apiKey: "dd-api-key-secret", appKey: "dd-app-key-secret", site: "datadoghq.com" }, fetchImpl);
    throw new Error("expected validateDatadogCredentials to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(DatadogApiError);
    const message = err instanceof Error ? err.message : String(err);
    expect(message).not.toContain("dd-api-key-secret");
    expect(message).not.toContain("dd-app-key-secret");
  }
});

test("a non-default site is honored in both the API host and the notebook's app URL", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl = fakeFetch(() => ({ body: fixtureNotebook("EU notebook", "EU-region content.") }), calls);

  const chunks = await walkDatadogNotebooks({
    apiKey: "k",
    appKey: "a",
    site: "datadoghq.eu",
    notebookIds: ["998877"],
    fetchImpl,
  });

  expect(calls[0].url).toBe("https://api.datadoghq.eu/api/v1/notebooks/998877");
  expect(chunks[0]?.sourcePath).toBe("https://app.datadoghq.eu/notebook/998877");
});
