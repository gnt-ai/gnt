"""Layer 2: NER for person names, org names, and places/facilities, run
over whatever layer 1 already masked.

Library choice: spaCy (https://spacy.io), en_core_web_md model.

The CLI gate uses `compromise`, a zero-dependency, pattern/lexicon-based JS
NER library, specifically because it runs on a customer's own laptop where
a heavier statistical model is a real cost (see layer2-ner.ts's own
writeup). That constraint doesn't apply here: this gate runs once, server-
side, on gnt's own infrastructure, on request bodies capped at 8000
characters (CreateRuleRequest.body) -- so a small trained model is
affordable in a way it wouldn't be for a CLI install.

spaCy over the alternatives considered:
  - Presidio (Microsoft's PII-detection toolkit) was deliberately retired
    from this exact codebase (commit 2951286, "retire ask_brain/
    search_knowledge and the whole voyage embedding pipeline") along with
    the entire old capture/embedding pipeline it was bundled with. That
    removal was a call about a whole obsolete architecture -- a duplicate,
    costly retrieval/memory feature this product's storage layer already
    covers -- not a verdict against Presidio or spaCy specifically as PII
    tools. Presidio is itself built on spaCy for NER; reaching for
    Presidio here would mean carrying its broader entity-recognizer/
    analyzer-registry machinery for functionality this gate's layer 1 (its
    own deterministic detectors) and layer 2b (its own amounts heuristic)
    already cover more cheaply and more inspectably. Bare spaCy, used only
    for what it's uniquely good at (name/org/place NER), is the leaner
    choice.
  - A regex/heuristic-only approach (matching the CLI's "lightweight over
    statistical" philosophy) was considered, but rejected:
    capitalized-word-sequence heuristics have far worse recall on
    person/org/place names than even a small trained model, and recall
    is the direction that matters most here -- under-masking is a real
    data leak, while over-masking is only a readability nuisance, so a
    heuristic that reliably under-masks names is the wrong tradeoff for a
    layer whose entire job is names.
  - `sm` vs `md` vs `lg`: `sm` (~15MB installed) was tried first and
    rejected: on this product's own policy-shaped test sentences, `sm`
    tagged the sentence-initial word "Refunds" (in
    "Refunds over 15% require manager sign-off.") as a GPE place name,
    which would have masked an ordinary policy sentence's first word for
    no reason. `md` (~48MB installed, ~32MB download) doesn't make that
    mistake on any case this module's test suite covers. `lg` (~587MB,
    the exact model this codebase downloaded in its Dockerfile before the
    pipeline that used it was retired -- commit 2951286, cited above) adds
    word vectors on top of `md`, which matter for similarity/clustering
    tasks and add nothing to NER quality, which is driven by the tok2vec +
    transition-based NER component `md` and `lg` share. `md` is the
    accuracy/size sweet spot for this use case, not the cheapest option
    that technically works. See this PR's own description for the actual
    install footprint measured against this repo's Docker build.

Known limitations worth calling out explicitly, same as the CLI module
does for compromise's possessive-splitting quirk:
  - spaCy's NER occasionally folds an adjacent function word into a
    PERSON/ORG span on short or ambiguous input (e.g. "Reach Jane Smith at
    ..." tags "Reach Jane Smith" as one PERSON entity). Every case this
    masks still gets masked correctly (nothing leaks) -- it just
    occasionally over-masks a neighboring word too. Safe (over-masking),
    not a leak, same accepted failure direction as the CLI's own quirk.
  - Short, bare, all-uppercase acronyms ("SSN", "API", "IP", "CFO", "URL",
    "HTTPS") get misclassified as ORG by both `sm` and `md` on their own,
    and this product's own policy-rule content is dense with exactly this
    kind of business/technical acronym. Left uncorrected, every rule
    mentioning "SSN" or "API" would come back with that word replaced
    by an org placeholder,
    which is a real, high-frequency hit to rule readability, not a rare
    edge case -- worse than the CLI's own accepted quirks by frequency.
    _SHORT_ACRONYM_RE below suppresses ORG matches shaped like this (a
    single 2-5 letter all-caps token). The accepted tradeoff this creates:
    a real short company acronym mentioned bare ("IBM", "AWS", "NASA")
    also won't be masked as ORG anymore. Deliberately accepted, not
    overlooked -- a bare company acronym is materially lower-risk than the
    business/technical acronyms this guard protects (it's rarely
    identifying on its own, and is the customer's own public vendor/
    infra choice far more often than a third party's), so trading that
    narrow miss for reliably not mangling ordinary policy prose is the
    right call: an over-masked rule is unreadable, and unreadable rules
    don't get followed.
    See test_privacy_gate_ner.py's own tests for both directions of this
    tradeoff, asserted explicitly rather than left undocumented.

Deviation from the CLI's layer2-ner.ts worth flagging on its own: that
module has to literal-search each matched name/org/place string back into
the source text, because compromise doesn't expose reliable character
offsets for tagged spans across versions (see that file's own comment).
spaCy's Doc/Span API gives real, direct `start_char`/`end_char` offsets for
every entity, so this module uses those directly -- no re-search, and no
risk of a name string over-matching an unrelated recurrence of the same
substring elsewhere in the text. A genuine improvement enabled by the
library swap, not something this port had to give up.
"""

