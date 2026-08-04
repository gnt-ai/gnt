"""Zendesk REST API adapter. Reads three kinds of
prose: macro action text, help-center article bodies, and internal (non-
public) notes on tickets. Deliberately never reads a ticket RECORD itself
(requester, submitter, assignee, organization, group, custom fields, tags,
subject, priority, status, satisfaction rating, ...) -- see this module's
own module-level constant _TICKET_REF_FIELDS and TicketRef below for how
that's enforced structurally, not just by convention.

Every function in this module returns one of the small, explicitly
declared dataclasses below -- Macro, Article, TicketRef, InternalNote --
built by reading named keys off Zendesk's raw JSON one field at a time.
None of them is ever constructed with `**payload` or by storing the raw
dict anywhere. That's not a style preference: it's what makes
tests/test_zendesk_client.py's declared-fields test able to PROVE (not
just assert) that a raw ticket payload carrying requester_id/custom_fields/
tags/subject/etc. can never reach anything downstream of this module --
TicketRef structurally has no attribute that could hold them, regardless
of what Zendesk's API happens to return in a given response.

Auth is Zendesk's own token scheme: HTTP Basic with a username of
"{agent_email}/token" and the API token as the password -- generated
self-serve in the customer's own Zendesk admin (Admin Center -> Apps and
integrations -> APIs -> Zendesk API), no OAuth app review needed.
"""

import re
from dataclasses import dataclass
from html import unescape
from html.parser import HTMLParser

import httpx

_REQUEST_TIMEOUT_SECONDS = 15.0

# A bare DNS label -- no dots, slashes, or fragment/query characters --
# so a value like "169.254.169.254/x#" can never turn "subdomain" into
# an attacker-controlled host once "_base_url" appends ".zendesk.com".
# Enforced again here (routers/zendesk.py validates on write) because
# the nightly sync worker reads "subdomain" back out of the database and
# calls this client directly, bypassing the request-model validator.
_SUBDOMAIN_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", re.IGNORECASE)


class ZendeskClientError(Exception):
    """Raised for anything other than a clean 2xx from Zendesk's API --
    callers should not need to know this is HTTP underneath."""


def _base_url(subdomain: str) -> str:
    if not _SUBDOMAIN_RE.fullmatch(subdomain):
        raise ZendeskClientError(f"invalid Zendesk subdomain: {subdomain!r}")
    return f"https://{subdomain}.zendesk.com/api/v2"


def _auth(agent_email: str, api_token: str) -> httpx.BasicAuth:
    # Zendesk's own token auth scheme -- the literal string "/token" is
    # part of the username, not a placeholder. See
    # developer.zendesk.com/api-reference/introduction/security-and-auth.
    return httpx.BasicAuth(f"{agent_email}/token", api_token)


async def _get(subdomain: str, agent_email: str, api_token: str, path: str, params: dict | None = None) -> dict:
    try:
        async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT_SECONDS) as client:
            response = await client.get(
                f"{_base_url(subdomain)}{path}", auth=_auth(agent_email, api_token), params=params
            )
    except httpx.HTTPError as exc:
        raise ZendeskClientError(f"could not reach Zendesk ({subdomain}): {exc}") from exc
    if response.status_code != 200:
        raise ZendeskClientError(f"Zendesk returned {response.status_code} for {path}: {response.text[:200]}")
    try:
        return response.json()
    except ValueError as exc:
        raise ZendeskClientError(f"Zendesk returned an invalid response for {path}") from exc


async def verify_credentials(subdomain: str, agent_email: str, api_token: str) -> None:
    """One real read before anything gets saved -- mirrors github/client.py's
    verify_repo_access. /users/me.json is the cheapest authenticated
    endpoint Zendesk's API has (a single row, no pagination, no scan of
    customer content), so this proves the subdomain/email/token triple is
    real and has API access without reading anything the connector will
    later read for real."""
    payload = await _get(subdomain, agent_email, api_token, "/users/me.json")
    user = payload.get("user") if isinstance(payload, dict) else None
    if not isinstance(user, dict) or not user.get("id"):
        raise ZendeskClientError(f"Zendesk did not return a valid user for {subdomain}")


