// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Throwaway visual QA for P-MASCOT.5: the prompt-bar runner next to the arcade sprite, so the walk
// and the pixel scale can be compared side by side. Delete once the user has looked.

import { MASCOT_H, MASCOT_RUN_FRAMES, MASCOT_THEMES, MASCOT_W, paintFrame } from "../renderer/mascot.ts";
import { mountComposerRunner, RUNNER_SCALE } from "../renderer/mascot_runner.ts";

const wrap = document.querySelector<HTMLElement>(".composer-wrap")!;
mountComposerRunner(wrap);
document.querySelector("#scaleOut")!.textContent = `RUNNER_SCALE = ${RUNNER_SCALE}`;

// The arcade reference: the same frames, painted the way mascot_game.ts paints them (scale 2, floor
// line, scrolling dashes) so the two walks can be judged against each other.
const cv = document.querySelector<HTMLCanvasElement>("#arcade")!;
const dpr = Math.min(2, Math.max(1, Math.ceil(window.devicePixelRatio || 1)));
const W = 420, H = 180, FLOOR = 172;
cv.width = W * dpr; cv.height = H * dpr;
cv.style.width = `${W}px`; cv.style.height = `${H}px`;
const ctx = cv.getContext("2d")!;
const palette = MASCOT_THEMES.lucid.palette;
const t0 = performance.now();
const tick = (): void => {
  requestAnimationFrame(tick);
  const t = performance.now() - t0;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = palette.B!;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = palette.g!;
  ctx.fillRect(0, FLOOR, W, 2);
  ctx.fillStyle = palette.D!;
  for (let x = -Math.floor(t * 0.055) % 38; x < W; x += 38) ctx.fillRect(x, FLOOR + 4, 28, 3);
  const frame = MASCOT_RUN_FRAMES[Math.floor(t / 80) % MASCOT_RUN_FRAMES.length]!;
  paintFrame(ctx, frame, 2, Math.round(W / 2 - MASCOT_W), Math.round(FLOOR - MASCOT_H * 2), palette);
};
tick();
