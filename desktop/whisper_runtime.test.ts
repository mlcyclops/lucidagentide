// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// The managed-Whisper lifecycle (whisper_runtime.ts): status, install, start (resolve bin -> ensure model ->
// spawn -> health -> wire STT), stop. All side effects injected, so every branch is exercised with no binary
// or network.

import { afterEach, describe, expect, it } from "bun:test";
import { installWhisper, startWhisper, stopWhisper, whisperStatus, whisperInstallState, type WhisperRuntimeDeps } from "./whisper_runtime.ts";
import type { MachineSpecs } from "./whisper_capability.ts";

const MAC8: MachineSpecs = { arch: "arm64", platform: "darwin", totalRamGB: 8, cpuCores: 10, accel: "metal" };

function deps(over: Partial<WhisperRuntimeDeps> = {}): WhisperRuntimeDeps {
  return {
    specs: () => MAC8,
    modelDir: "/models",
    listModels: () => [],
    resolveBin: () => ({ path: "/bin/whisper-server", source: "path" }),
    download: async () => ({ ok: true, path: "/models/x.bin", bytes: 200 * 1024 * 1024 }),
    spawn: () => ({ pid: 4242, kill: () => {} }),
    health: async () => true,
    setSttUrl: () => {},
    sleep: async () => {},
    ...over,
  };
}

afterEach(async () => { await stopWhisper(); });

describe("whisperStatus", () => {
  it("reports capability, binary availability, and which tiers are installed", () => {
    const s = whisperStatus(deps({ listModels: () => ["ggml-small.en.bin"] }));
    expect(s.capable).toBe(true);
    expect(s.binAvailable).toBe(true);
    expect(s.tiers.find((t) => t.tier === "small")!.installed).toBe(true);
    expect(s.tiers.find((t) => t.tier === "base")!.installed).toBe(false);
    expect(s.running).toBe(false);
  });
  it("flags a missing binary with an actionable hint", () => {
    const s = whisperStatus(deps({ resolveBin: () => null }));
    expect(s.binAvailable).toBe(false);
    expect(s.binHint).toMatch(/LUCID_WHISPER_BIN|bundle/);
  });
});

describe("startWhisper", () => {
  it("downloads a missing model, spawns, health-checks, wires STT, and reports running", async () => {
    const events: string[] = [];
    let sttUrl = "";
    const d = deps({
      listModels: () => [], // nothing on disk -> must download
      download: async () => { events.push("download"); return { ok: true, path: "/models/m.bin", bytes: 1 }; },
      spawn: () => { events.push("spawn"); return { pid: 1, kill: () => events.push("kill") }; },
      setSttUrl: (u) => { sttUrl = u; },
    });
    const r = await startWhisper(d, { tier: "base", port: 9123 });
    expect(r.ok).toBe(true);
    expect(events).toEqual(["download", "spawn"]);
    expect(sttUrl).toBe("http://127.0.0.1:9123");
    expect(whisperStatus(d).running).toBe(true);
    expect(whisperStatus(d).serveUrl).toBe("http://127.0.0.1:9123");
  });

  it("skips the download when the model is already present", async () => {
    let downloaded = false;
    const d = deps({ listModels: () => ["ggml-base.en.bin"], download: async () => { downloaded = true; return { ok: true, path: "x", bytes: 1 }; } });
    const r = await startWhisper(d, { tier: "base" });
    expect(r.ok).toBe(true);
    expect(downloaded).toBe(false);
  });

  it("fails fast with a hint when no binary is available (no spawn)", async () => {
    let spawned = false;
    const r = await startWhisper(deps({ resolveBin: () => null, spawn: () => { spawned = true; return { pid: 0, kill: () => {} }; } }));
    expect(r.ok).toBe(false);
    expect(spawned).toBe(false);
    expect(r.reason).toMatch(/LUCID_WHISPER_BIN|bundle/);
  });

  it("refuses on an incapable machine", async () => {
    const r = await startWhisper(deps({ specs: () => ({ ...MAC8, totalRamGB: 1 }) }));
    expect(r.ok).toBe(false);
  });

  it("stops + fails when the server never becomes healthy", async () => {
    let killed = false;
    const r = await startWhisper(deps({ health: async () => false, listModels: () => ["ggml-base.en.bin"], spawn: () => ({ pid: 9, kill: () => { killed = true; } }) }), { tier: "base" });
    expect(r.ok).toBe(false);
    expect(killed).toBe(true);
  });
});

describe("installWhisper", () => {
  it("downloads the recommended tier and reports it", async () => {
    let dl = false;
    const r = await installWhisper(deps({ download: async () => { dl = true; return { ok: true, path: "x", bytes: 1 }; } }), undefined, () => {});
    expect(r.ok).toBe(true);
    expect(r.tier).toBe("small"); // 8GB recommendation
    expect(dl).toBe(true);
  });
  it("is a no-op when already installed", async () => {
    let dl = false;
    const r = await installWhisper(deps({ listModels: () => ["ggml-small.en.bin"], download: async () => { dl = true; return { ok: true, path: "x", bytes: 1 }; } }), "small", () => {});
    expect(r.ok).toBe(true);
    expect(dl).toBe(false);
  });
});

// P-STT.2d: the live progress the no-code Voice card polls during a download (whisperInstallState()).
describe("whisperInstallState (download progress)", () => {
  it("tracks downloading -> starting -> done through a successful start", async () => {
    const seen: Array<{ phase: string; fraction: number }> = [];
    const d = deps({
      listModels: () => [], // force a download
      download: async (_m, _dest, onP) => { onP(0.25); seen.push({ ...whisperInstallState() }); onP(0.75); seen.push({ ...whisperInstallState() }); return { ok: true, path: "x", bytes: 1 }; },
    });
    const r = await startWhisper(d, { tier: "base", port: 9124 });
    expect(r.ok).toBe(true);
    expect(seen.map((s) => s.phase)).toEqual(["downloading", "downloading"]);
    expect(seen.map((s) => s.fraction)).toEqual([0.25, 0.75]);
    const end = whisperInstallState();
    expect(end.active).toBe(false);
    expect(end.phase).toBe("done");
    expect(end.fraction).toBe(1);
    expect(whisperStatus(d).install.phase).toBe("done");
  });

  it("marks phase=error (active false) with the reason when the download fails", async () => {
    const d = deps({ listModels: () => [], download: async () => ({ ok: false, reason: "network down" }) });
    const r = await startWhisper(d, { tier: "base" });
    expect(r.ok).toBe(false);
    const st = whisperInstallState();
    expect(st.active).toBe(false);
    expect(st.phase).toBe("error");
    expect(st.reason).toBe("network down");
  });

  it("goes straight to starting (no download) when the model is already present", async () => {
    const phases: string[] = [];
    const d = deps({ listModels: () => ["ggml-base.en.bin"], spawn: () => { phases.push(whisperInstallState().phase); return { pid: 1, kill: () => {} }; } });
    await startWhisper(d, { tier: "base", port: 9125 });
    expect(phases).toEqual(["starting"]); // set before spawn, never downloading
    expect(whisperInstallState().phase).toBe("done");
  });

  it("installWhisper alone reports downloading and still fires the caller's onProgress", async () => {
    const fr: number[] = [];
    const d = deps({ listModels: () => [], download: async (_m, _dest, onP) => { onP(0.5); return { ok: true, path: "x", bytes: 1 }; } });
    const r = await installWhisper(d, "base", (f) => fr.push(f));
    expect(r.ok).toBe(true);
    expect(fr).toEqual([0.5]);
    expect(whisperInstallState().phase).toBe("done");
  });
});
