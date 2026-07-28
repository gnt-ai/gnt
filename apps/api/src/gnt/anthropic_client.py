from functools import lru_cache

import anthropic

from gnt.config import get_settings


@lru_cache
def get_client() -> anthropic.Anthropic:
    """Uses an explicit ANTHROPIC_API_KEY if one is configured; failing
    that, falls back to the SDK's normal credential resolution
    (ANTHROPIC_AUTH_TOKEN, then an `ant auth login` profile), which lets
    local testing run against a Claude subscription instead of
    provisioning a separate key."""
    key = get_settings().anthropic_api_key
    return anthropic.Anthropic(api_key=key) if key else anthropic.Anthropic()
