import uuid
from datetime import date, datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import BigInteger, Date, DateTime, ForeignKey, Index, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

EMBEDDING_DIM = 1024


class Base(DeclarativeBase):
    pass


def _uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


def _timestamp() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now())


class Org(Base):
    """Primary key is the Better Auth org_id — Better Auth already owns org identity."""

    __tablename__ = "orgs"

    id: Mapped[str] = mapped_column(primary_key=True)
    created_at: Mapped[datetime] = _timestamp()
    # Set once, at first insert (see db/org.py's ensure_org) — a purely
    # local gate that needs no Stripe involvement during the trial itself.
    trial_ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    # All three stay null until the org goes through Checkout once.
    # subscription_status mirrors Stripe's own status values (trialing,
    # active, past_due, canceled, ...) verbatim — kept in sync by
    # routers/billing.py's webhook handler, never written anywhere else.
    stripe_customer_id: Mapped[str | None] = mapped_column(unique=True, nullable=True)
    stripe_subscription_id: Mapped[str | None] = mapped_column(unique=True, nullable=True)
    subscription_status: Mapped[str | None] = mapped_column(nullable=True)
    # Stripe event timestamp (not our own clock) that last wrote
    # subscription_status — webhook delivery order isn't guaranteed, so
    # billing.py's apply_webhook_event compares against this before
    # applying a status, rather than trusting arrival order.
    subscription_status_synced_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Set by billing.py's cancel_subscription (the in-app cancel flow) and
    # kept in sync from Stripe's own subscription.updated/deleted events
    # too, so it stays correct even if canceled from Stripe's dashboard
    # directly instead of through the app.
    cancel_at_period_end: Mapped[bool] = mapped_column(default=False, server_default="false")
    # The subscription's current billing period end, straight from
    # Stripe -- lets the settings page show the exact "access continues
    # until" date on a page reload without a live Stripe call on every
    # status check. Same sync sources as cancel_at_period_end above.
    current_period_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # "base" or "pro" — kept in sync by routers/billing.py's webhook handler
    # from the subscribed Stripe price id (see billing.py's PRICE_ID_TIER),
    # never written anywhere else. Nullable so an org that hasn't gone
    # through Checkout yet has no tier opinion; plan_limits.py's
    # cap_for_tier treats null the same as "base".
    plan_tier: Mapped[str | None] = mapped_column(nullable=True)


class McpApiKey(Base):
    __tablename__ = "mcp_api_keys"

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[str] = mapped_column(ForeignKey("orgs.id"), index=True)
    key_hash: Mapped[str] = mapped_column(unique=True)
    name: Mapped[str | None] = mapped_column(nullable=True)
    created_at: Mapped[datetime] = _timestamp()
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Key expiry and rotation. Nullable: null means
    # "never expires", not "unset by migration error" — every row that
    # existed before migration 0025 stays valid indefinitely rather than
    # getting retroactively expired on deploy. create_cli_key sets this to
    # a 90-day default at mint time (Settings.cli_key_default_ttl_days);
    # create_mcp_key deliberately leaves it null (see that endpoint's own
    # comment for why CLI and MCP keys diverge here). Checked alongside
    # revoked_at in auth/api_key.py's resolve_api_key_row — an expired key
    # fails auth resolution the same way a revoked one does.
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Snapshotted once, at mint time, from the minting user's live
    # session — only /v1/settings/cli-key (gated on a real session, not
    # another API key) is allowed to set this true. /v1/settings/mcp-keys
    # (the agent/MCP-serving path) always leaves it at the column default.
    is_admin: Mapped[bool] = mapped_column(default=False, server_default="false")
    # cli|mcp — which minting path created this row. Both key types have
    # always lived in this one table (same auth resolution, same
    # revocation column); this just makes the split explicit instead of
    # inferring it from name=="cli", so /v1/settings/cli-keys and
    # /v1/settings/mcp-keys can each see only their own rows.
    key_type: Mapped[str] = mapped_column(default="mcp", server_default="mcp")


