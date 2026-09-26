// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/build/airgap-smoke.ts — the air-gap gate (ADR-0225).
//
// Runs in CI right after electron-builder packages the app, on the SAME native runner. It proves the
// PACKAGED bundle is self-contained: the two runtimes that used to be fetched on first launch — the omp
// agent (`bun add -g @oh-my-pi/pi-coding-agent`) and the scanner's Python (`uv venv --python 3.12`) — now
// resolve and RUN entirely from bundled resources, with no network. If the installer isn't self-contained
// (a runtime is missing, or the POSIX omp shim / bundled Python lost its exec bit through packaging), this
// fails the build — the whole point being that an air-gapped host must work cold.
//
// It exercises the runtimes DIRECTLY from `resources/` (never `bun add` / `uv venv`), so a green run means
// no fetch path was needed. The scanner check doubles as keystone #2 coverage: clean text → zero findings,
// a bidi/homoglyph sample → the expected findings, all under the bundled interpreter.

import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, delimiter as PATH_SEP, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ArchTag, type Plat, resolveResourcesDir } from "./packaged_tree.ts";

const HERE = dirname(fileURLToPath(import.meta.url)); // desktop/build
const PLAT = process.platform; // "win32" | "linux" | "darwin"
const ARCH = process.arch; // "x64" | "arm64"
const EXE = PLAT === "win32" ? ".exe" : "";

function fail(msg: string): never {
  console.error(`\n✗ air-gap smoke: ${msg}\n`);
  process.exit(1);
}

/** Which electron-builder output dir under desktop/ to gate, as a bare directory NAME. Creator packages
 *  into `release-creator` (build/electron-builder.creator.cjs), so this gate has to be pointable at it,
 *  or a Creator release build would validate whatever stale Agent `release/` tree sat on the runner and
 *  report green about bytes it never looked at. A NAME, not a path: anchoring resolution inside desktop/
 *  means a stray value cannot aim the gate at an unrelated tree and pass. */
function releaseDirName(): string {
  const raw = (process.env.LUCID_RELEASE_DIR ?? "").trim();
  if (!raw) return "release";
  if (raw.includes("/") || raw.includes("\\") || raw.startsWith(".")) {
    fail(`LUCID_RELEASE_DIR must be a bare directory name under desktop/, got "${raw}"`);
  }
  return raw;
}
const RELEASE = join(HERE, "..", releaseDirName());

/** The packaged resources dir for THIS runner's plat+arch, derived from electron-builder's own
 *  appOutDir naming rule (see build/packaged_tree.ts). Hardcoding `linux-unpacked` here is what
 *  discarded the first working arm64 AppImage: the tree was named `linux-arm64-unpacked`. */
const resolved = resolveResourcesDir({ releaseDir: RELEASE, plat: PLAT as Plat, arch: ARCH as ArchTag });
if (!resolved.ok) fail(resolved.reason);
const res = resolved.dir;
console.log(`air-gap smoke: packaged resources = ${res}`);
if (!resolved.exact) console.log(`  note: gating a tree other than the expected ${resolved.expected}/`);

// --- 1) scanner Python: bundled interpreter runs the scanner OFFLINE ---------------------------------
const pyDir = join(res, "runtimes", `python-${PLAT}-${ARCH}`);
// POSIX ships bin/python3 as a symlink to the real bin/python3.12; accept either (see fetch-runtimes).
const pyCands = PLAT === "win32"
  ? [join(pyDir, "python.exe")]
  : [join(pyDir, "bin", "python3"), join(pyDir, "bin", "python3.12"), join(pyDir, "bin", "python")];
const py = pyCands.find((p) => existsSync(p));
if (!py) fail(`bundled Python interpreter missing under ${pyDir}/bin (tried: ${pyCands.map((p) => p.slice(pyDir.length + 1)).join(", ")})`);

