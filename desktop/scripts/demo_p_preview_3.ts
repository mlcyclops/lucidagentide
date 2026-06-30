// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_preview_3.ts
//
// Increment P-PREVIEW.3 (ADR-0096) — harden the sandbox the preview <iframe> runs untrusted, agent-authored
// code in. Proves the single-source policy is locked down:
//   (1) scripts run (the app must work) but the frame is OPAQUE-ORIGIN (no allow-same-origin) — it can't
//       read LUCID's origin, cookies, or localStorage;
//   (2) no escape/escalation token is ever granted (same-origin, top-navigation, popups, modals,
//       pointer-lock, downloads all stay OFF);
//   (3) the Permissions-Policy (`allow`) denies every powerful feature (camera/mic/geolocation/...).

import { PREVIEW_ALLOW, PREVIEW_SANDBOX, PREVIEW_SANDBOX_FORBIDDEN } from "../preview_resolve.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);
const tokens = PREVIEW_SANDBOX.split(/\s+/).filter(Boolean);

console.log("== P-PREVIEW.3 — hardened preview sandbox ==");

console.log("\n1) scripts run, but opaque-origin (isolated from LUCID)");
if (!tokens.includes("allow-scripts")) fail("the previewed app must be able to run JS");
if (tokens.includes("allow-same-origin")) fail("allow-same-origin would break the opaque-origin isolation");
ok(`sandbox="${PREVIEW_SANDBOX}" — scripts on, same-origin OFF`);

console.log("\n2) no escape/escalation token is granted");
for (const forbidden of PREVIEW_SANDBOX_FORBIDDEN) {
  if (tokens.includes(forbidden)) fail(`${forbidden} must never be in the sandbox`);
  ok(`excluded: ${forbidden}`);
}

console.log("\n3) Permissions-Policy denies all powerful features");
if (PREVIEW_ALLOW !== "") fail(`allow must be empty (deny all); got "${PREVIEW_ALLOW}"`);
ok(`allow="" — camera/mic/geolocation/... all denied`);

console.log("\nPASS — untrusted agent-authored pages run sandboxed, opaque-origin, with no powerful features.");
