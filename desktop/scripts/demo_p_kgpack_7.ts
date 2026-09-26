// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-KGPACK.7 (ADR-0340): a BOUGHT pack must import in the SHIPPED app, not only from source.
//
// The field report: "Import a Pack You Own" rejected a purchased Senior Proposal Manager pack with
//   pack db is not a valid KG store: ENOENT: no such file or directory, scandir 'B:\~BUN\root\migrations'
// `B:\~BUN\root` is the virtual bunfs root of the `bun build --compile` engine (bin/lucid-engine,
// ADR-0260). Every DuckDB store computed its migrations directory as join(import.meta.dir, "migrations"),
// which is a real path in a dev run and a virtual one in the shipped binary, where the bundle embeds
// MODULES and not a directory of .sql files. So the store could not open and the pack was refused at the
// scan stage. Nothing about the pack was wrong: its signature verifies and its db holds 2,221 pages.
//
// This demo proves the fix where the bug actually lived. A source-only assertion would be worthless here,
// because from source the OLD code passes too. So it COMPILES a probe with `bun build --compile` (the same
// flag the shipped engine uses), runs it so import.meta.dir is virtual, and requires it to resolve a REAL
// migrations directory and open a REAL KG store. It also covers the second half of the report: the picker
// offered only a folder, so the delivered .lkgpack.zip could not be selected at all and the user had to
// guess that unzipping was required, with nothing in the UI saying so.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMigrationsDir } from "../../harness/migrations_dir.ts";
import { KB_MIGRATIONS_DIR, KbGraphStore } from "../../harness/kb/store.ts";
import { classifyPackInput } from "../kb_pack.ts";

const REPO = join(import.meta.dir, "..", "..");
let failures = 0;
const ok = (m: string): void => console.log(`  ok   ${m}`);
const fail = (m: string): void => { failures++; console.error(`  FAIL ${m}`); };
const check = (cond: boolean, m: string): void => { if (cond) ok(m); else fail(m); };

console.log("\n[1] the resolver probes, and never trusts a virtual path");
const BUNFS = process.platform === "win32" ? "B:\\~BUN\\root" : "/$bunfs/root";
const virtualResolved = resolveMigrationsDir("harness/kb", BUNFS, {
  exists: (p) => p === join(REPO, "harness", "kb", "migrations"),
  execPath: join(REPO, "bin", "lucid-engine"),
  resources: undefined,
});
check(virtualResolved === join(REPO, "harness", "kb", "migrations"), "a virtual module dir falls through to <execPath>/../../harness/kb/migrations");
const ownResolved = resolveMigrationsDir("harness/kb", join(REPO, "harness", "kb"), { exists: existsSync, execPath: "/nowhere/bin/lucid-engine" });
check(ownResolved === join(REPO, "harness", "kb", "migrations"), "a real module dir wins (dev + tests keep their exact old path)");
const resourced = resolveMigrationsDir("harness/kb", BUNFS, {
  exists: (p) => p === join("/res", "repo", "harness", "kb", "migrations"),
  execPath: "/app/bin/lucid-engine",
  resources: "/res",
});
check(resourced === join("/res", "repo", "harness", "kb", "migrations"), "LUCID_RESOURCES (threaded by main.ts when packaged) is honoured");
check(KB_MIGRATIONS_DIR === join(REPO, "harness", "kb", "migrations"), "the live KB constant still points at the repo from source");

