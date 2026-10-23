// Focused tests for projectToDeclaredFields (mcp-framework/fields.ts):
// the function that turns an adapter's declared fields into a hard
// privacy boundary before any adapter parse code runs. framework.test.ts
// covers the basic shapes alongside the rest of the framework; this file
// pins the projection itself down at depth -- nested objects, arrays
// inside arrays, and undeclared keys dropped at every level of the tree,
// not just the top one -- so a refactor regression in the recursion is
// caught here directly, not only indirectly through an adapter suite.
import { expect, test } from "bun:test";
import { projectToDeclaredFields } from "../../../src/prebrain/mcp-framework/fields.js";

test("projectToDeclaredFields drops undeclared keys at every depth, not just the top level", () => {
  const projected = projectToDeclaredFields(
    {
      id: "page-1",
      email: "leak-top@example.com",
      profile: {
        name: "Ada",
        email: "leak-nested@example.com",
        address: {
          city: "London",
          postcode: "E1 6AN",
          email: "leak-deep@example.com",
        },
      },
    },
    new Set(["id", "profile", "name", "address", "city"]),
  );
  expect(projected).toEqual({
    id: "page-1",
    profile: { name: "Ada", address: { city: "London" } },
  });
  expect(JSON.stringify(projected)).not.toContain("leak-");
});

test("projectToDeclaredFields projects arrays element-wise, including a top-level array", () => {
  const projected = projectToDeclaredFields(
    [
      { id: "1", name: "first", email: "leak@example.com" },
      { id: "2", name: "second", internal: { id: "hidden" } },
    ],
    new Set(["id", "name"]),
  );
  expect(projected).toEqual([
    { id: "1", name: "first" },
    { id: "2", name: "second" },
  ]);
});

test("projectToDeclaredFields recurses into arrays nested inside declared keys and arrays", () => {
  const projected = projectToDeclaredFields(
    {
      rows: [
        [{ id: "1", email: "leak@example.com" }],
        [{ id: "2", name: "kept" }],
      ],
      labels: ["alpha", "beta"],
    },
    new Set(["rows", "labels", "id", "name"]),
  );
  expect(projected).toEqual({
    rows: [[{ id: "1" }], [{ id: "2", name: "kept" }]],
    labels: ["alpha", "beta"],
  });
});

test("projectToDeclaredFields drops a declared leaf buried inside an undeclared container at depth", () => {
  // "email" and "record" are declared, but "contact" -- the object
  // holding the email two levels down -- is not, so the whole contact
  // object is dropped at its parent and the leaf stays unreachable.
  const projected = projectToDeclaredFields(
    { record: { contact: { email: "leak@example.com" } } },
    new Set(["record", "email"]),
  );
  expect(projected).toEqual({ record: {} });
});

test("projectToDeclaredFields passes primitives through and keeps declared falsy values", () => {
  const allowed = new Set(["count", "flag", "note"]);
  expect(projectToDeclaredFields("plain", allowed)).toBe("plain");
  expect(projectToDeclaredFields(42, allowed)).toBe(42);
  expect(projectToDeclaredFields(true, allowed)).toBe(true);
  expect(projectToDeclaredFields(null, allowed)).toBeNull();
  expect(projectToDeclaredFields({ count: 0, flag: false, note: null }, allowed)).toEqual({
    count: 0,
    flag: false,
    note: null,
  });
});

test("projectToDeclaredFields returns empty structures when nothing is declared", () => {
  const allowed = new Set<string>();
  expect(projectToDeclaredFields({ id: "1", nested: { id: "2" } }, allowed)).toEqual({});
  expect(projectToDeclaredFields([{ id: "1" }], allowed)).toEqual([{}]);
  expect(projectToDeclaredFields([], allowed)).toEqual([]);
  expect(projectToDeclaredFields({}, allowed)).toEqual({});
});

test("projectToDeclaredFields builds a new structure and never mutates its input", () => {
  const input = {
    profile: { name: "Ada", email: "leak@example.com" },
    items: [{ id: "1", email: "leak@example.com" }],
  };
  const snapshot = JSON.parse(JSON.stringify(input)) as unknown;
  const projected = projectToDeclaredFields(input, new Set(["profile", "name", "items", "id"])) as {
    profile: unknown;
    items: unknown;
  };
  expect(input).toEqual(snapshot);
  expect(projected).toEqual({ profile: { name: "Ada" }, items: [{ id: "1" }] });
  expect(projected).not.toBe(input);
  expect(projected.profile).not.toBe(input.profile);
  expect(projected.items).not.toBe(input.items);
});
