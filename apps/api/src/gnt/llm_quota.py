"""Per-org monthly LLM spend quota, plus a global aggregate circuit
breaker. check_action made every agent decision an LLM call on the bill;
ingestion multiplies that exposure. Nothing before this tracked dollars —
rate_limit.py's check_rate_limit/check_sliding_window_rate_limit bound
REQUEST COUNT per org (abuse), and roi_counters (migration 0023) counts
call VOLUME per org/day for the customer-facing ROI number — neither
tracks spend, and conflating the two would be wrong: an org could be
well under its request rate limit and still be burning real money on
long completions.

Enforced BEFORE the paid call fires, at all three LLM-backed call sites:
action_check.py's judge_action (check_action — the highest-volume one,
runs on every agent action check), pipeline/rule_conflict.py's
judge_conflict (propose_rule's soft conflict check, and the nightly
contradiction sweep in workers/tasks_contradictions.py). Recorded AFTER
each call succeeds, using the real usage the Anthropic response reports —
not a flat per-call estimate — so the running total tracks actual spend,
not a worst-case guess.

Two-tier shape, mirroring rate_limit.py's own check_rate_limit /
_enforce_rate_limit split: get_llm_quota_status/check_llm_quota return a
plain status/bool (no exception) for callers that want a quiet
check-then-skip loop (tasks_contradictions.py's per-org sweep, right
alongside its existing comparisons/issues budget checks); enforce_llm_quota
raises for callers that already have a catch-all around the paid call and
want the quota gate to fall into that same degrade-safely path
(action_check.evaluate_action, pipeline.rule_conflict.find_conflict)
instead of threading a bool check through their own control flow. Not a
literal reuse of check_rate_limit, though — that's an hourly-window Redis
counter; this is a monthly-aggregate Postgres one, so the two share a
shape, not an implementation.

Fails closed on infra failure, same discipline check_rate_limit already
established for a Redis outage (see tests/test_rate_limit.py): a DB error
while reading spend propagates rather than silently returning "ok", which
would defeat the entire point of a cost gate. Each of the three call sites
already has its own catch-all around the paid call (action_check's
needs_human degrade, rule_conflict's "any failure = no conflict",
tasks_contradictions' per-org sweep's own quiet budget-exhausted break),
so this doesn't add new unhandled-exception risk anywhere it's wired in.
"""

from dataclasses import dataclass
from datetime import date, datetime, timezone

import sentry_sdk
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.config import get_settings
from gnt.db.models import LlmUsage, LlmUsageGlobal
from gnt.db.rls import scope_to_org
from gnt.db.session import get_sessionmaker

# Approximate, source: platform.claude.com/docs/en/pricing, cached
# 2026-06-24. Dollars per 1,000,000 tokens, as (input, output) — the only
# two models config.py's check_action_model/rule_merge_model are set to
# today or call out as the near-term swap target (see those settings'
# own comments — "swap back to claude-sonnet-5 once past validation").
# Update this table before pointing either setting at a model not listed
# here.
_MODEL_PRICING_PER_MTOK_USD: dict[str, tuple[float, float]] = {
    "claude-haiku-4-5": (1.00, 5.00),
    "claude-sonnet-5": (3.00, 15.00),
}
# Used only if a model isn't in the table above — conservative (priced at
# the more expensive Sonnet tier) rather than silently free, with a
# Sentry breadcrumb so the table gets a real entry instead of this
# estimate quietly going stale.
_FALLBACK_PRICING_PER_MTOK_USD = (3.00, 15.00)

_MICROS_PER_DOLLAR = 1_000_000

# Fixed at 50/80/100 percent (founder-alert checkpoints) rather than a
# Settings knob — these are deliberate product thresholds, not a number
# this codebase's own judgment picked, so there's nothing to tune
# per-deploy. Each tuple is (fraction of the global cap, Sentry level,
# the LlmUsageGlobal column that marks "already sent this month").
_ALERT_THRESHOLDS: tuple[tuple[float, str, str], ...] = (
    (0.5, "warning", "alert_50_sent_at"),
    (0.8, "error", "alert_80_sent_at"),
    (1.0, "fatal", "alert_100_sent_at"),
)


