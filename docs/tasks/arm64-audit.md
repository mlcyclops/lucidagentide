# Increment A: Linux aarch64 dependency audit

Status: complete. No code, build config, or workflow changed in this increment.
Scope was the audit only, per `docs/tasks/arm64.md` Increment A.

Session increment ID: **P-ARM64.A**.

Method: every claim below was read out of this repo at the cited `file:line`, or
verified against the upstream vendor's own published checksum manifest. Claims
inherited from the handoff brief were re-derived from source and are corrected
where wrong. Anything not directly verified is marked `[UNVERIFIED]`.

-----

## Headline

**There is no blocker.** Every bundled native artifact either already has a
linux-arm64 path in this repo, or has a published upstream aarch64 build that
drops into the existing pinned-and-hash-verified mechanism unchanged.

The scanner sidecar, which the brief correctly identified as the item that
cannot degrade gracefully, turns out to be the *cheapest* item to fix: it has
zero Python dependencies and its interpreter is a relocatable CPython that
astral-sh publishes for `aarch64-unknown-linux-gnu`. Three new entries in one
array, with hashes already verified below, cover it.

The brief's predicted hard cases (Whisper, Kokoro, ONNX) are wrong in the
favorable direction: Whisper's linux-arm64 binary is *already pinned in this
repo* with a committed SHA-256, and Kokoro and ONNX do not ship in the Linux
bundle at all.

-----

## Verdict table

| # | Bundled artifact | Pinned version | Source of truth | linux-arm64 | Verdict |
|---|---|---|---|---|---|
| 1 | Scanner CPython (python-build-standalone) | `3.12.13+20260623` | `fetch-runtimes.ts:47-48` | published | **needs-build** |
| 2 | Scanner Python runtime deps | none (`dependencies = []`) | `scanner-sidecar/pyproject.toml:9` | n/a | **available** |
| 3 | bun (static) | `1.3.14` | `fetch-runtimes.ts:39` | published | **needs-build** |
| 4 | uv (static) | `0.11.23` | `fetch-runtimes.ts:40` | published | **needs-build** |
| 5 | whisper.cpp server | `1.9.1` | `whisper_binaries.ts:46-53` | already pinned in-repo | **available** |
| 6 | DuckDB node binding | `1.5.4-r.1` | `bun.lock:55` | prebuilt optionalDep present | **available** (runtime load unverified on arm) |
| 7 | omp `pi-natives` | `16.1.20` | `bun.lock:163` | prebuilt optionalDep present | **available** |
| 8 | Kokoro TTS | n/a | `harness/brief/tts_backend.ts:7-10` | n/a, remote HTTP client | **not-shipped** |
| 9 | `onnxruntime-node` | `1.24.3` | `bun.lock:463` | excluded from bundle | **not-shipped** |
| 10 | Electron | `44.0.0` (resolved) | `desktop/node_modules/electron/package.json` | `electron-v44.0.0-linux-arm64.zip` published | **available** |
| 11 | electron-builder Linux artifact name | `25.1.8` (resolved) | `desktop/package.json:155` | hardcoded `x86_64` literal | **needs-build** |
| 12 | CI Linux runner | `ubuntu-latest` | `build-desktop.yml:49-51` | no arm leg exists | **needs-build** |

Counts: 6 available, 4 needs-build, 2 not-shipped, **0 blockers**.

-----

## Corrections to the handoff brief

The brief's "Context" section was derived from the public site and release list.
Seven items were wrong or unresolved. Corrected here, with evidence.

### C1. The scanner is not PyInstaller, wheels, or an embedded interpreter

The brief listed the bundling mechanism as unknown, guessing
"PyInstaller/embedded interpreter/wheels". It is none of those.

`desktop/build/fetch-runtimes.ts:41-48` fetches a **relocatable CPython from
astral-sh/python-build-standalone**, pinned to release tag `20260623`, CPython
`3.12.13`, using the `install_only` archive, and copies the whole extracted
`python/` tree to `runtimes/python-<platform>-<arch>`. Combined with
`scanner-sidecar/pyproject.toml:9` (`dependencies = []`), there is no wheel
resolution, no pip, and no build step anywhere in the scanner's path. A bare
interpreter is sufficient, which the source comment states explicitly at
`fetch-runtimes.ts:44-45`.