console.log("\n[2] the SHIPPED runtime: a compiled binary opens a real KG store");
const work = mkdtempSync(join(tmpdir(), "kgpack7-"));
try {
  const probeSrc = join(work, "probe.ts");
  writeFileSync(probeSrc, [
    `import { KB_MIGRATIONS_DIR, KbGraphStore } from ${JSON.stringify(join(REPO, "harness", "kb", "store.ts").replace(/\\/g, "/"))};`,
    `import { existsSync } from "node:fs";`,
    `const dbPath = process.argv[2]!;`,
    `console.log("MIGRATIONS=" + KB_MIGRATIONS_DIR);`,
    `console.log("MIGRATIONS_EXISTS=" + existsSync(KB_MIGRATIONS_DIR));`,
    `const s = await KbGraphStore.open(dbPath);`,
    `const pages = await s.listPages();`,
    `s.close();`,
    `console.log("OPENED=true PAGES=" + pages.length);`,
  ].join("\n"));

  // The probe must live at <root>/bin/<exe> so the execPath fallback resolves <root>/harness/kb/migrations,
  // exactly like the shipped bin/lucid-engine sitting beside the packaged repo.
  const exe = join(REPO, "bin", `kgpack7-probe${process.platform === "win32" ? ".exe" : ""}`);
  if (!existsSync(join(REPO, "bin"))) mkdirSync(join(REPO, "bin"), { recursive: true });
  const build = spawnSync("bun", ["build", "--compile", probeSrc, "--outfile", exe, "--external", "*.node"], { encoding: "utf8", cwd: REPO });
  if (build.status !== 0) {
    fail(`could not compile the probe: ${(build.stderr || build.stdout || "").slice(0, 400)}`);
  } else {
    ok("probe compiled with the same --compile flag the shipped engine uses");
    const dbPath = join(work, "probe_kb_graph.duckdb");
    const seed = await KbGraphStore.open(dbPath); // create + migrate from source, the way a pack's db was authored
    seed.close();
    // cwd = the repo, because the compiled engine resolves duckdb's native binding out of node_modules the
    // same way in the packaged tree (resources/repo/node_modules). LUCID_RESOURCES is cleared on purpose so
    // this exercises the execPath fallback, which is the branch the shipped Windows engine actually took.
    const run = spawnSync(exe, [dbPath], { encoding: "utf8", cwd: REPO, env: { ...process.env, LUCID_RESOURCES: "" } });
    const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    const migLine = out.match(/MIGRATIONS=(.*)/)?.[1]?.trim() ?? "";
    // A MISSING line must FAIL, never pass by matching nothing (ADR-0303: the vacuous-green trap).
    check(migLine.length > 0 && !/~BUN|bunfs/.test(migLine), `the compiled binary resolves a NON-virtual migrations path (${migLine || "no MIGRATIONS line printed"})`);
    check(/MIGRATIONS_EXISTS=true/.test(out), "that path exists on disk");
    check(/OPENED=true/.test(out), "the compiled binary OPENS the KG store (the exact step that rejected the bought pack)");
    if (!/OPENED=true/.test(out)) console.error(`    probe output: ${out.slice(0, 600)}`);
    try { rmSync(exe, { force: true }); } catch { /* ignore */ }
  }
} finally {
  try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log("\n[3] the picker no longer demands that the user unzip and guess");
const dir = mkdtempSync(join(tmpdir(), "kgpack7b-"));
try {
  const packDir = join(dir, "senior-proposal-manager.lkgpack");
  mkdirSync(packDir, { recursive: true });
  writeFileSync(join(packDir, "manifest.json"), "{}");
  writeFileSync(join(dir, "senior-proposal-manager.lkgpack.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]));
  writeFileSync(join(dir, "notes.txt"), "not a pack");

  const asDir = classifyPackInput(packDir);
  check(asDir.kind === "dir" && asDir.packDir === packDir, "an unzipped .lkgpack folder still imports (unchanged)");
  const asManifest = classifyPackInput(join(packDir, "manifest.json"));
  check(asManifest.kind === "dir" && asManifest.packDir === packDir, "picking manifest.json inside an unzipped pack resolves to its folder");
  const asZip = classifyPackInput(join(dir, "senior-proposal-manager.lkgpack.zip"));
  check(asZip.kind === "zip", "the DOWNLOADED .lkgpack.zip is accepted directly, no unzip step");
  const asJunk = classifyPackInput(join(dir, "notes.txt"));
  check(asJunk.kind === "reject" && /zip/i.test(asJunk.kind === "reject" ? asJunk.reason : ""), "anything else is refused with copy that names what to pick");
  const missing = classifyPackInput(join(dir, "nope.zip"));
  check(missing.kind === "reject", "a path that does not exist is refused, not opened");
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0 ? "\ndemo-P-KGPACK.7 OK\n" : `\ndemo-P-KGPACK.7 FAILED (${failures})\n`);
process.exit(failures === 0 ? 0 : 1);
