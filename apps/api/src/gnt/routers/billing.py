from datetime import datetime, timezone
from typing import Literal

import stripe
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.auth.better_auth import OrgContext, require_admin
from gnt.billing import (
    BillingNotConfigured,
    apply_webhook_event,
    cancel_subscription,
    create_checkout_session,
    create_portal_session,
    get_default_payment_method,
    is_org_entitled,
    list_invoices,
    verify_webhook_signature,
)
from gnt.config import get_settings
from gnt.db.models import Org
from gnt.db.org import ensure_org
from gnt.db.rls import scope_to_org
from gnt.db.session import get_cron_session, get_session
from gnt.email import send_subscription_canceled_email
from gnt.org_contacts import get_digest_recipients
from gnt.plan_limits import get_plan_action_usage, org_plan_tier

router = APIRouter(prefix="/v1/billing", tags=["billing"])


class CheckoutRequest(BaseModel):
    tier: Literal["base", "pro"] = "base"


class CheckoutResponse(BaseModel):
    url: str


class PortalResponse(BaseModel):
    url: str


class BillingStatus(BaseModel):
    entitled: bool
    subscription_status: str | None
    trial_ends_at: str | None
    plan_tier: str
    monthly_actions_used: int
    monthly_actions_cap: int
    cancel_at_period_end: bool
    current_period_end: str | None


class CancelResponse(BaseModel):
    cancel_at: str


class PaymentMethodInfo(BaseModel):
    brand: str
    last4: str
    exp_month: int
    exp_year: int


class InvoiceInfo(BaseModel):
    id: str
    number: str | None
    created: str
    status: str | None
    amount_paid: int
    currency: str
    hosted_invoice_url: str | None
    invoice_pdf: str | None


@router.get("/status", response_model=BillingStatus)
async def billing_status(
    org: OrgContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
):
    # is_org_entitled provisions the org row (ensure_org) if it doesn't
    # already exist, so the row is guaranteed present by the time the
    # SELECT below runs.
    entitled = await is_org_entitled(session, org.org_id)
    row = (await session.execute(select(Org).where(Org.id == org.org_id))).scalar_one()
    used, cap = await get_plan_action_usage(org.org_id)
    return BillingStatus(
        entitled=entitled,
        subscription_status=row.subscription_status,
        trial_ends_at=row.trial_ends_at.isoformat() if row.trial_ends_at else None,
        plan_tier=await org_plan_tier(session, org.org_id),
        monthly_actions_used=used,
        monthly_actions_cap=cap,
        cancel_at_period_end=row.cancel_at_period_end,
        current_period_end=row.current_period_end.isoformat() if row.current_period_end else None,
    )


@router.get("/payment-method", response_model=PaymentMethodInfo | None)
async def payment_method(
    org: OrgContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
):
    row = (await session.execute(select(Org).where(Org.id == org.org_id))).scalar_one_or_none()
    if row is None:
        return None
    try:
        pm = await get_default_payment_method(row)
    except BillingNotConfigured as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
    if pm is None:
        return None
    card = pm.card
    return PaymentMethodInfo(brand=card.brand, last4=card.last4, exp_month=card.exp_month, exp_year=card.exp_year)


@router.get("/invoices", response_model=list[InvoiceInfo])
async def invoices(
    org: OrgContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
):
    row = (await session.execute(select(Org).where(Org.id == org.org_id))).scalar_one_or_none()
    if row is None:
        return []
    try:
        rows = await list_invoices(row)
    except BillingNotConfigured as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
    return [
        InvoiceInfo(
            id=inv.id,
            number=inv.number,
            created=datetime.fromtimestamp(inv.created, tz=timezone.utc).isoformat(),
            status=inv.status,
            amount_paid=inv.amount_paid,
            currency=inv.currency,
            hosted_invoice_url=inv.hosted_invoice_url,
            invoice_pdf=inv.invoice_pdf,
        )
        for inv in rows
    ]


