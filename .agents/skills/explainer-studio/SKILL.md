---
name: explainer-studio
description: "Build premium interactive 3D explainers: one procedural three.js page that teaches ONE idea through chapters, camera views, a console of controls, exact live numbers, and an honest write-up. Use this skill whenever the user asks for an interactive explainer, a 3D lesson, a visual simulation of a concept, a sael.net-style explainer, an educational three.js scene, or a kid-friendly interactive model of math, science, civics, or how a machine works, even if they never say 'explainer'. Read it before writing PLAN.md or any scene code. Pair it with explainer-assets-gpu when the explainer needs generated textures, CAD parts, narration, presenter video, baked simulation data, or preview clips."
---

# Explainer Studio

An explainer is a teaching instrument, not a demo reel. The learner should be able to change one thing, watch
the model respond, read the exact number that changed, and then read a short, honest account of what was real,
what was calculated, and what was drawn only to illustrate.

**Inspiration and credit.** The bar comes from Ryan Sael's free interactive explainers at
`https://sael.net/explainers`. Treat them as a style reference ONLY. You NEVER copy their code, text, names,
chapter structures, or layouts, and you never name an explainer after one of his. Credit him as the
inspiration when the user publishes a collection built with this skill.

## The quality bar

These numbers come from profiling twelve sael.net explainers live in Chromium (fraction-kitchen, heart-pump,
soap-bubble, periodic-table, internet, electricity, river-bend, earthquake-tower, plane-of-focus, flatpack,
pendulum-rhythm, lightning-path). Every one was procedural three.js, and that is the default here.

- **Procedural first.** Geometry, materials, skies, and motion are generated in code. Total transfer for the
  page is **under 1 MB** (the profiled set ran 0.3 to 0.9 MB). No glTF/GLB models, no HDR/EXR environment
  maps, no KTX2 textures, no WASM physics, no Gaussian splats, unless the `explainer-assets-gpu` skill's
  budget rules justify one specific asset and PLAN.md records why.
- **Runtime is the viewer's own GPU through WebGL.** No server, no network after load. three.js is vendored
  next to the page (current releases' `build/three.module.js` imports `./three.core.js`, so ship both, plus
  each addon you use); never load it from a CDN.
- **Media is small.** The only video is a short muted preview clip (about 25 to 260 KB) and a poster image.
- **The structure is complete.** At least 3 chapters, at least 2 camera views plus a cinematic toggle, a slim
  console (chapter tabs, sliders, +/- steppers, live readouts, a replay action), keyboard shortcuts with a
  `?` help list, toggleable floating labels, a short themed loading line, and a write-up drawer with the
  honesty sections below and a "these are simplified models" line.

`references/quality-bar.md` has the full checklist used to grade a finished explainer.

## Workflow

1. **Plan first.** Write `PLAN.md` with every section in the next list before any scene code. Show it to the
   user and build only once it is complete and, when a user is present, approved. A plan with a missing
   section is not a plan.
2. **Pure math module first.** Write the exact-math module and its self-test before the scene (see Exact math).
3. **Skeleton.** Renderer, sky, lights, ground, camera presets, the console shell, the state object, the
   loading line. Verify it renders with zero console errors before adding chapters.
4. **One chapter at a time.** Build, then verify that chapter (screenshot, readouts, keyboard path) before
   starting the next one.
5. **Write-up.** Fill the drawer from the plan's honesty table; every sentence must be true.
6. **Verify and report** (see Verification). "It should work" is not a report.

## PLAN.md sections (all required)

1. **Goal**: one sentence naming the single idea the learner leaves with.
2. **Audience and levels**: ages, prior knowledge, and what changes between a younger and an older level.
3. **The idea and misconceptions**: the core insight and the two or three wrong ideas the scene must break.
4. **Chapters**: for each, what the learner does, what the scene shows, which readouts change, and the success
   check that ends it.
5. **Views**: named camera presets, what each is for, and the cinematic camera's path.
6. **Console and keyboard map**: every control with its label, range, step, default, and key.
7. **Math model**: the exact number types, every formula, edge cases (zero, maximum, invalid input), and the
   self-test cases.
8. **Honesty table**: real, calculated, drawn to illustrate, simplified, one row per claim.
9. **Look**: palette (one accent colour per concept), lighting, camera, typography.
10. **Accessibility**: keyboard paths, live regions, text alternatives, reduced-motion behaviour.
11. **Performance budget**: transfer size, draw calls, instance counts, target frame rate.
12. **Assets**: "none" by default; otherwise each asset with its source, size, and the budget rule it meets.
13. **Kid safety**: required when the audience includes children.
14. **Verification plan**: the exact screenshots, checks, poster frames, and clip you will produce.
15. **Out of scope**: what this explainer deliberately does not teach.

A complete worked example is in `references/sample-plan.md`; a matching build prompt is in
`references/sample-build-prompt.md`.

## Scene, lighting, and camera

- **Sky and fog:** a large inside-out sphere with a two- or three-stop gradient shader (`depthWrite: false`),
  and `scene.fog` set to the horizon colour so the ground melts into the sky. Dusk palettes read well: a warm
  horizon under a deep blue zenith.
- **Lighting:** a `HemisphereLight` for soft fill plus ONE shadow-casting `DirectionalLight` whose shadow
  camera is fitted tightly to the stage. ACES filmic tone mapping, sRGB output. Avoid more than three lights.
- **Ground:** a large disc or plane with a subtle radial fade; the subject sits on a low plinth or table so it
  has a place in the world.
- **Camera:** `OrbitControls` with damping, a clamped polar angle (never under the ground), and min/max
  distance. Presets ease position and target together over about 0.8 s. The cinematic camera is a slow orbit
  or dolly that ANY user input cancels.
