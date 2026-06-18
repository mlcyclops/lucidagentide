"""NDJSON server contract (ADR-0002). Tests the pure request handler.

The server NEVER decides "safe": it returns findings or an error. Malformed
input yields an error object (which the TS gate maps to BLOCK) -- the loop must
not crash on a bad line.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server import SCANNER_VERSION, _handle  # noqa: E402


def test_clean_request_well_formed_response():
    resp = _handle('{"id": "r1", "text": "hello world"}')
    assert resp["id"] == "r1"
    assert resp["findings"] == []
    assert resp["scanner_version"] == SCANNER_VERSION


def test_poisoned_request_reports_finding():
    text = "edit" + chr(0x200B) + "file"
    import json

    resp = _handle(json.dumps({"id": "r2", "text": text}))
    assert resp["id"] == "r2"
    assert any(f["type"] == "zero-width" for f in resp["findings"])


def test_invalid_json_is_error_not_crash():
    resp = _handle("{not json")
    assert "error" in resp
    assert resp["id"] is None


def test_missing_id_is_error():
    resp = _handle('{"text": "hi"}')
    assert "error" in resp


def test_missing_text_is_error_but_keeps_id():
    resp = _handle('{"id": "r3"}')
    assert resp["id"] == "r3"
    assert "error" in resp