class LlmQuotaExceededError(RuntimeError):
    """Raised by enforce_llm_quota when this org's monthly quota or the
    global circuit breaker is already at/over its cap."""


def _dollars_to_micros(dollars: float) -> int:
    return round(dollars * _MICROS_PER_DOLLAR)


def _micros_to_dollars(micros: int) -> float:
    return micros / _MICROS_PER_DOLLAR


def _current_month(today: date | None = None) -> date:
    # UTC, not the server's local date — see roi_summary.build_roi_summary's
    # matching comment. A monthly spend cap (especially the org-independent
    # global circuit breaker) has to reset at the same instant regardless of
    # which timezone the deployed container's clock happens to be in.
    return (today or datetime.now(timezone.utc).date()).replace(day=1)


def _estimate_cost_micros(model: str, input_tokens: int, output_tokens: int) -> int:
    pricing = _MODEL_PRICING_PER_MTOK_USD.get(model)
    if pricing is None:
        sentry_sdk.capture_message(
            f"llm_quota: no pricing entry for model {model!r}; using fallback estimate",
            level="warning",
        )
        pricing = _FALLBACK_PRICING_PER_MTOK_USD
    input_price, output_price = pricing
    dollars = (input_tokens * input_price + output_tokens * output_price) / 1_000_000
    return round(dollars * _MICROS_PER_DOLLAR)


@dataclass
class LlmQuotaStatus:
    org_spent_micros: int
    org_quota_micros: int
    global_spent_micros: int
    global_cap_micros: int

    @property
    def org_exceeded(self) -> bool:
        # A configured quota of $0 (or negative, though Settings' Field(ge=0)
        # rules that out) is treated as "no cap set" rather than "block
        # everything" — matches how the same >0 guard reads in
        # _newly_crossed_thresholds below for the global cap.
        return self.org_quota_micros > 0 and self.org_spent_micros >= self.org_quota_micros

    @property
    def global_exceeded(self) -> bool:
        return self.global_cap_micros > 0 and self.global_spent_micros >= self.global_cap_micros

    @property
    def ok(self) -> bool:
        return not self.org_exceeded and not self.global_exceeded


async def get_llm_quota_status(org_id: str, *, today: date | None = None) -> LlmQuotaStatus:
    """Reads this org's and the global current-month spend against the
    configured caps. No exception handling here beyond what SQLAlchemy
    itself raises — a DB failure propagates to the caller (fail closed;
    see module docstring)."""
    settings = get_settings()
    month = _current_month(today)
    session_factory = get_sessionmaker()
    async with session_factory() as session:
        await scope_to_org(session, org_id)
        org_row = (
            await session.execute(
                select(LlmUsage).where(LlmUsage.org_id == org_id, LlmUsage.month == month)
            )
        ).scalar_one_or_none()
        global_row = (
            await session.execute(select(LlmUsageGlobal).where(LlmUsageGlobal.month == month))
        ).scalar_one_or_none()

    return LlmQuotaStatus(
        org_spent_micros=org_row.estimated_cost_micros if org_row else 0,
        org_quota_micros=_dollars_to_micros(settings.llm_monthly_quota_per_org_usd),
        global_spent_micros=global_row.estimated_cost_micros if global_row else 0,
        global_cap_micros=_dollars_to_micros(settings.llm_global_monthly_cap_usd),
    )


async def check_llm_quota(org_id: str, *, today: date | None = None) -> bool:
    """True if org_id may fire another LLM-backed call right now. Plain
    bool, no exception, for callers that want a quiet check-then-skip
    loop — see workers/tasks_contradictions.py's per-pair budget check,
    right alongside its existing comparisons/issues caps. Still raises on
    a DB/infra failure while reading the status (see module docstring's
    fail-closed discipline)."""
    return (await get_llm_quota_status(org_id, today=today)).ok


