// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-TUI.5 (ADR-0433) - tabs inside spaces, and the spaces RAIL.
//
// Part A drives the REAL headless hub (`lucid hub --headless`) on the REAL dev.ts engine through the
// REAL `lucid hub <cmd>` CLI; part B runs the same HubComponent in-process (no tty) to read the rail
// and feed it the exact SGR mouse bytes a terminal sends:
//   [1] a P-TUI.3 v1 hub-spaces.json migrates on boot: each space's tree becomes tab t1, pane ids kept
//   [2] grouped `tab` verbs: create / rename / focus / last-tab refusal
//   [3] the CORRECTED tmux mapping: window = tab (new/rename/select/list/kill-window), session = space
//       (new-session / switch-client / rename-session / list-sessions / kill-session)
//   [4] SIGTERM + relaunch: tabs, names, focus and counters come back from the v2 file
//   [5] the rail renders every space with its tabs (live: a CLI rename shows on the next frame),
//       focus marker, pane counts and the AGENTS seam header (lane badges: hub_tui.test.ts)
//   [6] clicks: a rail tab row focuses that tab, a pane click focuses the pane, a motion report and a
//       click during a composer do nothing; r renames inline, n creates; b persists across restart
//
// Run with: bun run desktop/scripts/demo_p_tui_5.ts

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectHub, startHubControl } from "../../harness/launcher/hub_control.ts";
import { loadSpaces, saveSpaces, spacesPath } from "../../harness/launcher/hub_spaces.ts";
import { DECKS, HubComponent, findEngine, railRows, type RailRow } from "../../harness/launcher/hub_tui.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  \u2717 " + msg); process.exit(1); }
  console.log("  \u2713 " + msg);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

console.log("== #ADR-0433 P-TUI.5: tabs in spaces, and the spaces rail ==\n");

const dataRoot = mkdtempSync(join(tmpdir(), "lucid-tui5-"));
const home = mkdtempSync(join(tmpdir(), "lucid-tui5-home-"));
const repo = join(import.meta.dir, "..", "..");
const lucid = join(repo, "harness", "launcher", "lucid_acp.ts");
const env = { ...process.env, LUCID_DATA_ROOT: dataRoot, HOME: home };
const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
const enginePort = probe.port!;
probe.stop(true);
const layoutFile = spacesPath(dataRoot);
const isDeck = (d: string) => DECKS.some((x) => x.id === d);

interface HubErr { error?: string; message?: string }
interface TabRow { id: string; space: string; name: string; active: boolean; focused: boolean; panes: number; layout: string }
interface PaneRow { id: string; tab: string }

