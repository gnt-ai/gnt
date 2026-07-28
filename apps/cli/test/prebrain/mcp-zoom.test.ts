// Tests the live-Zoom walker against the shared harness plus a fake
// McpToolClient. No real network call, no real mcp-remote process, ever
// runs in this file -- see mcp-linear.test.ts's own header for why. The
// transcript-timeline-to-turn conversion (this connector's own "light
// adaptation" of Zoom's caption-shaped transcript into transcript-chunk.ts's
// input shape) gets its own tests below, separate from the shared chunker's
// own coverage in transcript-chunk.test.ts.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { MissingZoomMcpTokenError, walkMcpZoom, zoomAdapter } from "../../src/prebrain/mcp-zoom.js";
import type { McpToolClient } from "../../src/prebrain/mcp-connector.js";
import {
  assertChunksWellFormed,
  assertCredentialsNeverLogged,
  assertDeclaredFieldsStripUndeclared,
  assertReadOnlyAllowlistEnforced,
  walkAdapterWithFake,
} from "./mcp-framework/harness.js";

let originalEnv: string | undefined;

beforeEach(() => {
  originalEnv = process.env.GNT_ZOOM_MCP_TOKEN;
  delete process.env.GNT_ZOOM_MCP_TOKEN;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.GNT_ZOOM_MCP_TOKEN;
  else process.env.GNT_ZOOM_MCP_TOKEN = originalEnv;
});

interface RecordedCall {
  name: string;
  args?: Record<string, unknown>;
}

interface FakeZoomFixture {
  recordingsByHost?: Record<string, unknown[]>;
  recordingResources?: Record<string, unknown | { isError: true }>;
}

function fakeZoomClient(fixture: FakeZoomFixture, calls: RecordedCall[]): McpToolClient {
  return {
    async callTool(params) {
      calls.push({ name: params.name, args: params.arguments });
      const args = params.arguments ?? {};

      if (params.name === "recordings_list") {
        const userId = args.userId as string | undefined;
        const meetings = (userId && fixture.recordingsByHost?.[userId]) || [];
        return { content: [{ type: "text", text: JSON.stringify({ meetings }) }] };
      }
      if (params.name === "get_recording_resource") {
        const meetingId = args.meetingId as string;
        const entry = fixture.recordingResources?.[meetingId];
        if (entry && typeof entry === "object" && "isError" in entry) {
          return { isError: true, content: [{ type: "text", text: "recording still processing" }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(entry ?? {}) }] };
      }
      throw new Error(`unexpected tool call in test fake: ${params.name}`);
    },
    async close() {},
  };
}

test("walks a host's recordings into PrebrainChunks tagged mcp-zoom, with the share_url as sourcePath", async () => {
  const calls: RecordedCall[] = [];
  const client = fakeZoomClient(
    {
      recordingsByHost: {
        "host@acme.com": [{ uuid: "abc123", topic: "Roadmap sync", host_email: "host@acme.com", share_url: "https://zoom.us/rec/share/abc123" }],
      },
      recordingResources: {
        abc123: {
          transcripts: [
            {
              timeline: [
                { text: "We're going with option B for the launch.", display_name: "Jane Doe" },
                { text: "Sounds good, I'll update the roadmap doc.", display_name: "John Smith" },
              ],
            },
          ],
        },
      },
    },
    calls,
  );

  const chunks = await walkMcpZoom({ token: "t", hosts: ["host@acme.com"], connect: async () => client });

  expect(chunks.length).toBeGreaterThan(0);
  for (const chunk of chunks) {
    expect(chunk.walker).toBe("mcp-zoom");
    expect(chunk.sourcePath).toBe("https://zoom.us/rec/share/abc123");
  }
  const combined = chunks.map((c) => c.text).join("\n");
  expect(combined).toContain("Jane Doe: We're going with option B for the launch.");
  expect(combined).toContain("John Smith: Sounds good, I'll update the roadmap doc.");
});

