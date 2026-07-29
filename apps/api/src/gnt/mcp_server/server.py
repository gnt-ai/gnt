import json
import time
import uuid
from urllib.parse import urlsplit

import sentry_sdk
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from sqlalchemy import select

from gnt.action_check import evaluate_action
from gnt.config import get_settings
from gnt.db.models import SkillFile, SkillPack
from gnt.db.rls import scope_to_org
from gnt.db.session import get_sessionmaker
from gnt.gap_tracking import log_gap
from gnt.mcp_server.context import require_key_id, require_org_id
from gnt.rate_limit import check_sliding_window_rate_limit
from gnt.roi_metrics import bump_roi_counters
from gnt.staleness import rule_freshness
from gnt.store_client import get_rule as store_get_rule
from gnt.store_client import search_rules as store_search_rules


# streamable_http_path defaults to "/mcp" and main.py mounts this whole app
# under settings.mcp_url's path again — left at the default, the real
# working path would be "/mcp/mcp", not the published settings.mcp_url.
# Serving from "/" here makes the mount prefix the only "/mcp" in the URL.
# See tests/test_mcp_published_url.py for the automated check that a real
# MCP protocol client actually gets an answer at that exact path.
#
# FastMCP's own DNS-rebinding protection defaults to allowing only
# 127.0.0.1/localhost Host headers (correct default for local dev, useless
# for a deployed server) — confirmed live: the real published domain got a
# flat 421 "Invalid Host header" until this was added. Origin isn't
# similarly allowlisted: MCP clients call this as a server API, not from a
# browser, so they don't send an Origin header, and the check passes
# any request that omits one.
_api_origin_host = urlsplit(get_settings().api_origin).netloc
_allowed_hosts = [_api_origin_host, "127.0.0.1:*", "localhost:*", "[::1]:*"]
# The service's own .up.railway.app domain stays valid alongside the custom
# domain — when API_ORIGIN moved to api.gntai.dev, deriving the allowlist
# from it alone silently 421'd every MCP config still pointing at the old
# host (the July domain migration explicitly promised those keep working).
# Explicit config, not RAILWAY_PUBLIC_DOMAIN: Railway repoints that var to
# the custom domain the moment one is attached, so the legacy host isn't
# derivable from anything Railway still provides — verified live when the
# env-var version of this fix deployed and changed nothing.
_allowed_hosts += [h.strip() for h in get_settings().mcp_extra_allowed_hosts.split(",") if h.strip()]
mcp = FastMCP(
    "gnt-brain",
    stateless_http=True,
    streamable_http_path="/",
    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=_allowed_hosts,
    ),
)

# --- The rules serving surface -----------------------------------------


def _log_mcp_call(
    tool: str, org_id: str, start: float, result, *, status: str = "ok", extra: dict | None = None
) -> None:
    """Structured, one-line-per-call logging: org, tool, latency, result
    count, never content bodies — this becomes usage data for pricing
    later (query volume per org/key is the metric that actually matters
    for that, not what was asked). status distinguishes a normal response
    from a rejected (rate-limited) or failed (exception) call so those
    don't silently disappear from the usage picture.

    `extra` carries tool-specific fields on the same line and mechanism —
    check_action uses it for the verdict, the ids it cited, and whether any
    rules were retrieved at all, which is exactly what the ROI metering
    behind the weekly digest aggregates per org later. No parallel logging
    system.

    This stream stays print-to-stdout, usage-data-shaped — it's not where
    coverage gaps get persisted. A "which queries has this
    org asked with no coverage" list needs GROUP BY/COUNT, which a log
    stream can't serve without a shipping pipeline this codebase doesn't
    have; see gap_tracking.py's rule_gaps table (Postgres) for that, and
    _log_gap below for the call sites that write to it."""
    if isinstance(result, list):
        result_count = len(result)
    elif isinstance(result, dict) and "error" in result:
        result_count = 0
    else:
        result_count = 1
    payload = {
        "event": "mcp_call",
        "tool": tool,
        "org_id": org_id,
        "status": status,
        "latency_ms": int((time.monotonic() - start) * 1000),
        "result_count": result_count,
    }
    if extra:
        payload.update(extra)
    print(json.dumps(payload))


