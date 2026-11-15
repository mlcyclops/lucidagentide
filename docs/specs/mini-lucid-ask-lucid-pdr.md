<!-- Copyright (c) 2026 TechLead 187 LLC -->
<!-- SPDX-License-Identifier: BUSL-1.1 -->

# PDR: mini Lucid and the Ask Lucid fly-out

Written 2026-11-14 from the request to bring LUCID Tradepass's mini Lucid and its fly-out into
LUCID Agent IDE. Each increment below is one session with its own ADR, tests and demo.

## 1. What was asked

1. In the LUCID Agent role, mini Lucid sits still and types while a session is doing turns, the way
   he does in Tradepass's Ask Lucid panel.
2. In the Developer role, the first new session lets mini Lucid walk along the bottom. A click makes
   him disappear.
3. In any role he sometimes shows up on a new session, without being annoying.
4. He can recommend a holiday theme through a quick popup, behind a setting that controls whether
   he asks.
5. He can explain new features.
6. A new fly-out called Ask Lucid holds a side conversation that may or may not be about the current
   work. Lucid sees every fleet lane, every Fleet Orbit node and the knowledge graph, so the user can
   check in, ask questions, or kick off a fleet lane or an orbit node.
7. The fly-out should behave like the one in Tradepass.

## 2. What already exists

**In LUCID Agent IDE.**

| Piece | Where | State |
|---|---|---|
| Mascot frames, palette, keyboard, state machine | `desktop/renderer/mascot.ts` | Complete. Tradepass vendors this file. |
| Walking runner on the prompt bar (hover hop, click leap, seasonal acts, reduced motion) | `desktop/renderer/mascot_runner.ts` | Mounted for the `lucid-agent` role only (`syncImmersiveWithRole`, app.ts). |
| Work pose | `WORK_ACTIVITIES` in mascot.ts | Cycles kata, shuriken, meditate, coding and others, standing. |
| Holiday seasons by date | `desktop/renderer/seasons.ts`, `secSeason()` | Following the calendar is opt-in. Nothing ever suggests a season. |
| Toasts, one-time nudges, role tour | `showToast` (ui.ts), `maybeOnboardPersonal`, `startTour` | No "what's new" surface. |
| Right-side panels | `aside.settings`, `aside.kg`, `plugins_flyout.ts` | Mutually exclusive drawers. No dock that floats, snaps or minimizes. |
| A model call outside the chat turn | `Backend.complete(system, user)` on a dedicated connection (acp_backend.ts) | Used by `/api/explain`. No conversation route. |
| Fleet, orbit and knowledge reads | `/api/fleet/status`, `/api/fleet/goal`, `/api/kb/retrieve`, `/api/kb/graph` | Present. |
| Fleet and orbit writes | `/api/fleet/spawn`, `/api/fleet/prompt`, `/api/fleet/goal/task` | UI token only. The agent token cannot call them. |

**In LUCID Tradepass.**

| Piece | Where | What to take |
|---|---|---|
| Seated, typing mini Lucid (idle, working, done, error) | `ui/js/mascot-mini.js` | The scene composition: seated pose, typing arms, lit keys. Same owner, same license. |
| The dock | `ui/js/dock.js` | Right, bottom and floating modes, minimize to a pill, drag to snap, keyboard move and resize, persisted placement. Pure geometry helpers with tests. |
| Ask Lucid | `ui/js/asklucid.js`, `src/assistant/*` | The rule that Lucid proposes and the human confirms: every action is a card with a risk label and a Confirm button, and the app runs it as the user. |

## 3. Decisions the design rests on

- **"Agent mode" is the `lucid-agent` role and "Dev mode" is the `developer` role.** Those are the two
  role-picker entries the request describes. The diagnostics toggle called developer mode is unrelated.
- **Mini Lucid is never in the way.** His canvas ignores the pointer, only his silhouette is clickable,
  he never covers the prompt, and he obeys `prefers-reduced-motion`. A single setting turns him off.
- **Ask Lucid reads, proposes, and never acts.** It runs on the side completion channel, so it cannot
  disturb a running turn and holds no tools. A fleet lane or an orbit task starts only when the user
  presses Confirm, and then the renderer calls the same UI-token route the Fleet panel uses.
- **Everything Lucid is shown is untrusted data.** Lane names, task titles, lane output and knowledge
  pages are written by agents and by imported content. They enter the prompt only inside the
  untrusted envelope (invariant 5), and an action Lucid proposes after reading them is still only a
  proposal on the user's screen.
- **CUI lockdown holds.** The side completion already resolves its model through the lockdown clamp.

## 4. Increments

### Session 1: P-MINI.1, mini Lucid visits and sits down to type

**Shipped 2026-11-14, ADR-0580.**

- `desktop/renderer/mascot_mini.ts`: the seated scene from Tradepass, in TypeScript, on this repo's
  own frames. `sceneRows(state, t)` is pure and tested.
- `mascot_runner.ts`: a `typing` work pose (seated at the keyboard while a turn runs) and a
  `dismiss on click` mode.
- `desktop/renderer/mini_lucid.ts`: the visit policy, pure. LUCID Agent role: always present, as today.
  Developer role: the first new session of a launch. Any role: one new session in four, at most three
  visits a day and never within thirty minutes of the last.
- Settings card "Mini Lucid": Off, Sometimes (default), Always.
- `make demo-P-MINI.1`.

### Session 2: P-ASKLUCID.1, the dock and a read-only Ask Lucid

**Shipped 2026-11-14, ADR-0581.**

- `desktop/renderer/dock.ts`: the Tradepass dock in TypeScript with its geometry tests.
- `desktop/ask_lucid.ts` (pure): the brief, the context blocks (fleet lanes, orbit goal and tasks,
  knowledge hits for the question), history trimming, all inside the untrusted envelope.
- `/api/ask-lucid` (UI token only): gathers the context server side and answers through
  `Backend.complete`. No tools, no session, no write.
- `desktop/renderer/ask_lucid_panel.ts`: the panel in the dock, mini Lucid in its header showing idle,
  working, done and error, a title-bar button to open it.
- `make demo-P-ASKLUCID.1`.

### Session 3: P-ASKLUCID.2, Lucid proposes, the user confirms

**Shipped 2026-11-14, ADR-0582.**

- Lucid may end a reply with one fenced `lucid-actions` block. Kinds: `spawn_lane`, `prompt_lane`,
  `add_orbit_task`, `open_view`. A pure validator drops anything else and bounds every field.
- Each action renders as a card with what it will do, a risk label and Confirm. Nothing runs
  without the click. Confirm calls the existing bridge methods as the user.
- `make demo-P-ASKLUCID.2`, including a lane whose output tells Lucid to spawn something: the result is
  at most a card.

### Session 4: P-MINI.2, suggestions

**Shipped 2026-11-14, ADR-0583.**

- A holiday theme suggestion when a season is live, the calendar is not being followed and this
  season has not been asked about: Apply, Not now, Don't ask again.
- "What's new": a short list keyed by version, shown once, with "Ask Lucid about it".
- A setting, "Lucid may suggest things", on by default, that silences both.
- `make demo-P-MINI.2`.

## 5. What not to do

- Do not give Ask Lucid a tool, a shell or a session of its own. The moment it can act, it is a
  second agent with none of the gates the first one has.
- Do not let a suggestion interrupt a running turn or stack on another popup.
- Do not vendor Tradepass's built file back. The frames live here; port the logic that is new.
