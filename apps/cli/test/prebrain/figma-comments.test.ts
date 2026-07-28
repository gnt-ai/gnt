// Tests the direct-REST Figma comments client against a fake fetch -- no
// real network call, no MCP client, no child process, ever runs in this
// file. Fixtures are shaped like Figma's real GET
// /v1/files/:file_key/comments response (github.com/figma/rest-api-spec's
// own Comment schema), including a full commenter user object and canvas
// position data, so the field-discipline tests below have something real
// to prove is stripped.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  FigmaApiError,
  MissingFigmaTokenError,
  resolveFigmaToken,
  validateFigmaToken,
  walkFigmaComments,
} from "../../src/prebrain/figma-comments.js";

let originalEnv: string | undefined;

beforeEach(() => {
  originalEnv = process.env.GNT_FIGMA_TOKEN;
  delete process.env.GNT_FIGMA_TOKEN;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.GNT_FIGMA_TOKEN;
  else process.env.GNT_FIGMA_TOKEN = originalEnv;
});

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
}

function fixtureComments() {
  return {
    comments: [
      {
        id: "1234",
        message: "Should this button say Submit or Save changes?",
        file_key: "abc123",
        parent_id: null,
        client_meta: { x: 104, y: 220 },
        created_at: "2026-07-01T12:00:00Z",
        resolved_at: null,
        order_id: "1",
        user: { id: "u-jordan", handle: "jordan.pm", img_url: "https://figma-alpha-api.s3/avatar-jordan.png" },
        reactions: [
          {
            user: { id: "u-sam", handle: "sam.design", img_url: "https://figma-alpha-api.s3/avatar-sam.png" },
            emoji: ":+1:",
            created_at: "2026-07-01T12:05:00Z",
          },
        ],
      },
      {
        id: "5678",
        message: "Save changes reads clearer once there's a second destructive action nearby.",
        file_key: "abc123",
        parent_id: "1234",
        client_meta: { x: 104, y: 220 },
        created_at: "2026-07-01T12:10:00Z",
        resolved_at: null,
        order_id: null,
        user: { id: "u-sam", handle: "sam.design", img_url: "https://figma-alpha-api.s3/avatar-sam.png" },
        reactions: [],
      },
    ],
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

test("reads a comment thread's message and reply into a chunk tagged figma-comments, with a stable id sourcePath", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl = fakeFetch(() => ({ body: fixtureComments() }), calls);

  const chunks = await walkFigmaComments({ token: "secret_test_token", fileKeys: ["abc123"], fetchImpl });

  expect(chunks.length).toBeGreaterThan(0);
  for (const chunk of chunks) {
    expect(chunk.walker).toBe("figma-comments");
    expect(chunk.sourcePath).toBe("figma/files/abc123/comments/1234");
  }
  const combined = chunks.map((c) => c.text).join("\n");
  expect(combined).toContain("Should this button say Submit or Save changes?");
  expect(combined).toContain("Save changes reads clearer once there's a second destructive action nearby.");
});

test("calls only the documented comments endpoint with the token in the X-Figma-Token header, never in the URL", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl = fakeFetch(() => ({ body: fixtureComments() }), calls);

  await walkFigmaComments({ token: "secret_test_token", fileKeys: ["abc123"], fetchImpl });

  expect(calls.length).toBe(1);
  expect(calls[0].url).toBe("https://api.figma.com/v1/files/abc123/comments");
  expect(calls[0].url).not.toContain("secret_test_token");
  expect(calls[0].headers["X-Figma-Token"]).toBe("secret_test_token");
});

test("strips commenter identity and canvas position -- a fixture with full user objects produces chunks that never mention them", async () => {
  const fetchImpl = fakeFetch(() => ({ body: fixtureComments() }));

  const chunks = await walkFigmaComments({ token: "secret_test_token", fileKeys: ["abc123"], fetchImpl });

  const serialized = JSON.stringify(chunks);
  expect(serialized).not.toContain("jordan.pm");
  expect(serialized).not.toContain("sam.design");
  expect(serialized).not.toContain("u-jordan");
  expect(serialized).not.toContain("u-sam");
  expect(serialized).not.toContain("avatar-jordan");
  expect(serialized).not.toContain("avatar-sam");
  expect(serialized).not.toContain("client_meta");
  expect(serialized).not.toContain("2026-07-01T12:00:00Z");
});

test("reads comments across multiple file keys, one request per file", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl = fakeFetch((url) => {
    if (url.includes("/files/file-a/")) {
      return { body: { comments: [{ id: "1", message: "File A: ship the red variant.", parent_id: null }] } };
    }
    return { body: { comments: [{ id: "2", message: "File B: keep the blue variant for now.", parent_id: null }] } };
  }, calls);

  const chunks = await walkFigmaComments({ token: "t", fileKeys: ["file-a", "file-b"], fetchImpl });

  expect(calls.length).toBe(2);
  const sourcePaths = new Set(chunks.map((c) => c.sourcePath));
  expect(sourcePaths.has("figma/files/file-a/comments/1")).toBe(true);
  expect(sourcePaths.has("figma/files/file-b/comments/2")).toBe(true);
});

test("returns [] and never calls fetch when fileKeys is empty, even with no token available", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const chunks = await walkFigmaComments({ fileKeys: [], fetchImpl });

  expect(chunks).toEqual([]);
  expect(called).toBe(false);
});

