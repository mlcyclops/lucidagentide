// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/creator_pipeline.test.ts - CREATOR-3 (ADR-0287).
//
// The two claims this file exists to defend:
//
//   * A DEAD SCANNER STOPS THE ARTIFACT (invariant 3). Not "logs a warning", not "stores it as suspicious":
//     nothing is written, the job says why, and the bytes never reach the ledger.
//   * A SERVER'S LABEL IS NOT EVIDENCE. The magic bytes decide the type, a contradiction is refused by name,
//     and unidentifiable bytes are refused rather than stored under a guessed extension.
//
// Everything is injected: no server, no disk, no clock.

import { test, expect, describe } from "bun:test";
import { foldArtifacts, type ArtifactIo } from "./creator_image.ts";
import { foldJobs, type JobAdmissionSnapshot, type JobIo } from "./creator_jobs.ts";
import {
  metadataBlock, runRenderPipeline, scanMetadata, trackProgress,
  type ComfyLike, type PipelineDeps, type ProgressFeed, type RenderPipelineInput, type ScanVerdict,
} from "./creator_pipeline.ts";
import type { ComfyOutputRef } from "../harness/creator/comfy_stream.ts";

// ── fixtures ────────────────────────────────────────────────────────────────

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 9, 9, 9, 9, 7, 7, 7, 7]);
const GLB = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 8, 8, 8, 8]);
const NOISE = new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]);

const CLEAN: ScanVerdict = { block: false, reason: "clean", trustLabel: "trusted", failClosed: false };

interface FakeDisk {
  readonly io: ArtifactIo;
  readonly files: Map<string, Uint8Array>;
  readonly text: Map<string, string>;
  readonly lines: string[];
}

function fakeDisk(): FakeDisk {
  const files = new Map<string, Uint8Array>();
  const text = new Map<string, string>();
  const lines: string[] = [];
  let n = 0;
  const io: ArtifactIo = {
    ensureDir: () => {},
    writeBytes: (path, bytes) => { files.set(path, bytes); },
    writeText: (path, body) => { text.set(path, body); },
    appendLine: (_path, line) => { lines.push(line); },
    readText: () => lines.join("\n"),
    now: () => 1_700_000_000_000,
    id: () => `art_${++n}`,
  };
  return { io, files, text, lines };
}

interface FakeJobs {
  readonly io: JobIo;
  readonly lines: string[];
}

function fakeJobs(): FakeJobs {
  const lines: string[] = [];
  let n = 0;
  const io: JobIo = {
    ensureDir: () => {},
    readText: () => lines.join("\n"),
    appendLine: (_path, line) => { lines.push(line); },
    now: () => 1_700_000_000_000,
    id: () => `job_${++n}`,
  };
  return { io, lines };
}

interface FakeServer {
  readonly client: ComfyLike;
  readonly calls: string[];
}

interface FakeServerOpts {
  readonly refs?: readonly ComfyOutputRef[];
  readonly bytes?: Uint8Array;
  readonly claimedMime?: string;
  readonly submitError?: string;
  readonly waitError?: string;
  /** Per-filename overrides, for a run where one output lies and another does not. */
  readonly perFile?: Readonly<Record<string, { bytes: Uint8Array; mime: string }>>;
}

const videoRef = (filename = "LUCID_00001_.webm"): ComfyOutputRef =>
  ({ filename, subfolder: "", type: "output", key: "videos", kind: "video", mime: "video/webm" });

function fakeServer(opts: FakeServerOpts = {}): FakeServer {
  const calls: string[] = [];
  const client: ComfyLike = {
    baseUrl: "http://127.0.0.1:8188",
    submit: async () => {
      calls.push("submit");
      return opts.submitError ? { ok: false, error: opts.submitError } : { ok: true, promptId: "p_1" };
    },
    waitForOutputs: async () => {
      calls.push("wait");
      if (opts.waitError) return { ok: false, error: opts.waitError };
      return { ok: true, refs: opts.refs ?? [videoRef()] };
    },
    fetchImage: async (ref) => {
      calls.push(`fetch:${ref.filename}`);
      const over = opts.perFile?.[ref.filename];
      if (over) return { ok: true, bytes: over.bytes, mime: over.mime };
      return { ok: true, bytes: opts.bytes ?? WEBM, mime: opts.claimedMime ?? "video/webm" };
    },
  };
  return { client, calls };
}