class WebhookToken(Base):
    """Generic webhook ingestion. A deliberately
    separate table from McpApiKey rather than a third key_type: this
    credential can only ever create draft rules (routers/webhooks.py's one
    endpoint), nothing else McpApiKey-authenticated callers can do, and it
    authenticates by URL path segment (Zapier/monday/HubSpot's own webhook
    config UIs typically just take a plain URL, not a custom header),
    never a bearer header. No RLS — same reasoning as mcp_api_keys
    (migration 0001): resolving which org a token belongs to has to happen
    before the org is known, so RLS (which requires app.current_org
    already set) can't apply to this lookup."""

    __tablename__ = "webhook_tokens"

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[str] = mapped_column(ForeignKey("orgs.id"), index=True)
    token_hash: Mapped[str] = mapped_column(unique=True)
    name: Mapped[str | None] = mapped_column(nullable=True)
    created_at: Mapped[datetime] = _timestamp()
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class IngestEvent(Base):
    """Metadata only — never raw content. Raw text lives in the ARQ job
    payload (Redis, TTL-bound) and is gone long before this row is read.

    Nothing writes new rows here anymore — its only writers were the
    retired knowledge-unit capture pipeline (routers/capture.py, the MCP
    `capture` tool, the Slack `/brain` slash command) and
    routers/brain.py's conflict-merge endpoint, both gone along with
    KnowledgeUnit/Conflict. Left in place, not dropped — existing rows
    stay exactly as they are, a founder call for a future phase, not this
    one."""

    __tablename__ = "ingest_events"

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[str] = mapped_column(ForeignKey("orgs.id"), index=True)
    source: Mapped[str] = mapped_column()  # capture | slack | upload
    status: Mapped[str] = mapped_column(default="pending")  # pending|processed|failed
    provenance: Mapped[dict] = mapped_column(JSONB, default=dict)
    contributor_hash: Mapped[str] = mapped_column()
    created_at: Mapped[datetime] = _timestamp()
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class SkillPack(Base):
    __tablename__ = "skill_packs"

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[str] = mapped_column(ForeignKey("orgs.id"), index=True)
    version: Mapped[int] = mapped_column()
    manifest: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = _timestamp()

    files: Mapped[list["SkillFile"]] = relationship(back_populates="pack")

    __table_args__ = (UniqueConstraint("org_id", "version", name="uq_skill_pack_org_version"),)


class SkillFile(Base):
    __tablename__ = "skill_files"

    id: Mapped[uuid.UUID] = _uuid_pk()
    pack_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("skill_packs.id"), index=True)
    path: Mapped[str] = mapped_column()
    content: Mapped[str] = mapped_column()
    sha256: Mapped[str] = mapped_column()

    pack: Mapped["SkillPack"] = relationship(back_populates="files")


class SlackConnection(Base):
    """One active Slack workspace connection per org. org_id is unique (a
    reinstall upserts, matching the dashboard's "Reconnect" semantics) and
    team_id is unique too — the slash-command handler trusts this as the
    only mapping from a Slack workspace back to a tenant, so a workspace
    can never be connected to two orgs at once. bot_token_encrypted is
    Fernet ciphertext (see gnt/slack/crypto.py), never plaintext at rest."""

    __tablename__ = "slack_connections"

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[str] = mapped_column(ForeignKey("orgs.id"), unique=True, index=True)
    team_id: Mapped[str] = mapped_column(unique=True, index=True)
    team_name: Mapped[str] = mapped_column()
    bot_user_id: Mapped[str] = mapped_column()
    bot_token_encrypted: Mapped[str] = mapped_column()
    scope: Mapped[str] = mapped_column()
    installed_by_user_id: Mapped[str] = mapped_column()
    created_at: Mapped[datetime] = _timestamp()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class GithubConnection(Base):
    """One connected rules repo per org (org_id unique — reconnecting
    upserts, matching SlackConnection's semantics). A dedicated table, not a
    shared polymorphic Connector — Slack has no such abstraction either, and
    the two connections' shapes (repo_url/default_branch vs
    team_id/bot_user_id) don't overlap enough to justify one. pat_encrypted
    and webhook_secret_encrypted are Fernet ciphertext (gnt/github/crypto.py)
    under their own dedicated key — separate from Slack's, since a PAT with
    write access to a customer's rules repo is a materially higher-value
    secret than a Slack bot token scoped to commands/chat/im only.

    Two connect flows share this one table rather than a parallel model —
    an org is on exactly one of them at a time, and installation_id is the
    discriminator: NULL means the legacy PAT flow (pat_encrypted/
    webhook_secret_encrypted set, a per-repo webhook this org's own PAT
    registered), non-NULL means the GitHub App flow (both those columns
    NULL instead — nothing to persist there, since an App-connected org's
    tokens are minted per-operation and never stored, see
    gnt/github/app_auth.py). `gnt connect github --upgrade` swaps a row
    from one shape to the other in place (same org_id, same upsert
    routers/github.py's PAT connect already used).

    Deliberately excluded from migration 0007's RLS pass, for the same
    reason slack_connections is: the GitHub webhook receiver (routers/
    github_webhook.py) has to look this row up by repo_url from the
    payload *before* it knows which org the request belongs to — that
    bootstrap lookup can't be org-scoped by definition. A future RLS
    pass should not add this table without solving that lookup first."""

    __tablename__ = "github_connections"

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[str] = mapped_column(ForeignKey("orgs.id"), unique=True, index=True)
    repo_url: Mapped[str] = mapped_column(unique=True, index=True)
    default_branch: Mapped[str] = mapped_column(default="main")
    # NULL for an App-connected org — see this model's own docstring.
    pat_encrypted: Mapped[str | None] = mapped_column(nullable=True)
    webhook_secret_encrypted: Mapped[str | None] = mapped_column(nullable=True)
    # NULL for a PAT-connected org. Not secret (GitHub shows it in the
    # customer's own installation-settings URL) — stored plainly, same as
    # repo_url, not through github/crypto.py's Fernet discipline. Globally
    # unique across every installation of this App, not just per-org, so
    # the unique constraint doubles as a guard against two orgs somehow
    # racing to claim the same installation.
    installation_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True, unique=True, index=True)
    installed_by_user_id: Mapped[str] = mapped_column()
    created_at: Mapped[datetime] = _timestamp()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Rule(Base):
    """The unified rules model — replaces the split between
    DecisionRule (structured condition/action) and
    KnowledgeUnit (flat facts/policies) with one reviewed, cited,
    versioned unit. Built alongside the old tables, not on top of them;
    nothing here reads or writes DecisionRule/KnowledgeUnit.

    Versioning: never mutate an approved rule in place. Editing an
    approved rule creates a new row (version = old.version + 1,
    previous_version_id pointing back). Approving that new row sets the
    OLD row's status to "deprecated" and its superseded_by to the new
    row's id — "deprecated" is how a superseded version reads, same as a
    manually retired one, not a separate 5th status.
    """

    __tablename__ = "rules"

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[str] = mapped_column(ForeignKey("orgs.id"), index=True)
    title: Mapped[str] = mapped_column()
    body: Mapped[str] = mapped_column()
    status: Mapped[str] = mapped_column(default="draft")  # draft|in_review|approved|deprecated
    confidence: Mapped[float] = mapped_column(default=0.7)
    owner_user_id: Mapped[str] = mapped_column()  # Better Auth user id
    # [{"source_type": ..., "source_id": ..., "permalink": ..., "captured_at": ...}]
    source_citations: Mapped[list] = mapped_column(JSONB, default=list)
    last_validated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    version: Mapped[int] = mapped_column(default=1)
    superseded_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("rules.id"), nullable=True)
    previous_version_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("rules.id"), nullable=True)
    approved_by: Mapped[str | None] = mapped_column(nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = _timestamp()

    # Phase 2 planned search_rules embedding title+body here on create/edit,
    # reusing the same embed() pipeline function knowledge_units used — that
    # never actually got wired up (routers/rules.py's create_rule/edit_rule
    # never write to this column) before search_rules moved onto apps/store's
    # own ZeroEntropy-backed embedding instead. Column and index appear
    # unused; left alone here since dropping a live rules-table column is
    # its own decision, out of scope for the removal this comment update
    # rides along with.
    embedding: Mapped[list[float] | None] = mapped_column(Vector(EMBEDDING_DIM), nullable=True)
    tags: Mapped[list] = mapped_column(JSONB, default=list)

    __table_args__ = (Index("ix_rules_org_status", "org_id", "status"),)


class RuleAuditLog(Base):
    """Append-only. Never updated or deleted — nothing in this codebase
    should ever UPDATE or DELETE a row here."""

    __tablename__ = "rule_audit_log"

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[str] = mapped_column(ForeignKey("orgs.id"), index=True)
    rule_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("rules.id"), index=True)
    action: Mapped[str] = mapped_column()  # created|submitted|approved|rejected|deprecated
    actor_user_id: Mapped[str] = mapped_column()
    before: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    after: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = _timestamp()


