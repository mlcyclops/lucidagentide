# ArtCraft Crafting Apps in LUCID Creator and LUCID plugins

ArtCraft (Brandon Thomas, talk "How I cloned Adobe with AI", AI Engineer channel, CODE Summit 2026) publishes seventeen
native, pure-Rust desktop apps under the GitHub organization `storytold`, each dual-licensed MIT OR Apache-2.0 and
each drivable from a headless `<app>-cli` with a stdio MCP server, plus a launcher, a shared AI layer with a one-entry
MCP gateway, and a TypeScript repo-maintenance factory called AutoCraft. The licenses permit redistribution, but the
apps are early alpha or in development, ship weekly, weigh roughly 100 to 140 MB per app per platform, carry a
restrictive brand license, and expose an MCP server whose own docs say it has no tool-level authorization. This
document therefore recommends that LUCID **does not bundle** any Crafting App in the Creator installers. Instead it
**detects** an installation the user made from the official source, labels it honestly in Creator Studio's
integration registry, and then **drives the headless CLI's MCP server through the engine**, behind a LUCID read/write
policy and the untrusted-output delimiters, the same way CREATOR-DRIFT drives CutWire Drift. A LUCID plugin comes
later, for the Agent edition's document apps only, after the Creator path has proven the policy. The first increment
(CREATOR-ARTCRAFT.1) is detection plus honest registry rows, with every MCP capability labeled `planned`.

Research date: 2026-11-20. Decision record: ADR-0619 (P-SETUX.1). Every statement this research could not check
against a primary source is marked **[unverified]**; statements derived by reasoning rather than read are marked
**[inferred]**.

-----

## 1. Sources and how they were verified

The video page (`youtube.com/watch?v=UCL4K36SHp0`) has no transcript. Its description was read directly: ArtCraft
builds open source Rust alternatives to Adobe's creative tools, Microsoft Office and Figma with AI coding agents; MCP
and CLI automation, Linux support, reusable UI components and CI bottlenecks "lead into Autocraft, a forthcoming
software factory for issue triage, agentic development, evaluations and post training". The description links
`getartcraft.com/apps`, `github.com/echelon` and `x.com/echelon`.

Primary sources read for this document:

| Source | What it established |
| --- | --- |
| `https://getartcraft.com/apps` and each `https://getartcraft.com/apps/<id>` page | The 17 apps, maturity label, current version, per-platform installers, the CLI asset, and each page's automation claim |
| `https://getartcraft.com/` | "Open source on GitHub" links to `https://github.com/storytold`; ArtCraft Studio is a separate generative app |
| `https://github.com/echelon` | Brandon Thomas, founder of ArtCraft; a personal account, member of the `storytold` org; pins `storytold/photocraft` and `storytold/artcraft` |
| `https://github.com/orgs/storytold/repositories` | Every app repo, its language and GitHub's detected license |
| `storytold/photocraft` README, `docs/development.md`, `docs/mcp.md`, `book/src/automation/mcp.md`, `docs/releasing.md`, `docs/brand/LICENSE-brand.txt` | CLI and MCP surface in detail, install locations, signing, brand license |
| `storytold/photocraft` release `v0.23.1` asset list | Asset sizes, per-asset sha256, `SHA256SUMS.txt` plus `SHA256SUMS.txt.asc` and `release-signing-key.asc` |
| READMEs of `filmcraft`, `lightcraft`, `pdfcraft`, `effectcraft`, `soundcraft`, `cadcraft`, `craft-anything`, `artcraft` | Per-app MCP invocation and licensing |
| `storytold/craft-launcher`, `storytold/craft-ai-integrations`, `storytold/autocraft`, `storytold/craft-skills` | Launcher, the `craft-ai-mcp` gateway and `craft-ai-agents` consent file, AutoCraft, skills corpus |

Web search was not available to this research session, so look-alike repositories were not enumerated by search; the
canonical identities below come from following links outward from `getartcraft.com` (section 7.3).

-----

## 2. Inventory

All 17 apps: repo `https://github.com/storytold/<id>`, language Rust, native GUI with no Electron and no web view
(site principle 02). License column: GitHub detects Apache-2.0 for every repo; the README states dual MIT OR
Apache-2.0 where marked "dual (README)". Platforms: every app page lists macOS (universal DMG plus a separate signed
and notarized CLI zip), Windows (x64 MSI, plus arm64 MSI and portable zips on the PhotoCraft page) and Linux (Flatpak,
AppImage, deb, rpm, tarball); Web (a self-hostable WebAssembly build) is listed for every app except FilmCraft.
"Replaces" for PhotoCraft, VectorCraft, FilmCraft, LightCraft, PdfCraft, EffectCraft and DesignCraft comes from the
Adobe trademark notice in the PhotoCraft README that names the workflows the suite is compatible with, and for
FigCraft, WordCraft, DeckCraft and GridCraft from the talk description (Office, Figma); the rest are **[inferred]**
from the app page wording.

