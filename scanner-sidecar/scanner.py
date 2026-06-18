"""Pure Unicode prompt-injection scanner.

The ONLY Python in the harness (CLAUDE.md invariant #2). Pure function:
text in -> findings out. No state, no I/O, no network. This is the single
safest thing to put across a process boundary (DECISIONS.md ADR-0001): if it
dies, the TS gate sees "no scan result" and fails closed.

Finding `type` values MUST stay in lockstep with FINDING_TYPES in
harness/contracts.ts (the frozen IPC contract, ADR-0002).

Increment 0 / P2.1 baseline covers: zero-width, Unicode Tag block, bidi
controls, private-use-area, and other format (Cf) characters. Mixed-script /
homoglyph detection ("mixed-script-homoglyph") is reserved for P2.1 and is not
emitted yet.
"""

from __future__ import annotations

import unicodedata

SCANNER_VERSION = "0.2.0"

# Bidirectional control / override characters by canonical name.
BIDI_NAMES = {
    "LEFT-TO-RIGHT OVERRIDE",
    "RIGHT-TO-LEFT OVERRIDE",
    "LEFT-TO-RIGHT EMBEDDING",
    "RIGHT-TO-LEFT EMBEDDING",
    "POP DIRECTIONAL FORMATTING",
    "LEFT-TO-RIGHT ISOLATE",
    "RIGHT-TO-LEFT ISOLATE",
    "FIRST STRONG ISOLATE",
    "POP DIRECTIONAL ISOLATE",
}

# Zero-width / invisible joiners and marks that smuggle structure between
# visible glyphs. (Subset of category Cf, called out for a precise finding type.)
ZERO_WIDTH = {
    0x200B,  # ZERO WIDTH SPACE
    0x200C,  # ZERO WIDTH NON-JOINER
    0x200D,  # ZERO WIDTH JOINER
    0x2060,  # WORD JOINER
    0xFEFF,  # ZERO WIDTH NO-BREAK SPACE / BOM
    0x180E,  # MONGOLIAN VOWEL SEPARATOR
}

# severity per finding type (strings MUST match SEVERITIES in contracts.ts)
_SEVERITY = {
    "unicode-tag-block": "critical",
    "bidi-control": "high",
    "zero-width": "high",
    "mixed-script-homoglyph": "high",
    "private-use-area": "medium",
    "unicode-category-cf": "medium",
}

# Scripts that are visually confusable with Latin and are the classic homoglyph
# spoofing vectors. We flag a token ONLY when Latin is mixed with one of these
# WITHIN a single word. This is deliberately narrow: legitimate multilingual text
# (Japanese mixing Hiragana/Katakana/Kanji, Arabic+Latin, pure-Cyrillic Russian)
# mixes scripts too, but not Latin-with-Cyrillic/Greek inside one token. Widening
# the confusable set (Cherokee, Coptic, fullwidth, ...) is a future enhancement.
_HOMOGLYPH_PRONE = {"CYRILLIC", "GREEK"}


def _classify(code: int, name: str, cat: str) -> str | None:
    """Return a FindingType string, or None if the character is unremarkable."""
    if 0xE0000 <= code <= 0xE007F:
        return "unicode-tag-block"
    if code in ZERO_WIDTH:
        return "zero-width"
    if name in BIDI_NAMES:
        return "bidi-control"
    # Private use areas (BMP + supplementary planes).
    if (0xE000 <= code <= 0xF8FF) or (0xF0000 <= code <= 0xFFFFD) or (0x100000 <= code <= 0x10FFFD):
        return "private-use-area"
    # Any remaining "format" character is suspicious in prompt-bearing text.
    if cat == "Cf":
        return "unicode-category-cf"
    return None


def _script_of(ch: str) -> str | None:
    """Best-effort script tag for a letter, derived from its Unicode name
    (e.g. "CYRILLIC SMALL LETTER IE" -> "CYRILLIC"). Non-letters return None."""
    if not unicodedata.category(ch).startswith("L"):
        return None
    name = unicodedata.name(ch, "")
    if not name:
        return None
    return name.split(" ", 1)[0]


def _iter_letter_tokens(text: str):
    """Yield (start_index, token_str) for maximal runs of letters/marks."""
    start = None
    for i, ch in enumerate(text):
        is_wordch = unicodedata.category(ch)[0] in ("L", "M")
        if is_wordch and start is None:
            start = i
        elif not is_wordch and start is not None:
            yield start, text[start:i]
            start = None
    if start is not None:
        yield start, text[start:]


def _detect_homoglyphs(text: str) -> list[dict]:
    """Flag tokens that mix Latin with a homoglyph-prone script (Cyrillic/Greek).
    One finding per smuggled (non-Latin, prone-script) character."""
    findings: list[dict] = []
    for start, token in _iter_letter_tokens(text):
        scripts: dict[str, list[int]] = {}
        for j, ch in enumerate(token):
            s = _script_of(ch)
            if s:
                scripts.setdefault(s, []).append(start + j)
        if "LATIN" not in scripts:
            continue
        for prone in _HOMOGLYPH_PRONE & scripts.keys():
            for idx in scripts[prone]:
                ch = text[idx]
                findings.append(
                    {
                        "type": "mixed-script-homoglyph",
                        "codepoint": f"U+{ord(ch):04X}",
                        "index": idx,
                        "severity": _SEVERITY["mixed-script-homoglyph"],
                        "name": unicodedata.name(ch, "<unnamed>"),
                    }
                )
    return findings


def inspect_text(text: str) -> list[dict]:
    """Scan `text`; return a list of finding dicts, sorted by index.

    Each finding: {type, codepoint, index, severity, name}.
    `index` is the Python character offset; `codepoint` is "U+XXXX".
    """
    findings: list[dict] = []
    # pass 1: per-character classification (invisible / control / out-of-band)
    for i, ch in enumerate(text):
        code = ord(ch)
        cat = unicodedata.category(ch)
        name = unicodedata.name(ch, "<unnamed>")
        ftype = _classify(code, name, cat)
        if ftype is None:
            continue
        findings.append(
            {
                "type": ftype,
                "codepoint": f"U+{code:04X}",
                "index": i,
                "severity": _SEVERITY[ftype],
                "name": name,
            }
        )
    # pass 2: token-level mixed-script / homoglyph spoofing
    findings.extend(_detect_homoglyphs(text))
    findings.sort(key=lambda f: f["index"])
    return findings
