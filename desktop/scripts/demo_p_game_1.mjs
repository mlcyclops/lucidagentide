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
    pointer(kind, x, y) { handlers.get(`${this.id}:${kind}`)?.({ button: 0, pointerId: 1, clientX: x, clientY: y, target: this }); }
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
  return { node, advance, pointer: (kind, x, y) => node('field').pointer(kind, x, y), key: code => handlers.get('window:keydown')?.({ code, preventDefault() {} }) };
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
for (let i = 0; i < 60; i++) { voyage.key('Space'); voyage.advance(.65); }
const reached = Number(/GOAL (\d+)/.exec(voyage.node('goalN').textContent)?.[1]);
assert.ok(reached >= 3, `missions must advance from center drops, got ${voyage.node('goalN').textContent}`);
assert.ok(Number(voyage.node('scoreV').textContent.replaceAll(',', '')) > 0);
voyage.key('KeyP');
voyage.key('KeyR');
assert.equal(voyage.node('goalN').textContent, 'GOAL 1/15', 'restart resets the voyage');
console.log(`Nebula Fusion: Voyage: missions advanced to ${reached}, restart resets`);
const brigade = await launch('brick-brigade.html', 400, 720);
brigade.advance(2); // the attract demo plays behind the title panel and never ends the run
assert.equal(brigade.node('ovTitle').textContent, 'BRICK BRIGADE');
brigade.node('btnPrimary').click();
assert.equal(brigade.node('overlay').hidden, true);
assert.equal(brigade.node('goalN').textContent, 'GOAL 1/13');
globalThis.__brickBrigade.autopilot(true); // the game's own playtest handle: the carrier tracks the ball
for (let i = 0; i < 90 && brigade.node('overlay').hidden; i++) brigade.advance(1);
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
console.log('P-GAME.1 demo passed.');