# --- Macros: prose only -- id, title, and the comment text an agent would
# insert. Never reads a macro's `restriction` (which can carry group/agent
# scoping) or any other field. -------------------------------------------


@dataclass(frozen=True)
class Macro:
    id: str
    title: str
    action_text: str
    updated_at: str


# The only two Zendesk macro action fields that carry agent-facing prose --
# every other action `field` (e.g. status, priority, assignee, tags,
# group_id) changes ticket STATE, not text, and is never read.
_MACRO_TEXT_ACTION_FIELDS = {"comment_value", "comment_value_html"}


def _macro_action_text(raw_macro: dict) -> str:
    parts: list[str] = []
    for action in raw_macro.get("actions") or []:
        if not isinstance(action, dict):
            continue
        if action.get("field") not in _MACRO_TEXT_ACTION_FIELDS:
            continue
        value = action.get("value")
        # Zendesk's own shape is inconsistent here -- comment_value's value
        # is sometimes a bare string, sometimes [public_bool, string].
        # Either way, only the string half is prose worth reading.
        if isinstance(value, list):
            value = next((v for v in value if isinstance(v, str)), None)
        if isinstance(value, str) and value.strip():
            parts.append(value.strip())
    return "\n\n".join(parts)


async def list_macros(subdomain: str, agent_email: str, api_token: str) -> list[Macro]:
    """Active macros only -- an inactive/archived macro isn't live guidance
    an agent would actually apply."""
    payload = await _get(subdomain, agent_email, api_token, "/macros/active.json")
    macros: list[Macro] = []
    for raw in payload.get("macros") or []:
        if not isinstance(raw, dict) or not raw.get("id"):
            continue
        action_text = _macro_action_text(raw)
        if not action_text:
            continue
        macros.append(
            Macro(
                id=str(raw["id"]),
                title=str(raw.get("title") or ""),
                action_text=action_text,
                updated_at=str(raw.get("updated_at") or ""),
            )
        )
    return macros


# --- Help Center articles: prose only -- id, title, plain-text body, and
# the public link. Never reads author_id, section/category ids, vote
# counts, or label_names. -------------------------------------------------


@dataclass(frozen=True)
class Article:
    id: str
    title: str
    body_text: str
    html_url: str
    updated_at: str


