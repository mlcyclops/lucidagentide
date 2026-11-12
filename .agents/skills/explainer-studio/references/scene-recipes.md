# Scene, lighting, camera, and console recipes

Original recipes for a procedural three.js explainer. They use only core three.js plus two addons
(`OrbitControls`, `CSS2DRenderer`). Adjust colours and sizes to the plan; keep the structure.

## Files and vendoring

```text
my-explainer/
  index.html          tiny: stage, console markup, import map, one module script
  main.js             scene, chapters, console wiring
  math.js             the exact-math module (pure, no DOM, no three)
  style.css
  vendor/three/       three.module.js, three.core.js, addons/controls/OrbitControls.js,
                      addons/renderers/CSS2DRenderer.js (copied from the installed three package)
```

```html
<script type="importmap">
{ "imports": { "three": "./vendor/three/three.module.js", "three/addons/": "./vendor/three/addons/" } }
</script>
<script type="module" src="./main.js"></script>
```

The addons import the bare specifier `three`, which the import map resolves. Copy only the addons you use.
If `preview_inspect` reports a module load error in the LUCID Preview frame, bundle instead
(`bun build main.js --minify --outfile=dist/main.js`) and load the single bundled file.

## Renderer, scene, camera, resize

```js
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const host = document.getElementById('stage');
const capture = new URLSearchParams(location.search).has('capture'); // verification capture mode
const renderer = new THREE.WebGLRenderer({
  antialias: true, powerPreference: 'high-performance',
  preserveDrawingBuffer: capture, // only while a script is taking screenshots
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // the clamp is part of the budget
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
host.appendChild(renderer.domElement);

const labels = new CSS2DRenderer();
labels.domElement.className = 'labels';
host.appendChild(labels.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);

function fit() {
  const w = host.clientWidth, h = host.clientHeight;
  renderer.setSize(w, h, false); // CSS gives the canvas width/height 100%
  labels.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  requestRender();
}
new ResizeObserver(fit).observe(host);
```

## Sky gradient and fog

```js
function makeSky({ zenith = '#14213d', mid = '#3d5a80', horizon = '#f4a261', radius = 90 } = {}) {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      zenith: { value: new THREE.Color(zenith) },
      mid: { value: new THREE.Color(mid) },
      horizon: { value: new THREE.Color(horizon) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 zenith; uniform vec3 mid; uniform vec3 horizon;
      varying vec3 vDir;
      void main() {
        float h = clamp(vDir.y, -0.2, 1.0);
        vec3 low = mix(horizon, mid, smoothstep(-0.2, 0.25, h));
        vec3 c = mix(low, zenith, smoothstep(0.25, 1.0, h));
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), material);
  sky.renderOrder = -1;
  return sky;
}
scene.add(makeSky());
scene.fog = new THREE.Fog('#f4a261', 25, 80); // the horizon colour, so the ground melts into the sky
```

Keep `radius` below the camera's far plane and above `controls.maxDistance` plus the stage size.

## Light rig and ground

```js
const hemi = new THREE.HemisphereLight('#bcd4ff', '#3a2e2a', 0.9); // sky fill, warm bounce
const sun = new THREE.DirectionalLight('#ffd7a8', 2.2);
sun.position.set(6, 10, 4);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 1, far: 30 }); // fit the stage
sun.shadow.camera.updateProjectionMatrix();
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
scene.add(hemi, sun, sun.target);

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(60, 64),
  new THREE.MeshStandardMaterial({ color: '#2b2f3a', roughness: 0.95 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
```

A tight shadow camera is the difference between crisp contact shadows and mush. Never add a second shadowed
light to fix a dark area; raise the hemisphere intensity instead.

## Controls, views, and the cinematic camera

