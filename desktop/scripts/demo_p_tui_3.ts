// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-TUI.3 - the hub CONTROL PLANE (ADR-0431): an agent drives `lucid hub` the way the herdr
// CLI drives herdr.
//
// Drives the REAL hub (`lucid hub --headless`, the same HubComponent with no terminal) attached to the
// REAL dev.ts engine, only through the real `lucid hub <cmd>` CLI:
//   [1] no hub -> {"error":"no_hub"} exit 1; a stale file and a squatter's file are inert, and the
//       squatter never receives a token
//   [2] the headless hub publishes hub-discovery-<pid>.json (0600) and wins the nonce handshake
//   [3] split-window via the CLI changes the tree; pane read returns the rendered pane text
//   [4] spaces: new-session / switch-client / rename-session / kill-session round-trip (P-TUI.5,
//       ADR-0433: a tmux SESSION is a space, a window is a tab); last space refuses; ids never reused
//   [5] agent ops proxy to the live engine's /api/fleet routes (list, spawn, prompt, read, cancel)
//   [6] control auth: wrong token 403, browser Origin 403
//   [7] SIGTERM removes the discovery file; the layout restores on the next launch
//
// Run with: bun run desktop/scripts/demo_p_tui_3.ts

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findEngine } from "../../harness/launcher/hub_tui.ts";
import { connectHub, hubDiscoveryPath } from "../../harness/launcher/hub_control.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  \u2717 " + msg); process.exit(1); }
  console.log("  \u2713 " + msg);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

console.log("== #ADR-0431 P-TUI.3: the lucid hub control plane ==\n");

const dataRoot = mkdtempSync(join(tmpdir(), "lucid-tui3-"));
const home = mkdtempSync(join(tmpdir(), "lucid-tui3-home-"));
const work = mkdtempSync(join(tmpdir(), "lucid-tui3-work-"));
const repo = join(import.meta.dir, "..", "..");
const lucid = join(repo, "harness", "launcher", "lucid_acp.ts");
const env = { ...process.env, LUCID_DATA_ROOT: dataRoot, HOME: home };
const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
const enginePort = probe.port!;
probe.stop(true);

interface HubErr { error?: string; message?: string }
interface PaneRow { id: string; deck: string }
interface SpaceRow { id: string; name: string; active: boolean }

