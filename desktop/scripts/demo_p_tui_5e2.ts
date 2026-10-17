// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-TUI.5 E2 (ADR-0434) - the rail's AGENTS panel + per-lane priority.
//
// Part A drives the REAL headless hub (`lucid hub --headless`) on the REAL dev.ts engine (over the
// house fake ACP agent) through the REAL `lucid hub <cmd>` CLI; part B runs the same HubComponent
// in-process (no tty) and feeds it the exact SGR mouse bytes a terminal sends:
//   [1] two real lanes spawn; `lucid hub agent priority <name> <1-9>` answers with the display-order
//       note and round-trips hub-agent-priorities.json (v1, 0600, keyed by lane NAME); a lane the
//       engine does not know is not_found; a non-numeric priority is a usage error with no hub call
//   [2] the rail renders the AGENTS header with the row count and one row per lane - status glyph,
//       name, model short-name, elapsed, p<n> badge - ordered by priority DESC then status then name
//   [3] a click on a row SELECTS it; a second click ATTACHES the lane into the focused pane (the
//       existing ADR-0420 bind); a digit on the selected row sets its priority (store + reorder on
//       the next frame); c routes the lane's turn to /api/fleet/cancel; approvals are never answered
//
// Run with: bun run desktop/scripts/demo_p_tui_5e2.ts

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentPrioritiesPath, loadPriorities, HubAgentsPanel } from "../../harness/launcher/hub_agents_panel.ts";
import { connectHub } from "../../harness/launcher/hub_control.ts";
import { loadSpaces, Spaces, spacesPath, saveSpaces } from "../../harness/launcher/hub_spaces.ts";
import { DECKS, HubComponent, findEngine, railRows } from "../../harness/launcher/hub_tui.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

console.log("== #ADR-0434 P-TUI.5 E2: the rail's AGENTS panel + priority ==\n");

const dataRoot = mkdtempSync(join(tmpdir(), "lucid-tui5e2-"));
const home = mkdtempSync(join(tmpdir(), "lucid-tui5e2-home-"));
const repo = join(import.meta.dir, "..", "..");
const lucid = join(repo, "harness", "launcher", "lucid_acp.ts");
const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
const enginePort = probe.port!;
probe.stop(true);

// The engine's omp child is the house fake ACP agent (the demo-P-TUI.4 pattern): routes, lane
// manager, gate and discovery stay real; only the model behind the lane is fake.
const fakeOmp = join(dataRoot, "bin", "omp");
mkdirSync(join(dataRoot, "bin"), { recursive: true });
writeFileSync(fakeOmp, `#!/usr/bin/env bun
if (process.argv.includes("--version")) { console.log("fake-omp 0.0.0"); process.exit(0); }
await import(${JSON.stringify(pathToFileURL(join(repo, "harness", "mcp", "testing", "fake_acp_agent.ts")).href)});
`, { mode: 0o755 });
chmodSync(fakeOmp, 0o755);
const env = { ...process.env, LUCID_DATA_ROOT: dataRoot, HOME: home, LUCID_OMP_BIN: fakeOmp };

interface HubErr { error?: string; message?: string }

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

