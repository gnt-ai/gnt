/* Hallmark · genre: modern-minimal · macrostructure: Split Studio
 * theme: existing terminal-native system (preserved, not catalog-swapped —
 * IBM Plex Mono single-font-by-design, near-monochrome ink/paper, one
 * green TUI accent) · enrichment: none (real TerminalBlock sessions stand
 * in for proof, not a catalog illustration tier) · nav: out of scope
 * (MarketingHeader, unedited) · footer: out of scope (MarketingFooter,
 * unedited)
 * pre-emit critique: P5 H5 E5 S5 R5 V5
 */
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowDown, ArrowRight } from "lucide-react";
import { CopyCtaButton } from "@/components/copy-cta-button";
import { FaqList } from "@/components/faq-list";
import { InstallTabs } from "@/components/install-tabs";
import { MarketingFooter } from "@/components/marketing-footer";
import { MarketingHeader } from "@/components/marketing-header";
import { TerminalBlock } from "@/components/terminal-block";
import packageJson from "../package.json";

const TITLE = "gnt.ai: The rulebook your agents actually check.";
const DESCRIPTION =
  "Rules live as files in your repo. Agents call check_action before anything risky, and every answer traces back to a merged PR.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    type: "website",
    title: TITLE,
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

const INSTALL_COMMAND = "npm install -g @gnt-ai/cli";

const CAPABILITIES = [
  {
    mark: "+",
    label: "Enforces, not just retrieves",
    desc: "Sits in front of the agent's next move, not just answering questions about it. Every check comes back allowed, blocked, or needs_human — plus the exact rule that made the call.",
  },
  {
    mark: "+",
    label: "Gets your first rules in fast",
    desc: "gnt prebrain reads your repo, docs, and the tools you already use (Notion, Linear, Jira...) and drafts your first rules for you. Don't have much written down yet? Starter packs cover the gap.",
  },
  {
    mark: "+",
    label: "Keeps rules honest over time",
    desc: "Every night, it flags what your rules don't cover yet, what's gone stale, and where two rules contradict each other — each one lands as its own PR, ready to review.",
  },
];

const PIPELINE = [
  {
    label: "Draft",
    desc: "gnt prebrain scans this repo and drafts your first rules automatically. After that: Slack, a webhook, a dozen-plus connectors, or by hand.",
    lines: [
      "$ gnt prebrain",
      "# scans this repo, drafts your first rules",
      "✓ Opened PR: acme/rules#412",
    ],
    copyText: "gnt prebrain",
  },
  {
    label: "Review",
    desc: "gnt review turns anything drafted outside prebrain into a real PR. prebrain opens its own directly.",
    lines: [
      "$ gnt review",
      "1 rule awaiting approval: refund-threshold",
      "✓ Opened PR: acme/rules#413",
    ],
    copyText: "gnt review",
  },
  {
    label: "Merge",
    desc: "A human merges it on GitHub — that's the approval, nothing else.",
    lines: [
      "$ git log -1 --oneline",
      "a3f1c9d Merge pull request #412 from acme/rules",
      "✓ Rule is live. Any MCP client can query it now.",
    ],
    copyText: "git log -1 --oneline",
  },
];

const FAQ = [
  {
    q: "What does check_action actually do?",
    a: "You describe the action in plain English. gnt checks it against your org's approved rules before the agent does it, and hands back allowed, blocked, or needs_human, plus exactly which rule made the call. If nothing covers the situation, you get needs_human, never a guess.",
  },
  {
    q: "Does gnt.ai store our data?",
    a: "Yes, and it's not either/or. Rules are files in your own git repo, reviewed and merged like code, and gnt also stores them in its own database, since that's what search_rules and get_rule read from over MCP. Anything that comes in through a webhook, Slack, or a sync passes through gnt's servers too, gets privacy-gated on arrival, and sits as a draft until you approve or reject it.",
  },
  {
    q: "Which agents can connect?",
    a: "Any MCP-compatible client: Claude, GPT, or something you built yourself. One endpoint, five tools: check_action, search_rules, get_rule, list_skill_packs, get_skill_pack.",
  },
  {
    q: "What happens when gnt doesn't know something?",
    a: "search_rules only ever hands back approved, cited rules. It never makes anything up. If nothing matches, you get an empty result, not an invented answer.",
  },
  {
    q: "What's a skill pack?",
    a: "A versioned, compiled bundle of your org's approved rules that an agent can pull and verify by hash. Run gnt pull from the terminal to grab the latest one, or use list_skill_packs and get_skill_pack over MCP.",
  },
  {
    q: "How much does it cost?",
    a: "$29/month gets you 1,500 check_action calls and a 14-day free trial. $149/month gets you 8,000 calls and is the only tier that can invite people already on another org, billed immediately with no trial. Full breakdown on the pricing page.",
  },
];