async def enforce_llm_quota(org_id: str, *, today: date | None = None) -> None:
    """Raises LlmQuotaExceededError if org_id's own monthly quota or the
    global circuit breaker is already at/over its cap. For callers that
    already have a catch-all around the paid call itself (action_check,
    rule_conflict) and want the quota gate to fall into that same
    degrade-safely path rather than threading a bool check through their
    own control flow."""
    status = await get_llm_quota_status(org_id, today=today)
    if status.global_exceeded:
        raise LlmQuotaExceededError(
            f"global monthly LLM spend cap reached "
            f"(${_micros_to_dollars(status.global_spent_micros):.2f} of "
            f"${_micros_to_dollars(status.global_cap_micros):.2f}); LLM-backed calls are "
            "paused system-wide until next month"
        )
    if status.org_exceeded:
        raise LlmQuotaExceededError(
            f"monthly LLM usage quota exceeded for org {org_id} "
            f"(${_micros_to_dollars(status.org_spent_micros):.2f} of "
            f"${_micros_to_dollars(status.org_quota_micros):.2f})"
        )


async def _lock_global_row(session: AsyncSession, month: date) -> LlmUsageGlobal:
    """INSERT ... ON CONFLICT DO NOTHING first, then SELECT ... FOR
    UPDATE, so this always returns a locked row without a race between
    "row doesn't exist yet" and a concurrent caller inserting it first —
    the do-nothing insert makes the row's existence a given before the
    lock is taken, regardless of which caller created it."""
    await session.execute(
        insert(LlmUsageGlobal).values(month=month).on_conflict_do_nothing(index_elements=["month"])
    )
    return (
        await session.execute(
            select(LlmUsageGlobal).where(LlmUsageGlobal.month == month).with_for_update()
        )
    ).scalar_one()


def _newly_crossed_thresholds(
    new_micros: int, cap_micros: int, row: LlmUsageGlobal
) -> list[tuple[float, str]]:
    if cap_micros <= 0:
        return []
    crossed: list[tuple[float, str]] = []
    now = datetime.now(timezone.utc)
    for fraction, level, attr in _ALERT_THRESHOLDS:
        threshold_micros = cap_micros * fraction
        if new_micros >= threshold_micros and getattr(row, attr) is None:
            setattr(row, attr, now)
            crossed.append((fraction, level))
    return crossed


async def record_llm_usage(
    org_id: str, model: str, input_tokens: int, output_tokens: int, *, today: date | None = None
) -> None:
    """Best-effort — mirrors roi_metrics.bump_roi_counters exactly: any
    failure here is reported to Sentry and swallowed, never re-raised,
    since this runs AFTER a call that's already been made (and billed);
    failing loudly here can't undo that spend, only crash the caller for
    no benefit.

    Bumps this org's month row (roi_counters-style atomic upsert) and the
    global month row (locked via SELECT ... FOR UPDATE so a threshold
    crossing is detected — and alerted — exactly once, not once per
    concurrent caller past it) in the same transaction, so an org bump
    can never commit without its matching global bump."""
    cost_micros = _estimate_cost_micros(model, input_tokens, output_tokens)
    month = _current_month(today)
    session_factory = get_sessionmaker()
    crossed: list[tuple[float, str]] = []
    async with session_factory() as session:
        try:
            await scope_to_org(session, org_id)
            metrics = {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "estimated_cost_micros": cost_micros,
            }
            stmt = insert(LlmUsage).values(org_id=org_id, month=month, **metrics)
            stmt = stmt.on_conflict_do_update(
                index_elements=["org_id", "month"],
                set_={metric: getattr(LlmUsage, metric) + stmt.excluded[metric] for metric in metrics}
                | {"updated_at": func.now()},
            )
            await session.execute(stmt)

            global_row = await _lock_global_row(session, month)
            global_row.input_tokens += input_tokens
            global_row.output_tokens += output_tokens
            global_row.estimated_cost_micros += cost_micros
            cap_micros = _dollars_to_micros(get_settings().llm_global_monthly_cap_usd)
            crossed = _newly_crossed_thresholds(global_row.estimated_cost_micros, cap_micros, global_row)

            await session.commit()
        except Exception as exc:
            sentry_sdk.capture_exception(exc)
            await session.rollback()
            return

    for fraction, level in crossed:
        sentry_sdk.capture_message(
            f"gnt LLM spend circuit breaker: global monthly spend crossed {int(fraction * 100)}% "
            f"of the configured cap (${get_settings().llm_global_monthly_cap_usd:.2f}/mo)",
            level=level,
        )
