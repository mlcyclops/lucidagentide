// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import {
  findExternalRefs, hyperframesEnv, hyperframesVersionArgv, planHyperframesRender, preflightHyperframes, runHyperframesRender,
  type HyperframesDeps, type HyperframesPlan, type HyperframesPlanInput,
} from "./creator_hyperframes.ts";
import { createJob, foldJobs, jobsLedger, startJob, type JobIo } from "./creator_jobs.ts";
import { artifactLedger, foldArtifacts, type ArtifactIo } from "./creator_image.ts";
import type { SpawnResult } from "./creator_blender.ts";

const NODE = "C:/node/node.exe";
const CLI = "C:/hf/node_modules/hyperframes/dist/cli.js";
const PROJECT = "C:/work/promo";
const OUT = "C:/creator/hyperframes/hf_1/render.mp4";

const plan = (over: Partial<HyperframesPlanInput> = {}): HyperframesPlan => {
  const r = planHyperframesRender({ exe: NODE, prefixArgs: [CLI], projectDir: PROJECT, outPath: OUT, ...over });
  if (!r.ok) throw new Error(r.error);
  return r.plan;
};
const refusal = (over: Partial<HyperframesPlanInput>): string => {
  const r = planHyperframesRender({ exe: NODE, prefixArgs: [CLI], projectDir: PROJECT, outPath: OUT, ...over });
  if (r.ok) throw new Error("expected a refusal");
  return r.error;
};

describe("the fixed argv", () => {
  test("lint, then render with format, quality, ONE worker, and LUCID's own output path", () => {
    const p = plan({ format: "webm", quality: "draft" });
    expect(p.lintArgv).toEqual([NODE, CLI, "lint", PROJECT]);
    expect(p.renderArgv).toEqual([NODE, CLI, "render", PROJECT, "--format", "webm", "--quality", "draft", "--workers", "1", "--output", OUT]);
    expect(p.mime).toBe("video/webm");
    expect(plan().renderArgv).toContain("mp4");
    expect(plan({ format: "mov" }).mime).toBe("video/quicktime");
  });

  test("cloud, publish, auth, and lambda can never ride the declared args", () => {
    for (const word of ["cloud", "publish", "auth", "lambda", "Cloudrun", " deploy "]) {
      expect(refusal({ prefixArgs: [CLI, word] })).toContain("never runs");
    }
  });

  test("a shell launcher is refused so no shell ever parses the argv", () => {
    for (const exe of ["C:/hf/node_modules/.bin/hyperframes.cmd", "C:/x/run.BAT", "C:/x/hf.ps1"]) expect(refusal({ exe })).toContain("shell launcher");
    expect(hyperframesVersionArgv({ exe: "C:/hf/hyperframes.cmd" }).ok).toBe(false);
    expect(hyperframesVersionArgv({ exe: NODE, prefixArgs: [CLI] })).toEqual({ ok: true, argv: [NODE, CLI, "--version"] });
  });

  test("the project folder is absolute, never climbs, and stays inside managed roots", () => {
    expect(refusal({ projectDir: "promo" })).toContain("absolute");
    expect(refusal({ projectDir: "C:/work/../Windows" })).toContain("..");
    expect(refusal({ projectDir: "" })).toContain("project folder");
    expect(refusal({ projectDir: "C:/work/promo\nrm" })).toContain("control characters");
    expect(refusal({ roots: ["D:/approved"] })).toContain("workspace roots");
    expect(plan({ roots: ["c:\\work"] }).projectDir).toBe(PROJECT);
    expect(plan({ projectDir: "/home/nick/promo", roots: ["/home/nick"] }).projectDir).toBe("/home/nick/promo");
    expect(refusal({ projectDir: "/home/nickel/promo", roots: ["/home/nick"] })).toContain("workspace roots");
  });

  test("unknown format or quality is refused, not defaulted", () => {
    expect(refusal({ format: "gif" as never })).toContain("format");
    expect(refusal({ quality: "ultra" as never })).toContain("quality");
  });
});

describe("the child env", () => {
  test("telemetry is off, and engine secrets never reach the child", () => {
    const env = hyperframesEnv({ PATH: "/usr/bin", HOME: "/home/nick", ELEVENLABS_API_KEY: "sk-secret", LUCID_COMFY_TOKEN: "t", HYPERFRAMES_NO_TELEMETRY: "0", HYPERFRAMES_BROWSER_PATH: "/usr/bin/chromium" });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/nick", HYPERFRAMES_BROWSER_PATH: "/usr/bin/chromium", HYPERFRAMES_NO_TELEMETRY: "1", DO_NOT_TRACK: "1" });
  });
});