const CLI_LINES = [
  "$ npm install -g @gnt-ai/cli",
  "$ gnt login",
  "✓ Logged in. Credentials saved to ~/.gnt/credentials.json",
  "",
  "$ gnt connect github",
  "✓ Connected. Rules will open as PRs against your repo.",
  "",
  "$ gnt prebrain",
  "# scans this repo, drafts your first rules",
  "✓ Opened PR: https://github.com/acme/rules/pull/412",
  "",
  "# merge it on GitHub. That merge is the approval.",
];

const CLI_COPY_TEXT = "npm install -g @gnt-ai/cli";

// Shortened from the full clone/build/migrate/up sequence (still the real
// one in docs/self-hosting/README.md) -- that many lines read as friction
// before a visitor's even started. This keeps it honest without spelling
// out every step: the comment line says plainly that env setup and a
// migration happen before `docker compose up` actually works, so nobody
// reads this as a true zero-config one-liner, and points at the doc that
// has the real sequence.
const SELF_HOST_LINES = [
  "$ git clone https://github.com/gnt-ai/gnt && cd gnt",
  "# fill in your .env files, run the migration once --",
  "# full sequence: docs/self-hosting/README.md",
  "$ docker compose up",
];

const SELF_HOST_COPY_TEXT = "git clone https://github.com/gnt-ai/gnt && cd gnt";

// Section label -- badge-section-label from the OpenCode reference doc:
// bold heading-md text, no chip background. The hairline that used to
// live under this label now comes from the section's own border-t (see
// <Section> below) -- one line, not two.
function SectionLabel({ children }: { children: string }) {
  return <h2 className="font-mono text-base font-bold tracking-tight mb-6">{children}</h2>;
}

// Every section after the hero sits inside the frame's left/right hairline
// (see the wrapping div in the page body) and adds its own top hairline --
// together they read as the reference's boxed/grid layout, not just
// isolated dividers floating between stacked blocks. Same px-6 as
// MarketingHeader's own logo/nav row and the hero below, at every
// breakpoint -- one consistent inset the whole page (header included)
// shares, rather than some elements sitting flush against the frame
// border and others padded away from it. Content runs the section's own
// full width (minus this px-6) rather than a narrower max-w-2xl column --
// that cap left text stopping ~70px short of the frame's right edge.
function Section({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="w-full border-t border-border px-6 py-16 scroll-mt-14">
      {children}
    </section>
  );
}

