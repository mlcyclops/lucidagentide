// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_netstat_1.ts
//
// P-NETSTAT.1 (ADR-0422): a network problem reads as a network problem, not a model failure.
//   [1] the engine probe times a REAL round trip to a live host, and a dead host reads offline;
//   [2] the reported failure ("acp: initialize timed out after 20000ms") is startup, not the model;
//       transport errors and a down link are the network; a real provider refusal still blames the model;
//   [3] a held prompt waits for a stable link (three answered probes), then resends, at most twice;
//   [4] outage toasts are held, security notices never are;
//   [5] a model id only selects a fixed probe host.
//
// Run: bun run harness/scripts/demo_p_netstat_1.ts

import { headProbe, MIN_GAP_MS, NetProbe } from "../../desktop/net_probe.ts";
import {
  classifyTurnFailure, MAX_AUTO_RESEND, netLabel, probeTargetFor, shouldHoldToast, standbyVerdict, summarizeNet,
} from "../../desktop/renderer/net_status.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`  ok  ${m}`); };

console.log("== #ADR-0422 P-NETSTAT.1: stand by for the network instead of blaming the model ==\n");

console.log("[1] the engine probe against real sockets");
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null, { status: 404 }) });
const live = `http://127.0.0.1:${server.port}/`;
const ms = await headProbe(live, 2000);
ok(ms !== null && ms >= 0, `a live host answers (404 counts as reachable): ${ms} ms`);
const deadPort = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
const dead = `http://127.0.0.1:${deadPort.port}/`;
deadPort.stop(true);
ok(await headProbe(dead, 2000) === null, "a closed port is a failed probe, not an exception");
let clock = 0;
const probe = new NetProbe(headProbe, () => clock);
await probe.check(dead); clock += MIN_GAP_MS;
const off = await probe.check(dead);
ok(off.state === "offline", `two failed probes in a row read ${off.state}; label: ${netLabel(off, true).text}`);
for (let i = 0; i < 3; i++) { clock += MIN_GAP_MS; await probe.check(live); }
const on = await probe.check(live);
ok(on.state === "online" && on.stable, `three answers on the new host: ${on.state}, stable, median ${on.medianMs} ms, label "${netLabel(on, true).text}"`);
server.stop(true);

console.log("\n[2] who is to blame for a turn that produced nothing");
const healthy = summarizeNet([{ at: 0, ok: true, ms: 80 }, { at: 1, ok: true, ms: 90 }, { at: 2, ok: true, ms: 85 }], "api.anthropic.com");
const reported = "acp: initialize timed out after 20000ms";
ok(classifyTurnFailure({ reason: reported, view: healthy, browserOnline: true }) === "starting", `"${reported}" is LUCID starting up, not the model`);
ok(classifyTurnFailure({ reason: reported, view: off, browserOnline: true }) === "network", "the same failure on a down link is the network");
ok(classifyTurnFailure({ reason: "getaddrinfo ENOTFOUND api.anthropic.com", view: healthy, browserOnline: true }) === "network", "a DNS failure is the network");
ok(classifyTurnFailure({ view: healthy, browserOnline: false }) === "network", "the OS reporting no connection is the network");
ok(classifyTurnFailure({ reason: "529 overloaded_error: Overloaded", view: healthy, browserOnline: true }) === "model", "a provider overload on a healthy link still offers another model");

console.log("\n[3] the held prompt");
const hold = { cause: "network" as const, browserOnline: true, modelsReady: true, waitedMs: 5000, attempts: 0 };
ok(!standbyVerdict({ ...hold, view: off }).resend, `down link: "${standbyVerdict({ ...hold, view: off }).line}"`);
ok(standbyVerdict({ ...hold, view: on }).resend, "stable link: resend");
ok(standbyVerdict({ ...hold, view: on, attempts: MAX_AUTO_RESEND }).giveUp, `after ${MAX_AUTO_RESEND} automatic resends the user decides`);

console.log("\n[4] toasts during an outage");
ok(shouldHoldToast({ tone: "warn", title: "Push not delivered", desc: "the backend is unreachable" }, off, true), "an outage warning is held in the network popover");
ok(!shouldHoldToast({ tone: "danger", title: "Tool call blocked", desc: "hidden Unicode quarantined" }, off, true), "a security block always pops");

console.log("\n[5] the probe host");
ok(probeTargetFor("claude-opus-5-5") === "https://api.anthropic.com", "Claude probes api.anthropic.com");
ok(!probeTargetFor("http://169.254.169.254/").includes("169.254"), "a model id can never name the URL the engine fetches");

console.log("\nPASS: P-NETSTAT.1 - network trouble reads as network trouble, with latency, and held prompts resend once stable.");