class OnboardingEvent(Base):
    """Append-only funnel-tracking log — one row per onboarding milestone
    an org hits (slack_connected, github_connected, rule_proposed,
    rule_approved — "capture" was a fifth type, retired along with the
    knowledge-unit pipeline that logged it; existing rows with that type
    are untouched, nothing writes new ones). Deliberately minimal: this is
    not a general analytics/events table, just enough to answer "how close
    is this org to a working setup" (routers/brain.py's
    /v1/onboarding/status) and, later, to meter ROI off the same rows —
    counting event_type over time per org already gets most of the way
    there without a schema change."""

    __tablename__ = "onboarding_events"

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[str] = mapped_column(ForeignKey("orgs.id"), index=True)
    event_type: Mapped[str] = mapped_column()  # slack_connected|github_connected|rule_proposed|rule_approved
    created_at: Mapped[datetime] = _timestamp()

    __table_args__ = (Index("ix_onboarding_events_org_type", "org_id", "event_type"),)


class RuleGap(Base):
    """Append-only coverage-gap log powering gap-aware answers. One row
    per MCP call that surfaced a "no approved rule covers this" signal on
    the serving path: a search_rules call with zero hits after
    the similarity threshold, or a check_action call whose needs_human
    verdict was specifically the no-coverage branch (action_check.py's
    `no_coverage` field — not the "rules retrieved but ambiguous" branch,
    which also returns needs_human but isn't a coverage gap).

    Same append-only, org-indexed shape as OnboardingEvent, but kept as its
    own table rather than folded into that one: OnboardingEvent's
    event_type is a small fixed funnel-milestone enum, while query_text
    here is arbitrary free text an org's rules genuinely don't cover yet —
    a different query shape (`gnt gaps` groups/counts by query_text, not
    just event_type) and a different retention story (this is meant to be
    read back and acted on, not just counted).

    Deliberately in Postgres, not only the stdout _log_mcp_call stream
    every MCP call already gets: printing has no query interface, and
    `gnt gaps` needs to GROUP BY / COUNT / ORDER BY to answer "top
    uncovered queries" — see gap_tracking.py."""

    __tablename__ = "rule_gaps"

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[str] = mapped_column(ForeignKey("orgs.id"), index=True)
    tool: Mapped[str] = mapped_column()  # search_rules|check_action
    query_text: Mapped[str] = mapped_column()
    created_at: Mapped[datetime] = _timestamp()

    __table_args__ = (Index("ix_rule_gaps_org_tool", "org_id", "tool"),)


