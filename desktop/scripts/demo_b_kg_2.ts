// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_b_kg_2.ts
//
// Increment B-KG.2 — recoverable export location (issue #115). The export destination used to flash in a
// toast for a few seconds, then it was gone. Proof of the decision core (kg_export.ts) that the renderer
// wires to: with a real path the toast persists and offers Copy path (+ Open folder on desktop); with no
// path it offers nothing and auto-dismisses as before.

import { exportActionPlan } from "../renderer/kg_export.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);
const eq = (a: unknown, b: unknown, msg: string): void => { if (JSON.stringify(a) !== JSON.stringify(b)) fail(`${msg} — got ${JSON.stringify(a)}`); };

console.log("== #115 export location is recoverable ==");

const desktop = exportActionPlan("C:/Users/me/LucidVault", true);
eq(desktop, { reveal: true, copy: true, persist: true }, "desktop+dest should offer Open folder + Copy path and persist");
ok("desktop app + path → Open folder + Copy path, toast persists (no more vanishing location)");

const browser = exportActionPlan("/home/me/LucidVault", false);
eq(browser, { reveal: false, copy: true, persist: true }, "browser+dest should offer Copy path and persist (no native reveal)");
ok("browser build + path → Copy path, toast persists (no native Open folder)");

const failed = exportActionPlan(undefined, true);
eq(failed, { reveal: false, copy: false, persist: false }, "no dest should offer nothing and auto-dismiss");
ok("no path (export failed) → no actions, auto-dismiss (unchanged)");

console.log("demo-B-KG.2 OK");
process.exit(0);
