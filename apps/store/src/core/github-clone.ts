/**
 * apps/store's own git clone/pull for private GitHub repos — deliberately
 * never routed through the vendored engine's cloneRepo/pullRepo
 * (src/core/git-remote.ts), which run under a strict env
 * (GIT_ASKPASS=/bin/false, no credential helper) by design, confining
 * automated clone/pull to public repos only. See
 * docs/migration/GIT_NATIVE_SPIKE.md for the research behind this.
 *
 * Auth is passed per-invocation via `-c http.extraHeader`, never embedded
 * in the remote URL or written to any git config file on disk — the PAT
 * exists only in this process's memory for the duration of the command.
 */
import { execFile as execFileCb } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";

export class GithubCloneError extends Error {}

const CLONE_TIMEOUT_MS = 60_000;

const execFile = promisify(execFileCb);

function authArgs(pat: string): string[] {
  const basic = Buffer.from(`x-access-token:${pat}`).toString("base64");
  return ["-c", `http.extraHeader=Authorization: Basic ${basic}`];
}

async function runGit(args: string[]): Promise<void> {
  try {
    await execFile("git", args, {
      timeout: CLONE_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch (e) {
    // Never surface e.message or e.cmd — both echo the full argv, including
    // the `-c http.extraHeader=Authorization: Basic <base64 PAT>` we pass
    // for auth. stderr is the only safe part of a failed git invocation.
    const stderr = (e as { stderr?: string | Buffer }).stderr?.toString().trim();
    throw new GithubCloneError(stderr || "git command failed");
  }
}

export async function cloneRepo(repoUrl: string, pat: string, destDir: string): Promise<void> {
  if (existsSync(destDir)) {
    throw new GithubCloneError(`${destDir} already exists — use pullRepo instead`);
  }
  mkdirSync(dirname(destDir), { recursive: true });
  try {
    await runGit([...authArgs(pat), "clone", "--depth=1", "--", repoUrl, destDir]);
  } catch (e) {
    // git creates destDir as soon as the clone starts, so a failure partway
    // through (network drop, timeout) leaves a partial directory behind —
    // without cleaning it up, every retry would hit the existsSync check
    // above and refuse to clone again, with no way to recover but by hand.
    rmSync(destDir, { recursive: true, force: true });
    throw e;
  }
}

export async function pullRepo(repoPath: string, pat: string): Promise<void> {
  await runGit(["-C", repoPath, ...authArgs(pat), "pull", "--ff-only", "--"]);
}

// Keyed by destDir so concurrent calls for the SAME org (e.g. connect's
// initial sync racing a webhook-triggered sync) serialize instead of two
// git processes fighting over the same working tree — while different
// orgs' clones still run fully in parallel.
const inFlight = new Map<string, Promise<void>>();

/** Clones if destDir doesn't exist yet, otherwise pulls — the one entry
 * point both the initial `gnt connect github` registration and every
 * later sync-on-merge call go through. Uses the async execFile (not
 * *Sync) so a slow clone/pull doesn't block the whole store process's
 * event loop — every other org's request would otherwise stall for up
 * to CLONE_TIMEOUT_MS. */
export function cloneOrPull(repoUrl: string, pat: string, destDir: string): Promise<void> {
  const previous = inFlight.get(destDir) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => {
    if (existsSync(destDir) && existsSync(`${destDir}/.git`)) {
      return pullRepo(destDir, pat);
    }
    return cloneRepo(repoUrl, pat, destDir);
  });
  inFlight.set(destDir, next);
  return next.finally(() => {
    if (inFlight.get(destDir) === next) {
      inFlight.delete(destDir);
    }
  });
}
