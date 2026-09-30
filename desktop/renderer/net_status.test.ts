// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-NETSTAT.1 (ADR-0422): the verdicts that decide whether a failed turn blames the model or waits on the
// network, and when a held prompt goes out again.
import { expect, test } from "bun:test";
import {
  classifyTurnFailure, MAX_AUTO_RESEND, type NetSample, type NetView, probeTargetFor, shouldHoldToast,
  STARTUP_GRACE_MS, standbyVerdict, summarizeNet,
} from "./net_status.ts";

const ok = (ms: number, at = 0): NetSample => ({ at, ok: true, ms });
const miss = (at = 0): NetSample => ({ at, ok: false, ms: null });
const healthy: NetView = summarizeNet([ok(80), ok(90), ok(85)], "api.anthropic.com");
const down: NetView = summarizeNet([ok(80), miss(), miss()], "api.anthropic.com");

test("summary: one failed first probe is still checking; two in a row is offline", () => {
  expect(summarizeNet([], "h").state).toBe("checking");
  expect(summarizeNet([miss()], "h").state).toBe("checking");
  expect(down.state).toBe("offline");
  expect(down.stable).toBe(false);
});

test("summary: a lone drop after answers is unstable, loss over the window is unstable, a slow median is slow", () => {
  expect(summarizeNet([ok(80), ok(80), miss()], "h").state).toBe("unstable");
  expect(summarizeNet([ok(80), miss(), ok(80), ok(80)], "h").state).toBe("unstable"); // 25% loss
  const slow = summarizeNet([ok(1200), ok(900), ok(1500)], "h");
  expect(slow.state).toBe("slow");
  expect(slow.stable).toBe(true);
  expect(healthy.state).toBe("online");
  expect(healthy.medianMs).toBe(85);
});

test("summary: stable needs the last three probes answered, and the window is bounded", () => {
  expect(summarizeNet([miss(), ok(80), ok(80)], "h").stable).toBe(false);
  expect(summarizeNet([miss(), ok(80), ok(80), ok(80)], "h").stable).toBe(true);
  // a long outage fills the window with misses; six answers clear the loss verdict, not twelve
  const after = summarizeNet([...Array.from({ length: 10 }, () => miss()), ...Array.from({ length: 6 }, () => ok(90))], "h");
  expect(after.state).toBe("online");
  const many = Array.from({ length: 40 }, (_, i) => (i < 30 ? miss(i) : ok(50, i)));
  const v = summarizeNet(many, "h");
  expect(v.samples).toBe(12);
  expect(v.history.length).toBe(12);
});

test("the reported case: omp's initialize timing out on a healthy link is startup, not the model", () => {
  expect(classifyTurnFailure({ reason: "acp: initialize timed out after 20000ms", view: healthy, browserOnline: true })).toBe("starting");
  expect(classifyTurnFailure({ reason: "acp: session/new timed out after 30000ms", view: healthy, browserOnline: true })).toBe("starting");
  // P-SANDBOX.18: the engine tags a contained handshake failure; it is still startup, never the model
  expect(classifyTurnFailure({ reason: "acp: initialize timed out after 20000ms (inside the Windows AppContainer sandbox)", view: healthy, browserOnline: true })).toBe("starting");
});

test("network evidence wins over any reason; transport errors are the network", () => {
  expect(classifyTurnFailure({ reason: "429 overloaded_error", view: healthy, browserOnline: false })).toBe("network");
  expect(classifyTurnFailure({ reason: "429 overloaded_error", view: down, browserOnline: true })).toBe("network");
  expect(classifyTurnFailure({ reason: "getaddrinfo ENOTFOUND api.anthropic.com", view: healthy, browserOnline: true })).toBe("network");
  expect(classifyTurnFailure({ reason: "fetch failed", view: null, browserOnline: true })).toBe("network");
  expect(classifyTurnFailure({ view: down, browserOnline: true })).toBe("network");
});

test("a real provider failure on a healthy link still blames the model; a missing omp is not 'starting'", () => {
  expect(classifyTurnFailure({ reason: "529 overloaded_error: Overloaded", view: healthy, browserOnline: true })).toBe("model");
  expect(classifyTurnFailure({ view: healthy, browserOnline: true })).toBe("model");
  expect(classifyTurnFailure({ reason: "acp: agent process failed to start: Executable not found", view: healthy, browserOnline: true })).toBe("model");
  // a prompt that ran for minutes then timed out is not a startup wait
  expect(classifyTurnFailure({ reason: "acp: session/prompt timed out after 600000ms", view: healthy, browserOnline: true })).toBe("model");
});

test("standby: waits while the link is down, resends once stable, gives up after the budget", () => {
  const base = { cause: "network" as const, browserOnline: true, modelsReady: true, waitedMs: 1000, attempts: 0 };
  expect(standbyVerdict({ ...base, view: down })).toMatchObject({ resend: false, giveUp: false });
  expect(standbyVerdict({ ...base, view: healthy, browserOnline: false }).resend).toBe(false);
  expect(standbyVerdict({ ...base, view: healthy }).resend).toBe(true);
  expect(standbyVerdict({ ...base, view: healthy, attempts: MAX_AUTO_RESEND })).toMatchObject({ resend: false, giveUp: true });
});

test("standby: a startup hold waits for the model list, but not past the grace period", () => {
  const base = { cause: "starting" as const, view: healthy, browserOnline: true, modelsReady: false, attempts: 0 };
  expect(standbyVerdict({ ...base, waitedMs: 2000 }).resend).toBe(false);
  expect(standbyVerdict({ ...base, waitedMs: STARTUP_GRACE_MS }).resend).toBe(true);
  expect(standbyVerdict({ ...base, modelsReady: true, waitedMs: 2000 }).resend).toBe(true);
});

test("toast hold: only warn/danger during an outage, and never a security notice", () => {
  const warn = { tone: "warn", title: "Push not delivered", desc: "the backend is unreachable" };
  expect(shouldHoldToast(warn, down, true)).toBe(true);
  expect(shouldHoldToast(warn, healthy, false)).toBe(true);
  expect(shouldHoldToast(warn, healthy, true)).toBe(false);
  expect(shouldHoldToast({ ...warn, tone: "ok" }, down, true)).toBe(false);
  expect(shouldHoldToast({ tone: "danger", title: "Tool call blocked", desc: "hidden Unicode quarantined" }, down, true)).toBe(false);
  expect(shouldHoldToast({ tone: "warn", title: "Approval needed", desc: "x" }, down, true)).toBe(false);
});

test("probe target: a model id selects a fixed host and can never name a URL", () => {
  expect(probeTargetFor("claude-opus-5-5")).toBe("https://api.anthropic.com");
  expect(probeTargetFor("gpt-6-astra")).toBe("https://api.openai.com");
  expect(probeTargetFor("asksage/gpt-5.6", { asksageBase: "https://gov.example/server" })).toBe("https://gov.example/server");
  expect(probeTargetFor("http://169.254.169.254/latest")).toBe("http://www.msftconnecttest.com/connecttest.txt");
  expect(probeTargetFor("claude-opus-5-5", { override: "https://proxy.corp/ping" })).toBe("https://proxy.corp/ping");
});
