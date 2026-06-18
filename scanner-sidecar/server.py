"""NDJSON stdin/stdout server for the Unicode scanner (ADR-0002 IPC contract).

One request line in -> one response line out. Long-lived process (one per
harness session) to avoid per-scan Python startup cost.

Request : {"id": str, "text": str, "policy"?: {...}}
Response: {"id": str, "findings": [Finding...], "scanner_version": str}
Error   : {"id": str|null, "error": str}   (TS gate maps this to BLOCK)

Design rule (DECISIONS.md ADR-0001 / CLAUDE.md #3): this process never decides
"safe". It only reports findings or reports an error. ALL fail-closed logic
lives on the TS side, which treats any missing/malformed/absent response as
"block / quarantine". So here we simply: parse, scan, emit — and never crash
the loop on a single bad line.
"""

from __future__ import annotations

import json
import sys

from scanner import SCANNER_VERSION, inspect_text


def _handle(line: str) -> dict:
    try:
        req = json.loads(line)
    except (json.JSONDecodeError, ValueError) as exc:
        return {"id": None, "error": f"invalid-json: {exc}"}

    if not isinstance(req, dict):
        return {"id": None, "error": "request-not-object"}

    req_id = req.get("id")
    if not isinstance(req_id, str):
        return {"id": None, "error": "missing-or-invalid-id"}

    text = req.get("text")
    if not isinstance(text, str):
        return {"id": req_id, "error": "missing-or-invalid-text"}

    findings = inspect_text(text)
    return {"id": req_id, "findings": findings, "scanner_version": SCANNER_VERSION}


def main() -> int:
    # Force UTF-8 on the IPC channel regardless of platform locale. On Windows
    # sys.stdin/stdout default to the ANSI code page (e.g. cp1252), which mangles
    # the very characters this scanner exists to catch (e.g. U+200B's UTF-8 bytes
    # would decode as three cp1252 chars and slip through). This line is
    # load-bearing for correctness on Windows.
    sys.stdin.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]

    # Line-buffered, explicit flush: the TS client blocks on one response line.
    for raw in sys.stdin:
        line = raw.rstrip("\n")
        if not line:
            continue
        resp = _handle(line)
        sys.stdout.write(json.dumps(resp, ensure_ascii=True) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