/** One real `lucid hub <args>` invocation: exit code + parsed stdout (typed by the caller) / stderr JSON. */
async function hub<T = Record<string, never>>(...args: string[]): Promise<{ code: number; out: T; err: HubErr }> {
  const p = Bun.spawn(["bun", lucid, "hub", ...args], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const parse = (s: string): unknown => { try { return JSON.parse(s); } catch { return { message: s.trim() }; } };
  // Demo-only unchecked cast: the CLI's JSON shape per command is exactly what each step asserts on.
  return { code, out: parse(out) as T, err: parse(err) as HubErr };
}

// A layout exactly as the P-TUI.3 hub saved it (v1): two spaces, a split, a burned pane id (p2).
writeFileSync(layoutFile, JSON.stringify({
  v: 1, active: "s1", nextSpace: 3, spaces: [
    { id: "s1", name: "main", tree: { kind: "split", dir: "v", a: { kind: "leaf", id: "s1:p1", deck: "overview" }, b: { kind: "leaf", id: "s1:p3", deck: "fleet" } }, focus: 1, zoom: false, nextPane: 4 },
    { id: "s2", name: "ops", tree: { kind: "leaf", id: "s2:p1", deck: "security" }, focus: 0, zoom: false, nextPane: 2 },
  ],
}), { mode: 0o600 });

const engineProc = Bun.spawn(["bun", join(repo, "desktop", "dev.ts")], {
  cwd: repo, env: { ...env, PORT: String(enginePort) }, stdout: "ignore", stderr: "ignore",
});
let hubProc: Bun.Subprocess | null = null;
const startHub = async () => {
  hubProc = Bun.spawn(["bun", lucid, "hub", "--headless"], { cwd: repo, env, stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 150 && !(await connectHub(dataRoot)); i++) await sleep(200);
};
const stopHub = async () => {
  hubProc!.kill("SIGTERM");
  await hubProc!.exited;
};

try {
  for (let i = 0; i < 150 && !(await findEngine({ LUCID_DATA_ROOT: dataRoot })); i++) await sleep(200);
  const engine = await findEngine({ LUCID_DATA_ROOT: dataRoot });
  if (!engine) throw new Error("the demo engine did not come up");

  console.log("[1] a v1 layout migrates on boot");
  await startHub();
  const tl = await hub<TabRow[]>("tab", "list");
  assert(tl.code === 0 && tl.out.map((t) => `${t.id}=${t.layout}`).join(" ") === "s1:t1=[s1:p1 | s1:p3] s2:t1=s2:p1", `each space's v1 tree is now its tab t1: ${tl.out.map((t) => `${t.id}=${t.layout}`).join(", ")}`);
  const st = await hub<{ active: string; tab: string; focused: string }>("status");
  assert(st.out.tab === "s1:t1" && st.out.focused === "s1:p3", "focus survives the migration (s1:t1, pane s1:p3)");
  const sp = await hub<{ focused: string }>("select-pane", "-t", "s1:p1");
  assert(sp.code === 0 && sp.out.focused === "s1:p1", "a v1 pane id still resolves (select-pane -t s1:p1)");

  console.log("\n[2] grouped tab verbs");
  const tc = await hub<TabRow>("tab", "create", "build");
  assert(tc.code === 0 && tc.out.id === "s1:t2" && tc.out.focused && tc.out.layout === "s1:p4", "tab create build -> s1:t2 holding s1:p4 (the space's pane counter, p2/p3 never re-minted)");
  const tr = await hub<TabRow>("tab", "rename", "-t", "s1:t2", "build-logs");
  assert(tr.out.name === "build-logs", "tab rename -t s1:t2 build-logs");
  const tf = await hub<TabRow>("tab", "focus", "s1:t1");
  assert(tf.code === 0 && tf.out.focused, "tab focus s1:t1");
  const lt = await hub("tab", "close", "-t", "s2:t1");
  assert(lt.code === 1 && lt.err.error === "last_tab", "closing a space's last tab refuses (last_tab)");

  console.log("\n[3] tmux: window = TAB, session = SPACE");
  const nw = await hub<TabRow>("new-window", "-n", "review");
  assert(nw.code === 0 && nw.out.id === "s1:t3" && nw.out.space === "s1", "new-window -n review -> a TAB (s1:t3) in the current space, not a space");
  const rw = await hub<TabRow>("rename-window", "-t", "s1:t3", "rev");
  assert(rw.out.name === "rev", "rename-window renames the tab");
  const sw = await hub<TabRow>("select-window", "-t", "s1:t2");
  assert(sw.out.focused && sw.out.name === "build-logs", "select-window -t s1:t2 focuses that tab");
  const lw = await hub<TabRow[]>("list-windows");
  assert(lw.out.map((t) => `${t.name}${t.focused ? "*" : ""}`).join(",") === "t1,build-logs*,rev", "list-windows: the current space's tabs, the focused one marked");
  const kw = await hub<{ closed: string }>("kill-window", "-t", "s1:t3");
  assert(kw.code === 0 && kw.out.closed === "s1:t3", "kill-window -t s1:t3 closes the tab");
  const ns = await hub<{ id: string; tabs: number; active: boolean }>("new-session", "-s", "lab");
  assert(ns.code === 0 && ns.out.id === "s3" && ns.out.tabs === 1 && ns.out.active, "new-session -s lab -> a SPACE (s3) with its first tab");
  const sc = await hub<{ id: string }>("switch-client", "-t", "main");
  assert(sc.code === 0 && sc.out.id === "s1", "switch-client -t main switches space");
  await hub("rename-session", "-t", "s3", "lab2");
  const ls = await hub<{ name: string }[]>("list-sessions");
  assert(ls.out.map((s) => s.name).join(",") === "main,ops,lab2", "list-sessions lists spaces (rename-session took)");
  const ks = await hub<{ closed: string }>("kill-session", "-t", "lab2");
  assert(ks.code === 0 && ks.out.closed === "s3", "kill-session -t lab2 closes the space");
  const lp = await hub<PaneRow[]>("list-panes");
  assert(lp.out.map((p) => `${p.tab}/${p.id}`).join() === "s1:t2/s1:p4", "list-panes = the current TAB's panes");
  const saved = JSON.parse(readFileSync(layoutFile, "utf8")) as { v: number };
  assert(saved.v === 2 && (statSync(layoutFile).mode & 0o777) === 0o600, "hub-spaces.json is now v2, still 0600");

  console.log("\n[4] SIGTERM + relaunch: the tabs come back");
  const before = (await hub<TabRow[]>("tab", "list")).out;
  await stopHub();
  await startHub();
  const after = (await hub<TabRow[]>("tab", "list")).out;
  assert(JSON.stringify(after) === JSON.stringify(before), `tabs, names, layouts and focus restored: ${after.map((t) => `${t.id}:${t.name}${t.focused ? "*" : ""}`).join(", ")}`);
  const again = await hub<TabRow>("tab", "create");
  assert(again.out.id === "s1:t4", "the tab counter survived the restart (s1:t3 is never re-minted)");
  await hub("kill-window", "-t", "s1:t4");
  await stopHub();
  assert(!existsSync(join(dataRoot, `hub-discovery-${hubProc!.pid}.json`)), "the headless hub removed its discovery file");

  console.log("\n[5] the rail, in-process on the same layout file and a live control server");
  const spaces = loadSpaces(layoutFile, isDeck);
  assert(spaces !== null && spaces.rail, "the saved v2 layout loads; the rail is open by default");
  spaces!.onChange = () => saveSpaces(layoutFile, spaces!);
  const ui = { requestRender() { /* headless */ }, terminal: { rows: 30 } };
  const view = new HubComponent(ui, engine, { spaces: spaces! });
  const control = startHubControl({ dir: dataRoot, exec: (op) => view.exec(op) });
  await view.refresh();
  const W = 140;
  const frame = () => view.render(W).map((l) => Bun.stripANSI(l));
  let f = frame();
  const railCol = f.slice(1, -1).map((l) => l.slice(0, 28));
  const at = (re: RegExp) => railCol.findIndex((l) => re.test(l));
  assert(at(/▦ SPACES\s+2/) >= 0 && at(/◎ AGENTS/) > at(/▦ SPACES/), "the rail heads SPACES (with the count) and keeps the AGENTS seam header below");
  assert(at(/▎◆ main\s+3▣/) >= 0 && at(/ ◇ ops\s+1▣/) > at(/◆ main/), "spaces in order: the focused one behind the accent bar with ◆, the others ◇, each with its pane count");
  assert(at(/├ t1\s+2▣/) === at(/◆ main/) + 1 && at(/└ build-logs\s+1▣/) === at(/◆ main/) + 2, "each space's tabs sit indented beneath it (t1, build-logs)");
  console.log(railCol.slice(0, 9).map((l) => `      | ${l}`).join("\n"));
  const rn = await hub<TabRow>("rename-window", "-t", "s1:t1", "editor");
  assert(rn.code === 0 && frame().some((l) => l.slice(0, 28).includes("├ editor")), "a CLI rename against this hub shows in the rail on the next frame (live names)");
  const top = frame()[0]!;
  assert(top.includes("main › editor [build-logs]"), `the top bar names the space and its tabs, the one on screen bracketed: "${top.trim().slice(-40)}"`);

  console.log("\n[6] clicks through the real input path (the SGR bytes a terminal sends)");
  const sgr = (col: number, row: number, button = 0, final = "M") => `\x1b[<${button};${col + 1};${row + 1}${final}`;
  const rowOf = (pred: (r: RailRow) => boolean) => 1 + railRows(spaces!).findIndex(pred);
  view.handleInput(sgr(10, rowOf((r) => r.kind === "tab" && r.id === "s1:t1")));
  assert(spaces!.tab.id === "s1:t1", "clicking the editor tab row focuses tab s1:t1");
  view.handleInput(sgr(6, rowOf((r) => r.kind === "space" && r.id === "s2")));
  assert(spaces!.active === "s2", "clicking the ops space row focuses space s2");
  view.handleInput(sgr(10, rowOf((r) => r.kind === "tab" && r.id === "s1:t1")));
  frame(); // the click geometry is the LAST rendered frame's
  assert(spaces!.pane().leaf.id === "s1:p1", "back on main/editor, the focused pane is s1:p1");
  view.handleInput(sgr(28 + 80, 10)); // right half of the [s1:p1 | s1:p3] split
  assert(spaces!.pane().leaf.id === "s1:p3", "a click on the right pane focuses s1:p3");
  view.handleInput(sgr(28 + 5, 10, 32)); // a motion report over the left pane
  view.handleInput(sgr(28 + 5, 10, 0, "m")); // a release
  assert(spaces!.pane().leaf.id === "s1:p3", "motion and release reports do nothing (clicks only)");
  view.handleInput(":");
  view.handleInput(sgr(10, rowOf((r) => r.kind === "space" && r.id === "s2")));
  f = frame();
  assert(spaces!.active === "s1" && f.at(-1)!.includes(":▌"), "a click while the : composer is open neither acts nor types into it");
  view.handleInput("\x1b"); // esc closes the composer

  // r / n on the rail: the keyboard is on the rail after a rail click.
  view.handleInput(sgr(10, rowOf((r) => r.kind === "tab" && r.id === "s1:t2")));
  view.handleInput("r");
  for (let i = 0; i < "build-logs".length; i++) view.handleInput("\x7f");
  for (const ch of "logs") view.handleInput(ch);
  view.handleInput("\r");
  await sleep(50);
  assert(spaces!.findTab("s1:t2").tab.name === "logs" && frame().some((l) => l.slice(0, 28).includes("└ logs")), "r renamed the selected tab inline (same composer as the Spaces deck)");
  view.handleInput(sgr(6, rowOf((r) => r.kind === "space" && r.id === "s2")));
  view.handleInput("n");
  assert(spaces!.tab.id === "s2:t2" && frame().some((l) => /└ t2\s+1▣/.test(l.slice(0, 28))), "n on a space row created tab s2:t2 under it");
  view.handleInput(sgr(4, rowOf((r) => r.kind === "spaces-head")));
  view.handleInput("n");
  assert(spaces!.spaces.length === 3 && spaces!.current.id === "s4", "n on the SPACES header created a space (s4)");
  view.handleInput("b");
  assert(frame().some((l) => l.includes("DECKS")) && !frame().some((l) => l.includes("▦ SPACES")), "b closes the rail; the deck list takes its place");

  control.stop();
  view.dispose();
  const reloaded = loadSpaces(layoutFile, isDeck)!;
  assert(reloaded.rail === false && reloaded.spaces.length === 3 && reloaded.findTab("s1:t2").tab.name === "logs", "rail state, the new space and the rail rename persisted (fresh load of hub-spaces.json)");

  console.log("\nP-TUI.5 demo: PASS");
} finally {
  try { (hubProc as Bun.Subprocess | null)?.kill(); } catch { /* gone */ }
  try { engineProc.kill(); } catch { /* gone */ }
  await engineProc.exited;
  for (const d of [dataRoot, home]) rmSync(d, { recursive: true, force: true });
}
