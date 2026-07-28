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
import { ArrowRight } from "lucide-react";
import { CopyCtaButton } from "@/components/copy-cta-button";
import { FaqList } from "@/components/faq-list";
import { InstallTabs } from "@/components/install-tabs";
import { MarketingFooter } from "@/components/marketing-footer";
import { MarketingHeader } from "@/components/marketing-header";
import { TerminalBlock } from "@/components/terminal-block";
import packageJson from "../package.json";

const TITLE = "gnt.ai: The brain for AI companies. In your terminal.";
const DESCRIPTION =
  "Checks what an agent's about to do against your rules before it does it. Everything else lives as files in your own repo, and approval is a merged PR.";

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
  },
  {
    label: "Review",
    desc: "gnt review turns anything drafted outside prebrain into a real PR. prebrain opens its own directly.",
  },
  {
    label: "Merge",
    desc: "A human merges it on GitHub — that's the approval, nothing else.",
  },
];

const FAQ = [
  {
    q: "What does check_action actually do?",
    a: "You describe the action in plain English, gnt checks it against your org's approved rules before the agent does it, and hands back allowed, blocked, or needs_human — plus exactly which rule made the call. If nothing covers the situation, you get needs_human, never a guess.",
  },
  {
    q: "Does gnt.ai store our data?",
    a: "Not your approved rules — those live as files in your own git repo, not in a database we control. If something comes in through a webhook, Slack, or the Zendesk/Intercom sync, it does pass through gnt's servers first, but it's privacy-gated on arrival and sits as a draft until you approve or reject it.",
  },
  {
    q: "Which agents can connect?",
    a: "Any MCP-compatible client — Claude, GPT, or something you built yourself. One endpoint, five tools: check_action, search_rules, get_rule, list_skill_packs, get_skill_pack.",
  },
  {
    q: "What happens when gnt doesn't know something?",
    a: "search_rules only ever hands back approved, cited rules — it never makes anything up. If nothing matches, you get an empty result, not an invented answer.",
  },
  {
    q: "What's a skill pack?",
    a: "A versioned, compiled bundle of your org's approved rules that an agent can pull and verify by hash. Run gnt pull from the terminal to grab the latest one, or use list_skill_packs and get_skill_pack over MCP.",
  },
  {
    q: "How do we get our first rules in?",
    a: "Run gnt prebrain. It scans your repo and docs, asks you a few quick questions, and opens your first pull requests for you. If you don't have much written policy yet, editable starter packs — refunds, discounts, engineering conventions, incident response — fill the gap.",
  },
  {
    q: "Can we self-host it?",
    a: "Yes. One docker-compose.yml gets the full API, MCP server, worker, and rules store running on your own infrastructure, with your own keys. Your rules live in your own git repo either way — hosted or self-hosted.",
  },
  {
    q: "Is gnt open source?",
    a: "Source-available under FSL-1.1-Apache-2.0 — you can read every line, self-host it, modify it, and send changes back. The one thing you can't do is sell a competing hosted version of gnt itself, and even that restriction lifts automatically two years after this repo goes public, converting to plain Apache-2.0.",
  },
  {
    q: "How much does it cost?",
    a: "$29/month gets you 1,500 check_action calls and a 14-day free trial. $149/month gets you 8,000 calls and is the only tier that can invite people already on another org — billed immediately, no trial. Full breakdown on the pricing page.",
  },
];

