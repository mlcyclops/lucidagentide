// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_kgpack_2.ts — P-KGPACK.2 (ADR-0205): the named-KG picker (pure builders).
//
// The combined "Compiled KB" becomes a filter-as-you-type dropdown of named KGs. This exercises the PURE
// builders the picker is made of (the app.ts popover + bridge wiring is typechecked + QA'd live, same as the
// P-KGUI dropdowns): the label shows the active KG name, the list filters + checks the active KG, user names
// are escaped, and the empty state is a message not a blank. No DOM, no server.

import { filterKgList, kgPickerHtml, kgPickerRowsHtml, kgViewLabel, type KgListItem } from "../renderer/kg_header.ts";

function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(`ASSERT FAILED: ${msg}`); }

const kgs: KgListItem[] = [
  { kg_id: "1", name: "My Knowledge", active: true, read_only: false, source_kind: "manual" },
  { kg_id: "2", name: "Backend Engineer", active: false, read_only: false, source_kind: "chat" },
  { kg_id: "3", name: "GovCon Contracts Officer", active: false, read_only: true, source_kind: "pack" },
];

console.log("== [1/4] the views-button label follows the active KG in kb mode ==");
assert(kgViewLabel({ relateOn: false, codeMode: false, kbMode: true, kbName: "Backend Engineer" }) === "Backend Engineer", "label = active KG name");
assert(kgViewLabel({ relateOn: false, codeMode: false, kbMode: true }) === "Compiled KB", "blank name falls back to Compiled KB");
console.log('   kb mode → "Backend Engineer"; no name → "Compiled KB"');

console.log("== [2/4] the list checks the active KG and carries stable handles ==");
const rows = kgPickerRowsHtml(kgs, "");
for (const id of ["1", "2", "3"]) { assert(rows.includes(`data-kgpick="${id}"`), `pick handle ${id}`); assert(rows.includes(`data-kgrename="${id}"`), `rename handle ${id}`); }
assert((rows.match(/✓/g) ?? []).length === 1 && rows.includes("My Knowledge ✓"), "exactly the active KG is checked");
assert(rows.includes(">Chat<") && rows.includes(">Pack<"), "origin badges rendered");
console.log("   3 rows, active KG checked, Chat + Pack badges present");

console.log("== [3/4] filter-as-you-type + empty state ==");
assert(filterKgList(kgs, "eng").map((k) => k.kg_id).join() === "2", "‘eng’ → Backend Engineer");
assert(kgPickerRowsHtml(kgs, "backend").includes("Backend Engineer"), "search shows the match");
assert(!kgPickerRowsHtml(kgs, "backend").includes("GovCon"), "search hides non-matches");
assert(kgPickerRowsHtml(kgs, "zzz").includes("No knowledge graph matches"), "empty state is a message");
console.log("   ‘eng’ → Backend Engineer · ‘zzz’ → friendly empty message");

console.log("== [4/4] KG names are escaped (user data, never markup) ==");
const evil = kgPickerRowsHtml([{ kg_id: "9", name: "<img src=x onerror=alert(1)>", active: false, read_only: false, source_kind: "manual" }], "");
assert(evil.includes("&lt;img") && !evil.includes("<img src=x"), "name escaped");
assert(kgPickerHtml(kgs, "").includes('id="kgPickSearch"') && kgPickerHtml(kgs, "").includes("data-kgnew"), "search box + New KG action present");
console.log("   <img …> rendered inert; search box + New KG action present");

console.log("== demo-P-KGPACK.2 OK ==");
