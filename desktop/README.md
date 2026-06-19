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

## Installers (.dmg / .exe) and the app icon

The app is packaged with **electron-builder** (config in `package.json` → `build`,
mac entitlements in `build/entitlements.mac.plist`).

| Platform | Targets | Arch |
| --- | --- | --- |
| macOS | `.dmg` + `.zip` | `arm64`, `x64` |
| Windows | NSIS `…-Setup.exe` + `…-portable.exe` | `x64` |
| Linux | `.AppImage` | `x64` |

### The icon

The brand icon's single source of truth is [`build/icon.svg`](build/icon.svg) — a
glowing **π** core inside a magenta→cyan "agent orbit." `bun run icons`
(`build/make-icons.ts`, run automatically by every `dist:*` script) rasterizes it
to `build/icon.png` (1024², → macOS `.icns`) and `build/icon.ico` (16–256 px, →
the Windows `.exe`, installer, and taskbar). The generated PNG/ICO/ICNS are
git-ignored — only the SVG is committed.

### Recommended: build via GitHub Actions (no Mac/Windows box needed)

[`.github/workflows/build-desktop.yml`](../.github/workflows/build-desktop.yml)
builds **both** installers on native runners (macOS for the `.dmg`, Windows for
the `.exe`) — the only way to produce a mac `.dmg` without a Mac.

- **Manual:** GitHub → **Actions → "Build desktop installers" → Run workflow**.
  Installers download as run **artifacts**.
- **On a release:** push a tag and the installers attach to that tag's Release:
  ```bash
  git tag v0.1.0 && git push origin v0.1.0
  ```

Builds are **unsigned** — no Apple/Windows certificates required to run the
workflow.

### Build locally

```bash
cd desktop
bun install            # pulls electron + electron-builder
bun run dist:mac       # → release/LucidAgentIDE-<ver>-{arm64,x64}.dmg (+ .zip)   (on macOS)
bun run dist:win       # → release/LucidAgentIDE-<ver>-Setup.exe (+ portable.exe) (on Windows)
```

> **A mac `.dmg` must be built on macOS** — electron-builder can't produce/sign
> one from Windows or Linux. Use the workflow above, or a Mac.
>
> **Building the Windows installer locally needs Developer Mode** (or an elevated
> shell): electron-builder extracts a signing toolchain that contains symlinks,
> which Windows blocks for unprivileged processes (`A required privilege is not
> held by the client`). The packaged app itself (`release/win-unpacked/`) builds
> fine without it — only the final `Setup.exe` step needs the privilege. The CI
> `windows-latest` runner has it, so the workflow is the friction-free path.

### What the installer bundles vs. requires

Both installers bundle the **renderer + the LucidAgentIDE repo** they run
(harness, tools, scanner-sidecar, desktop sources, and `node_modules`) into
`Resources/repo` (`Contents/Resources/repo` on macOS) via `extraResources`, and
the main process resolves paths from there when packaged. (Verified on Windows:
`release/win-unpacked/resources/repo/` contains harness + scanner-sidecar +
the in-process security gate.)

It still **orchestrates tools on the user's machine** (it spawns them, it doesn't
embed them) — so the target machine needs:

- **Bun** — runs the in-app server + bundles the renderer.
- **omp** (`bun add -g @oh-my-pi/pi-coding-agent`) — the agent.
- **Python + uv** for the Unicode scanner sidecar — once, in the bundled repo:
  `cd "<App>/…/Resources/repo/scanner-sidecar" && uv sync`.

(Embedding bun/omp/python into the installer is a future step.)

### Signing / notarization

The config builds **unsigned** by default.

- **macOS:** unsigned apps hit Gatekeeper — first launch via right-click →
  **Open**. To ship it, set an Apple Developer identity (`CSC_LINK` /
  `CSC_KEY_PASSWORD` env or `mac.identity`) and add notarization (`afterSign` +
  `@electron/notarize`); the hardened-runtime entitlements are already in place.
- **Windows:** SmartScreen warns on unsigned `.exe` — click **More info → Run
  anyway**. To ship it, set an Authenticode cert (`CSC_LINK` / `CSC_KEY_PASSWORD`).

> Status: the **Windows** packaging is verified on this host up to the unpacked
> app (`win-unpacked` builds with the icon embedded + repo bundled); the final
> `Setup.exe` and the **macOS** `.dmg` are produced by the GitHub Actions workflow
> on native runners (run it and grab the artifacts).
