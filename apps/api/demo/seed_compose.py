"""Seed and exercise the Docker demo stack.

Run through ``./demo.sh`` rather than directly. This creates one local demo
org, rotates its demo MCP key, writes one approved rule through the store's
real signed-approval gate, then calls the published check_action endpoint.
"""

import asyncio
import json
import os
import uuid
from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import select

from gnt.approval import hash_approval_content, sign_approval
from gnt.auth.mcp_keys import generate_key
from gnt.db.models import McpApiKey, Org
from gnt.db.org import ensure_org
from gnt.db.session import get_sessionmaker
from gnt.store_client import put_rule

DEMO_ORG_ID = "gnt-docker-demo"
DEMO_KEY_NAME = "docker-demo"
DEMO_RULE_ID = "96fd8539-ad08-4f87-8e47-54d190e020cd"
DEMO_DESCRIPTION = "issue a $250 refund to a customer"


def _demo_rule() -> dict:
    now = datetime.now(UTC).isoformat()
    return {
        "slug": f"rules/{DEMO_RULE_ID}",
        "org": DEMO_ORG_ID,
        "title": "Refunds over $100 require human approval",
        "body": (
            "An agent must not issue a $250 refund to a customer. "
            "Any refund over $100 requires approval from a human billing manager."
        ),
        "status": "approved",
        "confidence": 1.0,
        "ownerId": "demo",
        "sourceCitations": [
            {
                "source_type": "demo",
                "source_id": "refund-policy",
                "permalink": "docker-demo/refund-policy.md",
            }
        ],
        "source": "docker-demo/refund-policy.md",
        "tags": ["billing", "refunds"],
        "lastValidatedAt": now,
        "version": 1,
        "supersededBy": None,
        "previousVersionId": None,
        "approvedBy": "docker-demo",
        "approvedAt": now,
        "createdAt": now,
        "prNumber": None,
        "prUrl": None,
    }


def _validate_demo_payload(payload: dict) -> None:
    if payload.get("rules_retrieved", 0) < 1:
        raise RuntimeError(f"the seeded rule was not retrieved: {payload}")
    if not os.environ.get("ANTHROPIC_API_KEY") and payload.get("verdict") != "needs_human":
        raise RuntimeError(f"expected fail-closed needs_human verdict: {payload}")


async def _seed() -> str:
    plaintext, key_hash = generate_key()
    session_factory = get_sessionmaker()
    async with session_factory() as session:
        await ensure_org(session, DEMO_ORG_ID)
        org = await session.get(Org, DEMO_ORG_ID)
        if org is None:
            raise RuntimeError("failed to create the Docker demo organization")
        # Keep repeat runs useful even if an old demo volume outlived its
        # original trial. This is isolated demo data, never a hosted org.
        org.trial_ends_at = datetime.now(UTC) + timedelta(days=14)
        existing = await session.scalar(
            select(McpApiKey).where(
                McpApiKey.org_id == DEMO_ORG_ID,
                McpApiKey.name == DEMO_KEY_NAME,
                McpApiKey.revoked_at.is_(None),
            )
        )
        if existing is None:
            session.add(
                McpApiKey(org_id=DEMO_ORG_ID, key_hash=key_hash, name=DEMO_KEY_NAME)
            )
        else:
            existing.key_hash = key_hash
        await session.commit()

    rule = _demo_rule()
    content_hash = hash_approval_content(
        title=rule["title"], body=rule["body"], tags=rule["tags"], status=rule["status"]
    )
    signature = sign_approval(
        org_id=DEMO_ORG_ID,
        slug=rule["slug"],
        version=rule["version"],
        content_hash=content_hash,
    )
    await put_rule(rule, approval_signature=signature)
    return plaintext


async def _call_check_action(key: str) -> str:
    request = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "check_action",
            "arguments": {"description": DEMO_DESCRIPTION},
        },
    }
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            "http://api:8000/mcp/",
            headers={
                "Authorization": f"Bearer {key}",
                "Accept": "application/json, text/event-stream",
                # Route over the Compose network while presenting the public
                # local origin FastMCP's DNS-rebinding guard allowlists.
                "Host": "localhost:8000",
            },
            json=request,
        )
    response.raise_for_status()
    event = next(
        (
            line.removeprefix("data: ")
            for line in response.text.splitlines()
            if line.startswith("data: ")
        ),
        None,
    )
    if event is None:
        raise RuntimeError(f"check_action returned no SSE data frame: {response.text}")
    envelope = json.loads(event)
    if "result" not in envelope:
        raise RuntimeError(f"check_action returned a JSON-RPC error: {event}")
    payload = json.loads(envelope["result"]["content"][0]["text"])
    _validate_demo_payload(payload)
    return json.dumps(payload, indent=2)


def _curl(key: str) -> str:
    body = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "check_action",
                "arguments": {"description": DEMO_DESCRIPTION},
            },
        },
        separators=(",", ":"),
    )
    return "\n".join(
        [
            "curl -sS http://localhost:8000/mcp/ \\",
            f"  -H 'Authorization: Bearer {key}' \\",
            "  -H 'Accept: application/json, text/event-stream' \\",
            "  -H 'Content-Type: application/json' \\",
            f"  --data '{body}'",
        ]
    )


async def main() -> None:
    # Validate the checked-in id early; get_rule/check_action expose bare UUID
    # ids and a typo here would create demo data that those tools cannot cite.
    uuid.UUID(DEMO_RULE_ID)
    key = await _seed()
    result = await _call_check_action(key)
    print("\nDemo check_action response:\n")
    print(result)
    print("\nRun it again with this ready-to-copy command:\n")
    print(_curl(key))


if __name__ == "__main__":
    asyncio.run(main())
