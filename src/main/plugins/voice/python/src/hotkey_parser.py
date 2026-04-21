#!/usr/bin/env python3
"""Binding-string parser for pynput global hotkeys.

Translates the human-friendly config string (e.g. ``"alt+q"``, ``"ctrl+shift+v"``,
``"f13"``) into a ``(modifiers, trigger)`` pair usable by a ``pynput.keyboard.Listener``
that tracks held keys manually.

Accepted tokens (case-insensitive, whitespace-tolerant):
  modifiers : ctrl | control, shift, alt | option, cmd | win | super | meta
  function  : f1 .. f24
  named     : enter | return, space, tab, esc | escape, backspace, delete | del,
              home, end, pageup | pgup, pagedown | pgdn, up, down, left, right,
              insert | ins
  char      : single printable ASCII character (a..z, 0..9, punctuation)

The daemon imports ``parse_binding`` at startup; this module lazy-imports pynput
so unit tests can exercise the token map without a display.
"""

from __future__ import annotations

from typing import FrozenSet, Tuple, Union

_MOD_ALIASES = {
    "ctrl": "ctrl",
    "control": "ctrl",
    "shift": "shift",
    "alt": "alt",
    "option": "alt",
    "cmd": "cmd",
    "command": "cmd",
    "win": "cmd",
    "windows": "cmd",
    "super": "cmd",
    "meta": "cmd",
}

_NAMED_KEYS = {
    "enter": "enter",
    "return": "enter",
    "space": "space",
    "tab": "tab",
    "esc": "esc",
    "escape": "esc",
    "backspace": "backspace",
    "delete": "delete",
    "del": "delete",
    "home": "home",
    "end": "end",
    "pageup": "page_up",
    "pgup": "page_up",
    "pagedown": "page_down",
    "pgdn": "page_down",
    "up": "up",
    "down": "down",
    "left": "left",
    "right": "right",
    "insert": "insert",
    "ins": "insert",
}


def _tokenize(binding: str) -> list[str]:
    parts = [p.strip().lower() for p in binding.split("+") if p.strip()]
    if not parts:
        raise ValueError(f"empty hotkey binding: {binding!r}")
    return parts


def _resolve_key(token: str):
    """Return the pynput key object for a non-modifier token."""
    from pynput import keyboard as pkb  # lazy: avoid import at test collection

    if token in _NAMED_KEYS:
        return getattr(pkb.Key, _NAMED_KEYS[token])
    if len(token) > 1 and token[0] == "f" and token[1:].isdigit():
        n = int(token[1:])
        if 1 <= n <= 24:
            name = f"f{n}"
            if hasattr(pkb.Key, name):
                return getattr(pkb.Key, name)
        raise ValueError(f"unsupported function key: {token!r}")
    if len(token) == 1:
        return pkb.KeyCode.from_char(token)
    raise ValueError(f"unknown hotkey token: {token!r}")


def _resolve_modifier(token: str):
    """Return a frozenset of pynput keys that satisfy one modifier token.

    pynput emits left/right variants (``Key.ctrl_l`` / ``Key.ctrl_r``) depending
    on which side the user pressed. Any of the variants counts as "held".
    """
    from pynput import keyboard as pkb

    canonical = _MOD_ALIASES[token]
    variants = {canonical}
    for suffix in ("_l", "_r"):
        name = canonical + suffix
        if hasattr(pkb.Key, name):
            variants.add(name)
    return frozenset(getattr(pkb.Key, v) for v in variants if hasattr(pkb.Key, v))


ParsedBinding = Tuple[FrozenSet[FrozenSet], object]


def parse_binding(binding: str) -> ParsedBinding:
    """Parse a config binding string into ``(modifier_groups, trigger)``.

    ``modifier_groups`` is a frozenset of frozensets. Each inner frozenset holds
    the acceptable variants for one modifier slot (e.g. ``{Key.ctrl, Key.ctrl_l,
    Key.ctrl_r}``). The daemon treats the hotkey as held when for every inner
    set at least one of its members is in the live ``held`` set.
    """
    tokens = _tokenize(binding)
    *mod_tokens, trigger_token = tokens

    seen: set[str] = set()
    modifier_groups: list[frozenset] = []
    for tok in mod_tokens:
        if tok not in _MOD_ALIASES:
            raise ValueError(f"not a modifier: {tok!r} (in {binding!r})")
        canonical = _MOD_ALIASES[tok]
        if canonical in seen:
            continue  # tolerate e.g. "ctrl+control+v"
        seen.add(canonical)
        modifier_groups.append(_resolve_modifier(tok))

    trigger = _resolve_key(trigger_token)
    return frozenset(modifier_groups), trigger


def modifiers_satisfied(held: "set", modifier_groups: "FrozenSet[FrozenSet]") -> bool:
    """Return True if every modifier group has at least one member in ``held``."""
    return all(bool(held & group) for group in modifier_groups)


def format_binding(binding: str) -> str:
    """Normalize spacing/case for logging. Raises ValueError for invalid input."""
    parts = _tokenize(binding)
    return "+".join(parts)


if __name__ == "__main__":  # manual smoke test: python hotkey_parser.py
    import sys

    samples = sys.argv[1:] or ["alt+q", "ctrl+shift+v", "ctrl+alt+v", "f13", "  ALT + Q  "]
    for s in samples:
        try:
            mods, trigger = parse_binding(s)
            print(f"{s!r:30}  -> mods={[sorted(str(k) for k in g) for g in mods]}  trigger={trigger}")
        except Exception as exc:
            print(f"{s!r:30}  -> ERROR: {exc}")
