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

# A Greek/Cyrillic letter mixed into a Latin token is only a homoglyph SPOOF when that
# specific codepoint is a genuine Latin look-alike. Non-confusable letters (Δ Σ Π Λ Φ Ψ Ω
# Γ Θ Ξ λ μ π θ σ φ …) are ordinary math/scientific notation and MUST NOT be flagged —
# "Δv", "5μm", "Σλ" are not attacks. This set is the Latin-confusable subset only; it
# preserves real spoof detection (Cyrillic 'а' in "pаypаl", Greek omicron in "lοgin")
# while letting legitimate scientific Unicode through. (The gate additionally treats
# homoglyph-only hits in the model's OWN tool content as non-blocking — see ADR-0019.)
_LATIN_CONFUSABLE = frozenset(
    {
        # Greek capitals that mirror Latin capitals (A B E Z H I K M N O P T Y X)
        0x0391, 0x0392, 0x0395, 0x0396, 0x0397, 0x0399, 0x039A, 0x039C,
        0x039D, 0x039F, 0x03A1, 0x03A4, 0x03A5, 0x03A7,
        # Greek lowercase look-alikes: omicron→o, nu→v, rho→p, lunate sigma→c, gamma→y
        0x03BF, 0x03BD, 0x03C1, 0x03F2, 0x03B3,
        # Cyrillic capitals that mirror Latin (A B E K M H O P C T Y X, plus S J)
        0x0410, 0x0412, 0x0415, 0x041A, 0x041C, 0x041D, 0x041E, 0x0420,
        0x0421, 0x0422, 0x0423, 0x0425, 0x0405, 0x0408,
        # Cyrillic lowercase look-alikes: a e o p c y x s i j
        0x0430, 0x0435, 0x043E, 0x0440, 0x0441, 0x0443, 0x0445, 0x0455,
        0x0456, 0x0458,
    }
)


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
                # Only a genuine Latin look-alike is a spoof; non-confusable math/
                # scientific letters (Δ Σ λ μ π …) mixed with Latin are legitimate.
                if ord(text[idx]) not in _LATIN_CONFUSABLE:
                    continue
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
