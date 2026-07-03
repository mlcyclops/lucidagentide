// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/chat_bg.ts
//
// P-APPEAR.1: the user's personalized chat-interface background. Stored in its OWN file (not the main
// settings JSON) so the frequently-read settings load() never has to parse a multi-MB image data URL.
// The image is a data: URL (set as a CSS background in the renderer, allowed by `img-src data:`); mode is
// off | ambient (a faint 25% wash) | flashlight (black background, revealed only under the cursor).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ChatBgMode = "off" | "ambient" | "flashlight";
export interface ChatBg { image: string; mode: ChatBgMode; opacity: number }

const DIR = join(homedir(), ".omp");
const FILE = join(DIR, "lucid-chatbg.json");
const DEFAULT: ChatBg = { image: "", mode: "off", opacity: 0.25 };
const MAX_DATAURL = 12 * 1024 * 1024; // ~9 MB image after base64 - a generous ceiling, not a burden

const clampOpacity = (n: unknown): number => (typeof n === "number" && n > 0 && n <= 1 ? n : 0.25);
const okMode = (m: unknown): ChatBgMode => (m === "ambient" || m === "flashlight" ? m : "off");

export function loadChatBg(): ChatBg {
  try {
    // Read directly (no stat-then-read: CodeQL flags that pair as a TOCTOU race).
    const j = JSON.parse(readFileSync(FILE, "utf8")) as Partial<ChatBg>;
    return { image: typeof j.image === "string" ? j.image : "", mode: okMode(j.mode), opacity: clampOpacity(j.opacity) };
  } catch { return { ...DEFAULT }; }
}

export function saveChatBg(patch: Partial<ChatBg>): { ok: boolean; error?: string; data?: ChatBg } {
  if (typeof patch.image === "string" && patch.image.length > MAX_DATAURL) {
    return { ok: false, error: "That image is too large (keep it under ~9 MB). Try a smaller or more compressed image." };
  }
  const cur = loadChatBg();
  const next: ChatBg = {
    image: typeof patch.image === "string" ? patch.image : cur.image,
    mode: patch.mode !== undefined ? okMode(patch.mode) : cur.mode,
    opacity: patch.opacity !== undefined ? clampOpacity(patch.opacity) : cur.opacity,
  };
  if (!next.image) next.mode = "off"; // no image → nothing to display
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify(next));
    return { ok: true, data: next };
  } catch (e) { return { ok: false, error: String((e as Error)?.message ?? e) }; }
}