const ADMITTED: JobAdmissionSnapshot = {
  ok: true, cpuPct: 12, memPct: 40, gpuPct: 8, vramPct: 20, gpuEvidenceMissing: false, reason: "",
};
const REFUSED: JobAdmissionSnapshot = {
  ok: false, cpuPct: 97, memPct: 55, gpuPct: 99, vramPct: 91, gpuEvidenceMissing: false,
  reason: "GPU has been at 99% for 34s (held 90%+ for 30s is not a burst) - let the current render finish",
};

interface Harness {
  readonly deps: PipelineDeps;
  readonly disk: FakeDisk;
  readonly jobs: FakeJobs;
  readonly server: FakeServer;
  readonly scans: string[];
}

function harness(opts: { server?: FakeServerOpts; scan?: (text: string) => Promise<ScanVerdict> } = {}): Harness {
  const disk = fakeDisk();
  const jobs = fakeJobs();
  const server = fakeServer(opts.server);
  const scans: string[] = [];
  const scan = async (text: string): Promise<ScanVerdict> => {
    scans.push(text);
    return opts.scan ? await opts.scan(text) : CLEAN;
  };
  return {
    deps: { client: server.client, artifactIo: disk.io, jobIo: jobs.io, scan, now: () => 1_700_000_000_000 },
    disk, jobs, server, scans,
  };
}

const WORKFLOW = { "3": { class_type: "SaveWEBM", inputs: { text: "{{prompt}}", seed: "{{seed}}" } } };

const input = (over: Partial<RenderPipelineInput> = {}): RenderPipelineInput => ({
  kind: "video",
  workflow: WORKFLOW,
  spec: { prompt: "a lantern in fog", seed: 7, model: "wan_video_14b.safetensors" },
  attested: ["image", "video", "workflow-run"],
  admission: ADMITTED,
  ...over,
});

// ── the probe gate, before anything leaves the machine ──────────────────────

describe("the probe gate", () => {
  test("a capability no live probe attested refuses BEFORE any request is made", async () => {
    const h = harness();
    const res = await runRenderPipeline(h.deps, "/base", input({ attested: ["image", "workflow-run"] }));
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("capability");
    expect(res.error).toContain("attested video");
    expect(res.error).toContain("image, workflow-run");
    // The whole point of gating first: nothing was submitted, fetched, or written.
    expect(h.server.calls).toEqual([]);
    expect(h.jobs.lines).toEqual([]);
    expect(h.disk.files.size).toBe(0);
  });

  test("an EXPIRED probe attests nothing, so the same refusal covers staleness with no extra branch", async () => {
    const h = harness();
    const res = await runRenderPipeline(h.deps, "/base", input({ attested: [] }));
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("capability");
    expect(res.error).toContain("attested: nothing");
    expect(res.error).toContain("Re-probe");
    expect(h.server.calls).toEqual([]);
  });

  test("a 3D request needs the 3D attestation, not merely video", async () => {
    const h = harness();
    const res = await runRenderPipeline(h.deps, "/base", input({ kind: "model-3d", attested: ["image", "video"] }));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("attested model-3d");
    expect(h.server.calls).toEqual([]);
  });
});

// ── the governor ────────────────────────────────────────────────────────────

describe("the governor", () => {
  test("a refused admission is WRITTEN DOWN as a refused job carrying the measurement, and never submitted", async () => {
    const h = harness();
    const res = await runRenderPipeline(h.deps, "/base", input({ admission: REFUSED }));
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("admission");
    expect(res.error).toContain("99% for 34s");
    expect(h.server.calls).toEqual([]);
    const jobs = foldJobs(h.jobs.lines.join("\n"));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.state).toBe("refused");
    expect(jobs[0]?.error).toContain("99% for 34s");
    expect(jobs[0]?.kind).toBe("render");
    expect(res.jobId).toBe(jobs[0]?.id);
  });

  test("skipping the governor entirely is itself a refusal, not a fast path", async () => {
    const h = harness();
    const res = await runRenderPipeline(h.deps, "/base", input({ admission: null }));
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("admission");
    expect(res.error).toContain("did not consult the resource governor");
    expect(h.jobs.lines).toEqual([]);
  });
});

// ── the template ────────────────────────────────────────────────────────────

