#!/usr/bin/env python3
"""DCO (Developer Certificate of Origin) check for PR commits.

CONTRIBUTING.md's "Sign off your commits (DCO)" section requires a
`Signed-off-by` trailer on every commit (`git commit -s`), matching the DCO
mechanism the Linux kernel and a lot of other open-source projects use
instead of a CLA -- but until now nothing in CI actually checked for it, so
it only ever got caught by a maintainer reading a PR by hand. This walks
every non-merge commit introduced by a PR and fails if any of them is
missing a trailer whose email matches that commit's own author.

Base resolution mirrors ci.yml's own TURBO_SCM_BASE step: origin/<base
branch> for a pull_request event, since that's the only event this workflow
actually runs the job on (see security.yml -- no push/workflow_dispatch
path needed here, unlike ci.yml's shared trigger block).
"""

from __future__ import annotations

import re
import subprocess
import sys

TRAILER_RE = re.compile(r"^Signed-off-by:\s*(.+?)\s*<([^<>]+)>\s*$", re.MULTILINE)


def commit_range(base: str) -> list[str]:
    out = subprocess.run(
        ["git", "log", "--no-merges", "--format=%H", f"{base}..HEAD"],
        capture_output=True,
        text=True,
        check=True,
    )
    return [line for line in out.stdout.splitlines() if line]


def commit_info(sha: str) -> tuple[str, str, str]:
    out = subprocess.run(
        ["git", "show", "-s", "--format=%ae%x00%s%x00%B", sha],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    author_email, subject, body = out.split("\x00", 2)
    return author_email.strip(), subject.strip(), body


def main(argv: list[str]) -> int:
    base = argv[1] if len(argv) > 1 else "origin/main"

    shas = commit_range(base)
    if not shas:
        print(f"no commits found between {base} and HEAD")
        return 0

    missing = []
    for sha in shas:
        author_email, subject, body = commit_info(sha)
        trailer_emails = {email.lower() for _, email in TRAILER_RE.findall(body)}
        if author_email.lower() not in trailer_emails:
            missing.append((sha[:12], subject, author_email))

    if missing:
        for sha, subject, email in missing:
            print(
                f"::error::commit {sha} ({subject!r}, author {email}) is missing a "
                "matching `Signed-off-by` trailer -- run `git commit -s` "
                "(or `git rebase --signoff <base>` to fix a whole branch)"
            )
        print(f"\n{len(missing)} commit(s) missing a DCO sign-off", file=sys.stderr)
        return 1

    print(f"DCO check: OK ({len(shas)} commit(s) signed off)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
