// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/creator_blender.test.ts - CREATOR-3 (ADR-0287) item 4.
//
// The claims this file exists to defend:
//
//   * THERE IS NO SHELL. The spawn is handed the builder's argument VECTOR and nothing else: no joined
//     command line, no `sh -c`, no `cmd.exe`. The fake spawn records what it was given so the vector that
//     would have reached the OS is an assertion rather than a hope.
//   * EVERY REFUSAL HAPPENS BEFORE THE PROCESS. A bad argv, a missing executable, a missing blend file, an
//     unapproved `--python`, and a refused admission each stop with a named stage and an empty call list.
//   * A RUN THAT PROVED NOTHING IS NOT A SUCCESS. Exit 0 with no saved file fails, a killed process fails,
//     and a failing run carries Blender's own `Error:` line into the message and into the ledger.
//
// Everything is injected: no process, no disk, no clock.

import { test, expect, describe } from "bun:test";
import { blenderRenderArgv } from "../harness/creator/blender_cli.ts";
import { foldJobs, type JobAdmissionSnapshot, type JobIo } from "./creator_jobs.ts";
import {
  blenderJobNeed, runBlenderRender,
  type BlenderDeps, type BlenderRunInput, type SpawnLike, type SpawnResult,
} from "./creator_blender.ts";

// ── fixtures ────────────────────────────────────────────────────────────────

const EXE = "/usr/bin/blender";
const BLEND = "/proj/shot.blend";
const OUT = "/out/frame_####";
const CLOCK = 1_700_000_000_000;

const SAVED_ONE: SpawnResult = {
  code: 0,
  stdout: "Fra:1 Mem:12.00M | Rendering\nSaved: '/out/frame_0001.png'\n Time: 00:02.11 (Saving: 00:00.03)\nBlender quit\n",
  stderr: "",
};

const ADMITTED: JobAdmissionSnapshot = {
  ok: true, cpuPct: 11, memPct: 38, gpuPct: 6, vramPct: 18, gpuEvidenceMissing: false, reason: "",
};
const REFUSED: JobAdmissionSnapshot = {
  ok: false, cpuPct: 96, memPct: 52, gpuPct: 99, vramPct: 93, gpuEvidenceMissing: false,
  reason: "GPU has been at 99% for 34s (held 90%+ for 30s is not a burst) - let the current render finish",
};

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
    now: () => CLOCK,
    id: () => `job_${++n}`,
  };
  return { io, lines };
}

interface SpawnCall {
  readonly argv: readonly string[];
  readonly opts: { cwd?: string; timeoutMs: number };
}

interface Harness {
  readonly deps: BlenderDeps;
  readonly jobs: FakeJobs;
  readonly calls: SpawnCall[];
}

/** `missing` names the paths `deps.exists` should deny; everything else is there. */
function harness(over: { run?: SpawnResult; throws?: string; missing?: readonly string[] } = {}): Harness {
  const jobs = fakeJobs();
  const calls: SpawnCall[] = [];
  const spawn: SpawnLike = async (argv, opts) => {
    calls.push({ argv: [...argv], opts });
    if (over.throws) throw new Error(over.throws);
    return over.run ?? SAVED_ONE;
  };
  const missing = over.missing ?? [];
  const deps: BlenderDeps = {
    spawn,
    jobIo: jobs.io,
    exists: (path) => !missing.includes(path),
    now: () => CLOCK,
  };
  return { deps, jobs, calls };
}

const input = (over: Partial<BlenderRunInput> = {}): BlenderRunInput => ({
  exe: EXE, blend: BLEND, outPattern: OUT, frame: 1, admission: ADMITTED, ...over,
});

// ── the vector, and the shell that is not there ─────────────────────────────

describe("what reaches the spawn", () => {
  test("the spawn is handed the builder's argv VECTOR and nothing else", async () => {
    const h = harness();
    const res = await runBlenderRender(h.deps, "/base", input({ format: "PNG", engine: "CYCLES" }));
    expect(res.ok).toBe(true);

    const built = blenderRenderArgv({ exe: EXE, blend: BLEND, outPattern: OUT, frame: 1, format: "PNG", engine: "CYCLES" });
    if (!built.ok) throw new Error(built.error);

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.argv).toEqual([...built.argv]);
    expect(h.calls[0]?.argv).toEqual([EXE, "-b", BLEND, "-o", OUT, "-F", "PNG", "-E", "CYCLES", "-f", "1"]);
    // The caller is told the same vector that ran, so a job row and a bug report agree.
    expect(res.argv).toEqual([...built.argv]);
  });

  test("no element is a command LINE: no interpreter, no -c, no chained operators", async () => {
    const h = harness();
    await runBlenderRender(h.deps, "/base", input({ engine: "CYCLES" }));
    const argv = h.calls[0]?.argv ?? [];
    expect(argv.length).toBeGreaterThan(0);
    expect(argv[0]).toBe(EXE);
    for (const part of argv) {
      expect(part.includes(" && ")).toBe(false);
      expect(part.includes(" ; ")).toBe(false);
      expect(part.endsWith(";")).toBe(false);
      expect(part).not.toBe("-c");
      expect(/(^|[\\/])(sh|bash|zsh|cmd\.exe|powershell(\.exe)?)$/i.test(part)).toBe(false);
    }
  });

  test("the spawn options carry the caller's cwd and timeout", async () => {
    const h = harness();
    await runBlenderRender(h.deps, "/base", input({ cwd: "/proj", timeoutMs: 5_000 }));
    expect(h.calls[0]?.opts).toEqual({ cwd: "/proj", timeoutMs: 5_000 });
  });

  test("a nonsense timeout falls back rather than becoming an instant kill reported as a render failure", async () => {
    const h = harness();
    await runBlenderRender(h.deps, "/base", input({ timeoutMs: -1 }));
    expect(h.calls[0]?.opts.timeoutMs).toBeGreaterThan(0);
    expect(h.calls[0]?.opts.cwd).toBeUndefined();
  });
});

