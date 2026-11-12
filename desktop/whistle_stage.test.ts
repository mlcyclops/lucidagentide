// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/whistle_stage.test.ts - CREATOR-WHISTLE (ADR-0432): the dev-run staging gate with injected
// fetch + fs. The fail-closed pins are the load-bearing part: a wrong-sized or wrong-hashed download
// lands only as `.part` and is deleted; a verified download is written as `.part` then renamed; a file
// already present AND verified is never re-downloaded; a present but corrupt file is replaced.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { stageWhistleAssets, type WhistleStageIO } from "./whistle_stage.ts";
import type { WhistleAssetSpec } from "./whistle_assets.ts";

const DIR = join("/scratch", "whistle");

function sha256(bytes: Uint8Array): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(bytes);
  return h.digest("hex");
}
function spec(name: WhistleAssetSpec["name"], bytes: Uint8Array): WhistleAssetSpec {
  return { name, url: `https://pins.test/${name}`, sha256: sha256(bytes), bytes: bytes.length };
}
const fill = (n: number, v: number): Uint8Array => new Uint8Array(n).fill(v);

const GLUE = fill(10, 1);
const WASM = fill(20, 2);
const CACT = fill(30, 3);
const SPECS = [spec("needle.js", GLUE), spec("needle.wasm", WASM), spec("whistle.cact", CACT)];

interface FakeFs {
  files: Map<string, Uint8Array>;
  dirs: string[];
  fetched: string[];
  removed: string[];
  renamed: Array<[string, string]>;
  io: WhistleStageIO;
}

/** In-memory fs + a fetch that serves `served` by URL (anything else -> 404). */
function fakeFs(served: Record<string, Uint8Array | number>, seed: Record<string, Uint8Array> = {}): FakeFs {
  const files = new Map<string, Uint8Array>(Object.entries(seed));
  const f: FakeFs = { files, dirs: [], fetched: [], removed: [], renamed: [], io: {} };
  // Cast reason: the stub ignores fetch's overloads (init unused); structurally it serves the one call
  // shape stageWhistleAssets makes, and inference cannot unify a one-arg async fn with fetch.
  const fetchImpl = (async (url: string) => {
    f.fetched.push(url);
    const body = served[url];
    if (body === undefined) return new Response("missing", { status: 404 });
    if (typeof body === "number") return new Response("down", { status: body });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  f.io = {
    fetchImpl,
    exists: (p) => files.has(p),
    readFile: (p) => {
      const b = files.get(p);
      if (!b) throw new Error(`ENOENT ${p}`);
      return b;
    },
    writeFile: (p, b) => { files.set(p, b); },
    rename: (from, to) => {
      const b = files.get(from);
      if (!b) throw new Error(`ENOENT ${from}`);
      files.delete(from);
      files.set(to, b);
      f.renamed.push([from, to]);
    },
    remove: (p) => { files.delete(p); f.removed.push(p); },
    mkdir: (d) => { f.dirs.push(d); },
  };
  return f;
}
const url = (name: string): string => `https://pins.test/${name}`;

describe("stageWhistleAssets", () => {
  test("downloads all three, writes .part then renames, nothing else left behind", async () => {
    const f = fakeFs({ [url("needle.js")]: GLUE, [url("needle.wasm")]: WASM, [url("whistle.cact")]: CACT });
    const r = await stageWhistleAssets(f.io, DIR, SPECS);
    expect(r).toEqual({ ok: true, dir: DIR, staged: ["needle.js", "needle.wasm", "whistle.cact"] });
    expect(f.dirs).toEqual([DIR]);
    expect([...f.files.keys()].sort()).toEqual(SPECS.map((s) => join(DIR, s.name)).sort());
    expect(f.renamed).toEqual(SPECS.map((s) => [join(DIR, `${s.name}.part`), join(DIR, s.name)]));
    expect(f.files.get(join(DIR, "whistle.cact"))).toEqual(CACT);
  });

  test("a present and verified file is skipped, the rest are fetched", async () => {
    const f = fakeFs({ [url("needle.js")]: GLUE, [url("whistle.cact")]: CACT }, { [join(DIR, "needle.wasm")]: WASM });
    const r = await stageWhistleAssets(f.io, DIR, SPECS);
    expect(r).toEqual({ ok: true, dir: DIR, staged: ["needle.js", "whistle.cact"] });
    expect(f.fetched).toEqual([url("needle.js"), url("whistle.cact")]);
  });

  test("a present but corrupt file is replaced, not trusted", async () => {
    const f = fakeFs({ [url("needle.js")]: GLUE, [url("needle.wasm")]: WASM, [url("whistle.cact")]: CACT }, { [join(DIR, "whistle.cact")]: fill(30, 9) });
    const r = await stageWhistleAssets(f.io, DIR, SPECS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.staged).toContain("whistle.cact");
    expect(f.files.get(join(DIR, "whistle.cact"))).toEqual(CACT);
  });

  test("a size mismatch is refused by name before hashing and the .part is deleted", async () => {
    const f = fakeFs({ [url("needle.js")]: GLUE, [url("needle.wasm")]: fill(19, 2), [url("whistle.cact")]: CACT });
    const r = await stageWhistleAssets(f.io, DIR, SPECS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("needle.wasm");
      expect(r.reason).toContain("size mismatch");
    }
    expect(f.removed).toEqual([join(DIR, "needle.wasm.part")]);
    expect([...f.files.keys()]).toEqual([join(DIR, "needle.js")]);
    // Stops at the first failure: the model was never fetched.
    expect(f.fetched).toEqual([url("needle.js"), url("needle.wasm")]);
  });

  test("a right-sized wrong-content download fails the hash gate and keeps no .part", async () => {
    const f = fakeFs({ [url("needle.js")]: GLUE, [url("needle.wasm")]: WASM, [url("whistle.cact")]: fill(30, 7) });
    const r = await stageWhistleAssets(f.io, DIR, SPECS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("whistle.cact");
      expect(r.reason).toContain("sha256 mismatch");
      expect(r.reason).toContain(SPECS[2].sha256.slice(0, 12));
    }
    expect(f.files.has(join(DIR, "whistle.cact.part"))).toBe(false);
    expect(f.files.has(join(DIR, "whistle.cact"))).toBe(false);
  });

  test("an HTTP failure reports the status by name and writes nothing for that asset", async () => {
    const f = fakeFs({ [url("needle.js")]: 503 });
    const r = await stageWhistleAssets(f.io, DIR, SPECS);
    expect(r).toEqual({ ok: false, reason: "needle.js: download failed (HTTP 503)" });
    expect(f.files.size).toBe(0);
  });

  test("a throwing fetch is reported, not thrown", async () => {
    const io: WhistleStageIO = {
      ...fakeFs({}).io,
      fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch,
    };
    const r = await stageWhistleAssets(io, DIR, SPECS);
    expect(r).toEqual({ ok: false, reason: "needle.js: download failed: offline" });
  });

  test("a mkdir failure is reported with the dir", async () => {
    const io: WhistleStageIO = { ...fakeFs({}).io, mkdir: () => { throw new Error("EACCES"); } };
    const r = await stageWhistleAssets(io, DIR, SPECS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(DIR);
  });
});
