// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/mcp/testing/fake_acp_script.ts
//
// The pure half of the fake ACP agent's `script` mode (FAKE_ACP_MODE=script): QA and video footage only,
// never used by the product at runtime. A script is a JSON file (desktop/scripts/fleet_demo/scripts/*.json)
// describing one believable agent turn: streamed prose, thinking, reads, edits, shell runs with their
// output, one permission ask, a `task` delegation whose subagents write real transcripts, and a usage
// report. This module picks the script for a prompt and replays its steps through an injected io, so the
// timing, the ACP update shapes and the subagent transcript lines are unit-tested without a process,
// a clock or a file system. fake_acp_agent.ts supplies the real io (stdout, timers, files).
//
// Subagent transcripts follow omp's layout, the one desktop/subagent_activity.ts reads: a JSONL per run
// with a `session` header, a `model_change`, the assignment as the first user message, then assistant
// messages carrying `thinking` / `toolCall` / `text` content, and a `<Name>.md` result once the run ends.

export interface ScriptEdit { old_text: string; new_text: string }

/** One background subagent step, written to its transcript after `ms` (default 2500). */
export type SubStep =
  | { type: "think"; text: string; ms?: number }
  | { type: "tool"; name: string; args: Record<string, unknown>; output?: string; ms?: number }
  | { type: "say"; text: string; ms?: number };

export interface SubTask { name: string; agent?: string; task: string; steps: SubStep[]; result: string }

export type ScriptStep =
  | { type: "say"; text: string }
  | { type: "think"; text: string }
  | { type: "read"; path: string; output: string; i?: string; ms?: number }
  | { type: "search"; pattern: string; paths?: string[]; output: string; i?: string; ms?: number }
  | { type: "edit"; path: string; edits: ScriptEdit[]; i?: string; ms?: number }
  | { type: "create"; path: string; content: string; i?: string; ms?: number }
  | { type: "bash"; command: string; output: string; i?: string; ms?: number }
  /** The session's one permission ask: a shell command the user approves or denies. Allowed, it runs and
   *  prints `output`; denied, the call fails and the `deny` steps replay instead, then the script goes on. */
  | { type: "ask"; command: string; output: string; deny: ScriptStep[]; title?: string; i?: string; ms?: number }
  | { type: "task"; context: string; tasks: SubTask[] }
  /** Wait for every background subagent started so far (omp's hub wait). */
  | { type: "join" }
  | { type: "usage"; used: number; size: number; cost: number }
  | { type: "pause"; ms: number };

export interface FleetScript {
  id: string;
  title: string;
  /** The prompt the seeder sends to select this script (and the test proves it does). */
  prompt: string;
  /** Case-insensitive whole-word phrases; the script with the highest summed phrase length wins. */
  keywords: string[];
  /** Chosen when no keyword matches. */
  default?: boolean;
  /** P-BUDDY.1: a side completion's canned answer (e.g. the buddy's ideas JSON), not fleet demo footage. */
  side?: boolean;
  model?: string;
  steps: ScriptStep[];
}

export interface ReplayIo {
  /** Send one `session/update` payload (the `update` object). */
  emit(update: Record<string, unknown>): void;
  sleep(ms: number): Promise<void>;
  /** Ask permission for this tool call; true = allowed. */
  ask(toolCall: Record<string, unknown>): Promise<boolean>;
  /** Subagent transcript sink, or null when the session has no file (the runs are then only timed). */
  transcript: { append(name: string, line: string): void; finish(name: string, markdown: string): void } | null;
  now(): number;
  cwd: string;
  /** A session/cancel arrived: stop at the next step boundary. */
  cancelled(): boolean;
}

export interface ReplayResult { text: string; tools: number; usage: { used: number; size: number; cost: number } | null; cancelled: boolean; allowed: boolean | null }

export const DEFAULT_MODEL = "lucid-demo/coder-large";

export const BUILTIN_DEFAULT_SCRIPT: FleetScript = {
  id: "builtin-default",
  title: "Generic small change",
  prompt: "Take a look at the repo",
  keywords: [],
  default: true,
  steps: [
    { type: "think", text: "No specific script matched this prompt, so I will survey the repo and report back." },
    { type: "read", path: "README.md", output: "# sample-service\n\nA small HTTP service used for QA footage.\n", i: "Reading project overview", ms: 900 },
    { type: "bash", command: "bun test", output: "12 pass\n0 fail\nRan 12 tests across 4 files. [1.21s]", i: "Running the test suite", ms: 3000 },
    { type: "say", text: "The repo is healthy: 12 tests pass and nothing is pending. Tell me what to build next." },
    { type: "usage", used: 9_400, size: 200_000, cost: 0.021 },
  ],
};