@router.post("/checkout", response_model=CheckoutResponse)
async def checkout(
    # Defaulted, not required — apps/cli's `gnt billing` (and any other
    # existing caller) POSTs with no body at all today; a required body
    # param would 422 every one of those instead of defaulting to base.
    body: CheckoutRequest = CheckoutRequest(),
    org: OrgContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
):
    await ensure_org(session, org.org_id)
    await session.commit()
    # commit() ends the transaction ensure_org's scope_to_org call scoped
    # (app.current_org is transaction-local) -- without re-scoping, the
    # SELECT below runs unscoped and RLS hides the row it just inserted,
    # same bug billing.is_org_entitled hit and fixed for the same reason.
    #
    # The comment above was written when this bug was first found and
    # "fixed" earlier the same day -- the call below was never actually
    # added, only the comment and the now-explained import. Every brand
    # new org's first checkout attempt threw NoResultFound in production
    # (confirmed via Railway logs and a real signed-up-through-the-UI
    # WebKit repro) until this was caught by re-testing the live site.
    await scope_to_org(session, org.org_id)
    row = (await session.execute(select(Org).where(Org.id == org.org_id))).scalar_one()
    web_origin = get_settings().web_origin
    try:
        url = await create_checkout_session(
            org.org_id,
            success_url=f"{web_origin}/billing/success",
            cancel_url=f"{web_origin}/billing/cancel",
            tier=body.tier,
            # Trial is a base-tier-only offer -- pro is billed immediately.
            # Also only an org's first-ever checkout gets one -- once it has
            # a Stripe customer, it's already had its one trial, so
            # canceling and resubscribing can't be used to stack free ones.
            trial_days=(
                get_settings().billing_trial_days if body.tier == "base" and not row.stripe_customer_id else None
            ),
        )
    except BillingNotConfigured as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
    return CheckoutResponse(url=url)


@router.post("/portal", response_model=PortalResponse)
async def portal(
    org: OrgContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
):
    row = (await session.execute(select(Org).where(Org.id == org.org_id))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="org not found")
    web_origin = get_settings().web_origin
    try:
        url = await create_portal_session(row, return_url=f"{web_origin}/")
    except BillingNotConfigured as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
    return PortalResponse(url=url)


@router.post("/cancel", response_model=CancelResponse)
async def cancel(
    org: OrgContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
):
    """In-app cancel -- the whole point is not sending the customer to
    Stripe's portal for this. Schedules cancellation at period end (see
    cancel_subscription's own docstring) and confirms by email right
    away, synchronously, rather than waiting on the webhook that also
    syncs this same state for cancellations started elsewhere."""
    row = (await session.execute(select(Org).where(Org.id == org.org_id))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="org not found")
    try:
        cancel_at = await cancel_subscription(row)
    except BillingNotConfigured as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
    await session.commit()
    recipients = await get_digest_recipients(session, org.org_id)
    await send_subscription_canceled_email(recipients, org.org_id, row.plan_tier or "base", cancel_at)
    return CancelResponse(cancel_at=cancel_at.isoformat())


@router.post("/webhook")
async def webhook(request: Request, session: AsyncSession = Depends(get_cron_session)):
    # gnt_cron (BYPASSRLS), not the default gnt_app session -- Stripe's
    # webhook is HMAC-authenticated (verify_webhook_signature below), not
    # org-scoped, and apply_webhook_event's subscription-keyed branches
    # have to look an org up by stripe_subscription_id before they know
    # its org_id at all -- there's no org_id yet to scope_to_org() with.
    # Confirmed live: every webhook branch silently no-op'd under the
    # ordinary RLS-enforced session (RLS hides every row when the GUC
    # is unset), so Stripe subscription state never once reached the DB.
    raw_body = await request.body()
    sig_header = request.headers.get("stripe-signature")
    if not sig_header:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="missing stripe-signature header")

    try:
        event = verify_webhook_signature(raw_body, sig_header)
    except BillingNotConfigured as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
    except stripe.SignatureVerificationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid signature") from exc

    # Unhandled event types 200 harmlessly rather than erroring -- Stripe
    # retries on non-2xx, and there's no reason to retry an event this
    # handler was never going to act on anyway.
    await apply_webhook_event(event, session)
    return {"received": True}
