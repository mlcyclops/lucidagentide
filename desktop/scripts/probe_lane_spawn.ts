// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/probe_lane_spawn.ts - P-FLEET.L16 diagnosis: where does a lane spawn actually spend
// its time in a DEV checkout? Drives the REAL fleetLaneArgv() plan (same gated omp binary, same -e
// extensions, same config) through the REAL ACPClient handshake against a scratch cwd, three times,
// timing every phase. Run: bun run desktop/scripts/probe_lane_spawn.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACPClient } from "../acp.ts";
import { fleetLaneArgv, interjectChildEnv } from "../acp_backend.ts";

const HANDSHAKE_MS = 30_000;
const plan = fleetLaneArgv();
console.log(`[probe] cmd=${plan.cmd}`);
console.log(`[probe] args=${plan.args.join(" ")}`);

async function once(round: number): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "lane-probe-"));
  const client = new ACPClient(plan.cmd, plan.args, cwd, interjectChildEnv(`probe-${round}`));
  const t0 = Date.now();
  const mark = (label: string) => console.log(`[probe ${round}] ${label} +${Date.now() - t0}ms`);
  try {
    client.start();
    mark("spawned");
    await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, { timeoutMs: HANDSHAKE_MS });
    mark("initialize ok");
    const s = await client.request<{ sessionId?: string; id?: string }>("session/new", { cwd, mcpServers: [] }, { timeoutMs: HANDSHAKE_MS });
    const sessionId = s?.sessionId ?? s?.id ?? null;
    mark(`session/new ok (${sessionId ? "id" : "NO ID"})`);
    if (sessionId) {
      await client.request("session/set_config_option", { sessionId, configId: "model", value: "anthropic/claude-opus-5" }, { timeoutMs: HANDSHAKE_MS });
      mark("set model ok");
    }
  } catch (e) {
    mark(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    try { client.stop(); } catch { /* dead */ }
    // Windows: the just-killed child may still hold the cwd for a beat - a leaked temp dir is fine for a probe.
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* EBUSY: leave it to tmp cleanup */ }
  }
}

for (let i = 1; i <= 3; i++) await once(i);
console.log("[probe] done");