// ── picking ─────────────────────────────────────────────────────────────────────────────────────────────

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The script for this prompt: an explicit `[script <id>]` marker, else the best keyword match, else the
 *  default script, else the first. Null only for an empty list. */
export function pickScript(scripts: readonly FleetScript[], prompt: string): FleetScript | null {
  const marker = /\[script ([\w-]+)\]/.exec(prompt);
  const named = marker ? scripts.find((s) => s.id === marker[1]) : undefined;
  if (named) return named;
  let best: FleetScript | null = null;
  let bestScore = 0;
  for (const s of scripts) {
    let score = 0;
    for (const k of s.keywords) if (new RegExp(`\\b${escapeRe(k)}\\b`, "i").test(prompt)) score += k.length;
    if (score > bestScore) { best = s; bestScore = score; }
  }
  return best ?? scripts.find((s) => s.default) ?? scripts[0] ?? null;
}

// ── validation ──────────────────────────────────────────────────────────────────────────────────────────

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const optNum = (v: unknown): boolean => v === undefined || isNum(v);
/** Parsed JSON as a record to probe field by field; a non-object probes as empty. */
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? v as Record<string, unknown> : {});

function checkSub(s: unknown, at: string): void {
  if (!s || typeof s !== "object") throw new Error(`${at}: not an object`);
  const o = rec(s);
  if (!optNum(o.ms)) throw new Error(`${at}: bad ms`);
  if ((o.type === "think" || o.type === "say") && isStr(o.text)) return;
  if (o.type === "tool" && isStr(o.name) && o.args && typeof o.args === "object" && (o.output === undefined || isStr(o.output))) return;
  throw new Error(`${at}: unknown or malformed subagent step`);
}

function checkStep(s: unknown, at: string): void {
  if (!s || typeof s !== "object") throw new Error(`${at}: not an object`);
  const o = rec(s);
  if (!optNum(o.ms)) throw new Error(`${at}: bad ms`);
  if (o.i !== undefined && !isStr(o.i)) throw new Error(`${at}: bad i`);
  const ok = (() => {
    switch (o.type) {
      case "say": case "think": return isStr(o.text) && o.text.length > 0;
      case "read": return isStr(o.path) && isStr(o.output);
      case "search": return isStr(o.pattern) && isStr(o.output) && (o.paths === undefined || (Array.isArray(o.paths) && o.paths.every(isStr)));
      case "edit": return isStr(o.path) && Array.isArray(o.edits) && o.edits.length > 0 && o.edits.every((e) => isStr(rec(e).old_text) && isStr(rec(e).new_text));
      case "create": return isStr(o.path) && isStr(o.content);
      case "bash": return isStr(o.command) && isStr(o.output);
      case "ask": {
        if (!isStr(o.command) || !isStr(o.output) || !Array.isArray(o.deny)) return false;
        o.deny.forEach((d, i) => { if (rec(d).type === "ask") throw new Error(`${at}.deny[${i}]: a deny path cannot ask again`); checkStep(d, `${at}.deny[${i}]`); });
        return true;
      }
      case "task": {
        if (!isStr(o.context) || !Array.isArray(o.tasks) || o.tasks.length === 0) return false;
        o.tasks.forEach((t, i) => {
          const r = rec(t);
          if (!isStr(r.name) || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(r.name) || !isStr(r.task) || !isStr(r.result) || !Array.isArray(r.steps)) throw new Error(`${at}.tasks[${i}]: malformed task`);
          r.steps.forEach((x, j) => checkSub(x, `${at}.tasks[${i}].steps[${j}]`));
        });
        return true;
      }
      case "join": return true;
      case "usage": return isNum(o.used) && isNum(o.size) && isNum(o.cost);
      case "pause": return isNum(o.ms);
      default: return false;
    }
  })();
  if (!ok) throw new Error(`${at}: unknown or malformed step (${String(o.type)})`);
}

/** Parse and validate one script file. Throws with the offending step's path. */
export function parseScript(json: string): FleetScript {
  const o = rec(JSON.parse(json));
  if (!isStr(o.id) || !/^[\w-]+$/.test(o.id)) throw new Error("script: bad id");
  if (!isStr(o.title) || !isStr(o.prompt)) throw new Error(`${o.id}: title and prompt are required`);
  if (!Array.isArray(o.keywords) || !o.keywords.every(isStr)) throw new Error(`${o.id}: keywords must be strings`);
  if (o.model !== undefined && !isStr(o.model)) throw new Error(`${o.id}: bad model`);
  if (o.side !== undefined && typeof o.side !== "boolean") throw new Error(`${o.id}: bad side`);
  if (!Array.isArray(o.steps) || o.steps.length === 0) throw new Error(`${o.id}: no steps`);
  o.steps.forEach((s, i) => checkStep(s, `${o.id}.steps[${i}]`));
  if (o.steps.filter((s) => rec(s).type === "ask").length > 1) throw new Error(`${o.id}: at most one ask per script`);
  return o as unknown as FleetScript;
}

