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
import { existsSync, readdirSync, statSync } from "node:fs";
import { delimiter as PATH_SEP, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // desktop/build
const RELEASE = join(HERE, "..", "release");
const PLAT = process.platform; // "win32" | "linux" | "darwin"
const ARCH = process.arch; // "x64" | "arm64"
const EXE = PLAT === "win32" ? ".exe" : "";

function fail(msg: string): never {
  console.error(`\n✗ air-gap smoke: ${msg}\n`);
  process.exit(1);
}

/** Every plausible packaged `…/resources` dir: the `*-unpacked` tree (win/linux) and any `*.app`
 *  bundle's Contents/Resources (mac, possibly one per arch). */
function candidateResourceDirs(): string[] {
  if (!existsSync(RELEASE)) fail(`no release dir at ${RELEASE} — did electron-builder run?`);
  const out: string[] = [];
  const direct =
    PLAT === "win32" ? join(RELEASE, "win-unpacked", "resources")
    : PLAT === "linux" ? join(RELEASE, "linux-unpacked", "resources")
    : null;
  if (direct && existsSync(direct)) out.push(direct);
  // macOS (and a belt-and-suspenders fallback): hunt for <name>.app/Contents/Resources.
  for (const entry of readdirSync(RELEASE)) {
    const p = join(RELEASE, entry);
    if (!statSync(p).isDirectory()) continue;
    const apps = entry.endsWith(".app")
      ? [p]
      : readdirSync(p).filter((x) => x.endsWith(".app")).map((x) => join(p, x));
    for (const app of apps) {
      const r = join(app, "Contents", "Resources");
      if (existsSync(r)) out.push(r);
    }
  }
  return out;
}

/** Pick the resources dir that carries THIS runner's arch-matched Python (so a mac x64 app bundle
 *  never sends an arm64 runner hunting for an x64 interpreter it can't exec). */
function resolveResources(): string {
  const cands = candidateResourceDirs();
  if (!cands.length) fail("found no packaged resources dir (…-unpacked/resources or *.app/Contents/Resources)");
  const match = cands.find((r) => existsSync(join(r, "runtimes", `python-${PLAT}-${ARCH}`)));
  return match ?? cands[0]!;
}

const res = resolveResources();
console.log(`air-gap smoke: packaged resources = ${res}`);

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

console.log("\n✓ air-gap smoke passed: omp + scanner Python + the compiled lucid launcher resolve and run from bundled resources (no network).\n");
