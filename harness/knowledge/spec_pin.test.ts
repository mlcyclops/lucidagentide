// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/knowledge/spec_pin.test.ts - P-KSYNC.L6 (#360): the spec drift pin, mirroring the Hub's
// vendored-digest test (LUCIDMeetingHub tests/test_spec_pin.py). This repo hosts the Knowledge Envelope
// spec and the Hub vendors these exact bytes. Editing either file without deliberately bumping the pin
// below (and re-vendoring on the Hub side) must fail here, never drift silently: a drifted envelope does
// not crash, it makes the other device skip our items.

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SPECS = join(import.meta.dir, "..", "..", "docs", "specs");
const PINS: Record<string, string> = {
  "knowledge-envelope-v1.md": "6db54e83b990b921db9e1f9636956649354ed1798ed49d2bffb1e19088d12668",
  "knowledge-envelope-v1.vectors.json": "7afaffb29b038bac01768daef736b370c58111d0ba902547356a35b094266d6d",
};

for (const [file, pin] of Object.entries(PINS)) {
  test(`${file} matches its pinned sha256`, () => {
    const actual = createHash("sha256").update(readFileSync(join(SPECS, file))).digest("hex");
    if (actual !== pin) {
      throw new Error(
        `docs/specs/${file} drifted: pinned ${pin}, actual ${actual}. A spec edit is a coordinated change: ` +
          `bump this pin deliberately, re-run envelope.test.ts, and re-vendor the bytes in LUCIDMeetingHub.`,
      );
    }
  });
}

test("the spec names the vectors digest it ships with", () => {
  expect(readFileSync(join(SPECS, "knowledge-envelope-v1.md"), "utf8")).toContain(PINS["knowledge-envelope-v1.vectors.json"]!);
});