describe("external references", () => {
  test("http(s) and protocol-relative URLs in attributes, CSS, and imports are found; local and data URLs are not", () => {
    const html = `<link href="https://fonts.example.com/a.css"><img src='//cdn.example.com/x.png'>
      <div style="background:url(https://img.example.com/b.jpg)"></div><style>@import "https://x.example/y.css";</style>
      <video src="assets/clip.mp4"></video><img src="data:image/png;base64,AAAA"><script type="module">import "https://esm.example/m.js"</script>`;
    expect(findExternalRefs(html).sort()).toEqual([
      "//cdn.example.com/x.png", "https://esm.example/m.js", "https://fonts.example.com/a.css", "https://img.example.com/b.jpg", "https://x.example/y.css",
    ]);
    expect(findExternalRefs(`<div class="clip" data-start="0" data-duration="3"><img src="logo.png"></div>`)).toEqual([]);
  });

  test("under CUI lockdown a composition with external URLs is refused before any job exists; unlocked it is a note", () => {
    const files: Record<string, string> = { [NODE]: "", [`${PROJECT}/index.html`]: `<img src="https://cdn.example.com/x.png">` };
    const d = { exists: (p: string) => p in files, readText: (p: string) => files[p] ?? "" };
    const locked = preflightHyperframes(d, plan(), NODE, true);
    expect(locked.ok).toBe(false);
    if (!locked.ok) { expect(locked.stage).toBe("external-refs"); expect(locked.error).toContain("CUI lockdown"); }
    const open = preflightHyperframes(d, plan(), NODE, false);
    expect(open.ok && open.note).toContain("not offline");
    expect(preflightHyperframes({ ...d, exists: (p) => p === NODE }, plan(), NODE, false)).toMatchObject({ ok: false, stage: "missing-project" });
    expect(preflightHyperframes({ ...d, exists: () => false }, plan(), NODE, false)).toMatchObject({ ok: false, stage: "missing-exe" });
  });
});

describe("the runner", () => {
  function harness(results: SpawnResult[], opts: { writeOutput?: boolean } = {}) {
    const files = new Map<string, string>();
    const bins = new Map<string, Uint8Array>();
    let n = 0;
    const jobIo: JobIo = {
      ensureDir: () => {}, readText: (p) => files.get(p) ?? "", appendLine: (p, l) => files.set(p, (files.get(p) ?? "") + l + "\n"),
      now: () => 1000 + n, id: () => `job_${++n}`,
    };
    const artifactIo: ArtifactIo = {
      ensureDir: () => {}, writeBytes: (p, b) => { bins.set(p, b); }, writeText: (p, t) => { files.set(p, t); },
      appendLine: (p, l) => files.set(p, (files.get(p) ?? "") + l + "\n"), readText: (p) => files.get(p) ?? "", now: () => 2000, id: () => "art_1",
    };
    const calls: { argv: readonly string[]; env: Record<string, string>; cwd: string }[] = [];
    const queue = [...results];
    const deps: HyperframesDeps = {
      spawn: async (argv, o) => {
        calls.push({ argv, env: o.env, cwd: o.cwd });
        const r = queue.shift() ?? { code: 0, stdout: "", stderr: "" };
        if (argv.includes("render") && r.code === 0 && opts.writeOutput !== false) bins.set(OUT, new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]));
        return r;
      },
      exists: (p) => bins.has(p), readText: () => "", readBytes: (p) => bins.get(p)!, ensureDir: () => {},
      jobIo, artifactIo, env: { PATH: "/usr/bin", ELEVENLABS_API_KEY: "sk-secret" }, now: () => 5000,
    };
    const job = createJob(jobIo, "/base", { kind: "render", label: "HyperFrames mp4: promo", provider: "hyperframes" });
    startJob(jobIo, "/base", job.id);
    const ledger = () => foldJobs(files.get(jobsLedger("/base")) ?? "").find((j) => j.id === job.id)!;
    const artifacts = () => foldArtifacts(files.get(artifactLedger("/base")) ?? "");
    return { deps, calls, jobId: job.id, ledger, artifacts };
  }

  test("a clean run lints, renders, stores a video artifact, and settles the job done", async () => {
    const h = harness([{ code: 0, stdout: "0 errors", stderr: "" }, { code: 0, stdout: "done", stderr: "" }]);
    const r = await runHyperframesRender(h.deps, "/base", h.jobId, plan(), { label: "HyperFrames mp4: promo" });
    expect(r.ok).toBe(true);
    expect(h.calls.map((c) => c.argv[2])).toEqual(["lint", "render"]);
    expect(h.calls.every((c) => c.env.HYPERFRAMES_NO_TELEMETRY === "1" && !("ELEVENLABS_API_KEY" in c.env) && c.cwd === PROJECT)).toBe(true);
    expect(r.artifact).toMatchObject({ kind: "video", mime: "video/mp4", source: "hyperframes" });
    expect(h.ledger()).toMatchObject({ state: "done", artifacts: ["art_1"] });
    expect(h.artifacts()).toHaveLength(1);
  });

  test("a failed lint stops before the render and fails the job with lint's own words", async () => {
    const h = harness([{ code: 1, stdout: "", stderr: "error: clip #intro has no data-duration" }]);
    const r = await runHyperframesRender(h.deps, "/base", h.jobId, plan(), { label: "x" });
    expect(r).toMatchObject({ ok: false, stage: "lint" });
    expect(r.error).toContain("no data-duration");
    expect(h.calls).toHaveLength(1);
    expect(h.ledger().state).toBe("failed");
  });

  test("exit 0 with no output file is a failure, never a success", async () => {
    const h = harness([{ code: 0, stdout: "", stderr: "" }, { code: 0, stdout: "", stderr: "" }], { writeOutput: false });
    const r = await runHyperframesRender(h.deps, "/base", h.jobId, plan(), { label: "x" });
    expect(r).toMatchObject({ ok: false, stage: "render" });
    expect(h.ledger().state).toBe("failed");
    expect(h.artifacts()).toEqual([]);
  });

  test("a killed render (code null) fails with its stage", async () => {
    const h = harness([{ code: 0, stdout: "", stderr: "" }, { code: null, stdout: "", stderr: "Runtime.callFunctionOn timed out" }]);
    const r = await runHyperframesRender(h.deps, "/base", h.jobId, plan(), { label: "x" });
    expect(r.stage).toBe("render");
    expect(r.error).toContain("killed");
    expect(r.error).toContain("timed out");
  });
});
