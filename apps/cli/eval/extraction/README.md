# Extraction quality eval

A benchmark for `gnt prebrain`'s extraction step
(`apps/cli/src/prebrain/extraction/`): seeded source documents with
expected policies, measuring precision (no hallucinated rules) and recall
(real policies found), for both extraction modes -- cloud (`cloud.ts`,
Anthropic's API) run in CI, local (`local.ts`, a local Ollama daemon)
measured by hand and its gap documented.

Modeled on this repo's other two quality evals
(`apps/api/eval/rule_retrieval/`, `apps/cli/eval/privacy-gate/`): a real
corpus, a pure scoring harness separate from the thing that runs it, and a
README with actual measured numbers instead of a promise. One thing is
fundamentally different here, and it shapes almost everything below:
**there is no fixed "correct" model output to precompute and commit.**
The retrieval eval precomputes embeddings once and replays them for free;
the privacy gate is 100% local and deterministic, so it just runs for
real every time. Extraction quality can only be measured by actually
calling the model being evaluated -- a real, paid API call every time this
eval runs in cloud mode. That's why this eval is wired into CI
differently from the other two: see "CI wiring" below.

## Layout

- `corpus.jsonl` -- 46 seeded source documents shaped like what a prebrain
  walker actually chunks (see `apps/cli/src/prebrain/types.ts`'s
  `PrebrainChunk`): a `repo-scan` README/CONTRIBUTING excerpt, a
  `docs-dir` handbook paragraph, a `notion-export` decision doc, a live
  `mcp-notion`/`mcp-monday` page/item shaped exactly like
  `buildProseDocument`'s own assembly (a title heading, the item's own
  prose, an optional `## Comments` section), or a `gitlab-threads` MR/issue
  discussion, `figma-comments` design-review thread, `hubspot-notes` CRM
  call note, or `datadog-notebooks` runbook -- each a few sentences long
  (matching the walkers' own ~1200-char chunk cap, not an artificially
  long document).
  - 30 `policy` documents, each with one or more `expected` policies a
    good extraction should find (real decision-prose: refund windows, SLA
    thresholds, escalation triggers, access/security rules, expense
    policy, a data-deletion SLA, a deal-approval threshold -- deliberately
    varied topics, not one theme repeated). Several documents carry more
    than one `expected` entry on purpose: real source prose often states
    two distinct policies in one paragraph (a primary rule plus a stated
    exception or a related follow-up action), and a good extraction that
    finds both must not be scored as a false positive for finding the
    second one just because an earlier version of this corpus only
    tracked the first.
  - 16 `no_policy` documents (marketing copy, changelog entries, a
    getting-started guide, meeting/standup notes, an architecture
    overview, a glossary, a feature-announcement draft, a status update,
    a flaky-test discussion, casual design feedback, a routine customer
    check-in, a weekly metrics summary) with an empty `expected` list --
    these exist so precision has something to fail against. A good
    extraction pass over this kind of prose should find zero rules; any
    rule extracted from one of these documents is by definition a false
    positive.
  - `mcp-notion` and `mcp-monday` were the two
    connectors this eval shipped without a fixture for (every other walker
    that existed at the time had at least one) -- one `policy` and one
    `no_policy` document were added for each, proving both connectors'
    real output shape (a page's markdown plus its comments; a board
    item's fields plus its updates) can seed a usable draft rule and
    doesn't hallucinate one from ordinary non-decision content.
  - A later pass added the same policy/no_policy pair for `gitlab-threads`,
    `figma-comments`, `hubspot-notes`, and `datadog-notebooks` -- four
    connectors whose content style (developer discussion, casual comment
    threads, terse CRM notes, technical runbooks) is genuinely different
    from the polished written docs the earlier fixtures drew from, not
    just a different walker label on the same prose shape.
    `mcp-jira`/`mcp-sentry`/`mcp-linear` are lower priority for a fixture
    of their own: they route through the exact same `buildProseDocument`
    helper `mcp-notion`/`mcp-monday` already exercise, and the extraction
    prompt never sees the walker label, only the resulting text -- so
    their real coverage gap is content diversity, not structural shape.
    Connectors that produce a genuinely different input shape --
    conversational meeting transcripts (`mcp-zoom`, `mcp-granola`,
    `meeting-notes-export`), email threads (`gmail-export`,
    `outlook-export`, `mbox`), and fully customer-defined free text
    (`airtable`) -- remain uncovered and are the next priority, not yet
    done.
- `harness.ts` -- pure scoring: `matchesPolicy`, `scoreDocument`, and
  `runExtractionQuality` compute recall and precision, overall and
  per-category, from a corpus document and the extraction step's real
  output. Never imports `extractRules` or calls a model -- see
  `apps/cli/test/prebrain/extraction/eval-harness.test.ts`, which
  exercises this module against synthetic fixtures with no real
  extraction involved.
- `run.ts` -- the thing that actually runs `corpus.jsonl` through the
  real `extractRules` entry point (cloud or local mode, chosen with
  `--mode`) and either prints a report or (`--write-baseline`) writes a
  baseline file. Run by hand with `bun run eval:extraction -- <flags>`
  from `apps/cli`.
- `baseline.json` -- recorded cloud-mode metrics, gated by
  `apps/cli/test/prebrain/extraction/eval-gate.test.ts` whenever
  `ANTHROPIC_API_KEY` is set. **Does not exist yet in this repo -- see
  "No recorded cloud baseline yet" below.**
- `baseline.local.json` -- the local-mode equivalent, written by
  `--mode local --write-baseline`. Not read by any CI gate (see "Local
  mode" below); purely a developer-generated reference file.

## The matching heuristic

LLM output won't match an expected policy's text verbatim, so each
expected policy carries `keyTerms`: a short list of the distinguishing
facts it hinges on -- almost always the specific number, threshold, or
named term (`"30 day"`, `"$50"`, `"sev1"`, `"72 hour"`). An extracted rule
counts as matching an expected policy when **every** one of that policy's
`keyTerms` appears as a case-insensitive substring somewhere in the
rule's `title + body` (see `matchesPolicy` in `harness.ts`).

This is a cheap, deterministic heuristic on purpose, chosen over a second
LLM-as-judge call -- a judge call would double the cost of every real run
of this eval and add its own noise to what's supposed to be a stable
regression gate. It's the same spirit as the retrieval eval's exact-slug
matching (`harness.py`'s `score_query`), just against a looser fixture
shape: a handful of distinguishing words/numbers instead of one exact id.
It's also legible by inspection -- open `corpus.jsonl` next to a run's
printed report and you can eyeball whether a match (or a miss) is fair,
the same way a human could sanity-check the retrieval eval's slug
matches.

**Recall** = of the expected policies in the corpus, how many had at
least one extracted rule match them.
**Precision** = of the rules the extraction step actually produced, how
many matched a real expected policy (i.e., weren't hallucinated).

A `no_policy` document has zero expected policies, so its recall is
reported as a vacuous `1` (nothing to have missed) -- the meaningful
number for that bucket is precision, where any extracted rule is
automatically a false positive since there was nothing real to match.

## Running it

From `apps/cli`:

```bash
bun run eval:extraction -- --mode cloud                      # print a report (needs ANTHROPIC_API_KEY)
bun run eval:extraction -- --mode cloud --write-baseline     # also (re)write baseline.json
bun run eval:extraction -- --mode local                      # against your own Ollama daemon
bun run eval:extraction -- --mode local --ollama-model llama3.1:8b --write-baseline
```

Cloud mode calls the real `extractFromChunkCloud` path once per document
(34 real Anthropic API calls against `claude-haiku-4-5`, this codebase's
established cost-conscious model choice -- see `DEFAULT_MODEL` in
`apps/cli/src/prebrain/extraction/cloud.ts`). Local mode calls the real
`extractFromChunkLocal` path against whatever Ollama daemon `--ollama-host` points at (default
`http://localhost:11434`, same as `local.ts`'s own default), with no API
cost but the reliability caveats `local.ts`'s own doc comment already
names (weaker instruction-following, occasional non-conforming JSON).

## No recorded cloud baseline yet

This eval shipped without `ANTHROPIC_API_KEY` available in the
environment that built it -- there is currently no such secret in this
repo's GitHub Actions secrets either (confirmed by grepping every
`.github/workflows/*.yml` for `secrets.` before this eval was added; only
`RAILWAY_TOKEN`/`RAILWAY_PROJECT_ID` existed). Consistent with this eval's
own principle (measure, don't promise -- see "The matching heuristic"
above), `baseline.json` is **not committed** with a fabricated or
guessed-at number.

**Manual follow-up once the secret exists:**

1. Add `ANTHROPIC_API_KEY` under this repo's Settings > Secrets and
   variables > Actions.
2. Run `bun run eval:extraction -- --mode cloud --write-baseline` from
   `apps/cli` (locally, with the same key set as an env var) to generate
   the first real `baseline.json`.
3. Commit it. From that point on,
   `apps/cli/test/prebrain/extraction/eval-gate.test.ts`'s live test
   (currently `test.skipIf`-disabled without the key) starts actually
   gating, both locally and in `.github/workflows/extraction-eval.yml`.

Until then, `eval-gate.test.ts`'s live test skips itself (see "CI wiring"
below) -- the corpus-shape sanity check and the pure harness unit tests
still run and still catch a corpus/scoring regression, just not a live
model-quality regression.

## Local mode: measured separately, gap documented

Local-only extraction (Llama 3.1 8B via Ollama, see
`DEFAULT_OLLAMA_MODEL` in `local.ts`) is measured separately from cloud
mode and does not run in CI -- GitHub Actions runners don't have a local
Ollama daemon available, and local-mode's whole point is running on a
customer's own hardware, not gnt's CI infra.

Run it by hand against your own Ollama daemon:

```bash
ollama pull llama3.1:8b   # the module's documented default target
cd apps/cli
bun run eval:extraction -- --mode local --write-baseline
```

### Original finding (real llama3.1:8b via Ollama 0.30.10, 34 documents, measured 2026-07-18): a hard 0% recall

```
overall      recall=  0.0% (0/24)  precision=100.0% (0/0)

by category
  no_policy    recall=100.0% (0/0)  precision=100.0% (0/0)   (vacuous -- 0 expected, 0 extracted)
  policy       recall=  0.0% (0/24)  precision=100.0% (0/0)
```

`llama3.1:8b` extracted zero rules from all 24 `policy` documents.
Digging into *why* (debug calls against the raw `/api/chat` endpoint, not
part of this eval's committed code) turned up something more specific
than "the model is weaker" -- **every one of the 34 real eval calls
failed at `local.ts`'s own `JSON.parse` step**, not at zod schema
validation. The model wasn't returning slightly-wrong JSON; it was
returning plain prose (numbered lists, `**Rule:**` markdown) as if
`format` had been ignored entirely.

Isolating it further: a minimal version of `EXTRACTION_JSON_SCHEMA`
(object/array/string/number types only) makes Ollama's structured output
work correctly for this model -- and adding the schema's `$schema` key or
a nested `additionalProperties: false` on their own don't break it
either. What breaks it is `ExtractedRuleCandidateSchema`'s
`min()`/`max()` calls on `title`/`body`/`tags` and `confidence`
(`z.string().min(1).max(200)`, etc.) -- once `z.toJSONSchema()`'s
resulting `minLength`/`maxLength`/`minimum`/`maximum` keywords are
present anywhere in the schema passed as Ollama's `format` field, the
model stops respecting `format` at all and free-generates prose instead,
on every single call, not just occasionally. This lines up with a known
class of limitation in llama.cpp-style grammar-constrained decoding
(which Ollama's structured output is built on): length/range validation
keywords generally can't be compiled into a generation grammar the way
`type`/`properties`/`required`/`enum` can, and this Ollama version
appears to fail closed (drop constrained decoding for the whole schema)
rather than fail open (constrain everything it can, ignore the rest) when
it hits one.

### Fixed: `local.ts` now strips the incompatible keywords before sending the schema to Ollama

`local.ts` builds a second copy of the schema for the `format` field --
`minLength`/`maxLength`/`minimum`/`maximum` stripped recursively via a
small helper (`stripOllamaIncompatibleKeywords`), computed once at module
load. The zod `ExtractionResultSchema.safeParse` call right after
`JSON.parse` still validates the full bounds (title 1-200 chars, body
1-8000 chars, confidence 0.0-1.0, and so on) against whatever Ollama
actually returns -- only the copy handed to Ollama's own grammar
constraint is narrowed, nothing about this codebase's own runtime
validation changed.

### Recorded baseline after the fix (real llama3.1:8b via Ollama 0.30.10, 34 documents, measured 2026-07-18)

```
overall      recall= 79.2% (19/24)  precision= 46.8% (22/47)

by category
  no_policy    recall=100.0% (0/0)  precision=  0.0% (0/4)
  policy       recall= 79.2% (19/24)  precision= 51.2% (22/43)
```

Recorded in `baseline.local.json`. Not gated in CI (see "CI wiring"
below) -- this number is a developer reference, regenerated by hand.

Recall moved from a hard 0% to 79.2% once the JSON-parse failure was
fixed -- confirming the schema keywords, not model capability, were the
root cause of the original 0%. Precision at 46.8% is the real,
now-measurable quality gap `local.ts`'s own doc comment already warns
about: Llama 3.1 8B hallucinating rules from documents with no real
decision-prose (`no_policy` precision is 0%) and rephrasing weakly-stated
prose into rules that don't clear the eval's keyword-matching bar. That
gap is a genuine model-capability ceiling, not a plumbing bug -- nothing
here claims local mode matches cloud mode's quality, only that it now
produces structured output at all.

## CI wiring

Unlike the privacy-gate eval (100% local, so its gate test just runs on
every `bun test`), this eval makes a real, paid API call per document in
cloud mode, and a cost-conscious founder decision (2026-07-18) is: **this
must not run on every push or PR.**

The split:

- `apps/cli/test/prebrain/extraction/eval-harness.test.ts` -- pure
  scoring math against synthetic fixtures, zero API calls, always runs
  as part of the ordinary `bun test` this repo's main CI (`ci.yml`)
  already runs on every push.
- `apps/cli/test/prebrain/extraction/eval-gate.test.ts` -- two tests:
  - A cheap structural check on `corpus.jsonl` (document/category counts,
    no `expected` entries on `no_policy` documents) -- no API call, also
    always runs in the ordinary `bun test` suite.
  - The live gate, wrapped in `test.skipIf(!process.env.ANTHROPIC_API_KEY)`
    -- a no-op, not a failure, whenever the key isn't set. It's skipped in
    `ci.yml`'s ordinary `web` job (which never sets that env var) and only
    actually executes inside `.github/workflows/extraction-eval.yml`.
- `.github/workflows/extraction-eval.yml` -- a **separate workflow file**
  with its own `on: pull_request: paths: [...]` / `on: push: paths: [...]`
  trigger scoped to `apps/cli/src/prebrain/extraction/**` and
  `apps/cli/eval/extraction/**` (GitHub Actions path filtering is
  workflow-level, not job-level, which is why this couldn't be a job
  bolted onto `ci.yml`'s single shared `on:` block). Its job reads
  `secrets.ANTHROPIC_API_KEY` into a job-level env var and has two
  mutually exclusive steps: run the live gate test if the key is present,
  or print a `::warning::` log line and exit clean if it isn't -- so this
  never breaks the build for anyone until a human adds the real secret.

A regression in either recall or precision beyond `TOLERANCE` (0.05,
slightly wider than the other two evals' 0.02 -- a live model call isn't
bit-for-bit deterministic run to run the way a replayed embedding or a
local deterministic gate is, so the floor needs a bit more room before it
means something real) fails the build, once a baseline exists to compare
against.

## Extraction changes merge only with eval results in the PR

Process expectation, not a hard git-hook gate: if
your PR touches `apps/cli/src/prebrain/extraction/` (the prompt in
`schema.ts`, either mode's call logic, the schema itself), run
`bun run eval:extraction -- --mode cloud` locally (or check the
`extraction-eval.yml` run this PR triggered) and paste the resulting
recall/precision numbers into the PR description, alongside whether they
moved versus the committed `baseline.json`. If a change is deliberate and
the eval's baseline should move with it, regenerate it
(`--write-baseline`) and commit the new `baseline.json` in the same PR,
with the old and new numbers both in the PR description -- same
discipline the other two evals' READMEs already ask for on a corpus/query
edit.
