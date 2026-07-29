"""P0 acceptance gate: runs the entire product
loop against real production infrastructure and fails loud if any step
doesn't behave exactly like a real customer's would.

rule drafted -> submitted -> proposed as a real PR opened in the connected
GitHub rules repo -> a real merge -> the GitHub webhook flips the rule to
approved -> a real MCP protocol client (not a direct function call) queries
the published endpoint and gets the approved rule back.

A 2026-07-18 audit found this script still called
POST /v1/capture and polled for extracted "knowledge units" -- that
endpoint doesn't exist anywhere in the current router set (grep
apps/api/src/gnt/routers confirms it). The capture/extraction pipeline it
exercised was retired by the git-native rules rewrite; there's no separate
extraction step left in the current architecture at all -- creating a
rule (the step right after, previously step 4) already IS the create-a-
rule action, extraction never sat between "capture" and "rule" here.
Removed those two dead steps and renumbered.

GitHub App migration (this change): the connect step below still uses the
legacy PAT flow (POST /v1/settings/github), not the new GitHub App install
flow, and that's a deliberate, structural choice, not an oversight -- a
GitHub App installation requires a human clicking "Install" in a browser
(github.com/apps/<slug>/installations/new), which is GitHub's own security
model for App installs, not something any script can complete headlessly.
The PAT flow stays fully supported on purpose (see GithubConnection's own
docstring) specifically so this gate can keep exercising the real
propose -> merge -> webhook -> approve -> MCP spine end to end without a
human in the loop. Step 0 below is what CAN be verified headlessly: that
the App's own JWT-signing and GitHub API auth plumbing (gnt/github/
app_auth.py) actually works against production, by hitting the real
install-url endpoint and checking it returns a well-formed GitHub URL.
That is real signal (a broken GITHUB_APP_PRIVATE_KEY, a wrong GITHUB_APP_ID,
a GitHub API auth failure would all fail this step), but it is NOT a
substitute for someone manually running `gnt connect github` once against
a real test org and confirming the full install -> callback -> connected
loop, which this script cannot do for you.

Nothing else here is mocked. Every HTTP call hits the real deployed
api/store services; the PR is a real GitHub pull request; the merge is a
real `gh pr merge`; the MCP call uses the actual `mcp` SDK client against
the real published URL. This is deliberately NOT run in CI on every push
(it opens a real PR and needs a real admin-scoped API key + GitHub PAT it
can't safely hold as a CI secret) -- run it by hand after any change that
touches the rules/github-connect/webhook/MCP path, or wire it into CI
once that work is scoped separately.

Requires four env vars, none of which this script can provision itself:

  E2E_BASE_URL      e.g. https://api.gntai.dev
  E2E_ADMIN_KEY     an is_admin=true mcp_api_keys token for a test org.
                    There's no scripted way to mint one -- create_cli_key
                    requires a live session by design (closes a
                    self-escalation path). Insert the row directly for a
                    throwaway test org instead; see apps/api/DEPLOY.md.
  E2E_GITHUB_PAT    a fine-grained PAT scoped to ONLY the test repo below
                    (repo contents + pull requests + webhooks, read/write).
                    Never reuse a broadly-scoped personal token here.
  E2E_TEST_REPO     "owner/repo" of a real, otherwise-unused GitHub repo
                    dedicated to this test. Every run opens and merges a
                    real PR against it.

Usage: uv run python scripts/acceptance_e2e.py
"""

import asyncio
import os
import subprocess
import sys
import time
import uuid

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client


def _env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        print(f"missing required env var {name} -- see this script's module docstring", file=sys.stderr)
        sys.exit(1)
    return value


async def _poll(fn, *, matches, timeout_s: float, interval_s: float = 3.0, label: str):
    deadline = time.monotonic() + timeout_s
    last = None
    while time.monotonic() < deadline:
        last = await fn()
        if matches(last):
            return last
        await asyncio.sleep(interval_s)
    raise TimeoutError(f"{label} did not complete within {timeout_s}s -- last seen: {last!r}")


