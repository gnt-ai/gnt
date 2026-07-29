"""Intercom REST API adapter. Reads three kinds of
prose: saved-reply (macro) text, help-center article bodies, and internal
notes on conversations. Deliberately never reads a contact RECORD itself
(email, phone, name, external_id, custom_attributes, location, companies,
tags, segments, ...) -- see this module's own ConversationRef below for
how that's enforced structurally, not just by convention.

Every function in this module returns one of the small, explicitly
declared dataclasses below -- SavedReply, Article, ConversationRef,
InternalNote -- built by reading named keys off Intercom's raw JSON one
field at a time. None of them is ever constructed with `**payload` or by
storing the raw dict anywhere. That's not a style preference: it's what
makes tests/test_intercom_client.py's declared-fields test able to PROVE
(not just assert) that a raw conversation payload carrying
contacts/custom_attributes/tags/priority/etc. can never reach anything
downstream of this module -- ConversationRef structurally has no attribute
that could hold them, regardless of what Intercom's API happens to return
in a given response.

Auth is a single self-serve access token: a Personal Access Token a
customer generates themselves in their own workspace (Settings -> Developer
Hub -> your app -> Access Token), sent as a plain bearer token -- no OAuth
app review needed, and unlike Zendesk there's no per-customer subdomain to
collect: every request goes to the same https://api.intercom.io host,
which Intercom itself auto-routes to the workspace's actual data region
(US/EU/AU) based on the token. See
developers.intercom.com/docs/build-an-integration/learn-more/authentication.

Two Intercom-Version values are in play, not one: every call in this
module pins "2.15" (the current stable API version) EXCEPT saved replies.
As of this connector's build date, Intercom's Macros API (the only way to
read saved replies at all) ships solely under the "Preview" version --
there is no stable, GA saved-replies endpoint the way Zendesk's macros are
already GA. list_saved_replies pins "Preview" for that one call only, so a
future stable release of the same endpoint doesn't silently change what
every other call in this module sees.
"""

from dataclasses import dataclass
from html import unescape
from html.parser import HTMLParser

import httpx

_REQUEST_TIMEOUT_SECONDS = 15.0
_BASE_URL = "https://api.intercom.io"

# The current stable REST API version this connector pins every call to,
# except list_saved_replies -- see module docstring. Bumping this is a
# deliberate, tested decision, not something that should silently drift
# with whatever Intercom treats as "default" on a given day.
_STABLE_VERSION = "2.15"

# The only Intercom-Version value that currently serves the Macros
# (saved-replies) API at all -- see module docstring.
_MACROS_API_VERSION = "Preview"


class IntercomClientError(Exception):
    """Raised for anything other than a clean 2xx from Intercom's API --
    callers should not need to know this is HTTP underneath."""


def _headers(access_token: str, version: str) -> dict:
    return {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/json",
        "Intercom-Version": version,
    }


async def _get(access_token: str, path: str, params: dict | None = None, *, version: str = _STABLE_VERSION) -> dict:
    try:
        async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT_SECONDS) as client:
            response = await client.get(f"{_BASE_URL}{path}", headers=_headers(access_token, version), params=params)
    except httpx.HTTPError as exc:
        raise IntercomClientError(f"could not reach Intercom: {exc}") from exc
    if response.status_code != 200:
        raise IntercomClientError(f"Intercom returned {response.status_code} for {path}: {response.text[:200]}")
    try:
        return response.json()
    except ValueError as exc:
        raise IntercomClientError(f"Intercom returned an invalid response for {path}") from exc


async def _post(access_token: str, path: str, json_body: dict, *, version: str = _STABLE_VERSION) -> dict:
    try:
        async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT_SECONDS) as client:
            response = await client.post(f"{_BASE_URL}{path}", headers=_headers(access_token, version), json=json_body)
    except httpx.HTTPError as exc:
        raise IntercomClientError(f"could not reach Intercom: {exc}") from exc
    if response.status_code != 200:
        raise IntercomClientError(f"Intercom returned {response.status_code} for {path}: {response.text[:200]}")
    try:
        return response.json()
    except ValueError as exc:
        raise IntercomClientError(f"Intercom returned an invalid response for {path}") from exc


