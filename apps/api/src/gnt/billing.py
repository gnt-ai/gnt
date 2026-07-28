"""Single flat tier ($29/mo), no metering — real usage data doesn't exist
yet to calibrate anything more granular. trial_ends_at is a purely local
gate (see db/org.py's ensure_org); Stripe only enters the picture once an
org actually goes through Checkout, at which point stripe_customer_id/
stripe_subscription_id/subscription_status get populated and kept in sync
by routers/billing.py's webhook handler.
"""

from datetime import date, datetime, timezone

import stripe
from fastapi import Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.auth.better_auth import OrgContext, get_current_org, require_admin
from gnt.config import get_settings
from gnt.db.models import Org
from gnt.db.org import ensure_org
from gnt.db.rls import scope_to_org
from gnt.db.session import get_session
from gnt.email import send_subscription_started_email
from gnt.org_contacts import get_digest_recipients

# Stripe's own subscription statuses that mean "keep serving them".
# past_due is included deliberately — a failed card shouldn't cut off
# access on the first retry attempt; Stripe's own dunning emails handle
# nudging the customer, and canceled (post-dunning) is what actually cuts
# access. incomplete/incomplete_expired/unpaid are excluded: those mean
# the subscription never successfully started.
_ACTIVE_SUBSCRIPTION_STATUSES = {"trialing", "active", "past_due"}


class BillingNotConfigured(RuntimeError):
    """Stripe env vars aren't set — distinct from a real Stripe API error
    so callers can tell "we forgot to configure this" apart from "Stripe
    rejected the request"."""


def _client() -> stripe.StripeClient:
    settings = get_settings()
    if not settings.stripe_secret_key:
        raise BillingNotConfigured("STRIPE_SECRET_KEY is not configured")
    return stripe.StripeClient(settings.stripe_secret_key)


async def is_org_entitled(session: AsyncSession, org_id: str) -> bool:
    """Trial window OR a Stripe subscription in a status that means keep
    serving them. Calls ensure_org first rather than treating a missing
    row as automatically unentitled: an org whose first-ever action is
    this check (propose a rule, hit the MCP endpoint) hasn't necessarily
    called ensure_org anywhere else yet, and a brand-new org should get
    its trial window, not an incorrect denial. ensure_org is a no-op
    (ON CONFLICT DO NOTHING) for an org that already exists."""
    await ensure_org(session, org_id)
    await session.commit()
    # commit() ends the transaction ensure_org's scope_to_org call scoped
    # (set_config(..., true) is transaction-local, same as SET LOCAL) --
    # the GUC reads back empty immediately after commit(). Without
    # re-scoping here, the SELECT below runs unscoped and RLS hides every
    # row, including the one ensure_org just inserted -- every org's
    # first-ever entitlement check (propose a rule, hit the MCP endpoint)
    # threw NoResultFound.
    await scope_to_org(session, org_id)
    org = (await session.execute(select(Org).where(Org.id == org_id))).scalar_one()
    if org.subscription_status in _ACTIVE_SUBSCRIPTION_STATUSES:
        return True
    return org.trial_ends_at is not None and org.trial_ends_at > datetime.now(timezone.utc)


async def require_entitled_org(
    org: OrgContext = Depends(get_current_org),
    session: AsyncSession = Depends(get_session),
) -> OrgContext:
    """A FastAPI dependency, composable anywhere get_current_org already
    is — routers/skill_packs.py's latest_skill_pack depends on this
    instead of get_current_org directly, so real product value (the
    compiled pack download) stays entitlement-gated."""
    if not await is_org_entitled(session, org.org_id):
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail="Trial expired and no active subscription. Run `gnt billing` to subscribe.",
        )
    return org


async def require_entitled_admin(
    org: OrgContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> OrgContext:
    """Same gate as require_entitled_org, composed on top of require_admin
    instead of get_current_org — for the handful of admin-only routes
    (propose_rule) that are themselves real value delivery, not just
    account management, but that already need admin's own role check
    too."""
    if not await is_org_entitled(session, org.org_id):
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail="Trial expired and no active subscription. Run `gnt billing` to subscribe.",
        )
    return org


