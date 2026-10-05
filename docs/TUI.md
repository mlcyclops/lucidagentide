# LUCID in the terminal: the `lucid hub` TUI

Design document. Nothing here is built yet; each increment below ships with its own
ADR and demo per AGENTS.md. This is the map.

## What this is

A full terminal UI for LUCID: every capability of the desktop app, driven from a
terminal instead of an Electron window. Not a second product and not a fork of the
GUI. One sentence of architecture makes the whole thing tractable:

**The desktop renderer is already just an HTTP client of the engine.**

`desktop/dev.ts` serves the entire capability surface (about 280 `/api/*` routes plus
the `/api/chat` NDJSON stream) over loopback, token-gated, and the renderer talks to
it exactly the way any other client would. The browser build (`bun run desktop:web`)
already proves the engine runs and serves everything without Electron. So the TUI is
a third client of the same engine, not a reimplementation of anything. Capability
parity is structural, not aspirational: if a feature exists, it is a route, and the
TUI calls the route.

```
                       ┌────────────────────────────┐
  Electron renderer ──▶│                            │
  Browser build     ──▶│  dev.ts engine (loopback,  │──▶ omp acp child
  lucid hub (TUI)   ──▶│  token-gated /api surface) │    (gate in-process)
                       └────────────────────────────┘
```

## What already exists (do not rebuild)

- **Bare `lucid` / `lucid tui`** (ADR-0161, `harness/launcher/lucid_acp.ts`): omp's
  native terminal UI running the byte-identical gated command as every other LUCID
  surface. Token streaming, thinking blocks, tool-call rendering, Plan/Ask/Agent
  modes, tool-approval prompts, the LUCID theme (P-THEME.1). Fail-closed preflight.
  This stays the zero-setup, single-session path.
- **`lucid kb`, `lucid stats`, `lucid check`**: KB browsing, session metrics, and the
  gate preflight as plain CLI subcommands.
- **`@oh-my-pi/pi-tui` 18.4.4**: already a pinned dependency. The TUI renders with
  it. No new dependency, no second widget toolkit, and the look matches omp's own
  terminal UI that `lucid tui` users already know.

The gap between `lucid tui` and the desktop app is the hub: dashboards, fleet,
sessions, settings, approvals, reports, KB/KG management, and everything else the
engine serves. `lucid hub` closes that gap.

## Boot and attach

Two modes, decided by whether an engine is already running:

1. **Attach.** The desktop app (or a previous `lucid hub`) already runs an engine.
   The engine writes a discovery file at boot (userData dir, mode 0600): port, the
   `/api/health` nonce, and a hub token. `lucid hub` reads it, verifies
   `/api/health` answers with the matching nonce, and connects. Two clients on one
   engine is already the daily reality (Electron window + browser build), so shared
   state costs nothing new. The discovery file is a new engine seam and gets its own
   increment and ADR; today only Electron `main.ts` learns the token.
2. **Standalone.** No engine running: `lucid hub` spawns `dev.ts` itself, headless,
   exactly as the browser build does, mints the token, and owns the child's
   lifetime. Terminal closes, engine exits (same parent-watch discipline as
   `parent_watch.ts`).

Everything security-relevant is unchanged: loopback bind, Origin/Host checks where
they apply, `x-lucid-token` on every request, and the omp child still loads the gate
in-process (invariant 4). The TUI holds the UI token, never the agent token.

## Interaction model

- **Panes, not pages.** The hub is a pane multiplexer in the herdr/tmux idiom: split
  the terminal into panes, put any capability deck in any pane, move focus between
  them, zoom one, close one. Layout is a binary split tree; `|` splits right, `-`
  splits down, `tab` walks the focus ring, `z` zooms the focused pane, `x` closes
  it, and a number key rebinds the focused pane to another deck. Every deck is a
  renderer over the same engine routes, so any combination of capabilities can sit
  side by side (chat next to Security next to Fleet). A persistent status line
  names the attached engine and carries a red badge when a security block or lane
  approval is pending anywhere.
- **Palette.** `Ctrl+K` opens the same command palette the GUI has: the 39 omp slash
  commands (`/api/commands`) plus hub actions ("spawn lane", "start goal run",
  "export brief as POA&M"). The palette is the escape hatch that keeps rare actions
  from needing dedicated keys.
