// Tests the direct-REST Airtable client against a fake fetch -- no real
// network call, no MCP client, no child process, ever runs in this file.
// Fixtures are shaped like Airtable's own published Web API responses
// (airtable.com/developers/web/api), including record fields that were
// never picked in the connect flow (an "Email", an "SSN"), so the
// field-discipline tests below have something real to prove is
// structurally unreachable, not merely unread.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  AIRTABLE_ENDPOINTS,
  AirtableApiError,
  getBaseSchema,
  hasStoredAirtableConnection,
  listAccessibleBases,
  MissingAirtableConfigError,
  MissingAirtableTokenError,
  resolveAirtableToken,
  serializeAirtableConfig,
  walkAirtable,
} from "../../src/prebrain/airtable.js";
import type { AirtableConnectorConfig } from "../../src/prebrain/airtable.js";

let originalTokenEnv: string | undefined;

beforeEach(() => {
  originalTokenEnv = process.env.GNT_AIRTABLE_TOKEN;
  delete process.env.GNT_AIRTABLE_TOKEN;
});

afterEach(() => {
  if (originalTokenEnv === undefined) delete process.env.GNT_AIRTABLE_TOKEN;
  else process.env.GNT_AIRTABLE_TOKEN = originalTokenEnv;
});

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
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

function config(overrides: Partial<AirtableConnectorConfig> = {}): AirtableConnectorConfig {
  return {
    token: "airtable-pat-secret",
    baseId: "appBase123",
    baseName: "Support Playbook",
    tables: [{ tableId: "tblNotes", tableName: "Playbook", allowedFields: ["Notes"] }],
    ...overrides,
  };
}

// Shaped like Airtable's own GET /v0/{baseId}/{tableIdOrName} response: the
// picked field ("Notes") sitting alongside fields nobody picked in the
// connect flow (a real email, a real SSN-shaped value) -- exactly the
// unpicked-but-present shape buildRecordDocument has to strip.
function fixtureRecords() {
  return {
    records: [
      {
        id: "recAAA111",
        createdTime: "2026-07-01T12:00:00Z",
        fields: {
          Notes: "Refunds over $500 require manager approval before processing.",
          Email: "jordan.lee@acme-corp-fake.test",
          SSN: "078-05-1120",
          Priority: 3,
        },
      },
    ],
  };
}

test("reads a record's own allowed field into a chunk tagged airtable, with the record's Airtable deep link as sourcePath", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl = fakeFetch(() => ({ body: fixtureRecords() }), calls);

  const chunks = await walkAirtable({ storedConfig: serializeAirtableConfig(config()), fetchImpl });

  expect(chunks.length).toBeGreaterThan(0);
  for (const chunk of chunks) {
    expect(chunk.walker).toBe("airtable");
    expect(chunk.sourcePath).toBe("https://airtable.com/appBase123/tblNotes/recAAA111");
  }
  const combined = chunks.map((c) => c.text).join("\n");
  expect(combined).toContain("Refunds over $500 require manager approval before processing.");
});

test("an unpicked field never reaches a chunk, even though it's present on every raw record Airtable returns", async () => {
  const fetchImpl = fakeFetch(() => ({ body: fixtureRecords() }));

  const chunks = await walkAirtable({ storedConfig: serializeAirtableConfig(config()), fetchImpl });

  const serialized = JSON.stringify(chunks);
  expect(serialized).not.toContain("jordan.lee@acme-corp-fake.test");
  expect(serialized).not.toContain("078-05-1120");
  expect(serialized).not.toContain("Email");
  expect(serialized).not.toContain("SSN");
  expect(serialized).not.toContain("Priority");
});

