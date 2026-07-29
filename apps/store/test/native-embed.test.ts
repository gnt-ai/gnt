import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EMBEDDING_DIMENSIONS, EmbedError, zeroEntropyEmbed } from "../src/native/embed.ts";

/** Deterministic, no-network coverage of the ZeroEntropy embed transport —
 * mocks globalThis.fetch so this never makes a real paid call, while
 * still proving the transport speaks ZE's actual wire shape
 * (`{results: [{embedding}]}`, not the AI-SDK-normalized `{data: [...]}`
 * shape the vendored engine's gateway rewrites it to) and enforces the
 * 1280-dim contract content_chunks.embedding is fixed to. */
describe("zeroEntropyEmbed", () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.ZEROENTROPY_API_KEY;

  beforeEach(() => {
    process.env.ZEROENTROPY_API_KEY = "test-key";
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.ZEROENTROPY_API_KEY;
    else process.env.ZEROENTROPY_API_KEY = realKey;
  });

  test("parses ZE's raw {results: [{embedding}]} response into a Float32Array", async () => {
    const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => i / EMBEDDING_DIMENSIONS);
    let capturedBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(url).toBe("https://api.zeroentropy.dev/v1/models/embed");
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ results: [{ embedding: vector }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const out = await zeroEntropyEmbed("refund window is 30 days");

    expect(out).toBeInstanceOf(Float32Array);
    expect(out.length).toBe(EMBEDDING_DIMENSIONS);
    // Float32Array narrows precision on assignment — compare against the
    // same narrowing, not the source doubles.
    expect(Array.from(out)).toEqual(Array.from(Float32Array.from(vector)));
    expect(capturedBody).toEqual({
      model: "zembed-1",
      input: ["refund window is 30 days"],
      dimensions: EMBEDDING_DIMENSIONS,
      input_type: "document",
      encoding_format: "float",
    });
  });

  test("rejects a wrong-width vector instead of silently writing it", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ results: [{ embedding: [0.1, 0.2, 0.3] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    await expect(zeroEntropyEmbed("short")).rejects.toThrow(EmbedError);
    try {
      await zeroEntropyEmbed("short");
      throw new Error("expected zeroEntropyEmbed to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EmbedError);
      expect((err as EmbedError).reason).toBe("dim_mismatch");
    }
  });

  test("fails loud on a malformed response with no results array", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ oops: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    await expect(zeroEntropyEmbed("text")).rejects.toThrow(EmbedError);
  });

  test("maps HTTP error statuses to typed failure reasons", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    try {
      await zeroEntropyEmbed("text");
      throw new Error("expected zeroEntropyEmbed to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EmbedError);
      expect((err as EmbedError).reason).toBe("auth");
      expect((err as EmbedError).status).toBe(401);
    }
  });

  test("throws without ever calling fetch when ZEROENTROPY_API_KEY is unset", async () => {
    delete process.env.ZEROENTROPY_API_KEY;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      throw new Error("should not be called");
    }) as unknown as typeof fetch;

    await expect(zeroEntropyEmbed("text")).rejects.toThrow(EmbedError);
    expect(called).toBe(false);
  });
});