describe("the user's template", () => {
  test("an unresolved placeholder refuses by NAME and nothing is submitted", async () => {
    const h = harness();
    const res = await runRenderPipeline(h.deps, "/base", input({
      workflow: { "3": { inputs: { a: "{{model}}", b: "{{image:style}}" } } },
      spec: { prompt: "x" },
    }));
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("template");
    expect(res.unresolved).toEqual(["model", "image:style"]);
    expect(res.error).toContain("model");
    expect(res.error).toContain("image:style");
    expect(h.server.calls).toEqual([]);
  });

  test("ComfyUI's own refusal of a graph is passed through in its own words and fails the job", async () => {
    const h = harness({ server: { submitError: "ComfyUI rejected the workflow (check the template against this server's nodes)" } });
    const res = await runRenderPipeline(h.deps, "/base", input());
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("submit");
    expect(res.error).toContain("ComfyUI rejected the workflow");
    const jobs = foldJobs(h.jobs.lines.join("\n"));
    expect(jobs[0]?.state).toBe("failed");
    expect(jobs[0]?.error).toContain("ComfyUI rejected");
  });
});

// ── the outputs ─────────────────────────────────────────────────────────────

describe("reading the outputs back", () => {
  test("a video render lands with its sha256, its provenance, and a job artifact row", async () => {
    const h = harness();
    const res = await runRenderPipeline(h.deps, "/base", input());
    expect(res.ok).toBe(true);
    expect(res.stage).toBe("done");
    expect(res.media).toHaveLength(1);
    const stored = res.media[0]!;
    expect(stored.artifact.kind).toBe("video");
    expect(stored.artifact.mime).toBe("video/webm");
    expect(stored.artifact.file).toBe("art_1.webm");
    expect(stored.artifact.sha256).toHaveLength(64);
    expect(stored.artifact.prompt).toBe("a lantern in fog");
    expect(stored.artifact.model).toBe("wan_video_14b.safetensors");
    expect(stored.artifact.source).toBe("comfyui http://127.0.0.1:8188");
    expect(h.disk.files.get(stored.path)).toEqual(WEBM);
    // The ledger and the job both know about it.
    expect(foldArtifacts(h.disk.lines.join("\n"))).toHaveLength(1);
    const jobs = foldJobs(h.jobs.lines.join("\n"));
    expect(jobs[0]?.state).toBe("done");
    expect(jobs[0]?.artifacts).toEqual([stored.artifact.id]);
  });

  test("a 3D output stores as model-3d with the glb extension the BYTES proved", async () => {
    const h = harness({
      server: {
        refs: [{ filename: "hero.glb", subfolder: "", type: "output", key: "model_file", kind: "model-3d", mime: "model/gltf-binary" }],
        bytes: GLB,
        claimedMime: "model/gltf-binary",
      },
    });
    const res = await runRenderPipeline(h.deps, "/base", input({ kind: "model-3d", attested: ["model-3d"] }));
    expect(res.ok).toBe(true);
    expect(res.media[0]?.artifact.kind).toBe("model-3d");
    expect(res.media[0]?.artifact.file).toBe("art_1.glb");
  });

  test("a workflow that produced stills when video was asked for FAILS by name instead of handing back a PNG", async () => {
    const h = harness({ server: { waitError: "that workflow finished but produced no video output: it produced image instead" } });
    const res = await runRenderPipeline(h.deps, "/base", input());
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("wait");
    expect(res.error).toContain("no video output");
    expect(res.error).toContain("image instead");
    expect(h.disk.files.size).toBe(0);
    expect(foldJobs(h.jobs.lines.join("\n"))[0]?.state).toBe("failed");
  });
});

// ── the bytes decide their own type ─────────────────────────────────────────

