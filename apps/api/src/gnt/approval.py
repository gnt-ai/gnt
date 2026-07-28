"""Computes the approval signature apps/store's GntStore.putPage requires
for any write setting status: "approved" — must match
apps/store/src/core/approval-signing.ts's canonicalization and HMAC
scheme exactly (HMAC-SHA256 over "{org}:{slug}:{version}:{content_hash}",
hex digest), or every approval would be rejected as an invalid signature.

content_hash binds the signature to what was actually approved (title,
body, tags, status) — without it, a valid signature for (org, slug,
version) would validate ANY content written under that slug/version,
making the signature check theater rather than a real approval gate.
"""

import hmac
import hashlib

from gnt.config import get_settings

_FIELD_SEP = "\x00"
_TAG_SEP = "\x01"


def hash_approval_content(*, title: str, body: str, tags: list[str], status: str) -> str:
    """Must match approval-signing.ts's hashApprovalContent byte-for-byte:
    NUL/SOH-separated, not JSON or a plain " "/"," joiner — those let two
    different (title, body, tags) tuples canonicalize to the same string.
    Rule content is untrusted (extraction output, admin input), so a field
    containing the separator itself is rejected rather than assumed away —
    it would reopen the same collision the separator choice closes."""
    for field in (title, body, status, *tags):
        if _FIELD_SEP in field or _TAG_SEP in field:
            raise ValueError("approval content must not contain NUL or SOH characters")
    canonical = _FIELD_SEP.join([title, body, _TAG_SEP.join(tags), status])
    return hashlib.sha256(canonical.encode()).hexdigest()


def sign_approval(*, org_id: str, slug: str, version: int, content_hash: str) -> str:
    secret = get_settings().approval_signing_secret
    message = f"{org_id}:{slug}:{version}:{content_hash}".encode()
    return hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()
