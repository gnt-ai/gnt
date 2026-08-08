from functools import lru_cache

from cryptography.fernet import Fernet

from gnt.config import get_settings


def make_token_cipher(settings_field: str, *, not_configured_error: type[Exception] | None = None):
    """Builds a connector's encrypt_token/decrypt_token pair, keyed off one
    settings field. Every connector's Fernet setup is otherwise identical —
    see the per-connector crypto.py modules that call this."""

    @lru_cache
    def _fernet() -> Fernet:
        key = getattr(get_settings(), settings_field)
        if not_configured_error is not None and not key:
            raise not_configured_error(f"{settings_field.upper()} is not configured")
        return Fernet(key.encode("utf-8"))

    def encrypt_token(plaintext: str) -> str:
        return _fernet().encrypt(plaintext.encode("utf-8")).decode("utf-8")

    def decrypt_token(ciphertext: str) -> str:
        return _fernet().decrypt(ciphertext.encode("utf-8")).decode("utf-8")

    return encrypt_token, decrypt_token
