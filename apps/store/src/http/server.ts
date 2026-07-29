/**
 * The internal API between apps/api (Python, keeps the approval state
 * machine reviewed in PR #11) and this seam. Not the customer/agent-facing
 * MCP surface — that's Phase 6, a completely separate, narrower, 3-tool
 * read-mostly API. This one is a private, same-host, all-operations
 * surface for gnt's own backend to call.
 *
 * Security posture: loopback-only by default, bearer-token auth, no
 * self-service registration, structured logging without content bodies.
 * GNT_STORE_INTERNAL_API_SECRET is a distinct secret from
 * GNT_APPROVAL_SIGNING_SECRET — this one proves "this request came from
 * gnt's own backend," the other proves "this specific approved-status
 * write was authorized by the approval workflow." A caller needs both to
 * push a rule to approved; needing only this one to do everything else
 * (create/submit/reject/deprecate/read) is intentional, not an oversight.
 */
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { NativeStore } from "../native/store.ts";
import { zeroEntropyEmbed } from "../native/embed.ts";
import { ApprovalRejectedError } from "../core/approval-signing.ts";
import type { AuditEntry, GntStore, IngestBatch, RuleStatus } from "../core/store.ts";

/**
 * registerGithubSource/syncGithubSource aren't part of the core GntStore
 * seam (source-sync is a separate concern from the rules CRUD every other
 * handler below uses) — NativeStore implements them with this exact
 * signature, so the HTTP layer depends on this narrow structural type
 * instead of the concrete class.
 */
type StoreWithGithubSource = GntStore & {
  registerGithubSource(orgId: string, repoUrl: string, pat: string): Promise<void>;
  syncGithubSource(orgId: string, repoUrl: string, pat: string): Promise<unknown>;
};

const RULE_STATUS_VALUES = ["draft", "in_review", "pending_merge", "approved", "deprecated"] as const;
const AUDIT_ACTION_VALUES = [
  "created",
  "submitted",
  "proposed",
  "approved",
  "rejected",
  "deprecated",
  "decision_logged",
  // Server-side privacy gate's own audit entry, see AuditEntry.action's
  // own comment in core/store.ts.
  "privacy_gate_masked",
] as const;
const SOURCE_KIND_VALUES = ["slack", "doc", "capture", "escalation"] as const;

// Deliberately opaque (see core/store.ts's SourceCitation type docstring)
// -- this has carried the legacy source_type/source_id/permalink/
// captured_at shape and `gnt prebrain`'s extraction-citation shape
// (sourcePath/startLine/endLine/walker/excerpt) over time, and nothing
// in this seam reads a specific field off either. Requiring
// source_type here (the schema's original, narrower shape) rejected every
// real prebrain-extracted citation outright -- any rule proposed with one
// 400'd on the very first putPage. z.record(), not z.object() with a
// union of the two known shapes, so a future producer's shape doesn't
// also need a schema change here to stop 400ing.
const SourceCitationSchema = z.record(z.string(), z.unknown());

const RulePageSchema = z
  .object({
    slug: z.string().min(1),
    org: z.string().min(1),
    title: z.string(),
    body: z.string(),
    status: z.enum(RULE_STATUS_VALUES),
    confidence: z.number(),
    ownerId: z.string(),
    sourceCitations: z.array(SourceCitationSchema),
    // .default(null), not just .nullable() — callers that predate this
    // field (test fixtures, eval seeding scripts, anything constructing a
    // rule dict without going through routers/rules.py's create_rule)
    // send no "source" key at all, and that must parse the same as an
    // explicit null rather than a validation error.
    source: z.string().nullable().default(null),
    tags: z.array(z.string()),
    lastValidatedAt: z.string().nullable(),
    version: z.number().int(),
    supersededBy: z.string().nullable(),
    previousVersionId: z.string().nullable(),
    approvedBy: z.string().nullable(),
    approvedAt: z.string().nullable(),
    createdAt: z.string(),
    prNumber: z.number().int().positive().nullable(),
    prUrl: z.string().url().nullable(),
  })
  .superRefine((rule, ctx) => {
    // draft/in_review never carry a PR reference — nothing proposes them
    // for merge yet. pending_merge must carry one — that's the whole
    // point of the status. approved/deprecated are deliberately left
    // unconstrained: whether a merged rule keeps its originating PR
    // reference as provenance, or has it cleared, is Phase 4's call
    // (the webhook handler), not decided by this schema.
    if (rule.status === "pending_merge") {
      if (rule.prNumber === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["prNumber"],
          message: "prNumber is required while status is pending_merge",
        });
      }
      if (rule.prUrl === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["prUrl"],
          message: "prUrl is required while status is pending_merge",
        });
      }
    } else if (rule.status === "draft" || rule.status === "in_review") {
      if (rule.prNumber !== null || rule.prUrl !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["prNumber"],
          message: "prNumber/prUrl must be null unless status is pending_merge",
        });
      }
    }
  });

