// Tests the direct-REST HubSpot notes client against a fake fetch -- no
// real network call ever runs in this file. This connector is the sprint's
// declared highest records-leak-risk connector, so the fixtures below are
// deliberately built to look like a real HubSpot response that "hydrates"
// a note with its full associated contact and deal records -- a plausible
// convenience shape a CRM API can return, whether or not HubSpot's own API
// does this today -- so the field-discipline tests have something real to
// prove is stripped, not just something to prove was never requested.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  HUBSPOT_ENDPOINTS,
  HubspotApiError,
  MissingHubspotTokenError,
  resolveHubspotToken,
  validateHubspotToken,
  walkHubspotNotes,
} from "../../src/prebrain/hubspot-notes.js";

let originalEnv: string | undefined;

beforeEach(() => {
  originalEnv = process.env.GNT_HUBSPOT_TOKEN;
  delete process.env.GNT_HUBSPOT_TOKEN;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.GNT_HUBSPOT_TOKEN;
  else process.env.GNT_HUBSPOT_TOKEN = originalEnv;
});

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

// The one request-body shape both the deal-search and notes-search
// assertions below need to look inside -- a typed cast, not `any`, so a
// typo in a test's own assertion path is still caught at compile time.
interface HubspotSearchRequestBody {
  properties?: string[];
  filterGroups: [{ filters: [{ propertyName: string; operator: string; value?: string; values?: string[] }] }];
}

function asSearchBody(body: unknown): HubspotSearchRequestBody {
  return body as HubspotSearchRequestBody;
}

// A note entry shaped like a plausible "hydrated" HubSpot response: the
// note's own body text sits alongside a fully populated embedded contact
// object (email, phone, first/last name) and an embedded deal object
// (amount, dealstage, closedate) -- exactly the highest-leak-risk shape
// the header comment above describes. Real customer PII and real deal financials,
// fenced off with an obviously-fake domain the same way every other
// connector's own test fixtures in this directory are.
function fixtureHydratedNote(id: string, body: string) {
  return {
    id,
    properties: { hs_note_body: body, hs_timestamp: "2026-07-10T12:00:00Z" },
    createdAt: "2026-07-10T12:00:00Z",
    updatedAt: "2026-07-10T12:00:00Z",
    archived: false,
    associations: {
      contacts: { results: [{ id: "9001", type: "note_to_contact" }] },
      deals: { results: [{ id: "5551", type: "note_to_deal" }] },
    },
    contact: {
      id: "9001",
      properties: {
        email: "jordan.buyer@acme-fake.test",
        phone: "+1-555-0100",
        firstname: "Jordan",
        lastname: "Buyer",
      },
    },
    deal: {
      id: "5551",
      properties: { amount: "48000", dealstage: "decisionmakerboughtin", closedate: "2026-08-01" },
    },
  };
}

function fakeFetch(
  respond: (url: string, method: string, body: unknown) => { body: unknown; status?: number },
  calls: RecordedCall[] = [],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const parsedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, headers, body: parsedBody });
    const { body, status } = respond(url, method, parsedBody);
    return new Response(JSON.stringify(body), { status: status ?? 200 });
  }) as unknown as typeof fetch;
}

test("reads a deal-scoped note's body into a chunk tagged hubspot-notes, with a deal/note id sourcePath", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl = fakeFetch((url) => {
    if (url.includes("/deals/search")) return { body: { results: [{ id: "5551" }] } };
    if (url.includes("/associations/notes")) return { body: { results: [{ toObjectId: "301" }] } };
    if (url.includes("/notes/batch/read")) {
      return { body: { results: [fixtureHydratedNote("301", "Deal moving to legal review, expect signature next week.")] } };
    }
    return { body: {} };
  }, calls);

  const chunks = await walkHubspotNotes({ token: "secret-token", pipelineIds: ["pipeline-1"], teamIds: [], fetchImpl });

  expect(chunks.length).toBeGreaterThan(0);
  for (const chunk of chunks) {
    expect(chunk.walker).toBe("hubspot-notes");
    expect(chunk.sourcePath).toBe("hubspot/deals/5551/notes/301");
  }
  expect(chunks.map((c) => c.text).join("\n")).toContain("Deal moving to legal review, expect signature next week.");
});

