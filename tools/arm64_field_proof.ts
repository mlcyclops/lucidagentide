// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/arm64_field_proof.ts - run an arm64 LUCID package on REAL arm64 hardware (P-ARM64.D).
//
// The standing gap this closes: the linux-arm64 AppImage has been BUILT but never EXECUTED. CI proves
// it packages on an arm runner; nothing has proven the bundled aarch64 runtimes actually run, that the
// scanner keystone holds there, or that the fail-closed gate refuses on that arch. A built-but-never-run
// artifact is the ADR-0303 vacuous-green shape at release scale.
//
// Run it ON the target box, WITH the extracted package's OWN bundled bun, so "the bundled arm64 bun
// executes" is demonstrated by the script running at all rather than asserted:
//
//   ./squashfs-root/resources/runtimes/bun-linux-arm64 arm64_field_proof.ts ./squashfs-root/resources
//
// Needs NO credentials and makes NO network call: every check is local to the package. A live model turn
// is deliberately out of scope, because it would mean moving a secret onto the test host, and the
// provider path is arch-independent anyway. What is arch-dependent is exactly what this checks.

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readSync, renameSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// ABSOLUTE, deliberately. Several checks spawn a bundled binary with `cwd` set elsewhere (the scanner
// runs in scanner-sidecar/, the engine in repo/), and a RELATIVE program path is resolved against that
// new cwd, not the one `existsSync` used. The first run of this script on a Spark passed the existence
// check and then died with ENOENT on posix_spawn for a file that was demonstrably there.
const res = process.argv[2] ? resolve(process.argv[2]) : "";
if (!res || !existsSync(res)) {
  console.error(`usage: <bundled-bun> arm64_field_proof.ts <path-to-resources-dir>\ngot: ${process.argv[2] ?? "(nothing)"}`);
  process.exit(2);
}
const ARCH = process.arch;
const PLAT = process.platform;
const repo = join(res, "repo");
const runtimes = join(res, "runtimes");

let failures = 0;
function ok(msg: string): void {
  console.log(`  PASS  ${msg}`);
}
function bad(msg: string): void {
  failures++;
  console.log(`  FAIL  ${msg}`);
}

/** The ELF e_machine of a binary, read from the header rather than shelled out to `file` (which is not
 *  guaranteed installed). Offset 0x12, little-endian u16. AArch64 is 183 (0xB7), x86-64 is 62 (0x3E).
 *  This is the check that catches an x64 binary that slipped into an arm64 package: it would still be
 *  PRESENT and the right SIZE, and only its header says it can never run here.
 *
 *  Read with openSync/readSync: these binaries are 50-120 MB and only 20 bytes matter. The first
 *  version used `Bun.file(p).slice(0, 20).arrayBuffer()`, which returns a PROMISE, so every binary
 *  reported "unreadable/not ELF" while running fine one line later. A check that cannot fail for the
 *  right reason is worse than no check, so this reads bytes synchronously and means it. */
function elfMachine(path: string): number | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(20);
    if (readSync(fd, buf, 0, 20, 0) < 20) return null;
    if (buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) return null;
    return buf.readUInt16LE(18);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
const ELF_NAME: Record<number, string> = { 183: "aarch64", 62: "x86-64", 243: "riscv", 40: "arm" };