class RuleStaleness(Base):
    """Nightly staleness snapshot per approved rule — see gnt.staleness for
    the decay math, workers/tasks_staleness.py for the cron job that
    writes this table. Approved rules themselves live in apps/store's
    git-native engine, not here (see this file's own Rule docstring above
    — that model predates the Phase 4 store migration and nothing reads
    or writes it anymore); this table is Postgres-side because that's
    what `gnt stale` needs to query cheaply ("which rules are due for
    re-validation" is a WHERE/ORDER BY, same reasoning as RuleGap above)
    and because the calibration-signal collection pipeline (see
    CalibrationEvent below) needs a history of staleness snapshots over
    time, which a number recomputed fresh on every request and thrown
    away wouldn't give it.

    One row per (org_id, rule_slug), upserted nightly — a full snapshot
    of that org's currently-approved rules, not an append-only log; a
    rule that stops being approved (deprecated, superseded by an edit)
    has its row deleted the next run rather than left stale forever. This
    is never the read path for a single rule's live freshness — MCP/CLI
    rule responses compute that on the fly from the rule's own
    approvedAt/lastValidatedAt (gnt.staleness.rule_freshness) so they're
    never a day behind reporting how stale a rule is."""

    __tablename__ = "rule_staleness"

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[str] = mapped_column(ForeignKey("orgs.id"), index=True)
    rule_slug: Mapped[str] = mapped_column()
    title: Mapped[str] = mapped_column()
    age_days: Mapped[float] = mapped_column()
    freshness_score: Mapped[float] = mapped_column()
    is_stale: Mapped[bool] = mapped_column()
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("org_id", "rule_slug", name="uq_rule_staleness_org_rule"),
        Index("ix_rule_staleness_org_stale", "org_id", "is_stale"),
    )


class CalibrationEvent(Base):
    """Append-only calibration-signal log. Labels confidence/decay as
    uncalibrated for now, and starts collecting the calibration data a
    future pass would need to fix that. Confidence scores and decay
    lambdas are admitted first-pass
    guesses (see mcp_server/server.py's confidence_estimate field and
    gnt.staleness's module docstring); this table is what a future
    calibration pass would read to check whether those guesses are any
    good. Nothing in this codebase consumes these rows yet — see
    gnt.calibration's module docstring for why that's deliberate.

    Same append-only, org-indexed shape as OnboardingEvent/RuleGap, but
    one table for three distinct signals (event_type) rather than three
    tables, since all three are small, low-volume, structurally similar
    "something happened to a rule, worth remembering" events:

    - rule_deprecated: age_days set, detail unset.
    - conflict_flagged: written by propose_rule when
      pipeline/rule_conflict.py's soft check flags a candidate; pr_number
      set so conflict_override below can find it again at merge time.
      detail carries {"relation", "candidate_slug"}.
    - conflict_override: written by the GitHub webhook handler when a
      merge lands on a PR that had a conflict_flagged row for the same
      (org_id, rule_slug, pr_number) — a human merged past the flag.
      detail is copied from the conflict_flagged row it matched.
    - revalidation_outcome: written by deprecate_rule/edit_rule when the
      rule being acted on was already flagged stale by the last nightly
      compute_rule_staleness run (see RuleStaleness above). age_days is that run's
      snapshot age, detail is {"action": "deprecated"|"edited"}.
    """

    __tablename__ = "calibration_events"

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[str] = mapped_column(ForeignKey("orgs.id"), index=True)
    # rule_deprecated|conflict_flagged|conflict_override|revalidation_outcome
    event_type: Mapped[str] = mapped_column()
    rule_slug: Mapped[str | None] = mapped_column(nullable=True)
    pr_number: Mapped[int | None] = mapped_column(nullable=True)
    age_days: Mapped[float | None] = mapped_column(nullable=True)
    detail: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = _timestamp()

    __table_args__ = (
        Index("ix_calibration_events_org_type", "org_id", "event_type"),
        Index("ix_calibration_events_org_rule_pr", "org_id", "rule_slug", "pr_number"),
    )


