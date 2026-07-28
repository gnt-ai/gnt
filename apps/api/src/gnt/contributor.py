import hmac
from hashlib import sha256

from gnt.config import get_settings


def contributor_hash(user_id: str) -> str:
    secret = get_settings().contributor_hash_secret.encode()
    return hmac.new(secret, user_id.encode(), sha256).hexdigest()
