"""demo-P2.1 -- scan every adversarial fixture, assert detection, and assert the
clean corpus is false-positive free. Stdlib only; runs with any Python 3.11+.

Acceptance (BUILD PLAN P2.1): each expected finding fires; zero false positives
on the clean control corpus.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from scanner import SCANNER_VERSION, inspect_text
from fixtures.adversarial import CLEAN_CORPUS, FIXTURES


def main() -> int:
    # The clean corpus prints multilingual text; force UTF-8 so a cp1252 console
    # (Windows default) doesn't crash on it. Same rationale as server.py.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    except (AttributeError, ValueError):
        pass

    print(f"== demo-P2.1 :: scanner {SCANNER_VERSION} ==\n")
    failures = 0

    print(f"-- {len(FIXTURES)} poisoned fixtures (expected findings MUST fire) --")
    for fx in FIXTURES:
        findings = inspect_text(fx["text"])
        types = {f["type"] for f in findings}
        missing = fx["expected"] - types
        ok = not missing
        failures += 0 if ok else 1
        mark = "OK " if ok else "XX "
        detail = ",".join(sorted(types)) or "(none)"
        print(f"  {mark}{fx['name']:34} -> {detail}")
        if missing:
            print(f"      MISSING expected: {sorted(missing)}")

    print(f"\n-- {len(CLEAN_CORPUS)} clean controls (MUST be zero findings) --")
    for i, text in enumerate(CLEAN_CORPUS):
        findings = inspect_text(text)
        ok = len(findings) == 0
        failures += 0 if ok else 1
        mark = "OK " if ok else "XX "
        preview = (text[:40] + "...") if len(text) > 43 else text
        preview = preview.replace("\n", "\\n").replace("\r", "\\r") or "(empty)"
        print(f"  {mark}clean[{i:2}] {preview}")
        if not ok:
            print(f"      FALSE POSITIVE(S): {[f['type'] for f in findings]}")

    print()
    if failures:
        print(f"demo-P2.1 FAILED: {failures} mismatch(es)")
        return 1
    print("demo-P2.1 OK -- all fixtures detected, clean corpus false-positive free")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
