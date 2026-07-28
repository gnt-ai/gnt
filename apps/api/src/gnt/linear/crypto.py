from functools import lru_cache

from cryptography.fernet import Fernet

from gnt.config import get_settings


@lru_cache
def _fernet() -> Fernet:
    return Fernet(get_settings().linear_token_encryption_key.encode("utf-8"))


def encrypt_token(plaintext: str) -> str:
    return _fernet().encrypt(plaintext.encode("utf-8")).decode("utf-8")


def decrypt_token(ciphertext: str) -> str:
    return _fernet().decrypt(ciphertext.encode("utf-8")).decode("utf-8")