describe("a server's content type is a claim, not evidence", () => {
  test("PNG bytes claimed as video/mp4 are REFUSED by name, and nothing is written", async () => {
    const h = harness({ server: { bytes: PNG, claimedMime: "video/mp4" } });
    const res = await runRenderPipeline(h.deps, "/base", input());
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("store");
    expect(res.refused).toHaveLength(1);
    expect(res.refused[0]?.filename).toBe("LUCID_00001_.webm");
    expect(res.refused[0]?.reason.toLowerCase()).toContain("video/mp4");
    expect(h.disk.files.size).toBe(0);
    expect(h.disk.lines).toEqual([]);
  });

  test("bytes LUCID cannot identify are refused rather than stored under a guessed extension", async () => {
    const h = harness({ server: { bytes: NOISE, claimedMime: "video/webm" } });
    const res = await runRenderPipeline(h.deps, "/base", input());
    expect(res.ok).toBe(false);
    expect(res.refused[0]?.reason).toContain("could not identify those bytes");
    expect(h.disk.files.size).toBe(0);
  });

  test("an output that reads back empty is refused with the server's reason and does not sink the others", async () => {
    const h = harness({
      server: {
        refs: [videoRef("a.webm"), videoRef("b.webm")],
        perFile: { "a.webm": { bytes: new Uint8Array(), mime: "video/webm" }, "b.webm": { bytes: WEBM, mime: "video/webm" } },
      },
    });
    const res = await runRenderPipeline(h.deps, "/base", input());
    expect(res.ok).toBe(true);
    expect(res.media).toHaveLength(1);
    expect(res.media[0]?.ref.filename).toBe("b.webm");
    expect(res.refused[0]?.filename).toBe("a.webm");
    expect(res.note).toContain("1 refused");
  });
});

// ── the scan gate: the keystone ─────────────────────────────────────────────

describe("the scan gate is fail-closed", () => {
  test("A DEAD SCANNER BLOCKS THE ARTIFACT: nothing is written and the job says why", async () => {
    const h = harness({ scan: async () => { throw new Error("sidecar is not running"); } });
    const res = await runRenderPipeline(h.deps, "/base", input());
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("scan");
    expect(res.error).toContain("fail-closed");
    expect(res.error).toContain("sidecar is not running");
    // The bytes were fetched, and then refused. Nothing reached the disk or the ledger.
    expect(h.disk.files.size).toBe(0);
    expect(h.disk.lines).toEqual([]);
    const jobs = foldJobs(h.jobs.lines.join("\n"));
    expect(jobs[0]?.state).toBe("failed");
    expect(jobs[0]?.error).toContain("fail-closed");
    expect(jobs[0]?.artifacts).toEqual([]);
  });

  test("a scanner that returns a malformed verdict is also a block, not a pass", async () => {
    const h = harness({ scan: async () => (undefined as unknown as ScanVerdict) });
    const res = await runRenderPipeline(h.deps, "/base", input());
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("scan");
    expect(res.error).toContain("no usable verdict");
    expect(h.disk.files.size).toBe(0);
  });

  test("a quarantining finding in the metadata blocks that artifact and quotes the reason", async () => {
    const h = harness({
      scan: async () => ({ block: true, reason: "quarantined: 1 finding(s), max severity exceeds high", trustLabel: "quarantined", failClosed: false }),
    });
    const res = await runRenderPipeline(h.deps, "/base", input());
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("scan");
    expect(res.error).toContain("quarantined: 1 finding(s)");
    expect(h.disk.files.size).toBe(0);
  });

  test("the scan runs BEFORE the write, so a blocked artifact never touches the disk at all", async () => {
    const disk = fakeDisk();
    const jobs = fakeJobs();
    const server = fakeServer();
    let filesAtScanTime = -1;
    const deps: PipelineDeps = {
      client: server.client, artifactIo: disk.io, jobIo: jobs.io, now: () => 1,
      scan: async () => { filesAtScanTime = disk.files.size; return { block: true, reason: "no", trustLabel: "quarantined", failClosed: false }; },
    };
    await runRenderPipeline(deps, "/base", input());
    expect(filesAtScanTime).toBe(0);
    expect(disk.files.size).toBe(0);
  });

  test("what gets scanned is every string the SERVER supplied, wrapped as untrusted data", async () => {
    const h = harness();
    await runRenderPipeline(h.deps, "/base", input());
    expect(h.scans).toHaveLength(1);
    const block = h.scans[0]!;
    expect(block.startsWith("UNTRUSTED_CONTENT_START")).toBe(true);
    expect(block.trimEnd().endsWith("UNTRUSTED_CONTENT_END")).toBe(true);
    expect(block).toContain("filename: LUCID_00001_.webm");
    expect(block).toContain("output-key: videos");
    expect(block).toContain("claimed-mime: video/webm");
  });

  test("a clean scan of one output does not bless another: each artifact is scanned on its own", async () => {
    const h = harness({ server: { refs: [videoRef("a.webm"), videoRef("b.webm")] } });
    const res = await runRenderPipeline(h.deps, "/base", input());
    expect(res.ok).toBe(true);
    expect(res.media).toHaveLength(2);
    expect(h.scans).toHaveLength(2);
    expect(h.scans[0]).toContain("a.webm");
    expect(h.scans[1]).toContain("b.webm");
  });

  test("the success note claims only what was proven, and admits the bytes were not content-scanned", async () => {
    const h = harness();
    const res = await runRenderPipeline(h.deps, "/base", input());
    expect(res.note).toContain("Type proven from the bytes");
    expect(res.note).toContain("were scanned before writing");
    expect(res.note).toContain("sha256, not a content scan");
  });
});

