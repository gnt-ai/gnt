from functools import lru_cache

from groq import Groq

from gnt.config import get_settings


@lru_cache
def get_client() -> Groq:
    return Groq(api_key=get_settings().groq_api_key)
