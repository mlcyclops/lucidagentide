// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/lane_runtime.ts - P-HOLDER.2 (ADR-0574): held lanes run from a copy of the runtime, one per app version,
// outside the install folder.
//
// A held lane (lane_holder.ts) outlives the IDE on purpose. Its processes (lucid-holder, omp, bun, the Python the
// scanner runs) used to run from the install folder, so while any held lane was alive an update could not replace
// those files: the install-on-close watcher waited forever and an NSIS install would fail on the locked files. Now
// the engine copies what a held lane executes into `<data root>/lane-runtime/<key>/` (same layout as `resources/`:
// `repo/` without the big binaries in `repo/bin` except the holder, `runtimes/bun`, `runtimes/python-<os>-<arch>`),
// and a held lane's command, arguments and environment are pointed at that copy. An update then replaces the install
// folder while those lanes keep running on the copy they started from; a lane picks up the new version when it is
// started again.
//
// The key names the build (the repo's version and the size and time of the files a lane runs), so two builds with the
// same version number (a local build and the CI one) get their own copies. The copy is made once per key, in the
// background when the engine starts, written under a partial name and renamed when complete. A copy is deleted only
// when it is not the current one and no held lane's record names it (deleting files under a running lane would break
// it). Only a packaged install has one: in a source checkout lanes run from the checkout, as before.
//
// Rewriting is by prefix and only to paths that exist in the copy: anything the copy does not carry (the IDE's own
// big binaries in repo/bin, which an agent runs only briefly) keeps its install path.
//
// P-HOLDER.3 (ADR-0606): omp's Python kernel (the eval tool) picks its interpreter itself, and without a venv of the
// lane's own it took omp's managed ~/.omp/python-env, a venv that may be built on the install folder's Python, so a
// held lane's kernel still pinned the install folder (issue #633). Each copy therefore carries `lane-python.yml`, an
// omp settings overlay naming the copy's interpreter (`python.interpreter`), and a held lane's PI_CONFIG_FILES lists
// it. The bundled Python needs no packages for omp's runner, so no venv is built.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, join, sep } from "node:path";
import { resolvedRepo } from "./repo_root.ts";

const COMPLETE = ".complete";
/** P-HOLDER.3 (ADR-0606): the omp settings overlay in a copy that names the copy's Python as omp's interpreter. */
export const PYTHON_OVERLAY = "lane-python.yml";

/** The overlay body: omp's `python.interpreter` set to `python`. The path is a JSON string, which YAML reads as a
 *  double-quoted scalar with the same escapes, so a Windows path's backslashes survive. */
export function pythonOverlayYaml(python: string): string {
  return `# Written by LUCID with this lane runtime copy (P-HOLDER.3). Held lanes' Python kernels run on the copy.\npython:\n  interpreter: ${JSON.stringify(python)}\n`;
}
/** How many files are copied at once. */
const COPY_PARALLEL = 16;

export interface LaneRuntimeOptions {
  /** The install's `resources` folder (holds `repo/` and `runtimes/`). */
  resources: string;
  /** Where the copies live: `<data root>/lane-runtime`. */
  root: string;
  platform?: NodeJS.Platform;
  arch?: string;
  log?: (line: string) => void;
}

/** The install's `resources` folder when this engine runs from a packaged install (`<resources>/repo` is its repo
 *  and `<resources>/runtimes` exists), else null (a source checkout: lanes run from it as before). */
export function installResources(repo: string = resolvedRepo().root): string | null {
  if (basename(repo).toLowerCase() !== "repo") return null;
  const resources = dirname(repo);
  return basename(resources).toLowerCase() === "resources" && existsSync(join(resources, "runtimes")) ? resources : null;
}

export class LaneRuntime {
  readonly resources: string;
  readonly root: string;
  readonly key: string;
  readonly #platform: NodeJS.Platform;
  readonly #arch: string;
  readonly #log: (line: string) => void;
  #ready: Promise<string | null> | null = null;

  constructor(o: LaneRuntimeOptions) {
    this.resources = o.resources;
    this.root = o.root;
    this.#platform = o.platform ?? process.platform;
    this.#arch = o.arch ?? process.arch;
    this.#log = o.log ?? ((l) => console.log(l));
    this.key = this.#computeKey();
  }

  /** The runtime for this engine, or null when it does not run from a packaged install, has no data root, or
   *  LUCID_LANE_RUNTIME=install keeps held lanes on the install folder. */
  static forEngine(env: Record<string, string | undefined> = process.env): LaneRuntime | null {
    if (env.LUCID_LANE_RUNTIME === "install" || !env.LUCID_DATA_ROOT) return null;
    const resources = installResources();
    return resources ? new LaneRuntime({ resources, root: join(env.LUCID_DATA_ROOT, "lane-runtime") }) : null;
  }

  get dir(): string { return join(this.root, this.key); }

