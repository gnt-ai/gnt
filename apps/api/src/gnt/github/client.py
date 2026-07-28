import base64
import re
from dataclasses import dataclass
from urllib.parse import quote

import httpx

_API_BASE = "https://api.github.com"
_REPO_URL_RE = re.compile(r"^https://github\.com/([\w.-]+)/([\w.-]+?)(?:\.git)?/?$")
_HEADERS_ACCEPT = "application/vnd.github+json"


class GithubClientError(Exception):
    # Populated for the handful of call sites where a caller genuinely
    # needs to branch on the specific HTTP status GitHub returned (today:
    # workers/tasks_staleness.py's get_file_content call, which treats a
    # 404 as "the source file is gone" and anything else as an ordinary
    # per-rule failure). None everywhere else — the message string alone
    # has always been enough for every existing caller, which only ever
    # logs or surfaces it, never branches on it.
    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


def parse_repo_url(repo_url: str) -> tuple[str, str]:
    """Returns (owner, repo) for a plain https://github.com/<owner>/<repo>
    URL, or raises GithubClientError. Deliberately narrow — no embedded
    credentials, no non-github hosts, no path traversal — this is validated
    before anything is persisted or before any PAT is used against it."""
    match = _REPO_URL_RE.match(repo_url.strip())
    if not match:
        raise GithubClientError(
            "repo_url must look like https://github.com/<owner>/<repo>"
        )
    return match.group(1), match.group(2)


async def verify_repo_access(repo_url: str, pat: str) -> str:
    """Confirms the repo exists and the PAT can at least read it — a real
    round-trip before persisting anything, mirroring Slack OAuth's
    exchange_code doing a live call before anything is stored. Returns the
    repo's actual default branch (GitHub's API is the source of truth here —
    "main" is a common default, not a guaranteed one, so callers must not
    assume it)."""
    owner, repo = parse_repo_url(repo_url)
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{_API_BASE}/repos/{owner}/{repo}",
                headers={"Authorization": f"Bearer {pat}", "Accept": _HEADERS_ACCEPT},
            )
    except httpx.HTTPError as exc:
        raise GithubClientError(f"could not reach GitHub to verify {owner}/{repo}: {exc}") from exc
    if response.status_code != 200:
        raise GithubClientError(
            f"could not access {owner}/{repo} with the provided PAT ({response.status_code})"
        )
    try:
        payload = response.json()
    except ValueError as exc:
        raise GithubClientError(f"GitHub returned an invalid response for {owner}/{repo}") from exc
    default_branch = payload.get("default_branch") if isinstance(payload, dict) else None
    if not isinstance(default_branch, str) or not default_branch:
        # Guessing "main" here would silently reintroduce the exact bug this
        # return value exists to fix — if GitHub's response doesn't say what
        # the real default branch is, that's a real error, not a fallback.
        raise GithubClientError(f"GitHub did not return a default branch for {owner}/{repo}")
    return default_branch


@dataclass(frozen=True)
class PullRequestResult:
    number: int
    url: str


def _headers(pat: str) -> dict:
    return {"Authorization": f"Bearer {pat}", "Accept": _HEADERS_ACCEPT}


async def _call(method: str, url: str, pat: str, action: str, **kwargs) -> httpx.Response:
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            return await client.request(method, url, headers=_headers(pat), **kwargs)
    except httpx.HTTPError as exc:
        raise GithubClientError(f"could not reach GitHub to {action}: {exc}") from exc