Consequence: the aarch64 scanner story is three array entries, not a packaging
project.

### C2. Whisper is the brief's predicted blocker and is actually already done

The brief flagged Whisper as "most likely to lack aarch64 prebuilds".
`desktop/whisper_binaries.ts:46-53` already contains a complete, committed
linux-arm64 entry:

```
"linux-arm64": {
  kind: "prebuilt",
  asset: "whisper-bin-ubuntu-arm64.tar.gz",
  sha256: "e0b66cd551ff6f2a28fabe3c6e89691eea037bb76833493abb9a71ca788994b3",
  bytes: 4555819,
  member: "whisper-server",
}
```

`fetch-whisper.ts` keys off `process.arch` (`fetch-whisper.ts:30-31`), and
`whisperBinarySpec()` (`whisper_binaries.ts:67-69`) resolves on
`${platform}-${arch}`. So `bun run whisper` on an arm64 runner already fetches
and hash-verifies the right binary with no code change.

Whisper is also the one component that genuinely degrades gracefully:
`whisper_runtime.ts:161` returns `{ok: false, reason: BIN_HINT}` rather than
throwing, and `shouldAutostartWhisper` (`whisper_runtime.ts:220-235`) requires
`binAvailable === true` before firing. A missing Whisper binary disables
dictation and nothing else.

### C3. Kokoro TTS ships no binary, so it is not an arch question

The brief asked whether Kokoro TTS ships in the Linux bundle. It does not ship
at all as a native artifact. `harness/brief/tts_backend.ts:7-10` implements
Kokoro as an OpenAI-compatible **HTTP client** against a self-hosted server, and
`desktop/dev.ts:1257-1290` defaults `LOCAL_TTS_URL` to `http://localhost:8880`
and merely probes whether something is listening. `harness/voice/catalog.ts:60-62`
lists it as a `local-tts` provider. There is no Kokoro binary, model, or ONNX
graph in the bundle, so there is nothing to port. Kokoro on arm64 is the user's
own server-side concern.

### C4. ONNX runtime is explicitly excluded from the shipped bundle

`desktop/package.json:81-82` excludes both `node_modules/onnxruntime-node/**`
and `node_modules/onnxruntime-web/**` from the `extraResources` repo copy. So
although `@huggingface/transformers@4.2.0` depends on `onnxruntime-node@1.24.3`
(`bun.lock:73`), that native module is not in the installed app. It is therefore
not an aarch64 concern for the installer. Relevant for Increment C only as a
"confirm nothing regressed" item, not a port item.

### C5. Windows is x64-only. The brief's open question is resolved

The brief left this "Unknown whether x64-only" and deferred it to a side
question. It is answerable from config: `desktop/package.json:116-127` pins both
Windows targets to an explicit single arch:

```
"win": { "target": [
  { "target": "nsis",     "arch": ["x64"] },
  { "target": "portable", "arch": ["x64"] } ] }
```

Windows is x64-only, explicitly and deliberately, not by default. The site copy
can state that today without further investigation. Windows-on-ARM remains a
separate decision, as the brief said.

### C6. macOS and Linux claims confirmed

macOS does ship both arches: `desktop/package.json:96-104` (`zip` with
`arch: ["arm64","x64"]`) plus `dist:mac` building `pkg` for `--arm64` and
`--x64` separately (`desktop/package.json:28`), with artifact name
`LucidAgent-mac-${arch}.${ext}` (line 92). Linux is x86_64-only, and the reason
is stronger than "no arm64 target": the artifact name is a **hardcoded string**,
`"artifactName": "LucidAgent-x86_64.${ext}"` (`desktop/package.json:155`), with
no `arch` array on the Linux target (line 154). An arm64 Linux build today would
emit a file literally named `LucidAgent-x86_64.AppImage`. The Creator flavor has
the identical bug at `desktop/build/electron-builder.creator.cjs:78`
(`LucidCreator-x86_64.${ext}`).