| # | App | Replaces | Version (2026-11-20) | Maturity | License | Agent surface (how it is exposed) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | PhotoCraft | Photoshop | 0.23.1 | Early alpha | dual (README) | `photocraft-cli mcp` on stdio (`--headless` plus `--automation-read-root` / `--automation-write-root`, or `--bridge 127.0.0.1:<port> --control-token-file <f>` to a running app); `run`, `batch`, `serve` (JSON lines), `commands`; 500+ commands; built on `rmcp` |
| 2 | VectorCraft | Illustrator | 0.24.1 | In development | Apache-2.0 | `vectorcraft-cli`; page: "VectorCraft's MCP server hands all of them [every command] to your AI agent" |
| 3 | FilmCraft | Premiere Pro | 0.20.1 | In development | Apache-2.0 | `filmcraft-cli mcp` (headless); JSON lines over TCP control channel; 650+ commands; own H.264/HEVC/ProRes/AAC codecs, no FFmpeg, no GPL/LGPL code (README) |
| 4 | LightCraft | Lightroom | 0.21.1 | In development | Apache-2.0 | `lightcraft-cli mcp <library>` headless, `--connect 127.0.0.1:<port>` to the live app |
| 5 | PdfCraft | Acrobat | 0.21.1 | Early alpha | Apache-2.0 | `pdfcraft-cli mcp --root <dir>`, stdio, opt-in, "opens no network port"; CLI-only Linux tarball |
| 6 | EffectCraft | After Effects | 0.24.1 | In development | Apache-2.0 | `effectcraft-cli mcp`, stdio, headless or attached bridge; repo ships `.mcp.json` |
| 7 | AniCraft | Animate **[inferred]** | 0.2.1 | Early alpha | Apache-2.0 | `anicraft-cli`; page: "the CLI, a JSON-lines channel and an MCP server can draw, animate and export" |
| 8 | DesignCraft | InDesign | 0.20.1 | In development | Apache-2.0 | `designcraft-cli`; JSON control channel and MCP server (page) |
| 9 | FigCraft | Figma | 0.18.1 | Early alpha | Apache-2.0 | `figcraft-cli`; 400+ commands; CLI, JSON control channel, MCP (page) |
| 10 | TextureCraft | Substance 3D Painter **[inferred]** | 0.6.1 | In development | Apache-2.0 | `texturecraft-cli`; CLI, JSON control channel, MCP (page) |
| 11 | MaterialCraft | Substance 3D Designer **[inferred]** | 0.4.1 | In development | Apache-2.0 | `materialcraft-cli`; CLI, JSON control channel, MCP (page) |
| 12 | SoundCraft | Pro Tools **[inferred]** | 0.20.1 | In development | Apache-2.0 | `soundcraft-cli mcp --automation-read-root <d> --automation-write-root <d>` (and `--demo`) |
| 13 | WordCraft | Word | 0.18.1 | In development | Apache-2.0 | `wordcraft-cli`; 389 commands; CLI, JSON control channel, MCP (page) |
| 14 | DeckCraft | PowerPoint | 0.18.1 | In development | Apache-2.0 | `deckcraft-cli`; 200+ commands; CLI, JSON control channel, MCP (page) |
| 15 | CADCraft | AutoCAD **[inferred]** | 0.20.1 | In development | Apache-2.0 | `cadcraft-cli mcp` on stdio headless, `--connect 127.0.0.1:<port>` live, automation roots; tools include `command_line`, `execute` |
| 16 | GridCraft | Excel | 0.19.1 | In development | Apache-2.0 | `gridcraft-cli`; "every ribbon button, menu item, and formula" over MCP, CLI or JSON control channel (page) |
| 17 | Craft Anything | none (software study and build tool) | 0.6.1 | Early alpha | dual (README) | `craft-anything-cli`; desktop app, CLI or MCP server "access the same engine"; works with a coding agent |

Shared infrastructure in the same org, relevant to integration:

