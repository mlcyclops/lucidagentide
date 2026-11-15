// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/bench/devset/runner.ts - P-BENCH.2a (ADR-0591): run the dev set through a real omp session.
//
// Each task gets its own session, built the way a LUCID lane is: the data arrives as the result of an MCP
// tool, so omp stores a long one as an artifact and shows the model a head and a tail; the MCP result gate
// scans and fences it; and, when `tools` is on, the artifact tools are loaded. What is scored is therefore
// the lane, not a prompt: window, gate, tools and model together.
//
// A model is anything that can open such a session:
//   policyModel     a scripted reference (policies.ts) on omp's in-process mock model. No network.
//   endpointModel   a real model behind an OpenAI-compatible endpoint (Ollama, llama.cpp, vLLM, LM Studio),
//                   declared to omp the way LUCID's Local Providers declare one.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type } from "arktype";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { Type } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-typebox";
import { cfgToolsXdev } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { artifactTools } from "../../omp/artifact_tools_extension.ts";
import { createMcpResultGate } from "../../omp/mcp_result_gate.ts";
import type { ScannerClient } from "../../security/scanner_client.ts";
import { createEchoSession } from "../../testing/echo.ts";
import { FETCH_TOOL, type Policy, type Transcript } from "./policies.ts";
import { extractAnswer, scoreReply, type TaskResult } from "./scorer.ts";
import type { DevTask } from "./tasks.ts";

type SessionOpts = NonNullable<Parameters<typeof createAgentSession>[0]>;
type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];

export interface SessionSpec {
  customTools: NonNullable<SessionOpts["customTools"]>;
  extensions: NonNullable<SessionOpts["extensions"]>;
  /** The ONLY tools the model is offered, each as a top-level tool. omp's built-ins (read, bash, eval,
   *  write and the rest) are left out, so the data reaches the model only through the fetch tool's result
   *  and, when loaded, the artifact tools: the dev set measures that mechanism and nothing around it. */
  toolNames: string[];
  settings?: SessionOpts["settings"];
}

/** The session options that offer a model exactly `spec.toolNames` as top-level tools. omp's
 *  `restrictToolNames` is not used: a restricted session also drops the extensions it is given, and the
 *  result gate is one. Device mode (`xd://`) is turned off so no tool hides behind `write`. */
function restrictTo(spec: SessionSpec): Pick<SessionOpts, "toolNames" | "settings"> {
  const settings = spec.settings ?? Settings.isolated({});
  cfgToolsXdev.override(settings, false);
  return { toolNames: spec.toolNames, settings };
}
export interface OpenSession { session: Session; cleanup(): void | Promise<void> }

/** End a session the way omp expects: `dispose` takes it out of omp's process-wide agent registry. A session
 *  that is only dropped stays registered as "Main", and the next one to start can be told it was replaced. */