const PutRuleBodySchema = z.object({
  rule: RulePageSchema,
  // store_client.py always sends this key, explicit `null` when there's no
  // signature to send — not omitted — so `.optional()` alone (undefined
  // only) would reject every unsigned write. `.nullish()` accepts both.
  approvalSignature: z.string().nullish(),
});

const AuditEntrySchema = z.object({
  org: z.string().min(1),
  ruleSlug: z.string().min(1),
  actorId: z.string().min(1),
  action: z.enum(AUDIT_ACTION_VALUES),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()),
});

const SearchBodySchema = z.object({
  query: z.string().min(1),
  orgId: z.string().min(1),
  status: z.literal("approved"),
});

const IngestBodySchema = z.object({
  org: z.string().min(1),
  sourceKind: z.enum(SOURCE_KIND_VALUES),
  text: z.string().min(1),
  ref: z.string(),
});

// repoUrl/pat travel in the body on every call (never cached store-side) —
// apps/api holds the encrypted PAT (GithubConnection), decrypts it, and
// passes it through here each time; this seam never persists it itself.
const GithubSourceBodySchema = z.object({
  org: z.string().min(1),
  repoUrl: z.string().min(1),
  pat: z.string().min(1),
});

// Org offboarding's store-side delete.
// No confirmation flag here: the confirmation gate lives one layer up
// (apps/api's two-step request/confirm flow) — by the time this seam sees
// the call, a human has already confirmed.
const DeleteOrgSourceBodySchema = z.object({
  org: z.string().min(1),
});

/** Parses the body as JSON and validates it against `schema` in one step —
 * a SyntaxError from malformed JSON and a ZodError from a well-formed but
 * invalid payload both become a 400, not an uncaught exception that falls
 * through to the generic 500 handler below. */
async function parseBody<T>(req: Request, schema: z.ZodType<T>): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return { ok: false, response: badRequest("malformed JSON body") };
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    return { ok: false, response: badRequest(result.error.issues.map((i) => i.message).join("; ")) };
  }
  return { ok: true, data: result.data };
}

function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

function makeAuthChecker(secret: string) {
  const secretBuf = Buffer.from(secret, "utf8");
  return (req: Request): boolean => {
    const header = req.headers.get("authorization");
    if (!header?.startsWith("Bearer ")) return false;
    const token = header.slice("Bearer ".length);
    const tokenBuf = Buffer.from(token, "utf8");
    // timingSafeEqual throws on mismatched lengths rather than returning
    // false, so the length check has to happen first — same pattern as
    // verifyApprovalSignature in approval-signing.ts.
    if (tokenBuf.length !== secretBuf.length) return false;
    return timingSafeEqual(tokenBuf, secretBuf);
  };
}

function logCall(method: string, path: string, status: number, startedAt: number): void {
  console.log(
    JSON.stringify({
      event: "store_internal_api_call",
      method,
      path,
      status,
      latency_ms: Date.now() - startedAt,
    }),
  );
}

async function handlePutRule(store: GntStore, req: Request): Promise<Response> {
  const parsed = await parseBody(req, PutRuleBodySchema);
  if (!parsed.ok) return parsed.response;
  try {
    const result = await store.putPage(parsed.data.rule, {
      approvalSignature: parsed.data.approvalSignature ?? undefined,
    });
    return Response.json(result);
  } catch (err) {
    if (err instanceof ApprovalRejectedError) {
      // A client error (bad/missing signature) — 403, not 500.
      return Response.json({ error: err.message }, { status: 403 });
    }
    throw err; // genuine failures still surface as 500 via the outer handler
  }
}

