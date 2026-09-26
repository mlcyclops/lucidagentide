// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_avatar_1.ts - P-AVATAR.1 (ADR-0251): the "LUCID Agent" role + the immersive stage.
//
// Verifies, with no DOM: the role joins the closed set in BOTH mirrors (settings_store + tour list),
// normalization stays fail-safe, the role has full display metadata + a bespoke tour that never targets a
// hidden rail, the animated glyph exists, and the stylesheet actually hides both rails + the inspector under
// the immersive class while providing the stage layer the face mounts into (P-AVATAR.2a).
//
// Run: bun run desktop/scripts/demo_p_avatar_1.ts

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeRole, USER_ROLES } from "../settings_store.ts";
import { ROLE_META, USER_ROLE_LIST, roleDefaultTab, stepsForRole } from "../renderer/tour.ts";
import { roleIcon } from "../renderer/role_icons.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} \u2713`);

console.log("== P-AVATAR.1 (ADR-0251) - the LUCID Agent role + immersive stage ==");

// 1. The role joins the closed set, in both mirrors, and normalization stays fail-safe.
if (!(USER_ROLES as string[]).includes("lucid-agent")) fail("settings_store USER_ROLES is missing lucid-agent");
if (!(USER_ROLE_LIST as string[]).includes("lucid-agent")) fail("renderer USER_ROLE_LIST is missing lucid-agent");
if (JSON.stringify([...USER_ROLES]) !== JSON.stringify([...USER_ROLE_LIST])) fail("the two role lists disagree");
if (normalizeRole("lucid-agent") !== "lucid-agent") fail("lucid-agent did not pass normalization");
if (normalizeRole("matrix") !== "developer") fail("junk roles must still fold to developer");
ok("lucid-agent is in the closed role set (both mirrors); junk still folds to developer");

// 2. Display metadata + the cosmetic guarantee (the tab domain stays {security, memory} - invariant #3).
const m = ROLE_META["lucid-agent"];
if (!m?.label || !m.icon || !m.lands || !m.blurb) fail("lucid-agent is missing display metadata");
if (roleDefaultTab("lucid-agent") !== "memory") fail("lucid-agent must land on the calm memory tab");
ok(`role card: ${m.label} - lands on ${m.lands}`);

// 3. A bespoke tour that only targets surfaces visible ON the stage (rails are hidden there).
const steps = stepsForRole("lucid-agent");
if (JSON.stringify(steps.map((s) => s.id)) !== JSON.stringify(["composer", "model", "stage", "closer"])) {
  fail(`unexpected lucid-agent tour: ${steps.map((s) => s.id).join(" \u2192 ")}`);
}
for (const s of steps) if (s.target.includes(".rail-btn") || s.target.startsWith("#rail")) fail(`tour step ${s.id} targets a hidden rail`);
if (steps[2]!.target !== "#agentStage") fail("the stage step must target #agentStage");
ok("tour: composer \u2192 model \u2192 stage \u2192 closer, never a hidden rail");

// 4. The animated glyph: the agent head with three rain streams.
const svg = roleIcon("lucid-agent");
if (!svg.includes("ri-agt")) fail("lucid-agent glyph missing its ri-agt class");
if ((svg.match(/ri-rain/g) ?? []).length < 3) fail("lucid-agent glyph should carry three rain streams");
ok("animated glyph present (head + 3 glyph-rain streams)");

// 5. The stylesheet contract: immersive hides BOTH rails + the inspector and ships the stage layer.
const HERE = dirname(fileURLToPath(import.meta.url));
const css = await Bun.file(join(HERE, "..", "renderer", "styles.css")).text();
if (!css.includes("#app-inner.immersive .rail{width:0")) fail("immersive CSS must collapse the activity rail IN PLACE");
if (!css.includes("#app-inner.immersive .sidebar,#app-inner.immersive .inspector{width:0")) fail("immersive CSS must collapse sidebar + inspector IN PLACE");
// The live-bug guard (2026-08-01): display:none REMOVES a grid item and re-slots every later panel -
// the center collapsed into an auto track and Settings landed mid-screen. Never again.
if (/#app-inner\.immersive [^{]*\{[^}]*display:\s*none/.test(css)) fail("immersive rules must NEVER display:none a .body grid child");
for (const sel of [".agent-stage{", ".agent-stage-glow{", "@keyframes agentGlow"]) {
  if (!css.includes(sel)) fail(`stage layer CSS missing ${sel}`);
}
if (!/prefers-reduced-motion:reduce\)\{\.agent-stage-glow\{animation:none\}/.test(css.replace(/\s+/g, ""))) {
  fail("the stage glow must respect prefers-reduced-motion");
}
ok("immersive CSS hides rail + sidebar + inspector; stage layer + reduced-motion fallback present");

console.log("\nALL CHECKS PASSED");