const scannerDir = join(res, "repo", "scanner-sidecar");
if (!existsSync(join(scannerDir, "scanner.py"))) fail(`bundled scanner-sidecar missing at ${scannerDir}`);

// U+0430 (Cyrillic а) homoglyph + U+200B zero-width space — the sample must produce those two findings,
// and clean text must produce none (keystone #2: no false positives). json round-trip normalizes the
// finding objects (dataclass or dict) to plain dicts so the asserts don't depend on the return shape.
const probe = [
  "import json, scanner",
  "summ = lambda o: vars(o) if hasattr(o, '__dict__') else o",
  "clean = json.loads(json.dumps(scanner.inspect_text('just some normal english text'), default=summ))",
  "dirty = json.loads(json.dumps(scanner.inspect_text('verify p\\u0430ypal now\\u200b'), default=summ))",
  "assert clean == [], f'clean text produced findings (false positive): {clean}'",
  "kinds = {f['type'] for f in dirty}",
  "assert {'zero-width', 'mixed-script-homoglyph'} <= kinds, f'missing expected findings: {dirty}'",
  "print('  scanner OK offline -', len(dirty), 'findings on the dirty sample, 0 on clean')",
].join("\n");

try {
  execFileSync(py, ["-c", probe], { cwd: scannerDir, stdio: "inherit" });
} catch (e) {
  fail(`scanner did not run under the bundled interpreter: ${(e as Error).message}`);
}

// --- 2) omp agent: bundled shim resolves + launches with ONLY bundled bun on PATH ---------------------
const ompShim = join(res, "repo", "node_modules", ".bin", `omp${EXE}`);
if (!existsSync(ompShim)) fail(`bundled omp shim missing: ${ompShim} (is node_modules/.bin/omp* re-included?)`);

const bunBin = join(res, "runtimes", `bun-${PLAT}-${ARCH}${EXE}`);
if (!existsSync(bunBin)) fail(`bundled bun missing: ${bunBin}`);
// The omp shim (.bunx) shells out to a PLAIN `bun[.exe]` on PATH, NOT the name-suffixed bundled binary. If
// the plain alias is missing, a box with no global bun gets "bun is not installed in %PATH%" → omp never
// starts → no models + no OAuth. Assert the alias exists (fetch-runtimes emits it).
const bunPlain = join(res, "runtimes", `bun${EXE}`);
if (!existsSync(bunPlain)) fail(`plain bun alias missing: ${bunPlain} — omp's shim needs a bare "bun" on PATH (fetch-runtimes must emit it)`);
// ...and that it is a copy of THIS arch's bun. Existing-and-executable is not enough: the arm64 AppImage
// shipped an x86-64 binary here (fetch-runtimes picked the first linux bun spec instead of the
// arch-matched one), which surfaced four steps later as `runtimes/bun: 1: Syntax error: ")" unexpected`
// when /bin/sh got ENOEXEC and fell back to parsing the ELF as a script. Comparing against the
// arch-suffixed binary names the fault directly instead of leaving a shell parse error as the evidence.
const plainStat = statSync(bunPlain);
const archStat = statSync(bunBin);
if (plainStat.size !== archStat.size) {
  fail(
    `plain bun alias is not a copy of ${basename(bunBin)}: ${plainStat.size} bytes vs ${archStat.size}. ` +
      `It is almost certainly another arch's bun, which cannot exec here (fetch-runtimes must alias bun-${PLAT}-${ARCH}).`,
  );
}
/** The first 64 bytes of a file, read WITHOUT loading it: these binaries are ~60 MB each and only the
 *  ELF/PE header is being compared. */
