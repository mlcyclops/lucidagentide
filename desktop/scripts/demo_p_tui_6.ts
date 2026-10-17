// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-TUI.6 (ADR-0435) - the deck STRIP + the fuzzy PALETTE.
//
// Drives the REAL engine (house fake ACP agent) and the REAL HubComponent in-process (no tty),
// through the real key and SGR mouse input paths:
//   [1] the strip: one line above the status bar, `digit glyph name count`, counts IDENTICAL to
//       the deck sidebar's badges on the same frame; digits 1-9,0 still rebind the focused pane;
//       a click on a strip cell rebinds it too (clickTarget's deck branch)
//   [2] the scorer + row building, on a seeded set of spaces, tabs and agents: subsequence only,
//       consecutive-run length first, then boundary hits, then the shorter target
//   [3] the palette overlay: ctrl+k opens (and `:palette`), typing filters with the asserted
//       ranking, ctrl+n moves, Enter dispatches per kind (space, tab, agent, deck), esc closes,
//       and a composer-owned keyboard NEVER opens it (the `:` prompt's own guard)
//
// Run with: bun run desktop/scripts/demo_p_tui_6.ts

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildPaletteItems, filterPalette } from "../../harness/launcher/hub_palette.ts";
import { Spaces } from "../../harness/launcher/hub_spaces.ts";
import { HubComponent, findEngine } from "../../harness/launcher/hub_tui.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

console.log("== #ADR-0435 P-TUI.6: the deck strip + the fuzzy palette ==\n");

const dataRoot = mkdtempSync(join(tmpdir(), "lucid-tui6-"));
const home = mkdtempSync(join(tmpdir(), "lucid-tui6-home-"));
const repo = join(import.meta.dir, "..", "..");
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

const engineProc = Bun.spawn(["bun", join(repo, "desktop", "dev.ts")], {
  cwd: repo, env: { ...env, PORT: String(enginePort) }, stdout: "ignore", stderr: "ignore",
});