test("a table with no fields picked is never queried at all -- fetch is never called for its records endpoint", async () => {
  let called = false;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/v0/appBase123/tblEmpty")) {
      called = true;
      throw new Error("walkAirtable must never fetch a table with zero picked fields");
    }
    return new Response(JSON.stringify({ records: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  const chunks = await walkAirtable({
    storedConfig: serializeAirtableConfig(
      config({ tables: [{ tableId: "tblEmpty", tableName: "Contacts", allowedFields: [] }] }),
    ),
    fetchImpl,
  });

  expect(called).toBe(false);
  expect(chunks).toEqual([]);
});

test("each table's allowlist is independent -- a field allowed on one table is still stripped on another that didn't pick it", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl = fakeFetch((url) => {
    if (url.includes("tblPlaybook")) {
      return {
        body: {
          records: [{ id: "rec1", fields: { Notes: "Escalate to on-call after 15 minutes.", Owner: "alex@acme-corp-fake.test" } }],
        },
      };
    }
    return {
      body: {
        records: [{ id: "rec2", fields: { Notes: "leaked if allowlist bled across tables", Owner: "sam@acme-corp-fake.test" } }],
      },
    };
  }, calls);

  const chunks = await walkAirtable({
    storedConfig: serializeAirtableConfig(
      config({
        tables: [
          { tableId: "tblPlaybook", tableName: "Playbook", allowedFields: ["Notes", "Owner"] },
          { tableId: "tblContacts", tableName: "Contacts", allowedFields: [] },
        ],
      }),
    ),
    fetchImpl,
  });

  // tblContacts has zero picked fields, so it's skipped entirely --
  // nothing from rec2 (including its Notes field) should surface.
  expect(calls.some((c) => c.url.includes("tblContacts"))).toBe(false);
  const serialized = JSON.stringify(chunks);
  expect(serialized).not.toContain("leaked if allowlist bled across tables");
  expect(serialized).toContain("Escalate to on-call after 15 minutes.");
  expect(serialized).toContain("alex@acme-corp-fake.test");
});

test("calls only the documented records endpoint, scoped server-side to the allowed fields, with the token in the Authorization header, never in the URL", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl = fakeFetch(() => ({ body: fixtureRecords() }), calls);

  await walkAirtable({ storedConfig: serializeAirtableConfig(config()), fetchImpl });

  expect(calls.length).toBe(1);
  expect(calls[0].url).toBe("https://api.airtable.com/v0/appBase123/tblNotes?pageSize=100&fields%5B%5D=Notes");
  expect(calls[0].url).not.toContain("airtable-pat-secret");
  expect(calls[0].headers.Authorization).toBe("Bearer airtable-pat-secret");
});

test("sends every allowed field name as its own repeated fields param, in the table's saved order", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl = fakeFetch(() => ({ body: { records: [] } }), calls);

  await walkAirtable({
    storedConfig: serializeAirtableConfig(
      config({ tables: [{ tableId: "tblNotes", tableName: "Playbook", allowedFields: ["Notes", "Owner"] }] }),
    ),
    fetchImpl,
  });

  const url = new URL(calls[0].url);
  // Airtable's List Records endpoint only accepts array-typed query params
  // in bracket notation -- fields[]=..., not a bare repeated fields=...
  // (confirmed against the real API: the latter 422s).
  expect(url.searchParams.getAll("fields[]")).toEqual(["Notes", "Owner"]);
});

test("throws MissingAirtableConfigError when no connection was ever saved", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  await expect(walkAirtable({ fetchImpl })).rejects.toThrow(MissingAirtableConfigError);
  await expect(walkAirtable({ storedConfig: "not json", fetchImpl })).rejects.toThrow(MissingAirtableConfigError);
  await expect(walkAirtable({ storedConfig: JSON.stringify({ baseId: "x" }), fetchImpl })).rejects.toThrow(
    MissingAirtableConfigError,
  );
  expect(called).toBe(false);
});

