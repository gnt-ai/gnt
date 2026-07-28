import hashlib
import secrets

# Distinct prefix from mcp_keys.py's gnt_live_ -- a webhook token is a
# different, much narrower credential (routers/webhooks.py's one endpoint
# only, draft-rule creation, nothing else McpApiKey-authenticated callers
# can do) and is designed to sit in a URL path where a bearer token
# normally wouldn't, so it needs to be visually distinguishable at a
# glance in logs/URLs, not just functionally distinct.
TOKEN_PREFIX = "whk_"


def generate_webhook_token() -> tuple[str, str]:
    """Returns (plaintext_token, sha256_hash). Only the hash is ever
    persisted -- mirrors mcp_keys.generate_key exactly."""
    plaintext = f"{TOKEN_PREFIX}{secrets.token_urlsafe(32)}"
    return plaintext, hash_token(plaintext)


def hash_token(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()
