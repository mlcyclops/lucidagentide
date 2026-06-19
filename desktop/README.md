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
  main.ts         Electron main: bootstrap runtimes, spawn dev.ts, open the window
  preload.ts      window.lucid = native shell only (crisp zoom + window controls)
  runtime.ts      runtime resolution + first-run bootstrap (bundled bun/uv → omp + scanner)
  splash.ts       first-run setup window (shown only when bootstrap has work to do)
  updater.ts      in-app auto-update via electron-updater (GitHub Releases)
  build/          icon.svg (brand mark) + make-icons.ts + mac entitlements
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

## AskSage gov gateway (ADR-0007)

Optional: route turns through the **AskSage** accredited government AI gateway
(`api.civ.asksage.ai`) instead of (or alongside) direct providers.

- **Enable:** Settings → Providers → **AskSage · Gov gateway** → paste your
  `ASKSAGE_API_KEY` (stored locally, git-ignored, never committed). Gov models
  (`GPT-5.2 · AskSage Gov`, `Claude Opus 4 · AskSage Gov`, …) then appear in the
  model picker automatically.
- **How:** `harness/omp/asksage_extension.ts` registers two omp providers via
  `pi.registerProvider` (OpenAI + Anthropic routes), loaded with a second `-e`
  alongside the security gate — no fork, gate still fail-closed on every turn.
- **Monthly usage** shows as a "Gov" chip in the status bar (refresh + 5-min poll).
- **Personas** (composer dropdown) are **scanned** by the same Unicode scanner as
  tool calls before use; a poisoned persona is blocked, a clean one is delimited.
- **Lockdown:** Settings → "AskSage-only" routes every turn through the gateway and
  hides direct providers.

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

### Zero-prerequisite install (bundled runtimes + first-run setup)

The installer is designed so the user installs **nothing** beforehand:

1. **Bundled** into the app (`Resources/runtimes`): the static **`bun`** and
   **`uv`** binaries — downloaded per-OS by the CI workflow, named
   `<tool>-<platform>-<arch>` to match [`runtime.ts`](runtime.ts).
2. **Bundled** into `Resources/repo` (`extraResources`): the renderer + the
   LucidAgentIDE repo it runs (harness, tools, scanner-sidecar, desktop sources,
   `node_modules`). The main process resolves paths from there when packaged.
   (Verified on Windows: `win-unpacked/resources/repo/` contains harness +
   scanner-sidecar + the in-process security gate.)
3. **Provisioned on first launch** ([`runtime.ts`](runtime.ts) →
   [`splash.ts`](splash.ts)) using the bundled bun/uv, into the app's userData:
   - **omp** — `bun add -g @oh-my-pi/pi-coding-agent` into a managed global dir.
   - **the scanner interpreter** — `uv venv … --python 3.12` (the sidecar has
     zero pip deps, so any 3.11+ interpreter works; uv downloads one if needed).

   A small setup splash appears only when there's work to do, then `LUCID_OMP_BIN`
   / `SCANNER_PYTHON` are passed down to the dev server and its omp + scanner
   children. On a machine that already has bun/omp/uv (e.g. a dev box), nothing
   is installed and no splash appears — resolution falls back to the user's own
   tools, then `PATH`.

If first-run setup fails (offline, etc.), the app still launches; the fail-closed
gate blocks tool calls until the scanner is available — it never treats a missing
scanner as "safe" (CLAUDE.md invariant #3).

### Auto-update

Packaged builds check **GitHub Releases** on launch and prompt to restart when a
newer version is downloaded ([`updater.ts`](updater.ts) + the `publish` provider
in `package.json`). To ship an update: bump `version`, then `git tag vX.Y.Z &&
git push origin vX.Y.Z` — the workflow builds installers and uploads the update
feed (`latest*.yml` + `.blockmap`) to that Release.

### Signing / notarization

The config builds **unsigned** by default; signing is **opt-in via GitHub
secrets** and the workflow signs + notarizes automatically when they're present.
Full secret list and setup: [`SIGNING.md`](SIGNING.md).

- **Unsigned macOS:** Gatekeeper — first launch via right-click → **Open**.
  (macOS *auto-update* needs a signed build.)
- **Unsigned Windows:** SmartScreen — **More info → Run anyway**. Windows
  auto-updates fine while unsigned.

> Status: the **Windows** packaging is verified on this host up to the unpacked
> app (`win-unpacked` builds with the icon embedded + repo bundled); the final
> `Setup.exe` and the **macOS** `.dmg` are produced by the GitHub Actions workflow
> on native runners (run it and grab the artifacts).
