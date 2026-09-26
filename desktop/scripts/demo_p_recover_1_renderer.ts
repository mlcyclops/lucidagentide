// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-RECOVER.1 (ADR-0385), renderer slice. Proves against the BUILT bundle (the bytes the engine
// serves, ADR-0303) that:
//   (1) build-renderer succeeds with the recovery supervisor, notice and Submit dialog wired in;
//   (2) the served renderer calls every recovery/incident route of the contract and the restart IPC;
//   (3) it carries the user-facing progress/result strings and the Submit dialog's disclosure;
//   (4) the field scenario ("reconnecting" with the engine gone) ends in ONE engine restart, and a refused
//       send against an idle engine ends in ONE agent recovery, driven through the real pure supervisor;
//   (5) no em or en dash in anything this slice wrote.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterProbe, afterRemedy, startRecovery, type EngineProbe, type RecoveryStep } from "../renderer/recovery_supervisor.ts";

const DESKTOP = join(import.meta.dir, "..");
let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}`);
  if (!ok) failures++;
}

console.log("== P-RECOVER.1 - renderer: recovery supervisor, notices, incident Submit ==");

console.log("\n[1] build-renderer");
const br = Bun.spawnSync(["bun", "build", "renderer/app.ts", "--target=browser", "--outfile", "renderer/app.bundle.js", "--sourcemap=inline"], { cwd: DESKTOP, stdout: "ignore", stderr: "pipe" });
check("bun run build-renderer exits 0", br.exitCode === 0);
if (br.exitCode !== 0) console.log(br.stderr.toString());

console.log("\n[2] routes and IPC in the served bundle");
const bundle = readFileSync(join(DESKTOP, "renderer", "app.bundle.js"), "utf8");
for (const route of ["/api/recovery/state", "/api/recovery/resume", "/api/recovery/recover", "/api/incidents", "/api/incidents/report?id=", "/api/incidents/seen", "/api/incidents/update", "/api/session-health", "restartEngine"]) {
  check(`bundle calls ${route}`, bundle.includes(route));
}

console.log("\n[3] user-facing strings");
for (const s of [
  "Checking the engine", "Restarting the agent process", "Restarting the engine", "Reconnecting to the running turn",
  "Your previous session could not be recovered. A new session was started.", "An incident report was saved.",
  "Submit an incident report", "GitHub issues are public.", "Open GitHub issue", "Show report file", "Copy full report", "Not now",
  "The engine was restarted. Reloading the window.",
]) check(`bundle carries "${s}"`, bundle.includes(s));
check("styles carry the recovery notice + incident dialog", /\.recovery-note\{/.test(readFileSync(join(DESKTOP, "renderer", "styles.css"), "utf8")));

console.log("\n[4] the field scenarios end");
const drive = (s: RecoveryStep, probes: EngineProbe[], remedy: (a: string) => boolean): string[] => {
  const seen: string[] = [];
  let i = 0;
  while (!s.run.finished) {
    seen.push(s.action.type);
    if (s.action.type === "probe") s = afterProbe(s.run, probes[Math.min(i++, probes.length - 1)]!);
    else if (s.action.type === "restart-engine") s = afterRemedy(s.run, { action: "restart-engine", ok: remedy("restart-engine") });
    else s = afterRemedy(s.run, { action: s.action.type as "reattach" | "recover-agent" | "resync", ok: remedy(s.action.type) });
  }
  seen.push(s.action.type === "done" ? `done:${s.action.how}` : `give-up:${s.action.reason}`);
  return seen;
};
const down: EngineProbe = { engineReachable: false, turnRunning: null, masterDead: false, exhausted: false };
const idle: EngineProbe = { engineReachable: true, turnRunning: false, masterDead: false, exhausted: false };
const gone = drive(startRecovery({ kind: "connection", state: "reconnecting" }, { waiting: true }), [down], () => true);
console.log(`     reconnecting, engine gone: ${gone.join(" -> ")}`);
check("engine gone: exactly one restart, then done", gone.filter((a) => a === "restart-engine").length === 1 && gone.at(-1) === "done:engine-restarted");
const wedged = drive(startRecovery({ kind: "send-failed", reason: "already-running" }, { waiting: false }), [idle], () => true);
console.log(`     refused send, engine idle: ${wedged.join(" -> ")}`);
check("wedged listener: exactly one agent recovery, then done", wedged.filter((a) => a === "recover-agent").length === 1 && wedged.at(-1) === "done:agent-recovered");
const hopeless = drive(startRecovery({ kind: "connection", state: "reconnecting" }, { waiting: true }), [down], () => false);
console.log(`     reconnecting, engine gone, restart fails: ${hopeless.join(" -> ")}`);
check("restart failed: gives up instead of looping", hopeless.at(-1)?.startsWith("give-up:") === true && hopeless.length < 10);

console.log("\n[5] writing rule: no em/en dash");
for (const f of ["renderer/recovery_supervisor.ts", "renderer/recovery_supervisor.test.ts", "renderer/incident_notice.ts", "scripts/demo_p_recover_1_renderer.ts"]) {
  check(`${f} has no U+2014/U+2013`, !/[\u2013\u2014]/.test(readFileSync(join(DESKTOP, f), "utf8")));
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