def _price_id_for_tier(tier: str) -> str:
    settings = get_settings()
    price_id = {"base": settings.stripe_price_id, "pro": settings.stripe_price_id_pro}.get(tier)
    if not price_id:
        env_var = "STRIPE_PRICE_ID" if tier == "base" else "STRIPE_PRICE_ID_PRO"
        raise BillingNotConfigured(f"{env_var} is not configured")
    return price_id


async def create_checkout_session(
    org_id: str, success_url: str, cancel_url: str, tier: str = "base", trial_days: int | None = None
) -> str:
    price_id = _price_id_for_tier(tier)
    client = _client()
    subscription_data: dict = {"metadata": {"org_id": org_id}}
    if trial_days:
        # A card is still collected up front -- Checkout's own default for
        # subscription mode, trial or not -- just not charged until the
        # trial ends. The router only ever passes this for an org's first
        # checkout (no stripe_customer_id yet), so canceling and
        # resubscribing can't be used to stack free trials.
        subscription_data["trial_period_days"] = trial_days
    checkout_session = await client.v1.checkout.sessions.create_async(
        {
            "mode": "subscription",
            "line_items": [{"price": price_id, "quantity": 1}],
            "success_url": success_url,
            "cancel_url": cancel_url,
            # Read back in the webhook handler to map the resulting
            # customer/subscription to an org — Checkout Sessions don't
            # otherwise carry any of our own identifiers.
            "client_reference_id": org_id,
            "subscription_data": subscription_data,
        },
        {
            # Bounds a retried/duplicate POST /v1/billing/checkout (network
            # blip, client retry) to the same Stripe Checkout Session for the
            # rest of the day, instead of minting a second one an org could
            # end up completing twice. Scoped to a calendar day, not org_id
            # alone, so it never blocks a genuinely new attempt tomorrow.
            # Includes tier so switching tiers the same day isn't bounced
            # into the previous attempt's stale session.
            "idempotency_key": f"checkout-{org_id}-{tier}-{date.today().isoformat()}",
        },
    )
    if not checkout_session.url:
        raise RuntimeError("Stripe created a checkout session but returned no url")
    return checkout_session.url


async def create_portal_session(org: Org, return_url: str) -> str:
    if not org.stripe_customer_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No billing account yet — run `gnt billing` to subscribe first.",
        )
    client = _client()
    try:
        portal_session = await client.v1.billing_portal.sessions.create_async(
            {"customer": org.stripe_customer_id, "return_url": return_url}
        )
    except stripe.InvalidRequestError as exc:
        # The stored customer id is stale — deleted straight from Stripe's
        # dashboard, or (in test/dev) never a real customer to begin with.
        # Without this, Stripe's raw "No such customer" propagates as an
        # unhandled 500 instead of a message telling them what to do.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Your billing account couldn't be found — contact support.",
        ) from exc
    return portal_session.url


async def cancel_subscription(org: Org) -> datetime:
    """In-app cancel -- schedules the subscription to end at the close of
    the current billing period (same as Stripe Checkout/Portal's own
    default cancel behavior: keep what was already paid for, no partial
    refund to reason about) without sending the customer to Stripe's
    portal at all. Writes cancel_at_period_end on the passed-in org
    directly so the caller's response/email/commit all see the change
    immediately, rather than waiting on the webhook round-trip that also
    syncs this same field (see apply_webhook_event) for any cancellation
    that happens outside the app."""
    if not org.stripe_subscription_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No active subscription to cancel.",
        )
    client = _client()
    try:
        subscription = await client.v1.subscriptions.update_async(
            org.stripe_subscription_id, {"cancel_at_period_end": True}
        )
    except stripe.InvalidRequestError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Your subscription couldn't be found — contact support.",
        ) from exc
    period_end = datetime.fromtimestamp(subscription.current_period_end, tz=timezone.utc)
    org.cancel_at_period_end = True
    org.current_period_end = period_end
    # Also bumps the same timestamp-guard field _apply_status compares
    # webhook events against (see its own docstring) -- without this, a
    # webhook event that's chronologically older than this direct write
    # (delayed delivery, a retry) could still pass the guard and stomp
    # cancel_at_period_end back to false, since nothing here had moved
    # subscription_status_synced_at forward to block it.
    org.subscription_status_synced_at = datetime.now(timezone.utc)
    return period_end