function run(argv: string[], opts: { cwd?: string; timeout?: number; env?: Record<string, string> } = {}) {
  const r = spawnSync(argv[0]!, argv.slice(1), {
    cwd: opts.cwd,
    encoding: "utf8",
    timeout: opts.timeout ?? 120_000,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

console.log(`\nLUCID arm64 field proof`);
console.log(`  host      ${PLAT}-${ARCH}`);
console.log(`  resources ${res}\n`);

// --- 0) the interpreter running this file IS the bundled one ------------------------------------------
console.log("0) bundled bun (this script is running under it)");
if (ARCH === "arm64") ok(`bun ${Bun.version} executing as ${PLAT}-${ARCH}`);
else bad(`expected to be running on arm64, got ${ARCH} - was this launched with the bundled arm64 bun?`);

// --- 1) every bundled native runtime is an aarch64 ELF that EXECUTES ----------------------------------
console.log("\n1) bundled runtimes are aarch64 and execute");
const pyDir = join(runtimes, `python-${PLAT}-${ARCH}`);
const py = [join(pyDir, "bin", "python3"), join(pyDir, "bin", "python3.12"), join(pyDir, "bin", "python")]
  .find((p) => existsSync(p));
const bins: Array<{ label: string; path: string | undefined; version: string[] }> = [
  { label: "bun", path: join(runtimes, `bun-${PLAT}-${ARCH}`), version: ["--version"] },
  { label: "uv", path: join(runtimes, `uv-${PLAT}-${ARCH}`), version: ["--version"] },
  { label: "python", path: py, version: ["-c", "import platform,sys;print(sys.version.split()[0], platform.machine())"] },
];
for (const b of bins) {
  if (!b.path || !existsSync(b.path)) {
    bad(`${b.label}: missing (looked for ${b.path ?? `python3 under ${pyDir}/bin`})`);
    continue;
  }
  const m = elfMachine(b.path);
  if (m !== 183) bad(`${b.label}: ELF machine is ${m === null ? "unreadable/not ELF" : (ELF_NAME[m] ?? m)}, expected aarch64`);
  const r = run([b.path, ...b.version], { timeout: 60_000 });
  if (r.code === 0) ok(`${b.label}: aarch64 ELF, runs -> ${r.out.split("\n")[0]}`);
  else bad(`${b.label}: exited ${r.code} -> ${r.out.slice(0, 200)}`);
}

// The omp shim shells out to a PLAIN `bun` on PATH, not the name-suffixed binary (see airgap-smoke).
// Its ARCH is checked, not just its presence: the first arm64 build shipped an x86-64 bun here, which
// exists, is executable, and is real bun. It simply cannot exec on this machine.
const plainBun = join(runtimes, "bun");
if (!existsSync(plainBun)) {
  bad(`plain bun alias missing at ${plainBun} (omp's shim needs a bare \`bun\` on PATH)`);
} else {
  const m = elfMachine(plainBun);
  if (m !== 183) bad(`plain bun alias is ${m === null ? "unreadable/not ELF" : (ELF_NAME[m] ?? String(m))}, expected aarch64 - omp cannot start`);
  else {
    const r = run([plainBun, "--version"], { timeout: 60_000 });
    if (r.code === 0) ok(`plain bun alias: aarch64, runs -> ${r.out.split("\n")[0]}`);
    else bad(`plain bun alias exited ${r.code} -> ${r.out.slice(0, 200)}`);
  }
}

// --- 2) KEYSTONE 2: the Unicode scanner, under the bundled interpreter, on this arch ------------------
console.log("\n2) scanner keystone under the bundled interpreter");
const scannerDir = join(repo, "scanner-sidecar");
// Byte-identical probe to desktop/build/airgap-smoke.ts: a clean control must yield ZERO findings (no
// false positives) and the bidi/homoglyph sample must yield both expected types.
const probe = [
  "import json, scanner",
  "summ = lambda o: vars(o) if hasattr(o, '__dict__') else o",
  "clean = json.loads(json.dumps(scanner.inspect_text('just some normal english text'), default=summ))",
  "dirty = json.loads(json.dumps(scanner.inspect_text('verify p\\u0430ypal now\\u200b'), default=summ))",
  "assert clean == [], f'clean text produced findings (false positive): {clean}'",
  "kinds = {f['type'] for f in dirty}",
  "assert {'zero-width', 'mixed-script-homoglyph'} <= kinds, f'missing expected findings: {dirty}'",
  "print(len(dirty), 'findings on dirty, 0 on clean')",
].join("\n");
if (!py) bad("no bundled interpreter, cannot run the scanner");
else if (!existsSync(join(scannerDir, "scanner.py"))) bad(`bundled scanner missing at ${scannerDir}`);
else {
  const r = run([py, "-c", probe], { cwd: scannerDir });
  if (r.code === 0) ok(`scanner: ${r.out}`);
  else bad(`scanner failed under the bundled interpreter: ${r.out.slice(0, 400)}`);
}

// --- 3) the compiled launcher starts, i.e. its aarch64 native addon resolves --------------------------
console.log("\n3) compiled launcher + native addon");
const launcher = join(repo, "bin", "lucid");
if (!existsSync(launcher)) bad(`compiled launcher missing: ${launcher}`);
else {
  const addons = readdirSync(join(repo, "bin")).filter((f) => f.startsWith(`pi_natives.${PLAT}-${ARCH}`) && f.endsWith(".node"));
  if (!addons.length) bad(`no pi_natives.${PLAT}-${ARCH}*.node next to the launcher`);
  for (const a of addons) {
    const p = join(repo, "bin", a);
    const m = elfMachine(p);
    if (!existsSync(p) || statSync(p).size === 0) bad(`${a}: does not resolve to a non-empty file (broken symlink?)`);
    else if (m !== 183) bad(`${a}: ELF machine ${m === null ? "unreadable" : (ELF_NAME[m] ?? m)}, expected aarch64`);
    else ok(`${a}: aarch64 addon, ${(statSync(p).size / 1e6).toFixed(0)} MB`);
  }
  const r = run([launcher, "--version"]);
  if (/Failed to load pi_natives|Cannot find module .*pi_natives/i.test(r.out)) {
    bad(`launcher cannot load its native addon:\n${r.out.split("\n").slice(0, 4).join("\n")}`);
  } else ok(`launcher runs -> ${r.out.split("\n")[0]?.slice(0, 120)}`);
}

// --- 4) the fail-closed preflight PASSES with the scanner present ------------------------------------
console.log("\n4) fail-closed preflight (invariant 3)");
// `lucid check` resolves the repo root by probing for the KEYSTONE file (ADR-0356). This is therefore
// also the first field test of that resolver inside a real packaged tree on this arch.
//
// Run it EXACTLY as shipped first: no SCANNER_PYTHON, no PATH help. Setting the env up front would
// hide the defect this found (ADR-0366), where the launcher could not resolve the interpreter it
// shipped with. When the shipped invocation fails, retry with the bundled interpreter named
// explicitly, purely to SPLIT the diagnosis: "the launcher cannot find python" and "the gate or the
// scanner is broken on this arch" are very different findings and must not share one FAIL line.
let check = run([launcher, "check"], { timeout: 180_000 });
// The env under which `check` PASSED. Section 5's negative must reuse it, or removing the scanner
// would "refuse" for the interpreter reason instead and the negative would pass vacuously.
let checkEnv: Record<string, string> | undefined;
if (check.code === 0) {
  ok(`lucid check -> ready (exit 0): ${check.out.split("\n").slice(-1)[0]?.slice(0, 140)}`);
} else if (py) {
  const forced = run([launcher, "check"], { timeout: 180_000, env: { SCANNER_PYTHON: py } });
  if (forced.code === 0) {
    bad(
      `lucid check FAILS as shipped but PASSES with SCANNER_PYTHON=${py}\n` +
        `        -> the gate and scanner work on this arch; the LAUNCHER cannot resolve the bundled\n` +
        `           interpreter (ADR-0366). Expect this on any host with no global \`python\`.\n` +
        `        shipped: ${check.out.split("\n").slice(-1)[0]?.slice(0, 160)}`,
    );
    check = forced; // section 5 can still prove fail-closed, using a working baseline
    checkEnv = { SCANNER_PYTHON: py };
  } else {
    bad(`lucid check exited ${check.code} with the scanner PRESENT, and still fails with an explicit interpreter: ${forced.out.slice(0, 400)}`);
  }
} else {
  bad(`lucid check exited ${check.code} with the scanner PRESENT: ${check.out.slice(0, 500)}`);
}

// --- 5) ...and REFUSES when the scanner is gone (the negative that makes check 4 mean something) ------
// Without this, a `check` that always returned 0 would look identical to a working gate. Invariant 3
// says an unobtainable scan is a BLOCK, never a pass, so the absence of the scanner must be fatal.
const scannerPy = join(scannerDir, "scanner.py");
const hidden = `${scannerPy}.hidden-by-field-proof`;
if (check.code === 0 && existsSync(scannerPy)) {
  let moved = false;
  try {
    renameSync(scannerPy, hidden);
    moved = true;
    const refused = run([launcher, "check"], { timeout: 180_000, env: checkEnv });
    if (refused.code !== 0) ok(`lucid check REFUSES with the scanner removed (exit ${refused.code}) - fail-closed holds`);
    else bad("lucid check returned 0 with the scanner REMOVED - fail-closed is broken on this arch");
  } catch (e) {
    bad(`could not run the fail-closed negative: ${(e as Error).message}`);
  } finally {
    if (moved && existsSync(hidden)) renameSync(hidden, scannerPy);
  }
} else {
  console.log("  SKIP  fail-closed negative (the positive check did not pass, so it would prove nothing)");
}

// --- 6) the compiled desktop engine boots and serves /api/health -------------------------------------
console.log("\n6) compiled engine boots and serves");
const engine = join(repo, "bin", "lucid-engine");
const renderer = join(repo, "desktop", "renderer", "app.bundle.js");
if (!existsSync(engine)) bad(`compiled engine missing: ${engine}`);
else if (!existsSync(renderer)) bad(`prebuilt renderer bundle missing: ${renderer} (engine would Bun.build() .ts at runtime)`);
else {
  const m = elfMachine(engine);
  if (m !== 183) bad(`engine: ELF machine ${m === null ? "unreadable" : (ELF_NAME[m] ?? m)}, expected aarch64`);
  const port = 5400 + Math.floor(Math.random() * 300);
  const child = Bun.spawn([engine], {
    cwd: repo,
    env: { ...process.env, PORT: String(port), LUCID_HEADLESS: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  let health: string | null = null;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && health === null) {
    await Bun.sleep(1000);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(4000) });
      if (r.ok) health = await r.text();
    } catch {
      /* not up yet */
    }
    if (child.exitCode !== null) break;
  }
  if (health !== null) {
    let parsed = false;
    try {
      parsed = JSON.parse(health).ok === true;
    } catch {
      parsed = false;
    }
    if (parsed) ok(`engine answered /api/health on :${port} -> ${health.slice(0, 120)}`);
    else bad(`engine answered but not ok:true -> ${health.slice(0, 200)}`);
    // Serve the renderer the window would actually load (ADR-0260: prebuilt bytes, never a runtime build).
    try {
      const app = await fetch(`http://127.0.0.1:${port}/app.js`, { signal: AbortSignal.timeout(10_000) });
      const body = app.ok ? await app.text() : "";
      if (body.length > 100_000) ok(`/app.js served ${(body.length / 1e6).toFixed(2)} MB of prebuilt renderer`);
      else bad(`/app.js served only ${body.length} bytes (status ${app.status})`);
    } catch (e) {
      bad(`/app.js did not serve: ${(e as Error).message}`);
    }
  } else {
    const tail = await new Response(child.stderr).text();
    bad(`engine never answered /api/health (exit ${child.exitCode}): ${tail.slice(-500)}`);
  }
  child.kill();
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} on ${PLAT}-${ARCH}\n`);
process.exit(failures === 0 ? 0 : 1);