| Repo | What it is | License | Relevance |
| --- | --- | --- | --- |
| `storytold/craft-launcher` (v0.19.2, early alpha) | egui launcher that installs, updates and opens every app; verifies every download against the release `SHA256SUMS.txt`; also lists the community apps SolidCraft (`tangency-labs/solidcraft`) and MailCraft (`UCS-Care-Group/mailcraft`), which are NOT ArtCraft-team apps | dual (README) | The official install and update path; LUCID should defer to it, not compete with it |
| `storytold/craft-ai-integrations` | Shared AI layer: provider adapters (OpenAI-compatible, BFL, Gemini, Vertex, Seedance, ArtCraft Omni), ComfyUI, local SAM engines; crate `craft-ai-agents` (the consent file `ArtCraft/mcp/apps.json`) and crate `craft-ai-mcp`, "one MCP server for every installed Craft app: four tools (list apps, find tools, describe, call) over stdio", shipped and switched on by the launcher | MIT OR Apache-2.0 (README) | Alternative single MCP entry; also the source of in-app cloud egress (section 7.5) |
| `storytold/craft-libs` | Shared Rust libraries | Apache-2.0 | none directly |
| `storytold/craft-extensions` | "Shared themes, plug-ins and resources for the Craft App Suite: package contract and on-disk store (provisional)" | Apache-2.0 | Watch only; provisional |
| `storytold/craft-skills` | Skills corpus for agentic use; today holds only README, AGENTS.md, CLAUDE.md | none detected | Nothing to import yet |
| `storytold/autocraft` | AutoCraft: a TypeScript (Node 24, pnpm) harness that mirrors a GitHub repo's issues and PRs into SQLite and runs Claude and Jev model stages (classify, duplicates, priority, review, fix, verify, merge queue) with operator approval for every GitHub write; exposes an MCP server on its dashboard (`POST /mcp`, streamable HTTP, personal bearer token) | MIT OR Apache-2.0 files present (`LICENSE-APACHE`, `LICENSE-MIT`) | Not a creator tool. Its `/mcp` is a self-hosted https endpoint, so it already fits LUCID's MCP settings (http transport plus token) for a maintainer who runs it; it does not belong in the community catalog because it has no vendor-hosted endpoint |
| `storytold/artcraft` (ArtCraft Studio) | The generative image and video app (multi-provider) | dual (README) | Separate product; out of scope for this document |

Status of AutoCraft against the talk: the description calls it "forthcoming"; the repo is public with 203 stars and a
full deployment story (systemd, k8s, compose). Whether it is released for outside use beyond that **[unverified]**.

### 2.1 Facts that matter for integration (verified on PhotoCraft, assumed suite-wide)

