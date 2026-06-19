# LucidAgentIDE — desktop (Electron)

A polished desktop shell around omp + the LucidAgentIDE security harness:
a gated agent chat, plus live security / memory-&-context dashboards — same
renderer as the browser build, with real `omp acp` wired in.

## Run

**Just the UI (no Electron, screenshot-able in a browser):**

```bash
bun run desktop:web        # from repo root → http://localhost:5319
```

The browser build uses live dashboards (`/api/security`, `/api/memory`) and a
*simulated* chat that demonstrates the gate blocking a poisoned command.

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

```
desktop/
  main.ts        Electron main: frameless window, spawns the two children, ACP↔IPC bridge
  preload.ts     contextBridge → window.lucid (dashboards via HTTP, chat via IPC, window ctrls)
  acp.ts         minimal Agent Client Protocol client (JSON-RPC over stdio)
  dev.ts         Bun server: bundles renderer/app.ts and serves /api data
  renderer/      the UI (vanilla TS, no framework) — identical in browser & Electron
    app.ts · styles.css · dom.ts · ui.ts · icons.ts · bridge.ts · format.ts
```

`renderer/bridge.ts` prefers `window.lucid` (Electron) and falls back to
`fetch('/api/*')` + a simulated stream in a plain browser, so the exact same
renderer is developed and screenshot-verified without Electron.

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
