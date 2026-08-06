/**
 * Direct coverage for apps/store/src/core/github-clone.ts — the plumbing
 * behind every /sync that needs a fresh or updated local checkout.
 *
 * http-server.test.ts already covers the bad-local-path → 502 path at the
 * HTTP boundary. This file covers the two gaps that suite still leaves:
 *   1. cloneOrPull on an already-cloned dest takes pullRepo and picks up
 *      new commits from the source.
 *   2. An auth failure against a real HTTPS remote returns GithubCloneError
 *      whose message never echoes the PAT (or the Authorization header argv).
 *
 * Local-path clones don't exercise auth (http.extraHeader is
 * transport-specific), so (2) needs a live network call to GitHub. It
 * skips cleanly when offline.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { GithubCloneError, cloneOrPull, cloneRepo } from "../src/core/github-clone.ts";

function initSourceRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "gnt-clone-src-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(dir, relativePath);
    mkdirSync(fullPath.slice(0, fullPath.lastIndexOf("/")), { recursive: true });
    writeFileSync(fullPath, content);
  }
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", [
    "-C",
    dir,
    "-c",
    "user.email=test@test.com",
    "-c",
    "user.name=test",
    "commit",
    "-q",
    "-m",
    "seed",
  ]);
  return dir;
}

function commitNewFile(dir: string, relativePath: string, content: string, message: string): void {
  const fullPath = join(dir, relativePath);
  mkdirSync(fullPath.slice(0, fullPath.lastIndexOf("/")), { recursive: true });
  writeFileSync(fullPath, content);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", [
    "-C",
    dir,
    "-c",
    "user.email=test@test.com",
    "-c",
    "user.name=test",
    "commit",
    "-q",
    "-m",
    message,
  ]);
}

describe("cloneOrPull", () => {
  test("second call on an existing clone takes pullRepo and picks up new commits", async () => {
    const source = initSourceRepo({ "rules/seed.md": "v1\n" });
    const dest = join(mkdtempSync(join(tmpdir(), "gnt-clone-dst-")), "repo");

    await cloneOrPull(source, "unused-for-a-local-repo", dest);
    expect(existsSync(join(dest, ".git"))).toBe(true);
    expect(readFileSync(join(dest, "rules/seed.md"), "utf8")).toBe("v1\n");

    commitNewFile(source, "rules/after-pull.md", "picked up by pull\n", "add after clone");

    // dest/.git already exists — cloneOrPull must pull, not re-clone
    // (re-clone would throw "already exists — use pullRepo instead").
    await cloneOrPull(source, "unused-for-a-local-repo", dest);
    expect(readFileSync(join(dest, "rules/after-pull.md"), "utf8")).toBe("picked up by pull\n");
    expect(readFileSync(join(dest, "rules/seed.md"), "utf8")).toBe("v1\n");
  });

  test("cloneRepo refuses a dest that already exists", async () => {
    const source = initSourceRepo({ "rules/seed.md": "v1\n" });
    const dest = join(mkdtempSync(join(tmpdir(), "gnt-clone-exists-")), "repo");
    await cloneRepo(source, "unused", dest);

    await expect(cloneRepo(source, "unused", dest)).rejects.toBeInstanceOf(GithubCloneError);
    await expect(cloneRepo(source, "unused", dest)).rejects.toThrow(/already exists/);
  });
});

describe("cloneOrPull auth failure", () => {
  test("a rejected PAT fails cleanly without leaking the token", async () => {
    // GitHub rejects invalid Authorization even on public repos — that's
    // enough to exercise runGit's stderr-only error path without needing
    // a private fixture. Skip when the network is unreachable so offline
    // `bun test` runs stay green.
    const probe = await fetch("https://github.com/", { method: "HEAD", signal: AbortSignal.timeout(5_000) }).catch(
      () => null,
    );
    if (!probe) {
      console.warn("skipping auth-failure test: github.com unreachable");
      return;
    }

    const badPat = "ghp_thisIsDefinitelyNotARealToken_xxxxxxxxxxxxxxxxxxxx";
    const dest = join(mkdtempSync(join(tmpdir(), "gnt-clone-auth-")), "repo");

    let err: unknown;
    try {
      await cloneOrPull("https://github.com/gnt-ai/gnt.git", badPat, dest);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(GithubCloneError);
    const message = String((err as Error).message);
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain(badPat);
    expect(message).not.toContain("Authorization");
    expect(message).not.toContain("extraHeader");
    expect(message).not.toContain("x-access-token");
    // Failed clone must clean up the partial dest dir.
    expect(existsSync(dest)).toBe(false);
  }, 90_000);
});
