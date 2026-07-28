"""gnt.github.client's _get_branch_sha, isolated from the router layer.
Everything else in this module is already exercised indirectly through
test_rules.py and test_github.py's router-level mocking of create_branch/
verify_repo_access; this file exists for the one piece of logic that
needed a test closer to the actual HTTP response it branches on -- the
409-means-empty-repo detection, added after the A1 production acceptance
run hit it as an opaque 502 (routers/rules.py's propose used to convert
every GithubClientError to 502; that's now 422, see test_rules.py's
test_propose_surfaces_github_client_error_as_422)."""

import pytest

from gnt.github.client import GithubClientError, _get_branch_sha


class _FakeResponse:
    def __init__(self, status_code: int, payload: dict | None = None):
        self.status_code = status_code
        self._payload = payload or {}

    def json(self):
        return self._payload


async def test_get_branch_sha_on_empty_repo_names_the_actual_cause(monkeypatch):
    async def _fake_call(method, url, pat, action, **kwargs):
        return _FakeResponse(409, {"message": "Git Repository is empty."})

    monkeypatch.setattr("gnt.github.client._call", _fake_call)

    with pytest.raises(GithubClientError, match="has no commits on main yet"):
        await _get_branch_sha("acme", "rules", "pat", "main")


async def test_get_branch_sha_on_other_failure_keeps_the_generic_message(monkeypatch):
    async def _fake_call(method, url, pat, action, **kwargs):
        return _FakeResponse(404)

    monkeypatch.setattr("gnt.github.client._call", _fake_call)

    with pytest.raises(GithubClientError, match=r"could not read branch main.*\(404\)"):
        await _get_branch_sha("acme", "rules", "pat", "main")


async def test_get_branch_sha_on_success_returns_the_sha(monkeypatch):
    async def _fake_call(method, url, pat, action, **kwargs):
        return _FakeResponse(200, {"object": {"sha": "abc123"}})

    monkeypatch.setattr("gnt.github.client._call", _fake_call)

    assert await _get_branch_sha("acme", "rules", "pat", "main") == "abc123"
