// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_voice_8.ts
//
// P-VOICE.8 (ADR-0400): the read-aloud checkboxes mean what the user clicked, everywhere. One rule
// (desktop/voice_flags.ts) is shared by the engine store and every renderer control; the renderer applies a
// click before the engine answers (so a streaming reply stops speaking at once), never lets an older answer
// overwrite a newer click, and repaints the popover, the chip and the Settings card from one state. The
// LUCID Agent stage stops forcing hands-free on for a user who set it themselves.
//
// Run: bun run harness/scripts/demo_p_voice_8.ts

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyReadAloudPatch } from "../../desktop/voice_flags.ts";
import { load, setVoiceSettings, voiceSettings } from "../../desktop/settings_store.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`  ok  ${m}`); };
const REPO = join(import.meta.dir, "..", "..");

console.log("== #ADR-0400 P-VOICE.8: the read-aloud settings are the ones you clicked ==\n");

console.log("[1] one rule");
const on = applyReadAloudPatch({ ttsAutoSpeak: false, ttsConversation: false, ttsDigest: false }, { ttsConversation: true });
ok(on.ttsAutoSpeak && on.ttsConversation, "conversation on brings auto-speak with it");
const off = applyReadAloudPatch(on, { ttsAutoSpeak: false });
ok(!off.ttsAutoSpeak && !off.ttsConversation, "auto-speak off turns conversation off");
ok(!applyReadAloudPatch(off, { ttsAutoSpeak: true }).ttsConversation, "turning auto-speak back on does not revive conversation");

console.log("\n[2] the engine store follows it (a throwaway settings file)");
const dir = mkdtempSync(join(tmpdir(), "pvoice8-"));
process.env.LUCID_GUI_SETTINGS_FILE = join(dir, "lucid-gui.json");
try {
  setVoiceSettings({ ttsConversation: true });
  setVoiceSettings({ ttsAutoSpeak: false });
  ok(load().ttsConversation === false, "auto-speak off clears the stored conversation flag, not just the view");
  ok(setVoiceSettings({ ttsAutoSpeak: true }).ttsConversation === false, "and it stays off when auto-speak returns");
  setVoiceSettings({ ttsReadAloudChosen: true });
  ok(voiceSettings().ttsReadAloudChosen, "a user click is remembered for the LUCID Agent stage");
} finally { delete process.env.LUCID_GUI_SETTINGS_FILE; rmSync(dir, { recursive: true, force: true }); }

console.log("\n[3] the renderer writes through one path, and the rebuilt bundle carries it");
const app = readFileSync(join(REPO, "desktop", "renderer", "app.ts"), "utf8");
ok(!app.includes("bridge.setVoiceSettings({ [key]: value }"), "the Settings card no longer writes around the shared path");
ok(/if \(seq !== voiceSeq\) return;/.test(app), "an older engine answer never overwrites a newer click");
ok(app.includes("!state.voice?.ttsReadAloudChosen"), "the LUCID Agent stage only arms hands-free for a user who never set it");
const bundle = readFileSync(join(REPO, "desktop", "renderer", "app.bundle.js"), "utf8");
ok(bundle.includes("ttsReadAloudChosen") && bundle.includes("Hands-free is off"), "app.bundle.js was rebuilt with the fix");

console.log("\nP-VOICE.8 demo passed.");
