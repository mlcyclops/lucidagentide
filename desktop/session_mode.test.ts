// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/session_mode.test.ts
//
// ADR-0219: the per chat-session CUI vs Search mode store. The sovereignty-critical property is the
// FAIL-CLOSED default: an unknown/absent session id reads as "cui" (which makes the backend egress gate
// block public egress). Also covers the persist roundtrip and the bounded-map pruning.

import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "lucid-sessmode-"));
process.env.LUCID_GUI_SETTINGS_FILE = join(dir, "gui.json");
const { sessionMode, setSessionMode } = await import("./settings_store.ts");

beforeEach(() => { try { rmSync(process.env.LUCID_GUI_SETTINGS_FILE!, { force: true }); } catch { /* fresh */ } });
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } });

describe("sessionMode (ADR-0219)", () => {
  test("FAIL-CLOSED: an unknown session id defaults to 'cui'", () => {
    expect(sessionMode("never-seen")).toBe("cui");
    expect(sessionMode("")).toBe("cui");
  });
  test("persist + read back a Search session; another id is still 'cui'", () => {
    setSessionMode("sess-A", "search");
    expect(sessionMode("sess-A")).toBe("search");
    expect(sessionMode("sess-B")).toBe("cui");
  });
  test("switching a session back to CUI persists", () => {
    setSessionMode("sess-A", "search");
    setSessionMode("sess-A", "cui");
    expect(sessionMode("sess-A")).toBe("cui");
  });
  test("an invalid mode value coerces to the fail-closed 'cui'", () => {
    // @ts-expect-error - exercising a bad runtime value
    setSessionMode("sess-X", "bogus");
    expect(sessionMode("sess-X")).toBe("cui");
  });
  test("the map is pruned to a bounded size (oldest dropped, newest kept)", () => {
    for (let i = 0; i < 250; i++) setSessionMode(`s${i}`, "search");
    expect(sessionMode("s0")).toBe("cui");      // oldest pruned → back to the default
    expect(sessionMode("s249")).toBe("search"); // newest kept
  });
});
