from datetime import datetime, timezone
from urllib.parse import parse_qsl

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.auth.better_auth import OrgContext, get_current_org
from gnt.config import get_settings
from gnt.db.models import SlackConnection
from gnt.db.org import ensure_org
from gnt.db.rls import scope_to_org
from gnt.db.session import get_session
from gnt.onboarding_metrics import log_onboarding_event
from gnt.routers.rules import CreateRuleRequest, _bare_id, create_draft_rule
from gnt.slack.crypto import encrypt_token
from gnt.slack.oauth import SlackOAuthError, build_authorize_url, exchange_code, verify_state
from gnt.slack.signature import verify_slack_request
from gnt.store_client import StoreClientError
from gnt.store_client import list_rules as store_list_rules

router = APIRouter(prefix="/v1/slack", tags=["slack"])


def _plain_page(message: str) -> HTMLResponse:
    """A bare confirmation/error page for the CLI's connect-slack flow — it
    never reads this page's content (it polls /v1/brain/summary directly,
    see apps/cli/src/commands/connect-slack.ts), so this only needs to be
    legible to the human sitting in front of the browser tab. Deliberately
    not a redirect into apps/web: the CLI flow has no dependency on the
    dashboard existing at all."""
    return HTMLResponse(
        f"<!doctype html><html><head><meta charset=\"utf-8\"><title>gnt.ai</title></head>"
        f"<body style=\"font-family: system-ui, sans-serif; padding: 3rem; text-align: center;\">"
        f"<p>{message}</p><p>You can close this tab.</p></body></html>"
    )


@router.get("/install-url")
async def install_url(
    org: OrgContext = Depends(get_current_org),
    session: AsyncSession = Depends(get_session),
    origin: str = "web",
):
    await ensure_org(session, org.org_id)
    return {"url": build_authorize_url(org.org_id, origin=origin)}


@router.get("/oauth/callback")
async def oauth_callback(
    session: AsyncSession = Depends(get_session),
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
):
    # Origin isn't known until the state is verified, so an early failure
    # (missing code/state, or a state that fails to verify) has nowhere
    # trustworthy to redirect a CLI-originated flow back to — a bare error
    # page is a safe default either way, and doesn't assume the dashboard
    # exists (the CLI flow never depends on it, see _plain_page above).
    if error or not code or not state:
        return _plain_page("Slack connection failed — run the connect command again.")

    try:
        slack_state = verify_state(state)
        result = await exchange_code(code)
    except SlackOAuthError:
        return _plain_page("Slack connection failed — run the connect command again.")

    org_id = slack_state.org_id
    await scope_to_org(session, org_id)
    await ensure_org(session, org_id)
    encrypted_token = encrypt_token(result.bot_token)
    stmt = (
        insert(SlackConnection)
        .values(
            org_id=org_id,
            team_id=result.team_id,
            team_name=result.team_name,
            bot_user_id=result.bot_user_id,
            bot_token_encrypted=encrypted_token,
            scope=result.scope,
            installed_by_user_id=result.authed_user_id,
        )
        .on_conflict_do_update(
            index_elements=["org_id"],
            set_={
                "team_id": result.team_id,
                "team_name": result.team_name,
                "bot_user_id": result.bot_user_id,
                "bot_token_encrypted": encrypted_token,
                "scope": result.scope,
                "installed_by_user_id": result.authed_user_id,
            },
        )
    )
    await session.execute(stmt)
    await session.commit()
    await log_onboarding_event(session, org_id, "slack_connected")

    if slack_state.origin == "cli":
        return _plain_page("Slack connected.")
    return RedirectResponse(f"{get_settings().web_origin}/app?slack=connected")


def _split_command_text(text: str) -> tuple[str, str]:
    """Turns `/brain`'s freeform `text` into the (title, body) pair
    CreateRuleRequest needs. This is a manually typed Slack message, not a
    document to extract structure from, so no LLM pass here — a plain
    heuristic is enough:

    - If the text spans more than one line (someone shift-entered a
      multi-line message before sending), the first line becomes the
      title and everything after it becomes the body — the same
      first-line-is-the-summary convention a git commit message uses.
    - Otherwise (the common case: one line typed straight into the
      command box), there is no separate summary line to promote, so the
      title is just the text itself.

    Either way `body` always ends up holding the complete original text
    (never just a truncated first line), and `title` is capped at
    CreateRuleRequest's own 200-char limit — truncated with an ellipsis
    rather than left to fail Pydantic validation with a 422 the Slack
    caller can't see the reason for."""
    stripped = text.strip()
    first_line, _, rest = stripped.partition("\n")
    rest = rest.strip()
    title = first_line.strip() if rest else stripped
    body = rest if rest else stripped
    if len(title) > 200:
        title = title[:197].rstrip() + "..."
    return title, body


_USAGE_TEXT = (
    "Usage: `/brain <what you want to capture>`. Turns a decision you just made "
    "into a draft rule, then run `gnt review` to propose (open a PR) or reject it.\n"
    "`/brain status` checks the connection without creating anything."
)


