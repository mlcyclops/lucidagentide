# Sample build prompt: Gear Train Workbench

The prompt a user (or a parent agent) hands to a builder agent once `PLAN.md` from `sample-plan.md` is
approved. A good build prompt names the goal, the audience, the plan as the contract, the files, the
constraints, and the evidence it wants back. Adapt the nouns; keep the shape.

---

Build the explainer described in `gear-train-workbench/PLAN.md`. The plan is the contract: every chapter,
view, control, key, formula, honesty row, and verification step in it must exist in what you build. If you
find a mistake in the plan, stop and say so instead of quietly building something else.

**Audience.** Children aged 8 to 12, two levels (Younger and Older) switchable with `Y`. Warm, encouraging
copy at a 3rd to 6th grade reading level. No links out, no accounts, no data collection.

**Files.** Create exactly:

- `gear-train-workbench/index.html`: the stage, the console markup, an import map, one module script, and
  `<link rel="icon" href="data:,">`. No inline script.
- `gear-train-workbench/main.js`: scene, chapters, console, keyboard, write-up drawer, capture mode.
- `gear-train-workbench/math.js` and `math.test.js`: the exact-math module and its Bun test.
- `gear-train-workbench/style.css`.
- `gear-train-workbench/vendor/three/`: `three.module.js`, `three.core.js`, and only the addons you use
  (`OrbitControls`, `CSS2DRenderer`), copied from the installed three package. Nothing from a CDN.

**Scene.** Procedural only: a gradient sky sphere with matching fog, hemisphere fill plus one shadowed warm
key light, a wooden bench on a ground disc that fades into the fog. Gears are `ExtrudeGeometry` from a
`Shape` generated from the tooth count at one shared tooth size; cache by count and dispose evicted ones.
OrbitControls with damping and clamped angles; Workbench, Face-on, and Top presets eased over about 0.8 s;
a cinematic orbit any input cancels.

**Math.** Tooth counts are integers and every ratio or turn count is a reduced rational from `math.js`.
Ratios show as `a : b` in lowest terms, turns as mixed numbers. No float ever reaches the screen. Run the
self-tests in `?selftest` mode and under `bun test`.

**Console.** Chapter tabs 1 to 5, steppers for each tooth count (8 to 60), idler toggle, Space turns the
driver one full turn, live readouts in each gear's accent colour, Play it again, the `?` shortcut list,
toggleable labels (`L`), a Calm switch, and a short themed loading line in your own words.

**Write-up drawer** (`W`): How it works, The idea, Worked examples (exact arithmetic), What's real, What's
calculated, What's drawn to illustrate, What's simplified, Controls, and the simplified-models line. Use the
plan's honesty table; say the tooth shape is simplified and is not a true involute.

**Accessibility and performance.** Full keyboard operation, visible focus, `aria-live` readout, canvas text
alternative, reduced motion honoured. Pixel ratio clamped to 2, render on demand, loop paused when hidden or
off screen, under 40 draw calls, total transfer under 400 KB.

**Capture mode.** `?capture=1` replaces the clock and exposes `window.__explainer` with `step(dt)`,
`chapter(n)`, `view(name)`, and `cinematic(on)`, as in the explainer-studio scene recipes.

**Evidence to return.**

1. `preview_inspect` `what: "errors"` showing zero errors, and `preview_screenshot` of every chapter.
2. The headless Chromium capture JSON (`errorCount`, `transferKB`, shot paths) for
   `--chapters 5 --views workbench,face,top --clip 6`.
3. `poster.webp`, per-chapter posters, `preview.webm` and `preview.mp4` with their sizes from `ffprobe`.
4. `bun test` output for `math.test.js`.
5. `renderer.info.render.calls` and triangles for the busiest chapter.
6. A list of anything you could not run, marked unverified, with the command that would verify it.

Do not copy code, text, names, or layouts from sael.net or any other explainer; it is a style reference only.