async def verify_credentials(access_token: str) -> None:
    """One real read before anything gets saved -- mirrors
    zendesk/client.py's verify_credentials. GET /me ("identify the current
    admin") is the cheapest authenticated endpoint Intercom's API has (a
    single row, no pagination, no scan of customer content), so this
    proves the access token is real and has API access without reading
    anything the connector will later read for real."""
    payload = await _get(access_token, "/me")
    if not isinstance(payload, dict) or not payload.get("id"):
        raise IntercomClientError("Intercom did not return a valid admin for this access token")


# --- Saved replies (macros): prose only -- id, name, and the plain-text
# reply body. Never reads a macro's `visible_to`/`visible_to_team_ids`
# (which scope who can use it) or `available_on`. --------------------------


@dataclass(frozen=True)
class SavedReply:
    id: str
    title: str
    action_text: str
    updated_at: str


async def list_saved_replies(access_token: str) -> list[SavedReply]:
    """Reads Intercom's Macros API (see module docstring for why this one
    call pins Intercom-Version: Preview). per_page=150 is the endpoint's
    documented maximum -- this reads a single page, same bounded-by-one-
    call shape zendesk/client.py's list_macros uses for
    /macros/active.json, trusting that page size to comfortably cover a
    self-serve workspace's saved-reply library.

    Intercom returns `body` (HTML with placeholder tags) and `body_text`
    (the same content already flattened to plain text with placeholders
    substituted) side by side -- body_text is read here, never body, so
    this connector never has to run its own HTML-to-text pass over a
    macro the way it does for help-center articles. Intercom's own docs
    note body_text can come back null for large result sets ("body
    rendering may be skipped for performance"); a null/empty body_text is
    treated the same as Zendesk's macro-with-no-comment-text -- skipped,
    not an error."""
    payload = await _get(
        access_token, "/macros", params={"per_page": 150}, version=_MACROS_API_VERSION
    )
    replies: list[SavedReply] = []
    for raw in payload.get("data") or []:
        if not isinstance(raw, dict) or not raw.get("id"):
            continue
        action_text = str(raw.get("body_text") or "").strip()
        if not action_text:
            continue
        replies.append(
            SavedReply(
                id=str(raw["id"]),
                title=str(raw.get("name") or ""),
                action_text=action_text,
                updated_at=str(raw.get("updated_at") or ""),
            )
        )
    return replies


