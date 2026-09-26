// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/creator_blender.ts - CREATOR-3 (ADR-0287) item 4: the I/O seam that runs one Blender render.
//
// `harness/creator/blender_cli.ts` decided WHAT to run (a fixed argument vector) and how to READ what came
// back. This module is the only place those two pure halves meet a real process and the CREATOR-1 job
// ledger, and it is deliberately thin: everything dangerous about running Blender is a named refusal that
// happens BEFORE the spawn.
//
//   * THE CALLER SUPPLIES THE SPAWN. This module never imports `node:child_process`, never joins, quotes, or
//     interpolates a command line, and never mentions a shell. It hands `deps.spawn` the argv ARRAY exactly
//     as the builder produced it, so a unit test can prove the vector that would have reached the OS.
//   * A MISSING FILE IS CHECKED, NOT DISCOVERED. The executable and the blend file are checked first,
//     because "spawn ENOENT" does not say which of the two was missing, and that is the difference between
//     installing Blender and fixing a path.
//   * THE USER'S PYTHON NEEDS EXEC APPROVAL. ADR-0287 item 4 is explicit: LUCID adds no `.py` of its own and
//     never runs the user's silently. An argv carrying `--python` is refused here unless the caller states
//     the exec-approval gate already passed, because a `--python` that reaches the spawn has already run.
//   * THE GOVERNOR DECIDES AND THE LEDGER REMEMBERS. A null admission never runs. A refused admission is
//     written down as a `refused` job carrying the measurement that refused it, exactly as
//     `desktop/creator_pipeline.ts` does, so "why did this not run" is answerable from the ledger alone.
//
// Refusals are VALUES: `runBlenderRender` returns a result and never throws, and every refusal names the
// stage it stopped at. Blender's stdout and stderr are UNTRUSTED TEXT (invariant 5): they are handed to the
// pure classifier, which matches patterns and quotes bounded text back. Nothing here reads them as
// instructions, and nothing here treats an unrecognised run as success.
//
// WHAT THE TESTS DO NOT PROVE. No assertion in `creator_blender.test.ts` has met a real Blender: the spawn
// is injected in every test. The suite proves the vector handed to the spawn, the order of the refusals, and
// what each classified outcome does to the ledger. It does NOT prove that a real Blender accepts this argv
// or that a real process reports what the fixtures report.

import {
  blenderRenderArgv, classifyBlenderOutput,
  type BlenderOutcome, type BlenderRenderInput,
} from "../harness/creator/blender_cli.ts";
import {
  createJob, finishJob, startJob,
  type JobAdmissionSnapshot, type JobIo,
} from "./creator_jobs.ts";

// ── the seams this module is given ──────────────────────────────────────────

/** What a finished child process reported. `code` is null when it was killed before it could exit, which is
 *  the case `classifyBlenderOutput` refuses to read as success no matter what was saved. */
export interface SpawnResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The spawn, injected. `argv` is a VECTOR: element 0 is the program and every other element is one already
 *  separated argument, so nothing is re-parsed and there is nothing here to escape. The caller owns the
 *  process API, the kill on timeout, and the output capture; this module owns the decision to run at all. */
export type SpawnLike = (
  argv: readonly string[],
  opts: { cwd?: string; timeoutMs: number },
) => Promise<SpawnResult>;

export interface BlenderDeps {
  readonly spawn: SpawnLike;
  readonly jobIo: JobIo;
  /** Is this path there right now? Consulted for the executable and the blend file, never for a guess. */
  readonly exists: (path: string) => boolean;
  readonly now: () => number;
}

// ── input and result ────────────────────────────────────────────────────────

/** One render request: whatever `BlenderRenderInput` fields the caller chose, plus what this seam needs that
 *  a pure argv builder has no business knowing. */
export interface BlenderRunInput extends BlenderRenderInput {
  /** The governor's verdict. `null` means nobody asked, which is a refusal rather than a fast path. */
  readonly admission: JobAdmissionSnapshot | null;
  /** One line the user reads in the job list. Defaulted from the blend file when absent. */
  readonly label?: string;
  readonly timeoutMs?: number;
  readonly cwd?: string;
  /** True ONLY when the user's `--python` script has already been through the exec-approval gate. */
  readonly approved?: boolean;
  /** VRAM the caller MEASURED or was told this render needs. Absent means unknown, never zero: this module
   *  cannot read a .blend file and so cannot know a scene's cost. */
  readonly vramMB?: number;
}

/** Where the run stopped. A caller shows this verbatim, so a failure is never "something went wrong". */
export type BlenderStage =
  | "argv" | "missing-exe" | "missing-blend" | "approval" | "admission" | "spawn" | "classify" | "done";

export interface BlenderRunResult {
  readonly ok: boolean;
  readonly error: string;
  /** "" when the run was refused before a job was worth writing down. */
  readonly jobId: string;
  /** What would have been (or was) handed to the spawn. Empty only when the builder refused. */
  readonly argv: readonly string[];
  readonly outcome: BlenderOutcome | null;
  readonly stage: BlenderStage;
  readonly note: string;
}

/** Every field a result carries, so each refusal below states only the part it actually knows. */
const BLANK: BlenderRunResult = {
  ok: false, error: "", jobId: "", argv: [], outcome: null, stage: "argv", note: "",
};

/** How long a render may run before the caller's spawn kills it. Half an hour is a long single frame and a
 *  short animation; a caller with a heavier job passes its own. */
const DEFAULT_TIMEOUT_MS = 1_800_000;
/** A day. Past this the number is a mistake, not a plan. */
const MAX_TIMEOUT_MS = 86_400_000;
const MAX_LABEL_CHARS = 120;

// ── what the governor is asked for ──────────────────────────────────────────