async def get_default_payment_method(org: Org) -> stripe.PaymentMethod | None:
    """The card the customer's subscription actually bills, not just "a"
    card on file — expands invoice_settings.default_payment_method so this
    is one Stripe call, not a retrieve-then-list round trip. Falls back to
    the first attached card if no default is set (Checkout doesn't always
    populate one), same "best available, not an error" posture as the
    portal/cancel flows above. Returns None (not a 404) for an org with no
    Stripe customer yet — the router turns that into 200 null, since "no
    card on file" is a normal state for a trialing org, not a failure."""
    if not org.stripe_customer_id:
        return None
    client = _client()
    customer = await client.v1.customers.retrieve_async(
        org.stripe_customer_id, {"expand": ["invoice_settings.default_payment_method"]}
    )
    default_pm = _field(_field(customer, "invoice_settings", {}), "default_payment_method")
    if default_pm and _field(default_pm, "type") == "card":
        return default_pm
    methods = await client.v1.payment_methods.list_async({"customer": org.stripe_customer_id, "type": "card"})
    return methods.data[0] if methods.data else None


async def list_invoices(org: Org, limit: int = 12) -> list[stripe.Invoice]:
    """Most-recent-first, same order Stripe already returns them in.
    Empty list (not an error) for an org with no Stripe customer yet."""
    if not org.stripe_customer_id:
        return []
    client = _client()
    invoices = await client.v1.invoices.list_async({"customer": org.stripe_customer_id, "limit": limit})
    return invoices.data


def verify_webhook_signature(payload: bytes, sig_header: str) -> stripe.Event:
    """Raises stripe.SignatureVerificationError on a bad/missing signature
    — the router translates that to a 400, same as any other malformed
    webhook delivery. HMAC verification is pure CPU, not I/O, so this
    stays synchronous rather than needing an async variant."""
    settings = get_settings()
    if not settings.stripe_webhook_secret:
        raise BillingNotConfigured("STRIPE_WEBHOOK_SECRET is not configured")
    return stripe.Webhook.construct_event(payload, sig_header, settings.stripe_webhook_secret)


def _tier_for_price_id(price_id: str | None) -> str | None:
    """Reverse of _price_id_for_tier — which tier a subscription's price id
    belongs to, or None if it matches neither configured price (an
    unrecognized price, or Stripe test-mode data against live settings).
    Unmatched deliberately leaves plan_tier untouched rather than guessing
    "base" — see apply_webhook_event's use of this."""
    settings = get_settings()
    if settings.stripe_price_id and price_id == settings.stripe_price_id:
        return "base"
    if settings.stripe_price_id_pro and price_id == settings.stripe_price_id_pro:
        return "pro"
    return None


def _field(obj, key: str, default=None):
    """`obj.get(key, default)`, but safe for a real stripe.StripeObject —
    confirmed live: StripeObject's own __getattr__ intercepts the `.get`
    lookup itself (not a real data key) and raises AttributeError instead
    of falling back to dict-like behavior, so `obj.get(...)` crashes on
    an actual webhook delivery even though it works fine against the
    plain dicts every existing test in test_billing.py constructs fake
    events from. `in`/`[]` both work correctly on StripeObject, unlike
    `.get`, so this is what every field read below goes through instead."""
    return obj[key] if key in obj else default


def _subscription_price_id(obj) -> str | None:
    items = _field(_field(obj, "items", {}), "data", [])
    if not items:
        return None
    return _field(_field(items[0], "price", {}), "id")


def _apply_status(
    org: Org,
    event: stripe.Event,
    status_value: str | None,
    tier: str | None = None,
    cancel_at_period_end: bool | None = None,
    current_period_end: datetime | None = None,
) -> bool:
    """Writes subscription_status (and plan_tier/cancel_at_period_end/
    current_period_end, if given) only if this event is at least as new as
    whatever we last applied — Stripe doesn't guarantee webhook delivery
    order, so without this a delayed/retried older event (e.g. a
    pre-cancellation "active" update arriving after the cancellation
    itself) could silently restore access, or an old tier/cancel state,
    after a real cancellation/upgrade. Returns whether the write happened,
    so callers can skip the commit otherwise. tier=None/
    cancel_at_period_end=None/current_period_end=None leave those fields
    untouched (checkout.session.completed doesn't carry any of them; the
    subscription.* events below do)."""
    event_time = datetime.fromtimestamp(event["created"], tz=timezone.utc)
    if org.subscription_status_synced_at is not None and event_time <= org.subscription_status_synced_at:
        return False
    org.subscription_status = status_value
    org.subscription_status_synced_at = event_time
    if tier is not None:
        org.plan_tier = tier
    if cancel_at_period_end is not None:
        org.cancel_at_period_end = cancel_at_period_end
    if current_period_end is not None:
        org.current_period_end = current_period_end
    return True


