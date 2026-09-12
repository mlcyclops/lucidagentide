# Task brief: Linux arm64/aarch64 support for LucidAgentIDE

Drop this in the repo (suggest `docs/tasks/arm64.md`) and point Claude Code at it.
Written as a handoff from a planning conversation. Everything in "Context" was
derived from the public site and release list, NOT from reading the repo, so
**verify before acting**.

---

## Why

A user (ML engineer, cleared, edge/ML hardware) asked whether any arm64/aarch64
builds exist. Answer today: macOS Apple Silicon yes, Linux aarch64 no, Windows
arm64 no. Linux aarch64 is the real gap and the likely ask.

## Context (VERIFIED against the repo, 2026-09-12)

Increment A audited every claim below against the actual source and CI config.
Full evidence with `file:line` citations is in `docs/tasks/arm64-audit.md`.
Corrected items are marked. Do not re-derive these; read the audit.

- CONFIRMED. macOS ships native arm64: `LucidAgent-mac-arm64.pkg` + arm64 `.zip`,
  Intel secondary. (`desktop/package.json:28`, `:92`, `:96-104`)
- CONFIRMED, with a sharper cause. Linux ships x86_64 only, and the reason is not
  merely a missing target: `linux.artifactName` is the hardcoded string
  `LucidAgent-x86_64.${ext}` (`desktop/package.json:155`). An arm64 build today
  would emit a file literally named `LucidAgent-x86_64.AppImage`. `deb`/`rpm`
  already template `${arch}` correctly; only AppImage naming is hardcoded. The
  Creator flavor has the same bug (`desktop/build/electron-builder.creator.cjs:78`).
- RESOLVED (was "unknown"). Windows is **x64-only, explicitly**, not by default:
  both `nsis` and `portable` pin `"arch": ["x64"]` (`desktop/package.json:116-127`).
  The site can state this today.
- CORRECTED. The scanner sidecar is NOT PyInstaller, wheels, or an embedded
  interpreter. It is a **relocatable CPython from astral-sh/python-build-standalone**
  (tag `20260623`, CPython `3.12.13`, `install_only` archive), fetched and
  SHA-256-verified by `desktop/build/fetch-runtimes.ts:41-48` alongside static
  `bun` 1.3.14 and `uv` 0.11.23. The scanner has **zero** runtime Python deps
  (`scanner-sidecar/pyproject.toml:9`), so a bare interpreter suffices and there
  are no wheels to source for aarch64. This makes the sidecar the CHEAPEST item
  to port, not the hardest: three array entries.
- CONFIRMED. TypeScript on Bun, in-process with omp; DuckDB for provenance/memory;
  bun and the scanner bundled, air-gap capable.
- CONFIRMED. The gate is fail-closed: scanner dead/garbage/timeout blocks, never
  "safe." (`harness/security/scanner_client.ts:96-106`, CLAUDE.md invariant 3)

## The risk that shapes this whole task (CONFIRMED, and already CI-gated)

The fail-closed thesis is correct. The audit traced the exact chain: on arm64 the
bundled Python resolves to a path that was never fetched, provisioning fails with
only a `console.warn`, `resolvePython()` falls through to the literal string
`"python"` (`scanner_client.ts:57`), the spawn fails, and every tool call blocks.
The app looks completely healthy while doing so, and nothing in the error names
the architecture. See the audit's "exact failure chain" section.

BUT the brief's instruction "do not build an installer before proving the sidecar
runs on aarch64" is **already enforced by a machine gate**, and that gate is
already arch-parameterized. `desktop/build/airgap-smoke.ts` resolves
`runtimes/python-${PLAT}-${ARCH}`, hard-fails if it is absent, and then actually
EXECUTES the scanner under the bundled interpreter, asserting a zero-width plus
homoglyph sample yields both findings and clean text yields none
(`airgap-smoke.ts:72-114`). It runs before any artifact is uploaded
(`build-desktop.yml:181-183`). So an arm64 CI leg added without the arm64 runtime
specs fails loudly at the air-gap step rather than shipping a broken artifact.
The failure mode is safe.

---

## Ground rules

- One increment per session. Do not start the next until the current one's
  acceptance check passes.
- Each increment gets its own ADR where it makes a real architectural choice,
  following the repo's existing ADR numbering and format.
- Follow the repo's existing CLAUDE.md / AGENTS.md conventions over anything in
  this brief if they conflict.
- Extend, never fork omp. Unchanged.

---

## Increment A: aarch64 dependency audit (no build work)

> **STATUS: COMPLETE (2026-09-12).** Deliverable is `docs/tasks/arm64-audit.md`.
> Result: 12 artifacts audited, 6 available, 4 needs-build, 2 not-shipped,
> **0 blockers**. Verified aarch64 SHA-256 hashes for bun, uv, and CPython are in
> the audit, each cross-checked against the vendor's own published manifest with a
> matching x86_64 control. No code changed.

**Goal:** a written inventory of every bundled native artifact and whether an
aarch64 build exists.

Audit at minimum:
1. **The Python Unicode scanner sidecar** ← start here. How is it bundled today
   (PyInstaller/embedded interpreter/wheels)? Does that mechanism have an aarch64
   path? What are its deps and do they all have aarch64 wheels?
2. **Bun** (linux-aarch64 believed available, confirm the version pinned here).
3. **DuckDB Node binding** (prebuilt linux-arm64? or does it compile?).
4. Any other node-gyp / native modules in `package.json`.
5. **Whisper (on-device dictation) and Kokoro TTS / ONNX runtime**, if they ship in
   the Linux bundle. These are the most likely to lack aarch64 prebuilds.
