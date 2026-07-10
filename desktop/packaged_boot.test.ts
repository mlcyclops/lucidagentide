// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/packaged_boot.test.ts — ADR-0177/0178: the packaged app must BOOT and its lazily-imported
// feature deps must LOAD under the packaging filter.
//
// Two shipped bricks taught two lessons:
//   v1.10.2: "!node_modules/**/*.md" stripped omp's prompt files; dev.ts newly imported
//            @oh-my-pi/pi-coding-agent at BOOT → the engine died before binding its port.
//   v1.10.3: the boot was saved by making that import lazy - but "!node_modules/@opentelemetry/**"
//            still broke the SAME import chain, so skill discovery shipped broken-but-QUIET.
// A first guard emulated exclusions with a Bun resolver plugin - which turned out NOT to intercept
// bare package specifiers (plugins see extension-routed loads, not node_modules bare resolution),
// so the package-subtree half of the filter was silently unenforced.
//
// This version is honest: it MATERIALIZES a filtered installation in a temp dir -
//   - every kept node_modules package is linked in (junction/symlink; excluded packages are ABSENT),
//   - the in-process-imported @oh-my-pi packages are hardlink-copied and the filter's file-type
//     exclusions (*.md, *.map, *.d.ts) are ACTUALLY DELETED from the copy,
//   - the repo source files ship like extraResources ships them -
// then boots the REAL dev.ts from that tree and requires /api/health, and separately requires every
// lazily-imported feature dep to load. Filter/import collisions fail CI instead of bricking users.
// (Known boundary: file-type exclusions are materialized inside @oh-my-pi only - the packages this
// codebase imports in-process; named package exclusions are enforced everywhere.)

import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { copyFileSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");

interface ResourceEntry { to?: string; filter?: string[] }
function nodeModulesExclusions(): string[] {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8")) as { build?: { extraResources?: ResourceEntry[] } };
  const repo = (pkg.build?.extraResources ?? []).find((r) => r?.to === "repo");
  return (repo?.filter ?? []).filter((f) => f.startsWith("!node_modules"));
}
const SUFFIXES = (ex: string[]) => ex.map((e) => /^!node_modules\/\*\*\/\*(\.[a-z.]+)$/.exec(e)?.[1]).filter((s): s is string => !!s);
const SUBTREES = (ex: string[]) => ex.map((e) => /^!node_modules\/([^*]+?)\/?\*\*$/.exec(e)?.[1]).filter((s): s is string => !!s);

/** Hardlink a tree (falls back to copy across filesystems), skipping files with excluded suffixes -
 *  i.e. the packaging filter's file-type stripping, applied FOR REAL. */
function linkTreeFiltered(src: string, dst: string, dropSuffixes: string[]): void {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, e.name), d = join(dst, e.name);
    if (e.isDirectory()) linkTreeFiltered(s, d, dropSuffixes);
    else if (e.isFile() && !dropSuffixes.some((suf) => e.name.endsWith(suf))) {
      try { linkSync(s, d); } catch { copyFileSync(s, d); }
    }
  }
}

const linkDir = (target: string, path: string): void => symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");

/** Copy the desktop repo sources the way the `to:"repo"` extraResources filter ships them: EVERY
 *  `desktop/**\/*.ts` (any depth), the whole `desktop/renderer/**`, and desktop/package.json - so a new
 *  desktop subdir the engine imports (v1.11.0 shipped `desktop/collab` and the filter's `desktop/*.ts` was
 *  depth-1 only, bricking boot) is present in the sim exactly as in the real package. Skips build-output. */
function copyDesktopSources(srcRoot: string, dstRoot: string, rel = ""): void {
  for (const e of readdirSync(join(srcRoot, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!rel && (e.name === "node_modules" || e.name === "release" || e.name === "dist")) continue;
      copyDesktopSources(srcRoot, dstRoot, r);
    } else if (e.isFile() && (e.name.endsWith(".ts") || r === "package.json" || r.startsWith("renderer/"))) {
      mkdirSync(join(dstRoot, rel), { recursive: true });
      cpSync(join(srcRoot, r), join(dstRoot, r));
    }
  }
}