try {
  for (let i = 0; i < 150 && !(await findEngine({ LUCID_DATA_ROOT: dataRoot })); i++) await sleep(200);
  const engine = await findEngine({ LUCID_DATA_ROOT: dataRoot });
  if (!engine) throw new Error("the demo engine did not come up");

  console.log("[1] the CLI verb: priority round-trips the store; refusals are named");
  hubProc = Bun.spawn(["bun", lucid, "hub", "--headless"], { cwd: repo, env, stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 150 && !(await connectHub(dataRoot)); i++) await sleep(200);
  const sa = await hub<{ lane: { id: string; name: string } }>("agent", "spawn", "--cwd", repo, "--name", "api");
  const sb = await hub<{ lane: { id: string; name: string } }>("agent", "spawn", "--cwd", repo, "--name", "web");
  assert(sa.code === 0 && sb.code === 0, `two real lanes spawned through the engine (${sa.out.lane?.name}, ${sb.out.lane?.name})`);
  const apiId = sa.out.lane.id;
  const pr = await hub<{ name: string; priority: number; note: string }>("agent", "priority", "web", "7");
  assert(pr.code === 0 && pr.out.name === "web" && pr.out.priority === 7, "agent priority web 7 lands on the lane by NAME");
  assert(pr.out.note.includes("display order") && pr.out.note.includes("not scheduling"), `the reply SAYS what priority is: "${pr.out.note}"`);
  const byId = await hub<{ name: string; priority: number }>("agent", "priority", apiId, "2");
  assert(byId.code === 0 && byId.out.name === "api", "the lane resolves by id too (the executor's own lane lookup)");
  const storePath = agentPrioritiesPath(dataRoot);
  const stored = JSON.parse(readFileSync(storePath, "utf8")) as { v: number; priorities: Record<string, number> };
  assert(stored.v === 1 && stored.priorities.web === 7 && stored.priorities.api === 2 && (statSync(storePath).mode & 0o777) === 0o600,
    "hub-agent-priorities.json: v1, keyed by lane name, 0600, beside hub-spaces.json");
  const nf = await hub("agent", "priority", "nope", "5");
  assert(nf.code === 1 && nf.err.error === "not_found", "a lane the engine does not know is not_found");
  const us = await hub("agent", "priority", "api", "high");
  assert(us.code === 1 && us.err.error === "usage" && (us.err.message ?? "").includes("whole number"), "a non-numeric priority is a usage error (answered locally)");
  hubProc.kill("SIGTERM");
  await hubProc.exited;

  console.log("\n[2] the rail renders the panel: glyph, name, model, elapsed, p<n>, priority order");
  const layoutFile = spacesPath(dataRoot);
  const spaces = loadSpaces(layoutFile, (d) => DECKS.some((x) => x.id === d)) ?? new Spaces();
  spaces.onChange = () => saveSpaces(layoutFile, spaces);
  const ui = { requestRender() { /* headless */ }, terminal: { rows: 30 } };
  const view = new HubComponent(ui, engine, { spaces, prioritiesPath: storePath });
  await view.refresh();
  const W = 140;
  const frame = () => view.render(W).map((l) => Bun.stripANSI(l));
  const railCol = () => frame().slice(1, -1).map((l) => l.slice(0, 28));
  const at = (re: RegExp) => railCol().findIndex((l) => re.test(l));
  assert(at(/◎ AGENTS\s+2/) >= 0, "the AGENTS header counts the panel's rows (2)");
  assert(at(/[◉●◐○] web.+p7/) > at(/◎ AGENTS/), "web's row: status glyph, name, p7 badge");
  assert(at(/[◉●◐○] api.+p2/) === at(/ web/) + 1, "priority DESC: web (p7) sits above api (p2)");
  assert(railCol().some((l) => /[◉●◐○] api\s.*\d+[smh]? p2/.test(l)), "the row carries elapsed since spawn (the model cell is pinned in unit tests; the fake agent reports none)");
  console.log(railCol().slice(at(/◎ AGENTS/), at(/◎ AGENTS/) + 3).map((l) => `      | ${l}`).join("\n"));

  console.log("\n[3] clicks and keys through the real input path");
  const panel = view.agentsPanel as HubAgentsPanel;
  assert(panel instanceof HubAgentsPanel, "the component bound its own HubAgentsPanel behind the seam");
  const sgr = (col: number, row: number, button = 0, final = "M") => `\x1b[<${button};${col + 1};${row + 1}${final}`;
  const rowOf = (id: string) => 1 + railRows(spaces, panel.rows()).findIndex((r) => r.kind === "agent" && r.row.id === id);
  frame(); // click geometry is the LAST rendered frame's
  view.handleInput(sgr(5, rowOf(apiId)));
  assert(panel.selected === apiId && spaces.pane().leaf.deck !== "agent", "the first click SELECTS the row - nothing attaches yet");
  view.handleInput(sgr(5, rowOf(apiId)));
  await sleep(100);
  assert(spaces.pane().leaf.deck === "agent" && spaces.pane().leaf.lane === apiId, "the second click ATTACHES the lane into the focused pane (the existing bind)");
  frame();
  view.handleInput("9"); // the keyboard is on the rail, on api's row, after the click
  assert(loadPriorities(storePath).api === 9, "a digit on the selected row round-trips the store (api -> p9)");
  assert(frame().some((l) => l.includes("display order")), "the status line SAYS it is display order");
  const rc = railCol();
  assert(rc.findIndex((l) => /[◉●◐○] api.+p9/.test(l)) < rc.findIndex((l) => /[◉●◐○] web.+p7/.test(l)), "the next frame reorders: api (p9) now above web (p7)");
  frame();
  view.handleInput(sgr(5, rowOf(sb.out.lane.id))); // select web's row (one click)
  view.handleInput("c");
  await sleep(200);
  assert(frame().at(-1)!.includes("cancel"), "c routes the lane's turn to /api/fleet/cancel (the refusal or the cancel surfaces verbatim)");
  view.dispose();

  console.log("\nP-TUI.5 E2 demo: PASS");
} finally {
  try { (hubProc as Bun.Subprocess | null)?.kill(); } catch { /* gone */ }
  try { engineProc.kill(); } catch { /* gone */ }
  await engineProc.exited;
  for (const d of [dataRoot, home]) rmSync(d, { recursive: true, force: true });
}
