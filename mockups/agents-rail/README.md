# Agents rail mockups

Mockups only. Nothing here is wired into the app. Open `index.html` in a Chromium browser (the pages use
`color-mix()`, `@property` and CSS `zoom`); every page is self-contained (inline CSS, JS and SVG, no network).

The idea: a new **Agents** view for the right metrics rail (the collapsed inspector, `#metricsRail`). A new
button sits to the right of the existing expand button (`.rail-expand`, the `<<` icon). It is an animated mini
LUCID that flips the rail between the live metrics and your Agents. New users land on the Agents view.

## Files

| File | What it is |
| --- | --- |
| `index.html` | Launcher with live, scaled previews of the three directions |
| `a-glass-brick.html` | Direction A: translucent Brick Brigade brick, vector chibi Lucid |
| `b-pixel-brick.html` | Direction B: pixel-art brick, the real 20 x 26 mascot sprite at 1 px per cell |
| `c-voxel-cube.html` | Direction C: isometric glass cube on a voxel pedestal, vector chibi Lucid |

## The directions

- **A, Glass brick.** A straight port of Brick Brigade's `brickSprite` (54 x 40 units: beveled frame, recessed
  window, gloss band, two glass streaks, specular dot, troop-style trim), made translucent in the Agent's color.
  The Lucid is a smooth vector chibi (navy gi, neon headband, belt and scarf tails, no face beyond the mask slit).
- **B, Pixel brick.** The Lucid is the mascot itself: `BASE_20` and its `meditate` rows from
  `desktop/renderer/mascot.ts`, drawn at 1 css px per cell. Typing is three new arm diffs plus a keyboard row,
  authored the way mascot frames are (row diffs). The brick is pixel art too (1 px outline, bevel, neon seam,
  rivets, pixel glass streak). Every animation is a frame swap, never a tween, so it stays on whole pixels. The
  toggle is the mascot head at 2x, so this direction's toggle is 40 px wide (32 + 4 + 40 = the rail's 76 px).
- **C, Voxel cube.** An isometric glass cube (frosted faces, bright front edge, glints) on a voxel pedestal in the
  Agent's color (four lit top voxels, shaded sides, neon seam). The Lucid sits inside like a figurine in a display
  case. The toggle's bust stands on a hexagon that turns a sixth on hover, like a voxel being rotated.

## What every page demonstrates

- The dark app frame edge at real proportions: the rail at its measured width (96 px, so a 76 x 49 px box).
- The real metric `.tile`, `.rail-expand`, `.inspector.rail`, `.popover`, `.cfg-sec`, `.cfg-lbl` and `.ctx-it`
  CSS copied verbatim from `desktop/renderer/styles.css`, plus the lucid-dark and lucid-light tokens.
- The toggle in both states (metrics view: muted; Agents view: lit) and its hover (lift, racing green ring, head
  tilt or hop, scarf flutter, happy eyes, spark), at 1x and 3x. Clicking the toggle inside a frame really flips it.
- Six Agents in different colors and states: working (typing, LED on), idle (meditating), and one mid-glance
  (`ml-notebooks` glances every 6.5 s on the page so reviewers can see it; the real cadence is about 60 s).
- The hover module open on `api-gateway` with Activate expanded. Hover any Agent to move it (140 ms intent,
  260 ms grace across the gap); click opens it with Activate expanded; Esc closes. It prefers the left of the box,
  clamps inside the window, and its nub tracks the box center. Color slider and swatches recolor the box live;
  Rename edits inline (Enter saves, Esc cancels); the three Activate choices show what they would do.
- A first-run variant: one Agent for the current folder, an "add agent" box, and a coach mark on the toggle.
- Specimens at 4x (idle, working, glance, reduced motion) and the six mascot palettes plus a custom hue at 2x.
- Page controls: Light theme, Reduced motion (stops every loop and the glance; pose and LED still show state),
  Glance now.

Motion per Agent: idle = meditating (4.8 s breath, slow aura); working = short typing bursts with a rest, keys
flash; glance = left, up, down, then back to center toward the user with one blink (3.2 s), about every 60 s with
jitter so the list never moves in unison. `prefers-reduced-motion` is honored.

The module reuses the `.popover` layer (z 95), so no new row is needed in the overlay stack in
`docs/UX-REVIEW.md` if this ships as drawn.

## Open questions for you

1. **Where do saved Agents come from?** Recent workspaces only, any folder opened in the last N days, or an
   explicit "Save as Agent" (from the folder picker, the composer header, a fleet lane card)? Does an Agent carry
   more than folder + name + color (default model, mode, skills, a standing prompt)?
2. **Max list length.** The rail fits about 10 boxes at a 900 px window. Proposal: pinned Agents first, then the
   8 most recent, then a "+N" box that opens the full list. Or just let the rail scroll (it already scrolls
   without a bar)?
3. **What does "working" mean per Agent?** Any fleet lane or orbit session whose folder is that Agent's folder
   has a turn in flight? Does the main composer count? Should "waiting on approval" get its own pose (the
   mascot's guard pose, amber LED) and errors their own state?
4. **Box size.** The mockups keep the exact metric box (76 x 49), so the Lucid is about 20 px tall at 1x. Would you
   rather have a taller "comfortable" box (about 62 px) that fits the Brick Brigade brick at its native 54 x 40?
5. **Rail opacity.** The metrics rail recedes to 55% at rest. The mockups keep the Agents view at full opacity
   because the characters wash out. OK?
6. **Rail width.** The Agents view keeps the width the metrics view measured, so toggling never shifts the center.
   With narrow metrics (no LUCID points tile) the names ellipsize sooner. Lock a minimum width in Agents view?
7. **Take over main composer.** Confirm first if main has a turn in flight? The main session moves to a new fleet
   lane; does main then resume the Agent's last session for that folder or start a fresh one?
8. **Agent World session.** If a lane for that Agent already exists, reuse it or start another? "Prompt panel
   open" means that Agent's node prompt in Agent Worlds (agent node id = fleet lane id)?
9. **Color reach.** Presets are the six mascot themes; the slider picks a custom hue (gi derived from it). Should
   an Agent's color also tint its fleet lane card and its Agent Worlds node?
10. **First run.** Who counts as new (no sessions yet)? Once someone flips to metrics, remember it per user?
11. **Direction B toggle width** (40 px instead of 32 px, to keep the 2x pixel head crisp): acceptable?
12. **Glances when the window is unfocused**: pause them (proposed) or keep running?
13. **Removing or unpinning an Agent** is not in the module (per the brief). Where should it live?
14. **Which direction**, or a mix (for example B's pixel sprite inside A's glass brick)?