test("strips embedded contact and deal record data -- a fixture with real PII and deal financials never leaks into a chunk", async () => {
  const fetchImpl = fakeFetch((url) => {
    if (url.includes("/deals/search")) return { body: { results: [{ id: "5551" }] } };
    if (url.includes("/associations/notes")) return { body: { results: [{ toObjectId: "301" }] } };
    if (url.includes("/notes/batch/read")) {
      return { body: { results: [fixtureHydratedNote("301", "Customer wants a Q3 renewal call before the deadline.")] } };
    }
    return { body: {} };
  });

  const chunks = await walkHubspotNotes({ token: "secret-token", pipelineIds: ["pipeline-1"], teamIds: [], fetchImpl });

  const serialized = JSON.stringify(chunks);
  // Contact record fields -- the exact leak this task exists to prevent.
  expect(serialized).not.toContain("jordan.buyer@acme-fake.test");
  expect(serialized).not.toContain("+1-555-0100");
  expect(serialized).not.toContain("Jordan");
  expect(serialized).not.toContain("Buyer");
  // Deal record's own fields -- amount/stage/close date, never the deal
  // itself, only its attached note text.
  expect(serialized).not.toContain("48000");
  expect(serialized).not.toContain("decisionmakerboughtin");
  expect(serialized).not.toContain("2026-08-01");
  // Association/id scaffolding and timestamps that aren't the note body.
  expect(serialized).not.toContain("note_to_contact");
  expect(serialized).not.toContain("note_to_deal");
  expect(serialized).not.toContain("2026-07-10T12:00:00Z");
});

test("strips owner identity when resolving a team's members -- a fixture with a real owner name/email never leaks into a chunk", async () => {
  const fetchImpl = fakeFetch((url) => {
    if (url.includes("/crm/v3/owners")) {
      return {
        body: {
          results: [
            {
              id: "owner-1",
              email: "sam.rep@acme-fake.test",
              firstName: "Sam",
              lastName: "Rep",
              teams: [{ id: "team-1", name: "Enterprise Sales", primary: true }],
            },
            { id: "owner-2", email: "other@acme-fake.test", firstName: "Other", lastName: "Rep", teams: [{ id: "team-9" }] },
          ],
        },
      };
    }
    if (url.includes("/notes/search")) {
      return { body: { results: [fixtureHydratedNote("777", "Renewal terms agreed verbally, sending contract Friday.")] } };
    }
    return { body: {} };
  });

  const chunks = await walkHubspotNotes({ token: "secret-token", pipelineIds: [], teamIds: ["team-1"], fetchImpl });

  const serialized = JSON.stringify(chunks);
  expect(serialized).not.toContain("sam.rep@acme-fake.test");
  expect(serialized).not.toContain("Sam");
  expect(serialized).not.toContain("Rep");
  expect(serialized).not.toContain("other@acme-fake.test");
  expect(chunks.map((c) => c.text).join("\n")).toContain("Renewal terms agreed verbally, sending contract Friday.");
});

test("scopes the owners search to only the resolved team's member ids", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl = fakeFetch((url) => {
    if (url.includes("/crm/v3/owners")) {
      return {
        body: {
          results: [
            { id: "owner-1", teams: [{ id: "team-1" }] },
            { id: "owner-2", teams: [{ id: "team-9" }] },
            { id: "owner-3", teams: [{ id: "team-1" }, { id: "team-9" }] },
          ],
        },
      };
    }
    return { body: { results: [] } };
  }, calls);

  await walkHubspotNotes({ token: "t", pipelineIds: [], teamIds: ["team-1"], fetchImpl });

  const searchCall = calls.find((c) => c.url.includes("/notes/search"));
  expect(searchCall).toBeDefined();
  const filters = asSearchBody(searchCall!.body).filterGroups[0].filters[0];
  expect(filters.propertyName).toBe("hubspot_owner_id");
  expect(new Set(filters.values)).toEqual(new Set(["owner-1", "owner-3"]));
});

test("never requests a deal property when searching deals by pipeline -- only ids come back", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl = fakeFetch((url) => {
    if (url.includes("/deals/search")) return { body: { results: [{ id: "5551", properties: { dealname: "Should never be read" } }] } };
    if (url.includes("/associations/notes")) return { body: { results: [] } };
    return { body: {} };
  }, calls);

  await walkHubspotNotes({ token: "t", pipelineIds: ["pipeline-1"], teamIds: [], fetchImpl });

  const dealSearchCall = calls.find((c) => c.url.includes("/deals/search"));
  expect(dealSearchCall).toBeDefined();
  expect(asSearchBody(dealSearchCall!.body).properties).toEqual([]);
  const filters = asSearchBody(dealSearchCall!.body).filterGroups[0].filters[0];
  expect(filters).toEqual({ propertyName: "pipeline", operator: "EQ", value: "pipeline-1" });
});

