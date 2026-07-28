// Dedicated unit tests for adf-to-text.ts's ADF-to-plain-text conversion --
// mcp-jira.ts's own test file exercises this indirectly through a full
// walk; these tests check the conversion itself against a realistic ADF
// fixture (nested paragraphs, a mention node, a code block, a link),
// proving it degrades to sensible plain text and drops non-text metadata
// (a mentioned user's account id) rather than only checking it doesn't
// throw.
import { expect, test } from "bun:test";
import { adfToPlainText } from "../../src/prebrain/adf-to-text.js";

// A realistic Jira issue description: two paragraphs (the second containing
// a mention and a link), then a code block -- the shape the task's own
// checklist asks this fixture to cover.
const ADF_FIXTURE = {
  type: "doc",
  version: 1,
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Refunds over $500 require manager approval, per " },
        {
          type: "text",
          text: "the finance runbook",
          marks: [{ type: "link", attrs: { href: "https://wiki.example.com/finance/runbook" } }],
        },
        { type: "text", text: "." },
      ],
    },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Assigned to " },
        {
          type: "mention",
          attrs: { id: "557058:11111111-2222-3333-4444-555555555555", text: "@Jane Doe" },
        },
        { type: "text", text: " for review." },
      ],
    },
    {
      type: "codeBlock",
      attrs: { language: "bash" },
      content: [{ type: "text", text: "curl -X POST /refunds --data amount=500" }],
    },
  ],
};

test("converts nested paragraphs, a mention, a code block, and a link into readable plain text", () => {
  const text = adfToPlainText(ADF_FIXTURE);

  expect(text).toContain("Refunds over $500 require manager approval");
  expect(text).toContain("[the finance runbook](https://wiki.example.com/finance/runbook)");
  expect(text).toContain("Assigned to @Jane Doe for review.");
  expect(text).toContain("```");
  expect(text).toContain("curl -X POST /refunds --data amount=500");
});

test("drops the mentioned user's account id -- only the display name survives", () => {
  const text = adfToPlainText(ADF_FIXTURE);
  expect(text).not.toContain("557058:11111111-2222-3333-4444-555555555555");
});

test("a plain string input passes through trimmed, unchanged", () => {
  expect(adfToPlainText("  Already markdown, no ADF here.  ")).toBe("Already markdown, no ADF here.");
});

test("null/undefined/non-object input renders to an empty string", () => {
  expect(adfToPlainText(null)).toBe("");
  expect(adfToPlainText(undefined)).toBe("");
  expect(adfToPlainText(42)).toBe("");
});

test("media nodes render to nothing -- their attrs (file id, collection) never surface", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "See attached:" }] },
      {
        type: "mediaSingle",
        content: [{ type: "media", attrs: { id: "media-abc123", type: "file", collection: "issue-uploads" } }],
      },
    ],
  };
  const text = adfToPlainText(doc);
  expect(text).toContain("See attached:");
  expect(text).not.toContain("media-abc123");
  expect(text).not.toContain("issue-uploads");
});

test("bullet lists and headings render with markdown-shaped structure", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Rollout steps" }] },
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Ship to staging" }] }] },
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Notify on-call" }] }] },
        ],
      },
    ],
  };
  const text = adfToPlainText(doc);
  expect(text).toContain("## Rollout steps");
  expect(text).toContain("- Ship to staging");
  expect(text).toContain("- Notify on-call");
});

test("an unrecognized node type still yields its nested text instead of dropping the node whole", () => {
  const doc = {
    type: "doc",
    content: [{ type: "someFutureNodeType", content: [{ type: "text", text: "Still readable." }] }],
  };
  expect(adfToPlainText(doc)).toBe("Still readable.");
});