### C7. "Do not build an installer before proving the sidecar runs" is already enforced by CI

The brief treats this as a discipline to maintain manually. It is already a
machine-checked gate, and it is already arch-parameterized.

`desktop/build/airgap-smoke.ts` runs on the native runner against the
`*-unpacked` output, before any artifact is uploaded (`build-desktop.yml:181-183`).
It resolves `runtimes/python-${PLAT}-${ARCH}` (line 85), hard-fails if the
interpreter is absent (line 91), hard-fails if bundled bun is absent (line 121),
and then actually **executes the scanner** under the bundled interpreter,
asserting a zero-width plus mixed-script-homoglyph sample produces both findings
and that clean text produces none (lines 99-114). `resolveResources()` at line
72-79 already reasons explicitly about arch mismatch: its comment is "so a mac
x64 app bundle never sends an arm64 runner hunting for an x64 interpreter it
can't exec".

This is load-bearing good news for Increment B: adding an arm64 CI leg *without*
first adding the arm64 runtime specs produces a loud build failure at the air-gap
step, not a silently broken artifact. The failure mode is safe.

-----

## 1. The Python Unicode scanner sidecar (audited first, per the brief)

This is the item the fail-closed gate makes non-negotiable, so it gets the full
chain.

**How it is bundled today.** Three layers:

1. `desktop/build/fetch-runtimes.ts` downloads a relocatable CPython
   (`install_only` tarball) and copies the extracted `python/` tree to
   `desktop/runtimes/python-<platform>-<arch>` (`fetch-runtimes.ts:236-257`).
   It dereferences symlinks on copy (line 248) because electron-builder drops
   them, and restores the exec bit on `bin/python3`, `bin/python`, and
   `bin/python3.12` (lines 251-257).
2. `desktop/package.json:45-50` copies `runtimes/` into `Resources/runtimes`,
   and lines 56-66 copy `scanner-sidecar/**/*` into `Resources/repo`, explicitly
   excluding `scanner-sidecar/.venv/**` (line 64) and `**/__pycache__/**` (line 65).
3. At runtime `desktop/runtime.ts:49-51` resolves
   `Resources/runtimes/python-${process.platform}-${process.arch}` and hands the
   result down as `SCANNER_PYTHON` (`runtime.ts:169`).

**Dependencies.** Zero. `scanner-sidecar/pyproject.toml:9` is `dependencies = []`,
and the comment at lines 6-8 states stdlib `unicodedata` covers the baseline.
`pytest>=8.0` is a dev-only group (lines 11-14). There are no wheels to source
for aarch64. `harness/maintainer/manifests.test.ts:270-276` even pins the "empty
dependencies array is zero deps, not an error" behavior, so the emptiness is
intentional and tested.

**Does the mechanism have an aarch64 path?** Yes, and it is already the exact
pattern macOS uses. `bundledPython()` keys on `process.arch`, and the SPECS
naming convention is `<tool>-<platform>-<arch>`, with the URL slug decoupled from
the Node arch name. macOS already exploits this: `bun-darwin-arm64` is fetched
from the slug `darwin-aarch64` (`fetch-runtimes.ts:74-78`). Linux needs the same
name/slug split (`linux-arm64` name, `aarch64-unknown-linux-gnu` or
`linux-aarch64` slug).

### The exact failure chain on arm64 with today's code

Traced, not inferred. Each step cited.

1. `fetch-runtimes.ts:185-186` filters SPECS by **platform only**:
   `SPECS.filter((s) => s.platform === TARGET)` where `TARGET` is
   `process.platform`. There is no `process.arch` filter anywhere in the file.
   On a linux-arm64 runner it therefore selects `bun-linux-x64`,
   `uv-linux-x64`, and `python-linux-x64`, and bundles three **x86_64 ELF
   binaries** into an arm64 app.
2. `runtime.ts:49-51` `bundledPython()` looks for
   `runtimes/python-linux-arm64`, which was never fetched. Returns `null`.