async def _status_text(connection: SlackConnection) -> str:
    """Read-only health line for `/brain status` — no ensure_org call and
    no session write, just the SlackConnection row the caller already
    looked up plus a plain GET through store_client.list_rules (the same
    read-only call org_offboarding.py already makes for a full-org rules
    export, so this adds no new query shape). Best-effort on the rule
    count: a store hiccup still confirms the workspace is linked, it just
    drops the count line rather than failing the whole health check —
    same allSettled-style degradation apps/cli's `gnt status` uses for
    its own best-effort sections."""
    header = f"Connected: Slack workspace *{connection.team_name}* is linked to GNT org `{connection.org_id}`."
    try:
        rules = await store_list_rules(connection.org_id)
    except StoreClientError:
        return header
    month_prefix = datetime.now(timezone.utc).strftime("%Y-%m")
    count = sum(
        1
        for rule in rules
        if (rule.get("source") or "").startswith("Slack") and (rule.get("createdAt") or "").startswith(month_prefix)
    )
    return f"{header}\n{count} rule{'s' if count != 1 else ''} ingested via Slack this month."


@router.post("/command")
async def slash_command(
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """`/brain <what you want to capture>` — retargeted at proposing rules,
    replacing the retired knowledge-unit capture pipeline (triage/extract/
    embed) it used to feed. `text` is freeform;
    see _split_command_text above for how it becomes a title/body pair.
    The rest goes through create_draft_rule, the exact same function
    POST /v1/rules and routers/webhooks.py's ingest_webhook already share
    — same sanitize/tenant-scoping/draft-ceiling behavior as every other
    draft-rule front door, just reached through a slash command instead.

    Bare `/brain`, `/brain help`, and `/brain status` are the three
    read-only, zero-write exits from this handler — matched against the
    whole trimmed `text` up front, before anything below touches
    create_draft_rule. No new Slack app manifest entry: this reuses the
    same `/brain` command and slash-command endpoint rather than
    registering a second one, since `/brain` had no subcommand-style
    parsing to preserve compatibility with. `status` exists so a human
    (or someone verifying the integration works at all) has a way to
    check "is this workspace actually linked to an org" without
    polluting real data by ingesting a throwaway policy just to find out.

    apply_privacy_gate=True below is not optional: a
    Slack message is exactly the ambient third-party content the gate
    exists for — someone's words in a channel, not a human deliberately
    typing straight into gnt — see gnt.pipeline.privacy_gate's module
    docstring and create_draft_rule's own docstring for the full
    reasoning, including the masking-is-permanent tradeoff.

    No Slack-specific rate limit added on top of the shared
    max_draft_rules_per_org ceiling create_draft_rule already enforces.
    Deliberate, not an oversight: routers/webhooks.py's per-IP/per-org
    limits exist because a webhook ingest token is a leakable bearer
    credential (anyone who obtains the URL can call it indefinitely, with
    nothing else identifying them), and its per-IP limit specifically
    protects the token-lookup DB hit against a flood of requests carrying
    invalid tokens. Neither threat model applies here: this endpoint is
    only ever reachable through Slack's own signed request (verified
    below, before any DB work runs), the caller-identifying signal is
    Slack's servers relaying a real signed request rather than any one
    IP, and firing this command still requires being a real member of a
    workspace that installed the app, typing it into Slack's own UI — a
    materially higher-friction, more accountable path than POSTing a
    bare URL. The shared draft-rule ceiling is the real backstop for a
    compromised or malicious workspace member spamming `/brain`, same as
    it already is for every other draft-rule front door."""
    raw_body = await request.body()
    timestamp = request.headers.get("X-Slack-Request-Timestamp", "")
    signature = request.headers.get("X-Slack-Signature", "")

    if not verify_slack_request(timestamp, raw_body, signature):
        return JSONResponse({"response_type": "ephemeral", "text": "Signature check failed."}, status_code=401)

    form = dict(parse_qsl(raw_body.decode("utf-8")))
    team_id = form.get("team_id", "")

    # No RLS on slack_connections (see migration) — this lookup has to run
    # across every org's connections to discover which org a given Slack
    # workspace belongs to, the same bootstrapping problem mcp_api_keys has.
    # Slack's own request signature (verified above) is what authenticates
    # this instead.
    connection = (
        await session.execute(select(SlackConnection).where(SlackConnection.team_id == team_id))
    ).scalar_one_or_none()
    if connection is None:
        return JSONResponse(
            {"response_type": "ephemeral", "text": "This workspace isn't connected — reconnect from the dashboard."}
        )

    text = form.get("text", "").strip()
    subcommand = text.lower()
    if not text or subcommand == "help":
        return JSONResponse({"response_type": "ephemeral", "text": _USAGE_TEXT})
    if subcommand == "status":
        return JSONResponse({"response_type": "ephemeral", "text": await _status_text(connection)})

    title, body_text = _split_command_text(text)
    channel_name = form.get("channel_name")
    command_name = form.get("command") or "/brain"
    source = f"Slack {command_name}" + (f" in #{channel_name}" if channel_name else "")

    await ensure_org(session, connection.org_id)
    await session.commit()

    rule = await create_draft_rule(
        connection.org_id,
        f"slack:{form.get('user_id', 'unknown')}",
        CreateRuleRequest(title=title, body=body_text, source=source),
        apply_privacy_gate=True,
    )
    return JSONResponse(
        {
            "response_type": "ephemeral",
            "text": f"Draft rule created (`{_bare_id(rule['slug'])}`). Run `gnt review` to propose "
            "(open a PR) or reject it.",
        }
    )
