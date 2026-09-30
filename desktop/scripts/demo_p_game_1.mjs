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

const merge = await launch('orbit-loom.html', 360, 520);
merge.node('overlay-action').click();
assert.equal(merge.node('overlay').hidden, true);
for (let i = 0; i < 22; i++) { merge.node('drop').click(); merge.advance(2.2); }
assert.ok(Number(merge.node('score').textContent.replaceAll(',', '')) > 0, 'matching orbs must score');
merge.node('pause').click();
assert.equal(merge.node('overlay-title').textContent, 'Orbit paused');
merge.node('overlay-action').click();
assert.equal(merge.node('overlay').hidden, true);
merge.node('restart').click();
assert.equal(merge.node('score').textContent, '0');
for (let i = 0; i < 180 && merge.node('overlay-title').textContent !== 'Orbit lost'; i++) {
  merge.node('drop').click(); merge.advance(1.5);
}
assert.equal(merge.node('overlay-title').textContent, 'Orbit lost');
merge.node('overlay-action').click();
assert.equal(merge.node('score').textContent, '0');
console.log('Orbit Loom: fusion score, pause/resume, danger loss, replay');

const defense = await launch('signal-garden.html', 450, 550);
defense.node('veilButton').click();
for (const [x, y] of [[3, 1], [6, 3], [3, 4]]) {
  defense.node('pulse').click(); defense.pointer('pointerdown', x * 50 + 25, y * 50 + 25);
}
assert.equal(defense.node('credits').textContent, '5', 'three towers cost 135 credits');
defense.node('speed').click();
const plots = [[6, 6], [4, 7], [2, 3], [6, 1], [4, 4], [1, 7], [8, 6]];
for (let wave = 1; wave <= 8; wave++) {
  if (wave > 1) {
    const [x, y] = plots[wave - 2];
    defense.node(Number(defense.node('credits').textContent) >= 95 ? 'mortar' : 'pulse').click();
    defense.pointer('pointerdown', x * 50 + 25, y * 50 + 25);
    if (!defense.node('upgrade').disabled) defense.node('upgrade').click();
  }
  defense.node('send').click();
  for (let i = 0; i < 700 && defense.node('send').disabled && defense.node('veil').hidden; i++) defense.advance(.05);
  assert.equal(defense.node('wave').textContent, `${wave} / 8`);
  if (wave < 8) assert.equal(defense.node('send').disabled, false, `wave ${wave} must finish`);
}
assert.equal(defense.node('status').textContent, 'Victory! The garden holds.');
defense.node('veilButton').click();
for (let wave = 0; wave < 2; wave++) {
  defense.node('send').click();
  for (let i = 0; i < 700 && defense.node('veil').hidden && defense.node('send').disabled; i++) defense.advance(.05);
}
assert.equal(defense.node('veilTitle').textContent, 'Heart extinguished');
defense.node('veilButton').click();
assert.equal(defense.node('heart').textContent, 12);
assert.equal(defense.node('wave').textContent, '0 / 8');
console.log('Signal Garden: tower economy, eight-wave victory, undefended defeat, replay');
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
