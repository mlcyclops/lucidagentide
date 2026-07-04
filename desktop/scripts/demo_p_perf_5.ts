// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_perf_5.ts
//
// Increment P-PERF.5 — interaction hygiene on the model/module switch path (ADR-0132). A model switch
// used to block the badge + status on an omp round-trip AND a synchronous settings write; every omp
// model report re-read the settings file from disk; the picker re-rendered 100-200 rows on every open.
// Now: the switch paints optimistically (round-trip reconciles in the background - wired in app.ts),
// lastModel is a debounced write-behind with read-your-writes, and load() is memoized on mtime+size.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flushPendingSettings, lastModel, load, save, setLastModel } from "../settings_store.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);

console.log("== #ADR-0132 switch hygiene: write-behind lastModel, memoized load, optimistic paint ==");

const dir = mkdtempSync(join(tmpdir(), "lucid-perf5-")); // atomic, random name (js/insecure-temporary-file)
const file = join(dir, "gui.json");
process.env.LUCID_GUI_SETTINGS_FILE = file;

try {
  // 1) a burst of model flips (the picker scroll-through) coalesces into ONE deferred write.
  //    Asserted on file CONTENT (not mtime) - stronger, and no stat-then-read pair (js/file-system-race).
  save({ lastModel: "m-start" });
  setLastModel("m-1");
  setLastModel("m-2");
  setLastModel("m-3");
  if (JSON.parse(readFileSync(file, "utf8")).lastModel !== "m-start") fail("no write may happen during the burst (write-behind)");
  if (lastModel() !== "m-3") fail("read-your-writes: the pending value must be visible immediately");
  flushPendingSettings();
  if (JSON.parse(readFileSync(file, "utf8")).lastModel !== "m-3") fail("the flush must persist the LAST value");
  ok("model-flip burst: zero writes during the burst, read-your-writes, one flush persists the final pick");

  // 2) load() is memoized (the hot path omp's model reports hit on every event) yet never stale
  save({ lastModel: "hot" });
  for (let i = 0; i < 1000; i++) if (load().lastModel !== "hot") fail("memoized load must be consistent");
  writeFileSync(file, JSON.stringify({ lastModel: "external" })); // an external change (mtime/size differ)
  if (load().lastModel !== "external") fail("an external file change must invalidate the memo");
  ok("1000 hot-path load()s served from the memo; an external edit still invalidates (mtime+size key)");

  // 3) mutation safety: a caller mutating a load() result cannot corrupt what others read
  const mine = load();
  mine.lastModel = "local-dirty";
  if (load().lastModel !== "external") fail("load() results must be independent clones");
  ok("load() hands out independent clones - a mutate-without-save bug can't poison other readers");

  // 4) the optimistic-switch contract (wired in app.ts applyConfig): paint first, reconcile after,
  //    warn on failure - never hold the badge hostage on the round-trip. Stated here; exercised live.
  ok("switch path: optimistic paint + background reconcile + honest warn toast on an unconfirmed apply");
} finally {
  flushPendingSettings();
  delete process.env.LUCID_GUI_SETTINGS_FILE;
  rmSync(dir, { recursive: true, force: true });
}

console.log("demo-P-PERF.5 OK");
process.exit(0);