describe("scanMetadata on its own", () => {
  test("a rejected scan promise becomes a fail-closed block rather than an escaping exception", async () => {
    const v = await scanMetadata(async () => { throw new Error("boom"); }, "text");
    expect(v.block).toBe(true);
    expect(v.failClosed).toBe(true);
    expect(v.trustLabel).toBe("quarantined");
    expect(v.reason).toContain("boom");
  });

  test("a clean verdict passes through untouched", async () => {
    const v = await scanMetadata(async () => CLEAN, "text");
    expect(v).toEqual(CLEAN);
  });

  test("the delimited block names the file, the key and the claim, so a finding is traceable", () => {
    const block = metadataBlock(videoRef("odd name.webm"), "video/webm", "comfyui http://box:8188");
    expect(block).toContain("source: comfyui http://box:8188");
    expect(block).toContain("filename: odd name.webm");
    expect(block).toContain("output-key: videos");
  });
});

// ── progress is telemetry, never authority ─────────────────────────────────

describe("the websocket stream", () => {
  const feedOf = (frames: readonly (string | Uint8Array)[]): ProgressFeed => ({
    async *[Symbol.asyncIterator]() { for (const f of frames) yield f; },
  });

  test("frames for ANOTHER prompt on a shared socket do not move our progress", async () => {
    const state = await trackProgress("p_mine", feedOf([
      JSON.stringify({ type: "progress", data: { value: 9, max: 10, node: "3", prompt_id: "p_theirs" } }),
      JSON.stringify({ type: "progress", data: { value: 1, max: 4, node: "3", prompt_id: "p_mine" } }),
    ]));
    expect(state.step).toBe(1);
    expect(state.total).toBe(4);
    expect(state.pct).toBe(25);
  });

  test("malformed and truncated frames are ignored rather than thrown, and the run continues", async () => {
    const state = await trackProgress("p_mine", feedOf([
      '{"type":"progress","data":{',
      new Uint8Array([0, 0, 0]),
      JSON.stringify({ type: "progress", data: { value: 2, max: 2, node: "3", prompt_id: "p_mine" } }),
    ]));
    expect(state.pct).toBe(100);
    expect(state.status).not.toBe("error");
  });

  test("a feed that dies mid-stream returns the last good state, because telemetry is not the render", async () => {
    const feed: ProgressFeed = {
      async *[Symbol.asyncIterator]() {
        yield JSON.stringify({ type: "progress", data: { value: 1, max: 2, node: "3", prompt_id: "p_mine" } });
        throw new Error("socket closed");
      },
    };
    const state = await trackProgress("p_mine", feed);
    expect(state.pct).toBe(50);
  });

  test("a silent socket cannot hang the render: the feed simply ends and polling decides", async () => {
    const h = harness({ server: { refs: [videoRef()] } });
    const res = await runRenderPipeline(h.deps, "/base", input({ feed: feedOf([]) }));
    expect(res.ok).toBe(true);
    expect(res.progress?.status).toBe("queued");
    expect(res.media).toHaveLength(1);
  });

  test("a noisy socket cannot spin forever: the frame budget bounds the drain", async () => {
    const noise = JSON.stringify({ type: "status", data: { status: { exec_info: { queue_remaining: 1 } } } });
    const state = await trackProgress("p_mine", feedOf(Array.from({ length: 50 }, () => noise)), { budget: 5 });
    expect(state.status).toBe("queued");
  });
});

// ── caps ────────────────────────────────────────────────────────────────────

test("the artifact cap bounds one render, so a runaway workflow cannot fill the library", async () => {
  const refs = Array.from({ length: 12 }, (_, i) => videoRef(`v${i}.webm`));
  const h = harness({ server: { refs } });
  const res = await runRenderPipeline(h.deps, "/base", input({ maxArtifacts: 3 }));
  expect(res.ok).toBe(true);
  expect(res.media).toHaveLength(3);
  expect(h.disk.files.size).toBe(3);
});
