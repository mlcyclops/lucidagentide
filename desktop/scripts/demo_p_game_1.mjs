// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Drive the ACTUAL inline game programs, not a separate model of their rules.
// A small DOM/canvas stand-in lets the increment demo prove complete loops without
// a display server. Visual Preview verification remains a separate manual check.
import { strict as assert } from 'node:assert';

async function launch(file, width, height) {
  const html = await Bun.file(new URL(`../renderer/games/${file}`, import.meta.url)).text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/i)?.[1];
  assert.ok(script, `${file} must have inline game code`);
  const handlers = new Map(), nodes = new Map(), frames = [];
  // Any canvas call returns another callable stand-in, so gradients, paths and offscreen buffers all no-op.
  const stub = () => new Proxy(function () {}, { get: (_, key) => (key === Symbol.toPrimitive ? () => 0 : stub()), apply: () => stub() });
  const context = stub();
  class Element {
    constructor(id) {
      this.id = id; this.hidden = false; this.disabled = false; this.textContent = '';
      this.style = {}; this.attrs = {}; this.dataset = {};
      this.classList = { add() {}, remove() {}, toggle() {} };
      this.offsetWidth = 0; this.innerHTML = '';
    }
    get parentNode() { return this.parent ??= new Element(this.id + ':parent'); }
    appendChild() {}
    addEventListener(kind, callback) { handlers.set(`${this.id}:${kind}`, callback); }
    setAttribute(key, value) { this.attrs[key] = value; }
    append() {}
    getContext() { return context; }
    getBoundingClientRect() { return { left: 0, top: 0, width, height }; }
    focus() { document.activeElement = this; }
    setPointerCapture() {}
    matches() { return false; }
    click() { if (!this.disabled) handlers.get(`${this.id}:click`)?.({ target: this }); }
    pointer(kind, x, y) { handlers.get(`${this.id}:${kind}`)?.({ button: 0, pointerId: 1, clientX: x, clientY: y, target: this, preventDefault() {} }); }
  }
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, new Element(id));
    return nodes.get(id);
  };
  globalThis.document = { getElementById: node, createElement: () => new Element('new'), activeElement: null, hidden: false, addEventListener() {} };
  globalThis.innerWidth = width; globalThis.innerHeight = height;
  globalThis.window = globalThis;
  globalThis.HTMLElement = globalThis.HTMLButtonElement = Element;
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  globalThis.addEventListener = (kind, callback) => handlers.set(`window:${kind}`, callback);
  new Function(script)();
  let clock = performance.now();
  function advance(seconds) {
    for (let i = 0; i < Math.ceil(seconds * 20); i++) {
      clock += 50;
      assert.ok(frames.length, `${file}: animation loop stopped`);
      frames.shift()(clock);
    }
  }
  return {
    node, advance, pointer: (kind, x, y) => node('field').pointer(kind, x, y),
    key: code => handlers.get('window:keydown')?.({ code, preventDefault() {} }),
    up: code => handlers.get('window:keyup')?.({ code, preventDefault() {} }), // games that read held keys
  };
}

