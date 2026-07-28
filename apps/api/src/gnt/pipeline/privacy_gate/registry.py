"""Python port of apps/cli/src/privacy-gate/registry.ts. Same reasoning,
same shape -- see that file for the fuller writeup this docstring
summarizes.
"""

from __future__ import annotations

from .types import PlaceholderKind, PrivacyGateMapping


class PlaceholderRegistry:
    """Assigns and remembers placeholders across every layer of one gate
    run (and, server-side, across every field of one rule -- see
    __init__.py's mask_fields). Shared by reference so the same real value
    gets the same placeholder no matter which layer or field finds it -- an
    email seen in both a rule's title and body becomes [EMAIL_1] both
    times, not [EMAIL_1] and [EMAIL_2].

    Keyed on the raw value alone, not (kind, value): in practice a given
    exact substring is only ever one entity kind, so the public mapping
    stays exactly "real value -> placeholder" rather than forcing every
    consumer to know the kind just to look a value up.
    """

    def __init__(self) -> None:
        self._counters: dict[PlaceholderKind, int] = {}
        self._value_to_placeholder: dict[str, str] = {}
        self._placeholder_to_value: dict[str, str] = {}

    def get_or_create(self, kind: PlaceholderKind, value: str) -> str:
        """Returns the existing placeholder for `value` if this registry
        has already masked it, otherwise mints and remembers a new one."""
        existing = self._value_to_placeholder.get(value)
        if existing:
            return existing

        next_n = self._counters.get(kind, 0) + 1
        self._counters[kind] = next_n
        placeholder = f"[{kind}_{next_n}]"

        self._value_to_placeholder[value] = placeholder
        self._placeholder_to_value[placeholder] = value
        return placeholder

    def has(self, value: str) -> bool:
        return value in self._value_to_placeholder

    def to_mapping(self) -> PrivacyGateMapping:
        """Snapshot for the public result -- copies rather than exposing
        the live dicts so nothing outside this module can mutate registry
        state after the gate run returns."""
        return PrivacyGateMapping(
            value_to_placeholder=dict(self._value_to_placeholder),
            placeholder_to_value=dict(self._placeholder_to_value),
        )