class ContradictionFinding(Base):
    """Dedup log for the continuous contradiction sweep — see
    workers/tasks_contradictions.py for the nightly cron job that
    writes this table, gnt.contradiction_findings for the read/write
    helpers. One row per (org_id, rule_slug_a, rule_slug_b) pair the
    sweep has already filed a GitHub issue for — checked before
    judge_conflict runs on that pair again, and before a second issue
    gets opened for the same contradiction, so an unresolved finding
    doesn't get re-flagged (and re-billed in LLM comparisons) every
    single night until a human resolves it.

    rule_slug_a/rule_slug_b are always stored in sorted order (see
    contradiction_findings.canonical_pair) so a pair compared as (a, b)
    one night and (b, a) another still dedupes as the same row —
    same-tag sampling has no guaranteed pair ordering across runs.

    Written only once a GitHub issue has actually been opened for the
    pair (issue_number/issue_url are always set, never null) — this
    table is a record of what was filed, not of what was merely judged a
    contradiction, since the latter would silently suppress re-filing
    forever with nothing for a human to act on.

    Same append-only, org-indexed shape as RuleGap/RuleStaleness/
    CalibrationEvent, and genuinely org-scoped with no auth-bootstrap
    lookup need, same reasoning as those three — RLS follows the
    standard tenant_isolation pattern (migration 0022)."""

    __tablename__ = "contradiction_findings"

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[str] = mapped_column(ForeignKey("orgs.id"), index=True)
    rule_slug_a: Mapped[str] = mapped_column()
    rule_slug_b: Mapped[str] = mapped_column()
    # duplicate|refines|contradicts — always "contradicts" today (the
    # sweep only ever files an issue for that relation, see
    # workers/tasks_contradictions.py's module docstring on why), but
    # stored rather than hardcoded so a future widening of what the sweep
    # files doesn't need a migration to record it.
    relation: Mapped[str] = mapped_column()
    issue_number: Mapped[int] = mapped_column()
    issue_url: Mapped[str] = mapped_column()
    # The proposed-resolution PR the sweep opens
    # alongside the issue above (a new draft amendment of whichever of the
    # pair's two rules the sweep picked to defer, pushed through the
    # normal submit -> propose lifecycle — see
    # workers/tasks_contradictions.py). Nullable, unlike issue_number/
    # issue_url: the issue is always filed before a PR is even attempted,
    # so a row can legitimately exist with the issue recorded and no PR —
    # opening the proposed-resolution PR is best-effort (a GitHub error, a
    # conflict on the new draft, anything else) and must never re-trigger
    # a duplicate issue on a rerun just because the PR half didn't land.
    pr_number: Mapped[int | None] = mapped_column(nullable=True)
    pr_url: Mapped[str | None] = mapped_column(nullable=True)
    filed_at: Mapped[datetime] = _timestamp()

    __table_args__ = (
        UniqueConstraint(
            "org_id", "rule_slug_a", "rule_slug_b", name="uq_contradiction_findings_org_pair"
        ),
    )


class StalenessRefreshProposal(Base):
    """Dedup log for the staleness sweep's refresh/deprecate half (see
    workers/tasks_staleness.py for the nightly job that writes this
    table, gnt.staleness_refresh for the read/write helpers). One row per
    (org_id, rule_slug, reason, content_fingerprint) the sweep has
    already opened a refresh-or-deprecate PR for — checked before a new
    draft version/PR gets created for the same rule again, so an
    unresolved flag doesn't get re-proposed every single night until a
    human actually merges or rejects it. Mirrors ContradictionFinding's
    role for the sibling contradiction sweep exactly, one table per sweep
    rather than a shared one — the two dedup keys don't overlap (a pair
    of rule slugs vs. one rule slug plus a reason and a content
    fingerprint) enough to justify forcing them into one shape.

    content_fingerprint, not just (org_id, rule_slug, reason), is the
    dedup key on purpose: if the source drifts again before a human gets
    to the first proposal (a "refresh" flag against one version of the
    drift, then the file changes a second time before anyone reviews it),
    that's a genuinely new finding worth a fresh proposal, not something
    the first row should silently keep suppressing forever. See
    workers/tasks_staleness.py's _fingerprint for how this is computed
    per reason.

    reason is "refresh" (source content changed) or "deprecate" (source
    file no longer exists) — see that module's own docstring for why
    both share this one mechanism instead of being two different code
    paths.

    Same append-only, org-scoped shape as ContradictionFinding, and
    genuinely org-scoped with no auth-bootstrap lookup need, same
    reasoning as that table — RLS follows the standard tenant_isolation
    pattern."""

    __tablename__ = "staleness_refresh_proposals"

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[str] = mapped_column(ForeignKey("orgs.id"), index=True)
    rule_slug: Mapped[str] = mapped_column()
    reason: Mapped[str] = mapped_column()  # refresh|deprecate
    source_path: Mapped[str] = mapped_column()
    content_fingerprint: Mapped[str] = mapped_column()
    new_rule_slug: Mapped[str] = mapped_column()
    pr_number: Mapped[int] = mapped_column()
    pr_url: Mapped[str] = mapped_column()
    proposed_at: Mapped[datetime] = _timestamp()

    __table_args__ = (
        UniqueConstraint(
            "org_id",
            "rule_slug",
            "reason",
            "content_fingerprint",
            name="uq_staleness_refresh_org_rule_reason_fingerprint",
        ),
    )


