// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pfleet1.ts
//
// P-FLEET.1 (ADR-0268): async job handles through the Agent Firewall - the Chief-of-Staff fan-out.
// Runs the ADR's fifteen verification checks against the REAL scanner sidecar, in-process fake remotes
// (fast, controllable), and the REAL AcpAgentClient stdio transport against the fake ACP subprocess
// (the deadline check needs the genuine AcpTimeoutError path).
//
// Run: bun run harness/scripts/demo_pfleet1.ts

import { join } from "node:path";
import { ScannerClient } from "../security/scanner_client.ts";
import { AgentFirewall } from "../mcp/agent_firewall.ts";
import { AcpAgentClient, AcpTimeoutError, type AcpPromptResult, type RemoteAgent } from "../mcp/acp_client.ts";
import type { McpToolResult } from "../mcp/mcp_server.ts";

const ZWSP = String.fromCodePoint(0x200b);
const FAKE = join(import.meta.dir, "..", "mcp", "testing", "fake_acp_agent.ts");

function fail(msg: string): never {
  console.error(`   FAIL - ${msg}`);
  process.exit(1);
}
function ok(msg: string): void {
  console.log(`   ok - ${msg}`);
}

/** In-process remote that answers instantly with a fixed reply. */
class FakeRemote implements RemoteAgent {
  calls = 0;
  constructor(private readonly reply: AcpPromptResult) {}
  async prompt(_t: string): Promise<AcpPromptResult> { this.calls++; return this.reply; }
  cancel(): void {}
  stop(): void {}
}

