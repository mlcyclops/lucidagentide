// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-TUI.1 (part) - `lucid hub`, the pane-multiplexer terminal hub (ADR-0420).
//
// Proves the hub against the REAL engine, headless (the component renders rows; no tty needed):
//   [1] findEngine attaches through the P-TUI.0 discovery seam (ADR-0419), never a guessed port
//   [2] the Overview deck renders THIS engine's real facts (version, port)
//   [3] `|` splits into two panes side by side; deck key rebinds the focused pane
//   [4] the focus ring, close and zoom keep every capability view reachable
//   [5] a dead engine degrades to an honest status line, never a crash (fail-closed reads)
//
// Run with: bun run desktop/scripts/demo_p_tui_1.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubComponent, attachOrSpawnEngine, findEngine } from "../../harness/launcher/hub_tui.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  \u2717 " + msg); process.exit(1); }
  console.log("  \u2713 " + msg);
}

console.log("== #ADR-0420 P-TUI.1 (part): the lucid hub pane multiplexer ==\n");

const dataRoot = mkdtempSync(join(tmpdir(), "lucid-tui1-"));
const home = mkdtempSync(join(tmpdir(), "lucid-tui1-home-"));
const repo = join(import.meta.dir, "..", "..");
const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
const enginePort = probe.port!;
probe.stop(true);

const engineProc = Bun.spawn(["bun", join(repo, "desktop", "dev.ts")], {
  cwd: repo,
  env: { ...process.env, PORT: String(enginePort), LUCID_DATA_ROOT: dataRoot, HOME: home },
  stdout: "pipe", stderr: "pipe",
});

const ui = { requestRender() { /* headless */ }, terminal: { rows: 24 } };

try {
  console.log("[1] attach through the discovery seam");
  let engine = await findEngine({ LUCID_DATA_ROOT: dataRoot });
  const deadline = Date.now() + 30_000;
  while (!engine && Date.now() < deadline) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 200);
    await promise;
    engine = await findEngine({ LUCID_DATA_ROOT: dataRoot });
  }
  assert(engine !== null, "findEngine read the discovery file and won the ADR-0305 nonce handshake");

  const hub = new HubComponent(ui, engine!);
  await hub.refresh();

  console.log("\n[2] the Overview deck shows THIS engine's real facts");
  const frame = hub.render(100).join("\n");
  assert(frame.includes("Overview"), "the single pane is titled Overview");
  assert(frame.includes(`:${enginePort}`), `the deck names the real port :${enginePort}`);
  assert(frame.includes("lucid hub"), "the status line names the client and its engine");

  console.log("\n[3] split and rebind: two capability views side by side");
  hub.handleInput("|");
  hub.handleInput("\t");     // focus the right pane
  hub.handleInput("3");      // Fleet deck there
  const split = hub.render(100);
  const row = split.find((l) => l.includes("Overview")) ?? "";
  assert(row.includes("Overview") && split.some((l) => l.includes("Fleet")), "left pane Overview, right pane Fleet");
  assert(split.some((l) => l.includes("╮╭")), "the two frames share the row - a real side-by-side split, not stacked text");

  console.log("\n[4] zoom, close, and the focus ring never lose a view");
  hub.handleInput("z");
  assert(hub.render(100).filter((l) => l.includes("╭")).length === 1, "zoom shows only the focused pane");
  hub.handleInput("z");
  hub.handleInput("x");
  assert(hub.render(100).join("\n").includes("Overview"), "closing the Fleet pane hands the region back to Overview");

  console.log("\n[5] a dead engine is an honest status, never a crash");
  engineProc.kill("SIGTERM");
  await engineProc.exited;
  await hub.refresh();
  assert(hub.render(100).join("\n").includes("engine unreachable"), "the status line says the engine is gone (fail-closed read)");

  console.log("\n[6] no engine anywhere -> the hub SPAWNS its own and owns its lifetime");
  const spawnRoot = mkdtempSync(join(tmpdir(), "lucid-tui1-spawn-"));
  try {
    const attached = await attachOrSpawnEngine({ ...process.env, LUCID_DATA_ROOT: spawnRoot, PORT: String(enginePort), HOME: home });
    assert(attached !== null && attached.spawned, "attachOrSpawnEngine booted a headless engine and verified it via the handshake");
    attached!.child!.kill("SIGTERM");
    await attached!.child!.exited;
    assert((await findEngine({ LUCID_DATA_ROOT: spawnRoot })) === null, "quitting the hub takes its spawned engine (and the discovery file) with it");
  } finally {
    rmSync(spawnRoot, { recursive: true, force: true });
  }

  hub.dispose();
  console.log("\nP-TUI.1 demo: PASS");
} finally {
  try { engineProc.kill(); } catch { /* already gone */ }
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