6. Electron version's linux-arm64 support (should be fine, confirm).

**Deliverable:** `docs/tasks/arm64-audit.md` listing each artifact as
available / needs-build / blocker, with the specific version and source URL.
**Acceptance:** every bundled native artifact has a verdict. No code changed.

**Outcome.** Met. Notable corrections: Whisper's linux-arm64 binary is ALREADY
pinned in-repo with a committed hash (`desktop/whisper_binaries.ts:46-53`), so the
brief's predicted hardest item needs no work; Kokoro TTS ships no binary at all
(it is a remote HTTP client, `harness/brief/tts_backend.ts:7-10`); ONNX runtime is
explicitly excluded from the bundle (`desktop/package.json:81-82`); DuckDB and omp
`pi-natives` both already publish prebuilt `linux-arm64` packages
(`bun.lock:55`, `:163`) with no node-gyp anywhere. The only genuinely missing
artifacts are the three Linux runtimes in `fetch-runtimes.ts`.

---

## Increment B: arm64 CI leg producing an unsigned AppImage

**Goal:** an arm64 Linux AppImage built natively in CI. NOTE: the exact filename
is now a DECISION, not a given. Plain `${arch}` templating yields
`LucidAgent-arm64.AppImage`, not `-aarch64`, while the `.rpm` will independently
say `aarch64` (electron-builder maps arm64 to `aarch64` only for rpm/pacman/
flatpak: `builder-util/out/arch.js:85-89`). Pick one spelling in ADR-0353 and
carry it into Increment D's site links, which are version-pinned filenames.

- Add an arm64 leg to the release workflow using GitHub's **`ubuntu-24.04-arm`**
  hosted runner (arm64 standard runners are GA, free for public repos, and now
  supported in private repos too). Native build, no QEMU cross-compile.
- ~~Add `arm64` to the Linux targets in electron-builder config.~~ **NOT NEEDED.**
  The audit traced electron-builder `25.1.8`: with no arch flag it defaults to the
  HOST arch, not x64 (`builder.js:42` returns empty, so `targetFactory.js:18`
  falls back to `[process.arch]`). On `ubuntu-24.04-arm` the existing `dist:linux`
  already builds arm64. The x64 hardcode at `targetFactory.js:36-37` only fires
  when cross-building Linux from darwin/win32 AND the config names no target, and
  this config names three. Passing `--arm64` explicitly is still recommended, for
  determinism rather than necessity.
- Keep the artifact naming consistent with the existing x86_64 convention.
  `linux.artifactName` is a hardcoded `x86_64` literal, not an `${arch}` template
  (`desktop/package.json:155`); it must be templated or made per-arch, and the
  same fix applied to the Creator config. Templating is SAFE for the existing
  artifact: `getArtifactArchName(x64, "AppImage")` is exactly `x86_64`, so the
  current filename is preserved byte-for-byte and no published link breaks. Also
  extend the release identity gate's expected-name set, since it classifies
  AppImage by filename stem and is fail-closed on unrecognized files (ADR-0307).
- Resolve whatever Increment A flagged as needs-build. That is exactly four items:
  the three linux-arm64 runtime SPECS entries (`bun`, `uv`, CPython, hashes
  already verified in the audit) plus the electron-builder artifact-name change.
- ALSO REQUIRED, surfaced by the audit: `fetch-runtimes.ts:185-186` filters SPECS
  by `process.platform` ONLY, never `process.arch`. Adding arm64 entries without
  an arch filter makes the x86_64 Linux build download and bundle them too
  (the CPython tree alone is ~44 MB compressed). Add arch-aware selection, and
  keep the plain-`bun` alias emission (`fetch-runtimes.ts:271-283`) reachable on
  arm64 or the air-gap gate fails on the missing alias.
- Consider adding a DuckDB probe to `airgap-smoke.ts`: it is the only bundled
  native artifact the gate does not currently cover.

**Acceptance:** CI produces an aarch64 AppImage. It is not yet claimed to work.

---

## Increment C: fail-closed validation on real aarch64 hardware

**Goal:** prove the security model holds on arm, not just that the app launches.

Run on actual aarch64 hardware (a DGX Spark is available), not just CI:
1. App launches, agent completes a trivial turn.
2. Scanner sidecar starts, scans a clean string and a zero-width-injected string
   correctly.
3. **Kill the sidecar mid-run and assert the gate still blocks.** This is the
   existing fail-closed regression test, run on arm.
4. DuckDB provenance store reads/writes.
5. Note in the ADR anything that only works on x86_64 (e.g. if Whisper/Kokoro
   have no aarch64 build, decide explicitly: ship without voice on arm, or block
   the release).

**Acceptance:** all five checked, results written up. This gate decides whether
the build is publishable.

---

## Increment D: publish + document

- Add `.deb (arm64)` and `.rpm (aarch64)` to the release outputs.
- Add a Linux arm64 row to the download section on the site, matching the
  existing plain-English install steps.
- Update the FAQ/platform copy so architecture support is stated explicitly for
  all three OSes, including Windows once its architecture is confirmed.

**Acceptance:** a user can download an aarch64 build from the site without a
GitHub account, same as x86_64 today.

---

## Side question: RESOLVED

The Windows build is **x64-only, explicitly**. `desktop/package.json:116-127`
pins `"arch": ["x64"]` on both the `nsis` and `portable` targets, so this is a
deliberate config choice rather than an electron-builder default. State it on the
site as part of Increment D. Windows-on-ARM native support remains a separate
decision, not part of this task.
