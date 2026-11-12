// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/voice_flags.test.ts - P-VOICE.8 (ADR-0400): the read-aloud flags mean exactly what the user
// clicked, on every surface. The field bug: turning auto-speak off left conversation stored as a masked
// preference, so it (and the mic) came back with auto-speak, and the two checkbox surfaces disagreed.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, setVoiceSettings, voiceSettings } from "./settings_store.ts"; // reads LUCID_GUI_SETTINGS_FILE per call
import { applyReadAloudPatch, effectiveReadAloud } from "./voice_flags.ts";

const OFF = { ttsAutoSpeak: false, ttsConversation: false, ttsDigest: false };

describe("applyReadAloudPatch", () => {
  test("auto-speak off turns conversation off, and turning auto-speak back on does not revive it", () => {
    const talking = applyReadAloudPatch(OFF, { ttsConversation: true });
    expect(talking).toEqual({ ttsAutoSpeak: true, ttsConversation: true, ttsDigest: false }); // conversation brings auto-speak
    const off = applyReadAloudPatch(talking, { ttsAutoSpeak: false });
    expect(off.ttsConversation).toBe(false);
    expect(applyReadAloudPatch(off, { ttsAutoSpeak: true }).ttsConversation).toBe(false);
  });
  test("off wins inside one patch, and the same click twice lands on the same flags", () => {
    expect(applyReadAloudPatch(OFF, { ttsAutoSpeak: false, ttsConversation: true })).toEqual(OFF);
    const once = applyReadAloudPatch({ ttsAutoSpeak: true, ttsConversation: true, ttsDigest: true }, { ttsConversation: false });
    expect(applyReadAloudPatch(once, { ttsConversation: false })).toEqual(once);
    expect(once).toEqual({ ttsAutoSpeak: true, ttsConversation: false, ttsDigest: true });
  });
  test("digest is a preference about HOW to speak: it survives auto-speak off", () => {
    expect(applyReadAloudPatch({ ttsAutoSpeak: true, ttsConversation: false, ttsDigest: true }, { ttsAutoSpeak: false }).ttsDigest).toBe(true);
  });
  test("a stored conversation under auto-speak off reads as off (older settings files)", () => {
    expect(effectiveReadAloud({ ttsAutoSpeak: false, ttsConversation: true }).ttsConversation).toBe(false);
  });
});

describe("the settings store follows the same rule", () => {
  const dir = mkdtempSync(join(tmpdir(), "voice-flags-"));
  process.env.LUCID_GUI_SETTINGS_FILE = join(dir, "lucid-gui.json");
  afterAll(() => { delete process.env.LUCID_GUI_SETTINGS_FILE; rmSync(dir, { recursive: true, force: true }); });

  test("off, then on again: conversation stays off, in the view AND on disk", () => {
    setVoiceSettings({ ttsConversation: true });
    expect(voiceSettings()).toMatchObject({ ttsAutoSpeak: true, ttsConversation: true });
    setVoiceSettings({ ttsAutoSpeak: false });
    expect(load().ttsConversation).toBe(false);
    expect(setVoiceSettings({ ttsAutoSpeak: true }).ttsConversation).toBe(false);
  });
  test("a legacy file storing conversation under auto-speak off does not bring it back", () => {
    writeFileSync(process.env.LUCID_GUI_SETTINGS_FILE!, JSON.stringify({ ttsAutoSpeak: false, ttsConversation: true }));
    expect(setVoiceSettings({ ttsAutoSpeak: true }).ttsConversation).toBe(false);
  });
  test("a user click is remembered, so the Agent stage leaves the flags alone", () => {
    expect(voiceSettings().ttsReadAloudChosen).toBe(false);
    setVoiceSettings({ ttsAutoSpeak: false, ttsReadAloudChosen: true });
    expect(voiceSettings().ttsReadAloudChosen).toBe(true);
    setVoiceSettings({ ttsReadAloudChosen: false }); // never cleared by a patch
    expect(voiceSettings().ttsReadAloudChosen).toBe(true);
  });
});