async function handleGetRule(store: GntStore, slug: string, orgId: string | null): Promise<Response> {
  if (!orgId) return badRequest("org query param is required");
  const page = await store.getPage(slug, { orgId });
  if (!page) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(page);
}

async function handleListRules(store: GntStore, url: URL): Promise<Response> {
  const orgId = url.searchParams.get("org");
  if (!orgId) return badRequest("org query param is required");
  const rawStatus = url.searchParams.get("status");
  const statusResult = rawStatus === null ? { success: true as const, data: undefined } : z.enum(RULE_STATUS_VALUES).safeParse(rawStatus);
  if (!statusResult.success) return badRequest(`status must be one of: ${RULE_STATUS_VALUES.join(", ")}`);
  const pages = await store.listPages({ orgId, status: statusResult.data as RuleStatus | undefined });
  return Response.json(pages);
}

async function handleSearch(store: GntStore, req: Request): Promise<Response> {
  const parsed = await parseBody(req, SearchBodySchema);
  if (!parsed.ok) return parsed.response;
  const hits = await store.search(parsed.data.query, { orgId: parsed.data.orgId, status: "approved" });
  return Response.json(hits);
}

async function handleAppendAudit(store: GntStore, req: Request): Promise<Response> {
  const parsed = await parseBody(req, AuditEntrySchema);
  if (!parsed.ok) return parsed.response;
  await store.appendAudit(parsed.data as AuditEntry);
  return Response.json({ ok: true });
}

async function handleIngest(store: GntStore, req: Request): Promise<Response> {
  const parsed = await parseBody(req, IngestBodySchema);
  if (!parsed.ok) return parsed.response;
  const receipt = await store.ingest(parsed.data as IngestBatch);
  return Response.json(receipt);
}

async function handleGetAuditTrail(store: GntStore, slug: string, orgId: string | null): Promise<Response> {
  if (!orgId) return badRequest("org query param is required");
  const entries = await store.getAuditTrail(slug, { orgId });
  return Response.json(entries);
}

async function handleListRulesByPr(store: GntStore, prNumber: number, orgId: string | null): Promise<Response> {
  if (!orgId) return badRequest("org query param is required");
  // pending_merge is the only status that ever carries a prNumber — no new
  // GntStore method needed, this is exactly what listPages already
  // supports, just filtered client-side to every rule matching this PR.
  //
  // This used to be .find() and returned (at most) one
  // rule. Batched propose (apps/api's POST /v1/rules/batch-propose) can
  // now put several rules on the SAME pull request, all sharing the same
  // prNumber, so the webhook handler that turns a merge into an approval
  // needs every one of them, not just whichever happened to be first in
  // listPages' order. There was never a uniqueness constraint on prNumber
  // to begin with — .find() silently dropping siblings was the actual bug,
  // not something this filter() is loosening. Returns an empty array
  // (still 200, matching listPages' own empty-list convention) rather than
  // a 404, since "no rule" is a completely ordinary result for an
  // unrecognized or already-approved PR, not an error — see the one
  // caller, github_webhook.py's handler, for how that's used.
  //
  // Replaces the single-rule response shape outright rather than adding a
  // second endpoint alongside it: store_client.py's get_rule_by_pr was
  // this endpoint's only caller anywhere in the codebase (grepped before
  // making this call), and that caller is being rewritten to expect a
  // list in this same change — so there's no other consumer left assuming
  // the old single-object shape to break.
  const pending = await store.listPages({ status: "pending_merge", orgId });
  return Response.json(pending.filter((rule) => rule.prNumber === prNumber));
}