test("token resolution: an explicit override wins over GNT_AIRTABLE_TOKEN, which wins over the saved config's token", async () => {
  process.env.GNT_AIRTABLE_TOKEN = "env-token";
  const calls: RecordedCall[] = [];
  const fetchImpl = fakeFetch(() => ({ body: { records: [] } }), calls);

  await walkAirtable({ storedConfig: serializeAirtableConfig(config()), fetchImpl, token: "explicit-token" });
  expect(calls[0].headers.Authorization).toBe("Bearer explicit-token");

  calls.length = 0;
  await walkAirtable({ storedConfig: serializeAirtableConfig(config()), fetchImpl });
  expect(calls[0].headers.Authorization).toBe("Bearer env-token");

  delete process.env.GNT_AIRTABLE_TOKEN;
  calls.length = 0;
  await walkAirtable({ storedConfig: serializeAirtableConfig(config()), fetchImpl });
  expect(calls[0].headers.Authorization).toBe("Bearer airtable-pat-secret");
});

test("resolveAirtableToken throws MissingAirtableTokenError with no token from any source", () => {
  expect(() => resolveAirtableToken(undefined, undefined)).toThrow(MissingAirtableTokenError);
});

test("a record whose declared field is present but blank, or of a non-string shape, contributes nothing", async () => {
  const fetchImpl = fakeFetch(() => ({
    body: {
      records: [
        { id: "rec1", fields: { Notes: "   " } },
        { id: "rec2", fields: { Notes: 42 } },
        { id: "rec3", fields: {} },
      ],
    },
  }));

  const chunks = await walkAirtable({ storedConfig: serializeAirtableConfig(config()), fetchImpl });
  expect(chunks).toEqual([]);
});

test("a malformed records payload degrades gracefully -- no records array, or an entry with no fields object, yield no chunks and never throw", async () => {
  const fetchImplNoRecords = fakeFetch(() => ({ body: { unexpected: "shape" } }));
  const chunksNoRecords = await walkAirtable({
    storedConfig: serializeAirtableConfig(config()),
    fetchImpl: fetchImplNoRecords,
  });
  expect(chunksNoRecords).toEqual([]);

  const fetchImplBadEntries = fakeFetch(() => ({ body: { records: [{ id: "r1" }, "not-an-object", null] } }));
  const chunksBadEntries = await walkAirtable({
    storedConfig: serializeAirtableConfig(config()),
    fetchImpl: fetchImplBadEntries,
  });
  expect(chunksBadEntries).toEqual([]);
});

test("paginates across offset pages up to the documented per-table cap", async () => {
  const page1 = {
    records: Array.from({ length: 100 }, (_, i) => ({ id: `rec${i}`, fields: { Notes: `Decision ${i}: ship it.` } })),
    offset: "page2",
  };
  const page2 = {
    records: Array.from({ length: 100 }, (_, i) => ({ id: `rec${100 + i}`, fields: { Notes: `Decision ${100 + i}: ship it.` } })),
    offset: "page3",
  };
  const page3 = {
    records: Array.from({ length: 100 }, (_, i) => ({ id: `rec${200 + i}`, fields: { Notes: `Decision ${200 + i}: ship it.` } })),
  };
  const calls: RecordedCall[] = [];
  const fetchImpl = fakeFetch((url) => {
    if (!url.includes("offset=")) return { body: page1 };
    if (url.includes("offset=page2")) return { body: page2 };
    return { body: page3 };
  }, calls);

  const chunks = await walkAirtable({ storedConfig: serializeAirtableConfig(config()), fetchImpl });

  // Capped at 200 records, so page3 is never requested.
  expect(calls.length).toBe(2);
  const recordCount = new Set(chunks.map((c) => c.sourcePath)).size;
  expect(recordCount).toBe(200);
});