const CLI_LINES = [
  "$ npm install -g @gnt-ai/cli",
  "$ gnt login",
  "✓ Logged in. Credentials saved to ~/.gnt/credentials.json",
  "",
  "$ gnt prebrain",
  "# scans this repo, asks a few questions, drafts your first rules",
  "✓ Opened PR: https://github.com/acme/rules/pull/412",
  "",
  "# merge it on GitHub. that merge is the approval.",
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
            {/* Headline names the mechanism, not the category -- "the
                brain for AI companies" told you what we call ourselves;
                this tells you what happens the moment an agent tries
                something. */}
            <h1 className="font-mono text-2xl sm:text-3xl font-bold tracking-tight leading-tight">
              Check the agent&apos;s next move. Before it happens.
            </h1>
            <p className="font-mono text-sm text-muted">
              Every rule lives as a file in your repo, reviewed like code. Approval is a merged
              pull request.
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

          {/* How it works -- the pipeline is inherently sequential
              (draft → review → merge), so this stays a numbered list
              rather than forcing it into the bracket-marker vocabulary
              above, which is for parallel capabilities, not an ordered
              flow. */}
          <Section id="how-it-works">
            <SectionLabel>How it works</SectionLabel>
            <ol className="flex flex-col gap-6">
              {PIPELINE.map((step, i) => (
                <li
                  key={step.label}
                  className="group flex gap-4 font-mono text-sm leading-relaxed"
                >
                  {/* Numeral sized up from the body copy around it -- the
                      one place on the page a bare number is allowed to
                      carry weight, since it's a real ordinal step count,
                      not a decorative eyebrow. Shifts to full foreground on
                      hover -- the one hover affordance this list didn't have
                      before, same 150ms/ease-out-strong idiom every other
                      hover state on the page already uses, not a new one. */}
                  <span className="text-2xl font-bold leading-none text-muted shrink-0 tabular-nums transition-colors duration-150 ease-out-strong group-hover:text-foreground">
                    {i + 1}
                  </span>
                  <p className="pt-1">
                    <span className="font-bold">{step.label}.</span>{" "}
                    <span className="text-muted">{step.desc}</span>
                  </p>
                </li>
              ))}
            </ol>
          </Section>

          {/* Built for privacy first -- two real trust boundaries, shown as
              a side-by-side comparison instead of two lookalike paragraphs
              stacked on top of each other. Same facts as before (see
              apps/api/src/gnt/pipeline/privacy_gate/__init__.py's module
              docstring for the server-side gate's full reasoning), just
              laid out so the CLI-vs-webhook split is something you see in
              one glance, not something you have to read twice to notice --
              also the one section on the page that breaks from the
              single-paragraph rhythm every other Section uses, on purpose. */}
          <Section id="privacy">
            <SectionLabel>Built to stay out of your data</SectionLabel>
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <div>
                <p className="font-mono text-sm font-bold mb-1">gnt prebrain (CLI)</p>
                <p className="font-mono text-sm text-muted leading-relaxed">
                  Processed on your device. A local privacy gate screens anything before it
                  reaches a cloud model. Never touches gnt&apos;s servers, never trains on it.
                </p>
              </div>
              <div>
                <p className="font-mono text-sm font-bold mb-1">Webhook, Slack, or a sync</p>
                <p className="font-mono text-sm text-muted leading-relaxed">
                  No device of yours in that path, so it reaches gnt&apos;s server, gets masked
                  on arrival, and stays that way — unrecoverable after.
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
            <FaqList items={FAQ} />
          </Section>

        </div>

        {/* The honest pitch, right before the ask -- deliberately not the
            hero framing (that stays calm/proactive for people who haven't
            had the bad night yet). This one names the actual moment people
            go looking for something like this: after an agent did something
            expensive with no record of why. The page's second and last
            break past the boxed frame (the hero above is the first) --
            full-bleed and set in the largest body type on the page, so it
            actually reads as a statement and not another paragraph the
            same weight as the FAQ answers around it. No forced dark
            surface here; that trick is TerminalBlock's alone (see its own
            comment) and only inverts correctly in one theme direction. */}
        <div className="w-full border-y border-border">
          <div className="max-w-3xl mx-auto px-6 py-16 lg:py-24">
            <p className="font-mono text-xl sm:text-2xl leading-snug">
              Most teams find us after an agent already did something expensive, or wrong, or
              just embarrassing, and nobody could say which rule should have caught it.{" "}
              <code className="font-mono font-bold">check_action</code> would have.{" "}
              <span className="text-muted">
                If that&apos;s not you yet, good — this is what you set up before it is, not
                after.
              </span>
            </p>
          </div>
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
