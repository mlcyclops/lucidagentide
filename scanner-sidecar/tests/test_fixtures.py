"""Adversarial fixture suite -- keystone #1 (P2.1). Over-tested on purpose.

Every poisoned fixture must produce at least its expected finding types; every
clean-corpus entry must produce ZERO findings (no false positives).
"""

import sys
from pathlib import Path

import pytest

# scanner.py + fixtures/ live one dir up (sidecar root).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scanner import inspect_text  # noqa: E402
from fixtures.adversarial import CLEAN_CORPUS, FIXTURES  # noqa: E402


@pytest.mark.parametrize("fx", FIXTURES, ids=[f["name"] for f in FIXTURES])
def test_poisoned_fixture_fires_expected_findings(fx):
    found_types = {f["type"] for f in inspect_text(fx["text"])}
    missing = fx["expected"] - found_types
    assert not missing, f"{fx['name']}: missing {missing}; got {found_types}"


@pytest.mark.parametrize("fx", FIXTURES, ids=[f["name"] for f in FIXTURES])
def test_every_finding_has_a_valid_shape(fx):
    for f in inspect_text(fx["text"]):
        assert set(f) >= {"type", "codepoint", "index", "severity", "name"}
        assert f["codepoint"].startswith("U+")
        assert isinstance(f["index"], int) and f["index"] >= 0
        assert f["severity"] in {"info", "low", "medium", "high", "critical"}


@pytest.mark.parametrize("text", CLEAN_CORPUS, ids=[f"clean{i}" for i in range(len(CLEAN_CORPUS))])
def test_clean_corpus_zero_false_positives(text):
    findings = inspect_text(text)
    assert findings == [], f"false positive(s) on clean text {text!r}: {findings}"


def test_corpus_is_non_trivial():
    # guard against an accidentally-empty corpus masking regressions
    assert len(FIXTURES) >= 12
    assert len(CLEAN_CORPUS) >= 10
    # every declared finding type is exercised by at least one fixture
    exercised = set().union(*(fx["expected"] for fx in FIXTURES))
    assert exercised >= {
        "zero-width",
        "unicode-tag-block",
        "bidi-control",
        "private-use-area",
        "mixed-script-homoglyph",
    }
