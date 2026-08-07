import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { API_URL } from "../config.js";
import { tryLoadCredentials } from "../credentials.js";
import { fail, muted, ok } from "../theme.js";

const MINIMUM_NODE_VERSION = [22, 13, 0] as const;
const REQUEST_TIMEOUT_MS = 5_000;

type EnvMap = Record<string, string>;

export interface DoctorOptions {
  cwd?: string;
  fetchImpl?: typeof fetch;
  nodeVersion?: string;
}

function parseVersion(version: string): number[] | null {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? match.slice(1).map(Number) : null;
}

export function isSupportedNodeVersion(version: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  for (let i = 0; i < MINIMUM_NODE_VERSION.length; i += 1) {
    if (parsed[i] !== MINIMUM_NODE_VERSION[i]) return parsed[i] > MINIMUM_NODE_VERSION[i];
  }
  return true;
}

function parseEnv(path: string): EnvMap {
  const values: EnvMap = {};
  for (const rawLine of readFileSync(path, "utf-8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function findSelfHostRoot(start: string): string | null {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, "docker-compose.yml")) && existsSync(join(current, "apps/api/.env.example"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function inspectSelfHostEnv(root: string): string[] {
  const apiPath = join(root, "apps/api/.env");
  const storePath = join(root, "apps/store/.env");
  if (!existsSync(apiPath) || !existsSync(storePath)) {
    return ["Self-host env files are missing. Run `./setup.sh` from the repository root."];
  }

  const api = parseEnv(apiPath);
  const store = parseEnv(storePath);
  const failures: string[] = [];
  const placeholders = Object.entries(api)
    .filter(([, value]) => value.includes("change-me"))
    .map(([key]) => key);

  if (placeholders.length > 0) {
    failures.push(`Unreplaced apps/api placeholders: ${placeholders.join(", ")}. Run \`./setup.sh\` to generate them.`);
  }
  if (!store.GNT_STORE_INTERNAL_API_SECRET || store.GNT_STORE_INTERNAL_API_SECRET.includes("change-me")) {
    failures.push("GNT_STORE_INTERNAL_API_SECRET is missing or still a placeholder in apps/store/.env.");
  }
  if (!api.STORE_INTERNAL_API_SECRET) {
    failures.push("STORE_INTERNAL_API_SECRET is missing from apps/api/.env.");
  }
  if (
    api.STORE_INTERNAL_API_SECRET &&
    store.GNT_STORE_INTERNAL_API_SECRET &&
    api.STORE_INTERNAL_API_SECRET !== store.GNT_STORE_INTERNAL_API_SECRET
  ) {
    failures.push("STORE_INTERNAL_API_SECRET and GNT_STORE_INTERNAL_API_SECRET do not match.");
  }
  if (
    api.APPROVAL_SIGNING_SECRET &&
    store.GNT_APPROVAL_SIGNING_SECRET &&
    api.APPROVAL_SIGNING_SECRET !== store.GNT_APPROVAL_SIGNING_SECRET
  ) {
    failures.push("APPROVAL_SIGNING_SECRET and GNT_APPROVAL_SIGNING_SECRET do not match.");
  }
  if (!store.ZEROENTROPY_API_KEY) {
    failures.push("ZEROENTROPY_API_KEY is empty in apps/store/.env; rule embedding and reranking will fail.");
  }

  return failures;
}

async function request(fetchImpl: typeof fetch, path: string, key?: string): Promise<Response | null> {
  try {
    return await fetchImpl(`${API_URL}${path}`, {
      headers: key ? { Authorization: `Bearer ${key}` } : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

export async function doctor(options: DoctorOptions = {}): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const credentials = tryLoadCredentials();
  let healthy = true;

  console.log(muted("gnt doctor"));

  if (isSupportedNodeVersion(nodeVersion)) {
    console.log(ok(`Node ${nodeVersion} (requires >=22.13.0)`));
  } else {
    console.log(fail(`Node ${nodeVersion} is unsupported; install Node >=22.13.0.`));
    healthy = false;
  }

  if (credentials) {
    console.log(ok("Login credentials found"));
  } else {
    console.log(fail("Not logged in. Run `gnt login`."));
    healthy = false;
  }

  const healthResponse = await request(fetchImpl, "/healthz");
  if (healthResponse?.ok) {
    console.log(ok(`API reachable at ${API_URL}`));
  } else {
    const detail = healthResponse ? `HTTP ${healthResponse.status}` : "network error or timeout";
    console.log(fail(`API unreachable at ${API_URL} (${detail}).`));
    healthy = false;
  }

  if (healthResponse?.ok && credentials) {
    const onboarding = await request(fetchImpl, "/v1/onboarding/status", credentials.apiKey);
    if (onboarding?.ok) {
      try {
        const data = (await onboarding.json()) as { connected_github?: boolean };
        if (data.connected_github) {
          console.log(ok("GitHub rules repository connected"));
        } else {
          console.log(fail("No GitHub rules repository connected. Run `gnt connect github`."));
          healthy = false;
        }
      } catch {
        console.log(fail("API returned an invalid onboarding-status response."));
        healthy = false;
      }
    } else if (onboarding?.status === 401 || onboarding?.status === 403) {
      console.log(fail(`Saved login was rejected by the API (HTTP ${onboarding.status}). Run \`gnt login\` again.`));
      healthy = false;
    } else if (onboarding) {
      console.log(fail(`Could not check the connected GitHub repository (HTTP ${onboarding.status}).`));
      healthy = false;
    } else {
      console.log(fail("Could not check the connected GitHub repository (network error or timeout)."));
      healthy = false;
    }
  } else {
    console.log(muted("- Connected GitHub repository check skipped until login and API reachability pass."));
  }

  const selfHostRoot = findSelfHostRoot(options.cwd ?? process.cwd());
  if (selfHostRoot) {
    const envFailures = inspectSelfHostEnv(selfHostRoot);
    if (envFailures.length === 0) {
      console.log(ok("Self-host environment files pass known configuration checks"));
    } else {
      for (const message of envFailures) {
        console.log(fail(message));
        healthy = false;
      }
    }
  }

  console.log(healthy ? ok("No blocking problems found.") : fail("Problems found; fix the items above and rerun `gnt doctor`."));
  return healthy;
}
