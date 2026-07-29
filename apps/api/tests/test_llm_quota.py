"""gnt.llm_quota — the per-org monthly LLM spend quota plus a global
aggregate circuit breaker that gates real LLM calls before they go out.
Covers the essential guarantees directly: a quota blocks a call once exceeded
(per-org), a different org isn't blocked by another org's exhausted quota
(tenant isolation), the global circuit breaker actually prevents a call
at 100% global spend, alerts fire once per threshold (50/80/100 percent),
and the quota machinery itself never touches the paid Anthropic API.

Every test pins a synthetic month (`_MONTH`, year 2099) via the `today=`
override every gnt.llm_quota function accepts — this keeps the module's
llm_usage_global row (a genuinely global, cross-test singleton per
calendar month) fully isolated from both other tests in this file and
from other test files that exercise the real call sites (e.g.
tests/test_tasks_contradictions.py's sweep tests, which use real,
non-rolled-back commits against the real current month). Tests still run
inside the db_session fixture's per-test transaction, which is rolled
back afterward — belt and suspenders, not strictly required given the
synthetic month, but it's the same isolation every other DB-backed test
in this suite gets for free."""

from datetime import date

import pytest
from sqlalchemy import select

from gnt.config import get_settings
from gnt.db.models import LlmUsage
from gnt.db.org import ensure_org
from gnt.db.rls import scope_to_org
from gnt.llm_quota import (
    LlmQuotaExceededError,
    check_llm_quota,
    enforce_llm_quota,
    get_llm_quota_status,
    record_llm_usage,
)

_MONTH = date(2099, 1, 15)


async def _llm_usage_row(db_session, org_id: str) -> LlmUsage | None:
    await scope_to_org(db_session, org_id)
    return (
        await db_session.execute(
            select(LlmUsage).where(LlmUsage.org_id == org_id, LlmUsage.month == _MONTH.replace(day=1))
        )
    ).scalar_one_or_none()


# --- get_llm_quota_status / check_llm_quota — basic reads --------------


async def test_status_defaults_to_zero_spend_when_no_rows_exist(db_session, org_a):
    await ensure_org(db_session, org_a)
    await db_session.commit()

    status = await get_llm_quota_status(org_a, today=_MONTH)
    assert status.org_spent_micros == 0
    assert status.global_spent_micros == 0
    assert status.ok is True
    assert await check_llm_quota(org_a, today=_MONTH) is True


# --- per-org quota blocks once exceeded ---------------------------------


async def test_check_llm_quota_blocks_once_org_quota_exceeded(db_session, org_a, monkeypatch):
    monkeypatch.setattr(get_settings(), "llm_monthly_quota_per_org_usd", 0.001)
    await ensure_org(db_session, org_a)
    await db_session.commit()

    assert await check_llm_quota(org_a, today=_MONTH) is True

    # Haiku 4.5 pricing: $1/$5 per MTok — 1000 input + 1000 output tokens
    # costs ($1*1000 + $5*1000)/1_000_000 = $0.006, comfortably over the
    # $0.001 quota set above.
    await record_llm_usage(org_a, "claude-haiku-4-5", 1000, 1000, today=_MONTH)

    assert await check_llm_quota(org_a, today=_MONTH) is False
    with pytest.raises(LlmQuotaExceededError, match="monthly LLM usage quota exceeded"):
        await enforce_llm_quota(org_a, today=_MONTH)


async def test_tenant_isolation_org_b_not_blocked_by_org_as_exhausted_quota(
    db_session, org_a, org_b, monkeypatch
):
    """The plan's automatic-rejection non-negotiable: one org's exhausted
    quota must never block a different org."""
    monkeypatch.setattr(get_settings(), "llm_monthly_quota_per_org_usd", 0.001)
    await ensure_org(db_session, org_a)
    await ensure_org(db_session, org_b)
    await db_session.commit()

    await record_llm_usage(org_a, "claude-haiku-4-5", 1000, 1000, today=_MONTH)

    assert await check_llm_quota(org_a, today=_MONTH) is False
    assert await check_llm_quota(org_b, today=_MONTH) is True
    await enforce_llm_quota(org_b, today=_MONTH)  # must not raise