- **Install locations (Windows).** The MSI installs per user to `%LOCALAPPDATA%\Programs\ArtCraft\<App>\` by default and
  puts `<app>-cli.exe` beside the GUI exe, **not on PATH**; an all-users install, and every launcher install, goes to
  `C:\Program Files\ArtCraft\<App>\`. Linux deb and rpm install `/usr/bin/<app>-cli`. On macOS the `.app` holds only
  the GUI; the CLI is the separate signed and notarized zip, wherever the user unpacked it. Verified for PhotoCraft
  (`book/src/automation/mcp.md`) and the launcher README; that every app follows the same layout is **[unverified]**.
- **The GUI exe cannot answer a probe on Windows.** Release builds use the GUI subsystem, so `--help` and `--version`
  print nothing to a terminal (PhotoCraft `docs/development.md`). A probe must run `<app>-cli.exe`, never the GUI exe.
- **Headless is opt-in per call.** Without `--headless`, `photocraft-cli mcp` works in the open window when the
  launcher's "Let AI agents use Craft apps" switch is on, and may start the GUI. LUCID must always pass `--headless`
  until it deliberately builds the live-app increment. Flag names differ per app (`--root` in PdfCraft, a positional
  library in LightCraft, `--connect` versus `--bridge` for the live app), so an argv table per app is required.
- **Filesystem authority is explicit.** Headless MCP gets only the read roots and the single write root on its argv;
  environment variables do not grant headless access; omitting a root denies that direction.
- **No tool-level authorization.** PhotoCraft's own security notes: "The current server does not issue scoped
  sessions or distinguish trusted tools from high-impact tools ... Do not expose either transport through an
  untrusted broker, shell, proxy, or remote service without adding an external policy boundary." LUCID is that
  boundary and must supply its own read/write classification.
- **Tools (PhotoCraft).** `session_list`; `doc_open`, `doc_new`, `doc_place`, `doc_replace_smart_object`,
  `doc_export_layers`, `doc_export_data_sets`, `doc_import_data_sets`, `doc_save`, `doc_export`, `doc_inspect`,
  `doc_render_preview` (returns a PNG image), `doc_select`, `doc_close`; `command_list`, `command_run`,
  `command_batch`; `jobs_list`, `jobs_cancel`; bridge only: `ui_inspect`, `ui_screenshot`, `ui_pointer`,
  `ui_menu_invoke`, `ui_set`, `control_call`. Resources `photocraft://document` and `photocraft://commands`. The five
  "shared core tools" across the suite are `command_list`, `command_run`, `command_batch`, `doc_inspect`,
  `render_preview` (per PhotoCraft's book; suite-wide uniformity **[unverified]**).
- **Release integrity.** Every PhotoCraft release carries `SHA256SUMS.txt`, a detached `SHA256SUMS.txt.asc`, and
  `release-signing-key.asc` inside the same release. macOS builds are signed with "Developer ID Application: Learning
  Machines LLC (DJ6XS33FX8)" and notarized. Windows "installers and executables are code-signed" via a `.pfx` or
  Azure Trusted Signing; the Windows publisher subject name **[unverified]**.
- **Sizes (PhotoCraft 0.23.1).** Windows x64 MSI 113 MB, Windows x64 portable zip 137 MB, macOS CLI zip 115 MB, other
  desktop packages 93 to 135 MB, web build zip 15.3 MB. Extrapolated to 17 apps that is roughly 2 GB per platform
  **[inferred]**.

-----

## 3. How LUCID integrates external creative tools today

Read for this document: `docs/CREATOR-MODE.md`, `desktop/creator_registry.ts`, `desktop/creator_probe.ts`,
`desktop/creator_drift.ts`, `harness/creator/drift_policy.ts`, `harness/omp/drift_extension.ts`,
`desktop/renderer/creator_studio.ts`, `desktop/build/electron-builder.creator.cjs`, `desktop/build/build-creator.ts`,
`desktop/build/fetch-runtimes.ts`, `desktop/build/fetch-whistle.ts`, `.github/workflows/build-creator.yml`,
`tools/build_addons.ts`, `harness/plugins/package.ts`, `desktop/plugins/mcp.ts`, `desktop/settings_store.ts`,
`desktop/renderer/plugin_catalog.ts`, `desktop/renderer/plugins_flyout.ts`, `plugins/herd/lucid-plugin.json`,
`THIRD-PARTY-NOTICES.md`.

- **Creator integration registry** (`desktop/creator_registry.ts`, ADR-0282). A closed `CreatorProviderId` union, a
  closed capability vocabulary, and four honesty labels: `available` (official documented API, CLI or runtime today),
  `unverified-endpoint` ("bring your endpoint"), `product-ui-only` ("vendor app only"), `planned`. Each provider has
  `kind` (`local-app` for desktop tools), `transports` (`child-process`, `local-http`, ...), `docsUrl`, a `note`, and a
  CUI posture (`on-device` for local tools). Declarations never hold secrets.
- **Probes** (`desktop/creator_probe.ts`). `configured` is not `ready`. A desktop tool (Blender, HyperFrames, OpenFilm)
  is attested by its declared executable existing plus a fixed-argv `--version`; Drift additionally searches default
  install paths (`defaultDriftExePaths`) and a discovery file. Probes expire after 15 minutes.
- **The closest precedent is CREATOR-DRIFT.** Drift (GPL-3.0) serves MCP on localhost; LUCID never bundles or links
  it. The engine discovers Drift's own `mcp-session.json`, holds the token, applies the CUI gate, and exposes token'd
  engine routes (`/api/creator/drift/status|call|library`). The omp extension `harness/omp/drift_extension.ts`
  registers four tools with approval levels (`drift_status` and `drift_read` read, `drift_apply` and `drift_export`
  write), wraps every answer in the UNTRUSTED delimiters, and a pure policy module (`harness/creator/drift_policy.ts`)
  classifies read-only tools and cloud-reaching ops. ArtCraft fits this template almost exactly, with stdio instead of
  HTTP.
- **Bundled third-party payloads** are pinned and hash-verified fail-closed: `fetch-runtimes.ts` (bun, uv, CPython:
  exact version plus committed SHA-256 cross-checked against the vendor's published checksums, `REFRESH=1` prints new
  hashes), `fetch-whistle.ts` (size plus SHA-256, `.part` then rename), each staged into an `extraResources` folder,
  each listed in `THIRD-PARTY-NOTICES.md`.
- **Creator release gates** (`build-creator.yml`). A release run fails on Windows without a signer, then checks that
  every `.exe` in `release-creator/` and the top level of `release-creator/win-unpacked/` is validly signed and
  timestamped by `CN=TECHLEAD 187 LLC` with that CompanyName; the air-gap smoke, Program Files boot smoke and release
  identity gate run against Creator bytes.
- **LUCID's MCP store** (`desktop/settings_store.ts`) supports only remote `http` and `sse` transports with an optional
  bearer token; the P-SETUX.1 community catalog (`desktop/renderer/mcp_catalog.ts`) admits only official https
  endpoints. A local stdio server cannot be added there. Every MCP tool result that reaches omp is scanned and
  delimited by the in-process MCP result gate (`harness/omp/mcp_result_gate.ts`, ADR-0152).
- **Plugins** (`harness/plugins/package.ts`, ADR-0462). A `.lplugin.zip` holds `lucid-plugin.json` (schema 1),
  `LICENSE`, the payload, and an Ed25519 `signature` over the canonical manifest, which lists every file's SHA-256.
  Manifest fields: `schema`, `id`, `name`, `version`, `publisher`, `license`, `tier` (`free` or `premium`), `section`
  (`civilian` or `government`), `kind` (`web` with `entry.root` and `entry.index`; `server` with `entry.main` and
  `entry.healthPath`; `daemon` with `entry.exe`, `entry.args`, `entry.healthPath`), optional
  `mcp: { command, args }` where `command` must be `"node"` or a path **inside the package**, optional
  `ai: { provider: "lucid" }`, `permissions` limited to `network:loopback`, `network:internet`, `fs:plugin-data`, and
  `csp` (web only). A running plugin's MCP server is registered as an ACP stdio entry while it is healthy
  (`desktop/plugins/mcp.ts`). Offered add-ons are packed and signed at build time by `tools/build_addons.ts` and
  installed only when the user presses Install (Herd, ADR-0541). The Plugins drawer's FREE registry
  (`plugin_catalog.ts` `FREE_PLUGINS`) has statuses `featured`, `built-in`, `planned`, `add-on`.

-----

## 4. Integration options, evaluated

### (a) Bundle in the Creator installers: rejected for now

What it would take, if a later decision reverses this:

- A `desktop/build/fetch-craft.ts` in the `fetch-runtimes.ts` mold: a committed table of `{ app, version, asset,
  sha256 }` per platform, downloading only from `https://github.com/storytold/<app>/releases/download/v<ver>/`, verifying
  the committed SHA-256 fail-closed, and additionally verifying `SHA256SUMS.txt.asc` against a key fingerprint
  committed in LUCID (never trusting the `release-signing-key.asc` that ships inside the same release, which proves
  nothing about who published it). Stage into `desktop/craft/`, map it as an `extraResources` entry in the Creator
  overlay only, add a `bun run craft` step to the three `dist:*:creator` scripts, and add a THIRD-PARTY-NOTICES.md
  section with the MIT and Apache-2.0 texts, each app's NOTICE and ATTRIBUTION.md.

Why not now:

1. **Size.** One app is about 113 to 137 MB per platform; even four apps would roughly double a Creator installer
   **[inferred]**, and the air-gap smoke would need to account for them.
2. **Signing.** The Creator Windows gate demands that every top-level exe be signed by TECHLEAD 187 LLC. ArtCraft exes
   are signed by their own publisher. Re-signing them would misattribute authorship and modify official builds; not
   re-signing them requires carving an exception into a release gate whose whole value is having no exceptions. Whether
   electron-builder would re-sign exes placed under `resources/` **[unverified]**.
3. **Churn.** Versions moved weekly in November 2026 and the apps are labeled early alpha or in development. A bundled
   copy is stale within days, and it cannot be updated by the official launcher, which only updates installs in the
   standard locations.
4. **Brand license.** The ArtCraft name and marks may appear only in the app itself and its official builds, unmodified,
   and never in the name, icon or marketing of anything else (section 7.1). Shipping the apps inside a LUCID-branded
   installer invites exactly the endorsement suggestion the license forbids.

The web builds (15.3 MB for PhotoCraft) are the one bundling shape worth revisiting later, as a LUCID `web` plugin in
the sandboxed Preview panel, but that still ships ArtCraft marks inside a LUCID package and needs ArtCraft's written
permission first.

### (b) Detect-and-launch in Creator Studio's registry: recommended first

One new provider, not seventeen: id `craft-suite`, name "Crafting Apps (storytold)", group by its most common use
(`video`, which the Studio titles "Image and video"), `kind: "local-app"`, `transports: ["child-process"]`,
`authKind: "local"`, `cui: { posture: "on-device" }`, `docsUrl: "https://getartcraft.com/apps"`. Each installed app
becomes one endpoint row of that provider (the existing `endpoints` field of `ProviderStatusView`), so the Studio grows
by one row that expands, rather than seventeen rows, in line with the P-SETUX.1 complexity review.

Detection, per app, from a committed table `{ id, name, cli, folder }` (for example
`{ id: "photocraft", name: "PhotoCraft", cli: "photocraft-cli", folder: "PhotoCraft" }`):

- Windows: `%LOCALAPPDATA%\Programs\ArtCraft\<folder>\<cli>.exe`, then `%ProgramFiles%\ArtCraft\<folder>\<cli>.exe`.
- Linux: `/usr/bin/<cli>`.
- macOS, and anything else: a user-declared absolute path, validated by the existing declaration rules (no shell
  strings, no `npx`, no shims).

Probe: fixed argv `<cli> --version`, captured version line, exit code; `ready` only on an answer. The probe never runs
the GUI exe (it prints nothing on Windows) and never runs `mcp` (that is CREATOR-ARTCRAFT.2). Capabilities map to the
existing vocabulary and stay `planned` until wired, for example PhotoCraft `layers`, `mask-trace`, `psd-export`;
VectorCraft `vector-draw`, `svg-export`; FilmCraft `video-edit`; EffectCraft and AniCraft `motion`; SoundCraft
`audio-mix`; PdfCraft `pdf-markup`; CADCraft `cad-drawing`, `cad-convert`. The `note` says: "Installed from
getartcraft.com or the ArtCraft Launcher; LUCID detects the official CLI and never installs, bundles or updates it."
When an app is not found the row says `not-installed` with exactly one link, `https://getartcraft.com/apps/<id>`.

"Launch" means opening a file the agent produced in the user's installed GUI on explicit click (Windows via the
shell, as PhotoCraft's own CLI does), never automatically.

### (c) MCP connector: recommended, engine-mediated, not through MCP settings

The Crafting Apps' MCP servers are local stdio processes, so they cannot enter LUCID's MCP store or the community
catalog (both https only, by design). Two stdio routes exist:

1. **Engine-mediated, the Drift template (recommended).** The engine spawns
   `<cli> mcp --headless --automation-read-root <workspace> --automation-write-root <creator job dir>` as a fixed-argv
   child process through the existing exec path, speaks JSON-RPC over its stdio, and exposes token'd routes
   `/api/creator/craft/status|call|library`. A new omp extension `harness/omp/craft_extension.ts` registers
   `craft_status` (read), `craft_read` (read), `craft_apply` (write) and `craft_export` (write), with every answer
   inside the UNTRUSTED delimiters, and a pure `harness/creator/craft_policy.ts` classifies tools:
   - read: `session_list`, `command_list`, `doc_inspect`, `doc_render_preview`, `jobs_list`, resource reads;
   - write (approval "write"): `doc_new`, `doc_open`, `doc_place`, `doc_select`, `doc_save`, `doc_export*`,
     `doc_import_data_sets`, `doc_replace_smart_object`, `command_run`, `command_batch`, `jobs_cancel`, `doc_close`;
   - refused in this route: every bridge-only tool (`ui_*`, `control_call`), and any command id the policy marks as
     reaching a cloud AI provider (section 7.5).
   Exports land in the Creator library through the library route, as `drift_export` does. The write root is a
   per-job directory under the Creator data root, never the user's home; the read root is the open workspace only.
2. **Direct ACP stdio registration** (the `desktop/plugins/mcp.ts` shape). Simpler, and the ADR-0152 result gate
   would scan results, but it hands the agent 20+ raw tools including `command_run` over 500+ commands with no LUCID
   read/write distinction, which ArtCraft's own docs say must not be exposed without an external policy boundary.
   Rejected as the primary route.

The `craft-ai-mcp` gateway (one entry for every app) is attractive for its single process, but it follows the
launcher's consent file and may reach the live GUI, and how it passes automation roots is **[unverified]**. Keep it as
an open question, not a dependency.

Security gate notes: `doc_render_preview` returns a PNG; how the scan and delimit path treats image content from an
engine route is an open question for CREATOR-ARTCRAFT.2 (the Drift `frames` and `capture` tools are the precedent to
check). Under CUI lockdown the provider stays allowed (`on-device`), but cloud-AI commands inside the apps are refused
by the policy.

### (d) LUCID plugin: later, for the Agent edition's document apps

The Agent edition has no Creator Studio, so PdfCraft, WordCraft, GridCraft and DeckCraft would reach it as a plugin or
not at all. Manifest shape that would validate today (illustrative, unsigned, not shipped):

```json
{
  "schema": 1,
  "id": "craft-docs",
  "name": "Office documents (PdfCraft, WordCraft, GridCraft, DeckCraft)",
  "version": "0.1.0",
  "publisher": "TECHLEAD 187 LLC",
  "license": "BUSL-1.1",
  "tier": "free",
  "section": "civilian",
  "kind": "server",
  "entry": { "main": "server.js", "healthPath": "/healthz" },
  "mcp": { "command": "node", "args": ["craft_mcp.js"] },
  "permissions": ["network:loopback", "fs:plugin-data"]
}
```

The gap: `craft_mcp.js` would have to spawn an executable outside the package (the user's `pdfcraft-cli.exe`), and the
schema-1 permission set has no entry for "run a user-installed program". Shipping that would bypass the exec-approval
path the Creator route uses. So the plugin route needs either a new permission (for example `exec:declared`, enforced
by the runtime) or the same engine module surfaced in the Agent build as a `built-in` card. Plugin naming must avoid
the ArtCraft name and marks (section 7.1); the poster is the generated glyph poster `plugins_flyout.ts` already draws,
never an ArtCraft icon. First step is a `planned` FREE_PLUGINS card with a `repo` link to `https://github.com/storytold`,
and nothing else, until the Creator route has run for a release.

### Per-app recommendation

| App | Creator edition | Agent edition | Why |
| --- | --- | --- | --- |
| PhotoCraft | (b) then (c), first app wired | none | Best-documented MCP surface, PSD round trip, fits the Design suite |
| VectorCraft | (b), (c) in .3 | none | SVG output complements the in-renderer `design` editor |
| FilmCraft | (b), (c) in .3 | none | Overlaps Drift; keep both, label honestly; no GPL in FilmCraft |
| EffectCraft | (b), (c) in .4 | none | Motion titles; overlaps HyperFrames and OpenFilm compositions |
| AniCraft | (b) only | none | Version 0.2.1, earliest maturity; detect, do not drive yet |
| SoundCraft | (b), (c) in .3 | none | Fills the `audio-mix` gap ElevenLabs marks `planned` |
| LightCraft | (b) only | none | Library-centric tool; drive later if asked |
| TextureCraft, MaterialCraft | (b) only | none | 3D materials beside Blender; versions 0.6.1 and 0.4.1 |
| CADCraft | (b), (c) in .4 | none | Joins the `cad` group (DWG notes, drawing conversion) |
| DesignCraft, FigCraft | (b) only | none | Layout and UI design; drive later if asked |
| PdfCraft | (b), (c) in .4 | (d) in .5 | Complements `pdf-markup`; useful to Agent users too |
| WordCraft, GridCraft, DeckCraft | (b) only | (d) in .5 | Office documents matter more to Agent users |
| Craft Anything | catalog note only | none | Itself an agentic build tool that works "with a coding agent"; overlaps LUCID's own role |
| Launcher, craft-ai-mcp | link only | none | Official install and update path; LUCID defers to it |
| AutoCraft | none | none (user may add its `/mcp` as an http server in MCP settings) | Repo maintenance, not creative work |

-----

## 5. Phased increment plan

Each increment is one session, ends with a `make demo-CREATOR-ARTCRAFT.N` script in the style of
`desktop/scripts/demo_creator_drift.ts`, and keeps every capability label honest at every step.

| Increment | Scope | Demo |
| --- | --- | --- |
| **CREATOR-ARTCRAFT.1** Detect and label | `craft-suite` provider in `creator_registry.ts` (all capabilities `planned`); `desktop/creator_craft.ts` with the app table and pure `defaultCraftCliPaths(platform, env)`; `probeCraft` in `creator_probe.ts` (`<cli> --version` on fixed argv); Studio row with per-app endpoint lines and one official link per missing app; tests for path derivation and probe verdicts | Against a temp install tree: PhotoCraft `ready` with its version, VectorCraft `not-installed` with the getartcraft.com link, a GUI-only folder (no `-cli.exe`) reported as "GUI found, CLI missing", a declared path with a shell string refused |
| **CREATOR-ARTCRAFT.2** PhotoCraft headless MCP | `harness/creator/craft_policy.ts`; stdio JSON-RPC client in the engine; `/api/creator/craft/*` routes; `harness/omp/craft_extension.ts` (four tools, approval levels, UNTRUSTED delimiters); per-job write root in the Creator library; job ledger rows; PhotoCraft capabilities flip to `available` only for what the probe's `tools/list` attests | The agent creates an 1200x630 title card with a type layer, inspects it with `doc_inspect`, exports PNG and PSD into the library; a `ui_screenshot` request is refused by policy |
| **CREATOR-ARTCRAFT.3** Video, vector, audio | Per-app argv table entries for FilmCraft, VectorCraft, SoundCraft; resource admission before renders; export routes | A 6 second FilmCraft H.264 export of library clips, a VectorCraft SVG logo, a SoundCraft mixdown, each a ledger row with an artifact |
| **CREATOR-ARTCRAFT.4** Open in app, plus EffectCraft, CADCraft, PdfCraft | "Open in <App>" button for a library artifact (explicit click only); headless MCP for the three apps; cloud-AI command refusal under CUI lockdown | Open the PSD from .2 in the installed PhotoCraft; a CADCraft DWG to PDF conversion; a lockdown-on refusal of an AI command, quoted |
| **CREATOR-ARTCRAFT.5** Agent edition decision | Either a new plugin permission (`exec:declared`) with runtime enforcement, or the engine module surfaced as a `built-in` Plugins card in the Agent build; ADR records the choice | In the Agent build, the agent fills a PdfCraft form and exports a DeckCraft deck from an outline, with write approvals shown |
| **CREATOR-ARTCRAFT.6** Bundling spike (no shipping) | `fetch-craft.ts` behind an off-by-default flag: pinned versions, committed SHA-256, `SHA256SUMS.txt.asc` verified against a committed key fingerprint; measures installer growth and runs the Windows signature gate against the result | A report: installer size before and after, and which release gate fails; feeds a go or no-go ADR |

-----

## 6. Recommended first increment: CREATOR-ARTCRAFT.1

Files: `desktop/creator_registry.ts` (add `craft-suite` to the closed id union and catalog), new
`desktop/creator_craft.ts` (app table, `defaultCraftCliPaths`, path validation), `desktop/creator_probe.ts` (one
`case "craft-suite"`), `desktop/renderer/creator_studio.ts` (endpoint lines and the official link), tests beside each,
`desktop/scripts/demo_creator_artcraft_1.ts`, a `demo-CREATOR-ARTCRAFT.1` Makefile target, and a docs/CREATOR-MODE.md registry paragraph. No network,
no MCP process, no installer change, no new dependency. Acceptance: a machine with PhotoCraft installed from
getartcraft.com shows a `ready` row with the version line inside 15 minutes of freshness; a machine without it shows
`not-installed` and one link; nothing claims a capability is `available`.

-----

## 7. Risks

### 7.1 Licensing and trademarks

- Code: MIT OR Apache-2.0 (dual verified for PhotoCraft, Craft Anything, the launcher, ArtCraft Studio and
  craft-ai-integrations; GitHub detects Apache-2.0 for the other app repos, and their dual status is
  **[unverified]**). Both are compatible with redistribution beside BUSL-1.1 code, with NOTICE and license text
  preserved. Detection and driving a user-installed binary redistributes nothing.
- Marks: `docs/brand/LICENSE-brand.txt` makes the ArtCraft name, wordmark and mark non-open, usable only in the app and
  its official builds, unmodified, and never in "the name, logo, icon, domain, social media handle, app-store listing,
  advertising or marketing of anything other than" the app; no suggestion of endorsement of any "plug-in". LUCID UI
  text may state facts in plain text ("detected PhotoCraft 0.23.1"); LUCID must not use ArtCraft logos or app icons,
  name a LUCID feature or plugin "ArtCraft ...", or market the integration as ArtCraft-endorsed. Whether the app names
  themselves (PhotoCraft and others) are claimed marks **[unverified]**; ask ArtCraft before any marketing use.
- Adobe, Microsoft and Figma names appear only as descriptive comparisons, as the ArtCraft READMEs themselves do.

### 7.2 Supply chain

- LUCID never downloads or installs the apps in increments 1 to 5, so LUCID adds no new download path; the user's own
  install from getartcraft.com or the launcher (which verifies SHA-256) is the trust root, and the probe records which
  binary answered.
- If bundling is ever revisited: pin exact versions, commit SHA-256 cross-checked against the release's
  `SHA256SUMS.txt`, verify `SHA256SUMS.txt.asc` against a committed fingerprint obtained out of band, and fail closed,
  exactly as `fetch-runtimes.ts` does.
- The suite's 14k-fork counts (PhotoCraft) mean many same-named repos exist. Only `github.com/storytold/<app>` is
  canonical.

### 7.3 Look-alike repositories and binaries

Canonical identity, verified by following links outward from the official site:

- Site: `https://getartcraft.com` (apps at `/apps/<id>`, docs at `https://craft.wiki/apps/<id>/`).
- Code and releases: `https://github.com/storytold/<id>` for each of the 17 ids in section 2, release assets under
  `https://github.com/storytold/<id>/releases/download/v<version>/`; launcher `https://github.com/storytold/craft-launcher`.
- People: `https://github.com/echelon` (Brandon Thomas) is a personal account and a member of `storytold`; it hosts
  no app code. The talk's link to it is to the person, not to the code.
- Platform identity: Flatpak and Linux app ids use the `ai.storyteller.` prefix (for example
  `ai.storyteller.photocraft`); macOS Developer ID "Learning Machines LLC (DJ6XS33FX8)".
- Not ArtCraft-team code, though listed in the launcher as community apps: `tangency-labs/solidcraft`,
  `UCS-Care-Group/mailcraft`.

Rules for LUCID: the registry's only outbound links are `getartcraft.com` URLs; the probe reports the absolute path it
ran; any CLI path outside the official install folders is a user declaration and is labeled as such; LUCID never
suggests an install command, package name or registry (crates.io, npm, winget) that this research did not verify.
Package-manager listings **[unverified]**.

### 7.4 Product and maturity

Early alpha and in-development apps will change flags and tool names between weekly releases. The probe captures the
version; the policy matches tool names from `tools/list`, not from a hard-coded list, and refuses unknown tools by
default. Breakage reads as a refusal with the reason, never as success.

### 7.5 Data egress inside the apps

The apps embed `craft-ai-integrations`, which can call OpenAI-compatible, BFL, Gemini, Vertex, Seedance and ArtCraft
Omni endpoints with keys the user configured in the app or launcher. That traffic leaves from the app's process, not
LUCID's, so LUCID's egress whitelist does not see it. The policy must refuse AI-provider commands under CUI lockdown and
label them as cloud otherwise; the exact command ids **[unverified]** and must be read from `command_list` in
CREATOR-ARTCRAFT.2.

### 7.6 Live-app control

Plain `mcp` without `--headless` can attach to the user's open window or launch the GUI when the launcher's agents
switch is on, and the bridge tools can click and type in the GUI. LUCID always passes `--headless` until a dedicated,
opt-in increment designs the live route.

-----

## 8. Open questions

1. Does ArtCraft grant written permission to name the integration and show app icons in LUCID (brand license,
   "Everything else" clause)? Until answered: plain-text names, generated glyphs.
2. Is the Windows install layout (`<cli>.exe` beside the GUI under `ArtCraft\<App>`) identical for all 17 apps, and
   does the launcher always install all-users?
3. Do all apps accept `--headless`, `--automation-read-root` and `--automation-write-root`, or does each need its own
   argv (PdfCraft `--root`, LightCraft positional library)? Answer per app before wiring it.
4. How does LUCID's scan path treat the PNG returned by `doc_render_preview` when it crosses an engine route rather
   than the ADR-0152 MCP result gate?
5. Should LUCID use the `craft-ai-mcp` gateway once its root handling is documented, trading one process per app for
   one shared process that follows the launcher's consent file?
6. Who signs the Windows binaries (Authenticode subject), and where is the fingerprint for `SHA256SUMS.txt.asc`
   published outside the release itself?
7. For the Agent edition, does LUCID want a new plugin permission for running a user-declared program, or should
   external-tool integrations stay engine-owned in both flavors?
8. Is AutoCraft intended for outside deployment now, given the talk calls it forthcoming?