test("throws MissingFigmaTokenError with no token from any source, and never attempts to fetch", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  await expect(walkFigmaComments({ fileKeys: ["abc123"], fetchImpl })).rejects.toThrow(MissingFigmaTokenError);
  expect(called).toBe(false);
});

test("resolveFigmaToken: explicit token wins over GNT_FIGMA_TOKEN, which wins over a stored token", () => {
  process.env.GNT_FIGMA_TOKEN = "env-token";
  expect(resolveFigmaToken("explicit-token", "stored-token")).toBe("explicit-token");
  expect(resolveFigmaToken(undefined, "stored-token")).toBe("env-token");
  delete process.env.GNT_FIGMA_TOKEN;
  expect(resolveFigmaToken(undefined, "stored-token")).toBe("stored-token");
  expect(() => resolveFigmaToken(undefined, undefined)).toThrow(MissingFigmaTokenError);
});

test("a malformed comments payload degrades gracefully -- no comments array, or entries missing a message, yield no chunks and never throw", async () => {
  const fetchImpl = fakeFetch(() => ({
    body: { comments: [{ id: "no-message", parent_id: null }, { message: "no id here", parent_id: null }, "not-an-object", null] },
  }));

  const chunks = await walkFigmaComments({ token: "t", fileKeys: ["abc123"], fetchImpl });
  expect(chunks).toEqual([]);

  const fetchImplNoCommentsKey = fakeFetch(() => ({ body: { unexpected: "shape" } }));
  const chunks2 = await walkFigmaComments({ token: "t", fileKeys: ["abc123"], fetchImpl: fetchImplNoCommentsKey });
  expect(chunks2).toEqual([]);
});

test("a reply whose parent isn't a root comment in the same response is dropped rather than guessed at", async () => {
  const fetchImpl = fakeFetch(() => ({
    body: { comments: [{ id: "orphan-reply", message: "reply to nothing we have", parent_id: "missing-root" }] },
  }));

  const chunks = await walkFigmaComments({ token: "t", fileKeys: ["abc123"], fetchImpl });
  expect(chunks).toEqual([]);
});

test("an HTTP error response throws FigmaApiError naming the file key and status, and never leaks the token into the message", async () => {
  const fetchImpl = fakeFetch(() => ({ body: { status: 403, err: "Invalid token" }, status: 403 }));

  await expect(walkFigmaComments({ token: "secret_test_token", fileKeys: ["abc123"], fetchImpl })).rejects.toThrow(
    FigmaApiError,
  );

  try {
    await walkFigmaComments({ token: "secret_test_token", fileKeys: ["abc123"], fetchImpl });
    throw new Error("expected walkFigmaComments to throw");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    expect(message).toContain("abc123");
    expect(message).toContain("403");
    expect(message).not.toContain("secret_test_token");
  }
});

test("a network-level failure (DNS, timeout, connection reset) surfaces as FigmaApiError, not a raw rejection", async () => {
  // A real fetch-level failure (DNS, timeout, ECONNRESET) never carries
  // this walker's own request headers in its message -- the token only
  // ever leaves this process inside the X-Figma-Token header itself (see
  // the "never in the URL" test above), so there's nothing for a
  // transport error to leak. This test only proves the thrown shape:
  // FigmaApiError, not an unhandled raw rejection.
  const fetchImpl = (async () => {
    throw new Error("ECONNRESET");
  }) as unknown as typeof fetch;

  await expect(walkFigmaComments({ token: "secret_test_token", fileKeys: ["abc123"], fetchImpl })).rejects.toThrow(
    FigmaApiError,
  );
});

test("caps threads read per file at a documented limit rather than reading an unbounded history", async () => {
  const comments = Array.from({ length: 150 }, (_, i) => ({
    id: `root-${i}`,
    message: `Decision ${i}: use the new copy.`,
    parent_id: null,
  }));
  const fetchImpl = fakeFetch(() => ({ body: { comments } }));

  const chunks = await walkFigmaComments({ token: "t", fileKeys: ["abc123"], fetchImpl });
  const threadCount = new Set(chunks.map((c) => c.sourcePath)).size;
  expect(threadCount).toBeLessThanOrEqual(100);
});

test("validateFigmaToken calls GET /v1/me and resolves on success", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl = fakeFetch(() => ({ body: { id: "u1", handle: "jordan.pm", img_url: "https://x", email: "jordan@acme.com" } }), calls);

  await validateFigmaToken("secret_test_token", fetchImpl);

  expect(calls.length).toBe(1);
  expect(calls[0].url).toBe("https://api.figma.com/v1/me");
  expect(calls[0].headers["X-Figma-Token"]).toBe("secret_test_token");
});

test("validateFigmaToken throws FigmaApiError on a non-200 response, without leaking the token", async () => {
  const fetchImpl = fakeFetch(() => ({ body: { status: 403, err: "Invalid token" }, status: 403 }));

  try {
    await validateFigmaToken("secret_test_token", fetchImpl);
    throw new Error("expected validateFigmaToken to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(FigmaApiError);
    const message = err instanceof Error ? err.message : String(err);
    expect(message).not.toContain("secret_test_token");
  }
});
