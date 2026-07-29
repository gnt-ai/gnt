"""Resend-backed email sending for apps/api (Python side). Nothing in this
codebase sent email from Python before the weekly digest
(workers/tasks_digest.py) — apps/web/lib/email.ts already does this for Better Auth's login
OTP/invite emails, but that's Node, a separate process, a separate deploy
target (Vercel), and has no reason to import into apps/api.

Deliberately a plain httpx POST to Resend's API
(https://api.resend.com/emails), not the `resend` PyPI package — matches
this codebase's existing outbound-HTTP style (github/client.py's
httpx-based _call helper) instead of adding a new SDK dependency for one
POST endpoint.

Same graceful-absence discipline as email.ts's isEmailConfigured/sendEmail:
RESEND_API_KEY is optional (config.py), and is NOT yet set on Railway's
api/worker services as of this module's introduction — only apps/web on
Vercel has it. Every function here checks is_email_configured() first and
logs-and-returns rather than raising when it's unset, so the weekly digest
cron job (workers/tasks_digest.py) — and everything else in that ROI-
reporting feature that doesn't depend on email at all (the ROI aggregation
itself, `gnt status --org`) — keeps working with zero email capability until the
founder adds the real credentials.
"""

import json
from datetime import datetime

import httpx
import sentry_sdk

from gnt.config import get_settings

_RESEND_API_URL = "https://api.resend.com/emails"
_TIMEOUT_SECONDS = 10.0


def is_email_configured() -> bool:
    return bool(get_settings().resend_api_key)


async def send_email(*, to: str, subject: str, text: str, log_fallback: str) -> bool:
    """Sends one plain-text email via Resend. Returns whether it was
    actually sent (True) or skipped/failed (False) — callers that send a
    digest to several recipients use this to decide whether to log the
    org-level outcome as sent or skipped, without needing to inspect
    module internals.

    Never raises: a Resend outage or a bad response must not crash the
    nightly/weekly cron job it rides along in, the same "log clearly and
    move on" discipline as workers/tasks_contradictions.py's per-pair error
    handling. Structured stdout logging (same shape as
    mcp_server/server.py's _log_mcp_call) covers the expected "not
    configured yet" case; Sentry covers a genuine send failure once it is
    configured."""
    settings = get_settings()
    if not settings.resend_api_key:
        print(
            json.dumps(
                {
                    "event": "email_skipped",
                    "reason": "RESEND_API_KEY not set",
                    "detail": log_fallback,
                }
            )
        )
        return False

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_SECONDS) as client:
            response = await client.post(
                _RESEND_API_URL,
                headers={"Authorization": f"Bearer {settings.resend_api_key}"},
                json={
                    "from": settings.resend_from_email,
                    "to": [to],
                    "subject": subject,
                    "text": text,
                },
            )
        if response.status_code >= 400:
            sentry_sdk.capture_message(
                f"resend send failed ({response.status_code}): {response.text[:200]}",
                level="error",
            )
            print(json.dumps({"event": "email_failed", "status": response.status_code, "to": to}))
            return False
    except httpx.HTTPError as exc:
        sentry_sdk.capture_exception(exc)
        print(json.dumps({"event": "email_failed", "reason": "network error", "to": to}))
        return False

    print(json.dumps({"event": "email_sent", "to": to, "subject": subject}))
    return True


