// Layer 1 (deterministic detectors) tests. Each detector gets a true-
// positive case and at least one false-positive-avoidance case, per the
// task's own bar: layer 1 must not be trigger-happy on plain numbers and
// percentages ("discounts over 15%", "orders over $50") even though full
// policy-vs-PII discrimination is a later task (1.2), not this one's job.
import { expect, test } from "bun:test";
import { PlaceholderRegistry } from "../../src/privacy-gate/registry.js";
import { runDeterministicLayer } from "../../src/privacy-gate/layer1-deterministic.js";

function run(text: string) {
  return runDeterministicLayer(text, new PlaceholderRegistry());
}

// -- API keys / tokens --

test("masks a vendor-prefixed OpenAI/Anthropic-style secret key", () => {
  const result = run("key: sk-proj-abc123DEF456ghi789JKL012"); // gitleaks:allow
  expect(result.text).toContain("[KEY_1]");
  expect(result.hits).toHaveLength(1);
  expect(result.hits[0]?.kind).toBe("KEY");
});

test("masks a GitHub classic personal access token", () => {
  const result = run("token=ghp_16C7e42F292c6912E7710c838347Ae178B4a"); // gitleaks:allow
  expect(result.text).toBe("token=[KEY_1]");
});

test("masks a GitHub fine-grained PAT", () => {
  const result = run("github_pat_11AAAAAAA0aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  expect(result.text).toContain("[KEY_1]");
});

test("masks a Slack bot token", () => {
  const result = run("SLACK_TOKEN=xoxb-1234567890-abcdefghijklmnop"); // gitleaks:allow
  expect(result.text).toContain("[KEY_1]");
});

test("masks an AWS access key ID", () => {
  const result = run("aws_access_key_id = AKIAIOSFODNN7EXAMPLE");
  expect(result.text).toContain("[KEY_1]");
});

test("masks a generic high-entropy token with no known vendor prefix", () => {
  const result = run("internal token: 7f9a8b3c1d2e4f5a6b7c8d9e0f1a2b3c4d5e6f7a"); // gitleaks:allow
  expect(result.text).toContain("[KEY_1]");
});

test("does not mask an ordinary long capitalized phrase as a key", () => {
  const result = run("the quarterly engineering all hands retrospective document");
  expect(result.hits.filter((h) => h.kind === "KEY")).toHaveLength(0);
});

test("does not mask a long hyphenated slug with no digits as a key", () => {
  const result = run("see the customer-facing-refund-policy-overview page");
  expect(result.hits.filter((h) => h.kind === "KEY")).toHaveLength(0);
});

// -- Credit cards (Luhn) --

test("masks a Luhn-valid card number with space grouping", () => {
  const result = run("Card 4242 4242 4242 4242 was charged.");
  expect(result.text).toBe("Card [CREDIT_CARD_1] was charged.");
});

test("masks a Luhn-valid card number with dash grouping", () => {
  const result = run("4242-4242-4242-4242");
  expect(result.text).toBe("[CREDIT_CARD_1]");
});

test("does not mask a 16-digit run that fails the Luhn checksum", () => {
  const result = run("reference number 1234 5678 9012 3456 on file");
  expect(result.hits.filter((h) => h.kind === "CREDIT_CARD")).toHaveLength(0);
});

test("does not mask a plain dollar amount", () => {
  const result = run("Orders over $50 get free shipping.");
  expect(result.text).toBe("Orders over $50 get free shipping.");
});

// -- SSNs --

test("masks a valid-shaped SSN", () => {
  const result = run("SSN: 078-05-1120");
  expect(result.text).toBe("SSN: [SSN_1]");
});

test("does not mask an SSN with the invalid 000 area number", () => {
  const result = run("ref 000-12-3456");
  expect(result.hits.filter((h) => h.kind === "SSN")).toHaveLength(0);
});

test("does not mask an SSN with the invalid 666 area number", () => {
  const result = run("ref 666-12-3456");
  expect(result.hits.filter((h) => h.kind === "SSN")).toHaveLength(0);
});

test("does not mask an SSN with an area number in the reserved 900-999 ITIN range", () => {
  const result = run("ref 912-12-3456");
  expect(result.hits.filter((h) => h.kind === "SSN")).toHaveLength(0);
});

test("does not mask an SSN-shaped number with a 00 group", () => {
  const result = run("ref 123-00-4567");
  expect(result.hits.filter((h) => h.kind === "SSN")).toHaveLength(0);
});

test("does not mask an SSN-shaped number with a 0000 serial", () => {
  const result = run("ref 123-45-0000");
  expect(result.hits.filter((h) => h.kind === "SSN")).toHaveLength(0);
});

test("does not mask a plain percentage as an SSN or a card", () => {
  const result = run("Policy: discounts over 15% need sign-off.");
  expect(result.text).toBe("Policy: discounts over 15% need sign-off.");
});

// -- Emails --

test("masks a normal email address", () => {
  const result = run("Contact jane.smith+billing@acme.co.uk for details.");
  expect(result.text).toBe("Contact [EMAIL_1] for details.");
});

test("masks the same email the same way every time it appears", () => {
  const result = run("From: jane@acme.com. Reply to jane@acme.com only.");
  expect(result.text).toBe("From: [EMAIL_1]. Reply to [EMAIL_1] only.");
  expect(result.hits.filter((h) => h.kind === "EMAIL")).toHaveLength(2);
});

// -- Phone numbers --

test("masks a US phone number with dashes", () => {
  const result = run("Call 555-123-4567 for support.");
  expect(result.text).toBe("Call [PHONE_1] for support.");
});

test("masks a US phone number with parens and a leading country code", () => {
  const result = run("+1 (555) 123-4567");
  expect(result.text).toBe("[PHONE_1]");
});

test("masks an international phone number", () => {
  const result = run("+44 20 7946 0958");
  expect(result.text).toBe("[PHONE_1]");
});

test("does not mask a bare short number as a phone number", () => {
  const result = run("Orders over $50 get free shipping.");
  expect(result.hits.filter((h) => h.kind === "PHONE")).toHaveLength(0);
});

// -- IPs --

test("masks a public IPv4 address", () => {
  const result = run("DNS is 8.8.8.8");
  expect(result.text).toBe("DNS is [IP_1]");
});

// Private/loopback ranges get masked too -- see the reasoning documented
// directly above detectIps() in layer1-deterministic.ts. They're not PII,
// but this gate runs entirely on the customer's own device before
// anything reaches a cloud model, so treating internal network topology as
// sensitive-by-default costs a placeholder, not a leak.
test("masks a private IPv4 address the same as a public one", () => {
  const result = run("internal host is 10.0.0.5");
  expect(result.text).toBe("internal host is [IP_1]");
});

test("masks a loopback address", () => {
  const result = run("bound to 127.0.0.1");
  expect(result.text).toBe("bound to [IP_1]");
});

test("does not mask an invalid IPv4-shaped number", () => {
  const result = run("version 999.999.999.999 does not exist");
  expect(result.hits.filter((h) => h.kind === "IP")).toHaveLength(0);
});

test("masks a full IPv6 address", () => {
  const result = run("route to 2001:0db8:85a3:0000:0000:8a2e:0370:7334");
  expect(result.text).toBe("route to [IP_1]");
});

test("masks a compressed IPv6 loopback address", () => {
  const result = run("bound to ::1");
  expect(result.text).toBe("bound to [IP_1]");
});

// -- Cross-cutting --

test("assigns a distinct placeholder per distinct value within a kind", () => {
  const result = run("Emails: a@example.com and b@example.com.");
  expect(result.text).toBe("Emails: [EMAIL_1] and [EMAIL_2].");
});

test("a realistic policy sentence with numbers and percentages is left untouched", () => {
  const text = "Refunds over 15% require manager sign-off. Orders over $50 ship free within 3 days.";
  const result = run(text);
  expect(result.text).toBe(text);
  expect(result.hits).toHaveLength(0);
});