test("a recording missing share_url and play_url falls back to recordings/<uuid> as sourcePath", async () => {
  const calls: RecordedCall[] = [];
  const client = fakeZoomClient(
    {
      recordingsByHost: { "host@acme.com": [{ uuid: "no-link-1", topic: "No link" }] },
      recordingResources: {
        "no-link-1": { transcripts: [{ timeline: [{ text: "Some decision text worth chunking here.", display_name: "Jane Doe" }] }] },
      },
    },
    calls,
  );

  const chunks = await walkMcpZoom({ token: "t", hosts: ["host@acme.com"], connect: async () => client });
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks.every((c) => c.sourcePath === "recordings/no-link-1")).toBe(true);
});

test("falls back to the first recording file's play_url when share_url is absent", async () => {
  const client = fakeZoomClient(
    {
      recordingsByHost: {
        "host@acme.com": [
          {
            uuid: "play-only",
            topic: "Play url only",
            recording_files: [{ file_type: "MP4", play_url: "https://zoom.us/rec/play/xyz" }],
          },
        ],
      },
      recordingResources: {
        "play-only": { transcripts: [{ timeline: [{ text: "Decision text here.", display_name: "Jane Doe" }] }] },
      },
    },
    [],
  );

  const chunks = await walkMcpZoom({ token: "t", hosts: ["host@acme.com"], connect: async () => client });
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks.every((c) => c.sourcePath === "https://zoom.us/rec/play/xyz")).toBe(true);
});

test("a recording whose host doesn't match the allowlisted host is dropped (defense in depth)", async () => {
  const client = fakeZoomClient(
    {
      recordingsByHost: {
        "host@acme.com": [
          { uuid: "mine", topic: "Mine", host_email: "host@acme.com" },
          { uuid: "not-mine", topic: "Someone else's", host_email: "other@acme.com" },
        ],
      },
      recordingResources: {
        mine: { transcripts: [{ timeline: [{ text: "My own decision text.", display_name: "Jane Doe" }] }] },
        "not-mine": { transcripts: [{ timeline: [{ text: "Someone else's decision text.", display_name: "Jane Doe" }] }] },
      },
    },
    [],
  );

  const chunks = await walkMcpZoom({ token: "t", hosts: ["host@acme.com"], connect: async () => client });
  const sourcePaths = chunks.map((c) => c.sourcePath);
  expect(sourcePaths).toContain("recordings/mine");
  expect(sourcePaths).not.toContain("recordings/not-mine");
});

test("merges consecutive same-speaker caption segments into one turn before chunking", async () => {
  const client = fakeZoomClient(
    {
      recordingsByHost: { "host@acme.com": [{ uuid: "merge-1", topic: "Merge test" }] },
      recordingResources: {
        "merge-1": {
          transcripts: [
            {
              timeline: [
                { text: "We're going", display_name: "Jane Doe" },
                { text: "with option B", display_name: "Jane Doe" },
                { text: "for the launch.", display_name: "Jane Doe" },
                { text: "Sounds good.", display_name: "John Smith" },
              ],
            },
          ],
        },
      },
    },
    [],
  );

  const chunks = await walkMcpZoom({ token: "t", hosts: ["host@acme.com"], connect: async () => client });
  const combined = chunks.map((c) => c.text).join("\n");
  // Merged into one turn -- no mid-turn split between Jane's own three
  // caption segments.
  expect(combined).toContain("Jane Doe: We're going with option B for the launch.");
  expect(combined).toContain("John Smith: Sounds good.");
});

test("a caption segment with no display_name becomes an unattributed turn", async () => {
  const client = fakeZoomClient(
    {
      recordingsByHost: { "host@acme.com": [{ uuid: "no-speaker", topic: "No speaker" }] },
      recordingResources: {
        "no-speaker": { transcripts: [{ timeline: [{ text: "Unattributed caption text." }] }] },
      },
    },
    [],
  );

  const chunks = await walkMcpZoom({ token: "t", hosts: ["host@acme.com"], connect: async () => client });
  const combined = chunks.map((c) => c.text).join("\n");
  expect(combined).toContain("Unattributed caption text.");
  expect(combined).not.toContain(": Unattributed caption text.");
});

