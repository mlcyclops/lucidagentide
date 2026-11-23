# Lucid Agent Worlds: platform audit (2026-11-22)

Scope: the host side of Visualize that every world pack shares (casting, characters, streams, GPU quality, options,
and the interface for future in-world mini games). Per-world critiques live with the packs in the private store repo
(`docs/WORLDS-AUDIT.md` there). Decisions: ADR-0649 to ADR-0654 (all Proposed).

Evidence: 406 stills pulled from the 29 filmed world shorts (14 fixed points per short), a Sonnet visual critic per
world, and the source anchors below.

## 1. Findings

### 1.1 Every demo agent looks the same: a seed bug, not a palette bug
- The node seed is a rolling hash of the node id (`desktop/renderer/viz_scene.ts:554-555`:
  `seed = (seed * 31 + charCode) >>> 0`). Ids that differ only in the last character get seeds one apart.
- Every world picks skin with `SKINS[(seed >>> 9) % 6]` and hair with `HAIRS[(seed >>> 13) % n]`. Shifting a seed
  right by 9 or 13 discards exactly the bits in which `demo-1` to `demo-6` differ.
- Result for the fixed demo fleet (computed, not estimated):

| node | seed | skin | hair index |
|---|---|---|---|
| main (hub) | 9808448 | `#6a3f25` (deepest) | 2 |
| demo-1 to demo-6 | 582137230 to 582137235 | `#8c5634` (dark), all six | 1, all six |
| three subagents | (various) | `#8c5634`, all three | 1 or 4 |

- Hair index 1 is "buzz" in most worlds, so the whole demo fleet renders as six identical dark-skinned buzz-cut men.
  Over 5000 sequential lane ids the skin pick is also lopsided (530 / 1098 / 458 / 1211 / 560 / 1143 per tone).
- The built-in Anime and Office styles do not have this bug: `seededGender` runs the seed through `mix32` first
  (`viz_anime_pose.ts:768-771`, `viz_office_pose.ts:213-219`, ADR-0637). Worlds never got that helper.

### 1.2 There is no gender or body model in worlds
- Worlds have one body: broad shoulders, straight torso. "Feminine" reads only from hair (bun, ponytail, bob), so
  most figures read male even when the hair varies. Hubs and helpers are often locked to a single look per role.
- The built-in styles already cast men and women (ADR-0637), so worlds are behind the product's own baseline.
- Patterns the per-world critics found across the 29 packs:

| pattern | effect | worlds |
|---|---|---|
| agents use the raw seed bits | every demo agent shares one tone and hair | most worlds |
| staff and helpers use their own PRNG | hubs and helpers vary while agents do not | many worlds; also Christmas elves |
| hand-built looks, hashed per driver | the most varied cast | Grand Prix |
| skin hard-coded per figure kind | Valentine's Day is all light; St. Patrick's Day is all light, bearded men | Valentine's Day, St. Patrick's Day |
| hub locked to an older, male-coded look | beard, mustache, bald or quiff on every hub | nearly every world |
| feminine cues tied to a role or sport | judges, skaters and stage assistants are always feminine; tennis rolls a skirt on every demo player | several worlds, including Tennis |
| helmets, caps and toques hide hair | hair variety disappears | Football, Baseball, Hockey, Extreme Sports, Chef Showdown, Swim and Dive |

### 1.3 Shoulders show skin above short sleeves (every short-sleeved figure)
- Shared template (soccer, itself from football): the sleeve is a cylinder from y +0.02 to -0.08 at the shoulder joint,
  the upper arm is a capsule of radius ~0.042 whose round top reaches y +0.042
  (`worlds/soccer/src/figures/player.ts:107,112,208,213` in the store repo). About 0.022 of skin-colored dome pokes
  above every short sleeve and turns with the arm. Every fork inherited it.
- **Where it shows as skin:** short-sleeved figures, which are players, polos, scrubs, judges' and coaches' shirts in
  Soccer, Football, Baseball, Basketball (assistant coach), Golf, Tennis, Summer Games (archer), Esports, Hospital,
  Talent Show, Bowling, Wave Riders and the Swim and Dive staff.
- **Where it shows as a shoulder bulge:** where the arm capsule wears the shirt color, the same geometry reads as a
  boxy pauldron: Construction, Grand Prix, Horse Racing and Dog Show.
- **Where it is absent:** long coats and capsule sleeves, as in Christmas, Valentine's Day, St. Patrick's Day,
  University, Extreme Sports and Magic Show.