test("an HTTP error response throws AirtableApiError naming the table and status, and never leaks the token into the message", async () => {
  const fetchImpl = fakeFetch(() => ({ body: { error: { type: "NOT_AUTHORIZED", message: "Invalid permissions" } }, status: 403 }));

  try {
    await walkAirtable({ storedConfig: serializeAirtableConfig(config()), fetchImpl });
    throw new Error("expected walkAirtable to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(AirtableApiError);
    const message = err instanceof Error ? err.message : String(err);
    expect(message).toContain("tblNotes");
    expect(message).toContain("403");
    expect(message).not.toContain("airtable-pat-secret");
  }
});

test("a network-level failure surfaces as AirtableApiError, not a raw rejection", async () => {
  const fetchImpl = (async () => {
    throw new Error("ECONNRESET");
  }) as unknown as typeof fetch;

  await expect(walkAirtable({ storedConfig: serializeAirtableConfig(config()), fetchImpl })).rejects.toThrow(
    AirtableApiError,
  );
});

test("listAccessibleBases calls GET /v0/meta/bases with the token in the Authorization header, never in the URL", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl = fakeFetch(
    () => ({ body: { bases: [{ id: "appBase123", name: "Support Playbook", permissionLevel: "create" }] } }),
    calls,
  );

  const bases = await listAccessibleBases("secret-token", fetchImpl);

  expect(calls.length).toBe(1);
  expect(calls[0].url).toBe("https://api.airtable.com/v0/meta/bases");
  expect(calls[0].url).not.toContain("secret-token");
  expect(calls[0].headers.Authorization).toBe("Bearer secret-token");
  expect(bases).toEqual([{ id: "appBase123", name: "Support Playbook", permissionLevel: "create" }]);
});

test("listAccessibleBases throws AirtableApiError on a non-200 response, without leaking the token", async () => {
  const fetchImpl = fakeFetch(() => ({ body: { error: "NOT_AUTHORIZED" }, status: 401 }));

  try {
    await listAccessibleBases("secret-token", fetchImpl);
    throw new Error("expected listAccessibleBases to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(AirtableApiError);
    const message = err instanceof Error ? err.message : String(err);
    expect(message).not.toContain("secret-token");
  }
});

test("getBaseSchema reads a base's live tables and fields from the documented metadata endpoint", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl = fakeFetch(
    () => ({
      body: {
        tables: [
          {
            id: "tblNotes",
            name: "Playbook",
            primaryFieldId: "fldTitle",
            fields: [
              { id: "fldTitle", name: "Title", type: "singleLineText" },
              { id: "fldNotes", name: "Notes", type: "multilineText" },
              { id: "fldEmail", name: "Owner Email", type: "email" },
            ],
          },
        ],
      },
    }),
    calls,
  );

  const tables = await getBaseSchema("appBase123", "secret-token", fetchImpl);

  expect(calls[0].url).toBe("https://api.airtable.com/v0/meta/bases/appBase123/tables");
  expect(tables).toEqual([
    {
      id: "tblNotes",
      name: "Playbook",
      fields: [
        { id: "fldTitle", name: "Title", type: "singleLineText" },
        { id: "fldNotes", name: "Notes", type: "multilineText" },
        { id: "fldEmail", name: "Owner Email", type: "email" },
      ],
    },
  ]);
});

test("hasStoredAirtableConnection reflects exactly what walkAirtable would accept -- valid config true, missing/malformed false", () => {
  expect(hasStoredAirtableConnection(undefined)).toBe(false);
  expect(hasStoredAirtableConnection("not json")).toBe(false);
  expect(hasStoredAirtableConnection(JSON.stringify({ baseId: "x" }))).toBe(false);
  expect(hasStoredAirtableConnection(serializeAirtableConfig(config()))).toBe(true);
});

test("the exhaustive endpoint list matches the exact three paths this file ever fetches", () => {
  expect(AIRTABLE_ENDPOINTS.map((e) => e.path)).toEqual([
    "GET /v0/meta/bases",
    "GET /v0/meta/bases/{baseId}/tables",
    "GET /v0/{baseId}/{tableIdOrName}",
  ]);
});
