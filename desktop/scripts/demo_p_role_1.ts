// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_role_1.ts
//
// Increment P-ROLE.1 (ADR-0088) — role-based onboarding + opinionated, progressively-disclosed views.
// Proves: (1) the four roles are a closed, ordered set with display metadata; (2) role normalisation
// is fail-safe — unset/unknown folds to the full-surface "developer" default; (3) each role maps to a
// CALM default landing surface (Security analyst → the queue, everyone else → Memory); (4) roles are
// COSMETIC — the mapping never names or touches the security gate.

import { ROLE_META, USER_ROLE_LIST, roleDefaultTab } from "../renderer/tour.ts";
import { normalizeRole, USER_ROLES } from "../settings_store.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);

console.log("== P-ROLE.1 — role onboarding + opinionated default views ==");

// 1. Closed, ordered set; the renderer mirror and the settings source agree.
const EXPECT = ["developer", "security", "manager", "executive"];
if (JSON.stringify(USER_ROLE_LIST) !== JSON.stringify(EXPECT)) fail(`role set/order drifted: ${USER_ROLE_LIST.join(",")}`);
if (JSON.stringify([...USER_ROLES]) !== JSON.stringify(EXPECT)) fail("settings_store USER_ROLES disagrees with the renderer list");
ok(`roles are a closed, ordered set: ${EXPECT.join(" · ")}`);

for (const r of USER_ROLE_LIST) {
  const m = ROLE_META[r];
  if (!m.label || !m.icon || !m.lands || !m.blurb) fail(`role ${r} missing display metadata`);
}
ok("every role has a label, glyph, landing phrase, and one-line blurb");

// 2. Fail-safe normalisation — unset/unknown → developer (the safe, full-surface default).
for (const r of USER_ROLE_LIST) if (normalizeRole(r) !== r) fail(`valid role ${r} did not pass through`);
for (const junk of [undefined, null, "", "root", "ADMIN", "superuser"]) {
  if (normalizeRole(junk as string) !== "developer") fail(`junk role ${String(junk)} did not fold to developer`);
}
ok("normalizeRole folds unset/unknown/junk → developer (fail-safe)");

// 3. CALM default landing surface per role.
const tab = (r: typeof USER_ROLE_LIST[number]) => roleDefaultTab(r);
if (tab("security") !== "security") fail("security role should land on the Security queue");
if (["developer", "manager", "executive"].some((r) => tab(r as typeof USER_ROLE_LIST[number]) !== "memory")) fail("non-security roles should land on Memory");
ok("Security engineer lands on the queue; Developer / Manager / Executive land on Memory");
for (const r of USER_ROLE_LIST) console.log(`      ${ROLE_META[r].label.padEnd(18)} → lands on ${ROLE_META[r].lands} (tab: ${tab(r)})`);

// 4. Cosmetic guarantee — the role→view mapping only ever yields a UI inspector TAB, never a
//    security decision. The function's entire output domain is {security, memory} (panels), so a role
//    can shift what's foregrounded but can never express "allow"/"block" (invariant #3 stays intact).
const domain = new Set(USER_ROLE_LIST.map(tab));
for (const v of domain) if (v !== "security" && v !== "memory") fail(`roleDefaultTab leaked a non-UI value ("${v}")`);
ok("role→view output domain is exactly {security, memory} inspector tabs — cosmetic, never a gate verdict");

console.log("demo-P-ROLE.1 OK");
process.exit(0);