  /** The executable suffix of the platform the copy is for (used by the plan, the key and the holder lookup). */
  get #exe(): string { return this.#platform === "win32" ? ".exe" : ""; }

  /** What a held lane runs, relative to `resources`: the directory trees and single files the copy carries. */
  #plan(): { dirs: string[]; files: string[] } {
    return {
      dirs: ["repo", this.#pythonDir],
      files: [join("runtimes", `bun${this.#exe}`)],
    };
  }

  /** The bundled Python tree, relative to `resources`. */
  get #pythonDir(): string { return join("runtimes", `python-${this.#platform}-${this.#arch}`); }

  /** Where the bundled Python's interpreter may sit, relative to `resources`, best first (desktop/runtime.ts
   *  bundledPython looks in the same places). */
  #pythonRels(): string[] {
    return this.#platform === "win32" ? [join(this.#pythonDir, "python.exe")]
      : ["python3", "python3.12", "python"].map((n) => join(this.#pythonDir, "bin", n));
  }

  /** Under `repo/bin` only the holder is copied: the rest are the IDE's own binaries (hundreds of MB). */
  #skip(rel: string): boolean {
    const bin = `repo${sep}bin${sep}`;
    return rel.startsWith(bin) && rel !== `${bin}lucid-holder${this.#exe}`;
  }