- **Approvals interrupt everywhere.** A gate block, a chat permission request, or a
  lane's pending approval raises a modal on whatever deck is open, with the same
  approve / dismiss / explain choices as the GUI toast. Fail-closed rules identical:
  the modal releases nothing by itself; `/api/security/approve` is the only release
  path and stays audited.
- **Lists follow invariant 11's spirit.** One row, one line: primary label takes the
  width and ellipsizes; chips render as short bracketed tags. No wrapped columns.
- **`$EDITOR` replaces Monaco.** Anywhere the GUI opens the embedded editor (design
  doc, agent specs, skill studio drafts), the TUI writes a temp file, opens
  `$EDITOR`, and posts the result back through the same save route.
- **Spaces, tabs and the control plane (P-TUI.3, ADR-0436; P-TUI.5, ADR-0433).** The hub
  holds named spaces (tmux sessions); each space holds named tabs (tmux windows), and each tab
  has its own split tree. Ids never come back meaning something else: spaces `s1`, tabs
  `s1:t2`, panes `s1:p2` (pane ids are per space, not per tab). `:` opens a command prompt.
  The same commands drive a running hub from outside: `lucid hub split-window -h`,
  `lucid hub pane read -t s1:p2`, `lucid hub new-window -n logs` (a tab),
  `lucid hub new-session -s work` (a space), `lucid hub agent prompt <lane> <text>`, and the
  rest of the grouped (`status`, `space`, `tab`, `pane`, `agent`) and tmux vocabularies.
  Output is JSON; errors are JSON on stderr with exit 1,
  and `{"error":"no_hub"}` when nothing is running. The hub publishes `hub-discovery-<pid>.json`
  (0600) and a client must win the same nonce handshake as P-TUI.0 before it sends the token.
  `lucid hub --headless` runs the hub with no terminal for agents and CI. Agent commands call
  a fixed set of engine fleet routes; nothing on the control plane approves, dismisses,
  answers asks, or changes the whitelist, and `send-keys` only types into agent panes.
- **The rail (P-TUI.5).** A left column lists every space with its tabs indented beneath:
  `◆` and an accent bar mark the focused space, the tab on screen is cyan, each row counts its
  panes (`3▣`), and a tab hosting agent panes carries a `◎n` badge (green while one works,
  amber while one waits on you). Below it sits the AGENTS section (P-TUI.5 E2, ADR-0434):
  every fleet lane as one row - status glyph in the LaneStatus hues (waiting-on-you amber,
  working green, error red), name, model short-name, the `space:tab` hosting its live pane,
  elapsed, and a `p<n>` badge - sorted by priority (highest first), then status (a lane
  waiting on a human outranks its equals), then name. Priority is a user-set 1-9 per lane
  NAME, saved in `hub-agent-priorities.json`: select a row and press a digit, or
  `lucid hub agent priority <name|id> <1-9>`. It is DISPLAY ORDER only, never scheduling -
  the engine and the lanes never see it. Click a row once to select it, click again (or `⏎`)
  to attach that agent into the focused pane; `c` cancels its running turn via the existing
  route. Approval prompts are never answered from the panel. `b` opens or closes the
  rail (closed, the deck list is back; the choice is saved in `hub-spaces.json`). Clicks work:
  a space or tab row focuses it, a pane focuses the pane. `B` puts the keyboard on the rail
  (`j`/`k`, `⏎` focus, `r` rename inline, `n` new tab, or a new space on the SPACES header,
  `esc` back to the panes).

## Capability map

Every GUI surface, its TUI counterpart, and the transport it already has. "Same
route" means zero engine work.

