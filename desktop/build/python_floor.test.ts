// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { checkBundledPython, compareDotted, PY_OPENSSL_MIN } from "./python_floor.ts";

const report = (python: string, openssl: string): string => JSON.stringify({ python, openssl });

describe("the bundled CPython must be the pinned one with OpenSSL at or above the floor (ADR-0548)", () => {
  test("20261026 (3.12.16, OpenSSL 3.5.9) passes", () => {
    expect(checkBundledPython(report("3.12.16", "OpenSSL 3.5.9 29 Sep 2026"), "3.12.16", PY_OPENSSL_MIN)).toBeNull();
  });
  test("20260623 (3.12.13, OpenSSL 3.5.7) is refused for its OpenSSL even when it is the pinned CPython", () => {
    expect(checkBundledPython(report("3.12.13", "OpenSSL 3.5.7 9 Jun 2026"), "3.12.13", PY_OPENSSL_MIN)).toContain("below PY_OPENSSL_MIN 3.5.9");
  });
  test("a stale cached tree that is not PY_VERSION is refused", () => {
    expect(checkBundledPython(report("3.12.13", "OpenSSL 3.5.9 29 Sep 2026"), "3.12.16", PY_OPENSSL_MIN)).toContain("but PY_VERSION is 3.12.16");
  });
  test("OpenSSL compares numerically: 3.5.10 passes a 3.5.9 floor", () => {
    expect(compareDotted("3.5.10", "3.5.9")).toBeGreaterThan(0);
    expect(checkBundledPython(report("3.12.16", "OpenSSL 3.5.10 10 Nov 2026"), "3.12.16", "3.5.9")).toBeNull();
  });
  test("output it cannot read is a refusal, never a pass", () => {
    expect(checkBundledPython("Traceback (most recent call last)", "3.12.16", "3.5.9")).toContain("no version report");
    expect(checkBundledPython(report("3.12.16", "LibreSSL 3.9.2"), "3.12.16", "3.5.9")).toContain("unreadable OpenSSL");
    expect(checkBundledPython(report("3.12.16", "OpenSSL 1.1.1w  11 Sep 2023"), "3.12.16", "1.1.1")).toContain("unreadable OpenSSL");
    expect(checkBundledPython(report("3.15.0rc1", "OpenSSL 3.5.9 29 Sep 2026"), "3.15.0rc1", "3.5.9")).toContain("unreadable CPython");
  });
});
