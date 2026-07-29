"""Async client for apps/store's internal HTTP API — the only way this
backend talks to the engine-backed seam. Every call
carries the shared bearer token; approving a rule additionally needs a
signature computed with approval_signing_secret (see approval.py), which
this client passes through rather than computes — the caller decides
whether a write is legitimately an approval.
"""

from typing import Any, Literal
from urllib.parse import quote

import httpx

from gnt.config import get_settings


class StoreClientError(Exception):
    """Raised for anything other than a clean 2xx/404 from the store API —
    callers should not need to know this is HTTP underneath."""


class ApprovalRejected(Exception):
    """The store's approval gate refused the write (missing/invalid
    signature) — a 403. Distinct from StoreClientError so callers can
    tell "the approval gate said no" apart from "the store is broken"."""


def _client() -> httpx.AsyncClient:
    settings = get_settings()
    return httpx.AsyncClient(
        base_url=settings.store_api_url,
        timeout=settings.store_http_timeout_seconds,
        headers={"Authorization": f"Bearer {settings.store_internal_api_secret}"},
    )


async def put_rule(rule: dict[str, Any], *, approval_signature: str | None = None) -> str:
    """Returns the slug. Raises ApprovalRejected on a 403 (the approval
    gate refusing an approved-status write), StoreClientError on anything
    else that isn't a clean 200."""
    async with _client() as client:
        response = await client.post(
            "/rules", json={"rule": rule, "approvalSignature": approval_signature}
        )
    if response.status_code == 403:
        raise ApprovalRejected(response.json().get("error", "approval rejected"))
    if response.status_code != 200:
        raise StoreClientError(f"put_rule failed: {response.status_code} {response.text}")
    return response.json()["slug"]


async def get_rule(org_id: str, slug: str) -> dict[str, Any] | None:
    # slug is itself "rules/<id>" (a slash-containing path segment) — must
    # be percent-encoded (matching the TS side's encodeURIComponent, which
    # encodes "/" too) so the server's single decodeURIComponent recovers
    # the exact original slug, not a coincidentally-matching double prefix.
    async with _client() as client:
        response = await client.get(f"/rules/{quote(slug, safe='')}", params={"org": org_id})
    if response.status_code == 404:
        return None
    if response.status_code != 200:
        raise StoreClientError(f"get_rule failed: {response.status_code} {response.text}")
    return response.json()


async def list_rules(org_id: str, *, status: str | None = None) -> list[dict[str, Any]]:
    params: dict[str, str] = {"org": org_id}
    if status is not None:
        params["status"] = status
    async with _client() as client:
        response = await client.get("/rules", params=params)
    if response.status_code != 200:
        raise StoreClientError(f"list_rules failed: {response.status_code} {response.text}")
    return response.json()


async def search_rules(org_id: str, query: str) -> list[dict[str, Any]]:
    async with _client() as client:
        response = await client.post(
            "/search", json={"query": query, "orgId": org_id, "status": "approved"}
        )
    if response.status_code != 200:
        raise StoreClientError(f"search_rules failed: {response.status_code} {response.text}")
    return response.json()


async def append_audit(
    *,
    org_id: str,
    rule_slug: str,
    actor_id: str,
    action: Literal[
        "created",
        "submitted",
        "proposed",
        "approved",
        "rejected",
        "deprecated",
        # The server-side privacy gate's own audit entry,
        # written by create_draft_rule when the webhook ingestion path
        # (routers/webhooks.py) masks PII/secrets before storing a rule.
        # See gnt.pipeline.privacy_gate/redaction_record.py.
        "privacy_gate_masked",
    ],
    before: dict[str, Any] | None,
    after: dict[str, Any],
) -> None:
    async with _client() as client:
        response = await client.post(
            "/audit",
            json={
                "org": org_id,
                "ruleSlug": rule_slug,
                "actorId": actor_id,
                "action": action,
                "before": before,
                "after": after,
            },
        )
    if response.status_code != 200:
        raise StoreClientError(f"append_audit failed: {response.status_code} {response.text}")


async def get_audit_trail(org_id: str, rule_slug: str) -> list[dict[str, Any]]:
    """Oldest first — see apps/store's NativeStore.getAuditTrail."""
    async with _client() as client:
        response = await client.get(f"/audit/{quote(rule_slug, safe='')}", params={"org": org_id})
    if response.status_code != 200:
        raise StoreClientError(f"get_audit_trail failed: {response.status_code} {response.text}")
    return response.json()


async def list_rules_by_pr(org_id: str, pr_number: int) -> list[dict[str, Any]]:
    """Looks up every pending_merge rule an open PR belongs to — the
    webhook handler's entry point for turning a merge event into one or
    more approvals. Plural because batch-propose can put
    several rules on the same PR (same prNumber); an empty list is the
    ordinary "gnt doesn't recognize this merged PR" case (an unrelated PR,
    or a PR whose rule(s) already moved past pending_merge), not an error —
    the store always answers 200 here, never 404."""
    async with _client() as client:
        response = await client.get(f"/rules/by-pr/{pr_number}", params={"org": org_id})
    if response.status_code != 200:
        raise StoreClientError(f"list_rules_by_pr failed: {response.status_code} {response.text}")
    return response.json()


async def register_github_source(org_id: str, repo_url: str, pat: str) -> None:
    """Clones (or pulls) the org's connected repo with apps/store's own
    auth and registers the local clone as the org's engine source. Called
    once at connect time (gnt connect github) so the source exists and is
    reachable before the first sync ever needs it."""
    async with _client() as client:
        response = await client.post(
            "/sources", json={"org": org_id, "repoUrl": repo_url, "pat": pat}
        )
    if response.status_code != 200:
        raise StoreClientError(f"register_github_source failed: {response.status_code} {response.text}")


async def sync_github_source(org_id: str, repo_url: str, pat: str) -> dict[str, Any]:
    """Pulls the org's repo fresh and imports whatever changed — called
    right after the webhook confirms a merge, so approved content is
    searchable within seconds instead of waiting on a cron."""
    async with _client() as client:
        response = await client.post("/sync", json={"org": org_id, "repoUrl": repo_url, "pat": pat})
    if response.status_code != 200:
        raise StoreClientError(f"sync_github_source failed: {response.status_code} {response.text}")
    return response.json()


async def delete_org_source(org_id: str) -> dict[str, Any]:
    """Hard-deletes this org's entire
    rules mirror (every page/chunk/embedding under its engine source).
    Irreversible; no confirmation flag on this call itself — the
    confirmation gate lives one layer up, in routers/org_admin.py's
    two-step request/confirm flow. Returns {"pagesDeleted": int}, 0 if the
    org never wrote a rule (no store-side source ever existed for it) —
    that is a legitimate empty-result case for offboarding, not an error."""
    async with _client() as client:
        response = await client.post("/sources/delete", json={"org": org_id})
    if response.status_code != 200:
        raise StoreClientError(f"delete_org_source failed: {response.status_code} {response.text}")
    return response.json()
