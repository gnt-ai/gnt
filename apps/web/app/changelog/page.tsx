import type { Metadata } from "next";
import { MarketingFooter } from "@/components/marketing-footer";
import { MarketingHeader } from "@/components/marketing-header";
import packageJson from "../../package.json";

const TITLE = "Changelog · gnt.ai";
const DESCRIPTION = "What's new in gnt.ai.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { type: "website", title: TITLE, description: DESCRIPTION },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

type Entry = { version: string; date: string; body: string };

const ENTRIES: Entry[] = [
  {
    version: packageJson.version,
    date: "Jul 23, 2026",
    body: "Connecting GitHub no longer asks for a personal access token: gnt connect github now installs a GitHub App scoped to just your rules repo, with tokens that expire hourly instead of a long-lived PAT sitting in our database. The old flow stays available behind --pat. Also new: connect GitHub straight from Organization settings in the browser, and a rebuilt account area that keeps the sidebar put while you switch tabs.",
  },
  {
    version: "0.2.0",
    date: "Jul 19, 2026",
    body: "A dozen new ways to get rules in: prebrain now reads straight from Linear, Jira, Sentry, Figma, Datadog, GitLab, HubSpot, and Airtable, on top of Notion and monday.com. Zendesk and Intercom sync on a nightly schedule in the background instead of through prebrain, since their content changes on its own. OpenClaw and Hermes Agent can now connect straight to the MCP endpoint too, with a skill that teaches check_action before every action.",
  },
  {
    version: "0.1.0",
    date: "Jul 11, 2026",
    body: "New public site. Real documentation with all five MCP tools and working examples, and this changelog starts here. Landing page rebuilt around one idea: connect the endpoint, everything else happens in your terminal.",
  },
];

export default function ChangelogPage() {
  return (
    <div className="flex-1 flex flex-col">
      <MarketingHeader />

      <main className="flex-1 px-6 py-10 max-w-3xl w-full mx-auto sm:border-x sm:border-border flex flex-col gap-10">
        <h1 className="font-mono text-2xl font-bold tracking-tight">Changelog</h1>

        <div className="flex flex-col gap-10">
          {ENTRIES.map((entry) => (
            <div key={entry.version} className="flex flex-col gap-2 border-t border-border pt-6">
              <div className="flex items-baseline gap-3 font-mono text-xs uppercase tracking-widest text-muted">
                <span className="text-foreground">v{entry.version}</span>
                <span>{entry.date}</span>
              </div>
              <p className="text-sm text-muted leading-relaxed">{entry.body}</p>
            </div>
          ))}
        </div>
      </main>

      <MarketingFooter />
    </div>
  );
}
