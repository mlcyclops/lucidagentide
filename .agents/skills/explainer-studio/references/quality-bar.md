# The quality bar: research facts and the grading checklist

## What was measured (2026-10-28)

`https://sael.net/explainers` lists 77 entries across Explainers, Worlds, Data, Play, Design, Simulator, and
Virtual Tour. Twelve were profiled live in Chromium: fraction-kitchen, heart-pump, soap-bubble,
periodic-table, internet, electricity, river-bend, earthquake-tower, plane-of-focus, flatpack,
pendulum-rhythm, and lightning-path.

- Every one is procedural three.js (r183), with 0.3 to 0.9 MB total transfer.
- None loads a glTF/GLB model, an HDR/EXR environment map, a KTX2 texture, WASM physics, or a splat.
- The only media are small webm/mp4 preview clips of related explainers (25 to 260 KB) and a few webp UI
  images.
- Each page has write-up sections ("How it works", "What's real", "What's calculated", "What's drawn to
  illustrate", "What's simplified", Controls), multiple views, chapter tabs, keyboard shortcuts, exact
  numbers, and a "simplified models" disclaimer.

**Consequence.** At runtime an explainer needs only the viewer's own GPU through WebGL. GPU compute is
useful only at AUTHORING time (code generation, CAD parts, textures, narration, presenter video, preview
clips, offline simulation baking), which is what the `explainer-assets-gpu` skill routes.

These are observations of a style. Nothing from those pages (code, text, names, layouts) is reused.

## Grading checklist

Grade a finished explainer against every line. A single "no" means it is not done.

### Teaching

- [ ] One stated idea, and every chapter serves it.
- [ ] The two or three misconceptions from PLAN.md are each broken by something the learner does.
- [ ] At least 3 chapters, each with a goal and a success check.
- [ ] A challenge or "try it" chapter that checks understanding, with hints instead of penalties.
- [ ] Younger and older levels differ in content, not only in font size.

### Scene

- [ ] Procedural sky gradient, matching fog, hemisphere fill plus one shadowed key light.
- [ ] The subject sits on a ground or plinth; nothing floats without a reason.
- [ ] At least 2 named views plus a cinematic camera that any input cancels.
- [ ] One accent colour per concept, used identically in scene, label, and readout.

### Console

- [ ] Chapter tabs, sliders with steps, +/- steppers, live readouts, and a replay action.
- [ ] Keyboard shortcuts for every action, listed by `?`.
- [ ] Floating labels that can be toggled.
- [ ] A short, themed loading line.
- [ ] State serialized to the URL hash.

### Numbers

- [ ] Every displayed number comes from the exact-math module.
- [ ] No float artifact anywhere (search the DOM text for runs like `0000000` and `9999999`).
- [ ] Rounded values carry an approximately-equals sign and their precision.
- [ ] Constants carry units and a source.

### Honesty

- [ ] Write-up sections: How it works, The idea, Worked examples, What's real, What's calculated, What's drawn
      to illustrate, What's simplified, Controls, and the simplified-models line.
- [ ] Anything not to scale says so and gives the real figures.
- [ ] No sentence claims more than the model computes.

### Accessibility

- [ ] Full keyboard operation with visible focus.
- [ ] `aria-live` main readout and a canvas text alternative that tracks state.
- [ ] Reduced motion turns off the cinematic camera, shake, and auto-play, and turns tweens into cuts.
- [ ] Contrast AA for all console text.

### Performance

- [ ] Total transfer under 1 MB (or under the explainer-assets-gpu budget, with each asset justified).
- [ ] Pixel ratio clamped to 2; repeated objects instanced; disposal on rebuild.
- [ ] Rendering pauses when the tab is hidden or the canvas is off screen.
- [ ] About 100 draw calls or fewer; 60 fps on an integrated GPU.

### Evidence

- [ ] Zero console errors in the Preview panel and in headless Chromium.
- [ ] One screenshot per chapter and per view.
- [ ] A poster image and a muted preview clip of about 25 to 260 KB.
- [ ] The report states measured size, error count, draw calls, and file paths.