### 1.4 Streams are thin gold-and-team lines on light worlds
- 24 of 29 worlds set `environment.edges.style: "fiber"` (a 1 px line with light streaks); 5 dark/holiday worlds use
  `plasma`. All 29 set `chargeColor` to a gold (`CHARGE_GOLD`, `#f5c542`, or rose gold), and edge colors come from
  the world's DEFAULT colors, not the user's chosen ones (`viz_scene.ts:1065-1085` applies the environment once).
- Plasma (`viz_plasma.ts`) is tuned for dark skies (additive glow). On light skies it washes out, which is why light
  worlds chose fiber. The product owner wants gold/yellow streams upgraded to detailed plasma particles with a plasma
  stream, and St. Patrick's Day gold to read as mini gold coins.

### 1.5 Quality tiers ignore the GPU
- The renderer already asks for the discrete GPU: `new THREE.WebGLRenderer({ antialias, alpha: false,
  powerPreference: "high-performance" })` (`viz_scene.ts:319`), and Electron runs hardware accelerated by default; the
  shell only disables the GPU sandbox after repeated GPU crashes (`main.ts:421-432`).
- The tier resolver (`perf_tier.ts:40-50`) looks only at battery, core count and reduced motion. It never asks what
  GPU it got, so a gaming GPU and a software renderer both get "full", and there is nothing above "full".
- A GPU probe already exists for Fleet orbit (`fleet_orbit.ts:158-167`, `WEBGL_debug_renderer_info`), and Electron
  offers `app.getGPUFeatureStatus()` and `app.getGPUInfo("basic")`; neither feeds Visualize.
- Tiers (`viz_model.ts:912-918`): full 6000 particles / 60 fps / dpr 1.5 / AA / bloom (dark only); reduced 2500 / 30 /
  1.25; minimal 600 / 20 / 1.0. No shadows anywhere. `WorldDetail` is the same three values.

### 1.6 Options are per world, flat, and cannot describe people
- `WorldOption` is `color | select | toggle` (`viz_world_api.ts:42-45`), persisted per world in
  `localStorage["lucid.worlds.options.v1"]` (`viz_worlds.ts:18`). There is no skin or hair control, no swatch ramp
  type, and no per-agent override, so the user cannot fix a cast they dislike.

### 1.7 Worlds cannot show UI or build anything
- A world contributes options, throws, a storm and 3D objects only; it cannot open a popup
  (`viz_view.ts:106`, `ui.ts:216` popovers are host-only). Agent events reach Visualize as `token`, `tool`,
  `tool-meta`, `subagent`, `status`, `usage`, `done`, `error` (`viz_model.ts:310-340`) and subagent runs are polled
  every 2.5 s (`viz_view.ts:112`). That is enough to drive a "build" visualization; nothing consumes it yet.

## 2. Improvements (each maps to an ADR)

### 2.1 Balanced casting for every world (ADR-0649)
- Host computes an `appearance` per node and passes it in `WorldFigureOptions` (contract v2, additive):
  `{ presentation: "feminine" | "masculine" | "neutral", body: 0..3, skin: hex, skinIndex, hair: style id,
  hairColor: hex, faceVariant }`.
- Seeds go through `mix32` with a salt per attribute (skin, hair, body), never raw high bits.
- **Fleet balance:** casting is a low-discrepancy sequence over the visible fleet, so any group of 6 shows at least 2
  feminine and 2 masculine figures and spans light, medium and dark skin. The look is deterministic per node id and
  stable as nodes come and go (slot by sorted id).
- Worlds read `o.appearance`; v1 worlds keep working, with the host passing a mixed seed so even old packs stop
  rolling one look.

### 2.2 One shared character kit (ADR-0654)
- `kit.character` provides body presets (shoulder, chest, waist, hip, height, neck and jaw for feminine, masculine and
  neutral), a hair library (short, buzz, curls, coils, afro, puffs, locs, braids, long straight, long wavy, bob,
  pixie, bun, ponytail, headscarf, hijab), face features (lashes, brows, lip tint), and a sleeve-safe shoulder (a
  shirt-material cap that always covers the arm capsule).
- Worlds dress the kit body instead of forking soccer's. This fixes the sleeve bug once and keeps 29 packs from
  drifting apart again.

### 2.3 Cast customization (ADR-0650)
- A "Cast" section in the View menu, shared by every world and both built-in styles:
  - **Skin:** a 10-step shade ramp, each step with warm, neutral and cool undertone variants.
  - **Hair color:** an 8-step natural ramp (black to platinum) plus a few fashion colors.
  - **Mode:** "Balanced fleet" (default) or "Same for all".
  - **Per agent:** right-click a node, then "Customize look", to pin presentation, skin, hair style and hair color
    for that lane id.
