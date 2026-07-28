// No GNT_CONFIG_DIR dance needed here (unlike gaps.test.ts/logout.test.ts)
// -- collectCompanyProfile takes its Ask function as a parameter and never
// touches credentials.ts, ~/.gnt/, or the network, so there's nothing to
// sandbox against a real user's machine.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Ask, CompanyProfile } from "../src/prebrain/profile.js";
import { collectCompanyProfile } from "../src/prebrain/profile.js";

let originalLog: typeof console.log;

beforeEach(() => {
  originalLog = console.log;
  console.log = () => {};
});

afterEach(() => {
  console.log = originalLog;
});

// Builds an Ask that hands back answers from a fixed queue in order, and
// fails the test loudly if collectCompanyProfile asks more questions than
// the queue has answers for -- that mismatch is itself a signal (e.g. the
// primary-function follow-up firing when it shouldn't have).
function scriptedAsk(answers: string[]): Ask {
  const queue = [...answers];
  return async () => {
    if (queue.length === 0) throw new Error("scriptedAsk: ran out of scripted answers");
    return queue.shift() as string;
  };
}

test("a full run through all questions produces a correctly-shaped CompanyProfile", async () => {
  const ask = scriptedAsk([
    "We do fraud detection for fintechs.", // description
    "1, 3", // agentFunctions: customer_support, engineering
    "2", // primaryFunction, picking from [customer_support, engineering] -> engineering
    "2", // decisionSource -> wiki
  ]);

  const profile = await collectCompanyProfile(ask);

  expect(profile).toEqual({
    description: "We do fraud detection for fintechs.",
    agentFunctions: ["customer_support", "engineering"],
    primaryFunction: "engineering",
    decisionSource: "wiki",
  });
});

test("blank answers default sensibly and skip the primary-function follow-up", async () => {
  const ask = scriptedAsk([
    "", // description -- free text, blank is a valid answer
    "", // agentFunctions -- blank means none picked
    // no primaryFunction answer queued -- must not be asked when 0 functions are picked
    "", // decisionSource -- blank falls back to "other"
  ]);

  const profile = await collectCompanyProfile(ask);

  expect(profile.description).toBe("");
  expect(profile.agentFunctions).toEqual([]);
  expect(profile.primaryFunction).toBeNull();
  expect(profile.decisionSource).toBe("other");
});

test("a single picked function skips the primary-function follow-up and becomes primary automatically", async () => {
  const ask = scriptedAsk([
    "Ticketing software.",
    "4", // agentFunctions -- finance_billing only
    // no primaryFunction answer queued
    "1", // decisionSource -> slack
  ]);

  const profile = await collectCompanyProfile(ask);

  expect(profile.agentFunctions).toEqual(["finance_billing"]);
  expect(profile.primaryFunction).toBe("finance_billing");
  expect(profile.decisionSource).toBe("slack");
});

test("out-of-range and non-numeric tokens in a multi-select answer are dropped, not rejected", async () => {
  const ask = scriptedAsk([
    "Dev tools.",
    "1, 9, x, 3", // 9 is out of range, x is non-numeric -- both dropped
    "1",
    "3",
  ]);

  const profile = await collectCompanyProfile(ask);

  expect(profile.agentFunctions).toEqual(["customer_support", "engineering"]);
  expect(profile.decisionSource).toBe("tribal_knowledge");
});

test("an out-of-range primary-function pick falls back to the first picked function", async () => {
  const ask = scriptedAsk([
    "Support tooling.",
    "1, 2", // customer_support, sales
    "99", // out of range -- falls back to the first picked function
    "4",
  ]);

  const profile = await collectCompanyProfile(ask);

  expect(profile.primaryFunction).toBe("customer_support");
});

// Runtime shape check: the exported CompanyProfile contract has exactly
// these four fields, of these types, regardless of which branch produced
// it. Later tasks (extraction tagging, starter-pack filtering) build
// against this shape directly, so a silent field rename or addition here
// should fail a test, not surface as a runtime surprise downstream.
test("CompanyProfile's shape is stable: exactly these four fields, with these types", async () => {
  const ask = scriptedAsk(["Anything.", "1", "1"]);
  const profile: CompanyProfile = await collectCompanyProfile(ask);

  expect(Object.keys(profile).sort()).toEqual([
    "agentFunctions",
    "decisionSource",
    "description",
    "primaryFunction",
  ]);
  expect(typeof profile.description).toBe("string");
  expect(Array.isArray(profile.agentFunctions)).toBe(true);
  expect(profile.primaryFunction === null || typeof profile.primaryFunction === "string").toBe(true);
  expect(typeof profile.decisionSource).toBe("string");
});