- **Materials:** `MeshStandardMaterial` with restrained roughness and metalness. The accent colour of a
  concept is the same in the scene, the label, and the readout that names it.

Copy-ready, original recipes (renderer setup, the sky shader, light rig, presets with easing, labels,
instancing, the visibility pause) are in `references/scene-recipes.md`.

## The console, chapters, and views

- **One state object** drives the scene, the console, and the readouts. Serialize it to the URL hash so any
  state, and therefore any screenshot, is reproducible.
- **Chapters** (tabs, keys `1` to `9`) each own a scene state, a one-line caption, and a goal. Switching
  tweens; it never snaps, except under reduced motion.
- **Controls** each have a visible label, a range, a step, a keyboard path, and a readout that updates on
  every change. Steppers move by exactly one step; sliders snap to steps so values stay exact.
- **Views** (named buttons, key `V` to cycle, `C` for cinematic) move only the camera, never the model.
- **Polish:** `?` toggles the shortcut list, `L` toggles floating labels, `R` replays the current chapter, and
  the loading line is short and themed ("Warming up the gem carts..." style, in your own words).

## Exact math

- Use integers and rationals: integer or `BigInt` numerator and denominator, reduced by gcd, sign on the
  numerator, comparison by cross-multiplication, lcm for common denominators.
- NEVER display a binary float. `0.1 + 0.2` must never reach the screen. Terminating decimals are printed
  exactly from the rational; any rounded value is shown with an approximately-equals sign and its precision.
- Real-world constants carry units and a source in the write-up; if you are unsure of a fact, leave it out.
- The math lives in a pure module with a self-test table that runs in a `?selftest` mode and under
  `bun test`. `references/exact-math.md` has an original rational type, mixed numbers, exact decimal
  expansion with repeating cycles, and a long-division stepper.

## The honesty write-up

The drawer is plain language at the audience's reading level, with these sections in this order:
**How it works**, **The idea**, **Worked examples** (with the exact arithmetic), **What's real**,
**What's calculated**, **What's drawn to illustrate**, **What's simplified**, **Controls**, and the closing
line that the scene uses simplified models. Scale is the most common lie in a 3D scene: if sizes or distances
are not to scale, say so and give the real figures.

## Accessibility and reduced motion

- Semantic `<button>`, labelled `<input type="range">`, visible focus, no keyboard traps, logical tab order.
- The main readout is an `aria-live="polite"` region; the canvas has a text alternative that describes the
  current state, updated with it.
- Contrast meets WCAG 2.1 AA over the scene (put readouts on a translucent panel).
- `prefers-reduced-motion: reduce` disables the cinematic camera, camera shake, and auto-play, and turns
  tweens into cuts. Offer the same switch in the console.
- Audio, if any, has captions and starts only after a user gesture.

## Performance budget

- `renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))`, and resize from the container, not the
  window.
- `InstancedMesh` for anything repeated more than about 20 times; share geometries and materials.
- Dispose geometry, materials, and textures when a chapter rebuilds.
- Pause when hidden: `renderer.setAnimationLoop(null)` on `visibilitychange` when `document.hidden`, and
  when an `IntersectionObserver` reports the canvas off screen. Render on demand when nothing is moving.
- Target 60 fps on an integrated GPU and about 100 draw calls or fewer; read `renderer.info.render` during
  development and record the numbers in the report.

## Kid-safe content (when the audience includes children)

- Warm, encouraging copy; a wrong answer earns a hint, never a penalty or a sad sound.
- No violence, fear, ads, outbound links, accounts, chat, analytics, or data collection.
- No real child's name, face, or voice. Mascots and presenters are fictional or the parent's own choice.
- Civics and history stay neutral and nonpartisan: describe how the process works, not who is right.
- Reading level matched to the age; one idea per sentence; numbers shown with their units.

## Verification (required before you say "done")

1. **In LUCID:** `preview_open` the page (it must live inside the workspace; the Preview frame has no network,
   so every file is local). `preview_inspect` with `what: "errors"` must report ZERO console errors.
   `preview_screenshot` every chapter and every view; drive controls with `preview_click` and `preview_type`
   and confirm the readouts changed.
2. **Headless Chromium** (for artifacts and CI): load the page from a loopback static server over the
   DevTools protocol, fail on any exception, console error, or failed request, and save one screenshot per
   chapter plus poster frames.
3. **Preview clip:** render frames deterministically and encode a short muted clip with ffmpeg (VP9 webm or
   H.264 mp4, about 25 to 260 KB), plus a poster image.
4. **Report** the measured transfer size, the console error count, `renderer.info` numbers, and the paths of
   every screenshot, poster, and clip. Anything you did not run is labelled unverified.

The serve and capture scripts and the exact ffmpeg commands are in `references/verification.md`.

## What you never do

- Copy code, text, or layouts from sael.net or any other explainer.
- Load three.js, fonts, or textures from a CDN, or fetch anything at runtime.
- Show a float artifact, a rounded number without an approximately-equals sign, or a fact you are not sure of.
- Claim an explainer works without zero-error evidence and a screenshot of every chapter.

## References

- `references/quality-bar.md`: the measured research facts and the grading checklist.
- `references/scene-recipes.md`: renderer, sky, lights, camera presets, labels, instancing, visibility pause.
- `references/exact-math.md`: rationals, mixed numbers, exact decimals, long-division steps, self-tests.
- `references/verification.md`: static server, DevTools capture script, poster frames, ffmpeg clips.
- `references/sample-plan.md`: a complete PLAN.md for a sample explainer.
- `references/sample-build-prompt.md`: the build prompt that pairs with the sample plan.
