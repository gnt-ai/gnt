import hashlib
import hmac
import time

from gnt.config import get_settings

# Slack rejects (and we should too) a request whose timestamp is more than
# 5 minutes old — this is the replay-protection half of Slack's own signing
# spec, the HMAC alone doesn't cover it.
_MAX_REQUEST_AGE_SECONDS = 60 * 5


def verify_slack_request(timestamp: str, raw_body: bytes, signature: str) -> bool:
    try:
        request_ts = int(timestamp)
    except ValueError:
        return False

    if abs(time.time() - request_ts) > _MAX_REQUEST_AGE_SECONDS:
        return False

    basestring = b"v0:" + timestamp.encode("utf-8") + b":" + raw_body
    digest = hmac.new(
        get_settings().slack_signing_secret.encode("utf-8"),
        basestring,
        hashlib.sha256,
    ).hexdigest()
    expected = f"v0={digest}"

    return hmac.compare_digest(expected, signature)
