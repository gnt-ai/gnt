"""The /brain slash command, revived to create draft rules instead of
returning the retired-stub message. Covers: a non-empty `text` creates a
real draft rule through the same create_draft_rule() every other
draft-rule front door shares, with the server-side privacy gate applied
exactly like routers/webhooks.py's ingest_webhook — proven with a real
PII payload masked end to end, not just that the gate function runs in
isolation. Empty/whitespace-only text is a no-op (the usage message, no
rule created). Tenant isolation: a workspace's command can only ever
create a rule visible to the org that workspace is connected to.
Signature verification and the unknown-workspace branch are covered
directly too, since no test file for this router existed before now.
"""

import hashlib
import hmac
import re
import time
import uuid
from urllib.parse import urlencode

import pytest
from httpx import ASGITransport, AsyncClient

from gnt.config import get_settings
from gnt.db.models import SlackConnection
from gnt.db.org import ensure_org
from gnt.db.rls import scope_to_org
from gnt.store_client import get_audit_trail
from gnt.store_client import get_rule as store_get_rule
from gnt.store_client import list_rules as store_list_rules

_RULE_ID_RE = re.compile(r"`([0-9a-fA-F-]{36})`")


@pytest.fixture
def slack_routers():
    from gnt.routers import slack as slack_router

    return [slack_router.router]


def _sign(form: dict[str, str]) -> tuple[bytes, str, str]:
    """Builds a real, currently-valid Slack request signature the same way
    gnt.slack.signature.verify_slack_request checks one — HMAC-SHA256 over
    "v0:<timestamp>:<raw body>" keyed on the app's signing secret. Mirrors
    the wire format a real Slack slash command POST uses: a url-encoded
    form body, not JSON."""
    raw_body = urlencode(form).encode("utf-8")
    timestamp = str(int(time.time()))
    basestring = b"v0:" + timestamp.encode("utf-8") + b":" + raw_body
    digest = hmac.new(
        get_settings().slack_signing_secret.encode("utf-8"), basestring, hashlib.sha256
    ).hexdigest()
    return raw_body, timestamp, f"v0={digest}"


async def _post_command(app_factory, slack_routers, form: dict[str, str]):
    app = app_factory(slack_routers)
    raw_body, timestamp, signature = _sign(form)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        return await client.post(
            "/v1/slack/command",
            content=raw_body,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "X-Slack-Request-Timestamp": timestamp,
                "X-Slack-Signature": signature,
            },
        )


async def _connect_workspace(db_session, org_id: str) -> str:
    """Inserts a SlackConnection row directly (no OAuth flow to drive in a
    test) — same seeding convention test_org_offboarding.py's
    _seed_full_org uses for this exact table. Returns the team_id the
    slash command payload should send as team_id to resolve back to
    org_id."""
    from gnt.slack.crypto import encrypt_token

    team_id = f"T{uuid.uuid4().hex[:10]}"
    await ensure_org(db_session, org_id)
    await db_session.commit()
    await scope_to_org(db_session, org_id)
    db_session.add(
        SlackConnection(
            org_id=org_id,
            team_id=team_id,
            team_name="Test Workspace",
            bot_user_id="U0TESTBOT",
            bot_token_encrypted=encrypt_token("fake-bot-token"),
            scope="commands,chat:write",
            installed_by_user_id="U0INSTALLER",
        )
    )
    await db_session.commit()
    return team_id


def _extract_rule_id(text: str) -> str:
    match = _RULE_ID_RE.search(text)
    assert match, f"no rule id found in response text: {text!r}"
    return match.group(1)


def test_split_command_text_single_line_uses_full_text_as_both_title_and_body():
    from gnt.routers.slack import _split_command_text

    title, body = _split_command_text("Refunds over 15% require manager sign-off.")
    assert title == "Refunds over 15% require manager sign-off."
    assert body == "Refunds over 15% require manager sign-off."


def test_split_command_text_multiline_promotes_first_line_to_title():
    from gnt.routers.slack import _split_command_text

    title, body = _split_command_text("Refund window shortened\nOnly 14 days now, not 30.")
    assert title == "Refund window shortened"
    assert body == "Only 14 days now, not 30."


def test_split_command_text_truncates_an_overlong_title():
    from gnt.routers.slack import _split_command_text

    title, _ = _split_command_text("x" * 250)
    assert len(title) == 200
    assert title.endswith("...")


