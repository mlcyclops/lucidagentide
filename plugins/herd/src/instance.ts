// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0535): a hub INSTANCE and the files it owns. Every one of them lives under the add-on's
// data dir (LUCID_PLUGIN_DATA when the IDE's plugin runtime or `lucid herd` starts Herd), never beside
// the classic hub's files:
//
//   hub-<name>-spaces.json            the layout (+ .bak, the write before it)       ADR-0490 items 4, 5
//   hub-snapshots/<name>/             the last SNAPSHOTS_KEPT layout writes           ADR-0490 item 5
//   hub-<name>-agent-priorities.json  the AGENTS panel's display order                ADR-0490 item 4
//   run/<name>/hub-discovery-<pid>.json  the control server's discovery file (0600)   ADR-0490 item 6
//   hub-<name>-server.log             a detached server's output (0600)
//
// One discovery folder per instance means the core control client (hub_control.ts connectHub) finds
// exactly that instance's server, through the same nonce handshake, with no name in the file format.
// The classic `hub-spaces.json` is only READ, once, to seed instance `main` when it has nothing yet.
//
// Pure apart from the file reads and writes it names; no Bun-only API, so the Node-side runtime host
// (runtime_host.ts) can use it too.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pluginDataDir } from "../../../desktop/plugins/installed.ts";
import { connectHub, type HubDiscovery } from "../../../harness/launcher/hub_control.ts";
import { HubOpError, loadSpaces, Spaces, spacesPath } from "../../../harness/launcher/hub_spaces.ts";

export const HERD_ID = "herd";
export const DEFAULT_INSTANCE = "main";
/** An instance name lands in file and folder names, so it is lowercase letters, digits, `-` and `_`,
 *  1-32, starting alphanumeric: no path separator, no dot, and no two names that a case-blind file
 *  system (Windows, macOS) folds together. */
export const INSTANCE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

type Env = Readonly<Record<string, string | undefined>>;

/** The instance name, or HubOpError("bad_name"). Undefined is the default instance. */
export function instanceName(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_INSTANCE;
  if (!INSTANCE_NAME_RE.test(raw)) throw new HubOpError("bad_name", `an instance name is 1-32 of a-z 0-9 - _, starting with a letter or digit (got "${raw}")`);
  return raw;
}

/** The add-on's data dir: the runtime's (or `lucid herd`'s) LUCID_PLUGIN_DATA, else the same folder
 *  the IDE gives the installed plugin. */
export function herdDataDir(env: Env): string {
  return env.LUCID_PLUGIN_DATA || pluginDataDir(HERD_ID);
}

export interface InstancePaths { name: string; spaces: string; priorities: string; snapshots: string; run: string; log: string }

export function instancePaths(data: string, name: string): InstancePaths {
  return {
    name,
    spaces: join(data, `hub-${name}-spaces.json`),
    priorities: join(data, `hub-${name}-agent-priorities.json`),
    snapshots: join(data, "hub-snapshots", name),
    run: join(data, "run", name),
    log: join(data, `hub-${name}-server.log`),
  };
}

/** The newest server of instance `name` that wins the nonce handshake, or null. */
export async function connectInstance(data: string, name: string, fetchImpl: typeof fetch = fetch): Promise<HubDiscovery | null> {
  return connectHub(instancePaths(data, name).run, fetchImpl);
}

/** `lucid herd server list`: every instance with a verified server, by name. */
export async function liveInstances(data: string, fetchImpl: typeof fetch = fetch): Promise<{ name: string; pid: number; port: number }[]> {
  let names: string[];
  try { names = readdirSync(join(data, "run")); } catch { return []; }
  const out: { name: string; pid: number; port: number }[] = [];
  for (const name of names.filter((n) => INSTANCE_NAME_RE.test(n)).sort()) {
    const d = await connectInstance(data, name, fetchImpl);
    if (d) out.push({ name, pid: d.pid, port: d.port });
  }
  return out;
}

export const SNAPSHOTS_KEPT = 10;
const SNAPSHOT_RE = /^\d{13}-\d{6}\.json$/;

/** tmp + rename, 0600: a crash mid-write leaves the previous file, never a torn one. */
export function writeAtomic(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, path);
}

/** The layout file of one instance with its durability (ADR-0490 item 5): every write that changes
 *  the layout also lands as a snapshot (the newest SNAPSHOTS_KEPT are kept) and the write before it
 *  as `<file>.bak`. A layout file that is there but off-shape (truncated, NUL-filled, hand-edited
 *  wrong) restores from the newest snapshot that parses, then the .bak; a MISSING file is a fresh
 *  instance, not a failure. */
export class LayoutStore {
  #last = "";
  #seq = 0;
  constructor(readonly path: string, readonly snapshots: string) {}

  /** Snapshot names, oldest first (the names sort by write time). */
  #names(): string[] {
    try { return readdirSync(this.snapshots).filter((n) => SNAPSHOT_RE.test(n)).sort(); } catch { return []; }
  }

  /** Never written: no layout file and no snapshot. */
  fresh(): boolean {
    return !existsSync(this.path) && this.#names().length === 0;
  }

  /** `restored` names where the layout came from when the file itself did not parse (null = it did,
   *  or there was nothing to restore). */
  load(isDeck: (deck: string) => boolean): { spaces: Spaces | null; restored: string | null } {
    let raw: string;
    try { raw = readFileSync(this.path, "utf8"); } catch { return { spaces: null, restored: null }; }
    const direct = Spaces.restore(raw, isDeck);
    if (direct) { this.#last = raw; return { spaces: direct, restored: null }; }
    const candidates = [...this.#names().reverse().map((n) => join(this.snapshots, n)), `${this.path}.bak`];
    for (const file of candidates) {
      let body: string;
      try { body = readFileSync(file, "utf8"); } catch { continue; }
      const spaces = Spaces.restore(body, isDeck);
      if (spaces) return { spaces, restored: file };
    }
    return { spaces: null, restored: null };
  }

  /** Write the layout when it changed; never throws (the layout is convenience, never fatal). */
  save(spaces: Spaces): void {
    const body = JSON.stringify(spaces) + "\n";
    if (body === this.#last) return;
    try {
      if (this.#last) writeFileSync(`${this.path}.bak`, this.#last, { mode: 0o600 });
      writeAtomic(this.path, body);
      this.#last = body;
      mkdirSync(this.snapshots, { recursive: true });
      writeFileSync(join(this.snapshots, `${Date.now()}-${String(this.#seq++ % 1_000_000).padStart(6, "0")}.json`), body, { mode: 0o600 });
      const names = this.#names();
      for (const old of names.slice(0, Math.max(0, names.length - SNAPSHOTS_KEPT))) rmSync(join(this.snapshots, old), { force: true });
    } catch { /* a full disk or a read-only data dir costs the layout, never the server */ }
  }
}

/** Instance `main` on its very first start (no layout, no snapshot) begins from the classic hub's
 *  layout in `classicDir`, READ only: the classic file is never moved or written. Null when the
 *  instance has history, is not `main`, or the classic layout is missing or off-shape. */
export function classicSeed(store: LayoutStore, name: string, classicDir: string | null, isDeck: (deck: string) => boolean): Spaces | null {
  if (name !== DEFAULT_INSTANCE || classicDir === null || !store.fresh()) return null;
  return loadSpaces(spacesPath(classicDir), isDeck);
}
