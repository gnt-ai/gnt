// gnt init: the actual fix for the cold-start gap the README's own
// quickstart has -- `gnt connect github` -> `gnt prebrain` assumes there's
// already decision-prose somewhere in --docs/--notion/etc. for prebrain to
// extract from. A brand-new repo has none of that on day one. This command
// scaffolds rules/ locally with a couple of example files so there's
// something real to look at and edit immediately, then points at
// `gnt prebrain --starter-packs` as the actual way to get real, approved
// rules -- these scaffolded files are local drafts only, never submitted
// anywhere, so nothing here needs an API key or a GitHub connection to run.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listStarterPackIds } from "../prebrain/starter-packs/index.js";
import { bold, dim, fail, muted, ok, text } from "../theme.js";

interface ExampleRule {
  slug: string;
  title: string;
  tags: string[];
  body: string;
}

// Same pair the README's own quickstart already shows under "your-repo/
// rules/" -- so a reader who scaffolds locally sees the exact files the
// docs already promised, not a different example invented here.
const EXAMPLE_RULES: ExampleRule[] = [
  {
    slug: "refund-approval-threshold",
    title: "Refund approval threshold",
    tags: ["refunds", "finance"],
    body: "Refunds over $500 need manager sign-off before they go out. Adjust the threshold and the approval chain to match your own policy -- this is a starting point, not a stated fact about your company.",
  },
  {
    slug: "contract-legal-cc",
    title: "CC legal on contract mentions",
    tags: ["legal", "contracts"],
    body: "Any outbound message that mentions a contract, MSA, or NDA gets legal CC'd before it sends. Edit this to match who actually needs to be looped in at your org.",
  },
];

// Mirrors apps/api/src/gnt/github/render.py's render_rule_markdown field
// set and order, so a scaffolded file reads as the same shape a real
// approved rule file eventually takes. status stays "draft" and
// owner_id/approved_by/approved_at/pr_number/pr_url stay null rather than
// faked -- these files never went through create/submit/approve, only
// `gnt prebrain --starter-packs`/`gnt prebrain` (via propose_rule/
// batch_propose_rules) actually gets a rule to "approved".
function renderExampleRule(rule: ExampleRule): string {
  const frontmatter = [
    `title: ${rule.title}`,
    "status: draft",
    "confidence: 0.5",
    "owner_id: null",
    "source_citations: []",
    "source: gnt init example",
    `tags: [${rule.tags.join(", ")}]`,
    "last_validated_at: null",
    "version: 1",
    "superseded_by: null",
    "previous_version_id: null",
    "approved_by: null",
    "approved_at: null",
    `created_at: ${new Date().toISOString()}`,
    "pr_number: null",
    "pr_url: null",
  ].join("\n");
  return `---\n${frontmatter}\n---\n\n${rule.body}\n`;
}

export interface InitOptions {
  dir?: string;
}

export function init(options: InitOptions = {}): void {
  const rulesDir = join(options.dir ?? process.cwd(), "rules");
  mkdirSync(rulesDir, { recursive: true });

  const written: string[] = [];
  const skipped: string[] = [];
  for (const rule of EXAMPLE_RULES) {
    const path = join(rulesDir, `${rule.slug}.md`);
    if (existsSync(path)) {
      skipped.push(`rules/${rule.slug}.md`);
      continue;
    }
    writeFileSync(path, renderExampleRule(rule));
    written.push(`rules/${rule.slug}.md`);
  }

  if (written.length > 0) {
    console.log(ok(`Scaffolded ${written.length} example rule${written.length === 1 ? "" : "s"}:`));
    for (const path of written) console.log(`  ${dim(path)}`);
  }
  if (skipped.length > 0) {
    console.log(fail(`Already exists, left untouched: ${skipped.join(", ")}`));
  }

  console.log();
  console.log(text("These are local, unapproved drafts, not real rules yet -- edit them to see the shape, then:"));
  console.log(
    `  ${muted("run")} ${bold("gnt connect github")} ${muted("(if you haven't) and")} ${bold("gnt prebrain --starter-packs <id>")} ${muted("for a curated pack --")}`,
  );
  console.log(`  ${muted("available packs:")} ${text(listStarterPackIds().join(", "))}`);
  console.log(`  ${muted("or")} ${bold("gnt prebrain")} ${muted("once you have real docs/notes for it to scan")}`);
}