3. `runtime.ts:105-107` `findScannerPython()` falls back to `venvPython()`
   (userData `runtimes/scanner-venv`, absent on a fresh install) and
   `projectVenvPython()` (`scanner-sidecar/.venv`, which
   `desktop/package.json:64` explicitly excludes from the bundle). Returns `null`.
4. `runtime.ts:154-168` tries to provision via uv. `findUv()` calls
   `bundled("uv")`, which misses for the same arch reason, then probes
   `~/.local/bin`, `~/.cargo/bin`, and `systemBins`. On a clean host all miss, so
   it logs `console.warn("[runtime] no uv available to provision the scanner
   interpreter")` (line 166) and **`SCANNER_PYTHON` is never set** (line 169 is
   guarded by `if (py)`). Note this is a warning, not a throw: `ensureRuntimes`
   returns successfully and the app proceeds to launch looking healthy.
5. `harness/security/scanner_client.ts:51-58` `resolvePython()` finds no
   `SCANNER_PYTHON` env, no `.venv`, and returns the literal string
   `"python"` (line 57, commented "last resort").
6. `scanner_client.ts:85` spawns `python server.py`. On a typical Debian or
   Ubuntu arm64 host there is no `python` on PATH, only `python3`.
   `proc.on("error")` fires (line 106), `die()` sets `#alive = false` and rejects
   every pending request with `ScanUnavailableError` (lines 96-104).
7. Fail-closed law (CLAUDE.md invariant 3) converts that into block/quarantine
   for **every** tool call.

**User-visible signature to expect on arm64:** the app installs, the setup
splash appears (because `needsBootstrap()` at `runtime.ts:111-112` returns true
when `findScannerPython()` is null), provisioning "fails" with only a console
warning that no user ever sees, the window opens and looks completely normal,
and then every single tool call is blocked with `scanner sidecar unavailable:
spawn error`. Nothing in that chain names the architecture. This is the
diagnosis hazard worth fixing in Increment B, separately from the port itself.

**Two traps worth recording now.**

- *The wrong fix is a rename.* Today the bundled x86_64 binaries are merely dead
  weight, because `bundled()` and `bundledPython()` key on `process.arch` and
  never find them. If someone "fixes" the arm64 build by renaming the x64
  payloads to `-arm64` instead of adding real arm64 SPECS entries, the binaries
  become reachable and the failure changes from "spawn ENOENT" to "exec format
  error", which is harder to read and, on a host with `qemu-user` binfmt
  registered, may partly *work*. That last case is the ADR-0303 vacuous-green
  trap: CI would be green on a qemu-enabled runner while real hardware fails
  differently. Use native arm64 assets, as the brief's Increment B already
  specifies.
- *Adding arm64 SPECS without an arch filter bloats the x64 build.* Because
  `fetch-runtimes.ts:186` filters on platform only, adding three linux-arm64
  entries makes the **x86_64** Linux build download and bundle them too. That is
  intentional on macOS, where one `.zip` serves both arches, but wrong on Linux,
  where electron-builder emits a separate artifact per arch. The relocatable
  CPython alone is roughly 44 MB compressed and well over 100 MB extracted.
  Increment B should add an arch filter, or per-arch spec selection, as a
  deliberate decision.

### Verified upstream aarch64 assets

All three cross-checked against the vendor's own published checksum manifest,
which is the trust anchor `fetch-runtimes.ts:12-14` requires. To validate the
method, the x86_64 hash was pulled the same way for each and compared to the
value already committed in this repo. **All three x86_64 controls matched
byte-for-byte**, so these aarch64 values are trustworthy by the same procedure.

| Artifact | aarch64 asset | Verified SHA-256 | Vendor manifest used | x86_64 control vs repo |
|---|---|---|---|---|
| bun 1.3.14 | `bun-linux-aarch64.zip` | `a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b` | `SHASUMS256.txt` in the release | matches `fetch-runtimes.ts:128` |
| uv 0.11.23 | `uv-aarch64-unknown-linux-gnu.tar.gz` | `1873a77350f6621279ae1a0d2227f2bd8b67131598f14a7eb0ba2215d3da2c98` | `<asset>.tar.gz.sha256` sibling | matches `fetch-runtimes.ts:136` |
| CPython 3.12.13+20260623 | `cpython-3.12.13+20260623-aarch64-unknown-linux-gnu-install_only.tar.gz` | `b14d074c43fdf03f01822fd07a15b3039eb0558503d1cb791791602cbe32908b` | `SHA256SUMS` in the release (852 entries) | matches `fetch-runtimes.ts:155` |

