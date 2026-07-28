import type { Metadata } from "next";
import { MarketingFooter } from "@/components/marketing-footer";
import { MarketingHeader } from "@/components/marketing-header";

const TITLE = "Privacy Policy · gnt.ai";
const DESCRIPTION = "How gnt.ai collects, uses, and protects data.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { type: "website", title: TITLE, description: DESCRIPTION },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

const EFFECTIVE_DATE = "July 18, 2026";

type Section = { heading: string; body: React.ReactNode };

const SECTIONS: Section[] = [
  {
    heading: "1. Who this applies to",
    body: (
      <>
        <p>
          gnt.ai (&ldquo;gnt.ai,&rdquo; &ldquo;we,&rdquo; &ldquo;us&rdquo;) is a git-native rules-governance
          layer for AI agents. An organization (&ldquo;org,&rdquo; &ldquo;you,&rdquo; &ldquo;your&rdquo;) connects
          gnt.ai to a GitHub repository of policy and rule content and, optionally, Slack. AI agents call
          gnt.ai&rsquo;s MCP server to look up rules and check actions against them.
        </p>
        <p>
          gnt.ai is business-to-business infrastructure. This policy describes what we collect from an org
          and the people acting on its behalf (its members, and any AI agents it authorizes), not
          end-consumers of your own product.
        </p>
      </>
    ),
  },
  {
    heading: "2. Information we collect",
    body: (
      <>
        <p>We collect the following categories of information:</p>
        <ul>
          <li>
            <strong>Account and identity data.</strong> Email address, name, and, if you choose to sign in
            that way, your Google or GitHub OAuth identity.
          </li>
          <li>
            <strong>Rule content.</strong> The text of the policies and rules your org writes or imports:
            titles, bodies, tags, and source citations. This is the core data our product exists to
            govern, and it can be sensitive internal company policy.
          </li>
          <li>
            <strong>Connection credentials.</strong> GitHub access is installation-scoped: connecting through
            our GitHub App stores no long-lived GitHub credential at all, only which repository you
            installed it on, and access tokens are minted on demand and expire within about an hour. An
            older, per-repo personal-access-token connection method still exists for orgs that set it up
            before the App; where that&rsquo;s in use, the token is encrypted at rest and is never returned
            by any API response after the moment it is set. A Slack bot token, if you connect it, is
            encrypted at rest the same way.
          </li>
          <li>
            <strong>Usage data.</strong> Which rules get served to your agents, coverage gaps (queries with no
            matching rule), rule freshness metadata, and aggregate usage counters. We do not sell or use this
            data for advertising.
          </li>
          <li>
            <strong>Payment information.</strong> If you subscribe, billing is handled by Stripe. We do not
            store your card number; Stripe processes and stores payment details under its own privacy policy.
          </li>
          <li>
            <strong>Audio</strong> (only if you use the voice-capture feature), sent directly to our
            transcription provider and not retained by gnt.ai after the transcript is returned.
          </li>
        </ul>
      </>
    ),
  },
  {
    heading: "3. How we use information",
    body: (
      <ul>
        <li>To operate the core product: storing, versioning, retrieving, and serving your org&rsquo;s rules.</li>
        <li>
          To extract candidate rules from source material you point our CLI at, and to check actions and
          detect contradictions using a language model.
        </li>
        <li>To authenticate you and maintain your session.</li>
        <li>To send transactional email: sign-in codes, organization invitations, and (if enabled) a weekly usage digest.</li>
        <li>To bill you, if you subscribe to a paid plan.</li>
        <li>To maintain security, prevent abuse, and enforce rate limits.</li>
        <li>To comply with legal obligations.</li>
      </ul>
    ),
  },
  {
    heading: "4. How your data reaches a model, and what&rsquo;s masked first",
    body: (
      <>
        <p>
          gnt.ai&rsquo;s CLI (<code>gnt prebrain</code>) runs primarily on your own device. Source material you
          point it at is read locally and passed through a local privacy gate, a layered set of
          detectors (pattern matching and named-entity recognition) that replaces emails, API keys, SSNs, and
          similar values with typed placeholders before anything is sent anywhere. In cloud extraction mode,
          only that masked text reaches the extraction model; in local mode, nothing leaves your device at
          all. A third layer, a local-model contextual pass meant to catch identifiers that only read as
          personal in context (&ldquo;the customer&rsquo;s usual order&rdquo;) rather than matching a pattern,
          is planned but not active yet; today it&rsquo;s a no-op, and the CLI says so on every{" "}
          <code>gnt prebrain</code> run rather than silently claiming coverage it doesn&rsquo;t have.
        </p>
        <p>
          Content submitted through a connected webhook or the Slack integration follows a different path:
          because there is no device of yours in that path, it reaches our server directly and is masked
          there, on arrival, before anything is stored. That masking is permanent; there is no way to
          recover the original text afterward.
        </p>
        <p>
          Rules already approved and merged into your repository are not put through the privacy gate before
          being served to your agents via search or <code>check_action</code>; by the time a rule is
          approved, it is your org&rsquo;s own reviewed content, not raw third-party source text.
        </p>
      </>
    ),
  },
  {
    heading: "5. Who we share data with",
    body: (
      <>
        <p>We share data only with the service providers (subprocessors) needed to run the product:</p>
        <ul>
          <li><strong>Anthropic</strong>: rule content, for extraction and contradiction-detection calls.</li>
          <li><strong>ZeroEntropy</strong>: rule title and body text, embedded and reranked to power search.</li>
          <li><strong>Groq</strong>: audio, if you use voice capture, for speech-to-text.</li>
          <li><strong>Resend</strong>: email addresses and message content, for transactional email.</li>
          <li><strong>Stripe</strong>: billing and payment information, if you subscribe.</li>
          <li><strong>Railway</strong> and <strong>Vercel</strong>: infrastructure hosting for our database, API, and web application.</li>
          <li><strong>Slack</strong>: only if you connect the Slack integration.</li>
          <li><strong>Google</strong> or <strong>GitHub</strong>: only if you choose to sign in via that provider; they receive the OAuth handshake, not rule content.</li>
        </ul>
        <p>
          Your own connected GitHub repository is not a subprocessor in the ordinary sense; it is
          infrastructure you already own and control, and gnt.ai reads and writes to it through an
          installation of our GitHub App, scoped to just that repository, the same way any CI tool would.
        </p>
        <p>We do not sell your data. We do not share it for advertising purposes.</p>
      </>
    ),
  },
  {
    heading: "6. Data retention",
    body: (
      <>
        <p>
          We retain your data for as long as your organization has an active account. If you request
          offboarding, an org admin can request a full export of your data and then permanently delete it;
          this is a two-step, admin-gated process that removes your organization&rsquo;s account
          records and its entire rules mirror from our systems. Rule content itself continues to exist in
          your own connected GitHub repository, which you control independently of gnt.ai.
        </p>
        <p>
          Offboarding today is an all-or-nothing operation at the organization level. If you need a more
          granular deletion request handled, contact us using the details below.
        </p>
      </>
    ),
  },
  {
    heading: "7. Security",
    body: (
      <ul>
        <li>Connection credentials (GitHub tokens, Slack bot tokens) are encrypted at rest.</li>
        <li>API keys and webhook tokens are stored as one-way hashes, never in plaintext, after the moment they are issued.</li>
        <li>Row-level security is enforced at the database layer for every table that carries an organization ID, independent of application-level checks. Two tables that must be looked up before an organization is known (API keys, by hash; Slack connections, by team ID) are the deliberate exception, and are protected by that lookup instead.</li>
        <li>Access to production systems is limited to the personnel who need it to operate the service.</li>
        <li>
          We do not currently hold a SOC 2, ISO 27001, or other third-party security certification. We will
          update this policy if that changes.
        </li>
      </ul>
    ),
  },
  {
    heading: "8. Cookies",
    body: (
      <p>
        We use one strictly necessary session cookie to keep you signed in. We do not use advertising,
        tracking, or third-party analytics cookies on our website.
      </p>
    ),
  },
  {
    heading: "9. Your rights",
    body: (
      <>
        <p>
          Depending on where you&rsquo;re located, you may have rights to access, correct, export, or delete
          your personal data, and to object to or restrict certain processing. To exercise any of these
          rights, contact us using the details below. We will respond within a reasonable time and in
          accordance with applicable law.
        </p>
        <p>
          If you are located in the European Economic Area, the United Kingdom, or Switzerland, you also have
          the right to lodge a complaint with your local data protection authority.
        </p>
        <p>
          If you are a California resident, you have the right to know what personal information we collect
          and to request its deletion. We do not sell personal information as defined by the CCPA/CPRA.
        </p>
      </>
    ),
  },
  {
    heading: "10. International data transfers",
    body: (
      <p>
        Our infrastructure and subprocessors are primarily based in the United States. If you are accessing
        gnt.ai from outside the United States, your information will be transferred to, stored, and processed
        in the United States and other countries where our subprocessors operate.
      </p>
    ),
  },
  {
    heading: "11. Children&rsquo;s privacy",
    body: (
      <p>
        gnt.ai is a business tool and is not directed at, or intended for use by, children. We do not
        knowingly collect personal information from anyone under 16.
      </p>
    ),
  },
  {
    heading: "12. Changes to this policy",
    body: (
      <p>
        We may update this policy from time to time. If we make material changes, we&rsquo;ll update the
        effective date above and, where appropriate, notify you directly.
      </p>
    ),
  },
  {
    heading: "13. Contact us",
    body: (
      <p>
        Questions about this policy, or a request to exercise any of the rights above, can be sent to{" "}
        <a href="mailto:privacy@gntai.dev" className="underline hover:text-foreground">
          privacy@gntai.dev
        </a>
        .
      </p>
    ),
  },
];

export default function PrivacyPolicyPage() {
  return (
    <div className="flex-1 flex flex-col">
      <MarketingHeader />

      <main className="flex-1 px-6 py-10 max-w-3xl w-full mx-auto sm:border-x sm:border-border flex flex-col gap-8">
        <div className="flex flex-col gap-2">
          <h1 className="font-mono text-2xl font-bold tracking-tight">Privacy Policy</h1>
          <p className="font-mono text-xs uppercase tracking-widest text-muted">Effective {EFFECTIVE_DATE}</p>
        </div>

        <div className="flex flex-col gap-10">
          {SECTIONS.map((section) => (
            <div key={section.heading} className="flex flex-col gap-3 border-t border-border pt-6">
              <h2 className="font-mono text-base font-bold">{section.heading}</h2>
              <div className="flex flex-col gap-3 text-sm text-muted leading-relaxed [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-2 [&_strong]:text-foreground [&_strong]:font-medium [&_code]:font-mono [&_code]:text-foreground [&_a]:text-foreground">
                {section.body}
              </div>
            </div>
          ))}
        </div>
      </main>

      <MarketingFooter />
    </div>
  );
}