from __future__ import annotations

import re
from functools import lru_cache

import spacy

from .registry import PlaceholderRegistry
from .spans import apply_matches, existing_placeholder_spans, resolve_overlaps
from .types import LayerResult, PlaceholderKind, RawMatch

_MODEL_NAME = "en_core_web_md"

# See this module's docstring ("known limitations") for why this exists
# and the tradeoff it deliberately accepts. Only applied to ORG -- spaCy
# does not mistake these short acronyms for PERSON or GPE/LOC/FAC in any
# case this module's test suite covers, so narrowing the guard to ORG
# alone avoids suppressing a real person/place match unnecessarily.
_SHORT_ACRONYM_RE = re.compile(r"^[A-Z]{2,5}$")

# Only PERSON/ORG/GPE/LOC/FAC map onto this gate's placeholder kinds.
# spaCy's small English model also tags NORP/PRODUCT/EVENT/WORK_OF_ART/LAW/
# LANGUAGE/DATE/TIME/PERCENT/MONEY/QUANTITY/ORDINAL/CARDINAL -- none of
# those are identity-revealing the way a name/org/place is, and PERCENT/
# MONEY specifically are layer 2b's job (layer2b_amounts.py), not this
# layer's: a bare "$50" here is a policy threshold far more often than not,
# the exact reason layer 1 also stays out of bare amounts. GPE (countries/
# cities/states), LOC (other locations), and FAC (buildings, campuses --
# where a short/ambiguous org name sometimes lands instead of ORG) all
# collapse onto ADDRESS, matching the CLI's compromise-based .places()
# bucket, which doesn't distinguish these either.
_LABEL_TO_KIND: dict[str, PlaceholderKind] = {
    "PERSON": "PERSON",
    "ORG": "ORG",
    "GPE": "ADDRESS",
    "LOC": "ADDRESS",
    "FAC": "ADDRESS",
}

# Same claim-order reasoning as layer 1's DETECTORS tuple and the CLI's own
# layer2-ner.ts comment: person names are claimed before org/place names so
# "Jane Smith" at "Acme Corp" doesn't get partially reclaimed if a place/org
# span happens to overlap it.
_KIND_PRIORITY: dict[PlaceholderKind, int] = {"PERSON": 0, "ORG": 1, "ADDRESS": 2}


@lru_cache(maxsize=1)
def _nlp() -> spacy.language.Language:
    # tagger/parser/attribute_ruler/lemmatizer are all irrelevant to named-
    # entity recognition in spaCy's pretrained English pipeline (the `ner`
    # component only depends on `tok2vec`) -- disabling them roughly halves
    # per-call latency with no effect on entity output, confirmed against
    # every case this module's own test suite covers. Loaded once per
    # process and cached: model load itself (not inference) is the
    # expensive part, so this must not run per-request.
    return spacy.load(_MODEL_NAME, disable=["tagger", "parser", "attribute_ruler", "lemmatizer"])


def run_ner_layer(text: str, registry: PlaceholderRegistry) -> LayerResult:
    reserved = existing_placeholder_spans(text)
    doc = _nlp()(text)

    candidates: list[RawMatch] = []
    for ent in doc.ents:
        kind = _LABEL_TO_KIND.get(ent.label_)
        if kind is None:
            continue
        if kind == "ORG" and _SHORT_ACRONYM_RE.match(ent.text):
            continue
        candidates.append(RawMatch(kind=kind, value=ent.text, start=ent.start_char, end=ent.end_char))
    # Stable sort: groups by kind priority (person, then org, then
    # address) while preserving each kind's original left-to-right order.
    candidates.sort(key=lambda match: _KIND_PRIORITY[match.kind])

    resolved = resolve_overlaps(candidates, reserved)
    return apply_matches(text, resolved, registry, "ner")