  #computeKey(): string {
    // The app's version is the desktop package's (the repo root's package.json says 0.0.0).
    let version = "0";
    for (const rel of [join("repo", "desktop", "package.json"), join("repo", "package.json")]) {
      try {
        const pkg: unknown = JSON.parse(readFileSync(join(this.resources, rel), "utf8"));
        if (pkg && typeof pkg === "object" && "version" in pkg && typeof pkg.version === "string") { version = pkg.version; break; }
      } catch { /* not this one */ }
    }
    const h = createHash("sha256").update(this.resources.toLowerCase());
    for (const rel of [join("repo", "package.json"), join("repo", "bin", `lucid-holder${this.#exe}`), join("repo", "node_modules", ".bin", `omp${this.#exe}`), join("runtimes", `bun${this.#exe}`), join("repo", "harness", "omp", "security_extension.ts")]) {
      try { const s = statSync(join(this.resources, rel)); h.update(`${rel}:${s.size}:${Math.round(s.mtimeMs)}\n`); } catch { h.update(`${rel}:-\n`); }
    }
    return `${version.replace(/[^A-Za-z0-9.+-]/g, "_")}-${h.digest("hex").slice(0, 10)}`;
  }

  /** The copy's folder once it is complete (made now when missing; one copy at a time), or null when it could not
   *  be made (the lane then runs from the install folder, as before, and says so in the log). */
  prepare(): Promise<string | null> {
    if (!this.#ready) this.#ready = this.#make().catch((e) => {
      this.#log(`[fleet] lane runtime copy failed, held lanes run from the install folder: ${e instanceof Error ? e.message : String(e)}`);
      this.#ready = null; // tried again by the next lane
      return null;
    });
    return this.#ready;
  }

  async #make(): Promise<string> {
    const dest = this.dir;
    if (existsSync(join(dest, COMPLETE))) return dest;
    await mkdir(this.root, { recursive: true });
    const partial = `${dest}.partial-${process.pid}`;
    await rm(partial, { recursive: true, force: true });
    const started = Date.now();
    const files: string[] = [];
    const { dirs, files: single } = this.#plan();
    for (const d of dirs) if (existsSync(join(this.resources, d))) await this.#walk(d, files);
    for (const f of single) if (existsSync(join(this.resources, f))) files.push(f);
    let bytes = 0;
    for (let i = 0; i < files.length; i += COPY_PARALLEL) {
      await Promise.all(files.slice(i, i + COPY_PARALLEL).map(async (rel) => {
        const to = join(partial, rel);
        await mkdir(dirname(to), { recursive: true });
        await copyFile(join(this.resources, rel), to);
        bytes += (await stat(to)).size;
      }));
    }
    // P-HOLDER.3 (ADR-0606): the omp overlay naming the copy's Python (its final path: the folder is renamed below).
    const python = this.#pythonRels().find((rel) => existsSync(join(partial, rel)));
    if (python) await writeFile(join(partial, PYTHON_OVERLAY), pythonOverlayYaml(join(dest, python)));
    await writeFile(join(partial, COMPLETE), JSON.stringify({ key: this.key, from: this.resources, files: files.length, bytes, at: Date.now() }));
    await rm(dest, { recursive: true, force: true });
    await rename(partial, dest);
    this.#log(`[fleet] lane runtime ${this.key}: ${files.length} files, ${Math.round(bytes / 1048576)} MB copied in ${Math.round((Date.now() - started) / 1000)} s`);
    return dest;
  }

  /** Every file under `rel` the copy carries (links are followed: a linked file is copied as a file). */
  async #walk(rel: string, out: string[]): Promise<void> {
    for (const e of await readdir(join(this.resources, rel), { withFileTypes: true })) {
      const child = join(rel, e.name);
      if (this.#skip(child)) continue;
      let isDir = e.isDirectory(), isFile = e.isFile();
      if (e.isSymbolicLink()) {
        try { const s = await stat(join(this.resources, child)); isDir = s.isDirectory(); isFile = s.isFile(); } catch { continue; }
      }
      if (isDir) await this.#walk(child, out);
      else if (isFile) out.push(child);
    }
  }

  /** `p` in the copy `dir` when it lies under the install's resources and the copy has it, else `p` unchanged. */
  mapPath(p: string, dir: string): string {
    if (!this.#underInstall(p)) return p;
    const to = join(dir, p.slice(this.resources.length + 1));
    return existsSync(to) ? to : p;
  }

  /** A held lane's command, arguments and environment pointed at the copy `dir`: every argument and every entry of
   *  every path-list variable (PATH, LUCID_BUN_BIN, SCANNER_PYTHON...) that names something the copy has.
   *  P-HOLDER.3 (ADR-0606): and omp's Python kernel too. Unless the lane's own venv in `cwd` (or VIRTUAL_ENV /
   *  CONDA_PREFIX) would be picked first, omp would fall back to its managed ~/.omp/python-env, a venv that may be
   *  built on the install folder's Python; so the copy's overlay naming the copy's interpreter is appended to
   *  PI_CONFIG_FILES (omp loads every file listed there as a `--config` overlay). */
  map(dir: string, cmd: string, args: string[], env: Record<string, string | undefined>, cwd: string): { cmd: string; args: string[]; env: Record<string, string | undefined> } {
    const out: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) out[k] = v === undefined ? v : v.split(delimiter).map((s) => this.mapPath(s, dir)).join(delimiter);
    const overlay = join(dir, PYTHON_OVERLAY);
    if (existsSync(overlay) && !this.#ownVenv(cwd, out)) out.PI_CONFIG_FILES = out.PI_CONFIG_FILES ? `${out.PI_CONFIG_FILES}${delimiter}${overlay}` : overlay;
    return { cmd: this.mapPath(cmd, dir), args: args.map((a) => this.mapPath(a, dir)), env: out };
  }

  /** True when omp would run its kernel on a venv of the lane's own that does not live on the install folder's
   *  Python. omp's order (eval/py/runtime.ts enumeratePythonRuntimes): VIRTUAL_ENV, then CONDA_PREFIX, then
   *  `<cwd>/.venv`, then `<cwd>/venv`, used when its Scripts/python.exe (bin/python) exists. A venv whose
   *  pyvenv.cfg `home` is under the install folder pins it like the managed one, so it does not count. */
  #ownVenv(cwd: string, env: Record<string, string | undefined>): boolean {
    const venv = env.VIRTUAL_ENV || env.CONDA_PREFIX || [join(cwd, ".venv"), join(cwd, "venv")].find((d) => existsSync(d));
    if (!venv) return false;
    const win = this.#platform === "win32";
    if (!existsSync(join(venv, win ? "Scripts" : "bin", win ? "python.exe" : "python"))) return false;
    let home = "";
    try { home = /^\s*home\s*=\s*(.+?)\s*$/m.exec(readFileSync(join(venv, "pyvenv.cfg"), "utf8"))?.[1] ?? ""; } catch { /* no pyvenv.cfg */ }
    return !this.#underInstall(venv) && !this.#underInstall(home);
  }

  /** True when `p` lies under the install's resources folder (case-insensitively on Windows). */
  #underInstall(p: string): boolean {
    const prefix = this.resources + sep;
    return this.#platform === "win32" ? p.toLowerCase().startsWith(prefix.toLowerCase()) : p.startsWith(prefix);
  }

  /** The holder binary in the copy `dir`, or null when it has none. */
  holderIn(dir: string): string | null {
    const p = join(dir, "repo", "bin", `lucid-holder${this.#exe}`);
    return existsSync(p) ? p : null;
  }

  /** Delete every copy that is not the current one and that no held lane uses (`inUse`: the keys held lanes'
   *  records name), and partial copies an earlier engine left. Returns the keys removed. A copy whose files are
   *  still open (a lane this engine did not know of) fails to delete and is tried again at the next start. */
  cleanup(inUse: ReadonlySet<string>): string[] {
    const removed: string[] = [];
    let names: string[] = [];
    try { names = readdirSync(this.root); } catch { return removed; }
    for (const n of names) {
      const partialOf = /^(.+)\.partial-(\d+)$/.exec(n);
      if (partialOf && Number(partialOf[2]) === process.pid) continue;
      if (!partialOf && (n === this.key || inUse.has(n))) continue;
      try { rmSync(join(this.root, n), { recursive: true, force: true }); removed.push(n); } catch (e) {
        this.#log(`[fleet] lane runtime ${n} not removed yet: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return removed;
  }
}
