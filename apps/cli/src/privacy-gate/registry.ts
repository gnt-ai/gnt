import type { PlaceholderKind, PrivacyGateMapping } from "./types.js";

// Assigns and remembers placeholders across all three layers of one gate
// run. Shared by reference across layers 1-3 so the same real value gets
// the same placeholder no matter which layer (or which occurrence in the
// text) finds it -- an email seen twice becomes [EMAIL_1] both times, not
// [EMAIL_1] and [EMAIL_2].
//
// Keyed on the raw value alone, not (kind, value): in practice a given
// exact substring is only ever one entity kind (an email string never also
// parses as a credit card), so this keeps the public mapping shape simple
// -- exactly "real value -> placeholder" -- rather than forcing every
// consumer to know the kind just to look a value up.
export class PlaceholderRegistry {
  private readonly counters = new Map<PlaceholderKind, number>();
  private readonly valueToPlaceholder = new Map<string, string>();
  private readonly placeholderToValue = new Map<string, string>();

  // Returns the existing placeholder for `value` if this registry has
  // already masked it, otherwise mints and remembers a new one.
  getOrCreate(kind: PlaceholderKind, value: string): string {
    const existing = this.valueToPlaceholder.get(value);
    if (existing) return existing;

    const next = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, next);
    const placeholder = `[${kind}_${next}]`;

    this.valueToPlaceholder.set(value, placeholder);
    this.placeholderToValue.set(placeholder, value);
    return placeholder;
  }

  has(value: string): boolean {
    return this.valueToPlaceholder.has(value);
  }

  // Snapshot for the public result -- copies rather than exposing the live
  // maps so nothing outside this module can mutate registry state after
  // the gate run returns.
  toMapping(): PrivacyGateMapping {
    return {
      valueToPlaceholder: new Map(this.valueToPlaceholder),
      placeholderToValue: new Map(this.placeholderToValue),
    };
  }
}