async def _log_gap(tool: str, org_id: str, query_text: str) -> None:
    """Best-effort coverage-gap logging — mirrors
    _log_mcp_call's own must-never-break-the-call discipline. gap_tracking.
    log_gap already swallows its own failures once it has a session; this
    also guards session/connection setup itself, since a DB hiccup here
    must never turn a normal empty-result search_rules or a genuine
    needs_human check_action response into a failed call. Opens its own
    session the same way list_skill_packs/get_skill_pack do above, rather
    than threading one through every tool — these MCP tool functions have
    no FastAPI request-scoped session to reuse."""
    try:
        session_factory = get_sessionmaker()
        async with session_factory() as session:
            await log_gap(session, org_id, tool, query_text)
    except Exception as exc:
        sentry_sdk.capture_exception(exc)


async def _bump_roi(org_id: str, counters: dict[str, int]) -> None:
    """Best-effort ROI counter increment, feeding the ROI metering behind
    the weekly digest — same must-never-break-the-call
    discipline and own-session shape as _log_gap right above: opens its
    own session (these MCP tool functions have no FastAPI request-scoped
    session to reuse) and swallows every failure, since a DB hiccup here
    must never turn a normal search_rules/get_rule/check_action response
    into a failed call. roi_metrics.bump_roi_counters already swallows its
    own failures once it has a session; this also guards session/connection
    setup itself, mirroring _log_gap's own belt-and-suspenders shape."""
    try:
        session_factory = get_sessionmaker()
        async with session_factory() as session:
            await bump_roi_counters(session, org_id, counters)
    except Exception as exc:
        sentry_sdk.capture_exception(exc)


def _resolve_aliased_param(tool: str, new_name: str, new_value, old_name: str, old_value):
    """Backward compat for a tool param an MCP client might still be
    sending under its pre-rename name (`action`/`id` on this surface) —
    an AI agent calling this tool can't "read the release notes" and
    adapt the way a human dev would, so the old name has to keep working,
    not just warn. Prefers `new_value` when both are given. Emits a soft
    deprecation notice on the same print-to-stdout mechanism _log_mcp_call
    uses, so old-name usage shows up in the usage stream without failing
    the call."""
    if new_value is not None:
        if old_value is not None:
            print(json.dumps({"event": "mcp_deprecated_param", "tool": tool, "old_param": old_name, "new_param": new_name, "note": "both given, new value used"}))
        return new_value
    if old_value is not None:
        print(json.dumps({"event": "mcp_deprecated_param", "tool": tool, "old_param": old_name, "new_param": new_name}))
    return old_value


async def _enforce_mcp_rate_limit(tool: str, org_id: str, key_id: str, start: float) -> None:
    settings = get_settings()
    within_budget = await check_sliding_window_rate_limit(
        f"mcp_serving_rate_limit:{key_id}",
        settings.mcp_rate_limit_per_key,
        settings.mcp_rate_limit_window_seconds,
    )
    if not within_budget:
        _log_mcp_call(tool, org_id, start, {"error": "rate limited"}, status="rejected")
        raise RuntimeError(
            f"rate limit exceeded for this API key "
            f"({settings.mcp_rate_limit_per_key}/{settings.mcp_rate_limit_window_seconds}s)"
        )


_RULE_SLUG_PREFIX = "rules/"


def _serialize_rule_for_mcp(rule: dict) -> dict:
    """rule is apps/store's RulePage/ScoredRule JSON shape (camelCase) —
    real rules live in the git-native store (see store_client.py), not
    this API's own Postgres. Maps it onto the MCP tools' existing output
    contract, unchanged from when this read a local Rule table, so no
    calling agent sees a breaking shape change."""
    out = {
        "id": rule["slug"].removeprefix(_RULE_SLUG_PREFIX),
        "title": rule["title"],
        "body": rule["body"],
        "confidence": rule["confidence"],
        # Confidence is a model-assigned score set
        # once at creation time (routers/rules.py's CreateRuleRequest),
        # never independently checked against reality. Labeled explicitly,
        # same convention as freshness's own "estimate" field below,
        # rather than left to read as a verified measurement.
        "confidence_estimate": True,
        "tags": rule["tags"],
        # Compact provenance footer, not the full audit trail — who
        # approved it, when, and what it was cited from.
        "provenance": {
            "approved_by": rule["approvedBy"],
            "approved_at": rule["approvedAt"],
            "sources": rule["sourceCitations"],
        },
        # Computed live off approvedAt/lastValidatedAt (never a value read
        # back from the nightly rule_staleness snapshot), so this is always
        # exactly as current as the rule itself, not up to a day behind.
        # Every field here is explicitly an estimate (see confidence_estimate
        # above) — decay_lambda is an admitted first-pass guess, never
        # presented as a verified fact.
        "freshness": rule_freshness(rule),
    }
    if "similarity" in rule:
        out["similarity"] = rule["similarity"]
    return out