class RoiCounter(Base):
    """Per-org daily usage counters, for ROI metering and the weekly
    number (see gnt.roi_metrics for the read/write helpers).

    One row per (org_id, day), upserted throughout the day by the MCP
    serving path (mcp_server/server.py's search_rules/get_rule/check_action)
    rather than appended — the cheapest possible shape for a counter that
    increments on every MCP call: an UPDATE ... SET x = x + 1 (or one
    INSERT the first time an org sees traffic on a given day), never a
    per-call row. _log_mcp_call's stdout stream carries the same signal but
    has no query interface (see that function's own docstring); this table
    is what the weekly digest and `gnt status` actually sum.

    Daily granularity, not one running total per org, so "this week vs.
    last week" (the coverage-growth number shown in the weekly digest) is
    a plain SUM over two trailing 7-day windows — no separate
    weekly-snapshot mechanism needed."""

    __tablename__ = "roi_counters"

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[str] = mapped_column(ForeignKey("orgs.id"), index=True)
    day: Mapped[date] = mapped_column(Date)
    rules_served: Mapped[int] = mapped_column(default=0, server_default="0")
    actions_checked: Mapped[int] = mapped_column(default=0, server_default="0")
    actions_blocked: Mapped[int] = mapped_column(default=0, server_default="0")
    actions_needs_human: Mapped[int] = mapped_column(default=0, server_default="0")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (UniqueConstraint("org_id", "day", name="uq_roi_counters_org_day"),)


class LlmUsage(Base):
    """Per-org monthly LLM spend tracking. check_action made every agent
    decision an LLM call on the bill, and ingestion multiplies that
    exposure, so a spend quota has to exist and be enforced before any of
    that ships further. See gnt.llm_quota
    for the read/enforce/record helpers and the three call sites it gates:
    action_check.py's judge_action, pipeline/rule_conflict.py's
    judge_conflict (both propose_rule and the nightly contradiction sweep
    in workers/tasks_contradictions.py call it).

    One row per (org_id, month), upserted the same atomic "INSERT ... ON
    CONFLICT DO UPDATE, no per-call row" shape as roi_counters — this
    table sits on the same hot paths (check_action, propose_rule, the
    nightly sweep), so it gets the same cheap-increment discipline.
    Monthly, not daily like roi_counters, because a spend QUOTA is
    inherently a monthly-aggregate concept, not a week-over-week trend
    line — no window-comparison read path needed.

    Cost is stored in micros (millionths of a dollar, integer) rather than
    a float/Numeric dollar amount — a running total built out of many
    small atomic `+=` increments (one per LLM call) is exactly the kind of
    accumulation where float drift compounds; integer micros sidesteps
    that (see gnt.llm_quota's _dollars_to_micros/_micros_to_dollars).

    Genuinely org-scoped with org_id known upfront from get_current_org /
    require_org_id (unlike mcp_api_keys/webhook_tokens, which exist to
    RESOLVE an org from an opaque token and can't be RLS-scoped until that
    lookup completes) — same reasoning as roi_counters/rule_gaps/etc., so
    RLS follows that same established pattern."""

    __tablename__ = "llm_usage"

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[str] = mapped_column(ForeignKey("orgs.id"), index=True)
    month: Mapped[date] = mapped_column(Date)
    input_tokens: Mapped[int] = mapped_column(default=0, server_default="0")
    output_tokens: Mapped[int] = mapped_column(default=0, server_default="0")
    estimated_cost_micros: Mapped[int] = mapped_column(default=0, server_default="0")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (UniqueConstraint("org_id", "month", name="uq_llm_usage_org_month"),)


