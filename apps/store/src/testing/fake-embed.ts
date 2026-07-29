/**
 * Deterministic, non-semantic fake embedding — tests must never make a
 * real paid embedding API call. Lives in src/, not test/,
 * so the HTTP server's test-mode switch (GNT_STORE_TEST_FAKE_EMBED) can
 * import it too, for cross-process test fixtures (e.g. the Python
 * backend's pytest suite spawning a real server) — never for production
 * use, see server.ts's loud stderr warning when that env var is set.
 */
const DIM = 1280; // matches production's embedding width (ZeroEntropy zembed-1, see native/embed.ts)

export async function fakeEmbed(text: string): Promise<Float32Array> {
  const out = new Float32Array(DIM);
  let seed = 0;
  for (let i = 0; i < text.length; i++) {
    seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
  }
  for (let i = 0; i < DIM; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    out[i] = (seed / 0xffffffff) * 2 - 1;
  }
  return out;
}