async function handleRegisterSource(store: StoreWithGithubSource, req: Request): Promise<Response> {
  const parsed = await parseBody(req, GithubSourceBodySchema);
  if (!parsed.ok) return parsed.response;
  try {
    await store.registerGithubSource(parsed.data.org, parsed.data.repoUrl, parsed.data.pat);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
  return Response.json({ ok: true });
}

async function handleSyncSource(store: StoreWithGithubSource, req: Request): Promise<Response> {
  const parsed = await parseBody(req, GithubSourceBodySchema);
  if (!parsed.ok) return parsed.response;
  try {
    const result = await store.syncGithubSource(parsed.data.org, parsed.data.repoUrl, parsed.data.pat);
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}

async function handleDeleteOrgSource(store: GntStore, req: Request): Promise<Response> {
  const parsed = await parseBody(req, DeleteOrgSourceBodySchema);
  if (!parsed.ok) return parsed.response;
  const result = await store.deleteOrgSource(parsed.data.org);
  return Response.json(result);
}

/**
 * Builds the fetch handler against an already-initialized store and a
 * fixed secret — the seam between "how do I answer an HTTP request" and
 * "how do I become a running process." Tests call this directly with a
 * fake-embed-backed store; the entrypoint below wires it to the real one.
 */
export function createFetchHandler(
  store: StoreWithGithubSource,
  secret: string,
): (req: Request) => Promise<Response> {
  const isAuthorized = makeAuthChecker(secret);

  return async function fetch(req: Request): Promise<Response> {
    const startedAt = Date.now();
    const url = new URL(req.url);

    if (url.pathname === "/health" && req.method === "GET") {
      return Response.json({ ok: true });
    }

    if (!isAuthorized(req)) {
      logCall(req.method, url.pathname, 401, startedAt);
      return unauthorized();
    }

    let response: Response;
    try {
      if (url.pathname === "/rules" && req.method === "POST") {
        response = await handlePutRule(store, req);
      } else if (url.pathname === "/rules" && req.method === "GET") {
        response = await handleListRules(store, url);
      } else if (url.pathname.startsWith("/rules/by-pr/") && req.method === "GET") {
        // Must be checked before the generic "/rules/" prefix branch below,
        // which would otherwise treat "by-pr/42" as a literal rule slug.
        const raw = url.pathname.slice("/rules/by-pr/".length);
        const prNumber = Number(raw);
        if (!Number.isInteger(prNumber) || prNumber <= 0) {
          response = badRequest("pr number must be a positive integer");
        } else {
          response = await handleListRulesByPr(store, prNumber, url.searchParams.get("org"));
        }
      } else if (url.pathname.startsWith("/rules/") && req.method === "GET") {
        const slug = decodeURIComponent(url.pathname.slice("/rules/".length));
        response = await handleGetRule(store, slug, url.searchParams.get("org"));
      } else if (url.pathname === "/search" && req.method === "POST") {
        response = await handleSearch(store, req);
      } else if (url.pathname === "/audit" && req.method === "POST") {
        response = await handleAppendAudit(store, req);
      } else if (url.pathname.startsWith("/audit/") && req.method === "GET") {
        const slug = decodeURIComponent(url.pathname.slice("/audit/".length));
        response = await handleGetAuditTrail(store, slug, url.searchParams.get("org"));
      } else if (url.pathname === "/ingest" && req.method === "POST") {
        response = await handleIngest(store, req);
      } else if (url.pathname === "/sources" && req.method === "POST") {
        response = await handleRegisterSource(store, req);
      } else if (url.pathname === "/sync" && req.method === "POST") {
        response = await handleSyncSource(store, req);
      } else if (url.pathname === "/sources/delete" && req.method === "POST") {
        response = await handleDeleteOrgSource(store, req);
      } else {
        response = Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "store_internal_api_error",
          path: url.pathname,
          message: (err as Error).message,
        }),
      );
      response = Response.json({ error: "internal error" }, { status: 500 });
    }

    logCall(req.method, url.pathname, response.status, startedAt);
    return response;
  };
}

const NO_PUBLIC_INGRESS_AUTH_MODE = "no public ingress attached, no external auth needed";
const PUBLIC_INGRESS_AUTH_MODE = "public ingress attached, secrets verified, explicit flag acknowledged";