@mcp.tool()
async def search_rules(query: str, tags: list[str] | None = None, limit: int = 10) -> list[dict]:
    """Semantic search over this org's approved, human-reviewed rules,
    optionally filtered to rules carrying any of the given tags. Only
    status == 'approved' rules are ever returned — draft, in_review,
    and deprecated rules are never exposed to a calling agent.

    An empty list is the unambiguous "no approved rule covers this query"
    signal — every returned hit already cleared the relevance threshold, so
    there's no separate "found something, but it's thin" case to represent.
    That gap is logged for the org (see `gnt gaps`)."""
    org_id = require_org_id()
    key_id = require_key_id()
    start = time.monotonic()
    await _enforce_mcp_rate_limit("search_rules", org_id, key_id, start)

    settings = get_settings()
    limit = max(1, min(limit, settings.search_rules_result_limit))
    threshold = settings.search_rules_similarity_threshold

    try:
        # The store's /search doesn't take a tags filter or a custom limit
        # (it always returns its own top-25 nearest neighbors) — apply
        # both here instead of pushing them down. "any of these tags"
        # matches the old jsonb `?|` semantics exactly.
        scored = await store_search_rules(org_id, query)
        hits = [
            _serialize_rule_for_mcp(rule)
            for rule in scored
            if rule["similarity"] >= threshold and (not tags or set(tags) & set(rule["tags"]))
        ][:limit]
    except Exception:
        _log_mcp_call("search_rules", org_id, start, {"error": "failed"}, status="failed")
        raise

    _log_mcp_call("search_rules", org_id, start, hits)
    if hits:
        # "rules served" counts individual rule
        # objects actually handed back to a calling agent, not MCP calls
        # made, so a 3-hit search counts as 3 served, same as three
        # separate get_rule calls would.
        await _bump_roi(org_id, {"rules_served": len(hits)})
    else:
        await _log_gap("search_rules", org_id, query)
    return hits


@mcp.tool()
async def get_rule(rule_id: str | None = None, id: str | None = None) -> dict:
    """Fetch a single approved rule by id, with its provenance footer.
    Raises if the rule doesn't exist, isn't approved, or belongs to a
    different org — never leaks which of those is true.

    Accepts the pre-rename `id` param name too, for callers not yet
    updated to `rule_id` — `rule_id` wins if both are given."""
    rule_id = _resolve_aliased_param("get_rule", "rule_id", rule_id, "id", id)
    org_id = require_org_id()
    key_id = require_key_id()
    start = time.monotonic()
    await _enforce_mcp_rate_limit("get_rule", org_id, key_id, start)

    valid_id = rule_id is not None
    if valid_id:
        try:
            uuid.UUID(rule_id)
        except ValueError:
            valid_id = False

    if not valid_id:
        _log_mcp_call("get_rule", org_id, start, {"error": "no approved rule with that id"}, status="failed")
        raise RuntimeError("no approved rule with that id")

    # store_get_rule's own org scoping (see store_client.py/GntStore.getPage)
    # is the real cross-org isolation boundary here — the status check below
    # is defense in depth, not the only thing standing between orgs.
    rule = await store_get_rule(org_id, f"{_RULE_SLUG_PREFIX}{rule_id}")
    if rule is None or rule["status"] != "approved":
        _log_mcp_call("get_rule", org_id, start, {"error": "no approved rule with that id"}, status="failed")
        raise RuntimeError("no approved rule with that id")

    result = _serialize_rule_for_mcp(rule)
    # Only a real rule handed back counts as
    # "served"; this branch is the sole path that reaches here (the
    # invalid-id and not-found/not-approved cases above both raise
    # instead), so this only runs on the actual hit.
    await _bump_roi(org_id, {"rules_served": 1})

    _log_mcp_call("get_rule", org_id, start, result)
    return result


