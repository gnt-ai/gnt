import type { Metadata } from "next";
import Link from "next/link";
import { MarketingFooter } from "@/components/marketing-footer";
import { MarketingHeader } from "@/components/marketing-header";

const TITLE = "Terms of Service · gnt.ai";
const DESCRIPTION = "The terms that govern use of gnt.ai.";

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
    heading: "1. Agreement to terms",
    body: (
      <p>
        These Terms of Service (&ldquo;Terms&rdquo;) govern your access to and use of gnt.ai (the
        &ldquo;Service&rdquo;), operated by gnt.ai (&ldquo;we,&rdquo; &ldquo;us,&rdquo; &ldquo;our&rdquo;). By
        creating an account or using the Service, you agree to these Terms on behalf of yourself and, if
        applicable, the organization you represent. If you don&rsquo;t agree, don&rsquo;t use the Service.
      </p>
    ),
  },
  {
    heading: "2. What the Service does",
    body: (
      <p>
        gnt.ai is a git-native rules-governance layer for AI agents. Your organization&rsquo;s policies and
        rules are stored as versioned files in a GitHub repository you own and control. A rule is not
        approved, and is never served to an agent, until a human on your team merges a pull request on
        GitHub. Any autonomous or agent-driven proposal the Service makes &mdash; a drafted rule, a
        refresh-or-deprecate suggestion, a flagged contradiction &mdash; is exactly that: a proposal. Nothing
        in the Service merges a pull request or approves a rule on your behalf.
      </p>
    ),
  },
  {
    heading: "3. Accounts",
    body: (
      <>
        <p>
          You must provide accurate information when creating an account and keep your credentials secure.
          You&rsquo;re responsible for all activity under your account and for the actions of any AI agent
          you authorize to act on your behalf using credentials or keys issued to your organization.
        </p>
        <p>
          You&rsquo;re responsible for configuring your connected GitHub repository&rsquo;s branch protection
          and access controls appropriately for your organization. The Service treats a merged pull request as
          proof of human review, which depends on your repository actually requiring review before merge.
        </p>
      </>
    ),
  },
  {
    heading: "4. Acceptable use",
    body: (
      <>
        <p>You agree not to:</p>
        <ul>
          <li>Use the Service to store or process content you don&rsquo;t have the right to store or process.</li>
          <li>Attempt to gain unauthorized access to another organization&rsquo;s data.</li>
          <li>Interfere with or disrupt the Service&rsquo;s infrastructure, or attempt to bypass rate limits or security controls.</li>
          <li>Use the Service to build a directly competing product using data or access obtained through it.</li>
          <li>Use the Service for any unlawful purpose.</li>
        </ul>
      </>
    ),
  },
  {
    heading: "5. Your content",
    body: (
      <>
        <p>
          You retain all rights to the rule content, source material, and other data you submit to the
          Service (&ldquo;Your Content&rdquo;). You grant us a limited license to host, process, and transmit
          Your Content solely as needed to provide the Service to you, including passing it to the
          third-party subprocessors described in our{" "}
          <Link href="/privacy" className="underline hover:text-foreground">
            Privacy Policy
          </Link>
          .
        </p>
        <p>
          You&rsquo;re responsible for Your Content and for having the rights necessary to submit it to the
          Service.
        </p>
      </>
    ),
  },
  {
    heading: "6. Subscriptions and billing",
    body: (
      <>
        <p>
          Paid plans are billed in advance on a recurring basis through Stripe. By subscribing, you authorize
          us to charge your payment method for the applicable fees. Fees are non-refundable except where
          required by law.
        </p>
        <p>
          You may cancel your subscription at any time; cancellation takes effect at the end of the current
          billing period. We may change our pricing with reasonable advance notice; continued use of the
          Service after a price change takes effect constitutes acceptance of the new pricing.
        </p>
      </>
    ),
  },
  {
    heading: "7. Third-party services and AI models",
    body: (
      <p>
        The Service relies on third-party infrastructure and AI model providers to operate, described in our{" "}
        <Link href="/privacy" className="underline hover:text-foreground">
          Privacy Policy
        </Link>
        . AI-generated output &mdash; extracted rule drafts, contradiction findings, staleness flags, and
        <code> check_action</code> verdicts &mdash; is a model-assisted estimate, not a verified fact, and may
        be incomplete or incorrect. You&rsquo;re responsible for reviewing any AI-generated proposal before it
        becomes a rule your agents rely on.
      </p>
    ),
  },
  {
    heading: "8. Intellectual property",
    body: (
      <p>
        We own the Service itself, including its software, design, and branding. These Terms don&rsquo;t
        grant you any rights to our intellectual property except the limited right to use the Service as
        described here.
      </p>
    ),
  },
  {
    heading: "9. Termination",
    body: (
      <p>
        You may stop using the Service and request account offboarding at any time. We may suspend or
        terminate your access if you materially breach these Terms and don&rsquo;t cure the breach within a
        reasonable period after notice, or immediately if necessary to protect the Service or other users. On
        termination, the data-deletion terms in our{" "}
        <Link href="/privacy" className="underline hover:text-foreground">
          Privacy Policy
        </Link>{" "}
        apply.
      </p>
    ),
  },
  {
    heading: "10. Disclaimers",
    body: (
      <p className="uppercase text-xs tracking-wide">
        The Service is provided &ldquo;as is&rdquo; and &ldquo;as available,&rdquo; without warranties of any
        kind, express or implied, including warranties of merchantability, fitness for a particular purpose,
        and non-infringement. We don&rsquo;t warrant that the Service will be uninterrupted, error-free, or
        that any AI-generated output will be accurate or complete.
      </p>
    ),
  },
  {
    heading: "11. Limitation of liability",
    body: (
      <p className="uppercase text-xs tracking-wide">
        To the maximum extent permitted by law, we won&rsquo;t be liable for any indirect, incidental,
        special, consequential, or punitive damages, or any loss of profits, revenue, data, or goodwill,
        arising from your use of the Service. Our total liability for any claim arising from these Terms or
        the Service is limited to the amount you paid us in the twelve months before the claim arose.
      </p>
    ),
  },
  {
    heading: "12. Indemnification",
    body: (
      <p>
        You agree to indemnify and hold us harmless from any claims, damages, or expenses arising from Your
        Content, your use of the Service in violation of these Terms, or your violation of any law or
        third-party right.
      </p>
    ),
  },
  {
    heading: "13. Changes to these Terms",
    body: (
      <p>
        We may update these Terms from time to time. If we make material changes, we&rsquo;ll update the
        effective date above and, where appropriate, notify you directly. Continued use of the Service after
        changes take effect constitutes acceptance of the updated Terms.
      </p>
    ),
  },
  {
    heading: "14. Governing law",
    body: (
      <p>
        These Terms are governed by the laws of the United States, without regard to conflict-of-law
        principles, except where applicable law requires otherwise.
      </p>
    ),
  },
  {
    heading: "15. Contact us",
    body: (
      <p>
        Questions about these Terms can be sent to{" "}
        <a href="mailto:legal@gntai.dev" className="underline hover:text-foreground">
          legal@gntai.dev
        </a>
        .
      </p>
    ),
  },
];

export default function TermsPage() {
  return (
    <div className="flex-1 flex flex-col">
      <MarketingHeader />

      <main className="flex-1 px-6 py-10 max-w-3xl w-full mx-auto sm:border-x sm:border-border flex flex-col gap-8">
        <div className="flex flex-col gap-2">
          <h1 className="font-mono text-2xl font-bold tracking-tight">Terms of Service</h1>
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