async def _get_branch_sha(owner: str, repo: str, pat: str, branch: str) -> str:
    response = await _call(
        "GET", f"{_API_BASE}/repos/{owner}/{repo}/git/ref/heads/{branch}", pat, f"read branch {branch}"
    )
    if response.status_code == 409:
        # GitHub's own signature for "this repo has zero commits" -- there's
        # no ref to read because the default branch doesn't exist yet. A
        # customer connecting a brand-new, truly empty repo hits this on
        # their very first propose; the fix is on their end (push one
        # commit), so say that instead of a generic status-code message.
        raise GithubClientError(
            f"{owner}/{repo} has no commits on {branch} yet -- push at least one commit "
            "(a README is enough) before proposing a rule against this repo"
        )
    if response.status_code != 200:
        raise GithubClientError(
            f"could not read branch {branch} on {owner}/{repo} ({response.status_code})"
        )
    try:
        sha = response.json()["object"]["sha"]
    except (ValueError, KeyError, TypeError) as exc:
        raise GithubClientError(
            f"GitHub returned an invalid response while reading branch {branch} on {owner}/{repo}"
        ) from exc
    if not isinstance(sha, str) or not sha:
        raise GithubClientError(
            f"GitHub did not return a valid sha for branch {branch} on {owner}/{repo}"
        )
    return sha


async def create_branch(repo_url: str, pat: str, new_branch: str, base_branch: str) -> None:
    """Creates new_branch pointing at base_branch's current HEAD. Treats an
    already-exists 422 as success — a retried propose call shouldn't fail
    just because the first attempt's branch creation already went through."""
    owner, repo = parse_repo_url(repo_url)
    base_sha = await _get_branch_sha(owner, repo, pat, base_branch)
    response = await _call(
        "POST",
        f"{_API_BASE}/repos/{owner}/{repo}/git/refs",
        pat,
        f"create branch {new_branch}",
        json={"ref": f"refs/heads/{new_branch}", "sha": base_sha},
    )
    if response.status_code == 201:
        return
    if response.status_code == 422 and "already exists" in response.text:
        return
    raise GithubClientError(
        f"could not create branch {new_branch} on {owner}/{repo} ({response.status_code})"
    )


async def put_file(repo_url: str, pat: str, branch: str, path: str, content: str, message: str) -> None:
    """Creates or updates a file on `branch`. Fetches the file's current sha
    first — GitHub's Contents API requires it for updates and rejects it for
    creates — a 404 on that lookup means "doesn't exist yet", not an
    error."""
    owner, repo = parse_repo_url(repo_url)
    contents_url = f"{_API_BASE}/repos/{owner}/{repo}/contents/{path}"
    existing = await _call("GET", contents_url, pat, f"read {path}", params={"ref": branch})
    if existing.status_code == 200:
        try:
            sha = existing.json()["sha"]
        except (ValueError, KeyError, TypeError) as exc:
            raise GithubClientError(
                f"GitHub returned an invalid response while reading {path} on {owner}/{repo}"
            ) from exc
    elif existing.status_code == 404:
        sha = None
    else:
        # Anything other than 200 (has a sha) or 404 (genuinely new file) is
        # a real failure — rate-limited, forbidden, etc. — not "file doesn't
        # exist yet". Treating it as the latter would silently attempt a
        # create when an update was actually needed.
        raise GithubClientError(f"could not read {path} on {owner}/{repo} ({existing.status_code})")

    body: dict = {
        "message": message,
        "content": base64.b64encode(content.encode("utf-8")).decode("ascii"),
        "branch": branch,
    }
    if sha:
        body["sha"] = sha
    response = await _call("PUT", contents_url, pat, f"write {path}", json=body)
    if response.status_code not in (200, 201):
        raise GithubClientError(f"could not write {path} on {owner}/{repo} ({response.status_code})")


async def get_file_content(repo_url: str, pat: str, path: str, ref: str) -> str:
    """Reads a file's raw text at a specific ref (branch/commit SHA). Used
    by the webhook handler to read a merged rule file's actual content —
    which may carry last-minute edits made during PR review — rather than
    trusting the content propose_rule originally rendered before the PR
    was ever opened."""
    owner, repo = parse_repo_url(repo_url)
    response = await _call(
        "GET",
        f"{_API_BASE}/repos/{owner}/{repo}/contents/{quote(path)}",
        pat,
        f"read {path}",
        params={"ref": ref},
    )
    if response.status_code != 200:
        raise GithubClientError(
            f"could not read {path} on {owner}/{repo} ({response.status_code})",
            status_code=response.status_code,
        )
    try:
        data = response.json()
        return base64.b64decode(data["content"]).decode("utf-8")
    except (ValueError, KeyError, TypeError) as exc:
        raise GithubClientError(f"GitHub returned an invalid response while reading {path} on {owner}/{repo}") from exc


