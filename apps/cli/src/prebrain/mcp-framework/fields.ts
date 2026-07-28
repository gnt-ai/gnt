// The "prose only" enforcement, made structural.
//
// An MCP-in adapter declares, per structured tool, the exact set of object
// keys it reads (McpReadDeclaration.fields). This function is what turns
// that declaration into a hard boundary: given a parsed tool response, it
// returns a copy containing ONLY the declared keys, everywhere in the
// tree, with everything else dropped. The adapter's own parse code then
// runs against this stripped copy, so a field the adapter never declared
// is not merely unread -- it is gone before the adapter's code executes,
// and cannot be reached even by a mistaken `obj.email` lookup. That's the
// difference the framework guarantees over each adapter filtering by
// convention.
//
// The set is flat and applies at every depth on purpose: traversal only
// ever descends into a value whose own key was declared, so a nested
// record object (a HubSpot contact, a Linear issue's author) is dropped
// whole at its parent unless the adapter explicitly declared that
// container key. Declaring a leaf like "text" does not expose a "text"
// buried inside an undeclared object, because that object was already
// dropped one level up.

// Projects `value` down to only the keys in `allowed`, recursively.
// Arrays map element-wise; objects keep declared keys and recurse into
// their values; primitives pass through. A new structure is built -- the
// input is never mutated.
export function projectToDeclaredFields(value: unknown, allowed: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => projectToDeclaredFields(entry, allowed));
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const projected: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      if (allowed.has(key)) {
        projected[key] = projectToDeclaredFields(source[key], allowed);
      }
    }
    return projected;
  }
  return value;
}