const garden = await launch('signal-garden.html', 400, 720);
garden.advance(2); // the attract garden plays behind the title panel and never wilts
assert.equal(garden.node('ovTitle').textContent, 'SIGNAL GARDEN');
garden.node('btnPrimary').click();
assert.equal(garden.node('overlay').hidden, true);
assert.equal(garden.node('goalN').textContent, 'GOAL 1/13');
// The tall garden at 400x720: 40px cells scaled by 392/360, offset (4, 70). Row 3 sits between two trail runs.
const plot = (c, r) => [4 + (c * 40 + 20) * (392 / 360), 70 + (r * 40 + 20) * (392 / 360)];
garden.node('seedThorn').click();
for (const c of [3, 4, 5]) garden.pointer('pointerdown', ...plot(c, 3));
garden.advance(0.5);
assert.equal(globalThis.__signalGarden.state().towers, 3, 'three Thornlings planted on open plots');
assert.equal(garden.node('goalN').textContent, 'GOAL 2/13', 'planting three seedlings completes mission 1');
garden.pointer('pointerdown', ...plot(1, 2)); // the trail itself is never plantable
assert.equal(globalThis.__signalGarden.state().towers, 3);
globalThis.__signalGarden.autopilot(true);
for (let i = 0; i < 120 && garden.node('overlay').hidden; i++) garden.advance(1);
const grown = globalThis.__signalGarden.state();
assert.ok(grown.done >= 4 && grown.kills >= 30 && grown.wave >= 3, `migrations must fall and missions advance, got ${JSON.stringify(grown)}`);
garden.key('KeyP');
assert.equal(garden.node('ovTitle').textContent, 'PAUSED');
garden.key('KeyR');
assert.equal(garden.node('goalN').textContent, 'GOAL 1/13', 'restart resets the ladder');
assert.equal(globalThis.__signalGarden.state().score, 0);
globalThis.__signalGarden.autopilot(false);
garden.key('Space'); // an unplanted garden: every pest reaches the Heartbloom
for (let i = 0; i < 400 && garden.node('ovTitle').textContent !== 'GARDEN WILTED'; i++) garden.advance(0.5);
assert.equal(garden.node('ovTitle').textContent, 'GARDEN WILTED');
assert.equal(garden.node('btnPrimary').textContent, 'Replant');
garden.node('btnPrimary').click();
assert.equal(globalThis.__signalGarden.state().heart, 20, 'replant starts a fresh garden');
console.log(`Signal Garden: hand planting, ${grown.done} missions over ${grown.wave} migrations on autopilot, pause/restart, loss (GARDEN WILTED), replant`);
const voyage = await launch('nebula-fusion.html', 460, 760);
voyage.node('btnStart').click();
assert.equal(voyage.node('goalN').textContent, 'GOAL 1/15');
// Space on the collapse screen starts a new voyage, so stop dropping once the run ends (its mission tally is
// written then) and count missions from that tally; otherwise a collapsed seed is measured as a fresh run.
for (let i = 0; i < 60 && !voyage.node('overGoals').textContent; i++) { voyage.key('Space'); voyage.advance(.65); }
const tally = voyage.node('overGoals').textContent;
const reached = tally ? Number(tally.split('/')[0]) : Number(/GOAL (\d+)/.exec(voyage.node('goalN').textContent)?.[1]) - 1;
assert.ok(reached >= 2, `missions must advance from center drops, got ${tally || voyage.node('goalN').textContent}`);
assert.ok(Number(voyage.node('scoreV').textContent.replaceAll(',', '')) > 0);
voyage.key('KeyP');
voyage.key('KeyR');
// A collapse begun by the last drops ignores keys until its screen shows; let it finish, then R restarts from there.
if (voyage.node('goalN').textContent !== 'GOAL 1/15') { voyage.advance(8); voyage.key('KeyR'); }
assert.equal(voyage.node('goalN').textContent, 'GOAL 1/15', 'restart resets the voyage');
console.log(`Nebula Fusion: Voyage: ${reached} missions done${tally ? ' before the well collapsed' : ''}, restart resets`);
const brigade = await launch('brick-brigade.html', 400, 720);
brigade.advance(2); // the attract demo plays behind the title panel and never ends the run
assert.equal(brigade.node('ovTitle').textContent, 'BRICK BRIGADE');
brigade.node('btnPrimary').click();
assert.equal(brigade.node('overlay').hidden, true);
assert.equal(brigade.node('goalN').textContent, 'GOAL 1/13');
globalThis.__brickBrigade.autopilot(true); // the game's own playtest handle: the carrier tracks the ball
// 180 s, not 90: about 1 random run in 30 had cleared only 2 missions by 90 s (measured; 0 of 30 short at 180 s).
for (let i = 0; i < 180 && brigade.node('overlay').hidden; i++) brigade.advance(1);
const run = globalThis.__brickBrigade.state();
assert.ok(run.done >= 3 && run.rescued >= 1, `missions and rescues must advance, got ${JSON.stringify(run)}`);
brigade.key('KeyP');
assert.equal(brigade.node('ovTitle').textContent, 'PAUSED');
brigade.key('KeyR');
assert.equal(brigade.node('goalN').textContent, 'GOAL 1/13', 'restart resets the ladder');
assert.equal(globalThis.__brickBrigade.state().score, 0);
globalThis.__brickBrigade.autopilot(false);
brigade.key('ArrowLeft'); // park the carrier in the corner: every ball is lost
for (let i = 0; i < 120 && brigade.node('ovTitle').textContent !== 'OUT OF LIVES'; i++) { brigade.key('Space'); brigade.advance(0.5); }
assert.equal(brigade.node('ovTitle').textContent, 'OUT OF LIVES');
assert.equal(brigade.node('btnPrimary').textContent, 'Redeploy');
brigade.node('btnPrimary').click();
assert.equal(globalThis.__brickBrigade.state().lives, 3, 'redeploy starts a fresh run');
console.log(`Brick Brigade: ${run.done} missions and ${run.rescued} rescues on autopilot, pause/restart, loss, redeploy`);
const deck = await launch('deck-guard.html', 400, 720);
deck.advance(2); // the attract demo flies behind the title panel and never loses
assert.equal(deck.node('ovTitle').textContent, 'DECK GUARD');
deck.node('btnPrimary').click();
assert.equal(deck.node('overlay').hidden, true);
assert.equal(deck.node('goalN').textContent, 'GOAL 1/13');
globalThis.__deckGuard.autopilot(true);
for (let i = 0; i < 60 && deck.node('overlay').hidden; i++) { deck.advance(1); if (i === 20 || i === 40) globalThis.__deckGuard.launchMissile(); }
const flight = globalThis.__deckGuard.state();
assert.ok(flight.done >= 1 && flight.downed >= 15, `the swarm must fall and missions advance, got ${JSON.stringify(flight)}`);
if (!deck.node('overlay').hidden) deck.node('btnPrimary').click(); // the autopilot can lose its jets first: that ends in the loss screen, and a new run starts
deck.key('KeyP');
assert.equal(deck.node('ovTitle').textContent, 'PAUSED');
deck.key('KeyR');
assert.equal(deck.node('goalN').textContent, 'GOAL 1/13', 'restart resets the ladder');
globalThis.__deckGuard.autopilot(false);
for (let i = 0; i < 400 && !/CRIPPLED|NO INTERCEPTORS/.test(deck.node('ovTitle').textContent); i++) { if (i % 20 === 0) globalThis.__deckGuard.launchMissile(); deck.advance(0.5); }
assert.match(deck.node('ovTitle').textContent, /CRIPPLED|NO INTERCEPTORS/, 'an undefended carrier falls');
deck.node('btnPrimary').click();
assert.equal(globalThis.__deckGuard.state().hull, 10, 'scramble again starts a fresh run');
console.log(`Deck Guard: ${flight.done} missions, ${flight.downed} drones and ${flight.missiles} missiles on autopilot, pause/restart, loss (${deck.node('ovTitle').textContent}), replay`);
const cadence = await launch('chroma-cadence.html', 420, 720);
const cc = () => globalThis.__chromaCadence.state();
const playOut = () => { for (let i = 0; i < 130 && cc().state === 'playing'; i++) cadence.advance(1); };
cadence.advance(1); // the menu sky and ambient loop run behind the title panel
assert.equal(cc().state, 'menu');
assert.equal(cadence.node('best0').textContent, 'NO BEST YET');
cadence.key('Digit1'); // CRUISE
cadence.key('Enter');
assert.equal(cc().state, 'playing');
assert.equal(cc().di, 0);
const seedA = cc().seed, gems = cc().notes;
assert.ok(gems >= 60, `a seeded song must chart real gems, got ${gems}`);
// A player whose audio reaches them 40 ms late: taps land as GOOD, and the results offer the fix.
globalThis.__chromaCadence.autopilot(true, 40);
playOut();
const laggy = cc();
assert.equal(laggy.state, 'results');
assert.equal(cadence.node('resTitle').textContent, 'TRACK CLEAR');
assert.equal(laggy.miss, 0, `a steady late player misses nothing, got ${JSON.stringify(laggy)}`);
assert.ok(laggy.good > 0, 'late taps land as GOOD');
assert.ok(laggy.meanErrMs >= 30 && laggy.meanErrMs <= 50, `timing reads about 40 ms late, got ${laggy.meanErrMs}`);
assert.match(cadence.node('rTiming').textContent, /ms LATE ON AVERAGE/);
assert.ok(laggy.syncSuggest >= 30 && laggy.syncSuggest <= 50, `sync suggestion near +40 ms, got ${laggy.syncSuggest}`);
assert.match(cadence.node('best0').textContent, /^BEST /, 'a clear records a best');
cadence.node('applySyncBtn').click();
assert.equal(cc().offsetMs, laggy.syncSuggest, 'one click applies the suggested sync');
cadence.key('Enter'); // retry the same seed
assert.equal(cc().seed, seedA);
assert.equal(cc().notes, gems, 'the same seed charts the same song');
playOut();
const synced = cc();
assert.equal(synced.miss, 0);
assert.equal(synced.good, 0, `with the sync applied the same late player hits every gem PERFECT, got ${JSON.stringify(synced)}`);
assert.equal(synced.grade, 'S');
assert.ok(synced.score > laggy.score);
cadence.key('Enter');
cadence.advance(4);
cadence.key('KeyP');
assert.equal(cc().state, 'paused');
const frozen = cc().songTime;
cadence.advance(3);
assert.equal(cc().songTime, frozen, 'a paused track does not move');
cadence.key('KeyP');
assert.equal(cc().state, 'resuming');
cadence.advance(0.5);
assert.equal(cc().state, 'resuming');
assert.equal(cc().songTime, frozen, 'the count-in holds the track still');
cadence.advance(2.5);
assert.equal(cc().state, 'playing');
assert.ok(cc().songTime > frozen, 'after the count-in the track moves again');
globalThis.__chromaCadence.autopilot(false); // stop playing: the chroma meter drains
playOut();
assert.equal(cc().state, 'failed');
assert.equal(cadence.node('resTitle').textContent, 'CHROMA DEPLETED');
assert.equal(cc().grade, 'F');
cadence.key('KeyN');
assert.equal(cc().state, 'playing');
assert.equal(cc().chroma, 100, 'a new song starts with a full meter');
console.log(`Chroma Cadence: ${gems} gems; 40 ms late reads ${laggy.meanErrMs} ms (${laggy.good} GOOD), sync +${laggy.syncSuggest} ms then ${synced.perfect} PERFECT rank ${synced.grade}; pause holds, count-in resumes; loss; new song`);
const wide = await launch('gravity-gambit.html', 942, 600);
wide.advance(0.2);
assert.equal(globalThis.__gravityGambit.state().portrait, false, 'a landscape panel keeps the course landscape');
const gambit = await launch('gravity-gambit.html', 400, 720);
const gs = () => globalThis.__gravityGambit.state();
gambit.advance(1); // sector 1 is the scenic backdrop behind the title panel
assert.equal(gs().state, 'title');
assert.equal(gs().portrait, true, 'a 400x720 panel turns the course upright');
assert.ok(gs().scale > 0.36, `the turned course draws larger than the 0.25 landscape fit, got ${gs().scale}`);
gambit.key('Enter');
assert.equal(gs().state, 'aim');
assert.equal(gs().sector, 1);
// Sling on the turned screen: pull straight DOWN and release. Screen down is world -x, so the probe
// must launch along world +x, toward the wormhole.
gambit.pointer('pointerdown', 200, 500);
gambit.pointer('pointermove', 200, 560);
assert.ok(Math.abs(gs().aimAngle) < 0.02, `pulling down on the turned screen aims at world +x, got ${gs().aimAngle}`);
gambit.pointer('pointerup', 200, 560);
assert.equal(gs().state, 'flight');
assert.equal(gs().strokes, 1);
gambit.advance(0.3);
gambit.key('KeyR'); // recall mid-flight
assert.equal(gs().lastEnd, 'recall');
gambit.advance(1);
assert.equal(gs().state, 'aim');
globalThis.__gravityGambit.aim(Math.atan2(760 - 450, 820 - 170), 0.5); // straight into sector 1's rock
gambit.key('Space');
for (let i = 0; i < 100 && gs().state === 'flight'; i++) gambit.advance(0.1);
assert.equal(gs().lastEnd, 'crash');
gambit.advance(1);
assert.equal(gs().state, 'aim');
assert.equal(gs().strokes, 2, 'the recalled launch and the crashed launch both count');
gambit.key('KeyP');
assert.equal(gs().state, 'pause');
const held = gs().tSim;
gambit.advance(1);
assert.equal(gs().tSim, held, 'pause freezes the orbits');
gambit.key('KeyP');
assert.equal(gs().state, 'aim');
// Every sector, on autopilot: solve() searches with the flight's own integrator, and the flight must
// then follow that exact path into the wormhole. Moving sectors wait for their window.
const labels = [];
for (let n = 1; n <= 10; n++) {
  assert.equal(gs().sector, n);
  let shot = null;
  for (let t = 0; t < 24 && !shot; t++) { shot = globalThis.__gravityGambit.solve(); if (!shot) gambit.advance(0.5); }
  assert.ok(shot, `sector ${n}: a capturing shot exists`);
  gambit.key('Space');
  for (let i = 0; i < 400 && gs().state === 'flight'; i++) gambit.advance(0.1);
  assert.equal(gs().lastEnd, 'goal', `sector ${n}: the flight follows the predicted path into the wormhole, got ${gs().lastEnd}`);
  gambit.advance(1.2); // the capture flourish, then the result card
  labels.push(gs().label);
  gambit.key('Enter');
}
assert.equal(gs().state, 'final', 'the last sector opens the mission debrief');
gambit.key('Enter');
assert.equal(gs().state, 'aim');
assert.equal(gs().sector, 1, 'play again restarts at sector 1');
console.log(`Gravity Gambit: portrait at scale ${gs().scale.toFixed(2)}, turned sling aims true, recall, crash, pause; all 10 sectors solved and flown into the wormhole (${labels.join(', ')}); debrief; replay`);
const fathom = await launch('silent-fathom.html', 400, 720);
const sf = () => globalThis.__silentFathom.state();
fathom.advance(1); // the abyss drifts behind the title panel
assert.equal(sf().state, 'menu');
assert.ok(sf().viewScale < 0.7, `a 400 px panel zooms the view out so the sub can see as far as it can be heard, got ${sf().viewScale}`);
globalThis.__silentFathom.seed(424242);
fathom.key('Enter');
assert.equal(sf().state, 'splash');
fathom.advance(2.6);
assert.equal(sf().state, 'playing');
assert.equal(sf().zone, 1);
assert.equal(sf().litSegs, 0, 'the cave is black until the first ping');
fathom.key('Space');
fathom.advance(1);
const lit = sf().litSegs;
assert.ok(lit > 20, `a ping paints the cave walls, got ${lit}`);
assert.equal(sf().pings, 1);
fathom.key('Space'); // still inside the 1.25 s cooldown
assert.equal(sf().pings, 1, 'a ping inside the cooldown is ignored');
fathom.advance(0.5);
fathom.key('Space');
assert.equal(sf().pings, 2);
fathom.key('KeyD'); // engines on
fathom.advance(1);
const loud = sf().noise;
fathom.up('KeyD'); // engines off
fathom.advance(3);
assert.ok(loud > 0.5 && sf().noise < 0.2, `thrust is loud and silence settles, got ${loud} then ${sf().noise}`);
fathom.key('KeyP');
assert.equal(sf().state, 'paused');
const stillT = sf().gameT;
fathom.advance(1);
assert.equal(sf().gameT, stillT, 'pause freezes the abyss');
fathom.key('KeyP');
assert.equal(sf().state, 'playing');
// The full descent on autopilot, hull locked: every zone's recorders and exit must be reachable.
globalThis.__silentFathom.god(true);
globalThis.__silentFathom.autopilot('explore');
let zonesSeen = 1;
for (let i = 0; i < 1500 && sf().state !== 'won'; i++) {
  fathom.advance(1);
  if (i % 4 === 0 && sf().state === 'playing') fathom.key('Space'); // sonar every few seconds
  zonesSeen = Math.max(zonesSeen, sf().zone);
}
const surfaced = sf();
assert.equal(surfaced.state, 'won', `the autopilot surfaces through all 5 zones, got ${JSON.stringify(surfaced)}`);
assert.equal(zonesSeen, 5);
assert.ok(surfaced.heard > 0, 'the leviathans hear the sub on the way down');
assert.equal(fathom.node('winScore').textContent, surfaced.score);
// Loss: hull unlocked, steer into the mines.
globalThis.__silentFathom.god(false);
fathom.key('Enter');
fathom.advance(2.6);
assert.equal(sf().hull, 3);
globalThis.__silentFathom.autopilot('mines');
for (let i = 0; i < 300 && sf().state !== 'dead'; i++) fathom.advance(0.5);
const lost = sf();
assert.equal(lost.state, 'dead', `an undefended hull breaks, got ${JSON.stringify(lost)}`);
assert.equal(fathom.node('overCause').textContent, lost.cause);
assert.ok(lost.cause.length > 0, 'the game-over card names the cause');
fathom.key('Enter');
assert.equal(sf().state, 'splash');
assert.equal(sf().zone, 1, 'dive again restarts at zone 1');
console.log(`Silent Fathom: view zoom ${sf().viewScale.toFixed(2)}, ping lit ${lit} wall segments, cooldown holds, engines loud then quiet, pause; autopilot surfaced through 5 zones (score ${surfaced.score}, heard ${surfaced.heard} times); loss (${lost.cause}); dive again`);
const sky = await launch('skyhook.html', 400, 720);
const sh = () => globalThis.__skyhook.stats();
sky.advance(1); // the cavern scrolls behind the title panel
assert.equal(sh().state, 'menu');
assert.equal(sh().viewScale, 0.5, 'a 400 px panel zooms out so the anchors in rope reach are on screen');
assert.equal(sky.node('bestMenu').textContent, 'NO RUNS YET: THE CAVERN AWAITS');
globalThis.__skyhook.seed(9973);
sky.node('btnStart').click();
assert.equal(sh().state, 'play');
// Hold to latch, swing, let go: the release is a clean swing and starts the FLOW chain.
sky.key('Space');
sky.advance(0.1);
assert.ok(sh().attached, 'holding Space latches the nearest anchor');
sky.advance(0.6);
sky.up('Space');
sky.advance(0.05);
assert.ok(!sh().attached && sh().flow === 1 && sh().metres > 0, `releasing flings forward, got ${JSON.stringify(sh())}`);
sky.key('Escape');
const pausedAt = sh().dist;
sky.advance(1);
assert.equal(sh().state, 'pause');
assert.equal(sh().dist, pausedAt, 'pause freezes the run');
sky.node('btnRestartP').click();
assert.ok(sh().state === 'play' && sh().metres === 0, 'restart from pause begins a fresh run');
// Every anchor stays within rope reach of the floor under it. Anchors used to hang up to about 620 px
// above the floor of a tall cave, so a player who touched the floor there could never latch again.
let reachWorst = 0;
for (const s of [1, 48514, 123456]) {
  globalThis.__skyhook.seed(s);
  for (const a of globalThis.__skyhook.anchorsTo(300000)) reachWorst = Math.max(reachWorst, a.floor - a.y);
}
assert.ok(reachWorst <= 330.5, `an anchor hangs ${reachWorst} px above the floor, out of the rope's reach`);
// A new player who does not press at once: on seed 48514 they used to land, slide back behind the
// first anchor and never latch again. Now a crystal hangs over the spawn and the next swing is there.
for (const wait of [2, 4]) {
  sky.key('Escape');
  sky.node('btnMenuP').click();
  globalThis.__skyhook.seed(48514);
  sky.node('btnStart').click();
  sky.advance(wait);
  sky.key('Space');
  sky.advance(0.3);
  assert.ok(sh().attached, `after ${wait} s on the floor, holding Space must latch`);
  sky.up('Space');
}
// The seeded cavern on autopilot (latch, reel on the downswing, release rising) carries a long run;
// then, with no input, the Cascade catches up.
globalThis.__skyhook.seed(9973); // takes effect at the restart below
sky.key('Escape');
sky.node('btnRestartP').click();
globalThis.__skyhook.autopilot(true);
for (let i = 0; i < 240 && sh().state === 'play' && sh().metres < 2000; i++) sky.advance(0.5);
const swung = sh();
assert.ok(swung.state === 'play' && swung.metres >= 2000 && swung.flowBest >= 5, `the autopilot must carry a long run, got ${JSON.stringify(swung)}`);
globalThis.__skyhook.autopilot(false);
for (let i = 0; i < 120 && sh().state === 'play'; i++) sky.advance(0.5);
sky.advance(1.5); // the death slow-motion plays before the results
const caught = sh();
assert.equal(caught.state, 'dead');
assert.equal(sky.node('deadTitle').textContent, caught.deathBy === 'abyss' ? 'SWALLOWED BY THE ABYSS' : 'THE CASCADE TAKES YOU');
// The results card groups thousands with a space: 2087 m reads "2 087 m".
assert.equal(sky.node('dDist').textContent, `${Math.floor(caught.metres / 1000)} ${String(caught.metres % 1000).padStart(3, '0')} m`);
assert.equal(sky.node('dBest').textContent, sky.node('dDist').textContent, 'the longest run is the best');
sky.node('btnRestart').click();
assert.ok(sh().state === 'play' && sh().metres === 0, 'dive again begins a fresh run');
sky.key('Escape');
sky.node('btnMenuP').click();
assert.equal(sh().state, 'menu');
assert.equal(sky.node('bestMenu').textContent, `BEST DISTANCE: ${sky.node('dBest').textContent}`, 'the best run carries to the menu');
console.log(`Skyhook: view zoom ${sh().viewScale}, latch and fling (FLOW 1), pause, restart; every anchor within ${reachWorst | 0} px of its floor; latch after landing; autopilot past ${swung.metres} m (FLOW x${swung.flowBest}), then caught idle at ${caught.metres} m (${sky.node('deadTitle').textContent}); best kept on the menu`);
console.log('P-GAME.1 demo passed.');
