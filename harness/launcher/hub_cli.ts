// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-TUI.3 (ADR-0436): `lucid hub <args>`. Bare `lucid hub` launches the TUI; `--headless` runs the same
// hub with no terminal (an agent's or CI's hub); `--skill` prints the agent-facing skill doc; anything
// else is a control command (hub_tmux_verbs.ts) sent to the RUNNING hub through its discovery file.
// Contract for scripts: JSON on stdout + exit 0, or JSON {"error":code,"message"} on stderr + exit 1.
// No hub running is {"error":"no_hub"}. This path never loads pi-tui and never starts a hub.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { discoveryDir } from "../../desktop/engine_discovery.ts";
import { callHub, connectHub, type HubReply } from "./hub_control.ts";
import { HubOpError } from "./hub_spaces.ts";
import { parseHubCommand } from "./hub_tmux_verbs.ts";

type Env = Readonly<Record<string, string | undefined>>;

const fail = (body: Record<string, unknown>): number => {
  process.stderr.write(JSON.stringify(body) + "\n");
  return 1;
};

export async function runHub(argv: readonly string[], env: Env, repoRoot: string): Promise<number> {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--headless")) {
    // Dynamic on purpose: the control CLI must not load pi-tui (or start anything) to send one command.
    const { runHubCli } = await import("./hub_tui.ts");
    return runHubCli(env, { headless: argv[0] === "--headless" });
  }
  if (argv.length === 1 && argv[0] === "--skill") {
    // Another increment authors skills/lucid-hub/SKILL.md; until it lands this is a one-line pointer.
    let doc: string;
    try { doc = readFileSync(join(repoRoot, "skills", "lucid-hub", "SKILL.md"), "utf8"); }
    catch { doc = "lucid hub skill: not installed yet; run `lucid hub status` or see docs/TUI.md (control plane) and DECISIONS.md ADR-0436.\n"; }
    process.stdout.write(doc.endsWith("\n") ? doc : `${doc}\n`);
    return 0;
  }
  try {
    parseHubCommand(argv); // usage errors answer locally, hub or no hub
  } catch (e) {
    if (e instanceof HubOpError) return fail({ error: e.code, message: e.message });
    throw e;
  }
  const hub = await connectHub(discoveryDir(env));
  if (!hub) return fail({ error: "no_hub", message: "no running lucid hub answered the handshake (start one with `lucid hub` or `lucid hub --headless`)" });
  let r: HubReply;
  try { r = await callHub(hub, argv); }
  catch (e) { return fail({ error: "hub_unreachable", message: e instanceof Error ? e.message : String(e) }); }
  if (r.status !== 200 || r.body.ok !== true) return fail(r.body);
  process.stdout.write(JSON.stringify(r.body.data, null, 2) + "\n");
  return 0;
}