Source URLs, matching the existing builder functions at
`fetch-runtimes.ts:62-68`:

- `https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-aarch64.zip`
- `https://github.com/astral-sh/uv/releases/download/0.11.23/uv-aarch64-unknown-linux-gnu.tar.gz`
- `https://github.com/astral-sh/python-build-standalone/releases/download/20260623/cpython-3.12.13%2B20260623-aarch64-unknown-linux-gnu-install_only.tar.gz`

Note the existing `pyUrl()` already emits `%2B` for the literal `+`
(`fetch-runtimes.ts:66-68`), so the URL builders need no change, only new slugs.

Caveat for Increment B: these hashes were verified on 2026-09-12 and should be
re-confirmed with `REFRESH=1 bun run build/fetch-runtimes.ts` at the time they
are committed, per the documented refresh ritual at `fetch-runtimes.ts:16-20`.
Do not paste them in blind.

-----

## 2. bun

Pinned `1.3.14` at `fetch-runtimes.ts:39`. Linux entry is x64-only
(`fetch-runtimes.ts:122-129`). Upstream publishes `bun-linux-aarch64.zip` for
this exact tag, verified above. Verdict: **needs-build**, one SPECS entry.

One extra detail specific to bun: `fetch-runtimes.ts:271-283` emits a plain
`bun[.exe]` alias alongside the arch-suffixed binary, because omp's `.bunx`
shim shells out to a bare `bun` on PATH. `airgap-smoke.ts:125-126` asserts that
alias exists and hard-fails without it. Whatever arch filtering Increment B
adds must keep that alias generation reachable on arm64, or the air-gap gate
fails with "plain bun alias missing".

## 3. uv

Pinned `0.11.23` at `fetch-runtimes.ts:40`. Linux entry x64-only
(`fetch-runtimes.ts:130-137`). Upstream publishes
`uv-aarch64-unknown-linux-gnu.tar.gz`, verified above. Verdict:
**needs-build**, one SPECS entry.

uv is strictly a fallback provisioner once the bundled CPython exists
(`runtime.ts:150-153` documents this), but it should still be shipped for arm64
so a non-air-gapped arm box has the same recovery path x64 has.

## 4. DuckDB node binding

Pinned `@duckdb/node-api@1.5.4-r.1` (root `package.json:68`). `bun.lock:49`
shows `@duckdb/node-bindings` declaring **optionalDependencies** for eight
platform slugs, and `bun.lock:55` is
`@duckdb/node-bindings-linux-arm64@1.5.4-r.1` with `{ "os": "linux", "cpu": "arm64" }`.
A musl arm64 variant also exists (`bun.lock:57`). These are **prebuilt** `.node`
packages: there is no node-gyp step and no compile. Verdict: **available**.

Two things to know for Increment C:

- DuckDB loads in the **Bun engine**, not in Electron. `harness/memory/db.ts:14`
  imports `@duckdb/node-api` at top level, and `desktop/dev.ts:374` imports `Db`
  non-lazily, so the binding must load at engine startup. It therefore matches
  Bun's ABI, not Electron's, which removes an entire class of arm64 ABI risk.
- `compile-engine` uses `bun build --compile ... --external '*.node'`
  (`desktop/package.json:19`), so the `.node` files are deliberately *not*
  embedded and must resolve from the packaged `node_modules` at runtime. Since
  `extraResources` copies `node_modules/**/*` with no DuckDB exclusion
  (`desktop/package.json:69`), a native arm64 `bun install` puts the arm64
  binding in place.