// ── refusals that never reach a process ─────────────────────────────────────

describe("refusals before the spawn", () => {
  test("a builder refusal is passed through in its own words and nothing is spawned", async () => {
    const h = harness();
    const res = await runBlenderRender(h.deps, "/base", input({ blend: "/proj/shot.txt" }));
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("argv");
    expect(res.error).toContain(".blend");
    expect(res.argv).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.jobs.lines).toEqual([]);
  });

  test("neither a frame nor a range is a builder refusal, not a run that renders nothing", async () => {
    const h = harness();
    const res = await runBlenderRender(h.deps, "/base", input({ frame: undefined }));
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("argv");
    expect(res.error).toContain("renders nothing");
    expect(h.calls).toEqual([]);
  });

  test("a missing executable refuses BY NAME, and the argv it would have run is still reported", async () => {
    const h = harness({ missing: [EXE] });
    const res = await runBlenderRender(h.deps, "/base", input());
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("missing-exe");
    expect(res.error).toContain(EXE);
    expect(res.argv[0]).toBe(EXE);
    expect(h.calls).toEqual([]);
    expect(h.jobs.lines).toEqual([]);
  });

  test("a missing blend file refuses as the BLEND, never as the executable", async () => {
    const h = harness({ missing: [BLEND] });
    const res = await runBlenderRender(h.deps, "/base", input());
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("missing-blend");
    expect(res.error).toContain(BLEND);
    expect(res.error).not.toContain("executable");
    expect(h.calls).toEqual([]);
    expect(h.jobs.lines).toEqual([]);
  });
});

// ── the user's Python ───────────────────────────────────────────────────────

describe("the user's --python script", () => {
  test("a script without exec approval refuses, names the file, and never reaches a process", async () => {
    const h = harness();
    const res = await runBlenderRender(h.deps, "/base", input({ pythonScript: "/proj/setup_render.py" }));
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("approval");
    expect(res.error).toContain("exec approval");
    expect(res.error).toContain("/proj/setup_render.py");
    expect(h.calls).toEqual([]);
    expect(h.jobs.lines).toEqual([]);
  });

  test("approved:false and a missing approval are the same refusal: only true runs it", async () => {
    const h = harness();
    const res = await runBlenderRender(h.deps, "/base", input({ pythonScript: "/proj/setup_render.py", approved: false }));
    expect(res.stage).toBe("approval");
    expect(h.calls).toEqual([]);
  });

  test("the same script WITH exec approval runs, and --python rides the argv as its own two elements", async () => {
    const h = harness();
    const res = await runBlenderRender(h.deps, "/base", input({ pythonScript: "/proj/setup_render.py", approved: true }));
    expect(res.ok).toBe(true);
    const argv = h.calls[0]?.argv ?? [];
    const at = argv.indexOf("--python");
    expect(at).toBeGreaterThan(-1);
    expect(argv[at + 1]).toBe("/proj/setup_render.py");
    // Argument order is semantic: a script placed after -f would run after the render it configures.
    expect(at).toBeLessThan(argv.indexOf("-f"));
    expect(res.note).toContain("exec approval");
  });
});

// ── the governor ────────────────────────────────────────────────────────────

