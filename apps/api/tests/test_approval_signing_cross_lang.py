"""Python's sign_approval()/hash_approval_content() must produce byte-
identical output to apps/store/src/core/approval-signing.ts's
signApproval()/hashApprovalContent() for the same inputs — the approval
gate lives in TS, the approval service that calls it lives in Python, and
any drift between the two HMAC/hash schemes would silently reject every
legitimate approval (or worse, silently accept a mismatched one). Fixed
expected values below were independently verified against a real run of
the TS implementation during Phase 4/6 development, not derived from the
Python code itself.
"""

from gnt.approval import hash_approval_content, sign_approval

_TITLE = "Refund window"
_BODY = "test rule body"
_TAGS = ["a", "b"]
_STATUS = "approved"


def test_content_hash_matches_the_typescript_implementation():
    content_hash = hash_approval_content(title=_TITLE, body=_BODY, tags=_TAGS, status=_STATUS)
    assert content_hash == "6fb630255d4d26d05bf961f8474ebfd529d034aed4d1d151dd2d7882ea3bca4b"


def test_matches_the_typescript_implementation(monkeypatch):
    monkeypatch.setenv("APPROVAL_SIGNING_SECRET", "cross-lang-test-secret")
    from gnt.config import get_settings

    get_settings.cache_clear()
    try:
        content_hash = hash_approval_content(title=_TITLE, body=_BODY, tags=_TAGS, status=_STATUS)
        signature = sign_approval(org_id="org-x", slug="rules/foo", version=2, content_hash=content_hash)
        assert signature == "49229b46baa2d8dadd6d3e923ba2d4da88e593da11646b3607a4247e6ca97280"
    finally:
        get_settings.cache_clear()


def test_different_version_produces_a_different_signature(monkeypatch):
    monkeypatch.setenv("APPROVAL_SIGNING_SECRET", "cross-lang-test-secret")
    from gnt.config import get_settings

    get_settings.cache_clear()
    try:
        content_hash = hash_approval_content(title=_TITLE, body=_BODY, tags=_TAGS, status=_STATUS)
        v1 = sign_approval(org_id="org-x", slug="rules/foo", version=1, content_hash=content_hash)
        v2 = sign_approval(org_id="org-x", slug="rules/foo", version=2, content_hash=content_hash)
        assert v1 != v2
    finally:
        get_settings.cache_clear()


def test_different_content_produces_a_different_signature(monkeypatch):
    monkeypatch.setenv("APPROVAL_SIGNING_SECRET", "cross-lang-test-secret")
    from gnt.config import get_settings

    get_settings.cache_clear()
    try:
        hash_a = hash_approval_content(title=_TITLE, body=_BODY, tags=_TAGS, status=_STATUS)
        hash_b = hash_approval_content(title=_TITLE, body="a completely different rule body", tags=_TAGS, status=_STATUS)
        sig_a = sign_approval(org_id="org-x", slug="rules/foo", version=2, content_hash=hash_a)
        sig_b = sign_approval(org_id="org-x", slug="rules/foo", version=2, content_hash=hash_b)
        assert sig_a != sig_b
    finally:
        get_settings.cache_clear()