// Real mechanism diagrams, not stock illustration -- each step is a
// bordered box (same visual language as every other box on the page,
// TerminalBlock included) connected by an arrow. Row on desktop, column
// on mobile (ArrowRight rotates to ArrowDown below sm), so it never
// forces horizontal scroll on a phone. This is what replaces the "real
// annotated screenshot" placeholder for the mechanics that don't need a
// live dashboard to show honestly -- the request flow and the
// architecture are both true regardless of what data is in any
// particular account.
function FlowDiagram({ steps }: { steps: { label: string; sub?: string }[] }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-stretch gap-3 sm:gap-0">
      {steps.map((step, i) => (
        <div key={step.label} className="flex flex-col sm:flex-row items-center flex-1">
          <div className="w-full border border-border rounded-[4px] px-4 py-3 text-center">
            <p className="font-mono text-sm font-bold">{step.label}</p>
            {step.sub ? <p className="font-mono text-xs text-muted mt-1">{step.sub}</p> : null}
          </div>
          {i < steps.length - 1 ? (
            <div className="shrink-0 text-muted py-2 sm:py-0 sm:px-3" aria-hidden="true">
              <ArrowDown className="h-4 w-4 sm:hidden" />
              <ArrowRight className="h-4 w-4 hidden sm:block" />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

const PROVENANCE_STEPS = [
  { label: "Agent acts", sub: "calls check_action" },
  { label: "gnt checks", sub: "against rules/*.md" },
  { label: "Matched rule", sub: "cited by id + title" },
  { label: "Rule's git file", sub: "frontmatter links the approving PR" },
];

const CLI_PRIVACY_STEPS = [
  { label: "Your source material", sub: "repo, docs, connected tools" },
  { label: "Privacy gate", sub: "runs on your device" },
  { label: "Your model provider", sub: "Anthropic direct, or --mode local" },
];

const SERVER_PRIVACY_STEPS = [
  { label: "Webhook, Slack, or a sync", sub: "no device of yours in this path" },
  { label: "gnt's server", sub: "masked on arrival" },
  { label: "Stays masked", sub: "unrecoverable after" },
];

// No server-side session fetch here on purpose -- the marketing content
// below never depends on auth state (only the header's own sign-in/sign-up
// vs. sign-out buttons do, and MarketingHeader's client-side useSession()
// already resolves that itself, same as the 3 pages that pass it no
// initialSession today, e.g. accept-invitation). Fetching the session
// server-side forced Next.js to render "/" dynamically on every request --
// a DB round trip before a single byte of a page with no per-user content
// could ship. Staying session-free lets "/" prerender fully static instead.
export default function LandingPage() {
  return (
    <div className="flex-1 flex flex-col">
      <MarketingHeader />

      <main className="flex-1 flex flex-col items-center">
        {/* Frame -- left/right hairline running the full height of the page
            body, matching MarketingHeader and MarketingFooter. Stacked
            single column, not a side-by-side diptych -- tried the terminal
            beside the headline and it never had room to breathe at this
            frame width, either cramped next to an oversized headline or
            fighting it for space no matter how the columns were split.
            Full-width below the pitch is what actually worked here. */}
        <div className="w-full max-w-3xl sm:border-x sm:border-border">
          {/* Hero */}
          <div className="px-6 pt-8 pb-16 flex flex-col items-start gap-4 text-left">
            {/* badge-news announcement bar -- a bordered strip, not just
                an inline badge+link, matching the reference's own
                "Introducing..." bar treatment. */}
            <div className="flex items-center gap-3 border border-border rounded-[4px] px-3 py-1.5 font-mono text-sm">
              <span className="rounded-[4px] bg-accent-brand px-2 py-0.5 text-xs text-accent-brand-foreground shrink-0">
                New
              </span>
              {/* Site release, not the CLI's — @gnt-ai/cli versions independently
                  (see apps/cli/package.json), so this is labeled explicitly to
                  avoid reading as `gnt --version`'s number. */}
              <span className="text-muted">gnt.ai site v{packageJson.version} is live.</span>
              <Link
                href="/changelog"
                className="group inline-flex items-center gap-1 text-foreground hover:opacity-80 transition-opacity duration-150 ease-out-strong whitespace-nowrap"
              >
                What&apos;s new
                <ArrowRight className="h-3.5 w-3.5 transition-transform duration-150 ease-out-strong group-hover:translate-x-0.5" />
              </Link>
            </div>
            {/* Headline names the mechanism, not the category -- not what
                we call ourselves, but the actual habit an agent has to
                have: checking before it acts, every time. */}
            <h1 className="font-mono text-2xl sm:text-3xl font-bold tracking-tight leading-tight">
              The rulebook your agents actually check.
            </h1>
            <p className="font-mono text-sm text-muted">
              Rules live as files in your repo. Agents call{" "}
              <code className="font-bold">check_action</code> before anything risky. Every answer
              traces to a merged PR.
            </p>
            <div className="w-full max-w-md mt-2">
              <InstallTabs />
            </div>
            {/* Hosted stays the primary CTA above (InstallTabs) -- these two
                are equally weighted secondary text links, same treatment as
                "Learn how it works" always had, just now with a second path
                next to it instead of implying hosted is the only one. */}
            <div className="flex flex-wrap items-center gap-5">
              <Link
                href="#how-it-works"
                className="group inline-flex items-center justify-center gap-2 font-mono text-sm text-muted hover:text-foreground transition-colors duration-150 ease-out-strong"
              >
                Learn how it works
                <ArrowRight className="h-3.5 w-3.5 transition-transform duration-150 ease-out-strong group-hover:translate-x-0.5" />
              </Link>
              <Link
                href="#source-available"
                className="group inline-flex items-center justify-center gap-2 font-mono text-sm text-muted hover:text-foreground transition-colors duration-150 ease-out-strong"
              >
                Self-host it instead
                <ArrowRight className="h-3.5 w-3.5 transition-transform duration-150 ease-out-strong group-hover:translate-x-0.5" />
              </Link>
            </div>
          </div>

          {/* Same TerminalBlock as docs' examples, same treatment too --
              rounded, inset by the same px-6 as the hero/sections around
              it, not flush against the frame border. theme-dark-surface
              keeps it the one deliberately-dark element regardless of site
              theme. pb-10 gives it room before the next section's own
              border-t. Full frame width -- no column to squeeze it, so its
              longer lines (the install command, the opened-PR URL) show
              without needing to scroll on anything but the narrowest
              phones. */}
          <div className="theme-dark-surface w-full px-6 pb-10">
            <TerminalBlock lines={CLI_LINES} copyText={CLI_COPY_TEXT} />
          </div>

          {/* Proof bar -- real, checkable signals only (license, source,
              self-host path), no invented stats or counts. Thin on purpose:
              a footnote-weight strip right under the install walkthrough,
              not another full Section like the ones around it. */}
          <div className="w-full border-t border-border px-6 py-4 flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-sm text-muted">
            <span>FSL-1.1-Apache-2.0, source-available</span>
            <Link
              href="https://github.com/gnt-ai/gnt"
              target="_blank"
              rel="noreferrer"
              className="text-foreground hover:opacity-80 transition-opacity duration-150 ease-out-strong"
            >
              Source on GitHub
            </Link>
            <Link
              href="#source-available"
              className="text-foreground hover:opacity-80 transition-opacity duration-150 ease-out-strong"
            >
              Self-hostable
            </Link>
          </div>

          {/* What is gnt.ai? -- bracket-marker capability list, direct
              structural match to the reference's "What is OpenCode?"
              section: [+] prefix, bold label, muted description. */}
          <Section>
            <SectionLabel>What is gnt.ai?</SectionLabel>
            <p className="font-mono text-sm text-muted mb-6">
              A git-native rules layer for AI agents: every rule is a file in your repo,
              reviewed and merged like code.
            </p>
            <ul className="flex flex-col gap-1">
              {CAPABILITIES.map((c) => (
                <li
                  key={c.label}
                  className="group flex gap-2 font-mono text-sm leading-relaxed py-1"
                >
                  <span
                    aria-hidden="true"
                    className="text-muted shrink-0 transition-colors duration-150 ease-out-strong group-hover:text-foreground"
                  >
                    [{c.mark}]
                  </span>
                  <p>
                    <span className="font-bold">{c.label}</span>{" "}
                    <span className="text-muted">{c.desc}</span>
                  </p>
                </li>
              ))}
            </ul>
          </Section>

          {/* How it works -- each step is a real terminal snippet next to
              its description, not just prose (see PIPELINE's own lines/
              copyText). Text and card swap sides on alternate steps so
              the section reads as a sequence, not three identical rows --
              same idea as Graphify's step cards, gnt's own palette
              (theme-dark-surface card, same as the hero's terminal). */}
          <Section id="how-it-works">
            <SectionLabel>How it works</SectionLabel>
            <ol className="flex flex-col gap-10">
              {PIPELINE.map((step, i) => (
                <li key={step.label} className="flex flex-col gap-4 sm:flex-row sm:items-center">
                  <div
                    className={`flex gap-4 sm:w-2/5 ${i % 2 === 1 ? "sm:order-2" : ""}`}
                  >
                    <span className="text-2xl font-bold leading-none text-muted shrink-0 tabular-nums">
                      {i + 1}
                    </span>
                    <p className="font-mono text-sm leading-relaxed pt-1">
                      <span className="font-bold">{step.label}.</span>{" "}
                      <span className="text-muted">{step.desc}</span>
                    </p>
                  </div>
                  <div className={`theme-dark-surface sm:w-3/5 ${i % 2 === 1 ? "sm:order-1" : ""}`}>
                    <TerminalBlock lines={step.lines} copyText={step.copyText} />
                  </div>
                </li>
              ))}
            </ol>
          </Section>
        </div>

        {/* The honest pitch -- placed once the mechanism's been explained
            (what it is, how it works), before the proof/comparison/trust
            detail that follows. Names the actual moment people go looking
            for something like this: after an agent did something expensive
            with no record of why. Breaks past the boxed frame (the hero
            above is the other one) -- full-bleed and set in the largest
            body type on the page, so it reads as a statement, not another
            paragraph the same weight as the FAQ answers further down. No
            forced dark surface here; that trick is TerminalBlock's alone
            (see its own comment) and only inverts correctly in one theme
            direction. */}
        <div className="w-full border-y border-border">
          <div className="max-w-3xl mx-auto px-6 py-16 lg:py-24">
            <p className="font-mono text-xl sm:text-2xl leading-snug">
              Most teams find us after an agent already did something expensive, or wrong, or
              just embarrassing, and nobody could say which rule should have caught it.{" "}
              <code className="font-mono font-bold">check_action</code> would have.{" "}
              <span className="text-muted">
                If that&apos;s not you yet, good. This is what you set up before it is, not
                after.
              </span>
            </p>
          </div>
        </div>

        <div className="w-full max-w-3xl sm:border-x sm:border-border">
          {/* Provenance -- the payoff section above makes the claim in
              prose; this is the same claim as a diagram, since "every
              rule traces to its approving PR" is exactly the kind of
              thing that's faster to see than to read. Real mechanism
              (see FlowDiagram's own comment for what backs it), not a
              screenshot of a UI that doesn't have a dashboard view of
              this yet -- that's still a real gap, tracked separately,
              not papered over with a mockup. */}
          <Section id="provenance">
            <SectionLabel>Every answer has a paper trail</SectionLabel>
            <FlowDiagram steps={PROVENANCE_STEPS} />
          </Section>

          {/* Built for privacy first -- two real trust boundaries, each as
              its own diagram + short caption instead of a paragraph.
              Same facts as before (see apps/api/src/gnt/pipeline/
              privacy_gate/__init__.py's module docstring for the
              server-side gate's full reasoning), just something you see
              in one glance, not something you have to read twice to
              notice -- stacked full-width rather than a 2-column grid
              since a 3-step diagram needs the room a half-width column
              doesn't have. */}
          <Section id="privacy">
            <SectionLabel>Built to stay out of your data</SectionLabel>
            <div className="flex flex-col gap-8">
              <div className="border border-border rounded-[4px] p-4">
                <p className="font-mono text-sm font-bold mb-4">gnt prebrain (CLI)</p>
                <FlowDiagram steps={CLI_PRIVACY_STEPS} />
                <p className="font-mono text-sm text-muted leading-relaxed mt-4">
                  Cloud by default, direct from your device to your own model provider, never to
                  gnt&apos;s servers. The one exception: once rules are drafted, gnt posts them to
                  its own API to open the PR. That request is how the PR gets created.
                </p>
              </div>
              <div className="border border-border rounded-[4px] p-4">
                <p className="font-mono text-sm font-bold mb-4">Webhook, Slack, or a sync</p>
                <FlowDiagram steps={SERVER_PRIVACY_STEPS} />
                <p className="font-mono text-sm text-muted leading-relaxed mt-4">
                  No device of yours in this path, so it reaches gnt&apos;s server first, and gets
                  masked the moment it arrives.
                </p>
              </div>
            </div>
            <p className="font-mono text-sm text-muted leading-relaxed mt-6">
              That privacy gate is source-available code, not a promise — read it yourself, or
              self-host it. Full connector-by-connector breakdown in{" "}
              <Link href="/docs" className="text-foreground underline">
                the docs
              </Link>
              .
            </p>
          </Section>

          {/* Source-available -- the license/self-host story gets its own
              section rather than staying folded into the privacy section
              above, since it's a distinct claim (what you can do with the
              code) from the privacy one (what happens to your data). Same
              terminal-block treatment as the hero's hosted quickstart --
              this is the self-host equivalent of that command, not prose
              trying to describe a `docker compose up`. */}
          <Section id="source-available">
            <SectionLabel>Source-available, not a black box</SectionLabel>
            <p className="font-mono text-sm text-muted leading-relaxed mb-4">
              Licensed FSL-1.1-Apache-2.0: source-available and self-hostable today, on your own
              infrastructure with your own keys. Two years after this repo goes public it
              converts automatically to Apache-2.0 — no restrictions left. Until then, the one
              thing you can&apos;t do is run a competing hosted version of gnt itself.
            </p>
            <p className="font-mono text-sm text-muted leading-relaxed mb-4">
              A clone and a compose command away from the full API, MCP server, worker, and
              rules store, on your own machine:
            </p>
            <div className="theme-dark-surface w-full mb-4">
              <TerminalBlock lines={SELF_HOST_LINES} copyText={SELF_HOST_COPY_TEXT} />
            </div>
            <div className="flex flex-wrap items-center gap-5">
              <Link
                href="https://github.com/gnt-ai/gnt"
                target="_blank"
                rel="noreferrer"
                className="group inline-flex items-center gap-1.5 font-mono text-sm text-foreground hover:opacity-80 transition-opacity duration-150 ease-out-strong"
              >
                Read the repo
                <ArrowRight className="h-3.5 w-3.5 transition-transform duration-150 ease-out-strong group-hover:translate-x-0.5" />
              </Link>
              <Link
                href="https://github.com/gnt-ai/gnt/blob/main/docs/self-hosting/README.md"
                target="_blank"
                rel="noreferrer"
                className="font-mono text-sm text-muted underline hover:text-foreground transition-colors duration-150 ease-out-strong"
              >
                Full self-hosting walkthrough
              </Link>
            </div>
          </Section>

          {/* FAQ -- real click-to-expand rows per the reference's faq-row
              spec (see components/faq-list.tsx), not just text styled to
              look like one. Bare +/− marker distinguishes this from the
              capability list's bracketed, always-visible [+] rows above. */}
          <Section>
            <SectionLabel>Frequently asked questions</SectionLabel>
            <div className="border border-border rounded-[4px] px-4">
              <FaqList items={FAQ} />
            </div>
          </Section>

        </div>

        {/* Closing CTA -- a confidence statement, then the same primary
            action repeated. Frame resumes one last time here so the page
            ends boxed, same width MarketingFooter picks up immediately
            after. */}
        <div className="w-full max-w-3xl sm:border-x sm:border-border">
          <Section>
            <div className="flex flex-col items-start gap-5 text-left">
              <h2 className="font-mono text-3xl sm:text-4xl font-bold tracking-tight leading-tight">
                Approval is a merged PR.
              </h2>
              <p className="font-mono text-sm text-muted">
                No separate sign-off screen to review in. Just the git workflow your team
                already uses.
              </p>
              <div className="flex flex-wrap items-center gap-4">
                <CopyCtaButton command={INSTALL_COMMAND} label="npm install -g @gnt-ai/cli" />
                <Link
                  href="/sign-up"
                  className="group inline-flex items-center gap-1.5 font-mono text-sm text-muted hover:text-foreground transition-colors duration-150 ease-out-strong"
                >
                  Start free trial
                  <ArrowRight className="h-3.5 w-3.5 transition-transform duration-150 ease-out-strong group-hover:translate-x-0.5" />
                </Link>
              </div>
            </div>
          </Section>
        </div>
      </main>

      <MarketingFooter />
    </div>
  );
}
