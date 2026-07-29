"""Spawns apps/store's REAL internal HTTP API (real Postgres/pgvector,
real NativeStore.search() hybrid pipeline — see
apps/store/scripts/eval-serve.ts) as a subprocess, the same pattern
apps/api/tests/conftest.py's `_store_server` fixture already uses for the
rest of the pytest suite, just wired to replay embedding/rerank functions
(apps/store/src/testing/replay-embed.ts, replay-rerank.ts) instead of a
live provider, on its own port so it never collides with conftest's
instance.

This is the one place the eval touches store_client.py's exact query
path (store_client.search_rules -> POST /search -> GntStore.search() ->
NativeStore's hybrid search) — see apps/api/eval/rule_retrieval/README.md
for why that's the surface under test rather than a mock.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import time
from pathlib import Path
from typing import Any

import httpx

from gnt.approval import hash_approval_content, sign_approval
from gnt.config import get_settings

_STORE_DIR = Path(__file__).resolve().parents[3] / "store"
_FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"
_EMBEDDINGS_FIXTURE = _FIXTURES_DIR / "embeddings.json"
_RERANK_FIXTURE = _FIXTURES_DIR / "rerank.json"

RULE_SLUG_PREFIX = "rules/"


class EvalStoreHarness:
    """Async context manager: spawns the eval store server on `port`,
    waits for it to become healthy, and tears it down on exit. Reuses the
    app's real store_internal_api_secret/approval_signing_secret (already
    configured in every environment this runs in — local .env or CI's
    STORE_INTERNAL_API_SECRET/APPROVAL_SIGNING_SECRET) rather than
    inventing eval-only secrets, since this is a same-host loopback
    process talking to itself.
    """

    def __init__(
        self,
        *,
        port: int = 8799,
        org_id: str = "rule-retrieval-eval",
    ):
        """Spawns against a real Postgres — NativeStore is Postgres-only.
        GNT_STORE_EVAL_NATIVE_DATABASE_URL picks the database, defaulting
        to the same local database the store's own native test suite
        uses."""
        settings = get_settings()
        self.port = port
        self.org_id = org_id
        self.base_url = f"http://127.0.0.1:{port}"
        self._secret = settings.store_internal_api_secret
        self._approval_secret = settings.approval_signing_secret
        self._process: subprocess.Popen | None = None

    async def __aenter__(self) -> "EvalStoreHarness":
        await self._start()
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self._stop()

    async def _start(self) -> None:
        env = {
            **os.environ,
            "GNT_STORE_PORT": str(self.port),
            "GNT_STORE_INTERNAL_API_SECRET": self._secret,
            "GNT_APPROVAL_SIGNING_SECRET": self._approval_secret,
            "GNT_STORE_EVAL_EMBEDDINGS_FIXTURE": str(_EMBEDDINGS_FIXTURE),
            # The reranker ships on for every org, so the eval exercises it
            # too — via a committed zerank-2 score fixture replayed for free
            # (no live call). record_rerank_fixture.py sets
            # GNT_STORE_EVAL_RERANK_RECORD instead, to capture that fixture
            # against the live provider; pass it through when present so
            # the recorder's live run reaches the real reranker.
            "GNT_STORE_EVAL_RERANK_FIXTURE": str(_RERANK_FIXTURE),
        }
        # GNT_STORE_EVAL_NATIVE_DATABASE_URL, when set in the parent
        # environment, already flows through via the **os.environ spread
        # above — NativeStore is Postgres-only, eval-serve.ts falls back to
        # a local default database when it's unset.
        record_path = os.environ.get("GNT_STORE_EVAL_RERANK_RECORD")
        if record_path:
            env["GNT_STORE_EVAL_RERANK_RECORD"] = record_path
        self._process = subprocess.Popen(
            ["bun", "run", "scripts/eval-serve.ts"],
            cwd=str(_STORE_DIR),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )

        health_url = f"{self.base_url}/health"
        deadline = time.monotonic() + 30
        last_error: Exception | None = None
        async with httpx.AsyncClient() as client:
            while time.monotonic() < deadline:
                if self._process.poll() is not None:
                    output = self._process.stdout.read() if self._process.stdout else ""
                    raise RuntimeError(f"eval store server exited early:\n{output}")
                try:
                    response = await client.get(health_url, timeout=1)
                    if response.status_code == 200:
                        return
                except httpx.HTTPError as exc:
                    last_error = exc
                await asyncio.sleep(0.5)
        self._process.terminate()
        raise RuntimeError(f"eval store server never became healthy: {last_error}")

    async def _stop(self) -> None:
        if self._process is None:
            return
        self._process.terminate()
        try:
            self._process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self._process.kill()

    async def seed_corpus(self, corpus: list[dict[str, Any]]) -> None:
        """Writes every corpus rule as an already-`approved` rule, signed
        the same way the real approval webhook signs a merge (see
        apps/api/tests/test_mcp_tools.py's `_approve_directly_via_store`,
        the pattern this mirrors) — search only ever returns approved
        rules, so an eval corpus written as `draft` would silently score
        every query as a miss."""
        async with httpx.AsyncClient(
            base_url=self.base_url,
            timeout=30,
            headers={"Authorization": f"Bearer {self._secret}"},
        ) as client:
            for entry in corpus:
                slug = f"{RULE_SLUG_PREFIX}{entry['id']}"
                content_hash = hash_approval_content(
                    title=entry["title"], body=entry["body"], tags=entry["tags"], status="approved"
                )
                signature = sign_approval(
                    org_id=self.org_id, slug=slug, version=1, content_hash=content_hash
                )
                rule = {
                    "slug": slug,
                    "org": self.org_id,
                    "title": entry["title"],
                    "body": entry["body"],
                    "status": "approved",
                    "confidence": 0.9,
                    "ownerId": "eval",
                    "sourceCitations": [],
                    "tags": entry["tags"],
                    "lastValidatedAt": None,
                    "version": 1,
                    "supersededBy": None,
                    "previousVersionId": None,
                    "approvedBy": "eval",
                    "approvedAt": "2026-01-01T00:00:00Z",
                    "createdAt": "2026-01-01T00:00:00Z",
                    "prNumber": None,
                    "prUrl": None,
                }
                response = await client.post(
                    "/rules", json={"rule": rule, "approvalSignature": signature}
                )
                if response.status_code != 200:
                    raise RuntimeError(
                        f"seed_corpus: failed to write {slug}: {response.status_code} {response.text}"
                    )

    async def search(self, query: str) -> list[str]:
        """Exercises the exact same request store_client.search_rules
        sends — POST /search — and returns ranked bare rule ids (the store
        already orders hits by descending relevance, see NativeStore.search)."""
        async with httpx.AsyncClient(
            base_url=self.base_url,
            timeout=30,
            headers={"Authorization": f"Bearer {self._secret}"},
        ) as client:
            response = await client.post(
                "/search", json={"query": query, "orgId": self.org_id, "status": "approved"}
            )
        if response.status_code != 200:
            raise RuntimeError(f"search failed: {response.status_code} {response.text}")
        return [hit["slug"].removeprefix(RULE_SLUG_PREFIX) for hit in response.json()]
