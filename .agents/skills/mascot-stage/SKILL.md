---
name: mascot-stage
description: Working on LUCID the ninja mascot (desktop/renderer/mascot.ts, immersive stage, P-MASCOT arc, ADR-0251 pivot). Use when touching mascot frames, animation states, activities, stage mounting, or doing visual QA in the preview panel - it encodes the settled art direction, the pixel-frame conventions, and the preview QA workflow.
---

# LUCID the ninja - the mascot stage

First-party skill, authored in-repo (2026-08-01, P-MASCOT.1 session). Supersedes the retired
`threejs-stage` skill (the talking-head + particles direction was killed by the user the same day it
shipped; three.js was removed from the repo with it).

## Art direction (user-set, load-bearing)

- LUCID is a FUN, COOL game character: an original fighting-game-style pixel NINJA. Chibi proportions,
  navy gi, neon-green (#41ff8b) headband/belt/scarf - the brand accent.
- **He does things**: practices kata, throws shuriken, meditates while the agent works; guards while
  the mic listens; gestures while replies speak; hits a victory pose when a turn lands; breathes and
  blinks when idle. The mascot must STAY IN LINE with real session state - never a looping GIF vibe.
- **History**: two 3D face attempts died here ("scary", then "still very bad"). Faces and particle
  humans are OFF the table - pixel-art characters are immune to the uncanny valley by construction.
  Do not resurrect the face without an explicit user ask.
- Original character only - inspired by the fighting-game GENRE, never a copy of an existing fighter.

## Pixel-frame conventions (desktop/renderer/mascot.ts)

- Frames are 20x26 char grids over MASCOT_PALETTE; '.' = transparent. Every frame derives from BASE
  via `rows(BASE, {overrides})` so the character stays on-model - author DIFFS, not new drawings.
- Keep silhouettes readable at small scale: one-pixel outlines ('k'), chunky limbs, high contrast
  between gi (K/D) and accent (G). Test: squint at an 8x scale render.
- Animation = beat tables (frame + ms). Working activities rotate every ~6.5s via `workActivity`.
  The state machine (`stepMascot`) is PURE and tested: victory fires on working->done, victory always
  finishes, speaking > listening > working > idle.
- Painting is nearest-neighbor fillRect at integer scale, DPR-aware, bottom-center anchored. No
  smoothing, no fractional scales - that is what keeps it crisp.

## Layout hazard (live bug, 2026-08-01)

- `.body` is a 5-track grid whose children include the rails AND the right-edge panels (Settings,
  Skills, ...). NEVER `display:none` a `.body` grid child: removal re-slots every later sibling into
  earlier tracks (the center collapses into an `auto` track, Settings lands mid-screen). Collapse IN
  PLACE instead - `width:0; min-width:0; opacity:0; pointer-events:none; overflow:hidden` (with
  `!important` where a resizer sets inline widths). demo-P-AVATAR.1 enforces this with a regex gate.

## Preview QA workflow (sharp edges, learned the hard way)

- The preview panel auto-opens ONLY on a direct write-tool call; `tool.write` from eval does not
  switch pages. Screenshots are cached PER PAGE LOAD - bump the html (version comment) to force a
  reload before a fresh capture.
- Harness pattern: bundle a tiny entry that mounts the mascot with a state-cycling driver, write a
  sibling .js + small .html (the panel inlines relative assets; single files over ~300KB choke it).
- Generated QA bundles under desktop/ need the BUSL header or the license gate fails; delete `_qa_*`
  scaffolding once the user has looked.
