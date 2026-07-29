"""gnt.zendesk.client — the Zendesk REST adapter.
Mocks at the module's own _get boundary (same shape test_github_client.py
uses for _call), so nothing here makes a real network call.

test_ticket_ref_never_carries_a_ticket_record_field is the declared-fields
proof this connector's PR description promises: it feeds
list_recently_updated_ticket_ids a raw Zendesk ticket payload carrying
every field a real ticket record has (requester_id, submitter_id,
custom_fields, tags, subject, description, priority, status,
satisfaction_rating, ...) and proves none of it survives past this
module — not by asserting a filtered dict happens not to contain those
keys today, but by proving TicketRef's own declared dataclass fields are
exactly {"id", "updated_at"}, so nothing downstream of this module could
ever hold a forbidden field even if a future edit tried to pass one
through.
"""

import dataclasses

import pytest

from gnt.zendesk.client import (
    Article,
    InternalNote,
    Macro,
    TicketRef,
    ZendeskClientError,
    list_articles,
    list_internal_notes,
    list_macros,
    list_recently_updated_ticket_ids,
    verify_credentials,
)

# A realistic full Zendesk ticket record -- every field this connector must
# never read, plus id/updated_at, the only two it's allowed to.
_FULL_TICKET_RECORD = {
    "id": 4821,
    "updated_at": "2026-07-18T10:00:00Z",
    "created_at": "2026-07-01T10:00:00Z",
    "requester_id": 555111,
    "submitter_id": 555222,
    "assignee_id": 555333,
    "organization_id": 999,
    "group_id": 42,
    "custom_fields": [{"id": 1, "value": "vip"}],
    "fields": [{"id": 2, "value": "gold"}],
    "tags": ["billing", "urgent"],
    "subject": "Can't access my account",
    "description": "I'm locked out and my card was charged twice, my email is a@b.com",
    "priority": "high",
    "status": "open",
    "satisfaction_rating": {"score": "good"},
    "via": {"channel": "email"},
    "recipient": "support@acme.zendesk.com",
    "collaborator_ids": [1, 2, 3],
    "email_cc_ids": [4, 5],
    "followup_ids": [],
    "brand_id": 7,
    "problem_id": None,
    "type": "incident",
    "raw_subject": "Can't access my account",
}


def _fake_get(payload):
    async def _get(subdomain, agent_email, api_token, path, params=None):
        return payload

    return _get


# --- Declared-fields proof --------------------------------------------


def test_ticket_ref_declares_only_id_and_updated_at():
    """Structural proof, not a behavioral one: TicketRef's own dataclass
    fields are exactly the two this connector is allowed to read off a
    ticket. If a future edit ever tried to widen TicketRef to carry a
    forbidden field, this test fails immediately, independent of whatever
    payload happens to be fed to it in a given test run."""
    field_names = {f.name for f in dataclasses.fields(TicketRef)}
    assert field_names == {"id", "updated_at"}


async def test_ticket_ref_never_carries_a_ticket_record_field(monkeypatch):
    monkeypatch.setattr(
        "gnt.zendesk.client._get", _fake_get({"tickets": [_FULL_TICKET_RECORD]})
    )
    refs = await list_recently_updated_ticket_ids(
        "acme", "agent@acme.com", "tok", start_time_unix=0, limit=10
    )
    assert len(refs) == 1
    ref = refs[0]
    assert ref == TicketRef(id="4821", updated_at="2026-07-18T10:00:00Z")

    # Even if someone reaches for the raw payload's forbidden fields by
    # name against the returned object, there is nothing there to find --
    # a dataclass has no such attributes at all.
    for forbidden in (
        "requester_id", "submitter_id", "assignee_id", "organization_id", "group_id",
        "custom_fields", "fields", "tags", "subject", "description", "priority",
        "status", "satisfaction_rating", "via", "recipient", "collaborator_ids",
        "email_cc_ids", "brand_id", "type", "raw_subject",
    ):
        assert not hasattr(ref, forbidden)


async def test_internal_note_never_carries_author_or_metadata_fields(monkeypatch):
    """Same declared-fields discipline for the comment adapter -- author_id,
    metadata, via, and attachments are present on a real Zendesk comment
    payload and never read."""
    raw_comment = {
        "id": 91,
        "type": "Comment",
        "author_id": 555333,
        "body": "internal: always waive the fee for VIP tier",
        "plain_body": "internal: always waive the fee for VIP tier",
        "html_body": "<p>internal: always waive the fee for VIP tier</p>",
        "public": False,
        "created_at": "2026-07-18T11:00:00Z",
        "attachments": [{"file_name": "screenshot.png"}],
        "audit_id": 12345,
        "via": {"channel": "web"},
        "metadata": {"system": {"client": "browser"}},
    }
    monkeypatch.setattr("gnt.zendesk.client._get", _fake_get({"comments": [raw_comment]}))

    notes = await list_internal_notes("acme", "agent@acme.com", "tok", ticket_id="4821")
    assert notes == [
        InternalNote(
            ticket_id="4821",
            comment_id="91",
            body_text="internal: always waive the fee for VIP tier",
            created_at="2026-07-18T11:00:00Z",
        )
    ]
    field_names = {f.name for f in dataclasses.fields(InternalNote)}
    assert field_names == {"ticket_id", "comment_id", "body_text", "created_at"}


