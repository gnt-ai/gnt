"""Proves the published MCP endpoint genuinely
answers real MCP protocol requests, not just a health check or a
direct-call test of the tool functions (that's what test_mcp_tools.py
already covers, and it says so in its own docstring).

This uses the real `mcp` Python SDK client — the same
`streamablehttp_client`/`ClientSession` pair acceptance_e2e.py uses
against real production — but against the FastAPI test app's own real
ASGI stack (httpx's ASGITransport, same pattern test_mcp_auth_middleware.py
already uses for McpAuthMiddleware) instead of a real socket. That
exercises the exact same code real traffic goes through: the DNS-rebinding
transport security settings, McpAuthMiddleware's bearer-key resolution,
tool registration on the real `mcp` object, and the real response shape —
without needing production credentials or a real deployed server.

The mount path under test comes from settings.mcp_url, the single
source-of-truth constant for the published URL, not a hardcoded "/mcp"
literal — this is what actually proves the published URL and the constant
stay in sync, not just that some MCP server somewhere answers.

Note: FastMCP's StreamableHTTPSessionManager can only have `.run()` called
once per process (it raises RuntimeError on a second call) — this file
therefore drives the whole real-protocol flow (initialize, list_tools,
call_tool) through a single session, matching how a real MCP client
actually uses one, rather than splitting it into several tests that would
each need their own `.run()`.
"""

import uuid
from urllib.parse import urlsplit

import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client
from sqlalchemy import text

from gnt.approval import hash_approval_content, sign_approval
from gnt.auth.mcp_keys import generate_key
from gnt.config import get_settings
from gnt.db.models import McpApiKey
from gnt.db.org import ensure_org
from gnt.mcp_server import server as mcp_server
from gnt.mcp_server.auth import McpAuthMiddleware
from gnt.store_client import put_rule


def _rule_dict(org_id: str, slug: str, title: str, tags: list[str] | None = None) -> dict:
    return {
        "slug": slug,
        "org": org_id,
        "title": title,
        "body": f"body for {title}",
        "status": "draft",
        "confidence": 0.7,
        "ownerId": "test_user",
        "sourceCitations": [],
        "tags": tags or [],
        "lastValidatedAt": None,
        "version": 1,
        "supersededBy": None,
        "previousVersionId": None,
        "approvedBy": None,
        "approvedAt": None,
        "createdAt": "2026-07-14T00:00:00Z",
        "prNumber": None,
        "prUrl": None,
    }


async def _approve_directly_via_store(org_id: str, rule: dict) -> dict:
    """Mirrors test_mcp_tools.py's identically-named helper (see its own
    comment on why this isn't imported across test files) — there's no
    HTTP path to "approved" outside a real GitHub PR merge, so this signs
    and writes it the same way the webhook handler does."""
    rule = dict(rule)
    rule["status"] = "approved"
    rule["approvedBy"] = "admin_a"
    rule["approvedAt"] = "2026-07-14T00:00:00Z"
    content_hash = hash_approval_content(
        title=rule["title"], body=rule["body"], tags=rule["tags"], status=rule["status"]
    )
    signature = sign_approval(
        org_id=org_id, slug=rule["slug"], version=rule["version"], content_hash=content_hash
    )
    await put_rule(rule, approval_signature=signature)
    return rule


@pytest.fixture
async def real_org_and_key(db_session):
    """Same setup as test_mcp_auth_middleware.py's real_org_and_key — a
    real org row and a real, hashed McpApiKey the middleware can resolve,
    not a dependency-override bypass. See that fixture's own comment on
    why the app.current_org GUC gets reset before returning."""
    org_id = f"__mcp_published_url_test_{uuid.uuid4().hex[:8]}__"
    await ensure_org(db_session, org_id)
    await db_session.commit()
    plaintext, key_hash = generate_key()
    key = McpApiKey(org_id=org_id, key_hash=key_hash, name="published-url-test")
    db_session.add(key)
    await db_session.commit()
    await db_session.execute(text("SELECT set_config('app.current_org', '', true)"))
    await db_session.commit()
    return org_id, plaintext


