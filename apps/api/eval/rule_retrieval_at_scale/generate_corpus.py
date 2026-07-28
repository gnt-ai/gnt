"""Generate a single simulated enterprise's rule corpus + query set at a
requested scale (1K / 10K / 100K / 1M).

Design goals (see README.md for the full writeup):

- ~10 department clusters, each with several real policy "concepts".
- At every tier, hand-seeded CROSS-DEPARTMENT collision pairs: the same
  policy concept ("refund", "escalation", "data retention", ...) living in
  2-4 departments with genuinely different specifics, so retrieval has to
  disambiguate by department context, not just concept keyword. These are
  the whole point of the at-scale test.
- Above the hand-authored core, templated-but-non-trivial generation:
  parameterized rules per department (team / region / system / dollar
  threshold / day window / role), each a genuinely distinct policy, phrased
  through several sentence variants so it is not number-swap boilerplate.
- Four query families matching the existing eval (exact_name, paraphrase,
  keyword_only, multi_rule) PLUS a dedicated cross-department collision
  family, all tagged.

Deterministic: seeded RNG, so a given tier reproduces byte-for-byte.

Usage:
    python generate_corpus.py --n 1000 --out corpus/tier_1k
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

# ---------------------------------------------------------------------------
# Shared parameter pools. Realistic specifics; the same pools feed every
# department so that same-concept rules across departments look plausibly
# confusable (that is the stress we want).
# ---------------------------------------------------------------------------

REGIONS = ["EMEA", "APAC", "LATAM", "North America", "the UK", "Germany",
           "Japan", "Australia", "Canada", "the Nordics", "India", "Brazil"]
TEAMS = ["Platform", "Growth", "Enterprise Sales", "SMB Sales", "Field Marketing",
         "Data Platform", "Payments", "Infrastructure", "Mobile", "Design Systems",
         "Customer Success", "Solutions Engineering", "People Ops", "Corporate Dev",
         "Trust & Safety", "Developer Relations", "Revenue Operations", "Facilities"]
# high-cardinality scope dimensions so every rule is UNIQUELY addressable
# (title/scope collisions would make a query genuinely ambiguous -> a miss
# that isn't a retrieval failure). T*D*R*S*Y = 18*44*12*30*10 = 2,851,200
# unique scopes, enough for the 1M tier with headroom.
DIVISIONS = ["Payments", "Identity", "Ledger", "Onboarding", "Retention", "Billing",
             "Fraud", "Compliance", "Analytics", "Messaging", "Search", "Catalog",
             "Checkout", "Pricing", "Notifications", "Reporting", "Provisioning",
             "Settlement", "Reconciliation", "Entitlements", "Localization",
             "Accessibility", "Observability", "Networking", "Storage", "Compute",
             "Governance", "Procure-to-Pay", "Order-to-Cash", "Talent", "Payroll",
             "Benefits", "Workplace", "Brand", "Demand-Gen", "Lifecycle",
             "Partnerships", "Channel", "Renewals", "Expansion", "Activation",
             "Support-Ops", "Trust-Ops", "Data-Governance"]
SEGMENTS = ["Consumer", "Enterprise", "SMB", "Mid-Market", "Public Sector", "Developer",
            "Startups", "Nonprofit", "Education", "Healthcare", "Financial Services",
            "Retail", "Manufacturing", "Media", "Gaming", "Logistics", "Energy",
            "Telecom", "Automotive", "Hospitality", "Agriculture", "Insurance",
            "Real Estate", "Legal Services", "Aerospace", "Biotech", "Robotics",
            "Marketplace", "Wholesale", "Direct"]
FISCAL_YEARS = [str(y) for y in range(2018, 2028)]
_SCOPE_SPACE = len(TEAMS) * len(DIVISIONS) * len(REGIONS) * len(SEGMENTS) * len(FISCAL_YEARS)
# large prime coprime to _SCOPE_SPACE -> full-period LCG walk = unique scopes
# without materializing the whole space.
_SCOPE_STRIDE = 1_500_007
SYSTEMS = ["Salesforce", "Workday", "the billing ledger", "the data warehouse",
           "the identity provider", "the CI pipeline", "the CRM", "the HRIS",
           "the ticketing system", "the code repository", "the payments gateway",
           "the analytics store", "the vendor portal", "the contract vault"]
SENIOR_ROLES = ["director", "VP", "senior manager", "department head",
                "regional lead", "principal", "staff lead", "group manager"]
JUNIOR_ROLES = ["manager", "team lead", "associate", "coordinator",
                "specialist", "analyst", "supervisor"]

# amounts and windows are drawn per-instance so two same-concept rules differ
# in a way a reader (and ideally a retriever) must actually resolve.
AMOUNTS = [500, 1000, 2500, 5000, 7500, 10000, 25000, 50000, 100000, 250000]
DAYS = [1, 2, 3, 5, 7, 10, 14, 21, 30, 45, 60, 90, 180, 365]
PCTS = [5, 10, 15, 20, 25, 30, 50]

# ---------------------------------------------------------------------------
# Concept catalogue. Each concept is authored once with several phrasing
# variants; instances are stamped out over scope pools. `collision_group`
# ties same-named concepts across departments together so the query builder
# can construct disambiguation queries and score the distractor set.
# ---------------------------------------------------------------------------

# body_variants: sentence templates. slots: {scope}{amount}{amount2}{days}
#   {days2}{srole}{jrole}{system}{region}{pct}
# title: short human title. paraphrase: disjoint-vocabulary restatement.
# keywords: fragments for keyword_only queries.

CONCEPTS = {
    # ---- finance ----------------------------------------------------------
    "finance": [
        dict(concept="expense_approval", collision_group="expense_approval",
             title="Expense approval limit for {scope}",
             keywords=["expense approval", "spending limit", "reimbursement cap", "sign-off threshold"],
             paraphrase="how large a purchase a {jrole} on {scope} can green-light before it needs a {srole}",
             body_variants=[
                 "Employees in {scope} may approve expenses up to ${amount}. Anything above ${amount} routes to a {srole} and must be filed within {days} days of the spend.",
                 "For {scope}, a {jrole} can sign off on reimbursements at or below ${amount}; larger claims escalate to a {srole} and require a receipt within {days} days.",
                 "Discretionary spend under ${amount} is self-approved across {scope}. Above that, a {srole} approval is mandatory and late filings past {days} days are rejected.",
             ]),
        dict(concept="wire_transfer", collision_group=None,
             title="Wire transfer authorization for {scope}",
             keywords=["wire transfer", "outbound payment", "dual authorization", "treasury approval"],
             paraphrase="who has to co-sign an outgoing bank transfer for {scope}",
             body_variants=[
                 "Outbound wires above ${amount} for {scope} require dual authorization from a {srole} and treasury. Wires settle no earlier than {days} business days after both approvals.",
                 "A single {srole} may release wires up to ${amount} for {scope}; anything larger needs a second {srole} co-signature and a {days}-day settlement hold.",
             ]),
        dict(concept="refund_finance", collision_group="refund",
             title="Refund accounting treatment for {scope}",
             keywords=["refund", "credit note", "revenue reversal", "chargeback"],
             paraphrase="how the books record money returned to a customer in {scope}",
             body_variants=[
                 "Refunds issued in {scope} post as revenue reversals in {system} within {days} days and above ${amount} require a {srole} to countersign the credit note.",
                 "Finance records every {scope} refund over ${amount} as a chargeback against the original booking; entries reconcile in {system} on a {days}-day cycle.",
             ]),
        dict(concept="quarter_close", collision_group=None,
             title="Quarter-close cutoff for {scope}",
             keywords=["quarter close", "book cutoff", "accruals deadline", "period end"],
             paraphrase="the deadline for booking entries before the quarter is locked for {scope}",
             body_variants=[
                 "All {scope} journal entries must land in {system} at least {days} days before quarter end; accruals above ${amount} need a {srole} review before the books lock.",
             ]),
    ],
    # ---- legal ------------------------------------------------------------
    "legal": [
        dict(concept="data_retention_legal", collision_group="data_retention",
             title="Contract records retention for {scope}",
             keywords=["data retention", "records retention", "document hold", "archival period"],
             paraphrase="how long signed agreements for {scope} have to be kept on file",
             body_variants=[
                 "Executed contracts for {scope} are retained for {days} days in {system}; litigation holds override deletion and only a {srole} in Legal may release them.",
                 "Legal keeps every {scope} agreement for a minimum of {days} days; early destruction requires written {srole} approval and a logged reason in {system}.",
             ]),
        dict(concept="nda_turnaround", collision_group=None,
             title="NDA turnaround SLA for {scope}",
             keywords=["NDA", "mutual nondisclosure", "redline turnaround", "confidentiality agreement"],
             paraphrase="how quickly Legal returns a signed confidentiality agreement for {scope}",
             body_variants=[
                 "Standard mutual NDAs for {scope} are redlined within {days} business days; non-standard terms escalate to a {srole} and can add ${amount} in outside-counsel cost.",
             ]),
        dict(concept="vendor_contract_legal", collision_group="vendor",
             title="Vendor contract review for {scope}",
             keywords=["vendor contract", "supplier agreement", "MSA review", "terms review"],
             paraphrase="Legal's checkpoints before {scope} can sign a supplier",
             body_variants=[
                 "Any {scope} vendor agreement above ${amount} annual value gets a full Legal review within {days} days; a {srole} must approve indemnity and liability caps.",
                 "Supplier MSAs for {scope} route through Legal when spend exceeds ${amount}; a {srole} signs off on data-processing addenda before countersignature.",
             ]),
        dict(concept="gdpr_dsar", collision_group="privacy_request",
             title="Data subject request handling for {scope}",
             keywords=["DSAR", "data subject request", "right to erasure", "access request"],
             paraphrase="how {scope} fulfills a person asking for or to delete their data",
             body_variants=[
                 "A verified data subject access request touching {scope} is fulfilled within {days} days; erasure requests are honored unless a {srole} documents a legal-hold exception in {system}.",
             ]),
    ],
    # ---- engineering ------------------------------------------------------
    "engineering": [
        dict(concept="incident_escalation_eng", collision_group="escalation",
             title="Production incident escalation for {scope}",
             keywords=["incident escalation", "on-call page", "sev tier", "paging policy"],
             paraphrase="who gets paged and how fast when {scope} breaks in production",
             body_variants=[
                 "A Sev-1 in {scope} pages the on-call within {days} minutes and auto-escalates to a {srole} if unacknowledged; Sev-2 gives a {days2}-minute window before escalation.",
                 "When {scope} triggers a Sev-1, the on-call {jrole} owns it for {days} minutes before it climbs to a {srole}; incidents costing over ${amount} in credits get an exec brief.",
             ]),
        dict(concept="data_retention_eng", collision_group="data_retention",
             title="Log and telemetry retention for {scope}",
             keywords=["data retention", "log retention", "telemetry TTL", "trace expiry"],
             paraphrase="how long {scope} keeps its logs and traces before they age out",
             body_variants=[
                 "{scope} retains application logs for {days} days and traces for {days2} days in {system}; extending retention past that needs a {srole} sign-off on the added storage cost.",
             ]),
        dict(concept="code_review", collision_group=None,
             title="Code review policy for {scope}",
             keywords=["code review", "PR approval", "merge gate", "reviewer count"],
             paraphrase="how many approvals a change in {scope} needs before it merges",
             body_variants=[
                 "Every {scope} pull request needs at least two approvals, one from a {srole}; changes touching {system} also require a security reviewer and block merge until CI is green.",
                 "Changes in {scope} merge after {days} approving reviews; a {jrole} can approve routine diffs but schema changes to {system} escalate to a {srole}.",
             ]),
        dict(concept="deploy_freeze", collision_group=None,
             title="Deployment freeze window for {scope}",
             keywords=["deploy freeze", "change freeze", "release blackout", "no-deploy window"],
             paraphrase="when {scope} is not allowed to ship to production",
             body_variants=[
                 "{scope} observes a deploy freeze for {days} days around peak traffic; emergency fixes need a {srole} exception and a rollback plan filed in {system}.",
             ]),
        dict(concept="onboarding_eng", collision_group="onboarding",
             title="Engineer onboarding access for {scope}",
             keywords=["onboarding", "access provisioning", "new hire setup", "repo access"],
             paraphrase="what a new engineer on {scope} gets access to and when",
             body_variants=[
                 "A new {scope} engineer gets read access to {system} on day one and write access after {days} days once a {srole} confirms training; production access needs a separate review.",
             ]),
    ],
    # ---- hr ---------------------------------------------------------------
    "hr": [
        dict(concept="pto_policy", collision_group=None,
             title="PTO accrual and carryover for {scope}",
             keywords=["PTO", "vacation accrual", "carryover cap", "leave balance"],
             paraphrase="how vacation builds up and how much rolls over for {scope}",
             body_variants=[
                 "Employees in {scope} accrue paid time off monthly and may carry over up to {days} days into the next year; balances above that expire unless a {srole} grants an exception.",
                 "{scope} PTO carryover is capped at {days} days; anything beyond is paid out at {pct}% of daily rate with {srole} approval recorded in {system}.",
             ]),
        dict(concept="hr_escalation", collision_group="escalation",
             title="HR concern escalation for {scope}",
             keywords=["escalation", "grievance", "HR complaint", "concern reporting"],
             paraphrase="how a reported workplace concern in {scope} moves up the chain",
             body_variants=[
                 "A workplace concern raised in {scope} is acknowledged within {days} days and, if unresolved, escalates from a {jrole} to a {srole} in People Ops within {days2} days.",
             ]),
        dict(concept="onboarding_hr", collision_group="onboarding",
             title="New hire onboarding checklist for {scope}",
             keywords=["onboarding", "new hire", "first week", "orientation"],
             paraphrase="what HR completes for a new person joining {scope}",
             body_variants=[
                 "HR completes {scope} onboarding within {days} days: payroll in {system}, benefits enrollment, and a {srole} check-in; equipment ships before the start date.",
             ]),
        dict(concept="access_review_hr", collision_group="access_review",
             title="Role and title change access review for {scope}",
             keywords=["access review", "role change", "entitlement review", "transfer"],
             paraphrase="how {scope} entitlements get re-checked when someone changes roles",
             body_variants=[
                 "When a {scope} employee changes roles, HR triggers an access review in {system} within {days} days so stale entitlements are removed; a {srole} attests to the new set.",
             ]),
        dict(concept="compensation_band", collision_group=None,
             title="Compensation band exception for {scope}",
             keywords=["comp band", "salary exception", "offer approval", "pay range"],
             paraphrase="who approves an offer for {scope} that lands outside the pay range",
             body_variants=[
                 "Offers in {scope} above the band midpoint by more than {pct}% need a {srole} and Finance approval; exceptions over ${amount} total comp go to the compensation committee.",
             ]),
    ],
    # ---- sales ------------------------------------------------------------
    "sales": [
        dict(concept="refund_sales", collision_group="refund",
             title="Deal refund and clawback for {scope}",
             keywords=["refund", "clawback", "commission reversal", "cancellation"],
             paraphrase="what happens to a rep's commission when a {scope} customer gets money back",
             body_variants=[
                 "If a {scope} customer is refunded within {days} days, the rep's commission is clawed back; refunds above ${amount} need a {srole} and Finance sign-off.",
                 "A {scope} cancellation inside {days} days reverses commission in {system}; partial refunds over ${amount} require a {srole} to approve the clawback percentage.",
             ]),
        dict(concept="discount_approval", collision_group="expense_approval",
             title="Discount approval authority for {scope}",
             keywords=["discount approval", "price concession", "margin exception", "deal desk"],
             paraphrase="how deep a discount a {jrole} on {scope} can grant before deal desk steps in",
             body_variants=[
                 "A {scope} {jrole} can grant discounts up to {pct}%; deeper concessions route to deal desk and anything past {pct2}% needs a {srole} and margin review.",
                 "Discounts under {pct}% are self-serve for {scope}; above that a {srole} approves, and concessions worth more than ${amount} in ACV go to the deal desk.",
             ]),
        dict(concept="quota_credit", collision_group=None,
             title="Quota credit and split rules for {scope}",
             keywords=["quota credit", "deal split", "attribution", "comp plan"],
             paraphrase="how a shared deal's credit is divided across reps in {scope}",
             body_variants=[
                 "Split deals in {scope} allocate quota credit by contribution logged in {system} within {days} days of close; disputes over ${amount} escalate to a {srole}.",
             ]),
        dict(concept="contract_terms_sales", collision_group="vendor",
             title="Non-standard contract terms for {scope}",
             keywords=["non-standard terms", "custom terms", "contract exception", "special terms"],
             paraphrase="who signs off when a {scope} deal wants terms off the standard paper",
             body_variants=[
                 "Any {scope} deal requesting non-standard payment terms beyond {days} days or liability above ${amount} needs Legal review and a {srole} approval before signature.",
             ]),
    ],
    # ---- support ----------------------------------------------------------
    "support": [
        dict(concept="refund_support", collision_group="refund",
             title="Goodwill refund policy for {scope}",
             keywords=["refund", "goodwill credit", "service credit", "make-good"],
             paraphrase="how much a support agent for {scope} can refund to smooth things over",
             body_variants=[
                 "A {scope} support {jrole} may issue goodwill refunds up to ${amount} without approval; larger make-goods need a {srole} and are logged in {system} within {days} days.",
                 "Service credits for {scope} outages are capped at ${amount} per account per incident; anything above requires a {srole} and a root-cause note in {system}.",
             ]),
        dict(concept="ticket_sla", collision_group=None,
             title="Support ticket response SLA for {scope}",
             keywords=["ticket SLA", "first response", "resolution time", "priority queue"],
             paraphrase="how fast {scope} promises a first reply and a fix by priority",
             body_variants=[
                 "{scope} first-responds to urgent tickets within {days} hours and resolves within {days2} days; breaching the SLA credits the account and pages a {srole}.",
             ]),
        dict(concept="support_escalation", collision_group="escalation",
             title="Tier-2 support escalation for {scope}",
             keywords=["escalation", "tier-2 handoff", "engineering bridge", "escalation path"],
             paraphrase="when a {scope} ticket jumps from front-line to engineering",
             body_variants=[
                 "A {scope} ticket unresolved after {days} hours escalates from a front-line {jrole} to tier-2, and a suspected product bug bridges to Engineering with a {srole} on the call.",
             ]),
    ],
    # ---- security ---------------------------------------------------------
    "security": [
        dict(concept="data_retention_security", collision_group="data_retention",
             title="Security event log retention for {scope}",
             keywords=["data retention", "audit log retention", "SIEM retention", "security log TTL"],
             paraphrase="how long {scope} keeps its security and audit logs",
             body_variants=[
                 "{scope} retains authentication and audit logs for {days} days in {system}; deletion before then is blocked and any exception needs a {srole} in Security to sign.",
                 "Security keeps {scope} SIEM events for {days} days hot and {days2} days cold; shortening retention requires a {srole} risk acceptance recorded in {system}.",
             ]),
        dict(concept="access_review_security", collision_group="access_review",
             title="Privileged access review for {scope}",
             keywords=["access review", "privileged access", "least privilege", "entitlement audit"],
             paraphrase="how often {scope} admin rights get re-certified",
             body_variants=[
                 "Privileged access to {scope} in {system} is re-certified every {days} days; an account unused for {days2} days is auto-disabled and a {srole} must reinstate it.",
             ]),
        dict(concept="incident_security", collision_group="escalation",
             title="Security incident escalation for {scope}",
             keywords=["escalation", "security incident", "breach response", "CIRT page"],
             paraphrase="who is woken up when {scope} has a suspected breach",
             body_variants=[
                 "A suspected breach in {scope} pages the security on-call within {days} minutes and escalates to a {srole} and Legal if data exfiltration is confirmed; regulators are notified within {days2} days.",
             ]),
        dict(concept="onboarding_security", collision_group="onboarding",
             title="Security onboarding and background check for {scope}",
             keywords=["onboarding", "background check", "clearance", "security training"],
             paraphrase="the security gates a new {scope} hire clears before getting access",
             body_variants=[
                 "A {scope} hire completes a background check and security training within {days} days; production and {system} access is withheld until a {srole} verifies completion.",
             ]),
        dict(concept="vuln_sla", collision_group=None,
             title="Vulnerability remediation SLA for {scope}",
             keywords=["vulnerability SLA", "patch window", "CVE remediation", "critical fix"],
             paraphrase="how fast {scope} has to patch a serious vulnerability",
             body_variants=[
                 "Critical vulnerabilities in {scope} are patched within {days} days and highs within {days2} days; a missed window auto-escalates to a {srole} and blocks new {system} deploys.",
             ]),
    ],
    # ---- procurement ------------------------------------------------------
    "procurement": [
        dict(concept="vendor_onboarding", collision_group="vendor",
             title="Vendor onboarding and vetting for {scope}",
             keywords=["vendor onboarding", "supplier vetting", "due diligence", "vendor intake"],
             paraphrase="the checks a new supplier for {scope} passes before its first PO",
             body_variants=[
                 "A new {scope} vendor clears security and financial vetting within {days} days; spend commitments over ${amount} also need a {srole} and a signed data-processing addendum.",
                 "Suppliers to {scope} are onboarded in {system} after due diligence; contracts above ${amount} require a {srole} approval and an insurance certificate on file.",
             ]),
        dict(concept="po_approval", collision_group="expense_approval",
             title="Purchase order approval for {scope}",
             keywords=["PO approval", "purchase order", "spend authorization", "requisition"],
             paraphrase="who signs a purchase order of a given size for {scope}",
             body_variants=[
                 "Purchase orders for {scope} up to ${amount} are approved by a {jrole}; between ${amount} and ${amount2} needs a {srole}, and above that goes to Finance and a {days}-day review.",
             ]),
        dict(concept="renewal_notice", collision_group=None,
             title="Contract renewal notice window for {scope}",
             keywords=["renewal notice", "auto-renew", "cancellation window", "notice period"],
             paraphrase="how far ahead {scope} must decide on renewing a supplier",
             body_variants=[
                 "{scope} vendor contracts auto-renew unless cancelled {days} days before term end; renewals with a price increase above {pct}% need a {srole} to re-approve.",
             ]),
    ],
    # ---- marketing --------------------------------------------------------
    "marketing": [
        dict(concept="brand_approval", collision_group="expense_approval",
             title="Campaign spend approval for {scope}",
             keywords=["campaign approval", "marketing spend", "budget sign-off", "media buy"],
             paraphrase="how big a media buy a {jrole} on {scope} can commit before escalation",
             body_variants=[
                 "A {scope} {jrole} can commit campaign spend up to ${amount}; larger media buys need a {srole} and, above ${amount2}, a Finance co-approval logged in {system}.",
             ]),
        dict(concept="pr_escalation", collision_group="escalation",
             title="PR and communications escalation for {scope}",
             keywords=["escalation", "PR crisis", "press response", "comms bridge"],
             paraphrase="who is looped in when {scope} faces a press or social crisis",
             body_variants=[
                 "A negative press event touching {scope} escalates to a {srole} in Comms within {days} hours; anything alleging legal or security exposure loops in Legal and a {srole} immediately.",
             ]),
        dict(concept="data_use_marketing", collision_group="privacy_request",
             title="Customer data use for {scope} campaigns",
             keywords=["data use", "consent", "email opt-in", "audience targeting"],
             paraphrase="the consent rules before {scope} can market to a customer list",
             body_variants=[
                 "{scope} campaigns may only target customers with logged opt-in consent in {system}; suppression requests are honored within {days} days and a {srole} audits lists quarterly.",
             ]),
        dict(concept="brand_asset", collision_group=None,
             title="Brand asset and trademark usage for {scope}",
             keywords=["brand asset", "logo usage", "trademark", "style guide"],
             paraphrase="how {scope} is allowed to use the logo and brand marks",
             body_variants=[
                 "External use of brand assets by {scope} follows the style guide; co-branding and any trademark alteration need a {srole} and a {days}-day Legal review.",
             ]),
    ],
    # ---- operations -------------------------------------------------------
    "operations": [
        dict(concept="access_review_ops", collision_group="access_review",
             title="Facility and system access review for {scope}",
             keywords=["access review", "badge audit", "system access", "offboarding sweep"],
             paraphrase="how {scope} re-checks who can get into buildings and core systems",
             body_variants=[
                 "{scope} badge and {system} access is audited every {days} days; access for anyone who left is revoked within {days2} hours and a {srole} signs the offboarding sweep.",
             ]),
        dict(concept="incident_ops", collision_group="escalation",
             title="Operational incident escalation for {scope}",
             keywords=["escalation", "operational incident", "business continuity", "outage bridge"],
             paraphrase="how a non-technical operational disruption in {scope} climbs the chain",
             body_variants=[
                 "A facility or vendor outage disrupting {scope} escalates to a {srole} in Operations within {days} hours; disruptions over ${amount} in impact trigger the continuity plan.",
             ]),
        dict(concept="procurement_ops", collision_group="expense_approval",
             title="Operational supply spend for {scope}",
             keywords=["supply spend", "operational purchase", "facilities budget", "reorder"],
             paraphrase="who approves routine operational purchases for {scope}",
             body_variants=[
                 "Routine supply reorders for {scope} under ${amount} are approved by a {jrole}; above that a {srole} signs, and recurring commitments over ${amount2} route through Procurement.",
             ]),
        dict(concept="dr_test", collision_group=None,
             title="Disaster recovery test cadence for {scope}",
             keywords=["disaster recovery", "DR drill", "failover test", "backup restore"],
             paraphrase="how often {scope} rehearses recovering from a major failure",
             body_variants=[
                 "{scope} runs a full disaster-recovery failover test every {days} days; a failed restore in {system} escalates to a {srole} and blocks the next release train.",
             ]),
    ],
}

DEPARTMENTS = list(CONCEPTS.keys())

# ---------------------------------------------------------------------------

def _fill(template: str, p: dict) -> str:
    out = template
    for k, v in p.items():
        out = out.replace("{" + k + "}", str(v))
    return out


def _scope_from_k(k: int, start: int) -> str:
    """Deterministic, globally-unique scope for the k-th rule (full-period
    LCG walk over the scope space). Natural-language, high-cardinality, so
    every rule is uniquely addressable by its scope."""
    idx = (start + k * _SCOPE_STRIDE) % _SCOPE_SPACE
    t = idx % len(TEAMS)
    idx //= len(TEAMS)
    d = idx % len(DIVISIONS)
    idx //= len(DIVISIONS)
    r = idx % len(REGIONS)
    idx //= len(REGIONS)
    s = idx % len(SEGMENTS)
    idx //= len(SEGMENTS)
    y = idx % len(FISCAL_YEARS)
    return (f"the {DIVISIONS[d]} division of {TEAMS[t]} "
            f"({SEGMENTS[s]}, FY{FISCAL_YEARS[y]}) in {REGIONS[r]}")


def _mk_params(rng: random.Random, k: int, start: int) -> dict:
    a1, a2 = sorted(rng.sample(AMOUNTS, 2))
    p1, p2 = sorted(rng.sample(PCTS, 2))
    d1, d2 = sorted(rng.sample(DAYS, 2))
    return dict(
        scope=_scope_from_k(k, start),
        amount=f"{a1:,}", amount2=f"{a2:,}",
        days=d1, days2=d2, pct=p1, pct2=p2,
        srole=rng.choice(SENIOR_ROLES), jrole=rng.choice(JUNIOR_ROLES),
        system=rng.choice(SYSTEMS), region=rng.choice(REGIONS),
    )


def generate(n: int, seed: int = 20260717, n_multi_clusters: int = 60):
    rng = random.Random(seed)
    rules: list[dict] = []
    # flatten (dept, concept) list; round-robin so departments stay balanced
    dept_concepts = [(d, c) for d in DEPARTMENTS for c in CONCEPTS[d]]
    rid = 0
    scope_start = rng.randrange(_SCOPE_SPACE)
    scope_k = 0  # only-ever-increments -> globally unique scopes
    # Stamp instances round-robin over every (dept, concept) until we hit n.
    # Each instance draws fresh params -> a genuinely distinct policy.
    while len(rules) < n:
        for dept, concept in dept_concepts:
            if len(rules) >= n:
                break
            p = _mk_params(rng, scope_k, scope_start)
            scope_k += 1
            body = _fill(rng.choice(concept["body_variants"]), p)
            title = _fill(concept["title"], p)
            rid += 1
            rules.append(dict(
                id=f"{dept}-{concept['concept']}-{rid:07d}",
                title=title,
                body=body,
                tags=[dept, concept["concept"]] + ([concept["collision_group"]] if concept["collision_group"] else []),
                dept=dept,
                concept=concept["concept"],
                collision_group=concept["collision_group"],
                cluster=None,
                _params=p,
                _keywords=concept["keywords"],
                _paraphrase=_fill(concept["paraphrase"], p),
            ))

    # Bounded multi-answer clusters. A named cross-functional "program"
    # (e.g. "the APAC data-residency program") legitimately spans a handful
    # of sibling rules across departments; a query about the program should
    # surface ALL of them. This gives multi_rule a BOUNDED, meaningful gold
    # set at every tier (unlike "all X policies", whose gold explodes to
    # thousands of instances at scale and makes recall@k meaningless). These
    # are the family the item-11 reranker regression was measured against, so
    # we keep them well-formed. Overwrites a few base rules in place so the
    # corpus stays exactly size n.
    programs = ["data-residency", "customer-trust", "cost-discipline", "incident-readiness",
                "vendor-risk", "audit-readiness", "privacy-by-design", "access-hygiene"]
    for ci in range(n_multi_clusters):
        region = rng.choice(REGIONS)
        program = rng.choice(programs)
        cluster_id = f"prog-{program}-{region}-{ci:03d}".replace(" ", "")
        program_phrase = f"the {region} {program} program"
        m = rng.randint(3, 6)
        picks = rng.sample(dept_concepts, m)
        # replace the first m base rules deterministically for this cluster
        base_slots = rng.sample(range(len(rules)), m)
        for slot, (dept, concept) in zip(base_slots, picks):
            p = _mk_params(rng, scope_k, scope_start)
            scope_k += 1
            body = _fill(rng.choice(concept["body_variants"]), p)
            body = f"As part of {program_phrase}, {body[0].lower()}{body[1:]}"
            title = f"{_fill(concept['title'], p)} under {program_phrase}"
            r = rules[slot]
            r.update(dict(
                title=title, body=body, cluster=cluster_id,
                tags=r["tags"] + [f"cluster:{cluster_id}"],
                _paraphrase=f"which policies govern {program_phrase}",
            ))
    return rules


# ---------------------------------------------------------------------------
# Query construction. Each query gets a family tag and a gold id set. We build
# queries proportional to tier size (capped so the harness stays fast), with a
# real emphasis on the cross-department collision family.
# ---------------------------------------------------------------------------

def build_queries(rules: list[dict], n_per_family: int, seed: int = 7):
    rng = random.Random(seed)
    by_group: dict[str, list[dict]] = {}
    for r in rules:
        if r["collision_group"]:
            by_group.setdefault(r["collision_group"], []).append(r)

    queries: list[dict] = []
    qid = 0

    def add(q, family, gold):
        nonlocal qid
        qid += 1
        queries.append(dict(id=f"q{qid:06d}", query=q, family=family, gold=gold))

    # exact_name: title verbatim -> that rule
    for r in rng.sample(rules, min(n_per_family, len(rules))):
        add(r["title"], "exact_name", [r["id"]])

    # paraphrase: disjoint-vocabulary restatement -> that rule
    for r in rng.sample(rules, min(n_per_family, len(rules))):
        add(r["_paraphrase"], "paraphrase", [r["id"]])

    # keyword_only: a couple of keyword fragments + one concrete specific
    for r in rng.sample(rules, min(n_per_family, len(rules))):
        kw = rng.choice(r["_keywords"])
        # tack on a real specific from the rule so it points at THIS instance
        scope = r["_params"]["scope"]
        add(f"{kw} {scope}", "keyword_only", [r["id"]])

    # multi_rule: a named cross-functional program -> the whole (bounded)
    # cluster of sibling rules is legitimately correct.
    clusters: dict[str, list[dict]] = {}
    for r in rules:
        if r.get("cluster"):
            clusters.setdefault(r["cluster"], []).append(r)
    for cid, grp in list(clusters.items())[:n_per_family]:
        # every rule in the cluster shares the same program-phrase paraphrase
        add(grp[0]["_paraphrase"], "multi_rule", [r["id"] for r in grp])

    # cross-department collision: name the concept, but include a
    # department-disambiguating cue -> ONLY that department's rule is gold,
    # even though same-concept rules exist in other departments (distractors).
    collision_built = 0
    groups_with_multi_dept = [grp for grp in by_group.values()
                              if len({r["dept"] for r in grp}) >= 2]
    # keep going round-robin over collision groups until we hit the target
    while collision_built < n_per_family and groups_with_multi_dept:
        for grp in groups_with_multi_dept:
            if collision_built >= n_per_family:
                break
            target = rng.choice(grp)
            distractors = [r["id"] for r in grp
                           if r["dept"] != target["dept"]]
            kw = rng.choice(target["_keywords"])
            # disambiguating cue = the department + the target's scope
            q = f"{target['dept']} {kw} for {target['_params']['scope']}"
            add(q, "collision", [target["id"]])
            # store a COUNT + small sample, not the full list (at 100K+ a
            # collision group holds thousands of same-concept rules and the
            # full id list bloats queries.jsonl into the hundreds of MB; the
            # harness only ever uses `gold` for scoring).
            queries[-1]["n_distractors"] = len(distractors)
            queries[-1]["distractor_sample"] = distractors[:5]
            collision_built += 1

    return queries


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, required=True, help="corpus size")
    ap.add_argument("--out", type=str, required=True, help="output dir")
    ap.add_argument("--queries-per-family", type=int, default=200)
    ap.add_argument("--seed", type=int, default=20260717)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    rules = generate(args.n, seed=args.seed)
    queries = build_queries(rules, args.queries_per_family, seed=args.seed + 1)

    # strip the private helper fields from the committed corpus but keep a
    # slim, reproducible record.
    with (out / "corpus.jsonl").open("w") as f:
        for r in rules:
            rec = {k: r[k] for k in ("id", "title", "body", "tags", "dept", "concept", "collision_group", "cluster")}
            f.write(json.dumps(rec) + "\n")

    with (out / "queries.jsonl").open("w") as f:
        for q in queries:
            f.write(json.dumps(q) + "\n")

    from collections import Counter
    fam = Counter(q["family"] for q in queries)
    dep = Counter(r["dept"] for r in rules)
    print(f"corpus={len(rules)} queries={len(queries)}")
    print("by family:", dict(fam))
    print("by dept:", dict(dep))


if __name__ == "__main__":
    main()
