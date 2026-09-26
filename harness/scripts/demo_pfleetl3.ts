// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pfleetl3.ts
//
// P-FLEET.L3 (ADR-0274): lane fidelity. Drives the REAL FleetLaneManager against REAL fake-ACP
// subprocesses and proves, headlessly:
//   1. DIFFS ON THE WIRE: a write/edit tool_call's authored code (the P-CHAT.1 rawInput contract)
//      crosses the lane wire as a structured `code` payload - old/new text, path resolved against the
//      LANE's cwd, never the master's - instead of being clamped to a 120-char title.
//   2. IMAGES IN PROMPTS: pasted images ride as ACP image blocks after the text, exactly like the
//      master chat (the fake agent counts the blocks it receives); the recovery transcript remembers
//      the COUNT, never the base64 - one screenshot must not burn the replay budget.
//   3. STAGED PROMPTS: a manager-owned FIFO queue per lane - staged while busy, reordered, removed,
//      drained in order when the lane is idle, capped loudly, and NEVER crossed into a busy lane
//      (one turn at a time per lane stands, the ADR-0268 lesson).
//
// Run: bun run harness/scripts/demo_pfleetl3.ts

import { join } from "node:path";
import { FleetLaneManager, type LaneEvent } from "../../desktop/fleet_lanes.ts";
import type { SystemSnapshot } from "../../desktop/system_profile.ts";

const FAKE = join(import.meta.dir, "..", "mcp", "testing", "fake_acp_agent.ts");

function fail(msg: string): never {
  console.error(`   FAIL - ${msg}`);
  process.exit(1);
}
function ok(msg: string): void {
  console.log(`   ok - ${msg}`);
}
function tokens(events: LaneEvent[]): string {
  return events.flatMap((e) => (e.type === "token" ? [e.text] : [])).join("");
}

const healthy: SystemSnapshot = { cpuModel: "demo", cores: 8, speedMHz: 4000, cpuBusyPct: 10, memTotalMB: 16_000, memFreeMB: 12_000 };

function mgr(mode?: string): FleetLaneManager {
  if (mode) process.env.FAKE_ACP_MODE = mode; else delete process.env.FAKE_ACP_MODE;
  return new FleetLaneManager({ argv: () => ({ cmd: "bun", args: [FAKE] }), masterModel: () => "orchestrator-model", sample: async () => healthy });
}

const sleep = (ms: number) => { const w = Promise.withResolvers<void>(); setTimeout(w.resolve, ms); return w.promise; };

// ── 1. Diffs on the wire ─────────────────────────────────────────────────────────────────────────────
console.log("1) a write/edit tool call carries its authored code, not a clamped title");
{
  const fleet = mgr();
  const r = await fleet.spawn({ cwd: process.cwd(), name: "editor" });
  if (!r.ok) fail(r.reason ?? "spawn failed");
  const events: LaneEvent[] = [];
  await fleet.prompt(r.lane!.id, "edit the greeting", (e) => events.push(e));
  const tool = events.find((e) => e.type === "tool" && e.code);
  if (!tool || tool.type !== "tool" || !tool.code) fail("the tool event must carry a code payload");
  if (tool.code.oldText !== "hello" || tool.code.newText !== "hello\nworld") fail(`before/after mangled: ${JSON.stringify(tool.code)}`);
  if (!tool.code.path.replace(/\\/g, "/").includes("src/greeting.ts")) fail(`path lost: ${tool.code.path}`);
  if (!tool.code.path.replace(/\\/g, "/").includes(process.cwd().replace(/\\/g, "/").split("/").pop()!)) fail("the path must resolve against the LANE's cwd");
  ok(`code payload crossed: ${tool.code.path.split(/[\\/]/).slice(-2).join("/")} (-1/+2 lines) - the card can render a real diff chip`);
  fleet.stopAll();
}

// ── 2. Images in prompts ─────────────────────────────────────────────────────────────────────────────
console.log("2) pasted images ride as ACP blocks; the replay memory keeps the count, never the bytes");
{
  const fleet = mgr();
  const r = await fleet.spawn({ cwd: process.cwd() });
  const id = r.lane!.id;
  const png = { data: "aGVsbG8=", mimeType: "image/png" };
  const events: LaneEvent[] = [];
  await fleet.prompt(id, "what is in this screenshot?", (e) => events.push(e), [png, png]);
  if (!tokens(events).includes("[images: 2]")) fail("the agent must actually RECEIVE the image blocks");
  await fleet.respawn(id); // fallback resume: the next prompt carries the transcript preamble
  const events2: LaneEvent[] = [];
  await fleet.prompt(id, "still there?", (e) => events2.push(e));
  const reply2 = tokens(events2);
  if (!reply2.includes("[attached 2 images]")) fail("the transcript must remember the image COUNT");
  if (reply2.includes("aGVsbG8=")) fail("base64 must NEVER enter the replay memory");
  ok("two blocks received by the agent; memory says '[attached 2 images]' and carries zero image bytes");
  fleet.stopAll();
}

// ── 3. The staged-prompt queue ───────────────────────────────────────────────────────────────────────
console.log("3) staged prompts: FIFO drain, reorder, remove, a loud cap, and no crossing into a busy lane");
{
  const fleet = mgr();
  const r = await fleet.spawn({ cwd: process.cwd() });
  const id = r.lane!.id;
  for (const t of ["first staged", "second staged", "third staged"]) {
    if (!fleet.enqueue(id, t).ok) fail(`enqueue refused: ${t}`);
  }
  fleet.queueMove(id, 2, -1); // third before second
  fleet.queueRemove(id, 0);   // drop first
  const previews = (await fleet.status()).lanes[0]!.queued.map((q) => q.text);
  if (previews.join("|") !== "third staged|second staged") fail(`reorder/remove broke order: ${previews.join("|")}`);
  const events: LaneEvent[] = [];
  await fleet.drain(id, (e) => events.push(e));
  if (!tokens(events).includes("third staged")) fail("drain must run the HEAD of the queue");
  if ((await fleet.status()).lanes[0]!.queued.length !== 1) fail("drain must consume exactly one");
  for (let i = 0; i < 7; i++) fleet.enqueue(id, `filler ${i}`);
  const overflow = fleet.enqueue(id, "one too many");
  if (overflow.ok || !/full/.test(overflow.reason ?? "")) fail("the 9th staged prompt must refuse loudly");
  ok(`FIFO order held through reorder+remove, drain consumed the head, the cap said "${overflow.reason}"`);

  // Never crossed: a busy lane refuses drain (the queue waits for idle).
  process.env.FAKE_ACP_MODE = "hang";
  const busy = await fleet.spawn({ cwd: process.cwd(), name: "busy" });
  const hangTurn = fleet.prompt(busy.lane!.id, "long", () => {});
  await sleep(150);
  fleet.enqueue(busy.lane!.id, "parked");
  const refused: LaneEvent[] = [];
  await fleet.drain(busy.lane!.id, (e) => refused.push(e));
  if (!refused.some((e) => e.type === "error" && /busy/.test(e.message))) fail("a busy lane must refuse the drain, not cross turns");
  fleet.cancel(busy.lane!.id);
  await hangTurn;
  ok("a busy lane refused the drain - one turn at a time per lane survives the queue");
  fleet.stopAll();
}

console.log("\ndemo_pfleetl3 OK - authored diffs cross the lane wire with lane-cwd paths, images ride as real ACP blocks with count-only memory, and staged prompts wait their turn in a capped manager-owned FIFO.");
process.exit(0);