test("a recording whose get_recording_resource read fails contributes no chunk, other recordings still walk", async () => {
  const client = fakeZoomClient(
    {
      recordingsByHost: {
        "host@acme.com": [
          { uuid: "still-processing", topic: "Still processing" },
          { uuid: "ready", topic: "Ready" },
        ],
      },
      recordingResources: {
        "still-processing": { isError: true },
        ready: { transcripts: [{ timeline: [{ text: "This one is ready.", display_name: "Jane Doe" }] }] },
      },
    },
    [],
  );

  const chunks = await walkMcpZoom({ token: "t", hosts: ["host@acme.com"], connect: async () => client });
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks.every((c) => c.sourcePath !== "recordings/still-processing")).toBe(true);
  expect(chunks.map((c) => c.text).join("\n")).toContain("This one is ready.");
});

test("a host recordings_list failure propagates as a clear error rather than being silently swallowed", async () => {
  // recordings_list is the primary discovery call, deliberately not caught
  // per host (see mcp-zoom.ts's own walkHost doc comment) -- a stale OAuth
  // token fails this identically for every host, so this must surface as a
  // real error the customer sees ("Zoom MCP walker skipped: ...") rather
  // than the whole run quietly returning zero chunks with no explanation.
  const client: McpToolClient = {
    async callTool(params) {
      if (params.name === "recordings_list") throw new Error("401 Unauthorized: access token expired");
      throw new Error(`unexpected: ${params.name}`);
    },
    async close() {},
  };

  await expect(
    walkMcpZoom({ token: "t", hosts: ["host@acme.com"], connect: async () => client }),
  ).rejects.toThrow(/access token expired/);
});

test("reads every host given, not just the first", async () => {
  const client = fakeZoomClient(
    {
      recordingsByHost: {
        "host-a@acme.com": [{ uuid: "a-1", topic: "A" }],
        "host-b@acme.com": [{ uuid: "b-1", topic: "B" }],
      },
      recordingResources: {
        "a-1": { transcripts: [{ timeline: [{ text: "Host A content.", display_name: "Jane Doe" }] }] },
        "b-1": { transcripts: [{ timeline: [{ text: "Host B content.", display_name: "Jane Doe" }] }] },
      },
    },
    [],
  );

  const chunks = await walkMcpZoom({ token: "t", hosts: ["host-a@acme.com", "host-b@acme.com"], connect: async () => client });
  const sourcePaths = chunks.map((c) => c.sourcePath);
  expect(sourcePaths).toContain("recordings/a-1");
  expect(sourcePaths).toContain("recordings/b-1");
});

test("passes userId/from/to through to recordings_list", async () => {
  const calls: RecordedCall[] = [];
  const client = fakeZoomClient({ recordingsByHost: {} }, calls);

  await walkMcpZoom({ token: "t", hosts: ["host@acme.com"], from: "2026-07-01", to: "2026-07-15", connect: async () => client });

  const listCall = calls.find((c) => c.name === "recordings_list");
  expect(listCall?.args).toMatchObject({ userId: "host@acme.com", from: "2026-07-01", to: "2026-07-15" });
});

test("returns no chunks and never connects when hosts is empty", async () => {
  let connectCalled = false;
  const connect = async () => {
    connectCalled = true;
    return fakeZoomClient({}, []);
  };

  const chunks = await walkMcpZoom({ token: "t", hosts: [], connect });
  expect(chunks).toEqual([]);
  expect(connectCalled).toBe(false);
});

test("throws MissingZoomMcpTokenError with no token from any source, and never attempts to connect", async () => {
  let connectCalled = false;
  const connect = async () => {
    connectCalled = true;
    return fakeZoomClient({}, []);
  };

  await expect(walkMcpZoom({ hosts: ["host@acme.com"], connect })).rejects.toThrow(MissingZoomMcpTokenError);
  expect(connectCalled).toBe(false);
});