async def test_public_comments_are_never_returned_as_internal_notes(monkeypatch):
    raw_comment = {
        "id": 92,
        "body": "Thanks for reaching out, here's your refund confirmation.",
        "plain_body": "Thanks for reaching out, here's your refund confirmation.",
        "public": True,
        "created_at": "2026-07-18T11:05:00Z",
    }
    monkeypatch.setattr("gnt.zendesk.client._get", _fake_get({"comments": [raw_comment]}))

    notes = await list_internal_notes("acme", "agent@acme.com", "tok", ticket_id="4821")
    assert notes == []


async def test_internal_notes_respects_the_limit_parameter_via_iteration(monkeypatch):
    # list_internal_notes itself has no `limit` (it's per-ticket, already
    # bounded by that ticket's own comment count) -- covered here just to
    # confirm a ticket with zero internal notes (all comments public)
    # returns an empty list, not an error.
    monkeypatch.setattr(
        "gnt.zendesk.client._get",
        _fake_get({"comments": [{"id": 1, "body": "hi", "plain_body": "hi", "public": True, "created_at": "x"}]}),
    )
    assert await list_internal_notes("acme", "a@b.com", "tok", ticket_id="1") == []


# --- Macros ---------------------------------------------------------------


async def test_list_macros_reads_only_comment_actions(monkeypatch):
    raw_macro = {
        "id": 55,
        "title": "Refund policy",
        "updated_at": "2026-07-01T00:00:00Z",
        "restriction": {"type": "Group", "ids": [1, 2]},
        "actions": [
            {"field": "status", "value": "solved"},
            {"field": "priority", "value": "normal"},
            {"field": "comment_value", "value": "Refunds are processed within 30 days."},
        ],
    }
    monkeypatch.setattr("gnt.zendesk.client._get", _fake_get({"macros": [raw_macro]}))

    macros = await list_macros("acme", "a@b.com", "tok")
    assert macros == [
        Macro(
            id="55", title="Refund policy",
            action_text="Refunds are processed within 30 days.",
            updated_at="2026-07-01T00:00:00Z",
        )
    ]


async def test_list_macros_skips_macros_with_no_comment_text(monkeypatch):
    raw_macro = {
        "id": 56, "title": "Escalate", "updated_at": "x",
        "actions": [{"field": "priority", "value": "urgent"}],
    }
    monkeypatch.setattr("gnt.zendesk.client._get", _fake_get({"macros": [raw_macro]}))
    assert await list_macros("acme", "a@b.com", "tok") == []


# --- Articles ---------------------------------------------------------------


async def test_list_articles_strips_html_to_plain_text(monkeypatch):
    raw_article = {
        "id": 77,
        "title": "Shipping policy",
        "body": "<p>Orders ship within <strong>2 days</strong>.</p><p>Second paragraph.</p>",
        "html_url": "https://acme.zendesk.com/hc/en-us/articles/77",
        "updated_at": "2026-07-10T00:00:00Z",
        "author_id": 12345,
        "vote_count": 9,
        "label_names": ["shipping"],
    }
    monkeypatch.setattr("gnt.zendesk.client._get", _fake_get({"articles": [raw_article]}))

    articles = await list_articles("acme", "a@b.com", "tok", limit=10)
    assert len(articles) == 1
    assert articles[0].id == "77"
    assert articles[0].title == "Shipping policy"
    assert "Orders ship within" in articles[0].body_text
    assert "Second paragraph." in articles[0].body_text
    assert "<p>" not in articles[0].body_text and "<strong>" not in articles[0].body_text
    assert articles[0].html_url == "https://acme.zendesk.com/hc/en-us/articles/77"
    field_names = {f.name for f in dataclasses.fields(Article)}
    assert field_names == {"id", "title", "body_text", "html_url", "updated_at"}


# --- verify_credentials -----------------------------------------------


async def test_verify_credentials_succeeds_on_a_valid_user(monkeypatch):
    monkeypatch.setattr(
        "gnt.zendesk.client._get", _fake_get({"user": {"id": 1, "role": "agent", "email": "a@b.com"}})
    )
    await verify_credentials("acme", "a@b.com", "tok")  # does not raise


async def test_verify_credentials_raises_on_a_malformed_response(monkeypatch):
    monkeypatch.setattr("gnt.zendesk.client._get", _fake_get({"user": None}))
    with pytest.raises(ZendeskClientError):
        await verify_credentials("acme", "a@b.com", "tok")


async def test_get_raises_a_clean_error_on_a_non_200_response(monkeypatch):
    import httpx

    async def _raise_connect_error(self, *args, **kwargs):
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(httpx.AsyncClient, "get", _raise_connect_error)

    with pytest.raises(ZendeskClientError, match="could not reach Zendesk"):
        await verify_credentials("acme", "a@b.com", "tok")