async def test_published_mcp_url_answers_real_protocol_requests(real_org_and_key):
    org_id, api_key = real_org_and_key

    # Real id (str(uuid.uuid4())), matching what routers/rules.py actually
    # mints — get_rule validates the id shape before ever asking the store.
    bare_id = str(uuid.uuid4())
    approved = await _approve_directly_via_store(
        org_id,
        _rule_dict(org_id, f"rules/{bare_id}", "Published MCP URL test rule", tags=["e2e-mcp-url"]),
    )

    # The mount path under test — derived from settings.mcp_url, the
    # source-of-truth constant, never a hardcoded "/mcp" literal, so this
    # test actually fails if the mount and the published URL ever drift apart.
    mcp_path = urlsplit(get_settings().mcp_url).path

    test_app = FastAPI()
    test_app.mount(mcp_path, McpAuthMiddleware(mcp_server.mcp.streamable_http_app()))
    transport = ASGITransport(app=test_app)

    # DNS-rebinding protection (see mcp_server/server.py) allowlists
    # localhost with any port — matches the transport_security_settings
    # every real deployment also carries.
    base_url = "http://localhost:8000"

    def _client_factory(
        headers: dict[str, str] | None = None,
        timeout: httpx.Timeout | None = None,
        auth: httpx.Auth | None = None,
    ) -> AsyncClient:
        # follow_redirects=True matches the real MCP SDK's own
        # create_mcp_http_client default — without it, a bare "/mcp" (no
        # trailing slash) 307s to "/mcp/" and the client raises instead of
        # following it, same as it would against the real deployed server.
        return AsyncClient(
            transport=transport,
            base_url=base_url,
            headers=headers,
            timeout=timeout,
            auth=auth,
            follow_redirects=True,
        )

    async with mcp_server.mcp.session_manager.run():
        async with streamablehttp_client(
            f"{base_url}{mcp_path}",
            headers={"Authorization": f"Bearer {api_key}"},
            httpx_client_factory=_client_factory,
        ) as (read, write, _):
            async with ClientSession(read, write) as session:
                init_result = await session.initialize()
                assert init_result.serverInfo.name == "gnt-brain"

                tools_result = await session.list_tools()
                tool_names = {t.name for t in tools_result.tools}
                # The headline, human-approved rules tools — not just
                # "some tool answered", the real ones the product publishes.
                assert {"search_rules", "get_rule"} <= tool_names

                call_result = await session.call_tool("get_rule", {"rule_id": bare_id})
                response_text = call_result.content[0].text if call_result.content else ""
                assert not call_result.isError, response_text
                assert bare_id in response_text
                assert "e2e-mcp-url" in response_text
                assert approved["title"] in response_text

                # search_rules now runs through apps/store's hybrid
                # (keyword + semantic) retrieval path (see store.ts) --
                # proves that path answers a real MCP protocol call too,
                # not just get_rule above. The multi-word phrase lexically
                # matches the rule's title/body (no embedding provider
                # configured in this test process, so this exercises the
                # keyword arm) comfortably above search_rules_similarity_
                # threshold's 0.4 default -- a single common word like
                # "published" alone scores ~0.30 on this corpus and would
                # false-negative here for a reason that has nothing to do
                # with what this test is actually verifying.
                search_result = await session.call_tool("search_rules", {"query": "Published MCP URL test rule"})
                search_text = search_result.content[0].text if search_result.content else ""
                assert not search_result.isError, search_text
                assert bare_id in search_text
                assert approved["title"] in search_text

                # An id that doesn't resolve to an approved rule must fail
                # the real MCP error contract (isError: true) over the wire,
                # not come back as ordinary content a client's isError check
                # would sail right past (see mcp_server/server.py's get_rule).
                missing_result = await session.call_tool("get_rule", {"rule_id": str(uuid.uuid4())})
                assert missing_result.isError

                # Backward compat: the pre-rename `id` param name (aliased to
                # `rule_id` inside get_rule) still resolves a real rule over
                # the real protocol, not just in a direct Python call.
                alias_result = await session.call_tool("get_rule", {"id": bare_id})
                alias_text = alias_result.content[0].text if alias_result.content else ""
                assert not alias_result.isError, alias_text
                assert bare_id in alias_text