test("sends the token in the Authorization header, never in the URL or body", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl = fakeFetch((url) => {
    if (url.includes("/deals/search")) return { body: { results: [] } };
    return { body: {} };
  }, calls);

  await walkHubspotNotes({ token: "secret-test-token", pipelineIds: ["pipeline-1"], teamIds: [], fetchImpl });

  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.url).not.toContain("secret-test-token");
    expect(JSON.stringify(call.body ?? {})).not.toContain("secret-test-token");
    expect(call.headers.Authorization).toBe("Bearer secret-test-token");
  }
});

test("the exhaustive endpoint list never references a contact or company endpoint", () => {
  for (const endpoint of HUBSPOT_ENDPOINTS) {
    expect(endpoint.path.toLowerCase()).not.toMatch(/\/contacts|\/companies/);
    expect(endpoint.description.toLowerCase()).not.toMatch(/contact record|company record/);
  }
  expect(HUBSPOT_ENDPOINTS.map((e) => e.path)).toEqual([
    "GET /crm/v3/owners",
    "POST /crm/v3/objects/deals/search",
    "GET /crm/v4/objects/deals/{dealId}/associations/notes",
    "POST /crm/v3/objects/notes/batch/read",
    "POST /crm/v3/objects/notes/search",
  ]);
});

test("returns [] and never calls fetch when both pipelineIds and teamIds are empty, even with no token available", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const chunks = await walkHubspotNotes({ pipelineIds: [], teamIds: [], fetchImpl });

  expect(chunks).toEqual([]);
  expect(called).toBe(false);
});

test("throws MissingHubspotTokenError with no token from any source, and never attempts to fetch", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  await expect(walkHubspotNotes({ pipelineIds: ["pipeline-1"], teamIds: [], fetchImpl })).rejects.toThrow(
    MissingHubspotTokenError,
  );
  expect(called).toBe(false);
});

test("resolveHubspotToken: explicit token wins over GNT_HUBSPOT_TOKEN, which wins over a stored token", () => {
  process.env.GNT_HUBSPOT_TOKEN = "env-token";
  expect(resolveHubspotToken("explicit-token", "stored-token")).toBe("explicit-token");
  expect(resolveHubspotToken(undefined, "stored-token")).toBe("env-token");
  delete process.env.GNT_HUBSPOT_TOKEN;
  expect(resolveHubspotToken(undefined, "stored-token")).toBe("stored-token");
  expect(() => resolveHubspotToken(undefined, undefined)).toThrow(MissingHubspotTokenError);
});

test("a malformed response degrades gracefully -- no results array, or an entry missing hs_note_body, yields no chunks and never throws", async () => {
  const fetchImplNoResults = fakeFetch((url) => {
    if (url.includes("/deals/search")) return { body: { results: [{ id: "5551" }] } };
    if (url.includes("/associations/notes")) return { body: { results: [{ toObjectId: "301" }] } };
    if (url.includes("/notes/batch/read")) return { body: { unexpected: "shape" } };
    return { body: {} };
  });
  const chunksNoResults = await walkHubspotNotes({
    token: "t",
    pipelineIds: ["pipeline-1"],
    teamIds: [],
    fetchImpl: fetchImplNoResults,
  });
  expect(chunksNoResults).toEqual([]);

  const fetchImplBlankBody = fakeFetch((url) => {
    if (url.includes("/deals/search")) return { body: { results: [{ id: "5551" }] } };
    if (url.includes("/associations/notes")) return { body: { results: [{ toObjectId: "301" }] } };
    if (url.includes("/notes/batch/read")) {
      return { body: { results: [{ id: "301", properties: {} }, "not-an-object", null] } };
    }
    return { body: {} };
  });
  const chunksBlankBody = await walkHubspotNotes({
    token: "t",
    pipelineIds: ["pipeline-1"],
    teamIds: [],
    fetchImpl: fetchImplBlankBody,
  });
  expect(chunksBlankBody).toEqual([]);
});