/** One real `lucid hub <args>` invocation: exit code + parsed stdout (typed by the caller) / stderr JSON. */
async function hub<T = Record<string, never>>(...args: string[]): Promise<{ code: number; out: T; err: HubErr }> {
  const p = Bun.spawn(["bun", lucid, "hub", ...args], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const parse = (s: string): unknown => { try { return JSON.parse(s); } catch { return { message: s.trim() }; } };
  // Demo-only unchecked cast: the CLI's JSON shape per command is exactly what each step asserts on.
  return { code, out: parse(out) as T, err: parse(err) as HubErr };
}

const engineProc = Bun.spawn(["bun", join(repo, "desktop", "dev.ts")], {
  cwd: repo, env: { ...env, PORT: String(enginePort) }, stdout: "ignore", stderr: "ignore",
});
let hubProc: Bun.Subprocess | null = null;
const startHub = async () => {
  hubProc = Bun.spawn(["bun", lucid, "hub", "--headless"], { cwd: repo, env, stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 150 && !(await connectHub(dataRoot)); i++) await sleep(200);
};

try {
  for (let i = 0; i < 150 && !(await findEngine({ LUCID_DATA_ROOT: dataRoot })); i++) await sleep(200);
  const engine = await findEngine({ LUCID_DATA_ROOT: dataRoot });
  if (!engine) throw new Error("the demo engine did not come up");

  console.log("[1] no hub: a clean error, and planted files are inert");
  const none1 = await hub("status");
  assert(none1.code === 1 && none1.err.error === "no_hub", `no running hub -> exit 1 + {"error":"${none1.err.error}"}`);
  const dead = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const deadPort = dead.port;
  dead.stop(true);
  writeFileSync(hubDiscoveryPath(dataRoot, 999_001), JSON.stringify({ v: 1, pid: 999_001, port: deadPort, nonce: "n", token: "stale-token" }));
  const squatSeen: string[] = [];
  const squat = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    squatSeen.push(`${new URL(req.url).pathname}|${req.headers.get("x-lucid-hub-token") ?? ""}`);
    return Response.json({ ok: true, nonce: "squatter" });
  } });
  writeFileSync(hubDiscoveryPath(dataRoot, 999_002), JSON.stringify({ v: 1, pid: 999_002, port: squat.port, nonce: "real-nonce", token: "phished?" }));
  const none2 = await hub("status");
  assert(none2.code === 1 && none2.err.error === "no_hub", "a stale file (dead port) and a squatter's file (wrong nonce) both answer no_hub");
  assert(squatSeen.length > 0 && squatSeen.every((s) => s === "/health|"), "the squatter saw only the /health handshake, never a token or a command");

  console.log("\n[2] the REAL hub, headless, publishes and wins the handshake");
  await startHub();
  const files = readdirSync(dataRoot).filter((n) => /^hub-discovery-\d+\.json$/.test(n));
  const own = hubDiscoveryPath(dataRoot, hubProc!.pid);
  assert(existsSync(own) && (statSync(own).mode & 0o777) === 0o600, `hub-discovery-${hubProc!.pid}.json is 0600 (beside ${files.length - 1} planted files)`);
  const st = await hub<{ engine: { port: number }; spaces: SpaceRow[]; focused: string }>("status");
  assert(st.code === 0 && st.out.engine.port === enginePort, `status answers through the handshake, attached to engine :${enginePort}`);
  assert(st.out.spaces.length === 1 && st.out.focused === "s1:p1", "one space, one pane: s1:p1");

  console.log("\n[3] a split via the CLI changes the tree; pane read returns rendered text");
  const sp = await hub<{ pane: string; layout: string }>("split-window", "-h");
  assert(sp.code === 0 && sp.out.pane === "s1:p2" && sp.out.layout === "[s1:p1 | s1:p2]", `split-window -h -> ${sp.out.layout}`);
  const lp = await hub<PaneRow[]>("list-panes");
  assert(lp.out.map((p) => p.id).join() === "s1:p1,s1:p2", "list-panes shows both panes");
  // The hub's first engine poll on a cold engine takes a few seconds; the pane says "loading" until then.
  let rd = await hub<{ title: string; lines: string[] }>("pane", "read", "-t", "s1:p2", "-w", "90", "-n", "20");
  for (let i = 0; i < 75 && rd.code === 0 && rd.out.lines.join("").includes("loading from the engine"); i++) {
    await sleep(200);
    rd = await hub<{ title: string; lines: string[] }>("pane", "read", "-t", "s1:p2", "-w", "90", "-n", "20");
  }
  assert(rd.code === 0 && rd.out.title.includes("Overview") && rd.out.lines.join("\n").includes(String(enginePort)), "pane read -t s1:p2 returns the Overview deck as rendered, naming the real engine port");
  console.log(rd.out.lines.slice(0, 4).map((l) => `      | ${l}`).join("\n"));
  const rs = await hub<{ ratio: number }>("resize-pane", "-t", "s1:p1", "-R", "10");
  assert(rs.code === 0 && rs.out.ratio === 0.6, "resize-pane -R 10 moves the border (ratio 0.6)");
  const sk = await hub("send-keys", "-t", "s1:p1", "a");
  assert(sk.code === 1 && sk.err.error === "not_agent", "send-keys into a deck pane is refused: the hub keymap (approve, whitelist) is not scriptable");

  console.log("\n[4] spaces round-trip");
  const nw = await hub<SpaceRow>("new-session", "-s", "work");
  assert(nw.code === 0 && nw.out.id === "s2" && nw.out.active, "new-session -s work -> s2, now active");
  const sw = await hub<SpaceRow>("switch-client", "-t", "s1");
  assert(sw.code === 0 && sw.out.active, "switch-client -t s1 switches back");
  const rw = await hub<SpaceRow>("rename-session", "-t", "s2", "ops");
  assert(rw.out.name === "ops", "rename-session -t s2 ops");
  const lw = await hub<SpaceRow[]>("list-sessions");
  assert(lw.out.map((s) => `${s.id}:${s.name}:${s.active}`).join() === "s1:main:true,s2:ops:false", "list-sessions: s1 main (active), s2 ops");
  const kw = await hub<{ closed: string }>("kill-session", "-t", "s2");
  assert(kw.code === 0 && kw.out.closed === "s2", "kill-session -t s2");
  const kl = await hub("kill-session");
  assert(kl.code === 1 && kl.err.error === "last_space", "closing the last space refuses (last_space)");
  await hub("kill-pane", "-t", "s1:p2");
  const sv = await hub<{ pane: string; layout: string }>("split-window", "-v");
  assert(sv.out.pane === "s1:p3" && sv.out.layout === "[s1:p1 / s1:p3]", "a killed pane's id is never reused: the next split is s1:p3");

  console.log("\n[5] agent ops proxy to the live engine");
  const directRes = await fetch(`http://127.0.0.1:${enginePort}/api/fleet/status`, { headers: { "x-lucid-token": engine.token } });
  const direct = (await directRes.json()) as { data: { lanes: unknown[] } }; // the engine's own answer, compared not trusted
  const al = await hub<unknown[]>("agent", "list");
  assert(al.code === 0 && al.out.length === direct.data.lanes.length, `agent list = the engine's own /api/fleet/status (${al.out.length} lanes)`);
  const as = await hub("agent", "status", "no-such-lane");
  assert(as.code === 1 && as.err.error === "not_found", "agent status on an unknown lane -> not_found");
  const spawn = await hub<{ lane: { id: string } }>("agent", "spawn", "--cwd", work, "--name", "demo-lane");
  if (spawn.code === 0) {
    const id = spawn.out.lane.id;
    assert(typeof id === "string", `agent spawn -> engine lane ${id}`);
    const rb = await hub<{ lane: string }>("pane", "rebind", "-t", "s1:p3", "agent", id);
    assert(rb.code === 0 && rb.out.lane === id, "pane rebind -t s1:p3 agent <lane> opens it in a pane");
    const ap = await hub<{ title: string }>("pane", "read", "-t", "s1:p3");
    assert(ap.out.title.includes("demo-lane"), `the agent pane renders: "${ap.out.title}"`);
    const pr = await hub<{ accepted: boolean }>("agent", "prompt", id, "say hello in one word");
    assert(pr.code === 0 ? pr.out.accepted : pr.err.error === "refused", `agent prompt -> the engine's own answer (${pr.code === 0 ? "accepted" : pr.err.message})`);
    const ar = await hub<{ turns: { role: string; text: string }[] }>("agent", "read", id);
    assert(ar.code === 0 && ar.out.turns.some((t) => t.role === "user" && t.text.includes("say hello")), "agent read: the engine's fleet transcript holds the prompt (it went through /api/fleet/prompt and the gate path, untouched)");
    const ac = await hub<{ lane: string }>("agent", "cancel", id);
    assert(ac.code === 0 && ac.out.lane === id, "agent cancel reaches /api/fleet/cancel");
  } else {
    assert(spawn.err.error === "refused" || spawn.err.error === "engine", `agent spawn -> the engine's own refusal, surfaced verbatim: ${spawn.err.message}`);
  }

  console.log("\n[6] control auth");
  const d = (await connectHub(dataRoot))!;
  const cmd = (h: Record<string, string>) => fetch(`http://127.0.0.1:${d.port}/cmd`, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify({ argv: ["status"] }) });
  assert((await cmd({ "x-lucid-hub-token": "wrong" })).status === 403, "wrong token -> 403");
  assert((await cmd({ "x-lucid-hub-token": d.token, origin: "http://evil.example" })).status === 403, "a browser Origin -> 403 even with the token");

  console.log("\n[7] SIGTERM cleans up; the layout comes back");
  const before = (await hub<PaneRow[]>("list-panes", "-a")).out;
  hubProc!.kill("SIGTERM");
  await hubProc!.exited;
  assert(!existsSync(own), "the discovery file is removed on exit");
  const gone = await hub("status");
  assert(gone.code === 1 && gone.err.error === "no_hub", "and the CLI says no_hub again");
  await startHub();
  const after = (await hub<PaneRow[]>("list-panes", "-a")).out;
  assert(JSON.stringify(after.map((p) => [p.id, p.deck])) === JSON.stringify(before.map((p) => [p.id, p.deck])), `a fresh hub restores the saved spaces and pane ids (${after.map((p) => p.id).join(", ")})`);
  hubProc!.kill("SIGTERM");
  await hubProc!.exited;
  squat.stop(true);

  console.log("\nP-TUI.3 demo: PASS");
} finally {
  try { (hubProc as Bun.Subprocess | null)?.kill(); } catch { /* gone */ }
  try { engineProc.kill(); } catch { /* gone */ }
  await engineProc.exited;
  for (const d of [dataRoot, home, work]) rmSync(d, { recursive: true, force: true });
}
