// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1
import { MASCOT_W, MASCOT_H, MASCOT_THEMES, MASCOT_RUN_FRAMES, MASCOT_RUN_BEAT_MS, WORK_ACTIVITIES, mascotActivityFrame, mascotFrame, paintFrame } from '../renderer/mascot.ts';

const roster = [
  { theme: 'lucid', title: 'LUCID / Original', activity: 'kata', role: 'Precision kata', note: 'Wind-up, strike, recoil. The original green.' },
  { theme: 'ember', title: 'EMBER / Striker', activity: 'staff', role: 'Staff practice', note: 'Warm copper armor. A measured staff sweep.' },
  { theme: 'glacier', title: 'GLACIER / Scout', activity: 'scanning', role: 'Field scanning', note: 'Cold blue kit. Eyes tracking the next signal.' },
  { theme: 'orchid', title: 'ORCHID / Builder', activity: 'coding', role: 'Terminal work', note: 'Violet wraps. Small hands, serious debugging.' },
  { theme: 'solar', title: 'SOLAR / Sentinel', activity: 'shuriken', role: 'Throwing practice', note: 'Gold accents. Set, aim, release, recover.' },
  { theme: 'stealth', title: 'STEALTH / Monk', activity: 'meditate', role: 'Quiet focus', note: 'Muted slate. A moment between missions.' },
] as const;
const host = document.querySelector<HTMLElement>('#roster')!;
const cards = roster.map((entry, i) => {
  const theme = MASCOT_THEMES[entry.theme];
  const card = document.createElement('article'); card.className = 'card'; card.style.setProperty('--accent', theme.palette.G!);
  const meta = document.createElement('div'); meta.className = 'card-top';
  const number = document.createElement('span'); number.textContent = String(i + 1).padStart(2, '0');
  const badge = document.createElement('span'); badge.textContent = entry.role; meta.append(number, badge);
  const cv = document.createElement('canvas'); cv.width = 240; cv.height = 240; cv.setAttribute('aria-label', entry.title + ' animated ' + entry.role); cv.setAttribute('role', 'img');
  const title = document.createElement('h2'); title.textContent = entry.title; title.title = entry.title;
  const note = document.createElement('p'); note.textContent = entry.note;
  const foot = document.createElement('div'); foot.className = 'card-foot';
  const small = document.createElement('canvas'); small.width = MASCOT_W; small.height = MASCOT_H; small.setAttribute('aria-label', 'Actual 40 by 52 pixel size');
  const frame = document.createElement('span'); frame.className = 'frame-name'; foot.append(small, frame);
  card.append(meta, cv, title, note, foot); host.append(card);
  return { ...entry, cv, ctx: cv.getContext('2d')!, small, smallCtx: small.getContext('2d')!, frame, palette: theme.palette, lastFrame: '' };
});
const mode = document.querySelector<HTMLSelectElement>('#activity')!;
for (const activity of WORK_ACTIVITIES) { const option = document.createElement('option'); option.value = activity; option.textContent = activity[0]!.toUpperCase() + activity.slice(1); mode.append(option); }
const speed = document.querySelector<HTMLSelectElement>('#speed')!;
const pause = document.querySelector<HTMLButtonElement>('#pause')!;
const status = document.querySelector<HTMLElement>('#status')!;
const motion = matchMedia('(prefers-reduced-motion: reduce)');
let paused = motion.matches, time = 0, last = performance.now();
function syncPause(): void { pause.textContent = paused ? 'Play animation' : 'Pause animation'; pause.setAttribute('aria-pressed', String(paused)); }
syncPause();
pause.onclick = () => { paused = !paused; syncPause(); };
document.querySelector<HTMLButtonElement>('#step')!.onclick = () => { paused = true; time += MASCOT_RUN_BEAT_MS; syncPause(); draw(); };
mode.onchange = () => { time = 0; draw(); };
motion.addEventListener('change', event => { paused = event.matches; syncPause(); });
function frameAt(activity: string): string {
  if (activity === 'run') return MASCOT_RUN_FRAMES[Math.floor(time / MASCOT_RUN_BEAT_MS) % MASCOT_RUN_FRAMES.length]!;
  if (activity === 'idle' || activity === 'speaking' || activity === 'victory' || activity === 'listening') return mascotFrame({ state: activity, since: 0, until: 1500 }, time);
  return mascotActivityFrame(activity, time);
}
function draw(): void {
  for (const card of cards) {
    const frame = frameAt(mode.value === 'signature' ? card.activity : mode.value);
    if (card.lastFrame === frame) continue;
    card.lastFrame = frame;
    card.ctx.clearRect(0, 0, card.cv.width, card.cv.height);
    card.ctx.fillStyle = '#080e18'; card.ctx.beginPath(); card.ctx.ellipse(120, 224, 54, 7, 0, 0, Math.PI * 2); card.ctx.fill();
    paintFrame(card.ctx, frame, 4, 40, 16, card.palette);
    card.smallCtx.clearRect(0, 0, MASCOT_W, MASCOT_H); paintFrame(card.smallCtx, frame, 1, 0, 0, card.palette);
    if (card.frame.textContent !== frame) card.frame.textContent = frame;
  }
  status.textContent = `40 x 52 native pixels / ${Math.round(time)} ms / ${paused ? 'paused' : speed.value + 'x playback'}`;
}
function tick(now: number): void { if (!paused && !document.hidden) time += Math.min(100, now - last) * Number(speed.value); last = now; draw(); requestAnimationFrame(tick); }
draw(); requestAnimationFrame(tick);
