// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { isAbsolute, resolve } from "node:path";
import { countContentLines, countDiffLines } from "../harness/runs/loc_count.ts";
import { recordAiLoc } from "./ailoc_log.ts";
import type { AiLocSample } from "./ailoc_read.ts";

interface Attribution { model: string; identity: string; identitySource: string; repo: string }
type Mutation = { tool: "write"; path: string; added: number } | { tool: "edit"; path?: string };
interface Pending { context: Attribution; sessionId?: string; kind: unknown; mutation?: Mutation }
const TERMINAL: Record<string, true> = { completed: true, failed: true, rejected: true, cancelled: true, canceled: true };
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const pathString = (v: unknown): string | undefined => typeof v === "string" && v.trim() ? v : undefined;

function replacement(ri: Record<string, unknown>): boolean {
  return [["old_string", "new_string"], ["old_text", "new_text"], ["oldText", "newText"]]
    .some(([old, next]) => typeof ri[old!] === "string" && typeof ri[next!] === "string");
}

/** ACP calls writes and edits "edit". Input shape distinguishes the mutations from read content. */
function mutation(kind: unknown, input: unknown): Mutation | undefined {
  if (!record(input)) return undefined;
  // omp's apply_patch wire name maps to ACP "other", not "edit".
  const applyPatch = kind === "other" && typeof input.input === "string" &&
    /^\*\*\* Begin Patch\r?\n/.test(input.input) && input.input.trimEnd().endsWith("*** End Patch");
  if (kind !== "edit" && !applyPatch) return undefined;
  const path = pathString(input.path) ?? pathString(input.file_path) ?? pathString(input.filePath);
  if (replacement(input) || (typeof input.patch === "string" && input.patch.trim()) ||
      (typeof input.input === "string" && input.input.trim()) ||
      (Array.isArray(input.edits) && input.edits.some((e) => record(e) &&
        (replacement(e) || typeof e.diff === "string" || ["create", "delete", "update"].includes(String(e.op)))))) {
    return { tool: "edit", path };
  }
  if (path && typeof input.content === "string") return { tool: "write", path, added: countContentLines(input.content) };
  return undefined;
}

/** Tracks starts separately from results. No input bodies or preview text survive observe(). */
export class AiLocCaptureTracker {
  private readonly pending = new Map<string, Pending>();
  private readonly settled = new Set<string>();
  private readonly cap: number;
  private readonly logPath?: string;

  constructor(opts: { logPath?: string; cap?: number } = {}) {
    this.logPath = opts.logPath;
    this.cap = Math.max(1, Math.floor(opts.cap ?? 256) || 256);
  }

  /** Drop orphaned starts. Subsequent updates cannot create a new call. */
  clear(): void { this.pending.clear(); }

  observe(sessionId: string | null | undefined, u: unknown, context: Attribution): AiLocSample[] {
    if (!record(u) || (u.sessionUpdate !== "tool_call" && u.sessionUpdate !== "tool_call_update") ||
        typeof u.toolCallId !== "string" || !u.toolCallId) return [];
    const key = JSON.stringify([sessionId ?? null, u.toolCallId]);
    if (this.settled.has(key)) return [];
    let call = this.pending.get(key);
    if (!call) {
      if (u.sessionUpdate !== "tool_call") return [];
      call = { context: { ...context }, sessionId: sessionId ?? undefined, kind: u.kind };
      this.pending.set(key, call);
      if (this.pending.size > this.cap) this.pending.delete(this.pending.keys().next().value!);
    }
    if (call.kind === undefined && u.kind !== undefined) call.kind = u.kind;
    // Late input is useful, but cannot change already identified mutation counts or attribution.
    call.mutation ??= mutation(call.kind, u.rawInput ?? u.input);
    const rawOutput = record(u.rawOutput) ? u.rawOutput : undefined;
    if (TERMINAL[String(u.status)] !== true && rawOutput?.isError !== true) return [];
    this.pending.delete(key);
    this.settled.add(key);
    if (this.settled.size > 4096) this.settled.delete(this.settled.values().next().value!);
    if (u.status !== "completed" || rawOutput?.isError === true || !call.mutation) return [];

    const completed = call;
    const samples: AiLocSample[] = [];
    const append = (path: string, added: number, removed: number) => {
      const sample = recordAiLoc({ ...completed.context, sessionId: completed.sessionId, tool: completed.mutation!.tool,
        filePath: isAbsolute(path) ? path : resolve(completed.context.repo, path), added, removed }, { logPath: this.logPath });
      if (sample) samples.push(sample);
    };
    if (call.mutation.tool === "write") {
      append(call.mutation.path, call.mutation.added, 0);
      return samples;
    }
    const details = record(rawOutput?.details) ? rawOutput.details : undefined;
    if (!details) return [];
    // Per-file diffs take precedence over the combined diff. Never attribute unnamed results.
    if (Array.isArray(details.perFileResults)) {
      for (const result of details.perFileResults) {
        if (!record(result) || result.isError === true || typeof result.diff !== "string") continue;
        const path = pathString(result.path);
        if (!path) continue;
        const counts = countDiffLines(result.diff);
        append(path, counts.added, counts.removed);
      }
    } else if (typeof details.diff === "string") {
      const path = pathString(details.path) ?? call.mutation.path;
      if (path) {
        const counts = countDiffLines(details.diff);
        append(path, counts.added, counts.removed);
      }
    }
    return samples;
  }
}