@mcp.tool()
async def check_action(
    description: str | None = None, context: str | None = None, action: str | None = None
) -> dict:
    """Check whether a described action complies with this org's approved,
    human-reviewed rules BEFORE the agent takes it. Returns a verdict —
    'allowed', 'blocked', or 'needs_human' — with the specific rule(s) cited
    and a one-line reason.

    Call this before any side-effectful or hard-to-reverse action (sending a
    message, issuing a refund, deleting data, spending money). Treat 'blocked'
    as a stop, and 'needs_human' as "escalate, don't proceed on your own".

    Conservative by design: if no approved rule covers the action, retrieval
    fails, or the check can't be completed, the verdict is 'needs_human' — it
    never guesses 'allowed' or 'blocked'. When needs_human happens specifically
    because no approved rule covers the action, the response's `no_coverage`
    field is true and that gap is logged for the org (see `gnt gaps`).

    Accepts the pre-rename `action` param name too, for callers not yet
    updated to `description` — `description` wins if both are given."""
    description = _resolve_aliased_param("check_action", "description", description, "action", action)
    if description is None:
        raise RuntimeError("check_action requires 'description' (or the deprecated 'action' alias)")
    org_id = require_org_id()
    key_id = require_key_id()
    start = time.monotonic()
    await _enforce_mcp_rate_limit("check_action", org_id, key_id, start)

    # evaluate_action degrades every expected failure to needs_human itself;
    # this guard only catches a truly unexpected error, and fails closed (an
    # error to the caller, never a fabricated allowed/blocked).
    try:
        result = await evaluate_action(org_id, description, context)
    except Exception:
        _log_mcp_call("check_action", org_id, start, {"error": "failed"}, status="failed")
        raise

    _log_mcp_call(
        "check_action",
        org_id,
        start,
        result,
        extra={
            "verdict": result["verdict"],
            "cited_rule_ids": [r["id"] for r in result["cited_rules"]],
            "rules_retrieved": result["rules_retrieved"],
            "no_coverage": result.get("no_coverage", False),
        },
    )
    if result["verdict"] == "needs_human" and result.get("no_coverage"):
        await _log_gap("check_action", org_id, description)

    # actions_checked counts every completed check
    # (evaluate_action returned normally, whatever the verdict); blocked and
    # needs_human — the two verdicts worth metering separately —
    # each get their own additional counter on top of that,
    # bumped together in one upsert (see roi_metrics.bump_roi_counters).
    # 'allowed' has no counter of its own: recoverable later as
    # actions_checked minus the other two, if that split ever matters.
    roi_counters = {"actions_checked": 1}
    if result["verdict"] == "blocked":
        roi_counters["actions_blocked"] = 1
    elif result["verdict"] == "needs_human":
        roi_counters["actions_needs_human"] = 1
    await _bump_roi(org_id, roi_counters)

    return result


@mcp.tool()
async def list_skill_packs() -> list[dict]:
    """List every compiled skill pack version for this org, newest first."""
    org_id = require_org_id()
    key_id = require_key_id()
    start = time.monotonic()
    await _enforce_mcp_rate_limit("list_skill_packs", org_id, key_id, start)

    session_factory = get_sessionmaker()
    async with session_factory() as session:
        await scope_to_org(session, org_id)
        result = await session.execute(
            select(SkillPack).where(SkillPack.org_id == org_id).order_by(SkillPack.version.desc())
        )
        packs = [
            {"id": str(p.id), "version": p.version, "created_at": p.created_at.isoformat()}
            for p in result.scalars().all()
        ]

    _log_mcp_call("list_skill_packs", org_id, start, packs)
    return packs


@mcp.tool()
async def get_skill_pack(pack_id: str) -> dict:
    """Fetch a compiled skill pack's manifest and file list (paths +
    hashes, not full file content) by id."""
    org_id = require_org_id()
    key_id = require_key_id()
    start = time.monotonic()
    await _enforce_mcp_rate_limit("get_skill_pack", org_id, key_id, start)

    try:
        pack_uuid = uuid.UUID(pack_id)
    except ValueError:
        result = {"error": "no skill pack with that id"}
        _log_mcp_call("get_skill_pack", org_id, start, result)
        return result

    session_factory = get_sessionmaker()
    async with session_factory() as session:
        await scope_to_org(session, org_id)
        pack = await session.get(SkillPack, pack_uuid)
        if pack is None or pack.org_id != org_id:
            result = {"error": "no skill pack with that id"}
        else:
            files = (
                await session.execute(
                    select(SkillFile.path, SkillFile.sha256).where(SkillFile.pack_id == pack.id)
                )
            ).all()
            result = {
                "id": str(pack.id),
                "version": pack.version,
                "created_at": pack.created_at.isoformat(),
                "manifest": pack.manifest,
                "files": [{"path": path, "sha256": sha256} for path, sha256 in files],
            }

    _log_mcp_call("get_skill_pack", org_id, start, result)
    return result
