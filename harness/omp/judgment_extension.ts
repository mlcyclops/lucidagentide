// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/judgment_extension.ts - P-JEV.2 (ADR-0377): tell the desktop about EVERY typed judgment,
// because omp records none of them and exposes no hook for them.
//
// WHAT THE USER ASKED. "Show when Jev is used": which judgment was asked, what it answered and how it got
// there, and say so when a configured Jev sat idle. omp's judgment module (18.2.6, `src/judgment/index.ts`)
// resolves a Judge per feature and calls it; only the auto-thinking caller records even usage
// (`appendModelUsage`, tokens only). The answers, the probabilities and the questions exist in exactly one
// place: inside `TypeSafeJudge.judge()` (Jev, api.typesafe.ai) and `TextJudge.judge()` (the chat/local
// keyword bridge omp falls back to, or uses outright when Jev is off). Those are plain class methods on
// the `@oh-my-pi/pi-ai` module this process already loaded (asksage_stream.ts imports the same package at
// runtime), so this extension wraps the two prototype methods in-process. Every judge omp constructs from
// here on is observed, whichever feature asked. This is an in-process wrapper on a public class, not a
// fork: omp's source is untouched and a future omp that changes the class shape degrades to "no trace".
//
// WHY THE POST IS AWAITED (unlike tool_meta_extension.ts). The last judgment of a turn can be the
// unexpected-stop check, which runs right before omp answers the ACP prompt. A fire-and-forget POST could
// lose the race with that final response, and the desktop would draw "Jev not consulted" for a turn that
// consulted it. So the wrapper awaits the loopback POST, bounded by POST_TIMEOUT_MS, BEFORE it returns the
// result to omp: the desktop has recorded the judgment by the time the agent acts on it. A slow or absent
// desktop costs at most that bound per judgment and never the judgment itself.
//
// FAIL-SOFT BY DESIGN. Observability, not a control: a missing URL, a failed POST or a changed class shape
// costs a trace, never a judgment and never a turn. Every path is wrapped. The judgment's own errors are
// re-thrown untouched so omp's TypeSafe-to-LLM fallback behaves exactly as pinned.

import { TextJudge, TypeSafeJudge } from "@oh-my-pi/pi-ai/judgment";
import { captureJudgment } from "../judgment/trace_schema.ts";
import type { JudgmentBackend, JudgmentReport } from "../judgment/trace.ts";

/** Upper bound on one awaited loopback POST. Local, so 1.5 s is already an outage, not latency. */
export const POST_TIMEOUT_MS = 1500;

/** The one method this module wraps, typed structurally so the wrapper works on any object carrying it
 *  (pi-ai's real prototypes in production, fakes under test). */
export interface JudgeLike {
  label?: string;
  judge(request: { state: unknown; questions: unknown }, options?: unknown): Promise<unknown>;
}

const PATCHED = Symbol.for("lucid.judgment_trace");

/** Wrap `proto.judge` so each call posts a JudgmentReport through `post` after it settles. Idempotent per
 *  prototype (loading the extension twice traces once). Returns false when there is nothing to wrap. */
export function traceJudgePrototype(proto: JudgeLike, backend: JudgmentBackend, target: string, post: (report: JudgmentReport) => Promise<void>): boolean {
  const holder = proto as JudgeLike & { [PATCHED]?: true };
  if (holder[PATCHED]) return true;
  const original = proto.judge;
  if (typeof original !== "function") return false;
  proto.judge = async function tracedJudge(this: JudgeLike, request, options) {
    const t0 = performance.now();
    let result: unknown, error: unknown, threw = false;
    try { result = await original.call(this, request, options); }
    catch (e) { threw = true; error = e; }
    try {
      const report = captureJudgment({
        target, backend,
        label: typeof this.label === "string" ? this.label : backend,
        ms: performance.now() - t0,
        request: { state: request?.state, questions: request?.questions },
        ...(threw ? { error } : { result: (result ?? {}) as NonNullable<Parameters<typeof captureJudgment>[0]["result"]> }),
      });
      await post(report);
    } catch { /* a trace must never change what omp sees */ }
    if (threw) throw error;
    return result;
  };
  holder[PATCHED] = true;
  return true;
}

/** POST one report to the desktop and wait, bounded. Resolves on every outcome: a failure here is a lost
 *  trace, and the caller has nothing to do about it. */
export async function postReport(url: string, report: JudgmentReport): Promise<void> {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
  } catch { /* observability only */ }
}

export default function judgmentExtension(_pi: unknown): void {
  try {
    const url = (process.env.LUCID_JUDGMENT_URL ?? "").trim();
    if (!url) return; // not launched by the desktop (bare `omp` / a test): nothing to report to
    // P-INTERJECT.1 stamps every LUCID-spawned child with its target ("master" or a lane id); the desktop
    // routes the report to that child's chat stream.
    const target = (process.env.LUCID_INTERJECT_TARGET ?? "").trim() || "master";
    const post = (report: JudgmentReport) => postReport(url, report);
    traceJudgePrototype(TypeSafeJudge.prototype as unknown as JudgeLike, "typesafe", target, post);
    traceJudgePrototype(TextJudge.prototype as unknown as JudgeLike, "text", target, post);
  } catch {
    /* A tracing extension must never break omp launch. Worst case: the chat shows no judgment row. */
  }
}