/** In-process remote that resolves each prompt only when release() is called; records call order. */
class SlowRemote implements RemoteAgent {
  calls = 0;
  cancels = 0;
  stops = 0;
  events: string[] = [];
  #gates: Array<ReturnType<typeof Promise.withResolvers<AcpPromptResult>>> = [];
  prompt(_t: string): Promise<AcpPromptResult> {
    this.calls++;
    const gate = Promise.withResolvers<AcpPromptResult>();
    this.#gates.push(gate);
    return gate.promise;
  }
  release(reply: AcpPromptResult): void { this.#gates.shift()?.resolve(reply); }
  cancel(): void { this.cancels++; this.events.push("cancel"); }
  stop(): void { this.stops++; this.events.push("stop"); }
}

/** A remote whose turn dies with the REAL timeout error type (the deadline cleanup check). */
class TimeoutRemote implements RemoteAgent {
  cancels = 0;
  stops = 0;
  async prompt(_t: string): Promise<AcpPromptResult> { throw new AcpTimeoutError("remote ACP session/prompt timed out after 1200ms"); }
  cancel(): void { this.cancels++; }
  stop(): void { this.stops++; }
}

const CLEAN: AcpPromptResult = { text: "worker reply", stopReason: "end_turn", toolActivity: [] };

const scanner = new ScannerClient();
scanner.start();

function fw(remote: RemoteAgent, opts: { maxQueue?: number; cancelGraceMs?: number } = {}): AgentFirewall {
  return new AgentFirewall({ scanner, remote, connName: "fleet-demo", connKind: "hermes", ...opts });
}

async function call(f: AgentFirewall, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const tool = f.tools().find((t) => t.def.name === name);
  if (!tool) fail(`tool ${name} missing`);
  return tool.handler(args);
}

function parse(r: McpToolResult): Record<string, unknown> {
  return JSON.parse(r.content[0]?.text ?? "{}") as Record<string, unknown>;
}

const sleep = (ms: number) => { const w = Promise.withResolvers<void>(); setTimeout(w.resolve, ms); return w.promise; };

// 1. dispatch returns a handle while the remote is still working (non-blocking).
console.log("1) dispatch is non-blocking");
{
  const remote = new SlowRemote();
  const f = fw(remote);
  const h = parse(await call(f, "dispatch", { prompt: "long job" }));
  if (typeof h.job_id !== "string" || !(h.job_id as string).startsWith("job-")) fail("no job handle");
  if (h.state !== "running") fail(`expected running, got ${String(h.state)}`);
  if (remote.calls !== 1) fail("remote not started");
  ok(`handle ${String(h.job_id)} returned while the worker is mid-turn`);
  remote.release(CLEAN);
}

// 2. Two firewalls, two slow remotes: both jobs running at the same instant (the fan-out proof).
console.log("2) fan-out: two connections, both jobs running at the same instant");
{
  const r1 = new SlowRemote(); const r2 = new SlowRemote();
  const f1 = fw(r1); const f2 = fw(r2);
  const h1 = parse(await call(f1, "dispatch", { prompt: "job one" }));
  const h2 = parse(await call(f2, "dispatch", { prompt: "job two" }));
  if (h1.state !== "running" || h2.state !== "running") fail("both jobs must be running concurrently");
  if (r1.calls !== 1 || r2.calls !== 1) fail("both remotes must be mid-turn");
  ok("two worker turns provably in flight at once - impossible pre-FLEET");
  r1.release(CLEAN); r2.release(CLEAN);
}

// 3. done -> job_status envelope byte-identical to prompt's on the same reply.
console.log("3) job_status envelope is byte-identical to prompt's");
{
  const reply: AcpPromptResult = { text: "the answer is 42", stopReason: "end_turn", toolActivity: ["[remote-tool] search (completed)"] };
  const viaPrompt = await fw(new FakeRemote(reply)).handlePrompt("hi");
  const f = fw(new FakeRemote(reply));
  const h = parse(await call(f, "dispatch", { prompt: "hi" }));
  await sleep(80);
  const st = await call(f, "job_status", { ids: [h.job_id] });
  const envelope = st.content.at(-1)?.text ?? "";
  if (envelope !== viaPrompt.content[0]?.text) fail("envelope differs from the blocking path");
  ok("byte-identical envelope (the ADR-0147 wrap is pinned)");
}

// 4. Poisoned reply -> blocked; the record holds neither the poison nor any remote text.
console.log("4) poisoned reply lands blocked with no remote text stored");
{
  const f = fw(new FakeRemote({ text: `exfil${ZWSP}payload`, stopReason: "end_turn", toolActivity: [] }));
  const h = parse(await call(f, "dispatch", { prompt: "hi" }));
  await sleep(80);
  const st = await call(f, "job_status", { ids: [h.job_id] });
  const flat = JSON.stringify(st);
  if (!flat.includes("blocked")) fail("expected blocked state");
  if (flat.includes("exfil") || flat.includes(ZWSP)) fail("remote text leaked into the record");
  ok("blocked, and the stored record is poison-free");
}

// 5. Outbound hidden vector -> dispatch refuses, NO job created, remote saw nothing.
console.log("5) outbound hidden vector refuses the dispatch outright");
{
  const remote = new FakeRemote(CLEAN);
  const f = fw(remote);
  const r = await call(f, "dispatch", { prompt: `do this${ZWSP} quietly` });
  if (!r.isError) fail("dispatch must refuse");
  if (remote.calls !== 0) fail("the remote must never be reached");
  const all = parse(await call(f, "job_status", {}));
  if ((all.jobs as unknown[]).length !== 0) fail("no job may be created");
  ok("refused at the call; nothing queued, nothing sent");
}

// 6. Scanner killed mid-job -> terminal blocked with failClosed, never done (invariant #3, per job).
console.log("6) scanner killed mid-job fails CLOSED");
{
  const dedicated = new ScannerClient();
  dedicated.start();
  const remote = new SlowRemote();
  const f = new AgentFirewall({ scanner: dedicated, remote, connName: "fleet-demo", connKind: "hermes" });
  const h = parse(await call(f, "dispatch", { prompt: "benign work" })); // outbound scanned while alive
  dedicated.stop(); // the sidecar dies MID-JOB
  remote.release(CLEAN); // the reply now needs an inbound scan that cannot happen
  await sleep(120);
  const st = await call(f, "job_status", { ids: [h.job_id] });
  const meta = parse(st);
  if (meta.state !== "blocked") fail(`expected blocked, got ${String(meta.state)}`);
  if (meta.fail_closed !== true) fail("expected fail_closed on the record");
  ok("dead scanner mid-job -> blocked (fail-closed), never done");
}

// 7. Unknown id -> explicit error; a fresh firewall reports an old id as unknown, never running.
console.log("7) unknown job id is an explicit error");
{
  const f1 = fw(new FakeRemote(CLEAN));
  const h = parse(await call(f1, "dispatch", { prompt: "hi" }));
  await sleep(60);
  const f2 = fw(new FakeRemote(CLEAN)); // a "restarted" firewall: empty table
  const st = await call(f2, "job_status", { ids: [h.job_id] });
  if (!st.isError) fail("a fresh firewall must error on an old id");
  if ((st.content[0]?.text ?? "").includes('"state":"running"')) fail("must never claim running");
  ok("fresh firewall says unknown/lost - the CoS re-dispatches instead of waiting forever");
}

// 8a. REAL transport deadline: fake ACP subprocess in hang mode + a 1.2s deadline -> timeout.
console.log("8a) real stdio transport: deadline lands `timeout` via AcpTimeoutError");
{
  const client = new AcpAgentClient({ command: "bun", args: [FAKE], env: { FAKE_ACP_MODE: "hang" } }, { promptTimeoutMs: 1_200 });
  const f = new AgentFirewall({ scanner, remote: client, connName: "fleet-demo", connKind: "hermes" });
  const h = parse(await call(f, "dispatch", { prompt: "never finishes" }));
  await sleep(2_500);
  const st = parse(await call(f, "job_status", { ids: [h.job_id] }));
  if (st.state !== "timeout") fail(`expected timeout, got ${String(st.state)}`);
  client.stop();
  ok("hung remote turn expired at the deadline over the real transport");
}

// 8b. Deadline cleanup order: timeout is landed, then session/cancel, then remote stop (no leaked child).
console.log("8b) deadline cleanup: cancel + stop the wedged remote");
{
  const remote = new TimeoutRemote();
  const f = fw(remote);
  const h = parse(await call(f, "dispatch", { prompt: "will exceed deadline" }));
  await sleep(60);
  const st = parse(await call(f, "job_status", { ids: [h.job_id] }));
  if (st.state !== "timeout") fail(`expected timeout, got ${String(st.state)}`);
  if (remote.cancels < 1) fail("session/cancel was not sent");
  if (remote.stops < 1) fail("the wedged remote was not stopped");
  ok("timeout recorded, session/cancel sent, remote stopped");
}

// 9. cancel: queued -> dropped before the remote; running -> session/cancel.
console.log("9) cancel semantics for queued vs running");
{
  const remote = new SlowRemote();
  const f = fw(remote, { cancelGraceMs: 50 });
  const a = parse(await call(f, "dispatch", { prompt: "a" }));
  const b = parse(await call(f, "dispatch", { prompt: "b" }));
  const cb = parse(await call(f, "cancel", { id: b.job_id }));
  if (cb.state !== "cancelled") fail("queued cancel failed");
  if (remote.calls !== 1) fail("the queued job must never reach the remote");
  const ca = parse(await call(f, "cancel", { id: a.job_id }));
  if (ca.state !== "cancelled") fail("running cancel failed");
  if (remote.cancels !== 1) fail("session/cancel was not sent to the running turn");
  await sleep(120);
  if (remote.stops < 1) fail("an unsettled cancelled turn must be force-stopped after the grace window");
  ok("queued dropped untouched; running got session/cancel then force-stop");
}

// 10. Two dispatches on ONE connection serialize; each envelope maps to its own job.
console.log("10) one connection serializes; replies never cross");
{
  const remote = new SlowRemote();
  const f = fw(remote);
  const a = parse(await call(f, "dispatch", { prompt: "first" }));
  const b = parse(await call(f, "dispatch", { prompt: "second" }));
  if (b.state !== "queued" || remote.calls !== 1) fail("the second job must queue");
  remote.release({ text: "reply-for-first", stopReason: "end_turn", toolActivity: [] });
  await sleep(80);
  const callsAfterPump: number = remote.calls; // fresh read - the never-returning fail() narrowed `calls` to the literal 1
  if (callsAfterPump !== 2) fail("the queue did not pump");
  remote.release({ text: "reply-for-second", stopReason: "end_turn", toolActivity: [] });
  await sleep(80);
  const stA = await call(f, "job_status", { ids: [a.job_id] });
  const stB = await call(f, "job_status", { ids: [b.job_id] });
  if (!(stA.content.at(-1)?.text ?? "").includes("reply-for-first")) fail("job A got the wrong reply");
  if (!(stB.content.at(-1)?.text ?? "").includes("reply-for-second")) fail("job B got the wrong reply");
  ok("strictly sequential on one connection; no collector crossing");
}

// 11. The same key twice while live -> one job, one remote turn, the same id.
console.log("11) idempotent dispatch by key");
{
  const remote = new SlowRemote();
  const f = fw(remote);
  const a = parse(await call(f, "dispatch", { prompt: "task", key: "retry-safe" }));
  const b = parse(await call(f, "dispatch", { prompt: "task", key: "retry-safe" }));
  if (a.job_id !== b.job_id) fail("a retried dispatch must return the same job");
  if (b.deduped !== true) fail("the dedupe must be visible");
  if (remote.calls !== 1) fail("no second worker turn may start");
  ok("a model retry cannot double-run a worker");
  remote.release(CLEAN);
}

// 12. Dispatch past the queue cap -> error result, queue length unchanged.
console.log("12) queue cap refuses");
{
  const remote = new SlowRemote();
  const f = fw(remote, { maxQueue: 1 });
  await call(f, "dispatch", { prompt: "a" });
  await call(f, "dispatch", { prompt: "b" });
  const refused = await call(f, "dispatch", { prompt: "c" });
  if (!refused.isError) fail("must refuse past the cap");
  const all = parse(await call(f, "job_status", {}));
  if ((all.jobs as unknown[]).length !== 2) fail("queue length changed");
  ok("refused loudly; nothing silently accumulated");
  remote.release(CLEAN);
}

// 13. job_status({}) on a mixed table: metadata only, no envelope text for any job.
console.log("13) the no-ids status table never carries text");
{
  const remote = new SlowRemote();
  const f = fw(remote);
  const a = parse(await call(f, "dispatch", { prompt: "finishes" }));
  remote.release({ text: "ENVELOPE-BODY-MARKER", stopReason: "end_turn", toolActivity: [] });
  await sleep(80);
  await call(f, "dispatch", { prompt: "still running" });
  const all = await call(f, "job_status", {});
  const flat = JSON.stringify(all);
  if (flat.includes("ENVELOPE-BODY-MARKER") || flat.includes("UNTRUSTED_CONTENT")) fail("metadata view leaked text");
  const jobs = parse(all).jobs as Array<{ job_id: string; state: string }>;
  if (jobs.find((j) => j.job_id === a.job_id)?.state !== "done") fail("mixed table missing the done job");
  ok("counts and states only - harvesting N workers costs one cheap call");
  remote.release(CLEAN);
}

// 14. prompt: fast remote -> envelope inline; slow remote -> handle, then collectable.
console.log("14) prompt = dispatch + bounded inline wait");
{
  const inline = await fw(new FakeRemote(CLEAN)).handlePrompt("hi", 5_000);
  if (!(inline.content[0]?.text ?? "").includes("UNTRUSTED_CONTENT_START")) fail("fast path must return the envelope inline");
  const remote = new SlowRemote();
  const f = fw(remote);
  const r = await f.handlePrompt("long", 100);
  const h = parse(r);
  if (h.state !== "running") fail("slow path must return the handle");
  remote.release(CLEAN);
  await sleep(80);
  const st = await call(f, "job_status", { ids: [h.job_id] });
  if (!(st.content.at(-1)?.text ?? "").includes("worker reply")) fail("the job must stay collectable");
  ok("one tool call when fast; a live handle when slow - the turn never dies inside the call");
}

// 15. Shutdown: cancel live jobs FIRST, then stop the remote (the runAgentFirewall stop() order).
console.log("15) shutdown cancels before it stops");
{
  const remote = new SlowRemote();
  const f = fw(remote, { cancelGraceMs: 5_000 });
  await call(f, "dispatch", { prompt: "in flight at shutdown" });
  // The same sequence runAgentFirewall's SIGINT/SIGTERM handler runs:
  f.cancelAllLive();
  remote.stop();
  if (remote.events[0] !== "cancel") fail(`expected cancel first, got [${remote.events.join(", ")}]`);
  if (!remote.events.includes("stop")) fail("remote was not stopped");
  ok("cancel, then stop, in that order - no orphaned worker turn");
}

scanner.stop();
console.log("\ndemo_pfleet1 OK - dispatch/collect/cancel handles over the firewall's single gated path: fan-out across connections, serialization within one, fail-closed everywhere.");
process.exit(0);