describe("the governor", () => {
  test("skipping the governor is a refusal, not a fast path, and writes no job at all", async () => {
    const h = harness();
    const res = await runBlenderRender(h.deps, "/base", input({ admission: null }));
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("admission");
    expect(res.error).toContain("resource governor");
    expect(res.jobId).toBe("");
    expect(h.jobs.lines).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  test("a refused admission is WRITTEN DOWN as a refused render job carrying the measurement, and never spawns", async () => {
    const h = harness();
    const res = await runBlenderRender(h.deps, "/base", input({ admission: REFUSED }));
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("admission");
    expect(res.error).toContain("99% for 34s");
    expect(h.calls).toEqual([]);
    const jobs = foldJobs(h.jobs.lines.join("\n"));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.state).toBe("refused");
    expect(jobs[0]?.kind).toBe("render");
    expect(jobs[0]?.error).toContain("99% for 34s");
    expect(res.jobId).toBe(jobs[0]?.id);
  });
});

// ── what came back ──────────────────────────────────────────────────────────

describe("classifying the run", () => {
  test("a finished render settles the job done and reports the files Blender said it saved", async () => {
    const h = harness({
      run: { code: 0, stdout: "Saved: '/out/frame_0001.png'\nSaved: '/out/frame_0002.png'\nBlender quit\n", stderr: "" },
    });
    const res = await runBlenderRender(h.deps, "/base", input({ frame: undefined, range: { start: 1, end: 2 } }));
    expect(res.ok).toBe(true);
    expect(res.stage).toBe("done");
    expect(res.error).toBe("");
    expect(res.outcome?.savedFiles).toEqual(["/out/frame_0001.png", "/out/frame_0002.png"]);
    expect(res.outcome?.frames).toBe(2);
    const jobs = foldJobs(h.jobs.lines.join("\n"));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.state).toBe("done");
    expect(jobs[0]?.error).toBe("");
    expect(jobs[0]?.admission?.ok).toBe(true);
    expect(res.jobId).toBe(jobs[0]?.id);
  });

  test("exit 0 with nothing saved FAILS the job in the classifier's words: it ran and rendered nothing", async () => {
    const h = harness({ run: { code: 0, stdout: "Blender quit\n", stderr: "" } });
    const res = await runBlenderRender(h.deps, "/base", input());
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("classify");
    expect(res.error).toContain("saved no files");
    expect(res.error).toContain("rendered nothing");
    expect(res.outcome?.frames).toBe(0);
    const jobs = foldJobs(h.jobs.lines.join("\n"));
    expect(jobs[0]?.state).toBe("failed");
    expect(jobs[0]?.error).toContain("rendered nothing");
  });

  test("a killed run (no exit code) fails by name even though a frame had already been saved", async () => {
    const h = harness({ run: { code: null, stdout: "Saved: '/out/frame_0001.png'\n", stderr: "" } });
    const res = await runBlenderRender(h.deps, "/base", input());
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("classify");
    expect(res.error).toContain("killed");
    expect(res.outcome?.frames).toBe(1);
    expect(foldJobs(h.jobs.lines.join("\n"))[0]?.state).toBe("failed");
  });

  test("a failing run carries Blender's own quoted Error: line, because 'the render failed' is useless", async () => {
    const h = harness({
      run: { code: 1, stdout: "", stderr: "Error: Cannot read file '/proj/shot.blend': No such file or directory\nBlender quit\n" },
    });
    const res = await runBlenderRender(h.deps, "/base", input());
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("classify");
    expect(res.error).toContain("exited 1");
    expect(res.error).toContain("Error: Cannot read file '/proj/shot.blend'");
    expect(res.outcome?.failingLine).toContain("Error:");
    const jobs = foldJobs(h.jobs.lines.join("\n"));
    expect(jobs[0]?.state).toBe("failed");
    expect(jobs[0]?.error).toContain("Error: Cannot read file");
  });

  test("a runner that throws fails the job at the spawn stage instead of unwinding into the caller", async () => {
    const h = harness({ throws: "EACCES: permission denied, spawn /usr/bin/blender" });
    const res = await runBlenderRender(h.deps, "/base", input());
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("spawn");
    expect(res.error).toContain("EACCES");
    expect(res.outcome).toBeNull();
    const jobs = foldJobs(h.jobs.lines.join("\n"));
    expect(jobs[0]?.state).toBe("failed");
    expect(jobs[0]?.error).toContain("EACCES");
  });
});

// ── what the governor is asked for ──────────────────────────────────────────

describe("blenderJobNeed", () => {
  test("a CYCLES render declares it wants the GPU and invents no VRAM number", () => {
    const need = blenderJobNeed(input({ engine: "CYCLES" }));
    expect(need.gpu).toBe(true);
    expect(need.vramMB).toBeUndefined();
    expect("vramMB" in need).toBe(false);
  });

  test("a WORKBENCH render does not ask for GPU headroom", () => {
    expect(blenderJobNeed(input({ engine: "BLENDER_WORKBENCH" })).gpu).toBe(false);
  });

  test("an engine the caller did not pin belongs to the blend file, so the GPU is declared rather than assumed away", () => {
    expect(blenderJobNeed(input()).gpu).toBe(true);
  });

  test("a VRAM figure is passed through ONLY when the caller supplied a real one", () => {
    expect(blenderJobNeed(input({ vramMB: 8192 })).vramMB).toBe(8192);
    expect(blenderJobNeed(input({ vramMB: 0 })).vramMB).toBeUndefined();
  });

  test("the label the governor is asked about is the label the ledger records", async () => {
    const h = harness();
    const req = input({ label: "shot 12 - beauty pass" });
    const res = await runBlenderRender(h.deps, "/base", req);
    expect(res.ok).toBe(true);
    const jobs = foldJobs(h.jobs.lines.join("\n"));
    expect(jobs[0]?.label).toBe(blenderJobNeed(req).label);
    expect(jobs[0]?.label).toBe("shot 12 - beauty pass");
  });
});
