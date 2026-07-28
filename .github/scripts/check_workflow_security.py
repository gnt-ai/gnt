#!/usr/bin/env python3
"""Fork-PR safety guard for .github/workflows/*.yml.

Public repos get pull requests from forks. GitHub already withholds repo
secrets from plain `pull_request` runs, but it does NOT stop a fork PR from
reaching a self-hosted runner (arbitrary code execution on the physical
machine) or a `pull_request_target`/`workflow_run` job that trusts the wrong
commit. This is a static line-scan, not a real YAML/expression parser --
it knows the shape of the workflows in this repo, not general Actions YAML.
Tighten the regexes if that shape changes; don't reach for a YAML/expression
library to make it "more correct" for shapes this repo doesn't use.

Invariants enforced:
  1. No workflow uses `pull_request_target`. It grants fork PRs access to
     secrets and a base-repo token; this repo has no case that needs it.
  2. In any workflow with a `pull_request` trigger (fork-reachable), no job
     runs on a bare `self-hosted` runner. A conditional runs-on expression
     is fine as long as it guards `self-hosted` behind a same-repo check
     (github.repository, checked against the PR's head repo).
  3. In any workflow with a `workflow_run` trigger, a job that touches
     secrets or a self-hosted runner must gate itself with a job-level
     `if:` that checks `head_repository` against `github.repository` --
     the `branches:` filter alone matches on branch name only, and a fork
     can name its branch anything, including the base repo's default
     branch name.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

JOB_HEADER_RE = re.compile(r"^  ([A-Za-z0-9_-]+):\s*$")
TOP_KEY_RE = re.compile(r"^(\w[\w-]*):\s*")
RUNS_ON_RE = re.compile(r"^\s*runs-on:")
JOB_IF_RE = re.compile(r"^ {4}if:")
SECRETS_RE = re.compile(r"secrets\.\w+")


def trigger_section(lines: list[str]) -> list[str]:
    on_idx = next((i for i, l in enumerate(lines) if TOP_KEY_RE.match(l) and l.startswith("on:")), None)
    jobs_idx = next((i for i, l in enumerate(lines) if l.startswith("jobs:")), len(lines))
    if on_idx is None:
        return []
    return lines[on_idx:jobs_idx]


def has_trigger(section: list[str], name: str) -> bool:
    pattern = re.compile(rf"^\s*{re.escape(name)}:\s*$")
    return any(pattern.match(l) for l in section)


def job_blocks(lines: list[str]) -> list[tuple[str, list[str]]]:
    jobs_idx = next((i for i, l in enumerate(lines) if l.startswith("jobs:")), None)
    if jobs_idx is None:
        return []
    headers = [(i, m.group(1)) for i, l in enumerate(lines[jobs_idx:], start=jobs_idx) if (m := JOB_HEADER_RE.match(l))]
    blocks = []
    for idx, (start, name) in enumerate(headers):
        end = headers[idx + 1][0] if idx + 1 < len(headers) else len(lines)
        blocks.append((name, lines[start:end]))
    return blocks


def runs_on_text(block: list[str]) -> str:
    out = []
    capturing = False
    base_indent = None
    for l in block:
        if RUNS_ON_RE.match(l):
            out.append(l)
            capturing = l.strip() == "runs-on:"
            base_indent = len(l) - len(l.lstrip())
            continue
        if capturing:
            indent = len(l) - len(l.lstrip())
            if l.strip().startswith("-") and indent > base_indent:
                out.append(l)
                continue
            capturing = False
    return "\n".join(out)


def check_file(path: Path) -> list[str]:
    errors = []
    lines = path.read_text().splitlines()
    full_text = "\n".join(lines)
    name = path.name

    if re.search(r"^\s*pull_request_target:\s*$", full_text, re.MULTILINE):
        errors.append(f"{name}: uses pull_request_target -- forbidden, see script docstring")

    section = trigger_section(lines)
    fork_reachable = has_trigger(section, "pull_request")
    via_workflow_run = has_trigger(section, "workflow_run")

    for job_name, block in job_blocks(lines):
        runs_on = runs_on_text(block)
        job_text = "\n".join(block)
        touches_secrets = bool(SECRETS_RE.search(job_text))
        is_self_hosted = "self-hosted" in runs_on

        if fork_reachable and is_self_hosted:
            is_expression = "${{" in runs_on
            guarded = "github.repository" in runs_on and ("head.repo.full_name" in runs_on or "head_repository" in runs_on)
            if not is_expression or not guarded:
                errors.append(
                    f"{name}: job '{job_name}' can run on a self-hosted runner from a fork "
                    "pull_request without a same-repo (github.repository) guard"
                )

        if via_workflow_run and (touches_secrets or is_self_hosted):
            job_if = " ".join(l for l in block if JOB_IF_RE.match(l))
            if "head_repository" not in job_if:
                errors.append(
                    f"{name}: job '{job_name}' is reachable via workflow_run and touches "
                    "secrets/self-hosted but its `if:` doesn't check head_repository against "
                    "github.repository (branch-name filters alone can be spoofed by a fork)"
                )

    return errors


def main(argv: list[str]) -> int:
    target = Path(argv[1]) if len(argv) > 1 else Path(__file__).resolve().parents[1] / "workflows"
    files = sorted(target.glob("*.yml")) + sorted(target.glob("*.yaml"))
    if not files:
        print(f"no workflow files found under {target}", file=sys.stderr)
        return 1

    all_errors = []
    for f in files:
        all_errors.extend(check_file(f))

    if all_errors:
        for e in all_errors:
            print(f"::error::{e}")
        print(f"\n{len(all_errors)} fork-PR safety issue(s) found", file=sys.stderr)
        return 1

    print(f"workflow fork-PR safety guard: OK ({len(files)} workflow file(s) checked)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
