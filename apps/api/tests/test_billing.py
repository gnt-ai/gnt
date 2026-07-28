"""Real tests against real Postgres for the billing/entitlement gate --
is_org_entitled's trial/subscription logic directly, plus end-to-end
proof that an expired org actually gets blocked at the two REST routes
wired up to require_entitled_org/require_entitled_admin (the skill-pack
download and propose_rule), not just that the helper function returns the
right bool in isolation.
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
import stripe
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from gnt.billing import (
    BillingNotConfigured,
    apply_webhook_event,
    cancel_subscription,
    create_checkout_session,
    create_portal_session,
    is_org_entitled,
)
from gnt.auth.better_auth import OrgContext
from gnt.config import get_settings
from gnt.db.models import Org
from gnt.db.org import ensure_org
from gnt.db.rls import scope_to_org
from gnt.db.session import get_cron_engine, get_cron_sessionmaker
from gnt.routers import billing as billing_router
from gnt.routers.billing import CheckoutRequest
from gnt.routers import rules as rules_router
from gnt.routers import skill_packs as skill_packs_router
from tests.conftest import TEST_DATABASE_URL, make_org_client


@pytest.fixture
def org_a() -> str:
    # Unique per test -- billing state (trial_ends_at, subscription_status)
    # is exactly the kind of thing that must not leak between tests, and
    # conftest's shared "org_test_a" would do that here.
    return f"org_test_billing_{uuid.uuid4().hex[:8]}"


async def _expire_trial(db_session, org_id: str) -> None:
    await ensure_org(db_session, org_id)
    await db_session.commit()
    org = (await db_session.execute(select(Org).where(Org.id == org_id))).scalar_one()
    org.trial_ends_at = datetime.now(timezone.utc) - timedelta(days=1)
    await db_session.commit()


async def test_new_org_is_entitled_during_trial(db_session, org_a):
    assert await is_org_entitled(db_session, org_a) is True


async def test_org_past_trial_without_subscription_is_not_entitled(db_session, org_a):
    await _expire_trial(db_session, org_a)
    assert await is_org_entitled(db_session, org_a) is False


@pytest.mark.parametrize("status", ["active", "trialing", "past_due"])
async def test_org_with_live_subscription_is_entitled_past_trial(db_session, org_a, status):
    await _expire_trial(db_session, org_a)
    org = (await db_session.execute(select(Org).where(Org.id == org_a))).scalar_one()
    org.subscription_status = status
    await db_session.commit()
    assert await is_org_entitled(db_session, org_a) is True


@pytest.mark.parametrize("status", ["canceled", "incomplete_expired", "unpaid"])
async def test_org_with_dead_subscription_is_not_entitled_past_trial(db_session, org_a, status):
    await _expire_trial(db_session, org_a)
    org = (await db_session.execute(select(Org).where(Org.id == org_a))).scalar_one()
    org.subscription_status = status
    await db_session.commit()
    assert await is_org_entitled(db_session, org_a) is False


async def test_skill_pack_download_blocked_after_trial_expires(db_session, test_app_factory, org_a):
    await _expire_trial(db_session, org_a)
    admin_a = make_org_client(
        test_app_factory, org_a, user_id="admin_a", role="admin", routers=[skill_packs_router.router]
    )
    async with admin_a as client:
        r = await client.get("/v1/skill-packs/latest.zip")
    assert r.status_code == 402


async def test_skill_pack_download_allowed_during_trial(db_session, test_app_factory, org_a):
    admin_a = make_org_client(
        test_app_factory, org_a, user_id="admin_a", role="admin", routers=[skill_packs_router.router]
    )
    async with admin_a as client:
        r = await client.get("/v1/skill-packs/latest.zip")
    # Entitlement gate passes through -- 404 here is "no pack compiled yet
    # for this brand-new org", not "blocked", which is the distinction
    # under test (contrast with the 402 case above).
    assert r.status_code == 404


async def test_propose_rule_blocked_after_trial_expires(db_session, test_app_factory, org_a):
    admin_a = make_org_client(test_app_factory, org_a, user_id="admin_a", role="admin", routers=[rules_router.router])
    async with admin_a as client:
        r = await client.post("/v1/rules", json={"title": "Refund window", "body": "Refunds within 30 days."})
        assert r.status_code == 201
        rule_id = r.json()["id"]
        r = await client.post(f"/v1/rules/{rule_id}/submit")
        assert r.status_code == 200

        await _expire_trial(db_session, org_a)

        r = await client.post(f"/v1/rules/{rule_id}/propose")
    assert r.status_code == 402


async def test_webhook_checkout_completed_activates_org(db_session, org_a):
    await ensure_org(db_session, org_a)
    await db_session.commit()

    event = {
        "type": "checkout.session.completed",
        "created": 1750000100,
        "data": {
            "object": {
                "client_reference_id": org_a,
                "customer": "cus_test123",
                "subscription": "sub_test123",
            }
        },
    }
    await apply_webhook_event(event, db_session)

    org = (await db_session.execute(select(Org).where(Org.id == org_a))).scalar_one()
    assert org.stripe_customer_id == "cus_test123"
    assert org.stripe_subscription_id == "sub_test123"
    assert org.subscription_status == "active"


async def test_webhook_handles_a_real_stripe_object_not_just_a_plain_dict(db_session, org_a, monkeypatch):
    """Regression test for a real production bug: every event["data"]["object"]
    apply_webhook_event reads is a genuine stripe.StripeObject on a real
    webhook delivery, not the plain dict every OTHER test in this file
    builds fake events from. StripeObject's own __getattr__ intercepts
    the `.get` lookup itself (it's not a real data key) and raises
    AttributeError instead of falling back to dict-like behavior --
    obj.get(...) crashed on every single real checkout/subscription
    webhook (confirmed via Railway logs: NoResultFound... no, an actual
    AttributeError: get, at the exact obj.get("client_reference_id")
    line this test exercises) while every test here kept passing, because
    a plain dict's own .get() works fine.

    Builds the same event this file's other checkout.session.completed
    test uses, but constructs the nested object via stripe.StripeObject's
    own construct_from -- confirmed separately that this reproduces the
    real AttributeError when .get() is called on it, and that bracket
    access / `in` both still work, which is what the fix (billing.py's
    _field helper) uses instead."""
    monkeypatch.setattr(get_settings(), "stripe_price_id", "price_base_test")
    monkeypatch.setattr(get_settings(), "stripe_price_id_pro", "price_pro_test")
    await ensure_org(db_session, org_a)
    await db_session.commit()

    checkout_obj = stripe.StripeObject.construct_from(
        {
            "client_reference_id": org_a,
            "customer": "cus_real_object_test",
            "subscription": "sub_real_object_test",
        },
        None,
    )
    await apply_webhook_event(
        {"type": "checkout.session.completed", "created": 1750000300, "data": {"object": checkout_obj}},
        db_session,
    )

    org = (await db_session.execute(select(Org).where(Org.id == org_a))).scalar_one()
    assert org.stripe_customer_id == "cus_real_object_test"
    assert org.subscription_status == "active"

    subscription_obj = stripe.StripeObject.construct_from(
        {
            "id": "sub_real_object_test",
            "status": "active",
            "items": {"data": [{"price": {"id": "price_pro_test"}}]},
        },
        None,
    )
    await apply_webhook_event(
        {"type": "customer.subscription.updated", "created": 1750000400, "data": {"object": subscription_obj}},
        db_session,
    )

    org = (await db_session.execute(select(Org).where(Org.id == org_a))).scalar_one()
    assert org.plan_tier == "pro"


async def test_webhook_subscription_created_resolves_org_by_metadata(db_session, org_a):
    # checkout.session.completed hasn't landed yet, so lookup by
    # stripe_subscription_id would miss -- falls back to the org_id Stripe
    # echoes back in the subscription's own metadata (set at Checkout
    # creation time via subscription_data.metadata).
    await ensure_org(db_session, org_a)
    await db_session.commit()

    event = {
        "type": "customer.subscription.created",
        "created": 1750000050,
        "data": {
            "object": {
                "id": "sub_test999",
                "status": "trialing",
                "metadata": {"org_id": org_a},
            }
        },
    }
    await apply_webhook_event(event, db_session)

    org = (await db_session.execute(select(Org).where(Org.id == org_a))).scalar_one()
    assert org.stripe_subscription_id == "sub_test999"
    assert org.subscription_status == "trialing"


async def test_webhook_subscription_updated_syncs_status(db_session, org_a):
    await ensure_org(db_session, org_a)
    org = (await db_session.execute(select(Org).where(Org.id == org_a))).scalar_one()
    org.stripe_subscription_id = "sub_test456"
    await db_session.commit()

    event = {
        "type": "customer.subscription.updated",
        "created": 1750000100,
        "data": {"object": {"id": "sub_test456", "status": "past_due"}},
    }
    await apply_webhook_event(event, db_session)

    org = (await db_session.execute(select(Org).where(Org.id == org_a))).scalar_one()
    assert org.subscription_status == "past_due"


async def test_webhook_subscription_deleted_cancels_org(db_session, org_a):
    await ensure_org(db_session, org_a)
    org = (await db_session.execute(select(Org).where(Org.id == org_a))).scalar_one()
    org.stripe_subscription_id = "sub_test789"
    org.subscription_status = "active"
    await db_session.commit()

    event = {
        "type": "customer.subscription.deleted",
        "created": 1750000100,
        "data": {"object": {"id": "sub_test789"}},
    }
    await apply_webhook_event(event, db_session)

    org = (await db_session.execute(select(Org).where(Org.id == org_a))).scalar_one()
    assert org.subscription_status == "canceled"


async def test_webhook_subscription_updated_syncs_cancel_at_period_end(db_session, org_a):
    # Covers a cancellation started outside the app entirely (Stripe
    # dashboard, a support agent's own portal action) -- the org's flag
    # still has to end up correct, not just the in-app cancel_subscription
    # path's own direct write.
    await ensure_org(db_session, org_a)
    org = (await db_session.execute(select(Org).where(Org.id == org_a))).scalar_one()
    org.stripe_subscription_id = "sub_cancel_flag"
    await db_session.commit()

    event = {
        "type": "customer.subscription.updated",
        "created": 1750000100,
        "data": {"object": {"id": "sub_cancel_flag", "status": "active", "cancel_at_period_end": True}},
    }
    await apply_webhook_event(event, db_session)

    org = (await db_session.execute(select(Org).where(Org.id == org_a))).scalar_one()
    assert org.cancel_at_period_end is True


async def test_webhook_subscription_deleted_resets_cancel_at_period_end(db_session, org_a):
    # The subscription is actually gone now -- "pending cancellation" has
    # resolved into "canceled", so the flag shouldn't still read true.
    await ensure_org(db_session, org_a)
    org = (await db_session.execute(select(Org).where(Org.id == org_a))).scalar_one()
    org.stripe_subscription_id = "sub_cancel_resolved"
    org.subscription_status = "active"
    org.cancel_at_period_end = True
    await db_session.commit()

    event = {
        "type": "customer.subscription.deleted",
        "created": 1750000100,
        "data": {"object": {"id": "sub_cancel_resolved"}},
    }
    await apply_webhook_event(event, db_session)

    org = (await db_session.execute(select(Org).where(Org.id == org_a))).scalar_one()
    assert org.cancel_at_period_end is False


async def test_webhook_subscription_created_with_known_tier_sends_started_email(db_session, org_a, monkeypatch):
    monkeypatch.setattr(get_settings(), "stripe_price_id", "price_base_test")
    monkeypatch.setattr(get_settings(), "stripe_price_id_pro", "price_pro_test")
    await ensure_org(db_session, org_a)
    await db_session.commit()

    sent = {}

    async def _fake_recipients(session, org_id):
        return ["owner@example.com"]

    async def _fake_send(to, org_id, tier):
        sent["to"] = to
        sent["org_id"] = org_id
        sent["tier"] = tier

    monkeypatch.setattr("gnt.billing.get_digest_recipients", _fake_recipients)
    monkeypatch.setattr("gnt.billing.send_subscription_started_email", _fake_send)

    event = {
        "type": "customer.subscription.created",
        "created": 1750000050,
        "data": {
            "object": {
                "id": "sub_started_email",
                "status": "trialing",
                "metadata": {"org_id": org_a},
                "items": {"data": [{"price": {"id": "price_base_test"}}]},
            }
        },
    }
    await apply_webhook_event(event, db_session)

    assert sent == {"to": ["owner@example.com"], "org_id": org_a, "tier": "base"}


async def test_webhook_subscription_created_without_resolvable_tier_sends_no_email(db_session, org_a, monkeypatch):
    # test_webhook_subscription_created_resolves_org_by_metadata's own
    # scenario (no items/price on the event) must not blow up trying to
    # email a tier it doesn't have -- this is the guard that prevents it.
    await ensure_org(db_session, org_a)
    await db_session.commit()

    called = False

    async def _fake_send(*_args, **_kwargs):
        nonlocal called
        called = True

    monkeypatch.setattr("gnt.billing.send_subscription_started_email", _fake_send)

    event = {
        "type": "customer.subscription.created",
        "created": 1750000050,
        "data": {"object": {"id": "sub_no_tier", "status": "trialing", "metadata": {"org_id": org_a}}},
    }
    await apply_webhook_event(event, db_session)

    assert called is False


async def test_webhook_stale_event_does_not_overwrite_newer_status(db_session, org_a):
    # Stripe doesn't guarantee webhook delivery order. A cancellation
    # arrives, then a delayed/retried "active" update from before the
    # cancellation shows up -- it must not resurrect access.
    await ensure_org(db_session, org_a)
    org = (await db_session.execute(select(Org).where(Org.id == org_a))).scalar_one()
    org.stripe_subscription_id = "sub_test_stale"
    await db_session.commit()

    cancellation = {
        "type": "customer.subscription.deleted",
        "created": 1750000200,
        "data": {"object": {"id": "sub_test_stale"}},
    }
    await apply_webhook_event(cancellation, db_session)

    stale_update = {
        "type": "customer.subscription.updated",
        "created": 1750000100,  # earlier than the cancellation above
        "data": {"object": {"id": "sub_test_stale", "status": "active"}},
    }
    await apply_webhook_event(stale_update, db_session)

    org = (await db_session.execute(select(Org).where(Org.id == org_a))).scalar_one()
    assert org.subscription_status == "canceled"


async def test_webhook_unknown_subscription_id_is_a_harmless_noop(db_session):
    # No org has this subscription id, and no org_id metadata fallback either
    # -- must not raise.
    event = {
        "type": "customer.subscription.updated",
        "created": 1750000100,
        "data": {"object": {"id": "sub_does_not_exist", "status": "active"}},
    }
    await apply_webhook_event(event, db_session)


async def test_webhook_requires_a_bypassrls_session_not_the_ordinary_one():
    """Regression test for the real production bug: routers/billing.py's
    webhook() route used to depend on get_session (gnt_app, RLS-enforced),
    not get_cron_session (gnt_cron, BYPASSRLS) -- Stripe's webhook is
    HMAC-authenticated, not org-scoped, and apply_webhook_event's
    subscription-keyed branches have to look an org up by
    stripe_subscription_id before they know its org_id, so there's no
    org_id yet to scope_to_org() with. Under the ordinary RLS-enforced
    session, every branch's SELECT saw zero rows (RLS hides everything
    when app.current_org is unset) and silently returned without ever
    writing anything -- confirmed live: no Stripe webhook had ever
    actually updated an org's subscription state since RLS landed.

    Every other test in this file calls apply_webhook_event(event,
    db_session) directly, which never exercises this: db_session is
    already scoped (by an earlier ensure_org() call in the same test, on
    the same shared connection/transaction) before apply_webhook_event
    ever runs, masking the exact gap that broke it in production. This
    test uses two genuinely fresh, unscoped connections instead -- one
    gnt_app (reproduces the original bug), one gnt_cron (the fix)."""
    get_cron_engine.cache_clear()
    get_cron_sessionmaker.cache_clear()
    org_id = f"org_test_billing_webhook_route_{uuid.uuid4().hex[:8]}"
    event = {
        "type": "checkout.session.completed",
        "created": 1750000200,
        "data": {
            "object": {
                "client_reference_id": org_id,
                "customer": "cus_route_test",
                "subscription": "sub_route_test",
            }
        },
    }

    app_engine = create_async_engine(TEST_DATABASE_URL)
    try:
        app_session_factory = async_sessionmaker(app_engine, expire_on_commit=False)
        async with app_session_factory() as seed_session:
            await ensure_org(seed_session, org_id)
            await seed_session.commit()

        # Genuinely fresh, never-scoped gnt_app session -- reproduces the
        # original bug. org_id is known here (unlike the real route) only
        # because this event type happens to carry it; the point under
        # test is RLS visibility, not org resolution.
        async with app_session_factory() as unscoped_session:
            await apply_webhook_event(event, unscoped_session)

        async with app_session_factory() as check_session:
            await ensure_org(check_session, org_id)
            org = (await check_session.execute(select(Org).where(Org.id == org_id))).scalar_one()
            assert org.stripe_customer_id is None, (
                "an ordinary RLS-enforced session with no scoping should silently "
                "no-op, same as it did in production before this was fixed"
            )

        # gnt_cron (BYPASSRLS) -- the actual fix routers/billing.py's
        # webhook() route now uses.
        cron_session_factory = get_cron_sessionmaker()
        async with cron_session_factory() as cron_session:
            await apply_webhook_event(event, cron_session)

        async with app_session_factory() as check_session:
            await ensure_org(check_session, org_id)
            org = (await check_session.execute(select(Org).where(Org.id == org_id))).scalar_one()
            assert org.stripe_customer_id == "cus_route_test"
            assert org.stripe_subscription_id == "sub_route_test"
            assert org.subscription_status == "active"
    finally:
        cleanup_engine = create_async_engine(TEST_DATABASE_URL)
        cleanup_session_factory = async_sessionmaker(cleanup_engine, expire_on_commit=False)
        async with cleanup_session_factory() as session:
            await ensure_org(session, org_id)
            org = (await session.execute(select(Org).where(Org.id == org_id))).scalar_one_or_none()
            if org is not None:
                await session.delete(org)
                await session.commit()
        await cleanup_engine.dispose()
        await app_engine.dispose()
        await get_cron_engine().dispose()
        get_cron_engine.cache_clear()
        get_cron_sessionmaker.cache_clear()


# --- plan tiers: checkout price selection, webhook price -> tier sync ---


async def test_checkout_fails_loud_when_pro_price_not_configured(monkeypatch):
    monkeypatch.setattr(get_settings(), "stripe_price_id_pro", None)
    with pytest.raises(BillingNotConfigured, match="STRIPE_PRICE_ID_PRO"):
        await create_checkout_session("org_x", "https://x/success", "https://x/cancel", tier="pro")


async def test_checkout_ensure_org_then_read_back_survives_a_real_commit():
    """Regression test for a real bug caught live while building the
    card-required trial flow: routers/billing.py's checkout() route calls
    ensure_org(session, org_id), then session.commit(), then reads the row
    straight back with a plain SELECT -- and that SELECT used to raise
    NoResultFound for any org without an existing orgs row already.
    ensure_org's own scope_to_org() call sets app.current_org for the
    CURRENT transaction only; commit() ends that transaction, so by the
    time the SELECT runs, RLS has nothing scoping it and hides the row
    ensure_org just inserted. Same bug class billing.is_org_entitled hit
    and fixed for the same reason (see that function's own comment).

    db_session (used by every other test in this file) can't reproduce
    this: it wraps each test in one savepoint-based transaction
    (conftest.py's join_transaction_mode="create_savepoint"), so
    session.commit() only releases a savepoint, never really ends the
    transaction -- app.current_org survives regardless, and a test built
    on it would pass whether or not the real fix (scope_to_org again
    after commit, see routers/billing.py's checkout()) is even there.
    Confirmed by literally reverting the fix and re-running this test with
    a fresh connection instead: only the fresh-connection version catches
    it. This mirrors test_webhook_requires_a_bypassrls_session_not_the_
    ordinary_one's own fresh-connection pattern, for the same reason."""
    org_id = f"org_test_checkout_commit_{uuid.uuid4().hex[:8]}"
    engine = create_async_engine(TEST_DATABASE_URL)
    try:
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        async with session_factory() as session:
            await ensure_org(session, org_id)
            await session.commit()
            # The exact fix: re-scope before the read, since the commit
            # above really did end the transaction ensure_org scoped.
            await scope_to_org(session, org_id)
            row = (await session.execute(select(Org).where(Org.id == org_id))).scalar_one()
            assert row.id == org_id
    finally:
        cleanup_engine = create_async_engine(TEST_DATABASE_URL)
        cleanup_session_factory = async_sessionmaker(cleanup_engine, expire_on_commit=False)
        async with cleanup_session_factory() as session:
            await ensure_org(session, org_id)
            org = (await session.execute(select(Org).where(Org.id == org_id))).scalar_one_or_none()
            if org is not None:
                await session.delete(org)
                await session.commit()
        await cleanup_engine.dispose()
        await engine.dispose()


async def test_checkout_route_survives_ensure_org_then_read_back_for_a_brand_new_org(
    test_app_factory, org_a, monkeypatch
):
    """Exercises the real HTTP route end to end (Stripe itself mocked
    out) -- POST /v1/billing/checkout had zero router-level coverage
    before this. Doesn't catch the commit/RLS bug on its own (db_session's
    savepoint wrapping masks it -- see
    test_checkout_ensure_org_then_read_back_survives_a_real_commit's own
    docstring for why), but does verify the route's actual response shape
    and the trial_days decision, which nothing else here covered."""
    captured = {}

    async def _fake_checkout(org_id, success_url, cancel_url, tier="base", trial_days=None):
        captured["trial_days"] = trial_days
        return "https://checkout.stripe.com/fake"

    monkeypatch.setattr("gnt.routers.billing.create_checkout_session", _fake_checkout)

    client = make_org_client(
        test_app_factory, org_a, user_id="admin_a", role="admin", routers=[billing_router.router]
    )
    async with client as c:
        r = await c.post("/v1/billing/checkout", json={"tier": "base"})
    assert r.status_code == 200
    assert r.json() == {"url": "https://checkout.stripe.com/fake"}
    # A brand-new org (no stripe_customer_id yet) gets the trial.
    assert captured["trial_days"] == get_settings().billing_trial_days


async def test_checkout_grants_no_trial_for_pro_even_on_a_brand_new_org(test_app_factory, org_a, monkeypatch):
    """Trial is a base-tier-only offer -- pro is billed immediately.
    Same brand-new-org setup as the test above (no stripe_customer_id,
    which is what grants base its trial), isolating tier as the reason
    pro gets none rather than the existing-customer path
    test_checkout_grants_no_second_trial_once_a_customer_exists covers."""
    captured = {}

    async def _fake_checkout(org_id, success_url, cancel_url, tier="base", trial_days=None):
        captured["trial_days"] = trial_days
        return "https://checkout.stripe.com/fake"

    monkeypatch.setattr("gnt.routers.billing.create_checkout_session", _fake_checkout)

    client = make_org_client(
        test_app_factory, org_a, user_id="admin_a", role="admin", routers=[billing_router.router]
    )
    async with client as c:
        r = await c.post("/v1/billing/checkout", json={"tier": "pro"})
    assert r.status_code == 200
    assert captured["trial_days"] is None


async def test_checkout_endpoint_itself_survives_ensure_org_then_commit_for_a_brand_new_org(
    monkeypatch,
):
    """The two tests above both gave false confidence for the same real
    bug: this one, and test_checkout_route_survives_..., each own
    docstring says why (savepoint wrapping masks a lost commit either as
    a hand-rolled pattern or through the HTTP layer). Neither actually
    calls gnt.routers.billing.checkout -- the real function -- with a
    connection where commit() really ends the transaction. That gap is
    exactly how routers/billing.py's checkout() went back to raising
    NoResultFound in production after its first fix: the fix's own
    comment survived a later edit, the `await scope_to_org(...)` call
    that comment describes didn't, and nothing here noticed.

    Calls the real router function directly (FastAPI's Depends() are
    just ordinary default values outside a real request, so this needs
    no app/client machinery) against a fresh, unscoped engine -- same
    "genuinely fresh connection" pattern as
    test_webhook_requires_a_bypassrls_session_not_the_ordinary_one.
    Confirmed by literally deleting the `await scope_to_org(session,
    org.org_id)` line from checkout() and re-running: this test fails
    with NoResultFound, matching production; restoring the line passes
    again."""
    org_id = f"org_test_checkout_endpoint_{uuid.uuid4().hex[:8]}"

    async def _fake_checkout(org_id, success_url, cancel_url, tier="base", trial_days=None):
        return "https://checkout.stripe.com/fake"

    monkeypatch.setattr("gnt.routers.billing.create_checkout_session", _fake_checkout)

    engine = create_async_engine(TEST_DATABASE_URL)
    try:
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        async with session_factory() as session:
            result = await billing_router.checkout(
                body=CheckoutRequest(tier="base"),
                org=OrgContext(org_id=org_id, user_id="test_admin", role="admin"),
                session=session,
            )
        assert result.url == "https://checkout.stripe.com/fake"
    finally:
        cleanup_engine = create_async_engine(TEST_DATABASE_URL)
        cleanup_session_factory = async_sessionmaker(cleanup_engine, expire_on_commit=False)
        async with cleanup_session_factory() as session:
            await ensure_org(session, org_id)
            org = (await session.execute(select(Org).where(Org.id == org_id))).scalar_one_or_none()
            if org is not None:
                await session.delete(org)
                await session.commit()
        await cleanup_engine.dispose()
        await engine.dispose()


async def test_checkout_grants_no_second_trial_once_a_customer_exists(
    db_session, test_app_factory, org_a, monkeypatch
):
    await ensure_org(db_session, org_a)
    org = (await db_session.execute(select(Org).where(Org.id == org_a))).scalar_one()
    org.stripe_customer_id = "cus_already_subscribed_once"
    await db_session.commit()

    captured = {}

    async def _fake_checkout(org_id, success_url, cancel_url, tier="base", trial_days=None):
        captured["trial_days"] = trial_days
        return "https://checkout.stripe.com/fake"

    monkeypatch.setattr("gnt.routers.billing.create_checkout_session", _fake_checkout)

    client = make_org_client(
        test_app_factory, org_a, user_id="admin_a", role="admin", routers=[billing_router.router]
    )
    async with client as c:
        r = await c.post("/v1/billing/checkout", json={"tier": "pro"})
    assert r.status_code == 200
    assert captured["trial_days"] is None


async def test_webhook_subscription_updated_syncs_plan_tier_from_price_id(db_session, org_a, monkeypatch):
    monkeypatch.setattr(get_settings(), "stripe_price_id", "price_base_test")
    monkeypatch.setattr(get_settings(), "stripe_price_id_pro", "price_pro_test")
    await ensure_org(db_session, org_a)
    org = (await db_session.execute(select(Org).where(Org.id == org_a))).scalar_one()
    org.stripe_subscription_id = "sub_tier_test"
    await db_session.commit()

    event = {
        "type": "customer.subscription.updated",
        "created": 1750000100,
        "data": {
            "object": {
                "id": "sub_tier_test",
                "status": "active",
                "items": {"data": [{"price": {"id": "price_pro_test"}}]},
            }
        },
    }
    await apply_webhook_event(event, db_session)

    org = (await db_session.execute(select(Org).where(Org.id == org_a))).scalar_one()
    assert org.plan_tier == "pro"


async def test_webhook_unrecognized_price_id_leaves_plan_tier_untouched(db_session, org_a, monkeypatch):
    monkeypatch.setattr(get_settings(), "stripe_price_id", "price_base_test")
    monkeypatch.setattr(get_settings(), "stripe_price_id_pro", "price_pro_test")
    await ensure_org(db_session, org_a)
    org = (await db_session.execute(select(Org).where(Org.id == org_a))).scalar_one()
    org.stripe_subscription_id = "sub_unrecognized_price"
    org.plan_tier = "pro"
    await db_session.commit()

    # Some other, unrelated Stripe price id (e.g. test-mode data, or a
    # price this codebase doesn't know about) must not silently downgrade
    # an org that's already on pro.
    event = {
        "type": "customer.subscription.updated",
        "created": 1750000200,
        "data": {
            "object": {
                "id": "sub_unrecognized_price",
                "status": "active",
                "items": {"data": [{"price": {"id": "price_totally_unrelated"}}]},
            }
        },
    }
    await apply_webhook_event(event, db_session)

    org = (await db_session.execute(select(Org).where(Org.id == org_a))).scalar_one()
    assert org.plan_tier == "pro"


async def test_webhook_stale_tier_event_does_not_downgrade_a_newer_upgrade(db_session, org_a, monkeypatch):
    monkeypatch.setattr(get_settings(), "stripe_price_id", "price_base_test")
    monkeypatch.setattr(get_settings(), "stripe_price_id_pro", "price_pro_test")
    await ensure_org(db_session, org_a)
    org = (await db_session.execute(select(Org).where(Org.id == org_a))).scalar_one()
    org.stripe_subscription_id = "sub_stale_tier"
    await db_session.commit()

    upgrade_to_pro = {
        "type": "customer.subscription.updated",
        "created": 1750000200,
        "data": {
            "object": {
                "id": "sub_stale_tier",
                "status": "active",
                "items": {"data": [{"price": {"id": "price_pro_test"}}]},
            }
        },
    }
    await apply_webhook_event(upgrade_to_pro, db_session)

    stale_base_event = {
        "type": "customer.subscription.updated",
        "created": 1750000100,  # earlier than the upgrade above
        "data": {
            "object": {
                "id": "sub_stale_tier",
                "status": "active",
                "items": {"data": [{"price": {"id": "price_base_test"}}]},
            }
        },
    }
    await apply_webhook_event(stale_base_event, db_session)

    org = (await db_session.execute(select(Org).where(Org.id == org_a))).scalar_one()
    assert org.plan_tier == "pro"


async def test_portal_session_turns_a_stale_stripe_customer_into_a_clean_400(monkeypatch):
    # Reproduces a real bug found via live testing: a stripe_customer_id
    # that Stripe no longer recognizes (deleted straight from the
    # dashboard, or bogus test data) used to propagate as an unhandled
    # 500 instead of billing.py's own "tell them what to do" convention
    # (see the sibling "no billing account yet" raise just above this
    # function in billing.py).
    org = Org(id="org_stale_customer", trial_ends_at=datetime.now(timezone.utc), stripe_customer_id="cus_deleted")

    class _FakeSessions:
        async def create_async(self, *_args, **_kwargs):
            raise stripe.InvalidRequestError("No such customer: 'cus_deleted'", param="customer")

    class _FakeClient:
        class v1:
            billing_portal = type("BP", (), {"sessions": _FakeSessions()})()

    monkeypatch.setattr("gnt.billing._client", lambda: _FakeClient())

    with pytest.raises(HTTPException) as exc_info:
        await create_portal_session(org, return_url="https://gntai.dev/")
    assert exc_info.value.status_code == 400


async def test_cancel_subscription_requires_an_existing_subscription():
    org = Org(id="org_no_sub", trial_ends_at=datetime.now(timezone.utc))
    with pytest.raises(HTTPException) as exc_info:
        await cancel_subscription(org)
    assert exc_info.value.status_code == 400


async def test_cancel_subscription_sets_flag_and_returns_stripes_period_end(monkeypatch):
    org = Org(
        id="org_cancel_me",
        trial_ends_at=datetime.now(timezone.utc),
        stripe_subscription_id="sub_to_cancel",
        cancel_at_period_end=False,
    )
    period_end = 1800000000

    class _FakeSubscription:
        current_period_end = period_end

    class _FakeSubscriptions:
        async def update_async(self, subscription_id, params):
            assert subscription_id == "sub_to_cancel"
            assert params == {"cancel_at_period_end": True}
            return _FakeSubscription()

    class _FakeClient:
        class v1:
            subscriptions = _FakeSubscriptions()

    monkeypatch.setattr("gnt.billing._client", lambda: _FakeClient())

    cancel_at = await cancel_subscription(org)

    assert org.cancel_at_period_end is True
    assert cancel_at == datetime.fromtimestamp(period_end, tz=timezone.utc)


async def test_cancel_subscription_blocks_a_stale_webhook_from_reverting_it(db_session, org_a, monkeypatch):
    # cancel_subscription writes cancel_at_period_end directly, outside
    # apply_webhook_event's own timestamp-guarded path -- without also
    # bumping subscription_status_synced_at, a webhook event delivered
    # late (retried, delayed) but chronologically older than the cancel
    # action itself could still pass _apply_status's guard and stomp
    # cancel_at_period_end back to false.
    await ensure_org(db_session, org_a)
    org = (await db_session.execute(select(Org).where(Org.id == org_a))).scalar_one()
    org.stripe_subscription_id = "sub_race_guard"
    org.subscription_status = "active"
    await db_session.commit()

    class _FakeSubscription:
        current_period_end = 1800000000

    class _FakeSubscriptions:
        async def update_async(self, *_args, **_kwargs):
            return _FakeSubscription()

    class _FakeClient:
        class v1:
            subscriptions = _FakeSubscriptions()

    monkeypatch.setattr("gnt.billing._client", lambda: _FakeClient())

    org_a_obj = (await db_session.execute(select(Org).where(Org.id == org_a))).scalar_one()
    await cancel_subscription(org_a_obj)
    await db_session.commit()

    # A webhook event "created" well before the cancel action just ran --
    # same shape as a delayed/retried delivery arriving out of order.
    stale_event = {
        "type": "customer.subscription.updated",
        "created": 1700000000,
        "data": {"object": {"id": "sub_race_guard", "status": "active", "cancel_at_period_end": False}},
    }
    await apply_webhook_event(stale_event, db_session)

    org = (await db_session.execute(select(Org).where(Org.id == org_a))).scalar_one()
    assert org.cancel_at_period_end is True


async def test_cancel_subscription_turns_a_stale_subscription_into_a_clean_400(monkeypatch):
    org = Org(
        id="org_stale_sub", trial_ends_at=datetime.now(timezone.utc), stripe_subscription_id="sub_already_gone"
    )

    class _FakeSubscriptions:
        async def update_async(self, *_args, **_kwargs):
            raise stripe.InvalidRequestError("No such subscription: 'sub_already_gone'", param="subscription")

    class _FakeClient:
        class v1:
            subscriptions = _FakeSubscriptions()

    monkeypatch.setattr("gnt.billing._client", lambda: _FakeClient())

    with pytest.raises(HTTPException) as exc_info:
        await cancel_subscription(org)
    assert exc_info.value.status_code == 400


async def test_cancel_endpoint_cancels_and_sends_confirmation_email(db_session, test_app_factory, org_a, monkeypatch):
    await ensure_org(db_session, org_a)
    await db_session.commit()

    period_end = 1800000000

    async def _fake_cancel_subscription(org):
        org.cancel_at_period_end = True
        return datetime.fromtimestamp(period_end, tz=timezone.utc)

    sent = {}

    async def _fake_recipients(session, org_id):
        return ["admin@example.com"]

    async def _fake_send(to, org_id, tier, cancel_at):
        sent["to"] = to
        sent["tier"] = tier
        sent["cancel_at"] = cancel_at

    monkeypatch.setattr("gnt.routers.billing.cancel_subscription", _fake_cancel_subscription)
    monkeypatch.setattr("gnt.routers.billing.get_digest_recipients", _fake_recipients)
    monkeypatch.setattr("gnt.routers.billing.send_subscription_canceled_email", _fake_send)

    client = make_org_client(
        test_app_factory, org_a, user_id="admin_a", role="admin", routers=[billing_router.router]
    )
    async with client as c:
        r = await c.post("/v1/billing/cancel")
    assert r.status_code == 200
    assert r.json() == {"cancel_at": datetime.fromtimestamp(period_end, tz=timezone.utc).isoformat()}
    assert sent["to"] == ["admin@example.com"]
    assert sent["cancel_at"] == datetime.fromtimestamp(period_end, tz=timezone.utc)


async def test_payment_method_endpoint_returns_the_card_on_file(db_session, test_app_factory, org_a, monkeypatch):
    await ensure_org(db_session, org_a)
    await db_session.commit()

    fake_card = type("Card", (), {"brand": "visa", "last4": "4242", "exp_month": 10, "exp_year": 2030})()
    fake_pm = type("PM", (), {"card": fake_card})()

    async def _fake_get_default_payment_method(org):
        return fake_pm

    monkeypatch.setattr("gnt.routers.billing.get_default_payment_method", _fake_get_default_payment_method)

    client = make_org_client(
        test_app_factory, org_a, user_id="admin_a", role="admin", routers=[billing_router.router]
    )
    async with client as c:
        r = await c.get("/v1/billing/payment-method")
    assert r.status_code == 200
    assert r.json() == {"brand": "visa", "last4": "4242", "exp_month": 10, "exp_year": 2030}


async def test_payment_method_endpoint_returns_null_when_no_card_on_file(
    db_session, test_app_factory, org_a, monkeypatch
):
    await ensure_org(db_session, org_a)
    await db_session.commit()

    async def _fake_get_default_payment_method(org):
        return None

    monkeypatch.setattr("gnt.routers.billing.get_default_payment_method", _fake_get_default_payment_method)

    client = make_org_client(
        test_app_factory, org_a, user_id="admin_a", role="admin", routers=[billing_router.router]
    )
    async with client as c:
        r = await c.get("/v1/billing/payment-method")
    assert r.status_code == 200
    assert r.json() is None


async def test_invoices_endpoint_returns_invoice_history(db_session, test_app_factory, org_a, monkeypatch):
    await ensure_org(db_session, org_a)
    await db_session.commit()

    fake_invoice = type(
        "Invoice",
        (),
        {
            "id": "in_123",
            "number": "INV-0001",
            "created": 1800000000,
            "status": "paid",
            "amount_paid": 2900,
            "currency": "usd",
            "hosted_invoice_url": "https://invoice.stripe.com/fake",
            "invoice_pdf": "https://invoice.stripe.com/fake.pdf",
        },
    )()

    async def _fake_list_invoices(org, limit=12):
        return [fake_invoice]

    monkeypatch.setattr("gnt.routers.billing.list_invoices", _fake_list_invoices)

    client = make_org_client(
        test_app_factory, org_a, user_id="admin_a", role="admin", routers=[billing_router.router]
    )
    async with client as c:
        r = await c.get("/v1/billing/invoices")
    assert r.status_code == 200
    assert r.json() == [
        {
            "id": "in_123",
            "number": "INV-0001",
            "created": datetime.fromtimestamp(1800000000, tz=timezone.utc).isoformat(),
            "status": "paid",
            "amount_paid": 2900,
            "currency": "usd",
            "hosted_invoice_url": "https://invoice.stripe.com/fake",
            "invoice_pdf": "https://invoice.stripe.com/fake.pdf",
        }
    ]


async def test_invoices_endpoint_empty_for_org_with_no_stripe_customer(test_app_factory, org_a, monkeypatch):
    client = make_org_client(
        test_app_factory, org_a, user_id="admin_a", role="admin", routers=[billing_router.router]
    )
    async with client as c:
        r = await c.get("/v1/billing/invoices")
    assert r.status_code == 200
    assert r.json() == []