try {
  for (let i = 0; i < 150 && !(await findEngine({ LUCID_DATA_ROOT: dataRoot })); i++) await sleep(200);
  const engine = await findEngine({ LUCID_DATA_ROOT: dataRoot });
  if (!engine) throw new Error("the demo engine did not come up");

  // Two REAL lanes through the engine's own spawn route (the strip's Fleet/Agents counts and the
  // palette's agent rows are the same /api/fleet/status answer every deck renders).
  const api = async (path: string, body?: Record<string, unknown>) => {
    const res = await fetch(`http://127.0.0.1:${engine.port}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "x-lucid-token": engine.token, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const parsed = await res.json() as { data?: unknown };
    return (parsed.data ?? parsed) as Record<string, unknown>;
  };
  const spawn = async (name: string) =>
    ((await api("/api/fleet/spawn", { cwd: repo, name })).lane as { id: string; name: string });
  const laneApi = await spawn("api");
  const laneWeb = await spawn("web");
  assert(!!laneApi.id && !!laneWeb.id, `two real lanes spawned (${laneApi.name}, ${laneWeb.name})`);

  // A seeded layout the fuzzy queries can bite on: spaces "work" (tabs main, logs) and "ops".
  const spaces = new Spaces();
  spaces.rename("s1", "work");
  spaces.renameTab("s1:t1", "main");
  spaces.createTab("s1", "logs");
  spaces.focusTab("s1:t1");
  const ops = spaces.create("ops");
  spaces.focus("s1");
  spaces.setRail(false); // [1] compares the strip against the deck SIDEBAR's badges
  const ui = { requestRender() { /* headless */ }, terminal: { rows: 30 } };
  const view = new HubComponent(ui, engine, { spaces, prioritiesPath: join(dataRoot, "prio.json") });
  await view.refresh();
  const W = 140;
  const frame = () => view.render(W).map((l) => Bun.stripANSI(l));

  console.log("[1] the strip: counts = the sidebar badges; digits and clicks rebind");
  const f1 = frame();
  assert(f1.length === 30, "one row each for the top bar, the strip and the status line");
  const strip = f1.at(-2)!;
  assert(strip.includes("1 ◆ Overview") && strip.includes("0 ▦ Spaces"), "every deck on the strip as `digit glyph name [count]`");
  // The sidebar's badge column on the SAME frame: rows "", "DECKS", "", then one row per deck.
  const badge = (deckRow: number) => /(\d+)\s*│$/.exec(f1[1 + 3 + deckRow]!.slice(0, 20))?.[1] ?? null;
  const cell = (re: RegExp) => re.exec(strip)?.[1] ?? null;
  for (const [row, re, name] of [
    [1, /Security (\d+)/, "Security (quarantined)"],
    [2, /Fleet (\d+)/, "Fleet (lanes)"],
    [3, /Sessions (\d+)/, "Sessions (on disk)"],
    [8, /Agents (\d+)/, "Agents (lanes)"],
    [9, /Spaces (\d+)/, "Spaces (client-side)"],
  ] as const) {
    assert(cell(re) !== null && cell(re) === badge(row), `${name}: strip ${cell(re)} = badge ${badge(row)}`);
  }
  assert(cell(/Fleet (\d+)/) === "2", "the Fleet/Agents count is the two real lanes");
  view.handleInput("2");
  assert(spaces.pane().leaf.deck === "security", "digit 2 still rebinds the focused pane (unchanged semantics)");
  const netCol = Bun.stringWidth(strip.slice(0, strip.indexOf("7 ⇄ Network")));
  frame(); // click geometry is the LAST rendered frame's
  view.handleInput(`\x1b[<0;${netCol + 1};${30 - 2 + 1}M`); // SGR left press on the strip row
  assert(spaces.pane().leaf.deck === "network", "a click on a strip cell rebinds the focused pane to that deck");

  console.log("\n[2] the scorer on the seeded set: ranking is the pinned rule, not vibes");
  const items = buildPaletteItems(spaces, [laneApi, laneWeb].map((l) => ({ id: l.id, name: l.name, status: "working" })));
  const labels = (q: string) => filterPalette(items, q).map((x) => x.label);
  assert(JSON.stringify(labels("work").slice(0, 3)) === JSON.stringify(["work", "work › main", "work › logs"]),
    "'work': the space beats its tabs (shorter target); tied tabs keep source order");
  assert(labels("web")[0] === "web" && labels("w")[0] === "web", "'web'/'w': the lane outranks longer targets");
  assert(labels("sec")[0] === "Security" && !labels("sec").includes("work"), "'sec': run 3 puts Security first; non-subsequences drop");
  assert(labels("zzz").length === 0, "a non-subsequence query matches nothing");

  console.log("\n[3] the palette overlay: ctrl+k, type, move, Enter dispatches per kind");
  const overlayOpen = () => frame().some((l) => l.includes("◆ palette"));
  view.handleInput("\x0b");
  assert(overlayOpen(), "ctrl+k opens the palette (hub-owned focus)");
  for (const ch of "sec") view.handleInput(ch);
  const rows3 = frame().filter((l) => l.includes(" deck "));
  assert(rows3[0]!.includes("Security"), "typing filters live: Security is the top row under 'sec'");
  view.handleInput("\x1b");
  assert(!overlayOpen(), "esc closes the palette");
  // tab: Enter focuses "work › logs".
  view.handleInput("\x0b");
  for (const ch of "logs") view.handleInput(ch);
  view.handleInput("\r");
  assert(spaces.current.name === "work" && spaces.current.tabs.find((t) => t.id === spaces.current.activeTab)!.name === "logs",
    "Enter on a TAB row focuses that tab (space › tab)");
  // space: Enter switches to "ops".
  view.handleInput("\x0b");
  for (const ch of "ops") view.handleInput(ch);
  view.handleInput("\r");
  assert(spaces.active === ops.id, "Enter on a SPACE row switches the space");
  // ctrl+n: the second-ranked row acts ("work" then its first tab "work › main").
  view.handleInput("\x0b");
  for (const ch of "work") view.handleInput(ch);
  view.handleInput("\x0e");
  view.handleInput("\r");
  assert(spaces.active === "s1" && spaces.current.tabs.find((t) => t.id === spaces.current.activeTab)!.name === "main",
    "ctrl+n moves the selection: Enter acts on the SECOND-ranked row (work › main)");
  // agent: Enter attaches into the focused pane (the existing ADR-0420 bind).
  view.handleInput("\x0b");
  for (const ch of "api") view.handleInput(ch);
  view.handleInput("\r");
  await sleep(300);
  assert(spaces.pane().leaf.deck === "agent" && spaces.pane().leaf.lane === laneApi.id,
    "Enter on an AGENT row attaches the lane into the focused pane");
  // The guard: a composer-owned keyboard never opens the palette (input meant for the agent).
  frame();
  view.handleInput("\r"); // the agent pane's composer opens
  view.handleInput("\x0b");
  assert(!overlayOpen(), "ctrl+k inside the composer is the composer's (ignored), never the palette");
  assert(frame().some((l) => l.includes("› ▌")), "the composer still owns the keyboard (its cursor row is on screen)");
  view.handleInput("\x1b"); // close the composer
  // `:palette` opens the same overlay through the command prompt.
  view.handleInput(":");
  for (const ch of "palette") view.handleInput(ch);
  view.handleInput("\r");
  assert(overlayOpen(), "`:palette` opens the same overlay (the `:` prompt alias)");
  // deck: Enter rebinds the focused pane (replacing the agent pane, like its digit key would).
  for (const ch of "usage") view.handleInput(ch);
  view.handleInput("\r");
  assert(spaces.pane().leaf.deck === "usage", "Enter on a DECK row rebinds the focused pane");
  view.dispose();

  console.log("\nP-TUI.6 demo: PASS");
} finally {
  try { engineProc.kill(); } catch { /* gone */ }
  await engineProc.exited;
  for (const d of [dataRoot, home]) rmSync(d, { recursive: true, force: true });
}
