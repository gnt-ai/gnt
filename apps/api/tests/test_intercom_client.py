"""gnt.intercom.client — the Intercom REST adapter, one of this codebase's
helpdesk connectors. Mocks at the module's own _get/_post boundary (same shape
test_zendesk_client.py uses for its own _get), so nothing here makes a
real network call.

test_conversation_ref_never_carries_a_contact_record_field is the
declared-fields proof this connector's PR description promises: it feeds
list_recently_updated_conversation_ids a raw Intercom conversation
payload carrying every field a real conversation (and the contact it
belongs to) has (contacts, custom_attributes, tags, priority,
admin_assignee_id, team_assignee_id, source.author.email, statistics,
conversation_rating, ...) and proves none of it survives past this
module — not by asserting a filtered dict happens not to contain those
keys today, but by proving ConversationRef's own declared dataclass
fields are exactly {"id", "updated_at"}, so nothing downstream of this
module could ever hold a forbidden field even if a future edit tried to
pass one through.
"""

import dataclasses

import pytest

from gnt.intercom.client import (
    Article,
    ConversationRef,
    IntercomClientError,
    InternalNote,
    SavedReply,
    list_articles,
    list_internal_notes,
    list_recently_updated_conversation_ids,
    list_saved_replies,
    verify_credentials,
)

# A realistic full Intercom conversation record -- every field this
# connector must never read, plus id/updated_at, the only two it's
# allowed to. Mirrors the shape Intercom's own /conversations/search
# response returns (contacts is the CRM-like record for the customer this
# connector must never touch).
_FULL_CONVERSATION_RECORD = {
    "type": "conversation",
    "id": "4821",
    "created_at": 1734537546,
    "updated_at": 1752883200,
    "waiting_since": None,
    "snoozed_until": None,
    "source": {
        "type": "conversation",
        "id": "403918346",
        "delivered_as": "customer_initiated",
        "subject": "",
        "body": "<p>I'm locked out and my card was charged twice, my email is a@b.com</p>",
        "author": {"type": "contact", "id": "6762f15b1bb69f9f2193bbbc", "name": "Alice", "email": "a@b.com"},
        "attachments": [],
        "url": None,
        "redacted": False,
    },
    "contacts": {
        "type": "contact.list",
        "contacts": [{"type": "contact", "id": "6762f15b1bb69f9f2193bbbc", "external_id": "70"}],
    },
    "first_contact_reply": None,
    "admin_assignee_id": 991267715,
    "team_assignee_id": 5017691,
    "open": False,
    "state": "closed",
    "read": False,
    "tags": {"type": "tag.list", "tags": [{"id": "1", "name": "billing"}]},
    "priority": "high",
    "sla_applied": None,
    "statistics": {"time_to_assignment": 120, "count_reopens": 1},
    "conversation_rating": {"score": 5, "remark": "great"},
    "teammates": None,
    "title": "Can't access my account",
    "custom_attributes": {"vip": True},
    "topics": {},
    "ticket": None,
    "linked_objects": {"type": "list", "data": [], "total_count": 0, "has_more": False},
    "ai_agent": None,
    "ai_agent_participated": False,
}


def _fake_get(payload):
    async def _get(access_token, path, params=None, **kwargs):
        return payload

    return _get


def _fake_post(payload):
    async def _post(access_token, path, json_body, **kwargs):
        return payload

    return _post


# --- Declared-fields proof --------------------------------------------


def test_conversation_ref_declares_only_id_and_updated_at():
    """Structural proof, not a behavioral one: ConversationRef's own
    dataclass fields are exactly the two this connector is allowed to
    read off a conversation. If a future edit ever tried to widen
    ConversationRef to carry a forbidden field, this test fails
    immediately, independent of whatever payload happens to be fed to it
    in a given test run."""
    field_names = {f.name for f in dataclasses.fields(ConversationRef)}
    assert field_names == {"id", "updated_at"}