/** Materialize the filtered install: repo sources + node_modules with the LIVE exclusions applied. */
function buildFilteredInstall(): string {
  const exclusions = nodeModulesExclusions();
  const suffixes = SUFFIXES(exclusions);
  const subtrees = new Set(SUBTREES(exclusions).map((t) => t.replace(/\/$/, "")));
  const sim = mkdtempSync(join(tmpdir(), "lucid-pkg-guard-"));

  // Repo sources, the way extraResources ships them (the subset the engine needs to boot).
  cpSync(join(REPO, "package.json"), join(sim, "package.json"));
  copyDesktopSources(join(REPO, "desktop"), join(sim, "desktop")); // desktop/**/*.ts + renderer/** + package.json
  for (const top of ["harness", "tools"]) cpSync(join(REPO, top), join(sim, top), { recursive: true });
  if (existsSync(join(REPO, "bin"))) cpSync(join(REPO, "bin"), join(sim, "bin"), { recursive: true });

  // node_modules: excluded packages are ABSENT; @oh-my-pi (imported in-process) is materialized
  // with the file-type exclusions really deleted; everything else links to the real install.
  const srcNM = join(REPO, "node_modules"), dstNM = join(sim, "node_modules");
  mkdirSync(dstNM);
  for (const e of readdirSync(srcNM, { withFileTypes: true })) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (subtrees.has(e.name)) continue; // e.g. .bin, onnxruntime-node, date-fns, @opentelemetry (whole scope)
    const src = join(srcNM, e.name), dst = join(dstNM, e.name);
    if (e.name.startsWith("@")) {
      mkdirSync(dst);
      for (const m of readdirSync(src, { withFileTypes: true })) {
        const full = `${e.name}/${m.name}`;
        if (subtrees.has(full)) continue;
        if (e.name === "@oh-my-pi") linkTreeFiltered(join(src, m.name), join(dst, m.name), suffixes);
        else linkDir(join(src, m.name), join(dst, m.name));
      }
    } else {
      linkDir(src, dst);
    }
  }
  return sim;
}

const SIM = buildFilteredInstall();
afterAll(() => { try { rmSync(SIM, { recursive: true, force: true }); } catch { /* temp dir; best-effort */ } });

async function runInSim(args: string[], waitPort?: number): Promise<{ ok: boolean; out: string; exit: number | null }> {
  const child = spawn(process.execPath, args, { cwd: SIM, env: { ...process.env, ...(waitPort ? { PORT: String(waitPort) } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout?.on("data", (d) => { out += String(d); });
  child.stderr?.on("data", (d) => { out += String(d); });
  if (waitPort) {
    try {
      const deadline = Date.now() + 30_000;
      let up = false;
      while (Date.now() < deadline && !up && child.exitCode === null) {
        try { up = (await fetch(`http://localhost:${waitPort}/api/health`)).ok; }
        catch { await new Promise((r) => setTimeout(r, 300)); }
      }
      return { ok: up, out, exit: child.exitCode };
    } finally { try { child.kill(); } catch { /* gone */ } }
  }
  const exit = await new Promise<number | null>((res) => child.on("close", res));
  return { ok: exit === 0, out, exit };
}

test("the engine boots from a REAL filtered install (packaging exclusions materialized)", async () => {
  const port = 5400 + Math.floor(Math.random() * 400);
  const r = await runInSim(["desktop/dev.ts"], port);
  if (!r.ok) throw new Error(`engine did not boot from the filtered install (exit=${r.exit}). Output:\n${r.out.slice(-2000)}`);
  expect(r.ok).toBe(true);
}, 90_000);

// Deps that features import LAZILY (so a boot test alone cannot see them). Add every lazily-imported
// node_modules dep here - if packaging strips something it needs, the feature ships broken-but-quiet.
const LAZY_FEATURE_DEPS = [
  "@oh-my-pi/pi-coding-agent", // skills_data.discoverRaw - the Skills directory's discovery
];

test("lazily-imported feature deps load from the filtered install (no broken-but-quiet features)", async () => {
  const probe = LAZY_FEATURE_DEPS.map((d) =>
    `await import(${JSON.stringify(d)}).then(() => console.log("LOADED ${d}")).catch((e) => { console.error("FAILED ${d}:", String(e && e.message).slice(0, 220)); process.exitCode = 1; });`).join("\n");
  const r = await runInSim(["-e", probe]);
  if (!r.ok) throw new Error(`a lazy feature dep cannot load from the filtered install - its feature would ship broken-but-quiet:\n${r.out.slice(-1500)}`);
  expect(r.ok).toBe(true);
}, 90_000);
