"""gnt/email.py (Resend-backed sending, Python side).
Covers: is_email_configured/send_email's graceful-absence behavior when
RESEND_API_KEY isn't set (no network call at all, a clear log line, no
raise), a real send path (mocked httpx, not a real Resend call — tests
must never spend a real paid-API request), a failed Resend response
degrading the same way, and render_weekly_digest's plain-text content
shape (real numbers, the deltas, no invented urgency)."""

import httpx
import pytest

import gnt.email as email_module
from gnt.config import get_settings as real_get_settings
from gnt.email import is_email_configured, render_weekly_digest, send_email, send_weekly_digest


@pytest.fixture
def unconfigured(monkeypatch):
    settings = real_get_settings().model_copy(update={"resend_api_key": None})
    monkeypatch.setattr(email_module, "get_settings", lambda: settings)
    return settings


@pytest.fixture
def configured(monkeypatch):
    settings = real_get_settings().model_copy(
        update={"resend_api_key": "test_resend_key", "resend_from_email": "gnt.ai <test@example.com>"}
    )
    monkeypatch.setattr(email_module, "get_settings", lambda: settings)
    return settings


class _FakeAsyncClient:
    """Stands in for httpx.AsyncClient — records every POST and returns a
    pre-baked response, so no real Resend call is ever made (tests must
    never spend a real paid-API request)."""

    def __init__(self, calls: list, response: httpx.Response | Exception):
        self._calls = calls
        self._response = response

    def __call__(self, *args, **kwargs):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, **kwargs):
        self._calls.append({"url": url, **kwargs})
        if isinstance(self._response, Exception):
            raise self._response
        return self._response


def test_is_email_configured_false_when_key_unset(unconfigured):
    assert is_email_configured() is False


def test_is_email_configured_true_when_key_set(configured):
    assert is_email_configured() is True


async def test_send_email_skips_and_logs_when_not_configured(unconfigured, monkeypatch, capsys):
    calls: list = []
    # No AsyncClient should ever be constructed on this path -- proves the
    # "not configured" branch never even attempts a network call.
    monkeypatch.setattr(email_module.httpx, "AsyncClient", _FakeAsyncClient(calls, httpx.Response(200)))

    sent = await send_email(to="owner@example.com", subject="hi", text="body", log_fallback="fallback text")

    assert sent is False
    assert calls == []
    out = capsys.readouterr().out
    assert "email_skipped" in out
    assert "RESEND_API_KEY" in out


async def test_send_email_posts_to_resend_when_configured(configured, monkeypatch, capsys):
    calls: list = []
    monkeypatch.setattr(
        email_module.httpx, "AsyncClient", _FakeAsyncClient(calls, httpx.Response(200, json={"id": "abc"}))
    )

    sent = await send_email(to="owner@example.com", subject="hi", text="body", log_fallback="fallback")

    assert sent is True
    assert len(calls) == 1
    assert calls[0]["url"] == "https://api.resend.com/emails"
    assert calls[0]["headers"]["Authorization"] == "Bearer test_resend_key"
    assert calls[0]["json"]["to"] == ["owner@example.com"]
    assert calls[0]["json"]["from"] == "gnt.ai <test@example.com>"
    assert calls[0]["json"]["subject"] == "hi"
    out = capsys.readouterr().out
    assert "email_sent" in out


async def test_send_email_degrades_on_resend_error_response(configured, monkeypatch, capsys):
    calls: list = []
    captured: list = []
    monkeypatch.setattr(email_module.sentry_sdk, "capture_message", lambda *a, **k: captured.append((a, k)))
    monkeypatch.setattr(
        email_module.httpx, "AsyncClient", _FakeAsyncClient(calls, httpx.Response(422, text="bad address"))
    )

    sent = await send_email(to="not-an-email", subject="hi", text="body", log_fallback="fallback")

    assert sent is False
    assert len(captured) == 1
    out = capsys.readouterr().out
    assert "email_failed" in out


async def test_send_email_degrades_on_network_error(configured, monkeypatch, capsys):
    calls: list = []
    captured: list = []
    monkeypatch.setattr(email_module.sentry_sdk, "capture_exception", lambda exc: captured.append(exc))
    monkeypatch.setattr(
        email_module.httpx,
        "AsyncClient",
        _FakeAsyncClient(calls, httpx.ConnectError("connection refused")),
    )

    sent = await send_email(to="owner@example.com", subject="hi", text="body", log_fallback="fallback")

    assert sent is False
    assert len(captured) == 1


def test_render_weekly_digest_content_shape():
    summary = {
        "roi": {
            "window_days": 7,
            "current": {"rules_served": 42, "actions_checked": 10, "actions_blocked": 2, "actions_needs_human": 1},
            "prior": {"rules_served": 30, "actions_checked": 10, "actions_blocked": 5, "actions_needs_human": 1},
        },
        "gaps": {"current": 3, "prior": 8},
        "stale_due_count": 2,
    }

    subject, body = render_weekly_digest("org_test_a", summary)

    assert "10 actions checked" in subject
    assert "42" in body
    assert "+12 vs. last week" in body
    assert "flat vs. last week" in body
    assert "-3 vs. last week" in body
    assert "-5 vs. last week" in body
    assert "2 approved rules due for re-validation" in body
    assert "gnt stale" in body
    assert "gnt gaps" in body


def test_render_weekly_digest_omits_staleness_line_when_nothing_is_due():
    summary = {
        "roi": {
            "window_days": 7,
            "current": {"rules_served": 0, "actions_checked": 0, "actions_blocked": 0, "actions_needs_human": 0},
            "prior": {"rules_served": 0, "actions_checked": 0, "actions_blocked": 0, "actions_needs_human": 0},
        },
        "gaps": {"current": 0, "prior": 0},
        "stale_due_count": 0,
    }

    _, body = render_weekly_digest("org_test_a", summary)

    assert "due for re-validation" not in body


async def test_send_weekly_digest_sends_once_per_recipient(configured, monkeypatch):
    calls: list = []
    monkeypatch.setattr(email_module.httpx, "AsyncClient", _FakeAsyncClient(calls, httpx.Response(200)))

    summary = {
        "roi": {
            "window_days": 7,
            "current": {"rules_served": 1, "actions_checked": 1, "actions_blocked": 0, "actions_needs_human": 0},
            "prior": {"rules_served": 1, "actions_checked": 1, "actions_blocked": 0, "actions_needs_human": 0},
        },
        "gaps": {"current": 0, "prior": 0},
        "stale_due_count": 0,
    }

    await send_weekly_digest(["a@example.com", "b@example.com"], "org_test_a", summary)

    assert len(calls) == 2
    assert {c["json"]["to"][0] for c in calls} == {"a@example.com", "b@example.com"}
