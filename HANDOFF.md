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

## Current state (2026-09-24, v2.3.0-beta.8 prerelease)

The original build plan (Increment 0-2 + Phases 2-7) closed long ago; work is
now product increments, each with its own ADR. The newest stretch is the
**Windows AppContainer sandbox arc** (ADR-0386 to ADR-0395), released as the
**v2.3.0-beta.8** GitHub prerelease on 2026-09-24 (never marked latest, cask
untouched):

- **P-SANDBOX.9 to .11** (ADR-0386/0387/0389): chat actually works inside the
  AppContainer. The helper hands its std handles to omp, the container can
  read its runtime and write `~/.omp`, inference goes through `PI_PROXY`, the
  bundled bun is 1.4.2 (1.3.14 cannot start a script in the container), and
  the pill lights only after the real runtime boots through the same wrap.
- **P-SANDBOX.12 / .13 / .13b** (ADR-0390/0391/0393): the Security panel's
  sandbox switch, Add folder via a dialog the ENGINE opens (never a caller
  path), the full reach list, and a helper Browse For Folder fallback when
  Smart App Control puts PowerShell in Constrained Language Mode.
- **P-SANDBOX.14** (ADR-0394): enterprise policy `security.sandbox`
  (`SandboxAllowUserOff`, `SandboxReadFolders`, `SandboxReadWriteFolders`,
  `SandboxLockFolders`). ADMX/ADML templates for them are still owed in the
  private add-on repo.
- **P-NORESP.2** (ADR-0388): agent errors reach the chat as words.
  **P-MODEL.5** (ADR-0392): Grok 4.7 and an xAI Grok picker family.
- **P-REL.1** (ADR-0395): `build-desktop.yml` can cut a beta prerelease from a
  `beta_release` dispatch (agent sessions cannot push tags).

Measured 2026-09-24 with **bun 1.4.2** (`desktop/release/**` excluded per
ADR-0303):

- **1,725 harness tests** across 147 files (1,721 pass / 0 fail / 4 skip).
- **3,756 desktop tests** across 258 files (3,756 pass / 0 fail).
- **57 sidecar tests** (pytest, all pass). **259 `demo-*` targets** in the `Makefile`.
- `tsc --noEmit` clean at the root and in `desktop/`; BUSL-1.1 headers complete.

Both correctness keystones are in and over-tested: the **Unicode scanner**
(`scanner-sidecar/`) and the **semantic-promotion gate**
(`harness/memory/promotion_gate.ts`). The end-to-end guarantee holds: untrusted
text -> scanned -> trust-labeled -> sanitized -> persisted -> blocked at the
tool / promotion / dispatch boundaries -> human-reviewed -> exits only as safe,
audited evidence.

**Bun version matters.** Under bun 1.3.x, 6 harness tests that start a real omp
session (including the fail-closed dead-scanner test in
`harness/hooks/quarantine_hook.test.ts`) die before their bodies run, because
omp 18.2.10's browser prelude will not link ("Missing 'default' export in
.../tools/browser/prelude.js"). They pass under bun 1.4.2 and in CI (which uses
`bun-version: latest`). Use bun >= 1.4.2 locally; if the machine's bun is older,
`npm i bun@1.4.2` into a scratch dir and run its binary. A bare `bun test
harness` also picks up the generated `desktop/release/win-unpacked/.../harness`
copy and roughly doubles every count: always pass
`--path-ignore-patterns='desktop/release/**'`.

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
4. Commit, push `master`, then push the `vX.Y.Z` tag. **Betas without a tag
   push** (e.g. from an agent session, which cannot push tags): dispatch
   `build-desktop.yml` on `master` with `beta_release` ON. It builds the
   committed prerelease version and creates tag `v<version>` plus the GitHub
   prerelease through the API (ADR-0395); it refuses a non-prerelease version,
   a non-master ref, or `publish_latest` alongside it. The tag build
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

**P-SANDBOX.15**: scope the omp child's loopback token. The contained omp
receives the same token that header-only engine routes accept, so it could call
routes like `/api/security/approve`. Give the child a token limited to the
routes it needs (the agent-facing grant claim, telemetry) and refuse it on
every human-only route. P-SANDBOX.13 already designed around this (the Add
folder route never takes a path from the caller); this closes it.

Queued behind it:
- **P-SIGN.1** (code signing): needs the owner's choice of Azure Artifact
  Signing or a traditional certificate. Signing also lifts the Smart App
  Control block on install.
- ADMX/ADML templates for the four P-SANDBOX.14 values (private add-on repo).

## Lessons learned (2026-09-24, the AppContainer arc)

- **Prove what the feature depends on, not a proxy for it.** A helper that
  exited 0 lit a green pill while every chat turn died. The probe now
  round-trips stdio and boots the REAL runtime through the SAME wrap before
  committing (ADR-0386/0387). Apply this to any "available" indicator.
- **Windows hosts with Smart App Control or WDAC run PowerShell in Constrained
  Language Mode.** `Add-Type` is refused, so any PowerShell-built UI silently
  fails. Keep a non-script fallback (the helper's FFI dialog, ADR-0393) and
  make failures say why.
- **A test must never open real UI on a CI runner.** A test that expected the
  off-Windows refusal opened a real modal dialog on `windows-latest` and hung
  the Full test gate (no `timeout-minutes`) until it was cancelled. Gate
  platform-specific calls on `process.platform`, and when a job hangs, read the
  last test line of its log before re-running anything.
- **A green check suite on an OLD head is not a pass.** Each push cancelled the
  previous CI run, so the Windows gate had never completed on the PR until the
  merge head. Before merging, confirm every check completed on the exact head
  SHA being merged.
- **Agent sessions can push only their own branch** (tags get HTTP 403 from the
  git proxy). Cut betas with the `beta_release` dispatch (ADR-0395) instead of
  asking for a local tag push.
- **The loopback token is shared with the agent.** Any route that widens access
  must not accept a caller-supplied target: the engine opens the picker itself
  (ADR-0391). P-SANDBOX.15 removes the shared token.
- **JSON-RPC errors are objects.** Wrap them with `rpcError` before they reach
  a string context, or the chat shows `[object Object]` (ADR-0388).

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

## Cross-repo briefs

- `DGX-FLEET-INTEGRATION.md` (repo root) - what the TL187 DGX Loader fleet
  ships for LUCID (OpenAI-compatible serving, A2A agent card registry, model
  provenance and trust states, LoRA candidates, corpus lake), how to
  build-and-test against it today over SSH tunnels with zero hardcoded box
  names, and five proposed ADRs (fleet endpoints as configuration, A2A card
  consumption with a trust gate, local-first routing, provenance in the
  selection UX, single-endpoint readiness). Written 2026-09-05 by the DGX
  Loader's agent; source of truth for wire contracts lives in that repo's
  ADRs 0001 to 0014 and `docs/LUCID-INTEGRATION.md`.