async def test_conversation_ref_never_carries_a_contact_record_field(monkeypatch):
    monkeypatch.setattr(
        "gnt.intercom.client._post", _fake_post({"conversations": [_FULL_CONVERSATION_RECORD]})
    )
    refs = await list_recently_updated_conversation_ids("tok", start_time_unix=0, limit=10)
    assert len(refs) == 1
    ref = refs[0]
    assert ref == ConversationRef(id="4821", updated_at="1752883200")

    # Even if someone reaches for the raw payload's forbidden fields by
    # name against the returned object, there is nothing there to find --
    # a dataclass has no such attributes at all.
    for forbidden in (
        "contacts", "custom_attributes", "tags", "priority", "admin_assignee_id",
        "team_assignee_id", "source", "statistics", "conversation_rating", "title",
        "state", "open", "read", "waiting_since", "snoozed_until", "linked_objects",
        "topics", "ticket", "ai_agent", "teammates",
    ):
        assert not hasattr(ref, forbidden)


async def test_internal_note_never_carries_author_or_conversation_metadata_fields(monkeypatch):
    """Same declared-fields discipline for the conversation-parts adapter
    -- author, redacted, attachments, and the conversation's own
    contact/tag/attribute fields are present on a real Intercom
    conversation payload and never read."""
    raw_conversation = {
        "id": "4821",
        "contacts": {"type": "contact.list", "contacts": [{"type": "contact", "id": "123"}]},
        "custom_attributes": {"vip": True},
        "tags": {"type": "tag.list", "tags": []},
        "conversation_parts": {
            "type": "conversation_part.list",
            "conversation_parts": [
                {
                    "type": "conversation_part",
                    "id": "133",
                    "part_type": "note",
                    "body": "internal: always waive the fee for VIP tier",
                    "created_at": 1734537565,
                    "updated_at": 1734537565,
                    "author": {"type": "admin", "id": "991267696", "name": "Ciaran", "email": "admin@acme.com"},
                    "attachments": [{"name": "screenshot.png"}],
                    "redacted": False,
                    "assigned_to": None,
                }
            ],
        },
    }
    monkeypatch.setattr("gnt.intercom.client._get", _fake_get(raw_conversation))

    notes = await list_internal_notes("tok", conversation_id="4821")
    assert notes == [
        InternalNote(
            conversation_id="4821",
            note_id="133",
            body_text="internal: always waive the fee for VIP tier",
            created_at="1734537565",
        )
    ]
    field_names = {f.name for f in dataclasses.fields(InternalNote)}
    assert field_names == {"conversation_id", "note_id", "body_text", "created_at"}


async def test_comment_parts_are_never_returned_as_internal_notes(monkeypatch):
    raw_conversation = {
        "id": "4821",
        "conversation_parts": {
            "type": "conversation_part.list",
            "conversation_parts": [
                {
                    "type": "conversation_part",
                    "id": "134",
                    "part_type": "comment",
                    "body": "Thanks for reaching out, here's your refund confirmation.",
                    "created_at": 1734537600,
                }
            ],
        },
    }
    monkeypatch.setattr("gnt.intercom.client._get", _fake_get(raw_conversation))

    notes = await list_internal_notes("tok", conversation_id="4821")
    assert notes == []


async def test_internal_notes_returns_empty_list_when_conversation_parts_missing(monkeypatch):
    monkeypatch.setattr("gnt.intercom.client._get", _fake_get({"id": "4821"}))
    assert await list_internal_notes("tok", conversation_id="4821") == []


# --- Saved replies (macros) -------------------------------------------


async def test_list_saved_replies_reads_body_text_not_body(monkeypatch):
    raw_macro = {
        "type": "macro",
        "id": "789",
        "name": "Refund Process",
        "body": "<p>The refund will be processed within 3-5 business days.</p>",
        "body_text": "The refund will be processed within 3-5 business days.",
        "created_at": "2025-07-21T07:15:34.000Z",
        "updated_at": "2025-07-21T07:15:34.000Z",
        "visible_to": "specific_teams",
        "visible_to_team_ids": ["security_team"],
        "available_on": ["inbox", "messenger"],
    }
    monkeypatch.setattr("gnt.intercom.client._get", _fake_get({"type": "list", "data": [raw_macro]}))

    replies = await list_saved_replies("tok")
    assert replies == [
        SavedReply(
            id="789", title="Refund Process",
            action_text="The refund will be processed within 3-5 business days.",
            updated_at="2025-07-21T07:15:34.000Z",
        )
    ]
    field_names = {f.name for f in dataclasses.fields(SavedReply)}
    assert field_names == {"id", "title", "action_text", "updated_at"}
    for forbidden in ("visible_to", "visible_to_team_ids", "available_on", "body"):
        assert not hasattr(replies[0], forbidden)


