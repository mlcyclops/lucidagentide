# LucidAgentIDE — desktop (Electron)

A polished desktop shell around omp + the LucidAgentIDE security harness:
a gated agent chat, plus live security / memory-&-context dashboards — same
renderer as the browser build, with real `omp acp` wired in.

## Run

**Just the UI (no Electron, screenshot-able in a browser):**

```bash
bun run desktop:web        # from repo root → http://localhost:4318
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

## Verified vs. to confirm on first run

- **Verified:** the renderer (screenshotted), the dashboards on live data, the
  ACP `initialize` handshake (`bun run acp:probe`), and that the gate loads under
  `omp acp -e …`.
- **Confirm on first real model turn:** the ACP `session/update` → chat-event
  mapping in `main.ts` follows the ACP spec but could not be exercised headlessly;
  field names may need a small tweak against a live stream.

See [`../DECISIONS.md`](../DECISIONS.md) ADR-0006 for why the gate stays
in-process and the GUI is a front end only.