async def apply_webhook_event(event: stripe.Event, session: AsyncSession) -> None:
    """Keeps orgs.subscription_status (and the two Stripe id columns) in
    sync with Stripe's own view of the world. Deliberately narrow: only
    the events that change what "entitled" means get handled; anything
    else 200s harmlessly (see routers/billing.py) rather than erroring on
    an event type we don't act on."""
    obj = event["data"]["object"]

    if event["type"] == "checkout.session.completed":
        org_id = _field(obj, "client_reference_id")
        if not org_id:
            return
        org = (await session.execute(select(Org).where(Org.id == org_id))).scalar_one_or_none()
        if org is None:
            return
        org.stripe_customer_id = _field(obj, "customer")
        org.stripe_subscription_id = _field(obj, "subscription")
        # The subscription's own status arrives moments later via
        # customer.subscription.created/updated -- this just marks
        # "checkout definitely happened" so a webhook-ordering race
        # doesn't leave the org looking unentitled in between. Still
        # timestamp-guarded: if that subscription event already landed
        # first with a more accurate status, this doesn't stomp it.
        if _apply_status(org, event, "active"):
            await session.commit()
        return

    if event["type"] in ("customer.subscription.updated", "customer.subscription.created"):
        subscription_id = _field(obj, "id")
        org = (
            await session.execute(select(Org).where(Org.stripe_subscription_id == subscription_id))
        ).scalar_one_or_none()
        if org is None:
            # checkout.session.completed may not have landed yet — this
            # subscription's own metadata carries the same org_id we set
            # at Checkout creation (create_checkout_session), so it can
            # still be resolved and stamped with its real id here.
            org_id = _field(_field(obj, "metadata", {}), "org_id")
            if not org_id:
                return
            org = (await session.execute(select(Org).where(Org.id == org_id))).scalar_one_or_none()
            if org is None:
                return
            org.stripe_subscription_id = subscription_id
        tier = _tier_for_price_id(_subscription_price_id(obj))
        # Stripe always includes this field on a real subscription object
        # (never absent, just true/false) -- this is what keeps
        # cancel_at_period_end correct even for a cancellation started
        # outside the app (Stripe dashboard, a support agent's own portal
        # action), not just the in-app cancel_subscription() path.
        cancel_at_period_end = bool(_field(obj, "cancel_at_period_end", False))
        period_end_ts = _field(obj, "current_period_end")
        current_period_end = datetime.fromtimestamp(period_end_ts, tz=timezone.utc) if period_end_ts else None
        wrote = _apply_status(
            org,
            event,
            _field(obj, "status"),
            tier=tier,
            cancel_at_period_end=cancel_at_period_end,
            current_period_end=current_period_end,
        )
        if wrote:
            await session.commit()
        # "created" fires exactly once per subscription (Stripe's own
        # semantics — unlike "updated", which fires repeatedly over the
        # subscription's life), so this can't double-send on a later
        # plan change or renewal. Tier is only known here, not at
        # checkout.session.completed above, which is why the started
        # email lives on this branch instead of that one.
        if wrote and event["type"] == "customer.subscription.created" and tier:
            recipients = await get_digest_recipients(session, org.id)
            await send_subscription_started_email(recipients, org.id, tier)
        return

    if event["type"] == "customer.subscription.deleted":
        subscription_id = _field(obj, "id")
        org = (
            await session.execute(select(Org).where(Org.stripe_subscription_id == subscription_id))
        ).scalar_one_or_none()
        if org is None:
            return
        # The subscription is actually gone now -- "pending cancellation"
        # has resolved into "canceled", so this no longer applies.
        if _apply_status(org, event, "canceled", cancel_at_period_end=False):
            await session.commit()
        return