async def open_pull_request(
    repo_url: str, pat: str, head_branch: str, base_branch: str, title: str, body: str
) -> PullRequestResult:
    owner, repo = parse_repo_url(repo_url)
    response = await _call(
        "POST",
        f"{_API_BASE}/repos/{owner}/{repo}/pulls",
        pat,
        "open pull request",
        json={"title": title, "head": head_branch, "base": base_branch, "body": body},
    )
    if response.status_code != 201:
        raise GithubClientError(
            f"could not open a pull request on {owner}/{repo} ({response.status_code}): {response.text[:200]}"
        )
    data = response.json()
    return PullRequestResult(number=data["number"], url=data["html_url"])


async def close_pull_request(repo_url: str, pat: str, pr_number: int) -> None:
    """Closes a PR without merging — used when a rule proposed for merge
    gets rejected instead, so a human reviewing the repo's PR list doesn't
    see a stale open PR for a rule gnt itself abandoned. A PR that's already
    closed (or merged) is treated as success, not an error — the desired
    end state (not open) already holds."""
    owner, repo = parse_repo_url(repo_url)
    response = await _call(
        "PATCH",
        f"{_API_BASE}/repos/{owner}/{repo}/pulls/{pr_number}",
        pat,
        f"close pull request #{pr_number}",
        json={"state": "closed"},
    )
    if response.status_code == 200:
        return
    raise GithubClientError(
        f"could not close pull request #{pr_number} on {owner}/{repo} ({response.status_code})"
    )


@dataclass(frozen=True)
class IssueResult:
    number: int
    url: str


async def create_issue(repo_url: str, pat: str, title: str, body: str) -> IssueResult:
    """Opens an issue on the org's connected rules repo — used by the
    nightly contradiction sweep (fix-plan-v2 item 13) to flag two
    approved rules that may contradict each other for a human to
    resolve. An issue, not a PR: there's no proposed code change to
    review here, just a finding that needs human attention, so
    open_pull_request's branch/file-diff machinery doesn't apply.

    Deliberately no `labels` argument — passing a label GitHub's API
    doesn't already recognize on the target repo fails the whole call,
    and this has no way to know what labels (if any) a given customer's
    repo has set up. An unlabeled issue that still gets filed beats a
    labeled one that silently never does."""
    owner, repo = parse_repo_url(repo_url)
    response = await _call(
        "POST",
        f"{_API_BASE}/repos/{owner}/{repo}/issues",
        pat,
        "create issue",
        json={"title": title, "body": body},
    )
    if response.status_code != 201:
        raise GithubClientError(
            f"could not create an issue on {owner}/{repo} ({response.status_code}): {response.text[:200]}"
        )
    data = response.json()
    return IssueResult(number=data["number"], url=data["html_url"])


async def create_webhook(repo_url: str, pat: str, webhook_url: str, secret: str) -> None:
    """Registers a webhook so the merge that approves a rule gets confirmed
    within seconds, not the ~30-minute durability-cron fallback interval.
    No GitHub App exists yet (see docs/migration/RECONCILE_V2.md), so this
    is created directly via the connecting org's own PAT at connect time."""
    owner, repo = parse_repo_url(repo_url)
    response = await _call(
        "POST",
        f"{_API_BASE}/repos/{owner}/{repo}/hooks",
        pat,
        "create webhook",
        json={
            "name": "web",
            "active": True,
            "events": ["pull_request"],
            "config": {"url": webhook_url, "content_type": "json", "secret": secret},
        },
    )
    if response.status_code != 201:
        raise GithubClientError(
            f"could not create a webhook on {owner}/{repo} ({response.status_code}): {response.text[:200]}"
        )
