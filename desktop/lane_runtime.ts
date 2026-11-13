// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/lane_runtime.ts - P-HOLDER.2 (ADR-0573): held lanes run from a copy of the runtime, one per app version,
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

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, join, sep } from "node:path";
import { resolvedRepo } from "./repo_root.ts";

const COMPLETE = ".complete";
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
      dirs: ["repo", join("runtimes", `python-${this.#platform}-${this.#arch}`)],
      files: [join("runtimes", `bun${this.#exe}`)],
    };
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
    const prefix = this.resources + sep;
    const win = this.#platform === "win32";
    if (!(win ? p.toLowerCase().startsWith(prefix.toLowerCase()) : p.startsWith(prefix))) return p;
    const to = join(dir, p.slice(prefix.length));
    return existsSync(to) ? to : p;
  }

  /** A held lane's command, arguments and environment pointed at the copy `dir`: every argument and every entry of
   *  every path-list variable (PATH, LUCID_BUN_BIN, SCANNER_PYTHON...) that names something the copy has. */
  map(dir: string, cmd: string, args: string[], env: Record<string, string | undefined>): { cmd: string; args: string[]; env: Record<string, string | undefined> } {
    const out: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) out[k] = v === undefined ? v : v.split(delimiter).map((s) => this.mapPath(s, dir)).join(delimiter);
    return { cmd: this.mapPath(cmd, dir), args: args.map((a) => this.mapPath(a, dir)), env: out };
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