- Persisted in `localStorage["lucid.viz.cast.v1"]` (fleet defaults plus a per-lane-id map), so it survives restarts
  and follows the lane, not the world.
- A new `swatch` option type (a named ramp of colors) for world-specific options (uniform shades, kit colors).

### 2.4 GPU-aware quality with higher tiers (ADR-0651)
- **GPU probe at startup.** Electron `app.getGPUFeatureStatus()` and `getGPUInfo("basic")` are read in main and
  passed through preload. The WebGL `UNMASKED_RENDERER` string is read in the page, reusing the `fleet_orbit.ts`
  probe. The result is classified:

| class | how it is detected |
|---|---|
| software | SwiftShader, llvmpipe, Microsoft Basic Render Driver, `gpu_compositing: disabled_software` |
| integrated | Intel, AMD APU, Apple M base, Adreno, Mali |
| discrete | NVIDIA, AMD Radeon RX/Pro, Apple M Pro/Max/Ultra |

- **New tiers.** `ultra` and `cinematic` sit above `full`. `WorldDetail` grows to match; v1 worlds treat unknown tiers
  as `full`. Auto picks the tier as follows:
  - software GPU: minimal
  - integrated GPU: reduced or full, by cores and battery
  - discrete GPU on AC power: ultra
  - Auto also runs a 3 s frame-time check after the scene settles and steps down one tier if the frame budget misses.
- **What the tiers add:**

| tier | adds |
|---|---|
| ultra | dpr 2, MSAA, PCF soft contact shadows under figures, rim light, 12000 particles, plasma-light streams with sparks, selective bloom on light themes, higher geometry segments, hair cards |
| cinematic | everything in ultra, plus SSAO, depth-of-field on the auto camera, and volumetric light shafts in stadium and stage worlds |

- The Quality control shows the detected GPU and the chosen tier, for example "Auto · ultra (RTX 4070)". The user's
  explicit choice still wins.
- "Enable GPU acceleration" is already on by default. This ADR makes the app use the GPU's headroom and report it.

### 2.5 World streams that read on light skies, plus token shapes (ADR-0652)
- A new edge style `plasma-light`: a plasma tube with a darker saturated core and an outer sheath, normal-blended
  token particles with a bright rim, and spark trails at ultra and above, so it reads on bright skies like Anime's
  plasma reads on dark ones.
- **Token shapes:** `edges.token: "orb" | "coin" | "petal" | "snowflake" | "spark" | "custom"`.
  - `coin` is an instanced, spinning mini gold coin with an embossed face and edge ridges, used by St. Patrick's Day
    and optional for Grand Prix and Bowling.
  - `custom` lets a world paint its own token sprite.
- **Colors follow the user's options:** `environmentFor(options)`, so streams and charge use the chosen team colors.
  Gold becomes a per-world accent, not a universal default.

### 2.6 Build sites and the artifact popup (ADR-0653)
- **Contract v2 `buildSites`:** a world declares where and how its agents build (a construction pad, a kitchen pass,
  a workbench), plus up to three mini-game templates.
- **Host-driven scaffolding in the kit.** Wireframe build-up, holo beams, panels, a progress ring and a "lock-in"
  flash.
- **Events drive the build:**

| event | what the scene shows |
|---|---|
| `subagent` | scaffold pieces appear, one per subagent |
| tool `done` | a piece locks in |
| tool `failed` | the piece flickers red |
| `done` or commit | the build reveals and an artifact chip appears over the node |

- **Artifact popup.** A host popover (`ui.ts:216`) hosts the artifact in a sandboxed iframe: `srcdoc`,
  `sandbox="allow-scripts"`, no same-origin, no network, CSP `default-src 'none'`.
  - The artifact passes the in-process security gate before display, and is labeled untrusted.
  - Agents build the mini game with their subagents (for example, a bowling scorekeeper or a recipe builder) as a
    normal lane task with a world-provided template.
  - The popup lets the user play it, and keep or discard it.
- Future detailed packs ship more actions through the same contract (more activity clips, extra build sites), so a
  "Deluxe" world is an upgrade, not a fork.

## 3. Order of work
1. ADR-0649 casting plus the `mix32` seed fix. This ships first and alone: it fixes every installed world without a
   pack update.
2. ADR-0654 character kit, then a pack refresh per world (store ADRs A123 to A151). This fixes sleeves, bodies and
   hair.
3. ADR-0650 cast customization UI.
4. ADR-0651 GPU tiers.
5. ADR-0652 streams and coins.
6. ADR-0653 build sites and the popup. This is the "Deluxe" foundation.