test("a deal with no associated notes and a pipeline with no matching deals both degrade to no chunks, never an error", async () => {
  const fetchImpl = fakeFetch((url) => {
    if (url.includes("/deals/search")) return { body: { results: [{ id: "5551" }] } };
    if (url.includes("/associations/notes")) return { body: { results: [] } };
    return { body: {} };
  });

  const chunks = await walkHubspotNotes({ token: "t", pipelineIds: ["pipeline-1"], teamIds: [], fetchImpl });
  expect(chunks).toEqual([]);
});

test("a team with no matching owners never calls the notes search endpoint", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl = fakeFetch((url) => {
    if (url.includes("/crm/v3/owners")) return { body: { results: [{ id: "owner-1", teams: [{ id: "team-9" }] }] } };
    return { body: { results: [] } };
  }, calls);

  const chunks = await walkHubspotNotes({ token: "t", pipelineIds: [], teamIds: ["team-1"], fetchImpl });

  expect(chunks).toEqual([]);
  expect(calls.some((c) => c.url.includes("/notes/search"))).toBe(false);
});

test("reads across both pipeline and team scope in one run when both are given", async () => {
  const fetchImpl = fakeFetch((url) => {
    if (url.includes("/deals/search")) return { body: { results: [{ id: "5551" }] } };
    if (url.includes("/associations/notes")) return { body: { results: [{ toObjectId: "301" }] } };
    if (url.includes("/notes/batch/read")) return { body: { results: [{ id: "301", properties: { hs_note_body: "Deal note text." } }] } };
    if (url.includes("/crm/v3/owners")) return { body: { results: [{ id: "owner-1", teams: [{ id: "team-1" }] }] } };
    if (url.includes("/notes/search")) return { body: { results: [{ id: "777", properties: { hs_note_body: "Engagement note text." } }] } };
    return { body: {} };
  });

  const chunks = await walkHubspotNotes({ token: "t", pipelineIds: ["pipeline-1"], teamIds: ["team-1"], fetchImpl });

  const combined = chunks.map((c) => c.text).join("\n");
  expect(combined).toContain("Deal note text.");
  expect(combined).toContain("Engagement note text.");
  const sourcePaths = new Set(chunks.map((c) => c.sourcePath));
  expect(sourcePaths.has("hubspot/deals/5551/notes/301")).toBe(true);
  expect(sourcePaths.has("hubspot/notes/777")).toBe(true);
});

test("an HTTP error response throws HubspotApiError naming the endpoint and status, and never leaks the token into the message", async () => {
  const fetchImpl = fakeFetch(() => ({ body: { status: "error", message: "Forbidden" }, status: 403 }));

  try {
    await walkHubspotNotes({ token: "secret-token-value", pipelineIds: ["pipeline-1"], teamIds: [], fetchImpl });
    throw new Error("expected walkHubspotNotes to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(HubspotApiError);
    const message = err instanceof Error ? err.message : String(err);
    expect(message).toContain("403");
    expect(message).toContain("Forbidden");
    expect(message).not.toContain("secret-token-value");
  }
});

test("a network-level failure surfaces as HubspotApiError, not a raw rejection", async () => {
  const fetchImpl = (async () => {
    throw new Error("ECONNRESET");
  }) as unknown as typeof fetch;

  await expect(
    walkHubspotNotes({ token: "t", pipelineIds: ["pipeline-1"], teamIds: [], fetchImpl }),
  ).rejects.toThrow(HubspotApiError);
});

test("validateHubspotToken calls the owners endpoint with limit=1 and resolves on success", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl = fakeFetch(() => ({ body: { results: [] } }), calls);

  await validateHubspotToken("secret-token-value", fetchImpl);

  expect(calls.length).toBe(1);
  expect(calls[0].url).toBe("https://api.hubapi.com/crm/v3/owners?limit=1");
  expect(calls[0].headers.Authorization).toBe("Bearer secret-token-value");
});

test("validateHubspotToken throws HubspotApiError on a non-200 response, without leaking the token", async () => {
  const fetchImpl = fakeFetch(() => ({ body: { status: "error", message: "Invalid token" }, status: 401 }));

  try {
    await validateHubspotToken("secret-token-value", fetchImpl);
    throw new Error("expected validateHubspotToken to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(HubspotApiError);
    const message = err instanceof Error ? err.message : String(err);
    expect(message).not.toContain("secret-token-value");
  }
});