class ZendeskConnection(Base):
    """One connected Zendesk instance per org (org_id unique — reconnecting
    upserts, matching SlackConnection/GithubConnection's semantics). A
    self-serve API token (subdomain + agent email + token, Zendesk's own
    email/token basic-auth scheme — see gnt/zendesk/client.py) rather than
    an OAuth app, so there's no app-review step blocking a customer from
    connecting on day one.

    api_token_encrypted is Fernet ciphertext (gnt/zendesk/crypto.py) under
    its own dedicated key, same reasoning as github_pat_encrypted having
    its own key separate from Slack's — see zendesk_token_encryption_key's
    own comment in config.py.

    RLS-eligible, unlike SlackConnection/GithubConnection: neither of
    those has RLS because something else (a Slack slash command's team_id,
    a GitHub webhook's repo_url) has to look the row up BEFORE an org_id is
    known. Zendesk has no equivalent inbound webhook — the nightly sync
    (workers/tasks_zendesk.py) only ever reads this row by org_id, already
    inside a scope_to_org'd session — so the standard tenant_isolation
    policy applies here same as contradiction_findings/roi_counters/etc."""

    __tablename__ = "zendesk_connections"

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[str] = mapped_column(ForeignKey("orgs.id"), unique=True, index=True)
    subdomain: Mapped[str] = mapped_column()
    agent_email: Mapped[str] = mapped_column()
    api_token_encrypted: Mapped[str] = mapped_column()
    installed_by_user_id: Mapped[str] = mapped_column()
    created_at: Mapped[datetime] = _timestamp()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class ZendeskSyncState(Base):
    """One row per org, upserted after every nightly sync run (success OR
    failure) by workers/tasks_zendesk.py — the Zendesk connector's
    sync-status health surface. Deliberately a full-snapshot upsert, not an
    append-only log like ContradictionFinding/StalenessRefreshProposal:
    "last successful sync, last error" is a current-state question (what
    `GET /v1/settings/zendesk/sync-status` and, eventually, `gnt status`
    answer), not a history a customer needs to page through — same
    "current state, not a log" reasoning RuleStaleness already applies to
    its own nightly snapshot.

    last_synced_at is set on every run regardless of outcome (proves the
    cron actually fired); last_success_at only on a run that completed
    without raising (proves data actually landed); last_error/
    last_error_at are cleared back to null the next run that succeeds, so
    a customer looking at this never sees a stale error from three nights
    ago once the connector has since recovered."""

    __tablename__ = "zendesk_sync_states"

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[str] = mapped_column(ForeignKey("orgs.id"), unique=True, index=True)
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str | None] = mapped_column(nullable=True)
    last_error_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    items_scanned_last_run: Mapped[int] = mapped_column(default=0, server_default="0")
    candidates_proposed_last_run: Mapped[int] = mapped_column(default=0, server_default="0")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class ZendeskProcessedItem(Base):
    """Dedup log for the nightly Zendesk sync (workers/tasks_zendesk.py) —
    mirrors ContradictionFinding/StalenessRefreshProposal's role for their
    own sweeps exactly. One row per (org_id, item_type, item_id,
    content_fingerprint) the sync has already run through extraction for,
    checked before a macro/internal note/article gets sent to the
    content_extraction_model again, so an org's full macro library and
    ticket history isn't re-extracted (and re-billed) every single night.

    content_fingerprint, not just (org_id, item_type, item_id), is part of
    the key for the same reason staleness_refresh_proposals' fingerprint
    is: a macro whose action text gets edited after its first sync is
    genuinely new content worth a fresh extraction pass, not something the
    first row should silently keep suppressing forever."""

    __tablename__ = "zendesk_processed_items"

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[str] = mapped_column(ForeignKey("orgs.id"), index=True)
    # macro|internal_note|article — see zendesk/client.py's declared-field
    # types for what each item_type actually reads.
    item_type: Mapped[str] = mapped_column()
    item_id: Mapped[str] = mapped_column()
    content_fingerprint: Mapped[str] = mapped_column()
    processed_at: Mapped[datetime] = _timestamp()

    __table_args__ = (
        UniqueConstraint(
            "org_id", "item_type", "item_id", "content_fingerprint", name="uq_zendesk_processed_items"
        ),
    )