| GUI surface | TUI counterpart | Transport |
| --- | --- | --- |
| Chat thread + composer | Chat deck: NDJSON stream, markdown to ANSI, tool-call rows, attachments by path | `/api/chat`, `/api/chat/attach`, `/api/chat/cancel`, `/api/chat/permission` |
| Model / mode / thinking picker | Picker overlay, same ordering rules (P-OWN.1 follow-up) | `/api/config`, `/api/model/*`, `/api/modes` |
| Security dashboard | Security deck: active blocks, approve/dismiss/ack, sandbox mode + grants, egress posture, whitelist CRUD | `/api/security*`, `/api/sandbox/*`, `/api/whitelist*` |
| Audit stream | Scrolling audit tail with sink status | `/api/audit` |
| Memory & context dashboard | Memory deck: gauges, snapshot, subagent runs, timeline | `/api/memory`, `/api/subagents`, `/api/timeline*` |
| Usage / budget / rate limits | Usage deck; also already partly `lucid stats` | `/api/usage`, `/api/budget`, `/api/ratelimits`, `/api/headroom` |
| Fleet (orbit + grid) | Fleet deck: lane table (status, cwd, turns, pending approval), attach-to-lane chat, queue reorder, spawn/promote/demote/stop/retry/respawn, hub grouping (ADR-0410) | `/api/fleet/*` |
| Sessions + recovery | Session deck: list, load, delete, ingest timeline, recovery flow | `/api/sessions*`, `/api/session*`, `/api/recovery/*` |
| Goal loop | Goal deck: preflight, launch, live run log, cancel, budget kill switch state | `/api/goal*` |
| Reports / briefs / AAR | Reports deck: list, read (markdown to ANSI), archive/restore/delete, POA&M CSV and STIG .ckl export to a path | `/api/reports`, `/api/report*`, `/api/brief*` |
| Automations | List, enable, run-now, delete | `/api/automations*` |
| KB | KB deck built on the `lucid kb` cores plus ingest, packs, graph view as an indented tree | `/api/kb/*`, `tools/kb_cli.ts` |
| Personal KG | KG deck: scopes, lock/unlock (CUI flows keep their explicit confirm wording), import with progress, forget, relate | `/api/personal/*`, `/api/kg/*` |
| Settings: providers/auth | Settings deck, one screen per namespace; secrets prompted with echo off, stored via the same vault routes, never displayed | `/api/auth*`, `/api/accounts*`, `/api/local-providers*`, `/api/asksage*` |
| Settings: MCP / remote agents | Same CRUD; engine restart on change, surfaced as a one-line notice | `/api/mcp*`, `/api/agents*` |
| Settings: voice / whisper / embeddings / judgment / uimode | Same routes, same toggles | `/api/voice*`, `/api/whisper/*`, `/api/embeddings*`, `/api/judgment`, `/api/uimode` |
| Agent Builder | Builder deck: spec list, `$EDITOR` for the spec JSON, validate on save, templates, import/export with the same scan + trust flow, runs + traces, run approvals | `/api/agent/*` |
| Skills | Skills deck: list, inspect, import, rescan, publish, studio drafts via `$EDITOR` | `/api/skill*` |
| Workspace switcher | Workspace deck: recents, clone, setup profile; folder choice via a path prompt completing against `/api/fs/list` (no native dialog in a terminal) | `/api/workspace*`, `/api/fs/list` |
| Preview panel | Degraded, honestly: text/HTML source view, `open`/`xdg-open` to the OS browser for a real render, screenshot cache shown inline where the terminal supports images | `/api/preview/file`, `/api/preview/shot`, OS `open` |
| Agent's visible browser | Not available (it is an Electron BrowserWindow). `browser_open` from a TUI-attached engine returns its normal honest error; the browser deck shows latest shots when a GUI client is also attached | `/api/browser/status`, `/api/browser/shot` |
| Voice input / TTS | Record via OS capture (`sox`/`ffmpeg`), post to transcribe; play TTS via `afplay`/`paplay` | `/api/transcribe`, `/api/tts/speak` |
| Incidents / processes / system | Ops deck: incident list + report, process table, system verdict | `/api/incidents*`, `/api/processes`, `/api/system` |
| Code activity / codegraph | Repo deck: diffstat summary, graph as tree/adjacency text | `/api/code-activity`, `/api/codegraph*` |
| Collab share | Collab deck: start/stop, status, guest inbox, authorize-connect prompts | `/api/collab/*` |
| Meetings hub | Meetings deck: list, detail, pair, todos | `/api/meetings*` |
| Creator Studio (Creator build) | Creator deck: registry, probes, jobs, library; artifacts open via OS; mixer/editor stay GUI-first (a waveform mixer in cells is a toy, not parity) | `/api/creator/*` |
| Intel news, trivia, guides | Read-only decks | `/api/intel-news`, `/api/guides`, `/api/trivia/*` |
| Mascot, arcade, chat background | Cosmetic. Out of scope for parity; the arcade is HTML games and the mascot is a canvas stage. A one-line status-bar mascot glyph is allowed to exist for fun, nothing more | none |