def render_weekly_digest(org_id: str, summary: dict) -> tuple[str, str]:
    """Builds the weekly digest's (subject, body) — plain text, real
    numbers, no invented urgency. Matches this codebase's own established
    voice (see `gnt gaps`/`gnt stale` CLI output: short, factual, a next
    step where there is one) rather than marketing copy.

    `summary` is workers/tasks_digest.py's build_digest_summary output —
    see that function's docstring for the exact shape."""
    roi = summary["roi"]
    current = roi["current"]
    prior = roi["prior"]
    gaps = summary["gaps"]
    stale_count = summary["stale_due_count"]

    subject = f"gnt.ai weekly digest: {current['actions_checked']} actions checked this week"

    lines = [
        f"Weekly summary for your org ({org_id}), the last {roi['window_days']} days"
        f" vs. the {roi['window_days']} before that:",
        "",
        f"Rules served: {current['rules_served']} ({_delta(current['rules_served'], prior['rules_served'])})",
        f"Actions checked: {current['actions_checked']} ({_delta(current['actions_checked'], prior['actions_checked'])})",
        f"  blocked: {current['actions_blocked']} ({_delta(current['actions_blocked'], prior['actions_blocked'])})",
        f"  needs human: {current['actions_needs_human']} ({_delta(current['actions_needs_human'], prior['actions_needs_human'])})",
        f"Coverage gaps (queries no rule covers yet): {gaps['current']} ({_delta(gaps['current'], gaps['prior'])})",
    ]
    if stale_count > 0:
        lines.append("")
        lines.append(
            f"{stale_count} approved rule{'s' if stale_count != 1 else ''} due for re-validation, "
            "confirm still true or open a deprecation/refresh PR. Run `gnt stale` for the list."
        )
    lines.append("")
    lines.append("Run `gnt gaps` to see the uncovered queries behind the coverage-gap count above.")

    return subject, "\n".join(lines)


def render_subscription_started(tier: str) -> tuple[str, str]:
    """(subject, body) for the email that fires the moment Stripe confirms
    a subscription actually started (apply_webhook_event's
    checkout.session.completed branch) -- same plain-text, factual voice
    as render_weekly_digest, not marketing copy."""
    label = "Pro" if tier == "pro" else "Base"
    subject = f"You're subscribed to gnt.ai {label}"
    body = (
        f"Your gnt.ai {label} subscription is active.\n\n"
        "Manage or cancel it any time from Settings → Billing — canceling doesn't need "
        "a trip through Stripe, it's one button in the app.\n\n"
        "Questions? Just reply to this email."
    )
    return subject, body


def render_subscription_canceled(tier: str, cancel_at: datetime) -> tuple[str, str]:
    """(subject, body) for the email that fires the moment an in-app
    cancel_subscription() call succeeds -- sent synchronously from the
    cancel endpoint itself (not the webhook) since the exact cancel_at
    date is already in hand there, and a customer canceling wants
    confirmation immediately, not whenever Stripe's webhook happens to
    land."""
    label = "Pro" if tier == "pro" else "Base"
    when = cancel_at.strftime("%B %-d, %Y")
    subject = "Your gnt.ai subscription is set to cancel"
    body = (
        f"Your gnt.ai {label} subscription is canceled.\n\n"
        f"You'll keep access until {when} — the end of your current billing period. "
        "No further charges after that.\n\n"
        "Changed your mind? Just start a new subscription from Settings → Billing any time "
        "before then."
    )
    return subject, body


def _delta(current: int, prior: int) -> str:
    diff = current - prior
    if diff == 0:
        return "flat vs. last week"
    sign = "+" if diff > 0 else ""
    return f"{sign}{diff} vs. last week"


async def send_weekly_digest(to: list[str], org_id: str, summary: dict) -> None:
    """Sends the same rendered digest to every contact email this org has
    (workers/tasks_digest.py's get_digest_recipients — typically the org's
    owner/admins). One Resend call per recipient, not a single multi-`to`
    call, so one bad address never suppresses delivery to the rest."""
    subject, text = render_weekly_digest(org_id, summary)
    for recipient in to:
        await send_email(
            to=recipient,
            subject=subject,
            text=text,
            log_fallback=f"weekly digest for org {org_id}",
        )


async def send_subscription_started_email(to: list[str], org_id: str, tier: str) -> None:
    subject, text = render_subscription_started(tier)
    for recipient in to:
        await send_email(
            to=recipient,
            subject=subject,
            text=text,
            log_fallback=f"subscription-started email for org {org_id}",
        )


async def send_subscription_canceled_email(to: list[str], org_id: str, tier: str, cancel_at: datetime) -> None:
    subject, text = render_subscription_canceled(tier, cancel_at)
    for recipient in to:
        await send_email(
            to=recipient,
            subject=subject,
            text=text,
            log_fallback=f"subscription-canceled email for org {org_id}",
        )