- **Gap:** `airgap-smoke.ts` does not probe DuckDB at all. It checks Python,
  scanner, omp shim, bun, and the plain bun alias. A missing or wrong-arch
  DuckDB binding would pass CI and fail at first engine boot. This is the one
  place where Increment B could add coverage cheaply, and it is exactly the kind
  of gap the air-gap gate exists to close.

## 5. Other native modules

- **omp `pi-natives`**: `bun.lock:157` declares optionalDependencies including
  `@oh-my-pi/pi-natives-linux-arm64`, present at `bun.lock:163` with
  `{ "os": "linux", "cpu": "arm64" }`. `desktop/build/copy-natives.ts:62` already
  lists `linux-arm64` in its `SUPPORTED` set, and lines 64-66 fail the BUILD on an
  unsupported triple rather than deferring to a user's startup. Lines 69-75 also
  fail if the package is absent, with an actionable hint
  (`bun add --optional @oh-my-pi/pi-natives-linux-arm64`) for the cross-build case.
  A native arm64 `bun install` picks it up automatically. Verdict: **available**.
- **`sharp`** (transitive via `@huggingface/transformers`, `bun.lock:73`):
  reaches the bundle only through the excluded transformers path; ships prebuilt
  per-platform packages. Not a blocker. `[UNVERIFIED]` whether it is loaded at
  all in the packaged Linux app.
- **node-gyp / postinstall compiles**: none found in either `package.json`. Root
  `trustedDependencies` is empty (`package.json:84`); desktop's is
  `["electron", "@resvg/resvg-js"]` (`desktop/package.json:5`). No source
  compilation in the install path.

## 6. Electron and electron-builder

Resolved versions, read from the installed trees rather than the `^` ranges:
**electron `44.0.0`**, **electron-builder `25.1.8`**, **app-builder-lib `25.1.8`**.

Electron 44.0.0 publishes `electron-v44.0.0-linux-arm64.zip` upstream (verified
against the release asset list). Verdict: **available**, no longer `[UNVERIFIED]`.

### electron-builder defaults to the HOST arch, not x64

This was residual unknown 2 and is now resolved by reading the installed
electron-builder source. It makes Increment B smaller than the brief assumed.

Trace for `electron-builder --linux --publish never` (`desktop/package.json:30`):

1. `electron-builder/out/builder.js:72` calls `processTargets(Platform.LINUX, args.linux)`.
   The flag carries no target values, so `types.length === 0`.
2. `builder.js:51` calls `commonArch(args.dir === true)`, which is `commonArch(false)`.
   No arch flags are set, so at `builder.js:42`
   `result.length === 0 && currentIfNotSpecified` is false and it returns the
   EMPTY array. The per-arch map is therefore never populated: `raw.size === 0`.
3. `app-builder-lib/out/targets/targetFactory.js:18`:
   `const defaultArchs = raw.size === 0 ? [process.arch] : ...` resolves to
   **`[process.arch]`**, the host arch.
4. `targetFactory.js:20-32` then iterates the config's
   `target: ["AppImage","deb","rpm"]` (`desktop/package.json:154`). Each entry is
   a plain string, so its `archs` is null and line 30 falls back to
   `defaultArchs`, i.e. the host arch.

The x64 hardcode does exist, at `targetFactory.js:36-37`, but it is gated on
`raw.size === 0 && platform === LINUX && (process.platform === "darwin" || "win32")`
**and** on the config specifying no target at all. This repo's config specifies
three targets, so that branch is unreachable here.

**Consequence:** `desktop/package.json:154` does **not** need an `arch` array.
On an `ubuntu-24.04-arm` runner, `process.arch === "arm64"` and the existing
`dist:linux` script already builds arm64 AppImage, deb, and rpm unchanged. The
brief's Increment B bullet "Add `arm64` to the Linux targets in electron-builder
config" is not required. Passing `--arm64` explicitly is still recommended, for
determinism rather than necessity: it makes the artifact's arch a property of the
build command instead of a property of whichever runner picked up the job.

### The artifact name is the only real config blocker, and `${arch}` will not spell it `aarch64`

