import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import postgres from "postgres";
import { resolveNetworkExposure } from "../src/http/server.ts";

/** Same reachability probe native-store.test.ts uses — the two subprocess
 * tests below that expect the server to reach "listening" need a real
 * NativeStore boot, which needs a real Postgres (see that file's header
 * comment for why this suite skips cleanly in CI without one). */
const DATABASE_URL =
  process.env.STORE_NATIVE_TEST_DATABASE_URL ?? "postgres://localhost:5432/gnt_store_native_test";

async function isReachable(url: string): Promise<boolean> {
  const probe = postgres(url, { connect_timeout: 2, onnotice: () => {} });
  try {
    await probe`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end({ timeout: 1 });
  }
}

const reachable = await isReachable(DATABASE_URL);

/**
 * Network-exposure gate, take two. The original version of this check
 * keyed off bind address (loopback vs. not) and crash-looped production: Railway
 * containers must bind 0.0.0.0 to be reachable by anything, including
 * Railway's own private network, so "non-loopback bind" and "publicly
 * reachable" are different facts there — see apps/store/README.md's
 * "Production bind shape" section for the full story.
 *
 * The signal that actually matters on Railway is whether a public domain
 * or TCP proxy is attached (RAILWAY_PUBLIC_DOMAIN / RAILWAY_TCP_PROXY_DOMAIN)
 * — that's what puts a service on the public internet instead of just
 * Railway's private network. resolveNetworkExposure is the pure gate
 * main() calls before it ever touches the engine or Bun.serve;
 * unit-testing it directly (same style as approval-gate.test.ts) covers
 * the decision logic exhaustively. The subprocess suite below then proves
 * main() is actually wired to call it and refuses to start for real, not
 * just in theory — including a scenario that reproduces today's actual
 * production env shape (GNT_STORE_BIND=0.0.0.0, no public domain var set)
 * to prove this version would not have crash-looped the way the original
 * one did.
 */
describe("resolveNetworkExposure", () => {
  const secrets = {
    internalApiSecret: "internal-secret",
    approvalSigningSecret: "approval-secret",
  };

  test("no public ingress starts with no flag and no secrets required, regardless of bind", () => {
    for (const bind of ["127.0.0.1", "0.0.0.0", "10.0.0.5", "localhost"]) {
      const authMode = resolveNetworkExposure({
        bind,
        internalApiSecret: undefined,
        approvalSigningSecret: undefined,
        publicDomain: undefined,
        tcpProxyDomain: undefined,
        allowPublicDomain: undefined,
      });
      expect(authMode).toBe("no public ingress attached, no external auth needed");
    }
  });

  test("today's real production shape (0.0.0.0 bind, no Railway public-domain vars) starts clean", () => {
    // This is the exact env shape that crash-looped production under the
    // old bind-address check: GNT_STORE_BIND=0.0.0.0 (required for Railway's
    // private network to reach the service at all) with no
    // GNT_STORE_ALLOW_NON_LOOPBACK ever set, because that flag didn't exist
    // before this gate was rewritten to key off public ingress instead of
    // bind address. Railway's own store service has no public
    // domain or TCP proxy attached, so neither RAILWAY_PUBLIC_DOMAIN nor
    // RAILWAY_TCP_PROXY_DOMAIN is set either.
    const authMode = resolveNetworkExposure({
      bind: "0.0.0.0",
      internalApiSecret: undefined,
      approvalSigningSecret: undefined,
      publicDomain: undefined,
      tcpProxyDomain: undefined,
      allowPublicDomain: undefined,
    });
    expect(authMode).toBe("no public ingress attached, no external auth needed");
  });

  test("a public domain attached without the flag refuses to start", () => {
    expect(() =>
      resolveNetworkExposure({
        bind: "0.0.0.0",
        ...secrets,
        publicDomain: "example-store.up.railway.app",
        tcpProxyDomain: undefined,
        allowPublicDomain: undefined,
      }),
    ).toThrow(/GNT_STORE_ALLOW_PUBLIC_DOMAIN/);
  });

  test("a TCP proxy attached without the flag refuses to start", () => {
    expect(() =>
      resolveNetworkExposure({
        bind: "0.0.0.0",
        ...secrets,
        publicDomain: undefined,
        tcpProxyDomain: "example.proxy.rlwy.net",
        allowPublicDomain: undefined,
      }),
    ).toThrow(/GNT_STORE_ALLOW_PUBLIC_DOMAIN/);
  });

  test("a public domain attached with the flag but missing secrets refuses to start", () => {
    expect(() =>
      resolveNetworkExposure({
        bind: "0.0.0.0",
        internalApiSecret: undefined,
        approvalSigningSecret: undefined,
        publicDomain: "example-store.up.railway.app",
        tcpProxyDomain: undefined,
        allowPublicDomain: "1",
      }),
    ).toThrow(/GNT_STORE_INTERNAL_API_SECRET.*GNT_APPROVAL_SIGNING_SECRET/s);

    // Missing just one of the two is equally fatal.
    expect(() =>
      resolveNetworkExposure({
        bind: "0.0.0.0",
        internalApiSecret: "internal-secret",
        approvalSigningSecret: undefined,
        publicDomain: "example-store.up.railway.app",
        tcpProxyDomain: undefined,
        allowPublicDomain: "1",
      }),
    ).toThrow();
    expect(() =>
      resolveNetworkExposure({
        bind: "0.0.0.0",
        internalApiSecret: undefined,
        approvalSigningSecret: "approval-secret",
        publicDomain: "example-store.up.railway.app",
        tcpProxyDomain: undefined,
        allowPublicDomain: "1",
      }),
    ).toThrow();
  });

  test("a public domain attached with the flag AND both secrets starts successfully", () => {
    const authMode = resolveNetworkExposure({
      bind: "0.0.0.0",
      ...secrets,
      publicDomain: "example-store.up.railway.app",
      tcpProxyDomain: undefined,
      allowPublicDomain: "1",
    });
    expect(authMode).toBe("public ingress attached, secrets verified, explicit flag acknowledged");
  });

  test("a truthy-looking but wrong flag value still refuses to start", () => {
    expect(() =>
      resolveNetworkExposure({
        bind: "0.0.0.0",
        ...secrets,
        publicDomain: "example-store.up.railway.app",
        tcpProxyDomain: undefined,
        allowPublicDomain: "true",
      }),
    ).toThrow(/GNT_STORE_ALLOW_PUBLIC_DOMAIN/);
  });
});

/**
 * End-to-end proof that main() actually calls resolveNetworkExposure
 * before it ever binds a socket, matching how apps/api/tests/conftest.py
 * spawns this same "bun run src/http/server.ts" command in production
 * shape. Refusal cases exit before store.init() runs, so they resolve
 * near-instantly and need no database; only the success cases pay a real
 * NativeStore boot's cost, so only those two skip without a reachable
 * Postgres (see the `reachable` probe above).
 */
describe("apps/store server startup (subprocess)", () => {
  const storeDir = join(import.meta.dir, "..");

  /** Builds a clean child env: starts from this process's env, then
   * deletes (rather than stringifying "undefined" for) any override key
   * whose value is undefined. That matters because other test files in
   * this same bun:test run (e.g. http-server.test.ts's beforeAll) mutate
   * process.env.GNT_APPROVAL_SIGNING_SECRET directly — without explicit
   * deletion here, a "missing secret" scenario could silently pass
   * because a sibling test file already set it process-wide. Also strips
   * RAILWAY_PUBLIC_DOMAIN/RAILWAY_TCP_PROXY_DOMAIN unconditionally, since
   * these tests must control that signal explicitly rather than
   * inheriting whatever the host running the test suite happens to have. */
  function buildEnv(overrides: Record<string, string | undefined>): Record<string, string> {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    delete env.RAILWAY_PUBLIC_DOMAIN;
    delete env.RAILWAY_TCP_PROXY_DOMAIN;
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    return env;
  }

  async function runServer(env: Record<string, string | undefined>): Promise<{ exitCode: number; output: string }> {
    const proc = Bun.spawn(["bun", "run", "src/http/server.ts"], {
      cwd: storeDir,
      env: buildEnv(env),
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const output = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    return { exitCode, output };
  }

  test.skipIf(!reachable)("today's real production shape (0.0.0.0 bind, no public-domain vars) starts fine", async () => {
    const proc = Bun.spawn(["bun", "run", "src/http/server.ts"], {
      cwd: storeDir,
      env: buildEnv({
        GNT_STORE_PORT: "0",
        GNT_STORE_BIND: "0.0.0.0",
        DATABASE_URL,
        GNT_STORE_TEST_FAKE_EMBED: "1",
        GNT_STORE_INTERNAL_API_SECRET: "production-shape-subprocess-secret",
        GNT_STORE_ALLOW_PUBLIC_DOMAIN: undefined,
        GNT_APPROVAL_SIGNING_SECRET: undefined,
        RAILWAY_PUBLIC_DOMAIN: undefined,
        RAILWAY_TCP_PROXY_DOMAIN: undefined,
      }),
      stdout: "pipe",
      stderr: "pipe",
    });

    let sawListening = false;
    let output = "";
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      output += decoder.decode(value);
      if (output.includes("store_internal_api_listening")) {
        sawListening = true;
        break;
      }
    }
    proc.kill();
    await proc.exited;

    expect(sawListening).toBe(true);
    expect(output).toContain('"authMode":"no public ingress attached, no external auth needed"');
  }, 35_000);

  test("a public domain attached without the flag refuses to start (subprocess)", async () => {
    const { exitCode, output } = await runServer({
      GNT_STORE_PORT: "0",
      GNT_STORE_BIND: "0.0.0.0",
      GNT_STORE_INTERNAL_API_SECRET: "subprocess-secret",
      GNT_STORE_ALLOW_PUBLIC_DOMAIN: undefined,
      GNT_APPROVAL_SIGNING_SECRET: undefined,
      RAILWAY_PUBLIC_DOMAIN: "example-store.up.railway.app",
    });
    expect(exitCode).not.toBe(0);
    expect(output).toMatch(/GNT_STORE_ALLOW_PUBLIC_DOMAIN/);
  }, 15_000);

  test("a public domain attached with the flag but missing secrets refuses to start (subprocess)", async () => {
    const { exitCode, output } = await runServer({
      GNT_STORE_PORT: "0",
      GNT_STORE_BIND: "0.0.0.0",
      GNT_STORE_INTERNAL_API_SECRET: "subprocess-secret",
      GNT_STORE_ALLOW_PUBLIC_DOMAIN: "1",
      GNT_APPROVAL_SIGNING_SECRET: undefined,
      RAILWAY_PUBLIC_DOMAIN: "example-store.up.railway.app",
    });
    expect(exitCode).not.toBe(0);
    expect(output).toMatch(/GNT_APPROVAL_SIGNING_SECRET/);
  }, 15_000);

  test.skipIf(!reachable)("a public domain attached with the flag AND both secrets starts successfully (subprocess)", async () => {
    const proc = Bun.spawn(["bun", "run", "src/http/server.ts"], {
      cwd: storeDir,
      env: buildEnv({
        GNT_STORE_PORT: "0",
        GNT_STORE_BIND: "0.0.0.0",
        DATABASE_URL,
        GNT_STORE_TEST_FAKE_EMBED: "1",
        GNT_STORE_INTERNAL_API_SECRET: "subprocess-secret",
        GNT_APPROVAL_SIGNING_SECRET: "subprocess-approval-secret",
        GNT_STORE_ALLOW_PUBLIC_DOMAIN: "1",
        RAILWAY_PUBLIC_DOMAIN: "example-store.up.railway.app",
      }),
      stdout: "pipe",
      stderr: "pipe",
    });

    let sawListening = false;
    let output = "";
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      output += decoder.decode(value);
      if (output.includes("store_internal_api_listening")) {
        sawListening = true;
        break;
      }
    }
    proc.kill();
    await proc.exited;

    expect(sawListening).toBe(true);
    expect(output).toContain('"authMode":"public ingress attached, secrets verified, explicit flag acknowledged"');
  }, 35_000);
});