async def test_slash_command_creates_a_draft_rule(test_app_factory, db_session, slack_routers):
    org_id = f"org_test_{uuid.uuid4().hex[:8]}"
    team_id = await _connect_workspace(db_session, org_id)

    r = await _post_command(
        test_app_factory,
        slack_routers,
        {
            "team_id": team_id,
            "user_id": "U0AUTHOR",
            "channel_name": "eng-decisions",
            "command": "/brain",
            "text": "Refunds within 30 days get a full refund, no manager approval needed.",
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["response_type"] == "ephemeral"
    assert "Draft rule created" in body["text"]
    assert "gnt review" in body["text"]

    rule_id = _extract_rule_id(body["text"])
    rule = await store_get_rule(org_id, f"rules/{rule_id}")
    assert rule is not None
    assert rule["status"] == "draft"
    assert rule["ownerId"] == "slack:U0AUTHOR"
    assert rule["body"] == "Refunds within 30 days get a full refund, no manager approval needed."
    assert rule["title"] == "Refunds within 30 days get a full refund, no manager approval needed."
    assert rule["source"] == "Slack /brain in #eng-decisions"


async def test_slash_command_splits_first_line_as_title_when_multiline(
    test_app_factory, db_session, slack_routers
):
    """The multi-line branch of _split_command_text: a message composed
    with shift-enter before sending gets its first line promoted to the
    title, git-commit-message style, with the full text still preserved
    as the body."""
    org_id = f"org_test_{uuid.uuid4().hex[:8]}"
    team_id = await _connect_workspace(db_session, org_id)

    r = await _post_command(
        test_app_factory,
        slack_routers,
        {
            "team_id": team_id,
            "user_id": "U0AUTHOR",
            "text": "Refund window shortened\nEffective next sprint, refunds are only honored within 14 days, not 30.",
        },
    )
    assert r.status_code == 200
    rule_id = _extract_rule_id(r.json()["text"])
    rule = await store_get_rule(org_id, f"rules/{rule_id}")
    assert rule["title"] == "Refund window shortened"
    assert rule["body"] == "Effective next sprint, refunds are only honored within 14 days, not 30."


async def test_slash_command_with_empty_text_does_not_create_a_rule(
    test_app_factory, db_session, slack_routers
):
    org_id = f"org_test_{uuid.uuid4().hex[:8]}"
    team_id = await _connect_workspace(db_session, org_id)

    before = await store_list_rules(org_id, status="draft")

    r = await _post_command(test_app_factory, slack_routers, {"team_id": team_id})
    assert r.status_code == 200
    assert "Usage:" in r.json()["text"]
    assert "/brain" in r.json()["text"]

    r_whitespace = await _post_command(
        test_app_factory, slack_routers, {"team_id": team_id, "text": "   "}
    )
    assert r_whitespace.status_code == 200
    assert "Usage:" in r_whitespace.json()["text"]

    after = await store_list_rules(org_id, status="draft")
    assert len(after) == len(before)


async def test_slash_command_rejects_bad_signature(test_app_factory, slack_routers):
    app = test_app_factory(slack_routers)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        r = await client.post(
            "/v1/slack/command",
            content=urlencode({"team_id": "T123", "text": "hello"}).encode("utf-8"),
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "X-Slack-Request-Timestamp": str(int(time.time())),
                "X-Slack-Signature": "v0=not-a-real-signature",
            },
        )
    assert r.status_code == 401
    assert r.json()["text"] == "Signature check failed."


async def test_slash_command_unknown_workspace_does_not_create_a_rule(
    test_app_factory, slack_routers
):
    r = await _post_command(
        test_app_factory,
        slack_routers,
        {"team_id": f"T{uuid.uuid4().hex[:10]}", "text": "some decision worth capturing"},
    )
    assert r.status_code == 200
    assert "isn't connected" in r.json()["text"]


async def test_slash_command_is_isolated_to_its_own_org(
    test_app_factory, db_session, slack_routers
):
    """A workspace connected to org A must never let a rule land in org
    B, even though nothing in the slash command payload itself names an
    org — team_id -> SlackConnection.org_id is the only org signal this
    endpoint has, same non-negotiable test_ingest_is_isolated_to_its_own_org
    proves for the webhook path."""
    org_id_a = f"org_test_{uuid.uuid4().hex[:8]}"
    org_id_b = f"org_test_{uuid.uuid4().hex[:8]}"
    team_id_a = await _connect_workspace(db_session, org_id_a)

    r = await _post_command(
        test_app_factory,
        slack_routers,
        {"team_id": team_id_a, "user_id": "U0AUTHOR", "text": "Org A only decision."},
    )
    assert r.status_code == 200
    rule_id = _extract_rule_id(r.json()["text"])

    assert await store_get_rule(org_id_a, f"rules/{rule_id}") is not None
    assert await store_get_rule(org_id_b, f"rules/{rule_id}") is None


async def test_slash_command_status_reports_the_linked_org_without_creating_a_rule(
    test_app_factory, db_session, slack_routers
):
    """`/brain status` — the read-only health check this task adds. Must
    confirm the org the workspace is linked to and must not create a rule:
    same "before/after count is unchanged" proof the empty-text test above
    uses for its own zero-write claim."""
    org_id = f"org_test_{uuid.uuid4().hex[:8]}"
    team_id = await _connect_workspace(db_session, org_id)

    before = await store_list_rules(org_id, status="draft")

    r = await _post_command(
        test_app_factory, slack_routers, {"team_id": team_id, "text": "status"}
    )
    assert r.status_code == 200
    body = r.json()["text"]
    assert "Connected" in body
    assert "Test Workspace" in body
    assert org_id in body
    assert "ingested via Slack this month" in body

    after = await store_list_rules(org_id, status="draft")
    assert len(after) == len(before)


async def test_slash_command_status_on_an_unconnected_workspace_does_not_create_a_rule(
    test_app_factory, slack_routers
):
    """The "not linked to any org" path: a workspace that never went
    through OAuth gets the same "isn't connected" message for `/brain
    status` as it does for any other text, since there is no org to
    report status for — same branch
    test_slash_command_unknown_workspace_does_not_create_a_rule exercises
    for plain capture text."""
    r = await _post_command(
        test_app_factory,
        slack_routers,
        {"team_id": f"T{uuid.uuid4().hex[:10]}", "text": "status"},
    )
    assert r.status_code == 200
    assert "isn't connected" in r.json()["text"]


async def test_slash_command_help_and_bare_text_return_the_same_usage_message(
    test_app_factory, db_session, slack_routers
):
    org_id = f"org_test_{uuid.uuid4().hex[:8]}"
    team_id = await _connect_workspace(db_session, org_id)

    r_help = await _post_command(
        test_app_factory, slack_routers, {"team_id": team_id, "text": "help"}
    )
    r_bare = await _post_command(test_app_factory, slack_routers, {"team_id": team_id})
    assert r_help.json()["text"] == r_bare.json()["text"]
    assert "/brain status" in r_help.json()["text"]


async def test_slash_command_masks_a_real_email_end_to_end(
    test_app_factory, db_session, slack_routers
):
    """The server-side privacy gate applies here exactly like it does on
    the webhook ingest path — a Slack message is the same kind of ambient
    third-party content the gate exists for. Proven with a real detector
    hit, not just that apply_privacy_gate=True is passed."""
    org_id = f"org_test_{uuid.uuid4().hex[:8]}"
    team_id = await _connect_workspace(db_session, org_id)

    r = await _post_command(
        test_app_factory,
        slack_routers,
        {
            "team_id": team_id,
            "user_id": "U0AUTHOR",
            "text": "Escalate refund questions to jane.doe@acme.com directly.",
        },
    )
    assert r.status_code == 200
    rule_id = _extract_rule_id(r.json()["text"])
    rule = await store_get_rule(org_id, f"rules/{rule_id}")
    assert "jane.doe@acme.com" not in rule["body"]
    assert "[EMAIL_1]" in rule["body"]

    trail = await get_audit_trail(org_id, f"rules/{rule_id}")
    masked_entries = [entry for entry in trail if entry["action"] == "privacy_gate_masked"]
    assert len(masked_entries) == 1
    # 2, not 1 — a single-line command (no title/body split available, see
    # _split_command_text) reuses the same text for both title and body,
    # so the one real email in the source text is hit once per field.
    assert masked_entries[0]["after"]["kind_counts"].get("EMAIL") == 2
