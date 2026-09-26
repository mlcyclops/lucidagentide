// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1
import { mountAgentArcade, createArcadeState, stepArcade, drawArcadeBonus } from '../renderer/mascot_game.ts';
import { MASCOT_THEMES } from '../renderer/mascot.ts';

const host = document.querySelector<HTMLElement>('#arcadeHost')!;
let reviewTotal = 0; // QA-only in-memory port; production wires the shared trivia balance
const game = mountAgentArcade(host, { total: () => reviewTotal, award: points => { reviewTotal += points; } });
let agentMode = true;
let running = true; // review page boots straight into an eligible run for hands-free screenshots
const status = document.querySelector<HTMLElement>('#runStatus')!;
function sync(): void {
  game.update(agentMode, running);
  status.textContent = `${agentMode ? 'LUCID Agent' : 'Regular IDE'} / ${running ? 'test run active' : 'no active run'}`;
  document.querySelector<HTMLButtonElement>('#role')!.textContent = agentMode ? 'Leave Agent role' : 'Enter Agent role';
}
document.querySelector<HTMLButtonElement>('#run')!.onclick = () => { running = true; sync(); };
document.querySelector<HTMLButtonElement>('#end')!.onclick = () => { running = false; sync(); };
document.querySelector<HTMLButtonElement>('#role')!.onclick = () => { agentMode = !agentMode; sync(); };
window.addEventListener('pagehide', () => game.dispose(), { once: true });
sync();

// Hands-free demo: press the REAL buttons and REAL key handlers so screenshots show live play.
setTimeout(() => host.querySelector<HTMLButtonElement>('.agent-arcade-reveal')?.click(), 200);
setTimeout(() => host.querySelector<HTMLButtonElement>('.agent-arcade-start')?.click(), 450);
const canvas = () => host.querySelector<HTMLCanvasElement>('canvas');
function press(key: string, holdMs: number): void {
  canvas()?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  setTimeout(() => canvas()?.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true })), holdMs);
}
let beat = 0;
setInterval(() => {
  beat++;
  if (beat % 3 === 0) press('Control', 120); // punch a pot or target
  else if (beat % 3 === 1) press('Alt', 160); // jump a crate
  else press('ArrowDown', 700); // duck a star or beam
}, 1500);

// The earned Flycatch scene, rendered by the production painter from a REAL engine transition.
const bonusCanvas = document.querySelector<HTMLCanvasElement>('#bonusScene');
const bonusContext = bonusCanvas?.getContext('2d');
if (bonusCanvas && bonusContext) {
  const primed = { ...createArcadeState(640, 7), clears: 5, spawnMs: 60000 }; // documented test seam
  let bonusState = stepArcade(primed, 16);
  const paintBonus = (): void => {
    bonusContext.fillStyle = '#0b1220';
    bonusContext.fillRect(0, 0, 640, 180);
    drawArcadeBonus(bonusContext, bonusState, MASCOT_THEMES.solar.palette);
  };
  paintBonus();
  setInterval(() => { bonusState = stepArcade(bonusState, 40); if (bonusState.mode !== 'flycatch') bonusState = stepArcade({ ...primed, seed: (bonusState.seed || 1) >>> 0 }, 16); paintBonus(); }, 40);
}