`desktop/package.json:155` is the hardcoded literal `LucidAgent-x86_64.${ext}`.
`deb` and `rpm` already template `${arch}` correctly (lines 158, 172), so AppImage
naming is the sole hardcode.

But `${arch}` does not expand the way the brief's stated goal assumes.
`builder-util/out/arch.js:58-91` `getArtifactArchName(arch, ext)` special-cases
arm64 to `aarch64` **only** for `rpm`, `pacman`, and `flatpak` (lines 85-89).
Every other extension, including **AppImage and deb**, gets the default
`Arch[arch]`, which is the string `arm64`. For x64 the same function yields
`x86_64` for AppImage and rpm and `amd64` for deb (lines 61-68).

So templating `artifactName` as `LucidAgent-${arch}.${ext}` produces:

| Target | x64 (today) | x64 after templating | arm64 |
|---|---|---|---|
| AppImage | `LucidAgent-x86_64.AppImage` | `LucidAgent-x86_64.AppImage` (unchanged) | `LucidAgent-arm64.AppImage` |
| deb | `lucidagentide-desktop_<v>_amd64.deb` | unchanged | `..._arm64.deb` |
| rpm | `lucidagentide-desktop-<v>.x86_64.rpm` | unchanged | `....aarch64.rpm` |

Two things follow. First, templating is **safe for the existing x86_64 artifact**:
`getArtifactArchName(x64, "AppImage")` is exactly `x86_64`, so the current
filename is preserved byte-for-byte and no published download link breaks.
Second, the brief's Increment B goal names `LucidAgent-aarch64.AppImage`, which
plain `${arch}` will **not** produce. That is a genuine decision for ADR-0353:
take `arm64` (the mechanism's own convention, zero custom logic, but inconsistent
with the `.rpm` which will say `aarch64`) or force `aarch64` per-arch (matches the
brief and the rpm, but needs an explicit per-arch `artifactName` override).

This must be settled **before** Increment D, not during it. The site's download
links are version-pinned filenames resolved through
`/releases/latest/download/...`, and `build-desktop.yml:97-105` records a prior
incident where exactly that class of filename mismatch left the site's pinned
links 404ing. Choosing the AppImage arch spelling late means choosing it twice.

## 7. CI and release-gate arch assumptions

No arm64 runner exists anywhere. `build-desktop.yml:43-51` is
`macos-latest` / `windows-latest` / `ubuntu-latest`, and `build-creator.yml:48-56`
mirrors it. `ci.yml:23` is `ubuntu-latest` for the harness leg, `ci.yml:82` adds a
`windows-latest` full-gate leg (ADR-0352), and the Python scanner job is matrixed
across `[ubuntu-latest, windows-latest]` (`ci.yml:101-107`) on Python `3.12`
(`ci.yml:112`). No arm64 runner label appears in any workflow.

Hardcoded architecture strings that Increment B or D will have to touch:

| Location | String |
|---|---|
| `desktop/package.json:155` | `LucidAgent-x86_64.${ext}` |
| `desktop/build/electron-builder.creator.cjs:78` | `LucidCreator-x86_64.${ext}` |
| `build-desktop.yml:299-300` | `LucidAgent-mac-arm64.pkg`, `LucidAgent-mac-x64.pkg` (cask pin) |
| `desktop/build/release_identity.test.ts:435-441` | `LucidAgent-x86_64.AppImage`, `...amd64.deb`, `...x86_64.rpm` fixtures |

The release identity gate (`release-identity-gate.ts`, ADR-0307) classifies
AppImage by **filename stem**, so a new `LucidAgent-aarch64.AppImage` will need
its expected-name set extended or the gate will reject it as an unrecognized
file in the release dir. That gate is fail-closed by design
(`build-desktop.yml:214-216`), so this shows up as a hard failure, not a silent
pass. Worth knowing before it surprises someone mid-release.

-----

## Residual unknowns

Honest list. None of these block Increment B.

**Resolved after the first pass** (both were cheap lookups, closed in the same
increment since neither required a code change):

- ~~Electron 44's linux-arm64 asset~~. **RESOLVED.** Resolved version is exactly
  `44.0.0`, and `electron-v44.0.0-linux-arm64.zip` is published upstream.
  See section 6.