# --- global circuit breaker ---------------------------------------------


async def test_global_circuit_breaker_blocks_at_100_percent(db_session, org_a, org_b, monkeypatch):
    """A different org, comfortably under its OWN per-org quota, is still
    blocked once the GLOBAL cap is reached — proves the two gates are
    independent, and the global one wins even when the per-org one
    wouldn't have fired."""
    monkeypatch.setattr(get_settings(), "llm_monthly_quota_per_org_usd", 1000.0)  # effectively unlimited
    monkeypatch.setattr(get_settings(), "llm_global_monthly_cap_usd", 0.001)
    await ensure_org(db_session, org_a)
    await ensure_org(db_session, org_b)
    await db_session.commit()

    await record_llm_usage(org_a, "claude-haiku-4-5", 1000, 1000, today=_MONTH)

    status_b = await get_llm_quota_status(org_b, today=_MONTH)
    assert status_b.org_exceeded is False  # nowhere near its own (huge) quota
    assert status_b.global_exceeded is True
    assert await check_llm_quota(org_b, today=_MONTH) is False
    with pytest.raises(LlmQuotaExceededError, match="global monthly LLM spend cap reached"):
        await enforce_llm_quota(org_b, today=_MONTH)


# --- record_llm_usage: atomic upsert, real pricing -----------------------


async def test_record_llm_usage_increments_not_overwrites(db_session, org_a):
    await ensure_org(db_session, org_a)
    await db_session.commit()

    await record_llm_usage(org_a, "claude-haiku-4-5", 100, 20, today=_MONTH)
    await record_llm_usage(org_a, "claude-haiku-4-5", 50, 10, today=_MONTH)

    row = await _llm_usage_row(db_session, org_a)
    assert row is not None
    assert row.input_tokens == 150
    assert row.output_tokens == 30


async def test_record_llm_usage_uses_real_haiku_pricing(db_session, org_a):
    await ensure_org(db_session, org_a)
    await db_session.commit()

    # $1.00/$5.00 per MTok: (200_000 * 1.00 + 40_000 * 5.00) / 1_000_000
    # = (200_000 + 200_000) / 1_000_000 = $0.4 = 400_000 micros.
    await record_llm_usage(org_a, "claude-haiku-4-5", 200_000, 40_000, today=_MONTH)

    row = await _llm_usage_row(db_session, org_a)
    assert row is not None
    assert row.estimated_cost_micros == 400_000


async def test_record_llm_usage_unknown_model_falls_back_and_warns(db_session, org_a, monkeypatch):
    """Never invents a price silently — an unpriced model still gets
    recorded (so spend isn't lost), using the conservative Sonnet-tier
    fallback, and raises a Sentry breadcrumb so the pricing table gets a
    real entry."""
    warned = []

    def _capture_message(message, level=None):
        warned.append((message, level))

    monkeypatch.setattr("gnt.llm_quota.sentry_sdk.capture_message", _capture_message)
    await ensure_org(db_session, org_a)
    await db_session.commit()

    await record_llm_usage(org_a, "claude-not-a-real-model", 100_000, 100_000, today=_MONTH)

    row = await _llm_usage_row(db_session, org_a)
    assert row is not None
    # Fallback pricing $3/$15 per MTok: (100_000*3 + 100_000*15)/1_000_000 = $1.8
    assert row.estimated_cost_micros == 1_800_000
    assert any("no pricing entry" in message for message, level in warned)


# --- alert thresholds: fire once per crossing, at the right severities --