Three honest non-parity items, called out so nobody discovers them in anger:

1. **Live HTML preview and the preview inspect/act relay.** The relay needs a real
   DOM host (the renderer's sandboxed iframe polls `/api/preview/inspect/next` and
   executes there). A TUI has no DOM. When only the TUI is attached, the preview
   tools return their existing "no preview is open" error, which is already the
   engine's fail-closed answer. A headless DOM host is a possible later increment;
   it is not promised here.
2. **The visible agent browser** (`browser_*`): same shape, Electron main owns the
   window and the command poll. Same honest error path when absent.
3. **Creator mixer/editor**: job control and library yes, timeline editing no.

Everything else is the same route the GUI calls today.

## Rendering specifics

- **Markdown**: `marked` (already a dep) to an ANSI renderer in pi-tui. KaTeX
  degrades to the raw TeX source in a dim span; a terminal is not going to typeset
  math and pretending otherwise is worse.
- **Images** (preview shots, browser shots, creator artifacts): kitty graphics
  protocol and iTerm2 inline images where detected, sixel as fallback, and a
  "saved to /tmp/… (press o to open)" line where none of that exists.
- **Streams**: `/api/chat` NDJSON is consumed exactly as `renderer/bridge.ts` does;
  the dashboard polls reuse the engine's existing memoized snapshots (P-PERF.3), so
  a TUI client adds no new load pattern.
- **Theme**: the P-THEME.1 LUCID skin tokens, so `lucid tui` and `lucid hub` look
  like one family.

## Security posture (unchanged, verified per increment)

- Gate in-process in the omp child; the TUI never scans, never releases, never
  fabricates a verdict (invariants 3 and 4).
- The TUI is a token-holding loopback client like the renderer: same H1/H2 gates,
  same UI-token/agent-token split (P-SANDBOX.15).
- Secrets: prompted with echo off, sent only to existing vault-backed routes, never
  written to TUI state or logs.
- The fail-closed demo for the hub is the same as the GUI's: kill the sidecar
  mid-run, watch the block modal appear, assert nothing released.

## Increment plan

One per session, each with its own ADR and `make demo-*`:

- **P-TUI.0** Engine discovery seam: the discovery file (port + nonce + hub token,
  0600), written by `dev.ts`, honored by Electron boot and standalone boot. Demo:
  two clients, one engine, both healthy.
- **P-TUI.1** `lucid hub` shell: pi-tui app, attach/spawn, status line, palette,
  chat deck end to end (stream, cancel, permission modal, model picker).
- **P-TUI.2** Security deck + global approval modal + audit tail. Includes the
  sidecar-kill demo.
- **P-TUI.3** Hub control plane: spaces, stable pane ids, the `lucid hub <cmd>` CLI with
  tmux verbs, the `:` prompt, and the loopback control server (shipped, ADR-0436). The
  fleet-deck work first planned under this number (table, attach, spawn, pending approvals)
  shipped with the P-TUI.1 hub; queue reorder and stop are still open.
- **P-TUI.4** Sessions, timeline, memory, usage decks.
- **P-TUI.5** Settings decks (providers, MCP, agents, whitelist, voice, whisper).
- **P-TUI.6** Goal, reports, automations decks; POA&M/.ckl export to path.
- **P-TUI.7** KB and personal KG decks (reusing `kb_cli` cores; CUI confirm flows).
- **P-TUI.8** Builder, skills, workspace decks (`$EDITOR` seam).
- **P-TUI.9** Media: inline images, voice capture, TTS playback, preview
  degradations wired and documented.
- **P-TUI.10** Ops, collab, meetings, creator (build-gated), read-only decks; docs
  pass and the parity table above re-audited against reality.

Ship order is negotiable; the P-TUI.0 seam and the P-TUI.2 fail-closed demo are not.