```js
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 4;
controls.maxDistance = 30;
controls.maxPolarAngle = Math.PI * 0.48; // never under the ground
controls.addEventListener('start', () => cinematic.stop());

const VIEWS = {
  overview: { pos: [9, 6, 11], target: [0, 1, 0] },
  close: { pos: [3, 2.2, 4], target: [0, 1.2, 0] },
  top: { pos: [0, 14, 0.01], target: [0, 0, 0] },
};
const easeInOutCubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
let tween = null;

function goToView(name, seconds = reducedMotion() ? 0 : 0.8) {
  const v = VIEWS[name];
  if (!v) return;
  state.view = name;
  tween = {
    t: 0, dur: seconds,
    fromP: camera.position.clone(), fromT: controls.target.clone(),
    toP: new THREE.Vector3(...v.pos), toT: new THREE.Vector3(...v.target),
  };
  requestRender();
}

function stepTween(dt) {
  if (!tween) return false;
  tween.t = tween.dur > 0 ? Math.min(1, tween.t + dt / tween.dur) : 1;
  const k = easeInOutCubic(tween.t);
  camera.position.lerpVectors(tween.fromP, tween.toP, k);
  controls.target.lerpVectors(tween.fromT, tween.toT, k);
  if (tween.t >= 1) tween = null;
  return true;
}

const cinematic = {
  on: false, angle: 0,
  start() {
    if (reducedMotion()) return;
    const d = camera.position.clone().sub(controls.target);
    this.angle = Math.atan2(d.x, d.z);
    this.on = true;
    requestRender();
  },
  stop() { this.on = false; },
};

function stepCinematic(dt) {
  if (!cinematic.on) return false;
  const d = camera.position.clone().sub(controls.target);
  const r = Math.hypot(d.x, d.z);
  cinematic.angle += dt * 0.12; // slow: about 52 s per lap
  camera.position.set(controls.target.x + r * Math.sin(cinematic.angle), camera.position.y,
    controls.target.z + r * Math.cos(cinematic.angle));
  return true;
}
```

## The loop: render on demand, injectable time, pause when hidden

```js
const clock = { now: () => performance.now() / 1000 }; // replaced in capture mode
let last = clock.now();
let dirty = true;
function requestRender() { dirty = true; }

function frame() {
  const t = clock.now();
  const dt = Math.min(0.05, t - last);
  last = t;
  const a = stepTween(dt);
  const b = stepCinematic(dt);
  const c = stepChapter(dt);          // your chapter animation; returns true while it moves
  const moved = controls.update();    // true while damping is still settling
  if (a || b || c || moved || dirty) {
    renderer.render(scene, camera);
    labels.render(scene, camera);
    dirty = false;
  }
}

let onScreen = true;
function syncLoop() {
  const run = !capture && !document.hidden && onScreen;
  if (run) last = clock.now();
  renderer.setAnimationLoop(run ? frame : null);
}
document.addEventListener('visibilitychange', syncLoop);
new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; syncLoop(); }).observe(host);
syncLoop();

// Capture mode: the verification script owns time, so clips and posters are deterministic.
if (capture) {
  let simTime = 0;
  clock.now = () => simTime;
  last = 0;
  window.__explainer = {
    step(dt) { simTime += dt; frame(); },
    chapter(n) { setChapter(n); },
    view(name) { goToView(name, 0); },
    cinematic(on) { if (on) cinematic.start(); else cinematic.stop(); },
  };
}
```

No `Math.random()` drives anything visible unless it is a seeded generator, so the same state always draws
the same picture.

## State, URL hash, and reduced motion

```js
const state = { chapter: 1, view: 'overview', level: 'older', labels: true, calm: false };

function writeHash() {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(state)) p.set(k, String(v));
  history.replaceState(null, '', '#' + p.toString());
}
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const ch = Number.parseInt(p.get('chapter') ?? '', 10);
  if (Number.isInteger(ch) && ch >= 1 && ch <= CHAPTERS.length) state.chapter = ch;
  if (p.get('view') in VIEWS) state.view = p.get('view');
  if (p.get('level') === 'younger' || p.get('level') === 'older') state.level = p.get('level');
}

const rm = matchMedia('(prefers-reduced-motion: reduce)');
const reducedMotion = () => rm.matches || state.calm;
rm.addEventListener('change', () => { if (reducedMotion()) cinematic.stop(); });
```