class IntercomConnection(Base):
    """One connected Intercom workspace per org (org_id unique — reconnecting
    upserts, matching SlackConnection/GithubConnection/ZendeskConnection's
    semantics). A self-serve Personal Access Token (see gnt/intercom/client.py)
    rather than an OAuth app, so there's no app-review step blocking a
    customer from connecting on day one. Unlike ZendeskConnection there's no
    subdomain/agent_email column — Intercom has no per-customer subdomain;
    every request goes to the same api.intercom.io host and the token alone
    identifies the workspace.

    access_token_encrypted is Fernet ciphertext (gnt/intercom/crypto.py) under
    its own dedicated key, same reasoning as zendesk_connections.
    api_token_encrypted having its own key — see
    intercom_token_encryption_key's own comment in config.py.

    RLS-eligible, unlike SlackConnection/GithubConnection, for the exact same
    reason as ZendeskConnection: no inbound webhook has to look this row up
    by an external id BEFORE an org_id is known — the nightly sync
    (workers/tasks_intercom.py) only ever reads this row by org_id, already
    inside a scope_to_org'd session — so the standard tenant_isolation policy
    applies here same as contradiction_findings/roi_counters/etc."""

    __tablename__ = "intercom_connections"

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[str] = mapped_column(ForeignKey("orgs.id"), unique=True, index=True)
    access_token_encrypted: Mapped[str] = mapped_column()
    installed_by_user_id: Mapped[str] = mapped_column()
    created_at: Mapped[datetime] = _timestamp()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class NotionConnection(Base):
    """One connected Notion workspace per org (org_id unique — reconnecting
    upserts, same semantics as SlackConnection/IntercomConnection). A real
    OAuth token (gnt/notion/oauth.py), not a self-serve integration token —
    unlike every other MCP-in source in this codebase, this credential is
    acquired server-side (the dashboard's "Connect Notion" button) and
    handed back to the CLI over GET /v1/notion/token so the CLI can keep
    doing the actual read/parse/chunk work locally, exactly as it already
    does for a pasted token — see apps/cli/src/prebrain/mcp-notion.ts's own
    doc comment for that side of the split.

    workspace_id/workspace_name/bot_id come straight from Notion's own OAuth
    token response (its documented shape, not guessed) — display-only, used
    for the dashboard's "Connected to <workspace>" status line, never sent
    anywhere else.

    access_token_encrypted is Fernet ciphertext (gnt/notion/crypto.py) under
    its own dedicated key — same "don't share a key across connectors of
    different value" reasoning notion_token_encryption_key's own comment in
    config.py gives.

    RLS-eligible, same reasoning IntercomConnection's own docstring gives:
    no inbound webhook needs to look this row up by an external id before an
    org_id is known — every read here is already inside a scope_to_org'd
    session."""

    __tablename__ = "notion_connections"

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[str] = mapped_column(ForeignKey("orgs.id"), unique=True, index=True)
    access_token_encrypted: Mapped[str] = mapped_column()
    workspace_id: Mapped[str | None] = mapped_column(nullable=True)
    workspace_name: Mapped[str | None] = mapped_column(nullable=True)
    bot_id: Mapped[str | None] = mapped_column(nullable=True)
    installed_by_user_id: Mapped[str] = mapped_column()
    created_at: Mapped[datetime] = _timestamp()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class LinearConnection(Base):
    """One connected Linear workspace per org — same shape and same
    dashboard-acquires/CLI-reads split as NotionConnection's own docstring
    describes, see that model for the full reasoning (applies here
    unchanged). No workspace/user identity column the way NotionConnection
    has one: Linear's OAuth token response carries no workspace or user
    info without a separate API call this task doesn't make, so the
    dashboard's status line for this connector is just "Connected", not
    "Connected to <workspace>".

    access_token_encrypted is Fernet ciphertext (gnt/linear/crypto.py)
    under its own dedicated key, same reasoning as every other connector's
    key in this file."""

    __tablename__ = "linear_connections"

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[str] = mapped_column(ForeignKey("orgs.id"), unique=True, index=True)
    access_token_encrypted: Mapped[str] = mapped_column()
    installed_by_user_id: Mapped[str] = mapped_column()
    created_at: Mapped[datetime] = _timestamp()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class IntercomSyncState(Base):
    """One row per org, upserted after every nightly sync run (success OR
    failure) by workers/tasks_intercom.py — the Intercom connector's
    sync-status health surface. Same "current state, not a log" shape as
    ZendeskSyncState — see that model's own docstring for the full
    reasoning (it applies here unchanged).

    last_synced_at is set on every run regardless of outcome; last_success_at
    only on a run that completed without raising; last_error/last_error_at
    are cleared back to null the next run that succeeds."""

    __tablename__ = "intercom_sync_states"

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[str] = mapped_column(ForeignKey("orgs.id"), unique=True, index=True)
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str | None] = mapped_column(nullable=True)
    last_error_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    items_scanned_last_run: Mapped[int] = mapped_column(default=0, server_default="0")
    candidates_proposed_last_run: Mapped[int] = mapped_column(default=0, server_default="0")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class IntercomProcessedItem(Base):
    """Dedup log for the nightly Intercom sync (workers/tasks_intercom.py) —
    mirrors ZendeskProcessedItem's role for its own sweep exactly. One row
    per (org_id, item_type, item_id, content_fingerprint) the sync has
    already run through extraction for, checked before a saved reply/
    internal note/article gets sent to the content_extraction_model again,
    so a workspace's full saved-reply library and conversation history
    isn't re-extracted (and re-billed) every single night.

    content_fingerprint is part of the key for the same reason
    ZendeskProcessedItem's is: a saved reply whose text gets edited after
    its first sync is genuinely new content worth a fresh extraction pass,
    not something the first row should silently keep suppressing forever."""

    __tablename__ = "intercom_processed_items"

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[str] = mapped_column(ForeignKey("orgs.id"), index=True)
    # saved_reply|internal_note|article — see intercom/client.py's declared-
    # field types for what each item_type actually reads.
    item_type: Mapped[str] = mapped_column()
    item_id: Mapped[str] = mapped_column()
    content_fingerprint: Mapped[str] = mapped_column()
    processed_at: Mapped[datetime] = _timestamp()

    __table_args__ = (
        UniqueConstraint(
            "org_id", "item_type", "item_id", "content_fingerprint", name="uq_intercom_processed_items"
        ),
    )

class LlmUsageGlobal(Base):
    """Global (cross-org) running total for the same month — the aggregate
    circuit-breaker on total LLM spend, distinct from LlmUsage's per-org
    quota above. No org_id column at all: this is deliberately NOT tenant data,
    so (unlike LlmUsage) there's no per-org RLS policy that could apply to
    it in the first place. Same "no RLS" outcome as migration 0024's
    webhook_tokens, for the opposite reason: that table has no RLS because
    an org isn't resolved YET; this one has no RLS because org never
    applies AT ALL.

    alert_50/80/100_sent_at are idempotency markers, not just timestamps
    for humans: gnt.llm_quota.record_llm_usage locks this row
    (SELECT ... FOR UPDATE) before comparing old vs. new spend against the
    configured thresholds, so a threshold only ever fires its
    sentry_sdk.capture_message once per month, not once per call for
    every call after spend is already past it."""

    __tablename__ = "llm_usage_global"

    id: Mapped[uuid.UUID] = _uuid_pk()
    month: Mapped[date] = mapped_column(Date, unique=True)
    input_tokens: Mapped[int] = mapped_column(default=0, server_default="0")
    output_tokens: Mapped[int] = mapped_column(default=0, server_default="0")
    estimated_cost_micros: Mapped[int] = mapped_column(default=0, server_default="0")
    alert_50_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    alert_80_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    alert_100_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