export interface NetworkExposureConfig {
  /** Only used for the error/log message — see the comment below on why
   * bind address no longer drives the decision itself. */
  bind: string;
  internalApiSecret: string | undefined;
  approvalSigningSecret: string | undefined;
  /** RAILWAY_PUBLIC_DOMAIN — set by Railway iff an HTTP domain (generated
   * or custom) is attached to this service. This is the thing that's
   * actually internet-reachable, not the bind address. */
  publicDomain: string | undefined;
  /** RAILWAY_TCP_PROXY_DOMAIN — Railway's equivalent signal for a raw TCP
   * proxy instead of an HTTP domain. Same exposure, different transport. */
  tcpProxyDomain: string | undefined;
  /** Raw value of GNT_STORE_ALLOW_PUBLIC_DOMAIN — must be exactly "1" to
   * count as an explicit acknowledgment, same convention as
   * GNT_STORE_TEST_FAKE_EMBED. */
  allowPublicDomain: string | undefined;
}

/**
 * Network-exposure gate, take two. The first version keyed off bind address
 * (loopback vs. not) and it crash-looped production: Railway containers
 * MUST bind 0.0.0.0 to be reachable by *anything*, including Railway's own
 * private network — see this package's README for the full explanation.
 * "Bound to 0.0.0.0" and "reachable from the public internet" are
 * different facts in a containerized deployment, and the first version
 * conflated them.
 *
 * The actual security boundary on Railway is whether a service has a
 * public domain or TCP proxy attached — that's the one thing that puts a
 * service on the public internet instead of just Railway's private
 * network. Railway injects RAILWAY_PUBLIC_DOMAIN / RAILWAY_TCP_PROXY_DOMAIN
 * only when that's true, so their absence is Railway's own proof this
 * service has no public ingress, independent of GNT_STORE_BIND.
 *
 * Refuses to start (throws) rather than logging a warning and continuing
 * — a warning is silent in most deploy pipelines, a thrown startup error
 * is not.
 *
 * No public ingress stays exactly as permissive as loopback used to be: no
 * flag, no extra secret required, since nothing off the private network
 * can reach it. A public domain or TCP proxy attached is the dangerous
 * case this check exists to catch — an operator accidentally exposing an
 * internal-only service to the internet.
 */
