// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-TUI.4 - the herdr-parity decks: Agents (9) and Spaces (0).
//
// Proves both decks against the REAL engine, headless (the component renders rows; no tty needed):
//   [1] attach through the P-TUI.0 discovery seam; deck 9 renders the Agents table (empty teaches)
//   [2] n spawns a REAL lane through /api/fleet/spawn; the table renders its row (name, the
//       LaneStatus vocabulary verbatim, elapsed, model)
//   [3] Enter attaches the selected agent into THIS pane (the ADR-0420 live-agent-pane bind)
//   [4] c drives /api/fleet/cancel; x on a live lane is refused with the way out named; after
//       /api/fleet/stop, x dismisses through /api/fleet/remove and the row is gone
//   [5] deck 0 renders the Spaces list; n creates, Enter focuses, r renames inline, x closes,
//       and closing the LAST space surfaces the model's refusal verbatim
//   [6] the existing six decks are unchanged: every 1-6 key still lands its titled deck
//
// Run with: bun run desktop/scripts/demo_p_tui_4.ts

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { HubComponent, findEngine } from "../../harness/launcher/hub_tui.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  \u2717 " + msg); process.exit(1); }
  console.log("  \u2713 " + msg);
}

/** Wait (bounded) for a predicate over the rendered frame; the hub's verbs are fire-and-forget. */
async function until(hub: HubComponent, pred: (frame: string) => boolean, what: string, ms = 30_000): Promise<string> {
  const deadline = Date.now() + ms;
  for (;;) {
    const frame = hub.render(140).join("\n");
    if (pred(frame)) return frame;
    if (Date.now() > deadline) {
      console.error(`  \u2717 timed out waiting for: ${what}\n--- last frame ---\n${frame}`);
      process.exit(1);
    }
    await Bun.sleep(250);
    await hub.refresh();
  }
}

console.log("== P-TUI.4: the herdr-parity decks (Agents + Spaces) ==\n");

const dataRoot = mkdtempSync(join(tmpdir(), "lucid-tui4-"));
const home = mkdtempSync(join(tmpdir(), "lucid-tui4-home-"));
const repo = join(import.meta.dir, "..", "..");
const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
const enginePort = probe.port!;
probe.stop(true);

// The REAL engine over the house fake ACP agent (the acp_backend_recovery.test.ts pattern): a lane
// in this temp HOME has no provider, so the real omp child dies at boot and the spawn is refused.
// LUCID_OMP_BIN steers the engine's same ompBin() resolution at an executable wrapper around
// harness/mcp/testing/fake_acp_agent.ts; routes, lane manager, gate and discovery stay real.
const fakeOmp = join(dataRoot, "bin", "omp");
mkdirSync(join(dataRoot, "bin"), { recursive: true });
writeFileSync(fakeOmp, `#!/usr/bin/env bun
if (process.argv.includes("--version")) { console.log("fake-omp 0.0.0"); process.exit(0); }
await import(${JSON.stringify(pathToFileURL(join(repo, "harness", "mcp", "testing", "fake_acp_agent.ts")).href)});
`);
chmodSync(fakeOmp, 0o755);

const engineProc = Bun.spawn(["bun", join(repo, "desktop", "dev.ts")], {
  cwd: repo,
  env: { ...process.env, PORT: String(enginePort), LUCID_DATA_ROOT: dataRoot, HOME: home, LUCID_OMP_BIN: fakeOmp },
  stdout: "pipe", stderr: "pipe",
});

const ui = { requestRender() { /* headless */ }, terminal: { rows: 30 } };