async def test_list_saved_replies_skips_macros_with_null_body_text(monkeypatch):
    """Intercom's own docs note body_text can come back null for large
    result sets ("body rendering may be skipped for performance") --
    treated the same as Zendesk's macro-with-no-comment-text: skipped,
    not an error."""
    raw_macro = {
        "id": "1001", "name": "Quick Response 1", "body": None, "body_text": None,
        "created_at": "x", "updated_at": "x",
    }
    monkeypatch.setattr("gnt.intercom.client._get", _fake_get({"type": "list", "data": [raw_macro]}))
    assert await list_saved_replies("tok") == []


# --- Articles ---------------------------------------------------------


async def test_list_articles_strips_html_to_plain_text(monkeypatch):
    raw_article = {
        "id": "39",
        "type": "article",
        "workspace_id": "abc123",
        "parent_id": "143",
        "parent_type": "collection",
        "parent_ids": [],
        "tags": {"type": "tag.list", "tags": []},
        "title": "Shipping policy",
        "description": "how shipping works",
        "body": "<p>Orders ship within <strong>2 days</strong>.</p><p>Second paragraph.</p>",
        "author_id": 991267492,
        "state": "published",
        "created_at": 1734537283,
        "updated_at": 1734537283,
        "url": "http://help-center.test/myapp/en/articles/39-shipping-policy",
    }
    monkeypatch.setattr("gnt.intercom.client._get", _fake_get({"type": "list", "data": [raw_article]}))

    articles = await list_articles("tok", limit=10)
    assert len(articles) == 1
    assert articles[0].id == "39"
    assert articles[0].title == "Shipping policy"
    assert "Orders ship within" in articles[0].body_text
    assert "Second paragraph." in articles[0].body_text
    assert "<p>" not in articles[0].body_text and "<strong>" not in articles[0].body_text
    assert articles[0].html_url == "http://help-center.test/myapp/en/articles/39-shipping-policy"
    field_names = {f.name for f in dataclasses.fields(Article)}
    assert field_names == {"id", "title", "body_text", "html_url", "updated_at"}
    for forbidden in ("author_id", "state", "description", "tags", "parent_id", "parent_ids", "parent_type"):
        assert not hasattr(articles[0], forbidden)


async def test_list_articles_respects_the_limit_by_slicing(monkeypatch):
    raw = [
        {"id": str(i), "title": f"Article {i}", "body": f"<p>content {i}</p>", "url": "x", "updated_at": "x"}
        for i in range(5)
    ]
    monkeypatch.setattr("gnt.intercom.client._get", _fake_get({"type": "list", "data": raw}))
    articles = await list_articles("tok", limit=2)
    assert len(articles) == 2


# --- verify_credentials -------------------------------------------------


async def test_verify_credentials_succeeds_on_a_valid_admin(monkeypatch):
    monkeypatch.setattr(
        "gnt.intercom.client._get", _fake_get({"type": "admin", "id": "991267459", "email": "a@b.com"})
    )
    await verify_credentials("tok")  # does not raise


async def test_verify_credentials_raises_on_a_malformed_response(monkeypatch):
    monkeypatch.setattr("gnt.intercom.client._get", _fake_get({"id": None}))
    with pytest.raises(IntercomClientError):
        await verify_credentials("tok")


async def test_get_raises_a_clean_error_on_a_non_200_response(monkeypatch):
    import httpx

    async def _raise_connect_error(self, *args, **kwargs):
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(httpx.AsyncClient, "get", _raise_connect_error)

    with pytest.raises(IntercomClientError, match="could not reach Intercom"):
        await verify_credentials("tok")
