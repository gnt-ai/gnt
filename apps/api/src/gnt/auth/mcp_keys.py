import hashlib
import secrets

KEY_PREFIX = "gnt_live_"


def generate_key() -> tuple[str, str]:
    """Returns (plaintext_key, sha256_hash). Only the hash is ever persisted."""
    plaintext = f"{KEY_PREFIX}{secrets.token_urlsafe(32)}"
    return plaintext, hash_key(plaintext)


def hash_key(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


def is_api_key(token: str) -> bool:
    return token.startswith(KEY_PREFIX)
