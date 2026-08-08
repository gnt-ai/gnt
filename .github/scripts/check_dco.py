#!/usr/bin/env python3
"""DCO (Developer Certificate of Origin) check for commit ranges.

CONTRIBUTING.md requires every commit to carry a `Signed-off-by` trailer
matching the commit author (`git commit -s`). This script enforces that in
CI the same way check_workflow_security.py enforces fork-PR safety: a small
stdlib Python check, no third-party Action, no GitHub App install.

Why a workflow script instead of the dcoapp GitHub App: this repo's CI
policy checks already live as scripts under .github/scripts/ and run on
ubuntu-latest for fork PRs. A script fits that pattern, needs no org-level
App install, and stays fork-safe by construction (hosted runner only).

Usage:
  BASE_SHA=<merge-base> HEAD_SHA=<tip> python3 .github/scripts/check_dco.py

CI sets BASE_SHA/HEAD_SHA from the pull_request or push event. Locally,
point them at any range you want to verify.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys

# GitHub's default squash-merge commit subject ("<PR title> (#123)").
SQUASH_MERGE_SUBJECT_RE = re.compile(r"\(#\d+\)$")


def run_git(*args: str) -> str:
    return subprocess.check_output(["git", *args], text=True).rstrip("\n")


def commit_range(base: str, head: str) -> list[str]:
    # Exclusive of base, inclusive of head — the commits a PR actually adds.
    out = run_git("rev-list", "--no-merges", f"{base}..{head}")
    return [line for line in out.splitlines() if line]


def author_identity(sha: str) -> str:
    return run_git("show", "--no-patch", "--format=%an <%ae>", sha)


def trailers(sha: str) -> str:
    # interpret-trailers --parse is the same parser `git commit -s` writes
    # for; grepping %B directly would false-positive on body text that
    # happens to mention "Signed-off-by".
    body = run_git("show", "--no-patch", "--format=%B", sha)
    return subprocess.check_output(
        ["git", "interpret-trailers", "--parse"],
        input=body,
        text=True,
    )


def check_commit(sha: str) -> str | None:
    expected = f"Signed-off-by: {author_identity(sha)}"
    parsed = trailers(sha)
    if any(line == expected for line in parsed.splitlines()):
        return None
    short = run_git("rev-parse", "--short", sha)
    subject = run_git("show", "--no-patch", "--format=%s", sha)
    if "Signed-off-by:" in parsed and SQUASH_MERGE_SUBJECT_RE.search(subject):
        # A GitHub squash-merge commit carries the trailer text from the
        # PR's original commits verbatim, but GitHub sets the squash
        # commit's own author to the contributor's GitHub-known identity
        # (e.g. their noreply email), which can literally differ from the
        # email their original commits signed off with. Those original
        # commits were already checked individually by this same script's
        # pull_request run before the PR could merge -- this isn't a
        # missing or fabricated sign-off, just squash-authorship the
        # contributor doesn't control.
        return None
    if "Signed-off-by:" in parsed:
        return (
            f"{short} ({subject}): Signed-off-by present but does not match "
            f"author — expected exactly `{expected}`"
        )
    return f"{short} ({subject}): missing `{expected}`"


def main() -> int:
    base = os.environ.get("BASE_SHA", "").strip()
    head = os.environ.get("HEAD_SHA", "").strip()
    if not base or not head:
        print(
            "BASE_SHA and HEAD_SHA must both be set (CI sets them from the "
            "pull_request/push event)",
            file=sys.stderr,
        )
        return 2

    try:
        commits = commit_range(base, head)
    except subprocess.CalledProcessError as e:
        print(f"failed to list commits in {base}..{head}: {e}", file=sys.stderr)
        return 2

    if not commits:
        print(f"DCO check: OK (no non-merge commits in {base[:7]}..{head[:7]})")
        return 0

    errors = [err for sha in commits if (err := check_commit(sha)) is not None]
    if errors:
        for err in errors:
            print(f"::error::{err}")
        print(
            f"\n{len(errors)} commit(s) failed the DCO check. "
            "Re-sign with `git commit --amend -s` (tip) or "
            "`git rebase --signoff <base>` (older commits). "
            "See CONTRIBUTING.md's DCO section.",
            file=sys.stderr,
        )
        return 1

    print(f"DCO check: OK ({len(commits)} commit(s) signed off)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
