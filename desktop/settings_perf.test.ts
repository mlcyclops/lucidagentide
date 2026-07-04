// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-PERF.5 (ADR-0132): the settings store's perf seams - memoized load(), debounced lastModel
// write-behind with read-your-writes, and deterministic flush. The store path is redirected to a
// temp file via LUCID_GUI_SETTINGS_FILE (read per call, so module-cache order can't leak writes
// into the real ~/.omp/lucid-gui.json). No wall-clock waits: flushPendingSettings() drives the
// debounce deterministically.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flushPendingSettings, lastModel, load, save, setLastModel } from "./settings_store.ts";

let dir = "";
let file = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lucid-gui-")); // atomic, random name (js/insecure-temporary-file)
  file = join(dir, "gui.json");
  process.env.LUCID_GUI_SETTINGS_FILE = file;
  flushPendingSettings(); // drain any pending write from a previous test before switching files
});

afterEach(() => {
  flushPendingSettings();
  delete process.env.LUCID_GUI_SETTINGS_FILE;
  rmSync(dir, { recursive: true, force: true });
});

test("setLastModel is read-your-writes BEFORE the flush, and persisted after", () => {
  setLastModel("anthropic/claude-x");
  expect(lastModel()).toBe("anthropic/claude-x"); // pending value visible immediately
  flushPendingSettings();
  expect(lastModel()).toBe("anthropic/claude-x");
  expect(JSON.parse(readFileSync(file, "utf8")).lastModel).toBe("anthropic/claude-x"); // on disk
});

test("a burst of switches coalesces to the LAST value", () => {
  setLastModel("m-1");
  setLastModel("m-2");
  setLastModel("m-3");
  expect(lastModel()).toBe("m-3");
  flushPendingSettings();
  expect(JSON.parse(readFileSync(file, "utf8")).lastModel).toBe("m-3");
  flushPendingSettings(); // idempotent - nothing pending, no error, file unchanged
  expect(JSON.parse(readFileSync(file, "utf8")).lastModel).toBe("m-3");
});

test("blank/whitespace models are ignored (never clobber a real value)", () => {
  setLastModel("m-real");
  flushPendingSettings();
  setLastModel("   ");
  flushPendingSettings();
  expect(lastModel()).toBe("m-real");
});

test("load() memoizes on mtime but still sees an EXTERNAL file change", () => {
  save({ lastModel: "from-save" });
  expect(load().lastModel).toBe("from-save"); // memo hit after save
  // simulate an external writer (a second process / manual edit): the mtime changes -> re-read
  writeFileSync(file, JSON.stringify({ lastModel: "external-edit" }));
  expect(load().lastModel).toBe("external-edit");
});

test("load() returns independent objects - mutating a result never corrupts the memo", () => {
  save({ lastModel: "clean" });
  const a = load();
  a.lastModel = "dirty-local-mutation";
  expect(load().lastModel).toBe("clean"); // the memo (and disk) are untouched
});

test("a missing settings file is just {} (no throw, no stale memo)", () => {
  expect(load()).toEqual({});
  save({ lastModel: "now-exists" });
  expect(load().lastModel).toBe("now-exists");
  rmSync(file);
  expect(load()).toEqual({}); // deletion observed, memo not served stale
});