function execHeader(p: string): string {
  const fd = openSync(p, "r");
  try {
    const buf = Buffer.alloc(64);
    readSync(fd, buf, 0, 64, 0);
    return buf.toString("hex");
  } finally {
    closeSync(fd);
  }
}
if (execHeader(bunPlain) !== execHeader(bunBin)) {
  fail(`plain bun alias has a different executable header than ${basename(bunBin)} — wrong arch or a corrupt copy`);
}
console.log(`  plain bun alias OK - byte-matched copy of ${basename(bunBin)}`);
// Run the shim with ONLY the bundled runtimes dir up front, and SCRUB any other bun from PATH, so a green
// run proves the shim reaches omp through the BUNDLED bun — not a global one the CI/dev box happens to have.
const scrubbed = (process.env.PATH ?? "").split(PATH_SEP).filter((d) => !existsSync(join(d, `bun${EXE}`)) || d === dirname(bunBin)).join(PATH_SEP);
const env = { ...process.env, PATH: `${dirname(bunBin)}${PATH_SEP}${scrubbed}` };
try {
  const out = execFileSync(ompShim, ["--version"], { env, encoding: "utf8" }).trim();
  if (!/omp\//.test(out)) fail(`omp shim ran but reported no version: "${out}"`);
  console.log(`  omp OK offline (bundled bun only) - ${out}`);
} catch (e) {
  fail(`bundled omp shim did not launch with only the bundled bun: ${(e as Error).message}`);
}

// --- 3) compiled `lucid` launcher: STARTS, i.e. its native addon resolves -----------------------------
// Checks 1-2 exercise omp through the node_modules/.bin/omp SHIM. The marketplace IDE extensions do not
// use that path — they spawn the COMPILED bin/lucid (P-EXT.1/ADR-0038, installedAppLauncherPaths()), which
// is a bunfs image with no node_modules resolution. That difference shipped a brick: the pi_natives addon
// lives only under node_modules/@oh-my-pi/pi-natives-*, which the compiled loader never searches, so every
// packaged `lucid acp` died with "Failed to load pi_natives" while the desktop app worked fine. Nothing
// here caught it, because nothing here ran the compiled binary. Now something does.
const launcher = join(res, "repo", "bin", `lucid${EXE}`);
if (!existsSync(launcher)) fail(`compiled launcher missing: ${launcher} (did compile-lucid run?)`);

// The addon must sit NEXT TO the binary — that is the only search path we control (build/copy-natives.ts
// puts it there). Resolve through it: on POSIX it is a relative symlink into node_modules, so a packaging
// step that broke the link leaves a dangling path that existsSync() rejects here rather than at a user.
const addons = readdirSync(dirname(launcher)).filter((f) => f.startsWith(`pi_natives.${PLAT}-${ARCH}`) && f.endsWith(".node"));
if (!addons.length) fail(`no pi_natives.${PLAT}-${ARCH}*.node next to ${launcher} — the compiled launcher cannot start (run build/copy-natives.ts)`);
for (const a of addons) {
  const p = join(dirname(launcher), a);
  if (!existsSync(p) || statSync(p).size === 0) fail(`${p} does not resolve to a non-empty addon (broken symlink through packaging?)`);
}

// Prove it by RUNNING it. The launcher fail-closes without the scanner sidecar (invariant #3), so a
// non-zero exit is expected and fine — we assert only that it got far enough to have loaded its natives.
const run = spawnSync(launcher, ["--version"], { encoding: "utf8", timeout: 120_000 });
const said = `${run.stdout ?? ""}${run.stderr ?? ""}`;
if (/Failed to load pi_natives|Cannot find module .*pi_natives/i.test(said)) {
  fail(`compiled launcher cannot load its native addon:\n${said.split("\n").slice(0, 6).join("\n")}`);
}
console.log(`  lucid launcher OK - ${addons.length} native addon${addons.length === 1 ? "" : "s"} resolve next to the binary, no load failure`);

// --- 3a) the launcher's PREFLIGHT passes, i.e. it can FIND its own bundled scanner interpreter -------
// The `--version` probe above proves the launcher STARTS. It does not prove the launcher can reach the
// scanner, and that difference shipped a real defect (P-SCANPY.1 / ADR-0366): on an arm64 install the
// launcher left SCANNER_PYTHON unset, `scanner_client.resolvePython()` fell back to the bare name
// `python`, and Ubuntu 24.04 does not provide one. `lucid check` died with "scanner sidecar
// unreachable: scanner stdin not writable" while the bundled aarch64 CPython sat one directory away,
// working. Found by running a packaged AppImage on real hardware, which is far too late.
//
// So the gate now runs the FAIL-CLOSED PREFLIGHT itself and requires exit 0. Env is deliberately NOT
// pre-seeded: no SCANNER_PYTHON, no PATH help. The whole assertion is that the PACKAGE is
// self-sufficient, so anything handed to it here would hide exactly the class of bug it exists to
// catch. This is the difference between proving the bundled runtimes WORK and proving the product can
// FIND them.
const pre = spawnSync(launcher, ["check"], { encoding: "utf8", timeout: 180_000 });
const preSaid = `${pre.stdout ?? ""}${pre.stderr ?? ""}`.trim();
if (pre.status !== 0) {
  fail(
    `\`lucid check\` exited ${pre.status} from the packaged tree - the launcher cannot reach its own ` +
      `bundled scanner interpreter (see ADR-0366; check harness/launcher/lucid_acp.ts scannerPythonCandidates):\n` +
      preSaid.split("\n").slice(0, 6).join("\n"),
  );
}
console.log(`  lucid check OK - fail-closed preflight passes using ONLY bundled resources: ${preSaid.split("\n").slice(-1)[0]}`);

// --- 3b) compiled desktop ENGINE + prebuilt renderer (P-WINBOOT.2 / ADR-0260) ------------------------
// The desktop app spawns the COMPILED engine (bin/lucid-engine) instead of `bun run desktop/dev.ts`, so
// Bun never module-loads a .ts out of a protected install dir (the v1.12.0 Program Files brick). If dist
// did not run compile-engine / build-renderer, resolveEngineSpawn silently FALLS BACK to `bun run dev.ts`
// and the brick returns. Assert both artifacts shipped so that regression fails the build, not a user.
const engineBin = join(res, "repo", "bin", `lucid-engine${EXE}`);
if (!existsSync(engineBin)) fail(`compiled desktop engine missing: ${engineBin} (did compile-engine run? see package.json dist scripts)`);
const rendererBundle = join(res, "repo", "desktop", "renderer", "app.bundle.js");
if (!existsSync(rendererBundle)) fail(`prebuilt renderer bundle missing: ${rendererBundle} (did build-renderer run? without it the packaged engine Bun.build()s .ts from the install dir at runtime)`);
console.log("  desktop engine OK - compiled bin/lucid-engine + prebuilt renderer bundle shipped (no runtime .ts load from the install dir)");

// --- 4) bundled offline Whisper: the whisper.cpp server binary + its co-located libs (P-STT.2c/.2d) -------
// The no-code "Install & start" button needs a whisper-server on disk. `bun run whisper` stages it into
// resources/whisper before packaging; if that step failed (or a runner lacked cmake for the mac source
// build), fail here rather than ship an app whose offline-STT button dead-ends.
const whisperBin = join(res, "whisper", `whisper-server${EXE}`);
if (!existsSync(whisperBin)) fail(`bundled whisper-server missing: ${whisperBin} (did \`bun run whisper\` stage it? see build/fetch-whisper.ts)`);
const whisperLibs = readdirSync(join(res, "whisper")).filter((f) => /\.(so|dylib|dll)/.test(f) && (f.includes("whisper") || f.includes("ggml")));
if (!whisperLibs.length) fail(`bundled whisper libs missing next to ${whisperBin} - the co-located whisper/ggml shared libs are required to load`);
console.log(`  whisper OK - whisper-server + ${whisperLibs.length} shared lib(s) bundled for offline STT`);

console.log("\n✓ air-gap smoke passed: omp + scanner Python + the compiled lucid launcher resolve and run from bundled resources (no network).\n");
