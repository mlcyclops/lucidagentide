// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_model_11.ts
//
// P-MODEL.11 (ADR-0602): subagent per-call model choice is a user setting LUCID writes at spawn. For each case the
// demo resolves the effective value, writes the overlay file the engine writes, loads it through omp's OWN config
// loader together with LUCID's acp_config.yml, and asks omp's real `perCallModelEnabled` whether a task call may
// name its model.
//
//   1. without LUCID's overlay (today), omp says no: the default is off and a project setting cannot turn it on
//   2. the setting On -> omp accepts a per-call model on task calls; Only in eval agents -> eval only
//   3. AskSage lockdown and a managed model restriction keep it off, even with `on` in the global config.yml
//   4. the overlay merges over acp_config.yml without dropping its settings
//
// Run: bun run desktop/scripts/demo_p_model_11.ts

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgEditMode } from "@oh-my-pi/pi-coding-agent/edit/settings";
import { cfgTaskPerCallModel, perCallModelEnabled } from "@oh-my-pi/pi-coding-agent/task/settings";
import { cfgToolsApproval } from "@oh-my-pi/pi-coding-agent/tools/settings";
import type { ManagedModels } from "../managed_config.ts";
import { resolvePerCallModel, writePerCallModelOverlay, type PerCallModelSetting } from "../per_call_model.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (m: string): void => console.log(`   ok - ${m}`);

const ACP_CONFIG = join(import.meta.dir, "..", "..", "harness", "omp", "acp_config.yml");
const work = mkdtempSync(join(tmpdir(), "lucid-model11-"));
const overlayFile = join(work, "lucid-per-call-model.yml");
const emptyAgent = join(work, "agent-empty");
const onAgent = join(work, "agent-on"); // a user whose global config.yml already says on
const project = join(work, "project"); // a repository whose .omp/config.yml says on (agent-writable)
for (const d of [emptyAgent, onAgent, join(project, ".omp")]) mkdirSync(d, { recursive: true });
writeFileSync(join(onAgent, "config.yml"), "task:\n  perCallModel: on\n");
writeFileSync(join(project, ".omp", "config.yml"), "task:\n  perCallModel: on\n");

interface Case { stored: PerCallModelSetting; asksageLocked?: boolean; models?: ManagedModels; agentDir?: string }

async function load(c: Case | null): Promise<{ settings: Settings; effective: string }> {
  const configFiles = [ACP_CONFIG];
  let effective = "(no LUCID overlay)";
  if (c) {
    const view = resolvePerCallModel(c.stored, { asksageLocked: c.asksageLocked ?? false, models: c.models });
    writePerCallModelOverlay(overlayFile, view.effective);
    configFiles.push(overlayFile);
    effective = view.effective;
  }
  const settings = await Settings.loadReadOnly({ cwd: project, agentDir: c?.agentDir ?? emptyAgent, configFiles });
  return { settings, effective };
}

const verdict = (s: Settings) => `task=${perCallModelEnabled(s, "task")}, eval=${perCallModelEnabled(s, "eval")}`;

try {
  console.log("1) without LUCID's overlay omp refuses a per-call model, and the repository's own `on` does not count");
  {
    const { settings } = await load(null);
    if (cfgTaskPerCallModel.get(settings) !== "on") fail("the demo's project config.yml was not read, so this check would prove nothing");
    if (perCallModelEnabled(settings, "task") || perCallModelEnabled(settings, "eval")) fail("a project config.yml must not turn per-call model choice on");
    ok(`project .omp/config.yml read (merged value ${String(cfgTaskPerCallModel.get(settings))}) -> ${verdict(settings)}`);
  }

  console.log("2) the LUCID setting turns it on through the spawn overlay");
  {
    const on = await load({ stored: "on" });
    if (!perCallModelEnabled(on.settings, "task") || !perCallModelEnabled(on.settings, "eval")) fail("On must allow task and eval");
    ok(`On -> overlay ${on.effective} -> ${verdict(on.settings)}`);
    const ev = await load({ stored: "eval" });
    if (perCallModelEnabled(ev.settings, "task") || !perCallModelEnabled(ev.settings, "eval")) fail("Only in eval agents must allow eval only");
    ok(`Only in eval agents -> overlay ${ev.effective} -> ${verdict(ev.settings)}`);
    const off = await load({ stored: "off" });
    if (perCallModelEnabled(off.settings, "task") || perCallModelEnabled(off.settings, "eval")) fail("Off must refuse");
    ok(`Off -> overlay ${off.effective} -> ${verdict(off.settings)}`);
  }

  console.log("3) the clamps hold even when the user's global config.yml says on");
  {
    const cases: [string, Case][] = [
      ["global config.yml on, LUCID Off", { stored: "off", agentDir: onAgent }],
      ["AskSage lockdown", { stored: "on", asksageLocked: true, agentDir: onAgent }],
      ["managed allow-list", { stored: "on", models: { allowed: ["anthropic/"] }, agentDir: onAgent }],
      ["managed deny-list", { stored: "on", models: { denied: ["deepseek"] }, agentDir: onAgent }],
      ["managed model lock", { stored: "on", models: { lock: true }, agentDir: onAgent }],
    ];
    for (const [name, c] of cases) {
      const r = await load(c);
      if (perCallModelEnabled(r.settings, "task") || perCallModelEnabled(r.settings, "eval")) fail(`${name}: per-call model choice must stay off`);
      ok(`${name} -> overlay ${r.effective} -> ${verdict(r.settings)}`);
    }
  }

  console.log("4) the overlay merges over acp_config.yml: LUCID's other omp settings are still in force");
  {
    const { settings } = await load({ stored: "on" });
    const approval = cfgToolsApproval.get(settings) as Record<string, unknown>;
    if (cfgEditMode.get(settings) !== "replace") fail("acp_config.yml's edit.mode must survive the overlay");
    if (approval.bash !== "prompt" || approval.eval !== "prompt") fail("acp_config.yml's tools.approval must survive the overlay");
    ok(`edit.mode=${String(cfgEditMode.get(settings))}, tools.approval.bash=${String(approval.bash)}, tools.approval.eval=${String(approval.eval)}`);
  }

  console.log("\nP-MODEL.11 demo: all checks passed");
} finally {
  rmSync(work, { recursive: true, force: true });
}
