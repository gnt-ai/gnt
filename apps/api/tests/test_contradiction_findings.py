"""contradiction_findings.py / ContradictionFinding (continuous
contradiction sweeps). Covers canonical_pair's order
independence, has_been_filed's dedup gate, record_finding's write and
best-effort failure handling, and RLS isolation — mirroring
test_calibration.py's own coverage shape for the same append-only,
org-scoped discipline.
"""

from sqlalchemy import select

from gnt.contradiction_findings import canonical_pair, has_been_filed, record_finding
from gnt.db.models import ContradictionFinding
from gnt.db.org import ensure_org
from gnt.db.rls import scope_to_org


async def _rows(db_session, org_id: str) -> list[ContradictionFinding]:
    await scope_to_org(db_session, org_id)
    return (
        (
            await db_session.execute(
                select(ContradictionFinding).where(ContradictionFinding.org_id == org_id)
            )
        )
        .scalars()
        .all()
    )


def test_canonical_pair_is_order_independent():
    assert canonical_pair("rules/b", "rules/a") == canonical_pair("rules/a", "rules/b")
    assert canonical_pair("rules/a", "rules/b") == ("rules/a", "rules/b")


async def test_has_been_filed_is_false_before_anything_is_recorded(db_session, org_a):
    await ensure_org(db_session, org_a)
    await db_session.commit()

    assert await has_been_filed(db_session, org_a, "rules/a", "rules/b") is False


async def test_record_finding_then_has_been_filed_matches_either_order(db_session, org_a):
    await ensure_org(db_session, org_a)
    await db_session.commit()

    await record_finding(
        db_session,
        org_a,
        "rules/b",
        "rules/a",
        relation="contradicts",
        issue_number=7,
        issue_url="https://github.com/acme/rules/issues/7",
    )

    # Recorded as (b, a) -- must still match a has_been_filed check that
    # queries with the pair in the opposite order, since a candidate pair
    # sampled a different night has no guaranteed ordering.
    assert await has_been_filed(db_session, org_a, "rules/a", "rules/b") is True
    assert await has_been_filed(db_session, org_a, "rules/b", "rules/a") is True
    assert await has_been_filed(db_session, org_a, "rules/a", "rules/c") is False

    rows = await _rows(db_session, org_a)
    assert len(rows) == 1
    assert rows[0].rule_slug_a == "rules/a"
    assert rows[0].rule_slug_b == "rules/b"
    assert rows[0].relation == "contradicts"
    assert rows[0].issue_number == 7
    assert rows[0].issue_url == "https://github.com/acme/rules/issues/7"


async def test_record_finding_swallows_failures(db_session, org_a, monkeypatch):
    captured: list[Exception] = []
    monkeypatch.setattr(
        "gnt.contradiction_findings.sentry_sdk.capture_exception", lambda exc: captured.append(exc)
    )

    await ensure_org(db_session, org_a)
    await db_session.commit()

    # issue_number is a required column -- omitting it trips the insert
    # rather than a legitimate no-op, proving a bug here can't escape and
    # break the nightly sweep it rides along with.
    await record_finding(
        db_session,
        org_a,
        "rules/a",
        "rules/b",
        relation="contradicts",
        issue_number=None,  # type: ignore[arg-type]
        issue_url="https://github.com/acme/rules/issues/1",
    )

    assert len(captured) == 1
    assert await _rows(db_session, org_a) == []


async def test_contradiction_findings_are_org_isolated_by_rls(db_session, org_a, org_b):
    await ensure_org(db_session, org_a)
    await ensure_org(db_session, org_b)
    await db_session.commit()

    await record_finding(
        db_session,
        org_a,
        "rules/a",
        "rules/b",
        relation="contradicts",
        issue_number=1,
        issue_url="https://github.com/acme/rules/issues/1",
    )

    await scope_to_org(db_session, org_b)
    org_b_view = (await db_session.execute(select(ContradictionFinding))).scalars().all()
    assert org_b_view == []

    assert await has_been_filed(db_session, org_b, "rules/a", "rules/b") is False

    await scope_to_org(db_session, org_a)
    org_a_view = (await db_session.execute(select(ContradictionFinding))).scalars().all()
    assert len(org_a_view) == 1
    assert org_a_view[0].org_id == org_a