async function disposeSession(session: Session): Promise<void> {
  try { await (session as unknown as { dispose?: () => unknown }).dispose?.(); } catch { /* already gone */ }
}
export interface BenchModel {
  /** How the model is named in a report. */
  label: string;
  open(spec: SessionSpec): Promise<OpenSession>;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (typeof c === "object" && c !== null && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("");
}

/** A scripted reference model: the policy decides each step from what the session has shown it. */
export function policyModel(label: string, policy: Policy): BenchModel {
  return {
    label,
    async open(spec) {
      const handler = (context: { messages: readonly { role?: string; toolName?: string; content?: unknown }[] }) => {
        const t: Transcript = {
          prompt: textOf(context.messages.find((m) => m.role === "user")?.content),
          results: context.messages.filter((m) => m.role === "toolResult").map((m) => ({ name: m.toolName ?? "", text: textOf(m.content) })),
        };
        const step = policy(t);
        return "call" in step ? { content: [{ type: "toolCall" as const, name: step.call.name, arguments: step.call.arguments }] } : { content: [step.answer] };
      };
      const s = await createEchoSession({ handler: handler as never, customTools: spec.customTools, extensions: spec.extensions, ...restrictTo(spec) });
      return { session: s.session, cleanup: async () => { await disposeSession(s.session); s.cleanup(); } };
    },
  };
}

export interface EndpointOptions {
  /** How the model is named in a report. Defaults to the model id. */
  label?: string;
  /** The OpenAI-compatible base URL, ending in /v1 for most servers. */
  baseUrl: string;
  /** The model id the server knows (an Ollama tag, a vLLM served name). */
  model: string;
  /** The model's context window in tokens, as measured on the endpoint, not as advertised. */
  contextWindow: number;
  maxTokens?: number;
  /** The NAME of the environment variable holding a bearer key, when the endpoint wants one. omp resolves
   *  the name from the environment, the way a Local Provider's key reaches it; the key is never written. */
  apiKeyEnv?: string;
}

const PROVIDER = "benchlocal";

/** PURE: the models.yml that declares one endpoint model to omp, in the shape LUCID's Local Providers write. */
export function endpointModelsYaml(o: EndpointOptions): string {
  const q = (s: string): string => JSON.stringify(s);
  return [
    "providers:",
    `  ${PROVIDER}:`,
    `    baseUrl: ${q(o.baseUrl.trim())}`,
    "    api: openai-completions",
    o.apiKeyEnv ? `    apiKey: ${q(o.apiKeyEnv)}` : "    auth: none",
    "    models:",
    `      - id: ${q(o.model)}`,
    `        name: ${q(o.label ?? o.model)}`,
    "        reasoning: false",
    "        input: [text]",
    "        supportsTools: true",
    "        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }",
    `        contextWindow: ${Math.max(1024, Math.trunc(o.contextWindow))}`,
    `        maxTokens: ${Math.max(256, Math.trunc(o.maxTokens ?? 2048))}`,
    "",
  ].join("\n");
}

/** A real model behind an OpenAI-compatible endpoint. */
export function endpointModel(o: EndpointOptions): BenchModel {
  return {
    label: o.label ?? o.model,
    async open(spec) {
      const cwd = mkdtempSync(join(tmpdir(), "lucid-bench-"));
      const done = (): void => { try { rmSync(cwd, { recursive: true, force: true }); } catch { /* a temp folder */ } };
      try {
        writeFileSync(join(cwd, "models.yml"), endpointModelsYaml(o), "utf8");
        const authStorage = await AuthStorage.create(join(cwd, "auth.db"));
        const modelRegistry = new ModelRegistry(authStorage, join(cwd, "models.yml"));
        const model = modelRegistry.find(PROVIDER, o.model);
        if (!model) throw new Error(`omp did not accept the model "${o.model}" at ${o.baseUrl}`);
        const { session } = await createAgentSession({ model, cwd, authStorage, modelRegistry, customTools: spec.customTools, extensions: spec.extensions, ...restrictTo(spec) });
        return { session, cleanup: async () => { await disposeSession(session); try { authStorage.close(); } catch { /* closing */ } done(); } };
      } catch (e) { done(); throw e; }
    },
  };
}

/** PURE: what the model is asked. The scoring rule and the fetch tool are always named; the artifact tools
 *  only when they are loaded. */
export function taskPrompt(task: Pick<DevTask, "question">, tools: boolean): string {
  return [
    "You are being scored on one question about a large piece of data.",
    `Call the tool ${FETCH_TOOL} once to get the data.`,
    ...(tools ? ["When the data is long you are shown only its beginning and end, with a handle such as artifact://0. The answer may be in the part you were not shown. Use the artifact tools on that handle (artifact_lookup for exact keys, artifact_find to search, artifact_count to count, artifact_track for the final value after ordered changes, artifact_slice to read lines). Do not guess."] : []),
    `Question: ${task.question}`,
    "End your reply with one line of the form:",
    "ANSWER: <your answer>",
  ].join("\n");
}

export interface RunOptions {
  /** Load the artifact tools into the session. Off measures the lane without them. */
  tools: boolean;
  scanner: ScannerClient;
  settings?: SessionOpts["settings"];
  /** Wall-clock limit for one task. A task that runs past it scores 0 and is marked failed. */
  timeoutMs?: number;
}

/** The tools artifact_tools_extension.ts registers, offered to the model when `tools` is on. */
export const ARTIFACT_TOOLS: string[] = artifactTools(Type).map((t) => t.name);

/** The artifact tools as session custom tools. An extension tool runs as (id, params, signal, onUpdate, ctx)
 *  and a custom tool as (id, params, onUpdate, ctx, signal); the definitions are the lane's own. */
function artifactCustomTools(): CustomTool[] {
  return artifactTools(Type).map((t) => ({ ...t, execute: (id: string, params: unknown, onUpdate: unknown, ctx: unknown, signal: unknown) => t.execute(id, params, signal, onUpdate, ctx) }) as unknown as CustomTool);
}

const OPEN_ATTEMPTS = 4;
const REPLACED = /was replaced during session initialization/;

/** Run one task in its own session and score the reply. Never throws: a failure is a result with a 0. */
export async function runTask(model: BenchModel, task: DevTask, opts: RunOptions): Promise<TaskResult> {
  const fetchTool = { name: FETCH_TOOL, label: "Fetch the data", description: "Return the data the question is about.", parameters: type({ "n?": "number" }), async execute() { return { content: [{ type: "text", text: task.haystack }] }; } } as unknown as CustomTool;
  const base = { id: task.id, family: task.family, length: task.length };
  const tools: string[] = [];
  let contextChars = 0;
  let reply = "";
  let open: OpenSession | null = null;
  try {
    const spec: SessionSpec = {
      // The artifact tools are the same definitions artifact_tools_extension.ts registers in a lane, passed
      // as the session's own tools: a restricted session drops tools an extension registers.
      customTools: [fetchTool, ...(opts.tools ? artifactCustomTools() : [])] as never,
      extensions: [createMcpResultGate(opts.scanner)] as never,
      toolNames: [FETCH_TOOL, ...(opts.tools ? ARTIFACT_TOOLS : [])],
      ...(opts.settings ? { settings: opts.settings } : {}),
    };
    // omp keeps one agent registry per process. If anything else in the process starts a session while
    // this one is starting, omp refuses one of them. That is a collision, not a result, so the session is
    // simply opened again, a few times at most.
    for (let attempt = 1; open === null; attempt++) {
      try { open = await model.open(spec); } catch (e) {
        if (attempt >= OPEN_ATTEMPTS || !REPLACED.test(String((e as { message?: unknown })?.message ?? e))) throw e;
        await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
      }
    }
    open.session.subscribe((ev: unknown) => {
      const e = ev as { type?: string; message?: { role?: string; toolName?: string; content?: unknown } };
      if (e?.type !== "message_end" || !e.message) return;
      if (e.message.role === "assistant") { const t = textOf(e.message.content); if (t.trim()) reply = t; }
      else if (e.message.role === "toolResult") { tools.push(e.message.toolName ?? ""); contextChars += textOf(e.message.content).length; }
    });
    const limit = opts.timeoutMs ?? 180_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), limit); });
    const outcome = await Promise.race([open.session.prompt(taskPrompt(task, opts.tools)).then(() => "done" as const), timedOut]);
    clearTimeout(timer);
    if (outcome === "timeout") {
      try { await (open.session as unknown as { abort?: () => Promise<void> }).abort?.(); } catch { /* already stopping */ }
      return { ...base, score: 0, given: extractAnswer(reply), contextChars, tools, error: `no answer within ${Math.round(limit / 1000)} seconds` };
    }
    return { ...base, score: scoreReply(task, reply), given: extractAnswer(reply), contextChars, tools };
  } catch (e) {
    return { ...base, score: 0, given: extractAnswer(reply), contextChars, tools, error: String((e as { message?: unknown })?.message ?? e).slice(0, 240) };
  } finally {
    try { await open?.cleanup(); } catch { /* closing */ }
  }
}

/** Run every task, one after another, reporting each as it finishes. */
export async function runDevset(model: BenchModel, tasks: readonly DevTask[], opts: RunOptions, onResult?: (r: TaskResult) => void): Promise<TaskResult[]> {
  const out: TaskResult[] = [];
  for (const task of tasks) {
    const r = await runTask(model, task, opts);
    out.push(r);
    onResult?.(r);
  }
  return out;
}