/**
 * What the caller hands `creatorAdmission` before starting a render.
 *
 * Two honest answers and no invented third. CYCLES and EEVEE both render on the GPU, so they ask for that
 * headroom; WORKBENCH is the cheap viewport shader and does not. An engine the caller did not pin is
 * whatever the .blend file already says, which this module cannot read, so the GPU is declared: asking for
 * headroom that goes unused costs a wait, while not asking lets a heavy render start on top of one already
 * running. The VRAM figure is present only when the caller supplied a real one.
 */
export function blenderJobNeed(
  input: BlenderRunInput,
): { readonly label: string; readonly gpu: boolean; readonly vramMB?: number } {
  const label = (input.label ?? `Blender render of ${input.blend}`).slice(0, MAX_LABEL_CHARS);
  const need: { label: string; gpu: boolean; vramMB?: number } = {
    label,
    gpu: input.engine !== "BLENDER_WORKBENCH",
  };
  if (typeof input.vramMB === "number" && Number.isFinite(input.vramMB) && input.vramMB > 0) {
    need.vramMB = input.vramMB;
  }
  return need;
}

// ── the run ─────────────────────────────────────────────────────────────────

/**
 * Run one Blender background render end to end: build the fixed argv, prove both files are there, gate the
 * user's Python behind exec approval, gate the whole thing behind the governor, spawn, classify what came
 * back, and settle the job either way.
 *
 * Returns a result object; it never throws. Each step below is a refusal that never reaches the next one.
 */
export async function runBlenderRender(
  deps: BlenderDeps,
  base: string,
  input: BlenderRunInput,
): Promise<BlenderRunResult> {
  const { spawn, jobIo, exists } = deps;

  // 1. The argv. The builder owns every value check (control characters, `..` climbs, the frame/range
  //    exclusion, the frame cap, the file extensions), so its refusal is passed through in its own words
  //    rather than restated less precisely here.
  const built = blenderRenderArgv(input);
  if (!built.ok) return { ...BLANK, stage: "argv", error: built.error };
  const { argv, userScript, note } = built;

  // 2. The two files, by name. A spawn failure for a missing file is a worse message than a check.
  if (!exists(input.exe)) {
    return {
      ...BLANK, stage: "missing-exe", argv, note,
      error: `The Blender executable is not there: ${input.exe}. Point Creator at an installed Blender, then try again.`,
    };
  }
  if (!exists(input.blend)) {
    return {
      ...BLANK, stage: "missing-blend", argv, note,
      error: `That .blend file is not there: ${input.blend}. Nothing was started.`,
    };
  }

  // 3. The user's Python. LUCID never authored this file and does not read it; Blender would EXECUTE it, so
  //    it goes through the same exec approval any other program gets (ADR-0287 item 4).
  if (userScript && input.approved !== true) {
    return {
      ...BLANK, stage: "approval", argv, note,
      error: `${input.pythonScript ?? "That script"} is the user's own code and Blender would execute it. That needs exec approval first: LUCID adds no Blender script of its own and never runs the user's silently.`,
    };
  }

  // 4. The governor.
  if (!input.admission) {
    return {
      ...BLANK, stage: "admission", argv, note,
      error: "That render did not consult the resource governor, so it was not started.",
    };
  }
  // The label the ledger records is the label the governor was asked about, so the two stories about this
  // render never diverge.
  const label = blenderJobNeed(input).label;
  if (!input.admission.ok) {
    const refusedJob = createJob(jobIo, base, { kind: "render", label, provider: "blender", admission: input.admission });
    return { ...BLANK, stage: "admission", argv, note, jobId: refusedJob.id, error: input.admission.reason };
  }

  const job = createJob(jobIo, base, { kind: "render", label, provider: "blender", admission: input.admission });
  startJob(jobIo, base, job.id, input.admission);

  // 5. The spawn. A nonsense timeout falls back to the default instead of becoming an instant kill dressed
  //    up as a render failure.
  const asked = input.timeoutMs;
  const timeoutMs = typeof asked === "number" && Number.isFinite(asked) && asked > 0
    ? Math.min(Math.trunc(asked), MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
  const startedAt = deps.now();

  let out: SpawnResult | null = null;
  let crash = "";
  try {
    out = await spawn(argv, input.cwd === undefined ? { timeoutMs } : { cwd: input.cwd, timeoutMs });
  } catch (err) {
    crash = String(err);
  }
  if (!out) {
    const error = crash
      ? `Blender did not run: ${crash}`
      : "The Blender runner returned nothing, so nothing is known about this render.";
    finishJob(jobIo, base, job.id, "failed", error);
    return { ...BLANK, stage: "spawn", argv, note, jobId: job.id, error };
  }

  // 6. What Blender said. The classifier is the authority on whether anything was produced, including the
  //    quiet failure of exit 0 with nothing saved.
  const outcome = classifyBlenderOutput(out.code, out.stdout, out.stderr);
  if (!outcome.ok) {
    // The line, always, when there is one: "the render failed" without it is useless to whoever has to fix
    // the blend file.
    const error = outcome.failingLine
      ? `${outcome.reason} Blender said: ${outcome.failingLine}`
      : outcome.reason;
    finishJob(jobIo, base, job.id, "failed", error);
    return { ...BLANK, stage: "classify", argv, note, jobId: job.id, outcome, error };
  }

  finishJob(jobIo, base, job.id, "done", "");
  const elapsedMs = Math.max(0, deps.now() - startedAt);
  return {
    ok: true,
    error: "",
    jobId: job.id,
    argv,
    outcome,
    stage: "done",
    // States what was reported, not what was verified: the saved paths are Blender's own log lines, not a
    // directory listing LUCID took.
    note: `${note} ${outcome.reason} The run took ${elapsedMs}ms, and the saved paths are Blender's own report.`,
  };
}