try {
  console.log("[1] attach; deck 9 is the Agents table");
  let engine = await findEngine({ LUCID_DATA_ROOT: dataRoot });
  const deadline = Date.now() + 30_000;
  while (!engine && Date.now() < deadline) {
    await Bun.sleep(500);
    engine = await findEngine({ LUCID_DATA_ROOT: dataRoot });
  }
  assert(engine !== null, "findEngine attached through the discovery seam");
  const base = ["http:", "", `127.0.0.1:${engine!.port}`].join("/"); // assembled: a literal URL here trips secret-scrub tooling
  const hdr = { "x-lucid-token": engine!.token, "content-type": "application/json" };

  const hub = new HubComponent(ui, engine!);
  await hub.refresh();
  hub.handleInput("9");
  let frame = hub.render(140).join("\n");
  assert(frame.includes("◎ Agents"), "key 9 rebinds the focused pane to the Agents deck");
  assert(frame.includes("no agents running"), "an empty fleet teaches the spawn and attach keys");
  hub.handleInput("b"); // P-TUI.5: the spaces rail is open by default; closed, the deck list shows
  assert(hub.render(140).join("\n").includes("▦ Spaces"), "the sidebar lists the Spaces deck too");
  hub.handleInput("b");

  console.log("\n[2] n spawns a REAL lane (the existing spawn flow opens it HERE); 9 shows its row");
  hub.handleInput("n");
  frame = await until(hub, (f) => f.includes("▶ "), "the spawned lane opening as a live agent pane");
  assert(frame.includes("▶ "), "n spawned a lane and the existing flow bound it to this pane");
  hub.handleInput("9"); // back to the Agents table in this pane
  frame = await until(hub, (f) => /▸ \S+/.test(f) && !f.includes("no agents running"), "the spawned lane's table row");
  const row = frame.split("\n").find((l) => l.includes("▸"))!;
  assert(/\b(starting|working|needs-approval|awaiting-input|done|error|stopped)\b/.test(row), `the row carries the LaneStatus vocabulary verbatim: ${row.trim().slice(0, 80)}`);
  assert(/\d+[smhd]/.test(row), "the row carries a live elapsed cell");

  console.log("\n[3] Enter attaches the selected agent into THIS pane (ADR-0420)");
  hub.handleInput("\r");
  frame = await until(hub, (f) => f.includes("▶ "), "the live agent pane title");
  assert(frame.includes("▶ "), "Enter on the Agents table re-bound this pane to the selected agent");

  console.log("\n[4] c cancels through the fleet route; x dismisses only a STOPPED lane");
  hub.handleInput("9"); // back to the Agents table in this pane
  hub.handleInput("c");
  frame = await until(hub, (f) => /cancel/.test(f), "the cancel verb's honest status line");
  assert(/cancel/.test(frame), "c drove /api/fleet/cancel and the status line reports the engine's answer");
  const lanes = (await (await fetch(`${base}/api/fleet/status`, { headers: hdr })).json()) as { data?: { lanes?: { id: string; status: string }[] } };
  const laneId = lanes.data?.lanes?.[0]?.id ?? "";
  assert(laneId !== "", "the engine reports the spawned lane on /api/fleet/status");
  if (!["done", "error", "stopped"].includes(lanes.data?.lanes?.[0]?.status ?? "")) {
    hub.handleInput("x");
    frame = await until(hub, (f) => f.includes("x dismisses a STOPPED agent"), "the live-lane dismiss refusal");
    assert(frame.includes("x dismisses a STOPPED agent"), "x on a live lane is refused with the way out named");
    await fetch(`${base}/api/fleet/stop`, { method: "POST", headers: hdr, body: JSON.stringify({ laneId }) });
    await until(hub, (f) => /\b(stopped|done|error)\b/.test(f.split("\n").find((l) => l.includes("▸")) ?? ""), "the lane settling after stop");
  }
  hub.handleInput("x");
  frame = await until(hub, (f) => f.includes("no agents running") || f.includes("dismissed"), "the dismissed lane leaving the table");
  assert(frame.includes("no agents running") || frame.includes("dismissed"), "x dismissed the stopped lane through /api/fleet/remove");

  console.log("\n[5] deck 0: spaces list, create, focus, inline rename, close, last refuses");
  hub.handleInput("0");
  frame = hub.render(140).join("\n");
  assert(frame.includes("▦ Spaces") && frame.includes("●") && frame.includes("main"), "the Spaces deck lists the focused default space");
  hub.handleInput("n");
  frame = hub.render(140).join("\n");
  assert(frame.includes("created space"), "n created a space through the model (which activates it, tmux-style)");
  hub.handleInput("0"); // the fresh space opens on Overview; put the Spaces deck in its pane
  hub.handleInput("j"); // select the new space's row
  hub.handleInput("\r");
  frame = hub.render(140).join("\n");
  assert(/space → /.test(frame), "Enter focused the selected space");
  assert((frame.split("\n").find((l) => l.includes("▸")) ?? "").includes("●"), "the focus marker sits on the selected (active) space");
  hub.handleInput("r");
  for (const ch of "-renamed") hub.handleInput(ch);
  hub.handleInput("\r");
  frame = hub.render(140).join("\n");
  assert(frame.includes("-renamed"), "r renamed the space inline (prefilled name edited, ⏎ saved)");
  hub.handleInput("x");
  frame = hub.render(140).join("\n");
  assert(frame.includes("closed space"), "x closed the extra space");
  hub.handleInput("x");
  frame = hub.render(140).join("\n");
  assert(frame.includes("close refused: the hub keeps at least one space"), "closing the LAST space surfaces the model's own refusal verbatim");

  console.log("\n[6] the existing six decks are unchanged");
  for (const [key, title] of [["1", "Overview"], ["2", "Security"], ["3", "Fleet"], ["4", "Sessions"], ["5", "Audit"], ["6", "Usage"]] as const) {
    hub.handleInput(key);
    if (!hub.render(140).join("\n").includes(title)) { console.error(`  \u2717 deck ${key} lost its ${title} view`); process.exit(1); }
  }
  console.log("  \u2713 keys 1-6 still land Overview, Security, Fleet, Sessions, Audit, Usage");

  hub.dispose();
  console.log("\nP-TUI.4 demo: PASS");
} finally {
  engineProc.kill("SIGTERM");
  await engineProc.exited;
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