- ~~Whether `electron-builder --linux` defaults to host arch or x64~~.
  **RESOLVED: host arch.** Traced through the installed electron-builder `25.1.8`
  source, `builder.js:42` to `targetFactory.js:18`. See section 6. This removed
  one item from Increment B and surfaced the AppImage arch-spelling decision.

**Still open:**

1. DuckDB arm64 `.node` actually loading inside the compiled `bin/lucid-engine`.
   Cannot be proven without arm64 hardware; this is Increment C item 4.
2. Whether `sharp` is loaded at all in the packaged Linux app.
3. glibc floor. `aarch64-unknown-linux-gnu` CPython and the Ubuntu-built Whisper
   arm64 binary both carry a glibc requirement. `[UNVERIFIED]` what the effective
   minimum is, which matters for older arm64 distros and for any musl target.
   The DGX Spark named in Increment C is Ubuntu-based, so this is unlikely to
   bite there, but it should be stated in the release notes rather than assumed.

-----

## Recommended ordering for Increment B

Not executed in this increment. Recorded so the next session does not re-derive it.

1. Add three linux-arm64 entries to `fetch-runtimes.ts` SPECS using the verified
   hashes above, re-confirmed via `REFRESH=1` at commit time.
2. Add arch-aware selection to the SPECS filter (`fetch-runtimes.ts:185-186`) so
   the x86_64 Linux build does not bundle arm64 payloads. Keep the plain-`bun`
   alias emission (lines 271-283) reachable on both arches, or `airgap-smoke.ts:125-126`
   fails the build on the missing alias.
3. Template the Linux `artifactName` off `${arch}`. This is safe for x86_64: the
   existing filename is reproduced byte-for-byte. **Decide the arm64 AppImage
   spelling explicitly**, because plain `${arch}` yields `arm64` while the `.rpm`
   will independently say `aarch64` (see section 6). Apply the same fix to the
   Creator config (`electron-builder.creator.cjs:78`).
4. Extend the release identity gate's expected-name set for the new artifact.
   It classifies AppImage by filename stem and is fail-closed on unrecognized
   files, so a new name is rejected until the set is extended.
5. Add the `ubuntu-24.04-arm` leg to `build-desktop.yml`. No `arch` array is
   needed on the Linux target (section 6), though passing `--arm64` explicitly in
   a dedicated script is recommended for determinism. The air-gap gate is already
   arch-parameterized and executes the scanner on the runner, so this leg is
   self-checking from the first run.
6. Consider adding a DuckDB probe to `airgap-smoke.ts`, which is the only
   bundled native artifact the gate currently does not cover.

**ADR note.** Increment A makes no architectural choice, so it gets no ADR;
this document is the deliverable. Increment B does make real choices, items 2
and 3 above, and should therefore carry one. The next free number is
**ADR-0353**: the highest existing is `## ADR-0352 -- P-TEST.W2: CI runs the
gate on the OS the developer actually uses (2026-09-08)` at `DECISIONS.md:23706`.
Required heading format, enforced by `harness/adr_numbering.test.ts:38-44` via
`/^## ADR-(A?\d{3,4})\b/`, is:

```
## ADR-NNNN -- P-ARM64.B: <title> (YYYY-MM-DD)
```

No prior ADR discusses arm64, aarch64, multi-arch builds, or Apple Silicon
packaging, so Increment B's ADR is the first on this subject and should carry
the corrected context from this audit rather than the brief's assumptions.

-----

## Acceptance

Brief's Increment A acceptance was "every bundled native artifact has a verdict.
No code changed."

- 12 artifacts enumerated, each with a verdict: 6 available, 4 needs-build,
  2 not-shipped, 0 blockers.
- All six items the brief asked for by name are covered: scanner sidecar (1),
  bun (2), DuckDB (3), other native modules (4), Whisper and Kokoro/ONNX (5),
  Electron (6).
- The brief's deferred side question, Windows architecture, is resolved: x64-only
  by explicit config.
- No code, build config, or workflow file was modified. The only file added is
  this document.