Validate every hash value against its range; an invalid value is ignored, never trusted.

## Floating labels

```js
function makeLabel(text, className = 'tag') {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text; // textContent, never innerHTML
  return new CSS2DObject(el);
}
// toggle all: labels.domElement.hidden = !state.labels;
```

## Instancing

```js
const gemGeo = new THREE.IcosahedronGeometry(0.18, 0);
const gemMat = new THREE.MeshStandardMaterial({ color: '#7dd3fc', roughness: 0.35, flatShading: true });
const gems = new THREE.InstancedMesh(gemGeo, gemMat, 1000); // capacity; draw only `count`
gems.castShadow = true;
scene.add(gems);

const m = new THREE.Matrix4();
function layoutGems(n) {
  for (let i = 0; i < n; i++) {
    m.makeTranslation((i % 10) * 0.4 - 1.8, 0.2 + Math.floor(i / 100) * 0.4, (Math.floor(i / 10) % 10) * 0.4 - 1.8);
    gems.setMatrixAt(i, m);
  }
  gems.count = n;
  gems.instanceMatrix.needsUpdate = true;
  gems.computeBoundingSphere();
  requestRender();
}
```

One `InstancedMesh` is one draw call for all of them. Per-instance colour: `setColorAt(i, color)` then
`instanceColor.needsUpdate = true`.

## Disposal on rebuild

```js
function disposeOwned(root) {
  root.traverse((o) => {
    o.geometry?.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const mat of mats) {
      for (const v of Object.values(mat)) if (v && v.isTexture) v.dispose();
      mat.dispose();
    }
  });
  root.removeFromParent();
}
```

Call it only on a group the chapter OWNS; shared geometries and materials are disposed once, at teardown.

## Console markup

```html
<div id="stage" role="img" aria-describedby="scene-desc"></div>
<p id="scene-desc" class="sr-only" aria-live="polite"></p>

<nav class="chapters" role="tablist" aria-label="Chapters">
  <button role="tab" aria-selected="true" data-chapter="1">1 Share</button>
  <button role="tab" aria-selected="false" data-chapter="2">2 Leftovers</button>
  <button role="tab" aria-selected="false" data-chapter="3">3 Check it</button>
</nav>

<section class="console" aria-label="Controls">
  <label for="gems">Gems</label>
  <button type="button" data-step="gems:-1" aria-label="One fewer gem">-</button>
  <input type="range" id="gems" min="0" max="999" step="1" value="156">
  <button type="button" data-step="gems:1" aria-label="One more gem">+</button>
  <output for="gems" id="gems-out">156</output>
  <p class="readout" id="readout" aria-live="polite"></p>
  <button type="button" id="replay">Play it again</button>
</section>

<div class="views" aria-label="Views">
  <button type="button" data-view="overview">Overview</button>
  <button type="button" data-view="close">Close up</button>
  <button type="button" data-view="top">Top</button>
  <button type="button" id="cine" aria-pressed="false">Cinematic</button>
</div>

<button type="button" id="writeup-open" aria-expanded="false" aria-controls="writeup">How it works</button>
<aside id="writeup" hidden>...</aside>
<div id="loading" role="status">Warming up the carts...</div>
```

## Keyboard map

```js
const KEYS = {
  v: () => cycleView(), c: () => (cinematic.on ? cinematic.stop() : cinematic.start()),
  l: () => toggleLabels(), r: () => replayChapter(), '?': () => toggleHelp(), w: () => toggleWriteup(),
};
addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target instanceof Element && e.target.closest('input, textarea, select')) return;
  if (/^[1-9]$/.test(e.key)) { setChapter(Number(e.key)); return; }
  const fn = KEYS[e.key.toLowerCase()] ?? KEYS[e.key];
  if (fn) { e.preventDefault(); fn(); }
});
```

Every key in `KEYS` appears in the `?` help list and in the write-up's Controls section.