/** True when a session/request_permission result selected an allow option. Anything else is a deny. */
export function permissionAllowed(result: unknown): boolean {
  const out = rec(rec(result).outcome);
  return out.outcome === "selected" && /allow/i.test(String(out.optionId ?? ""));
}

// ── streaming ───────────────────────────────────────────────────────────────────────────────────────────

const GROUP = [3, 2, 4, 1, 3, 5, 2];

/** Split prose into natural streaming chunks of a few words, breaking after punctuation and newlines.
 *  Lossless: the chunks concatenate to the input exactly. */
export function chunkProse(text: string): string[] {
  const words = text.match(/\S+\s*|\s+/g) ?? [];
  const out: string[] = [];
  let cur = "";
  let n = 0;
  let k = 0;
  for (const w of words) {
    cur += w;
    n++;
    if (n >= GROUP[k % GROUP.length]! || /[.!?:;,]\s*$/.test(w) || w.includes("\n")) { out.push(cur); cur = ""; n = 0; k++; }
  }
  if (cur) out.push(cur);
  return out;
}

/** Pause after one streamed chunk: longer chunks take longer, thinking streams a little faster. */
export function chunkDelay(chunk: string, thinking = false): number {
  return thinking ? Math.min(120, 20 + chunk.length * 3) : Math.min(160, 30 + chunk.length * 4);
}

const TOOL_MS = { read: 900, search: 1200, edit: 1500, create: 1800, bash: 3500, ask: 3000 } as const;
const SUB_STEP_MS = 2500;

// ── replay ──────────────────────────────────────────────────────────────────────────────────────────────

/** Replay one script as one agent turn. `idPrefix` keeps tool call ids unique within the session and
 *  `nameSuffix` keeps subagent transcript names unique when a session runs the same script twice. */
