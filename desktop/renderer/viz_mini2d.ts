// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_mini2d.ts - P-VIZ.2 (ADR-0623): the PIXEL mini Lucid for the Visualize view's 2D map.
//
// The same seated mini Lucid the prompt bar and Ask Lucid show (mascot_mini.ts: typingRows / sceneRows over
// the mascot.ts frames), palette-swapped per agent: G/g wear the look's accent, K/D/L its gi. One cell is one
// texel of a small canvas texture sampled nearest-neighbor with no mipmaps, so the scene can scale it to any
// size and it stays crisp. It repaints only when the frame changes (a typing beat is TYPING_BEAT_MS).
//
//   working : typing; the tempo follows the intensity (a firehose types about four times faster than a trickle)
//   paused  : the typing frame it stopped on, held still
//   idle    : seated, eyes closed, a slow breath
//   failed  : the error blink beat (mascot_mini's flinch)
//   ended   : seated, eyes closed, dimmed
//   killed  : the down (blink) frame, desaturated and dimmed

import * as THREE from "three";
import { MASCOT_PALETTE, paintRows } from "./mascot.ts";
import { SCENE_H, SCENE_W, sceneRows, TYPING_BEAT_MS, typingRows } from "./mascot_mini.ts";
import type { MiniLook, MiniState } from "./viz_mini3d.ts";

export interface Mini2D {
  readonly texture: THREE.CanvasTexture;
  /** Width over height of the figure's cell grid. */
  readonly aspect: number;
  update(tMs: number, state: MiniState, intensity: number): void;
  dispose(): void;
}

/** The typing pattern repeats every 6 s (mascot_mini.typingRows), so a beat index is enough of a key. */
const TYPING_BEATS = Math.round(6000 / TYPING_BEAT_MS);
const BREATH_MS = 1600;

export function createMini2D(look: MiniLook): Mini2D {
  const cv = document.createElement("canvas");
  cv.width = SCENE_W;
  cv.height = SCENE_H;
  const ctx = cv.getContext("2d");
  const texture = new THREE.CanvasTexture(cv);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  // The mascot palette with the look's accent and gi swapped in (outline, mask, eyes and steel stay).
  const palette = { ...MASCOT_PALETTE, G: look.accent, g: look.accentDeep, K: look.gi, D: look.giShadow, L: look.giHighlight };
  const dead = desaturate(palette);
  let acc = 0, lastT = -1, failAt = 0, prev: MiniState | null = null, key = "";

  return {
    texture,
    aspect: SCENE_W / SCENE_H,
    update(tMs, state, intensity) {
      const dt = lastT < 0 ? 0 : Math.max(0, Math.min(250, tMs - lastT));
      lastT = tMs;
      if (state === "failed" && prev !== "failed") failAt = tMs;
      prev = state;
      if (state === "working") acc += dt * (0.45 + 1.55 * Math.max(0, Math.min(1, intensity)));
      let k: string;
      let rows: () => readonly string[];
      switch (state) {
        case "working":
        case "paused": {
          k = `t${Math.floor(acc / TYPING_BEAT_MS) % TYPING_BEATS}`;
          const at = acc;
          rows = () => typingRows(at);
          break;
        }
        case "failed": {
          const age = tMs - failAt;
          const blink = age < 140 || (age >= 300 && age < 440);
          k = `f${blink ? 1 : 0}`;
          rows = () => sceneRows("error", blink ? 0 : 200);
          break;
        }
        case "ended": k = "e"; rows = () => sceneRows("idle", 0); break;
        case "killed": k = "k"; rows = () => sceneRows("error", 0); break;
        default: {
          const breathe = Math.floor(tMs / BREATH_MS) % 2 === 1;
          k = `i${breathe ? 1 : 0}`;
          rows = () => sceneRows("idle", 0, { breathe });
        }
      }
      k += `|${state}`;
      if (k === key || !ctx) return;
      key = k;
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.globalAlpha = state === "ended" ? 0.55 : state === "killed" ? 0.7 : 1;
      paintRows(ctx, rows(), 1, 0, 0, state === "killed" ? dead : palette);
      ctx.globalAlpha = 1;
      texture.needsUpdate = true;
    },
    dispose() { texture.dispose(); },
  };
}

/** Every color pulled most of the way to its own gray and a little darker: the figure reads as powered off. */
function desaturate(p: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, hex] of Object.entries(p)) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) { out[k] = hex; continue; }
    const n = parseInt(m[1]!, 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const y = 0.3 * r + 0.59 * g + 0.11 * b;
    const ch = (c: number): string => Math.round((c + (y - c) * 0.85) * 0.8).toString(16).padStart(2, "0");
    out[k] = `#${ch(r)}${ch(g)}${ch(b)}`;
  }
  return out;
}
