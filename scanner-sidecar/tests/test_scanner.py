"""Scanner correctness -- keystone #1 (CLAUDE.md). Over-tested on purpose.

Every adversarial character is constructed via chr(0x....) so this source stays
fully inspectable -- there are NO literal invisible characters anywhere in the
file. (Eating our own dogfood: a prompt-injection-defense project must not ship
invisible characters in its own test sources.)
"""

import sys
from pathlib import Path

# scanner.py lives one dir up (sidecar root), not installed as a package.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scanner import inspect_text  # noqa: E402

ZWSP = chr(0x200B)  # ZERO WIDTH SPACE
ZWNJ = chr(0x200C)  # ZERO WIDTH NON-JOINER
ZWJ = chr(0x200D)  # ZERO WIDTH JOINER
WJ = chr(0x2060)  # WORD JOINER
BOM = chr(0xFEFF)  # ZERO WIDTH NO-BREAK SPACE
RLO = chr(0x202E)  # RIGHT-TO-LEFT OVERRIDE
TAG_A = chr(0xE0041)  # TAG LATIN CAPITAL LETTER A
PUA = chr(0xE000)  # PRIVATE USE AREA (first BMP PUA codepoint)


# -- clean control corpus: MUST produce zero findings (no false positives) --
CLEAN = [
    "",
    "hello world",
    "def edit_file(path: str) -> None: ...",
    "Unicode: café, naïve, Zürich, emoji " + chr(0x1F389) + ", math ∑∫√",
    "Multi\nline\ttext with\r\n CRLF and tabs",
    "Numbers 1234567890 and symbols !@#$%^&*()_+-=[]{}",
]


def test_clean_corpus_has_zero_findings():
    for s in CLEAN:
        assert inspect_text(s) == [], f"false positive on clean string: {s!r}"


def test_zero_width_detected():
    s = f"edit{ZWSP}file"  # ZWSP smuggled between visible tokens
    findings = inspect_text(s)
    f = next(f for f in findings if f["type"] == "zero-width")
    assert f["codepoint"] == "U+200B"
    assert f["index"] == 4
    assert f["severity"] == "high"


def test_all_zero_width_variants_detected():
    for cp in (ZWSP, ZWNJ, ZWJ, WJ, BOM):
        findings = inspect_text(f"a{cp}b")
        assert any(f["type"] == "zero-width" for f in findings), f"missed {cp!r}"


def test_unicode_tag_block_detected():
    s = f"look{TAG_A}here"  # invisible Tag-block instruction smuggling
    findings = inspect_text(s)
    f = next(f for f in findings if f["type"] == "unicode-tag-block")
    assert f["severity"] == "critical"


def test_bidi_override_detected():
    s = f"user{RLO}gnp.txt"  # RLO: displayed text differs from logical text
    findings = inspect_text(s)
    f = next(f for f in findings if f["type"] == "bidi-control")
    assert f["severity"] == "high"


def test_private_use_area_detected():
    s = f"tag{PUA}end"
    findings = inspect_text(s)
    assert any(f["type"] == "private-use-area" for f in findings)


def test_findings_carry_required_fields():
    f = inspect_text(f"a{ZWSP}b")[0]
    assert set(f) >= {"type", "codepoint", "index", "severity", "name"}
    assert f["codepoint"].startswith("U+")
    assert isinstance(f["index"], int)