async def test_alerts_fire_once_per_threshold_in_order(db_session, org_a, monkeypatch):
    monkeypatch.setattr(get_settings(), "llm_global_monthly_cap_usd", 1.00)
    await ensure_org(db_session, org_a)
    await db_session.commit()

    captured: list[tuple[str, str]] = []

    def _capture_message(message, level=None):
        captured.append((message, level))

    monkeypatch.setattr("gnt.llm_quota.sentry_sdk.capture_message", _capture_message)

    # Each call is priced at $1/$5 per MTok; 100_000 input + 0 output =
    # $0.10 per call. Ten calls reach exactly the $1.00 cap; thresholds at
    # 50%/80%/100% land on calls 5, 8, and 10 respectively.
    for _ in range(10):
        await record_llm_usage(org_a, "claude-haiku-4-5", 100_000, 0, today=_MONTH)

    levels_fired = [level for _message, level in captured]
    assert levels_fired == ["warning", "error", "fatal"]

    # A further call past 100% must not re-fire any threshold — each one
    # is a one-time-per-month idempotency marker (see LlmUsageGlobal's
    # alert_*_sent_at columns), not a level than re-triggers on every call
    # once crossed.
    await record_llm_usage(org_a, "claude-haiku-4-5", 100_000, 0, today=_MONTH)
    assert len(captured) == 3


async def test_alert_thresholds_are_scoped_to_a_single_month(db_session, org_a, monkeypatch):
    """A pinned month's alert idempotency markers must not leak into a
    different month's row — otherwise a real circuit-breaker trip in
    January would silently suppress February's first-ever 50% alert."""
    monkeypatch.setattr(get_settings(), "llm_global_monthly_cap_usd", 0.10)
    await ensure_org(db_session, org_a)
    await db_session.commit()

    captured: list[tuple[str, str]] = []
    monkeypatch.setattr(
        "gnt.llm_quota.sentry_sdk.capture_message", lambda message, level=None: captured.append((message, level))
    )

    other_month = date(2099, 2, 15)
    await record_llm_usage(org_a, "claude-haiku-4-5", 100_000, 0, today=_MONTH)  # $0.10 -> crosses all 3
    assert len(captured) == 3

    captured.clear()
    await record_llm_usage(org_a, "claude-haiku-4-5", 100_000, 0, today=other_month)
    assert len(captured) == 3  # fresh row for a different month, fires again


# --- fail closed on infra failure ----------------------------------------


async def test_get_llm_quota_status_fails_closed_on_db_error(monkeypatch):
    """Same discipline rate_limit.check_rate_limit already established for
    a Redis outage: a DB error while reading spend must propagate, never
    silently resolve to 'ok' — that would defeat the entire cost gate."""

    class _BrokenSessionFactory:
        def __call__(self):
            raise RuntimeError("could not connect to postgres")

    monkeypatch.setattr("gnt.llm_quota.get_sessionmaker", lambda: _BrokenSessionFactory())

    with pytest.raises(RuntimeError, match="could not connect to postgres"):
        await get_llm_quota_status("org_a", today=_MONTH)
    with pytest.raises(RuntimeError, match="could not connect to postgres"):
        await check_llm_quota("org_a", today=_MONTH)
    with pytest.raises(RuntimeError, match="could not connect to postgres"):
        await enforce_llm_quota("org_a", today=_MONTH)


# --- the quota machinery itself never calls the paid Anthropic API ------


async def test_llm_quota_module_never_touches_the_anthropic_client(db_session, org_a, monkeypatch):
    """gnt.llm_quota has no reason to ever construct an Anthropic client —
    it only reads/writes Postgres. Guards against a future edit
    accidentally wiring in a real (billed) call: get_client raising here
    means any accidental use would blow up loudly instead of quietly
    spending money in a test run."""

    def _must_not_be_called(*args, **kwargs):
        raise AssertionError("gnt.llm_quota must never call the real Anthropic client")

    monkeypatch.setattr("gnt.anthropic_client.get_client", _must_not_be_called)
    await ensure_org(db_session, org_a)
    await db_session.commit()

    await get_llm_quota_status(org_a, today=_MONTH)
    await check_llm_quota(org_a, today=_MONTH)
    await enforce_llm_quota(org_a, today=_MONTH)
    await record_llm_usage(org_a, "claude-haiku-4-5", 100, 20, today=_MONTH)