test("falls back to GNT_ZOOM_MCP_TOKEN, then to a stored token, in that precedence order", async () => {
  process.env.GNT_ZOOM_MCP_TOKEN = "env-token";
  const client = fakeZoomClient({ recordingsByHost: {} }, []);

  await walkMcpZoom({ storedToken: "stored-token", hosts: ["host@acme.com"], connect: async () => client });

  delete process.env.GNT_ZOOM_MCP_TOKEN;
  await expect(
    walkMcpZoom({ storedToken: "stored-token", hosts: ["host@acme.com"], connect: async () => client }),
  ).resolves.toBeDefined();
});

test("always closes the client, even when a mid-walk tool call throws", async () => {
  let closed = false;
  const client: McpToolClient = {
    async callTool(params) {
      if (params.name === "recordings_list") throw new Error("boom");
      throw new Error("unexpected");
    },
    async close() {
      closed = true;
    },
  };

  await expect(walkMcpZoom({ token: "t", hosts: ["host@acme.com"], connect: async () => client })).rejects.toThrow();
  expect(closed).toBe(true);
});

// ---- shared harness assertions (framework README checklist) ----

test("harness: the read-only allowlist is exactly the declared reads", () => {
  assertReadOnlyAllowlistEnforced(zoomAdapter);
});

test("harness: declares only recordings_list and get_recording_resource -- write and out-of-scope tools are unreachable", () => {
  const declaredTools = zoomAdapter.reads.map((r) => r.tool);
  expect(declaredTools.sort()).toEqual(["get_recording_resource", "recordings_list"]);
  for (const writeOrOutOfScope of [
    "search_meetings",
    "get_meeting_assets",
    "search_zoom",
    "create_new_file_with_markdown",
    "get_file_content",
    "hub_create_file_from_content",
    "hub_get_file_content",
  ]) {
    expect(declaredTools).not.toContain(writeOrOutOfScope);
  }
});

test("harness: recordings_list strips undeclared record fields (participant/account metadata)", () => {
  assertDeclaredFieldsStripUndeclared(
    zoomAdapter,
    "recordings_list",
    {
      meetings: [
        {
          uuid: "1",
          topic: "Keep",
          host_email: "host@acme.com",
          participants: [{ email: "leak@acme.com", name: "Leaky Participant" }],
          account_id: "acct-leak-12345",
        },
      ],
    },
    ["leak@acme.com", "Leaky Participant", "acct-leak-12345"],
  );
});

test("harness: get_recording_resource strips undeclared response sections (summaries, next steps, play urls)", () => {
  assertDeclaredFieldsStripUndeclared(
    zoomAdapter,
    "get_recording_resource",
    {
      transcripts: [{ timeline: [{ text: "Keep this line.", display_name: "Jane Doe" }] }],
      summaries: [{ overall_summary: "leak-summary-content" }],
      next_steps: [{ items: [{ text: "leak-next-step-content" }] }],
      play_urls: [{ urls: ["https://leak-play-url.example/should-not-survive"] }],
    },
    ["leak-summary-content", "leak-next-step-content", "leak-play-url.example"],
  );
});

test("harness: the token never appears in anything the walk logs", async () => {
  await assertCredentialsNeverLogged(zoomAdapter, {
    responses: {
      recordings_list: () => ({ meetings: [] }),
    },
    params: { hosts: ["host@acme.com"] },
    token: "super-secret-zoom-token",
  });
});

test("harness: walks fixtures into well-formed chunks", async () => {
  const { chunks } = await walkAdapterWithFake(zoomAdapter, {
    responses: {
      recordings_list: () => ({ meetings: [{ uuid: "1", topic: "Roadmap sync", share_url: "https://zoom.us/rec/share/1" }] }),
      get_recording_resource: () => ({
        transcripts: [{ timeline: [{ text: "We're shipping the vendor migration in Q3.", display_name: "Jane Doe" }] }],
      }),
    },
    params: { hosts: ["host@acme.com"] },
  });
  assertChunksWellFormed(zoomAdapter, chunks);
  expect(chunks.map((c) => c.text).join("\n")).toContain("vendor migration in Q3");
});
