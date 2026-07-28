"""gnt/github/app_auth.py — the App JWT/installation-token minting the
GitHub App connect flow replaces the PAT flow's stored-token model with,
plus the signed install-state token that's the callback's only proof of
which org an install belongs to (see that module's own docstring).

Real RSA keypair generated per test session below (not the production
key, never read from env) — every JWT sign/verify here is genuine crypto,
just against a throwaway key, matching this suite's existing "real
Fernet key, not a placeholder string" convention for
GITHUB_PAT_ENCRYPTION_KEY (see ci.yml's own comment on that).
"""

import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat

from gnt.config import get_settings
from gnt.db.models import GithubConnection
from gnt.github.app_auth import (
    GithubAppError,
    build_install_state,
    get_installation_token,
    get_repo_token,
    verify_install_state,
)
from gnt.github.crypto import encrypt_token


@pytest.fixture(scope="module")
def _test_private_key_pem() -> bytes:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return key.private_bytes(Encoding.PEM, PrivateFormat.TraditionalOpenSSL, NoEncryption())


@pytest.fixture
def app_configured(monkeypatch, _test_private_key_pem):
    settings = get_settings()
    monkeypatch.setattr(settings, "github_app_id", "999111")
    monkeypatch.setattr(settings, "github_app_private_key", _test_private_key_pem.decode("utf-8"))
    return settings


def test_build_and_verify_install_state_round_trips(app_configured):
    state = build_install_state("org_test_a", "user_1", origin="cli")
    result = verify_install_state(state)
    assert result.org_id == "org_test_a"
    assert result.user_id == "user_1"
    assert result.origin == "cli"


def test_verify_install_state_defaults_origin_web(app_configured):
    state = build_install_state("org_test_a", "user_1")
    assert verify_install_state(state).origin == "web"


def test_verify_install_state_rejects_a_tampered_token(app_configured):
    state = build_install_state("org_test_a", "user_1")
    with pytest.raises(GithubAppError):
        verify_install_state(state + "tampered")


def test_verify_install_state_rejects_a_different_orgs_signature(app_configured, _test_private_key_pem):
    """The exact tenant-isolation property this token exists for: a state
    signed for org A must never verify as valid for org B, and a state
    signed with a DIFFERENT key entirely (simulating a forged token) must
    be rejected outright."""
    from cryptography.hazmat.primitives.asymmetric import rsa as rsa_mod

    other_key = rsa_mod.generate_private_key(public_exponent=65537, key_size=2048)
    other_pem = other_key.private_bytes(Encoding.PEM, PrivateFormat.TraditionalOpenSSL, NoEncryption())
    forged = jwt.encode(
        {
            "org_id": "org_test_a",
            "user_id": "user_1",
            "origin": "web",
            "iat": int(time.time()),
            "exp": int(time.time()) + 600,
        },
        other_pem,
        algorithm="RS256",
    )
    with pytest.raises(GithubAppError):
        verify_install_state(forged)


def test_verify_install_state_rejects_an_expired_token(app_configured):
    expired = jwt.encode(
        {
            "org_id": "org_test_a",
            "user_id": "user_1",
            "origin": "web",
            "iat": int(time.time()) - 1200,
            "exp": int(time.time()) - 600,
        },
        get_settings().github_app_private_key,
        algorithm="RS256",
    )
    with pytest.raises(GithubAppError):
        verify_install_state(expired)


async def test_get_installation_token_signs_a_jwt_with_the_configured_app_id(app_configured, monkeypatch):
    """The App JWT this mints for GitHub's token-exchange call must carry
    the real configured App ID as `iss` -- a mismatched or missing iss is
    exactly the kind of config-vs-code drift that would silently mint
    tokens for the wrong app (or fail every real call) without ever
    showing up in a test that only checks the final return value."""
    captured_auth: dict[str, str] = {}

    class _FakeResponse:
        status_code = 201

        @staticmethod
        def json():
            return {"token": "ghs_fake_installation_token"}

    async def _fake_call(method, url, headers, action, **kwargs):
        captured_auth["authorization"] = headers["Authorization"]
        return _FakeResponse()

    monkeypatch.setattr("gnt.github.app_auth._call", _fake_call)

    token = await get_installation_token(12345)
    assert token == "ghs_fake_installation_token"

    app_jwt = captured_auth["authorization"].removeprefix("Bearer ")
    claims = jwt.decode(app_jwt, options={"verify_signature": False})
    assert claims["iss"] == "999111"


async def test_get_repo_token_mints_an_installation_token_for_an_app_connected_org(monkeypatch):
    connection = GithubConnection(
        org_id="org_test_a",
        repo_url="https://github.com/acme/rules",
        default_branch="main",
        installation_id=555,
        pat_encrypted=None,
        webhook_secret_encrypted=None,
        installed_by_user_id="user_1",
    )

    async def _fake_get_installation_token(installation_id: int) -> str:
        assert installation_id == 555
        return "ghs_minted"

    monkeypatch.setattr("gnt.github.app_auth.get_installation_token", _fake_get_installation_token)
    assert await get_repo_token(connection) == "ghs_minted"


async def test_get_repo_token_decrypts_the_stored_pat_for_a_pat_connected_org():
    connection = GithubConnection(
        org_id="org_test_a",
        repo_url="https://github.com/acme/rules",
        default_branch="main",
        installation_id=None,
        pat_encrypted=encrypt_token("gph_real_secret"),
        webhook_secret_encrypted=encrypt_token("whsec"),
        installed_by_user_id="user_1",
    )
    assert await get_repo_token(connection) == "gph_real_secret"


async def test_get_installation_token_raises_a_clean_error_when_the_app_isnt_configured(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "github_app_id", None)
    monkeypatch.setattr(settings, "github_app_private_key", None)
    with pytest.raises(GithubAppError):
        await get_installation_token(1)