class _HtmlToText(HTMLParser):
    """Best-effort, not a full HTML parser -- good enough to turn a help
    center article's rich-text body into plain prose for extraction. Block
    tags become paragraph breaks; everything else is dropped. Matches this
    codebase's existing "minimal, purpose-built string handling" discipline
    (see pipeline/sanitize.py) rather than pulling in a parsing dependency
    for one connector."""

    _BLOCK_TAGS = {"p", "div", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr"}

    def __init__(self) -> None:
        super().__init__()
        self._parts: list[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag in self._BLOCK_TAGS:
            self._parts.append("\n")

    def handle_data(self, data: str) -> None:
        self._parts.append(data)

    def text(self) -> str:
        joined = unescape("".join(self._parts))
        lines = [line.strip() for line in joined.splitlines()]
        return "\n".join(line for line in lines if line).strip()


def _html_to_text(html: str) -> str:
    parser = _HtmlToText()
    parser.feed(html)
    return parser.text()


async def list_articles(subdomain: str, agent_email: str, api_token: str, *, limit: int) -> list[Article]:
    """Most-recently-updated first, capped at `limit` -- the sync's own
    per-org item budget (Settings.zendesk_sweep_max_items_per_org) applies
    across macros/notes/articles combined, so this never asks Zendesk for
    more than the sync could possibly use."""
    payload = await _get(
        subdomain,
        agent_email,
        api_token,
        "/help_center/articles.json",
        params={"sort_by": "updated_at", "sort_order": "desc", "per_page": min(limit, 100)},
    )
    articles: list[Article] = []
    for raw in (payload.get("articles") or [])[:limit]:
        if not isinstance(raw, dict) or not raw.get("id"):
            continue
        body_text = _html_to_text(str(raw.get("body") or ""))
        if not body_text:
            continue
        articles.append(
            Article(
                id=str(raw["id"]),
                title=str(raw.get("title") or ""),
                body_text=body_text,
                html_url=str(raw.get("html_url") or ""),
                updated_at=str(raw.get("updated_at") or ""),
            )
        )
    return articles


# --- Tickets: id + updated_at ONLY. This is the whole enforcement point
# for "never reads a ticket record" -- see this dataclass's own docstring
# and tests/test_zendesk_client.py's declared-fields test. --------------


@dataclass(frozen=True)
class TicketRef:
    """The ENTIRE surface this connector ever reads off a ticket record.
    Zendesk's incremental ticket export returns full ticket objects
    (requester_id, submitter_id, assignee_id, organization_id, group_id,
    custom_fields, fields, tags, subject, description, priority, status,
    satisfaction_rating, via, ...) -- every one of those is present in the
    raw response this dataclass is built from, and every one of them is
    deliberately left unread. `id` identifies which ticket to fetch
    internal comments from (the actual prose source); `updated_at` is what
    bounds the sync to recently-changed tickets. Nothing else about a
    ticket is ever a legitimate reason for this connector to exist."""

    id: str
    updated_at: str


async def list_recently_updated_ticket_ids(
    subdomain: str, agent_email: str, api_token: str, *, start_time_unix: int, limit: int
) -> list[TicketRef]:
    """Zendesk's incremental ticket export (cursor-based) -- the standard
    "what changed since I last looked" endpoint. The raw response carries
    full ticket bodies; this function reads exactly two fields off each
    one (see TicketRef's own docstring) and discards the rest before
    returning, so nothing else in that payload survives past this
    function's stack frame."""
    payload = await _get(
        subdomain,
        agent_email,
        api_token,
        "/incremental/tickets/cursor.json",
        params={"start_time": start_time_unix},
    )
    refs: list[TicketRef] = []
    for raw in payload.get("tickets") or []:
        if not isinstance(raw, dict) or not raw.get("id"):
            continue
        refs.append(TicketRef(id=str(raw["id"]), updated_at=str(raw.get("updated_at") or "")))
        if len(refs) >= limit:
            break
    return refs


# --- Internal notes: the non-public comments on a ticket. Reads only
# comment id, its text, and when it was written -- never author_id,
# metadata, via, or attachments. ------------------------------------------


@dataclass(frozen=True)
class InternalNote:
    ticket_id: str
    comment_id: str
    body_text: str
    created_at: str


async def list_internal_notes(
    subdomain: str, agent_email: str, api_token: str, *, ticket_id: str
) -> list[InternalNote]:
    """`public: false` is Zendesk's own field marking a comment as an
    internal note rather than a customer-visible reply -- every comment
    with public: true is skipped outright, regardless of its text, since
    that's the same prose the requester already sees, not the internal
    tribal knowledge this connector exists to surface."""
    payload = await _get(subdomain, agent_email, api_token, f"/tickets/{ticket_id}/comments.json")
    notes: list[InternalNote] = []
    for raw in payload.get("comments") or []:
        if not isinstance(raw, dict) or not raw.get("id"):
            continue
        if raw.get("public") is not False:
            continue
        body_text = str(raw.get("plain_body") or raw.get("body") or "").strip()
        if not body_text:
            continue
        notes.append(
            InternalNote(
                ticket_id=str(ticket_id),
                comment_id=str(raw["id"]),
                body_text=body_text,
                created_at=str(raw.get("created_at") or ""),
            )
        )
    return notes
