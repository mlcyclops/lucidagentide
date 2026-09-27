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
console.log('P-GAME.1 demo passed.');
