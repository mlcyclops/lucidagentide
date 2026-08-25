# HANDOFF - Lucid Agent IDE

Cold-start context for a fresh or **remote** Claude session (see
`.github/workflows/claude.yml`). Read this, then `AGENTS.md` / `CLAUDE.md`
(the invariants, byte-identical below their title lines), before touching code.

## What this is

A security / provenance / memory layer built **around** oh-my-pi (omp), not a
fork. TypeScript on Bun, in-process with omp; the only Python is
`scanner-sidecar/` (the pure Unicode scanner). It ships as **LUCID Agent IDE**,
an Electron desktop app (Windows NSIS + portable, macOS .pkg/.zip, Linux
AppImage/deb/rpm), with the same gated agent available headless (`lucid`,
`lucid tui`, `lucid acp`). See `README.md` and `BUILD PLAN omp.md`.

## Current state (2026-08-25, v1.13.1)

The original build plan (Increment 0-2 + Phases 2-7) closed long ago; work is
now product increments, one per session, each with its own ADR. Newest:
**ADR-0273 / P-FLEET.L2** - fleet lanes are unlimited and admitted by *sustained*
pressure (refuse only at 90%+ held 30 unbroken seconds), lanes can be spawned
from a GitHub / GitLab / Azure DevOps / self-hosted remote with a per-host token
in the OS-encrypted vault, and the minimized fleet pill is a per-state snapshot
that no longer flickers.

Measured, not estimated:

- **1,041 harness tests** across 122 files (`bun test harness` on a clean
  checkout; CI run 32838505161: 1,037 pass / 4 skip / 0 fail).
- **2,036 desktop tests** across 185 files (`bun test desktop`, the generated
  `desktop/release/` copy excluded).
- **57 sidecar tests** (pytest). **207 `demo-*` targets** in the `Makefile`.
- `tsc --noEmit` clean at the root and in `desktop/`; BUSL-1.1 headers complete.
- 11 numbered DuckDB migration files (`harness/memory/migrations/`).

Both correctness keystones are in and over-tested: the **Unicode scanner**
(`scanner-sidecar/`) and the **semantic-promotion gate**
(`harness/memory/promotion_gate.ts`). The end-to-end guarantee holds: untrusted
text -> scanned -> trust-labeled -> sanitized -> persisted -> blocked at the
tool / promotion / dispatch boundaries -> human-reviewed -> exits only as safe,
audited evidence.

**Known local reds on Windows (pre-existing, green on the Linux CI runner) -
do not chase them:** `harness/launcher/lucid_acp.test.ts` (2, asserts POSIX
asset paths), `desktop/fs_browse.test.ts` (5, resolves a Windows HOME against a
POSIX fixture), `desktop/symbol_graph.test.ts` (4, needs the TS compiler).

## How to run

```bash
bun install
(cd scanner-sidecar && uv sync)

bun test harness                                    # harness suite (what CI gates)
bun test --path-ignore-patterns='desktop/release/**' desktop   # desktop suite
(cd scanner-sidecar && uv run pytest -q tests)      # scanner suite
bun x tsc --noEmit && (cd desktop && bun x tsc --noEmit)
bun run tools/license_headers.ts --check
```

`make` is the canonical task spec (`make test`, `make demo-<increment>`) but is
not installed on the Windows origin host, and `package.json` mirrors only the
early demos. Run any demo directly instead, e.g.
`bun run harness/scripts/demo_pfleetl2.ts` or
`bun run desktop/scripts/demo_p_sandbox_5.ts`; the target's recipe in the
`Makefile` names the script.

The desktop app runs from source with `cd desktop && bun run start` (builds
`dist/main.js` + preload, then launches Electron) or headless-in-browser with
`bun run web` (the `dev.ts` backend alone); installers are built by CI, never
locally.

## Session ritual (from AGENTS.md - follow it)

1. Read `AGENTS.md`. Confirm a green baseline (`bun test harness` + the previous
   `demo-*`) before changing anything.
2. Build **exactly one** increment. Keep every invariant (fail-closed; extend
   omp, never fork; untrusted content delimited + late; byte-stable prompt
   prefix; closed trust-label/event sets; stable IDs; DuckDB schema only via
   numbered migrations; UI labels never word-wrap in narrow columns).
3. Do **not** edit frozen contracts (`harness/contracts.ts`,
   `harness/tools/result_adapter.ts`, the frozen prompt prefix, applied
   migrations) as a side effect. A real contract change is its own increment
   plus an ADR (ADR-0273 changed `FleetStatusData.resources`; every consumer
   moved in the same increment).
4. Append a 3-line `PROGRESS.md` entry: shipped / stubbed / next. `/ship-docs`
   does that review + update.

## Cutting a release

1. Bump the four version sites: `desktop/package.json`, `desktop/version.ts`
   (`APP_VERSION` + a changelog comment line for the version being superseded),
   and the two pins in `desktop/about.test.ts`.
2. README: rewrite the **Newest (vX.Y.Z)** paragraph, demote the previous
   version into the history chain, add a `vX.Y.Z batch` row to *Recent updates*,
   and refresh the test badge + status counts only with measured numbers.
3. `PROGRESS.md`: a `## Release cut: vX.Y.Z` entry at the top.
4. Commit, push `master`, then push the `vX.Y.Z` tag. The tag build
   (`.github/workflows/build-desktop.yml`) packages all three OSes, re-runs the
   air-gap gate and the strict Program Files boot gate on the release bytes,
   attaches the installers + the electron-updater feed to that tag's Release,
   and auto-pins `Casks/lucidagentide.rb` on master (brew is the macOS update
   channel, ADR-0258). GitHub marks the newest tag Release "Latest", so the
   README `releases/latest/download/...` buttons follow it.
5. The rolling `latest` **tag** release is a separate, opt-in surface: a manual
   `workflow_dispatch` with `publish_latest` ON, from `master` only. It pushes at
   already-installed users, so never flip it as part of a routine tag cut.

## Next increment

**P-FLEET.P1** (ADR-0272): the Fleet Profile store + `LUCID_INSTANCE_ID` +
`/api/instance`, promoting the `LUCID_GUI_SETTINGS_FILE` / `LUCID_PERSONAL_DIR`
test seams into a real contract, so project-bound full-GUI instances stop
sharing `lucid-gui.json`.

## Map

- `harness/security/` - scanner client, fail-closed gate.
- `harness/hooks/` - omp quarantine pre-hook (blocks poisoned tool calls).
- `harness/memory/` - DuckDB, ingest, sanitize, compaction, promotion gate,
  resume, migrations.
- `harness/runs/` - run lineage, sandbox profiles, security-review, remote gate,
  replay.
- `harness/omp/` - omp extensions (gate, theme, welcome, fleet status).
- `harness/launcher/` - the `lucid` CLI (tui / acp / kb / stats / check /
  agent-firewall).
- `harness/{prompt,telemetry,verification,export,dashboards,bench,kb,trainer,voice,mcp,agent,commands}/`
  - the rest of the harness.
- `desktop/` - Electron main + `dev.ts` backend + `renderer/` (the IDE UI,
  dashboards, fleet grid, preview, KG); `desktop/scripts/` holds its demos.
- `tools/` - CLIs and build/ops helpers (license headers, KB, metrics, relay,
  remote PWA, AppContainer sandbox helper).
- `extensions/` - VS Code, Neovim, JetBrains clients.
- `scanner-sidecar/` - the only Python; the Unicode scanner + fixtures.
