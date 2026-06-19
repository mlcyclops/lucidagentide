# LucidAgentIDE — desktop (Electron)

A polished desktop shell around omp + the LucidAgentIDE security harness:
a gated agent chat, plus live security / memory-&-context dashboards — same
renderer as the browser build, with real `omp acp` wired in.

## Run

**Browser build — real chat, no Electron (screenshot-able):**

```bash
bun run desktop:web        # from repo root → http://localhost:5319
```

The dev server drives a **real `omp acp` session** (with the gate loaded), so
prompts produce genuine model replies in a plain browser — same backend the
desktop app uses. Dashboards are the live read-only `/api/security|memory`.

**The full desktop app:**

```bash
cd desktop
bun install                # one-time: pulls Electron
bun run start              # bundles main/preload, launches the window
```

The desktop app spawns two children:

1. `bun desktop/dev.ts` — serves the renderer + read-only `/api` dashboards.
2. `omp acp -e harness/omp/security_extension.ts` — the agent loop **with the
   security gate loaded in-process** (invariant #4 holds on the GUI path too).

It reuses your existing `~/.omp` credentials (OAuth or API key) — no re-login.

## Architecture

One real backend serves both the browser build and the desktop app; Electron is
a thin native shell on top.

```
desktop/
  dev.ts          Bun server: bundles renderer/app.ts, serves the read-only /api
                  dashboards AND the real chat/config backend
  acp_backend.ts  singleton omp-ACP session (chat, config, commands) — gate loaded
  acp.ts          minimal Agent Client Protocol client (JSON-RPC over stdio)
  main.ts         Electron main: spawns dev.ts, opens it in a frameless window
  preload.ts      window.lucid = native shell only (crisp zoom + window controls)
  renderer/       the UI (vanilla TS, no framework) — identical in browser & Electron
    app.ts · styles.css · dom.ts · ui.ts · icons.ts · bridge.ts · format.ts
```

`renderer/bridge.ts` talks to the dev server over HTTP for everything —
`/api/security|memory` (dashboards), `/api/chat` (streaming NDJSON), `/api/config`,
`/api/commands` — so chat + config are **real in the browser too**. The only
native-only bits are crisp text zoom (`webFrame`) and window controls, from
`window.lucid`; in a plain browser those fall back to CSS zoom.

## Features

- **Functional chat** over real omp ACP (`session/new` → `session/prompt`,
  streaming `agent_message_chunk`), with the gate loaded so blocked tool calls
  surface as a fly-in toast.
- **Model · Mode · Thinking picker** — click the titlebar model badge. The list,
  current values, and switching all use omp's live `configOptions`
  (`session/set_config_option`); no need to drop into omp.
- **Text zoom** — titlebar − / 100% / +, plus Ctrl ± / Ctrl 0 (Electron
  `webFrame.setZoomFactor`; CSS `zoom` in the browser build). Persisted.
- **omp commands** — the 39 ACP slash commands (`/context`, `/usage`, `/tools`,
  `/compact`, `/memory`, …) appear in the ⌘K palette; selecting one drops it in
  the composer to run.
- **Live telemetry** — the status bar's context gauge + cost update from the
  session's `usage_update` stream.

## Verified vs. to confirm on first run

- **Verified:** the renderer (screenshotted: chat stream, toast, palette, config
  picker, zoom), the dashboards on live data, and — captured from a **live omp
  16.0.8 ACP turn** — the exact wire format now used by `main.ts`/`acp.ts`:
  `session/new` config options, `agent_message_chunk`/`usage_update`/
  `available_commands_update`/`config_option_update`, and
  `session/set_config_option {sessionId, configId, value}`.
- **Confirm in the running window:** tool-call event shapes (`tool_call` /
  `tool_call_update`) weren't exercised (the probe turn used no tools); the gate's
  stderr `[BLOCKED …]` line is the reliable block signal regardless.

See [`../DECISIONS.md`](../DECISIONS.md) ADR-0006 for why the gate stays
in-process and the GUI is a front end only.

## Build a macOS installer (.dmg)

The app is packaged with **electron-builder** (config in `package.json` → `build`,
mac entitlements in `build/entitlements.mac.plist`). A `.dmg`/`.zip` is produced
for both Apple Silicon (`arm64`) and Intel (`x64`).

> **Must be built on macOS.** electron-builder can't produce/sign a mac `.dmg`
> from Windows or Linux. Run this on a Mac (or mac CI runner).

```bash
cd desktop
bun install            # pulls electron + electron-builder
bun run dist:mac       # → desktop/release/LucidAgentIDE-<ver>-{arm64,x64}.dmg (+ .zip)
```

### What the installer bundles vs. requires

The `.app` bundles the **renderer + the LucidAgentIDE repo** it runs (harness,
tools, scanner-sidecar, desktop sources, and `node_modules`) into
`Contents/Resources/repo` (`extraResources`), and the main process resolves paths
from there when packaged.

It still **orchestrates tools on the user's Mac** (it spawns them, it doesn't
embed them) — so the target Mac needs:

- **Bun** (`~/.bun/bin/bun`) — runs the in-app server + bundles the renderer.
- **omp** (`~/.bun/bin/omp`, `bun add -g @oh-my-pi/pi-coding-agent`) — the agent.
- **Python + uv** for the Unicode scanner sidecar — once, in the bundled repo:
  `cd "<App>/Contents/Resources/repo/scanner-sidecar" && uv sync`.

(Embedding bun/omp/python into the `.app` is a future step.)

### Signing / notarization

The config builds **unsigned** by default. Unsigned apps hit Gatekeeper — first
launch via right-click → **Open**. To ship it, set an Apple Developer identity
(`CSC_LINK`/`CSC_KEY_PASSWORD` env or `mac.identity`) and add notarization
(`afterSign` + `@electron/notarize`); the hardened-runtime entitlements are
already in place.

> Note: this packaging is **configured but not built/tested from this Windows
> host** — run `dist:mac` on a Mac and tell me anything that needs adjusting.