# --- Help Center articles: prose only -- id, title, plain-text body, and
# the public link. Never reads author_id, state, description, tags, or
# parent_id/parent_ids/parent_type. Collections themselves (the folders
# articles live in) carry no body text of their own -- just a name and a
# description -- so there's nothing in a Collection worth extracting from;
# the prose this connector reads lives entirely in Articles. -------------


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
    for one connector. Same shape as zendesk/client.py's own
    _HtmlToText -- kept local to each connector rather than factored into
    a shared util, since neither one is more than this."""

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


async def list_articles(access_token: str, *, limit: int) -> list[Article]:
    """Most-recently-updated first (Intercom's own documented default
    order for this endpoint), capped at `limit` client-side -- the sync's
    own per-org item budget (Settings.intercom_sweep_max_items_per_org)
    applies across saved replies/notes/articles combined, so this never
    hands extraction more than the sync could possibly use. Unlike
    Zendesk's help_center/articles.json, GET /articles takes no per_page
    parameter, so bounding happens entirely by slicing the response."""
    payload = await _get(access_token, "/articles")
    articles: list[Article] = []
    for raw in (payload.get("data") or [])[:limit]:
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
                html_url=str(raw.get("url") or ""),
                updated_at=str(raw.get("updated_at") or ""),
            )
        )
    return articles


# --- Conversations: id + updated_at ONLY. This is the whole enforcement
# point for "never reads a contact record" -- see this dataclass's own
# docstring and tests/test_intercom_client.py's declared-fields test. ----


@dataclass(frozen=True)
class ConversationRef:
    """The ENTIRE surface this connector ever reads off a conversation.
    Intercom's conversation search returns full conversation objects
    (contacts, custom_attributes, tags, priority, admin_assignee_id,
    team_assignee_id, source.body/source.author, statistics,
    conversation_rating, ai_agent, title, state, open, read,
    waiting_since, snoozed_until, linked_objects, topics, ticket, ...) --
    every one of those is present in the raw response this dataclass is
    built from, and every one of them is deliberately left unread. `id`
    identifies which conversation to fetch internal notes from (the
    actual prose source); `updated_at` is what bounds the sync to
    recently-changed conversations. Nothing else about a conversation --
    and in particular nothing about the CONTACT that conversation belongs
    to (email, phone, name, external_id, custom_attributes, location,
    companies, tags, segments -- Intercom's Contact/Company objects) -- is
    ever a legitimate reason for this connector to exist."""

    id: str
    updated_at: str


async def list_recently_updated_conversation_ids(
    access_token: str, *, start_time_unix: int, limit: int
) -> list[ConversationRef]:
    """POST /conversations/search -- Intercom's own "what changed since I
    last looked" mechanism (there's no separate incremental-export
    endpoint the way Zendesk has one; search with an `updated_at > X`
    filter is the documented way to do this). The raw response carries
    full conversation bodies; this function reads exactly two fields off
    each one (see ConversationRef's own docstring) and discards the rest
    before returning, so nothing else in that payload survives past this
    function's stack frame."""
    payload = await _post(
        access_token,
        "/conversations/search",
        {
            "query": {"field": "updated_at", "operator": ">", "value": start_time_unix},
            "pagination": {"per_page": min(limit, 150)},
        },
    )
    refs: list[ConversationRef] = []
    for raw in payload.get("conversations") or []:
        if not isinstance(raw, dict) or not raw.get("id"):
            continue
        refs.append(ConversationRef(id=str(raw["id"]), updated_at=str(raw.get("updated_at") or "")))
        if len(refs) >= limit:
            break
    return refs


# --- Internal notes: the non-public parts on a conversation. Reads only
# the part id, its plain-text body, and when it was written -- never
# author, metadata, or the conversation's own contact/tag/attribute
# fields. -------------------------------------------------------------


@dataclass(frozen=True)
class InternalNote:
    conversation_id: str
    note_id: str
    body_text: str
    created_at: str


async def list_internal_notes(access_token: str, *, conversation_id: str) -> list[InternalNote]:
    """`part_type: "note"` is Intercom's own field marking a conversation
    part as an internal note (visible only to teammates) rather than a
    customer-facing reply -- every part whose type isn't exactly "note"
    (comment, assignment, close, snoozed, ...) is skipped outright,
    regardless of its text, since a "comment" is the same prose the
    customer already sees, not the internal tribal knowledge this
    connector exists to surface.

    display_as=plaintext asks Intercom to flatten each part's body to
    plain text server-side, the same role Zendesk's plain_body field
    plays for ticket comments -- this connector never runs its own HTML
    stripping over conversation content."""
    payload = await _get(access_token, f"/conversations/{conversation_id}", params={"display_as": "plaintext"})
    parts_container = payload.get("conversation_parts") or {}
    notes: list[InternalNote] = []
    for raw in parts_container.get("conversation_parts") or []:
        if not isinstance(raw, dict) or not raw.get("id"):
            continue
        if raw.get("part_type") != "note":
            continue
        body_text = str(raw.get("body") or "").strip()
        if not body_text:
            continue
        notes.append(
            InternalNote(
                conversation_id=str(conversation_id),
                note_id=str(raw["id"]),
                body_text=body_text,
                created_at=str(raw.get("created_at") or ""),
            )
        )
    return notes