export function resolveNetworkExposure(config: NetworkExposureConfig): string {
  const hasPublicIngress = Boolean(config.publicDomain) || Boolean(config.tcpProxyDomain);

  if (!hasPublicIngress) {
    return NO_PUBLIC_INGRESS_AUTH_MODE;
  }

  const ingressDescription = [
    config.publicDomain ? `RAILWAY_PUBLIC_DOMAIN=${config.publicDomain}` : null,
    config.tcpProxyDomain ? `RAILWAY_TCP_PROXY_DOMAIN=${config.tcpProxyDomain}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  if (config.allowPublicDomain !== "1") {
    throw new Error(
      `refusing to start: this service has a public ingress attached (${ingressDescription}, ` +
        `GNT_STORE_BIND=${config.bind}). This is an internal-only service — apps/api reaches it ` +
        "over Railway's private network and it should never be internet-reachable. Set " +
        "GNT_STORE_ALLOW_PUBLIC_DOMAIN=1 to explicitly acknowledge a deliberate public " +
        "deployment (and make sure it actually sits behind auth).",
    );
  }

  if (!config.internalApiSecret || !config.approvalSigningSecret) {
    throw new Error(
      `refusing to start: a public ingress is attached (${ingressDescription}), which requires ` +
        "both GNT_STORE_INTERNAL_API_SECRET and GNT_APPROVAL_SIGNING_SECRET to be set " +
        "(GNT_STORE_ALLOW_PUBLIC_DOMAIN alone is not enough — it acknowledges the deployment " +
        "shape, it doesn't stand in for auth).",
    );
  }

  return PUBLIC_INGRESS_AUTH_MODE;
}

/**
 * Bun.serve defaults maxRequestBodySize to 128 MiB — far past anything
 * this service's actual traffic shape needs, and large enough that a
 * single caller (malicious or just buggy) could force multiple such
 * bodies into memory at once. None of this file's schemas declare a max
 * length on their text fields (RulePageSchema.body/.title, IngestBodySchema.text,
 * the capture/page content this seam actually stores), but even a long
 * hand-authored policy doc or a captured thread tops out in the tens to
 * low hundreds of KB, not megabytes. 4 MiB gives an order of magnitude of
 * headroom above any realistic single request while still bounding it.
 * Bun enforces this natively before the fetch handler ever runs: an
 * up-front Content-Length check rejects immediately, and streamed/chunked
 * bodies are capped mid-stream — both paths return 413 without
 * materializing the oversized body.
 */
export const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024; // 4 MiB

async function main(): Promise<void> {
  const port = Number(process.env.GNT_STORE_PORT ?? 8787);
  const bind = process.env.GNT_STORE_BIND ?? "127.0.0.1";
  const secret = process.env.GNT_STORE_INTERNAL_API_SECRET;

  if (!secret) {
    throw new Error(
      "GNT_STORE_INTERNAL_API_SECRET is not set. The internal API refuses to start " +
        "unauthenticated — this is not optional even for local dev (fail closed).",
    );
  }

  const authMode = resolveNetworkExposure({
    bind,
    internalApiSecret: secret,
    approvalSigningSecret: process.env.GNT_APPROVAL_SIGNING_SECRET,
    publicDomain: process.env.RAILWAY_PUBLIC_DOMAIN,
    tcpProxyDomain: process.env.RAILWAY_TCP_PROXY_DOMAIN,
    allowPublicDomain: process.env.GNT_STORE_ALLOW_PUBLIC_DOMAIN,
  });

  // "native" is the only backend this store has left — kept as an explicit
  // string (not just always-native with no var at all) so an old deploy
  // target still carrying STORE_BACKEND=engine fails loudly with a clear
  // message instead of silently misbehaving.
  const backend = process.env.STORE_BACKEND ?? "native";
  if (backend !== "native") {
    throw new Error(
      `STORE_BACKEND=${backend} is not supported — the only backend is "native" ` +
        '(or leave STORE_BACKEND unset, "native" is the default).',
    );
  }
  const testFakeEmbed = process.env.GNT_STORE_TEST_FAKE_EMBED === "1";
  if (testFakeEmbed) {
    console.warn(
      "[gnt-store] GNT_STORE_TEST_FAKE_EMBED=1 — using a deterministic fake embedding, " +
        "NOT a real provider. This must never be set outside a test/CI fixture (e.g. the " +
        "Python backend's pytest suite spawning this server as a subprocess).",
    );
  }

  // orgId below only bootstraps a placeholder source; every real org's
  // source is lazily bootstrapped on its first putPage.
  let store: StoreWithGithubSource;
  if (testFakeEmbed) {
    const { fakeEmbed } = await import("../testing/fake-embed.ts");
    // Same live-call gate as the embed above (tests must never make a
    // real paid provider call) — this test path must never construct
    // NativeStore's real zeroEntropyRerank default, since apps/store/.env
    // auto-loads a real ZEROENTROPY_API_KEY into every subprocess spawned
    // from this directory.
    const { fakeRerank } = await import("../testing/fake-rerank.ts");
    const native = new NativeStore(fakeEmbed, fakeRerank);
    await native.init({ engine: "postgres", orgId: "__store_bootstrap__" });
    store = native;
  } else {
    // Real ZeroEntropy zembed-1 transport (../native/embed.ts) — rerank
    // stays NativeStore's own constructor default (zeroEntropyRerank),
    // same account, no separate wiring needed here.
    const native = new NativeStore(zeroEntropyEmbed);
    await native.init({ engine: "postgres", orgId: "__store_bootstrap__" });
    store = native;
  }

  const server = Bun.serve({
    port,
    hostname: bind,
    fetch: createFetchHandler(store, secret),
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  });
  console.log(
    JSON.stringify({
      event: "store_internal_api_listening",
      port: server.port,
      hostname: bind,
      backend,
      authMode,
    }),
  );
}

// import.meta.main is Bun's "is this the entrypoint, not an import" check
// — tests import createFetchHandler without triggering a real server +
// real embedding-gateway startup.
if (import.meta.main) {
  await main();
}