export async function replayScript(script: FleetScript, io: ReplayIo, opts: { idPrefix: string; nameSuffix?: string }): Promise<ReplayResult> {
  const model = script.model ?? DEFAULT_MODEL;
  let seq = 0;
  const nextId = (): string => `${opts.idPrefix}-call-${++seq}`;
  const background: Promise<void>[] = [];
  const res: ReplayResult = { text: "", tools: 0, usage: null, cancelled: false, allowed: null };

  const stream = async (kind: "agent_message_chunk" | "agent_thought_chunk", body: string): Promise<void> => {
    for (const c of chunkProse(body)) {
      io.emit({ sessionUpdate: kind, content: { type: "text", text: c } });
      await io.sleep(chunkDelay(c, kind === "agent_thought_chunk"));
    }
  };
  const result = (toolCallId: string, output: string, status = "completed"): void => {
    io.emit({ sessionUpdate: "tool_call_update", toolCallId, status, content: [{ type: "content", content: { type: "text", text: output } }], rawOutput: { output } });
  };
  const tool = async (title: string, kind: string, rawInput: Record<string, unknown>, ms: number, output: string): Promise<void> => {
    const toolCallId = nextId();
    res.tools++;
    io.emit({ sessionUpdate: "tool_call", toolCallId, title, kind, status: "pending", rawInput });
    await io.sleep(ms);
    result(toolCallId, output);
  };
  const withIntent = (i: string | undefined, o: Record<string, unknown>): Record<string, unknown> => (i ? { ...o, i } : o);

  const runSubagent = async (t: SubTask, context: string, name: string): Promise<void> => {
    const tr = io.transcript;
    const at = (): string => new Date(io.now()).toISOString();
    let msg = 0;
    const line = (o: Record<string, unknown>): void => { tr?.append(name, JSON.stringify(o)); };
    const message = (role: string, content: unknown[], extra: Record<string, unknown> = {}): void =>
      line({ type: "message", id: `${name}-m${++msg}`, timestamp: at(), message: { role, content, timestamp: io.now(), ...extra } });
    line({ type: "session", version: 3, id: `${name}-${opts.idPrefix}`, timestamp: at(), cwd: io.cwd });
    line({ type: "model_change", timestamp: at(), model });
    message("user", [{ type: "text", text: `Complete the assignment below, thoroughly:\n${t.task}\n\n# Shared context\n${context}` }]);
    let call = 0;
    for (const s of t.steps) {
      await io.sleep(s.ms ?? SUB_STEP_MS);
      if (s.type === "think") message("assistant", [{ type: "thinking", thinking: s.text }], { model });
      else if (s.type === "say") message("assistant", [{ type: "text", text: s.text }], { model });
      else {
        const id = `${name}-tc${++call}`;
        message("assistant", [{ type: "toolCall", id, name: s.name, arguments: s.args }], { model });
        message("toolResult", [{ type: "text", text: s.output ?? "ok" }], { toolCallId: id, toolName: s.name });
      }
    }
    await io.sleep(800);
    message("assistant", [{ type: "toolCall", id: `${name}-yield`, name: "yield", arguments: { data: { summary: t.result.split("\n")[0] } } }], { model });
    tr?.finish(name, t.result);
  };

  const run = async (steps: readonly ScriptStep[]): Promise<void> => {
    for (const s of steps) {
      if (io.cancelled()) { res.cancelled = true; return; }
      switch (s.type) {
        case "say": res.text += s.text; await stream("agent_message_chunk", s.text); break;
        case "think": await stream("agent_thought_chunk", s.text); break;
        case "read": await tool(`read ${s.path}`, "read", withIntent(s.i, { path: s.path }), s.ms ?? TOOL_MS.read, s.output); break;
        case "search": await tool(`grep ${s.pattern}`, "search", withIntent(s.i, { pattern: s.pattern, ...(s.paths ? { paths: s.paths } : {}) }), s.ms ?? TOOL_MS.search, s.output); break;
        case "edit": await tool(`edit ${s.path}`, "edit", withIntent(s.i, { path: s.path, edits: s.edits }), s.ms ?? TOOL_MS.edit, `Updated ${s.path} (${s.edits.length} edit${s.edits.length === 1 ? "" : "s"})`); break;
        case "create": await tool(`write ${s.path}`, "edit", withIntent(s.i, { path: s.path, content: s.content }), s.ms ?? TOOL_MS.create, `Wrote ${s.path} (${s.content.split("\n").length} lines)`); break;
        case "bash": await tool(`bash ${s.command}`, "execute", withIntent(s.i, { command: s.command, timeout: 120 }), s.ms ?? TOOL_MS.bash, s.output); break;
        case "ask": {
          const toolCallId = nextId();
          const rawInput = withIntent(s.i, { command: s.command, timeout: 300 });
          const title = s.title ?? `bash ${s.command}`;
          res.tools++;
          io.emit({ sessionUpdate: "tool_call", toolCallId, title, kind: "execute", status: "pending", rawInput });
          const allowed = await io.ask({ toolCallId, title, kind: "execute", rawInput });
          res.allowed = allowed;
          if (allowed) { await io.sleep(s.ms ?? TOOL_MS.ask); result(toolCallId, s.output); }
          else { result(toolCallId, "Permission denied by the user.", "failed"); await run(s.deny); }
          break;
        }
        case "task": {
          const toolCallId = nextId();
          const names = s.tasks.map((t) => `${t.name}${opts.nameSuffix ?? ""}`);
          res.tools++;
          io.emit({ sessionUpdate: "tool_call", toolCallId, title: "task", kind: "other", status: "pending", rawInput: { context: s.context, tasks: s.tasks.map((t, i) => ({ name: names[i], agent: t.agent ?? "task", task: t.task })) } });
          s.tasks.forEach((t, i) => background.push(runSubagent(t, s.context, names[i]!)));
          await io.sleep(700);
          result(toolCallId, `Spawned ${s.tasks.length} background agent${s.tasks.length === 1 ? "" : "s"}: ${names.join(", ")}`);
          break;
        }
        case "join": {
          const toolCallId = nextId();
          io.emit({ sessionUpdate: "tool_call", toolCallId, title: "hub", kind: "other", status: "pending", rawInput: { op: "wait" } });
          await Promise.all(background.splice(0));
          result(toolCallId, "All background agents finished.");
          break;
        }
        case "usage": res.usage = { used: s.used, size: s.size, cost: s.cost }; io.emit({ sessionUpdate: "usage_update", used: s.used, size: s.size, cost: { amount: s.cost, currency: "USD" } }); break;
        case "pause": await io.sleep(s.ms); break;
      }
    }
  };

  await run(script.steps);
  // A script that never joined still lets its subagents finish, so every run gets its result file.
  await Promise.all(background.splice(0));
  if (io.cancelled()) res.cancelled = true;
  return res;
}