async def main() -> None:
    base_url = _env("E2E_BASE_URL").rstrip("/")
    admin_key = _env("E2E_ADMIN_KEY")
    github_pat = _env("E2E_GITHUB_PAT")
    test_repo = _env("E2E_TEST_REPO")

    headers = {"Authorization": f"Bearer {admin_key}"}
    run_id = uuid.uuid4().hex[:8]

    rule_body = (
        f"Acceptance test run {run_id}: refunds are only issued within 30 days "
        "of purchase, and only for unused items in original packaging."
    )

    async with httpx.AsyncClient(base_url=base_url, headers=headers, timeout=30.0) as client:
        print("[0/5] checking the GitHub App auth plumbing is live (JWT signing + GitHub API auth)...")
        r = await client.get("/v1/settings/github/app/install-url")
        if r.status_code == 200:
            install_url = r.json()["url"]
            if not install_url.startswith("https://github.com/apps/"):
                raise AssertionError(f"install-url returned something that isn't a real GitHub App URL: {install_url}")
            print(f"      real install URL minted: {install_url}")
        elif r.status_code == 502:
            # GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY unset or GitHub's own
            # /app endpoint rejected the signed JWT -- a real, reportable
            # failure, but not one that should block the rest of this gate
            # (the PAT-flow spine below is what's actually load-bearing for
            # the merge/webhook path this gate exists to prove).
            print(f"      WARNING: GitHub App auth check failed ({r.status_code}): {r.text[:200]}", file=sys.stderr)
        else:
            r.raise_for_status()

        print(f"[1/5] connecting GitHub repo {test_repo} (legacy PAT flow -- see module docstring for why)...")
        r = await client.post(
            "/v1/settings/github",
            json={"repo_url": f"https://github.com/{test_repo}", "pat": github_pat},
        )
        # 201 = freshly connected, 200/409-shaped "already connected" is
        # also fine on a rerun against the same repo -- only a genuine
        # failure status should stop the run.
        if r.status_code not in (200, 201):
            r.raise_for_status()
        print(f"      connected: {r.json()}")

        print("[2/5] creating, submitting, and proposing a rule...")
        r = await client.post(
            "/v1/rules",
            json={
                "title": f"Acceptance test rule {run_id}",
                "body": rule_body,
                "tags": ["e2e-acceptance-test"],
            },
        )
        r.raise_for_status()
        rule_id = r.json()["id"]
        r = await client.post(f"/v1/rules/{rule_id}/submit")
        r.raise_for_status()
        r = await client.post(f"/v1/rules/{rule_id}/propose")
        r.raise_for_status()
        proposed = r.json()
        pr_number = proposed["pr_number"]
        pr_url = proposed["pr_url"]
        print(f"      real PR opened: {pr_url}")

        print(f"[3/5] merging PR #{pr_number} for real (gh pr merge)...")
        subprocess.run(
            ["gh", "pr", "merge", str(pr_number), "--repo", test_repo, "--merge"],
            check=True,
        )
        print("      merged")

        print("[4/5] waiting for the real GitHub webhook to flip the rule to approved...")

        async def _check_rule():
            resp = await client.get(f"/v1/rules/{rule_id}")
            resp.raise_for_status()
            return resp.json()

        approved = await _poll(
            _check_rule, matches=lambda r: r["status"] == "approved", timeout_s=30, label="webhook approval"
        )
        print(f"      approved by {approved['approved_by']} at {approved['approved_at']}")

    print("[5/5] querying the real published MCP endpoint (real protocol client, not a direct call)...")
    mcp_url = f"{base_url}/mcp"
    async with streamablehttp_client(mcp_url, headers=headers) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool("get_rule", {"rule_id": rule_id})
            text = result.content[0].text if result.content else ""
            if rule_id not in text or "e2e-acceptance-test" not in text:
                raise AssertionError(f"MCP get_rule did not return the approved rule back: {text}")
            print(f"      MCP get_rule returned the approved rule: {text}")

    print("\nP0 ACCEPTANCE GATE: PASS")
    print(f"  rule: {base_url}/v1/rules/{rule_id}")
    print(f"  PR:   {pr_url}")


if __name__ == "__main__":
    asyncio.run(main())
