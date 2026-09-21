// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-JEV.4 (ADR-0379) - the Jev browser action policy. Proves, offline and against the REAL
// module surfaces the app loads, that:
//   (1) the policy maps a snapshot to ONE judgment request (operation head + a speculative target head
//       per offered operation + the value head only when values exist) and folds the typed answers into
//       exactly one executable decision, reading only the head the operation selected;
//   (2) the REAL browser_run tool, registered through the extension's default export the way omp loads
//       it, drives a scripted run end to end: TYPE_TEXT with a caller-supplied value, then CLICK, then
//       DONE, executing through /act with the snapshot's freshness reference, and reports typed values
//       by NAME only;
//   (3) fail-closed holds at every seam: a malformed judgment executes nothing, a stale act re-decides
//       without spending a step, an unreachable judge stops before the first snapshot, TYPE_TEXT with no
//       values stops with needs_values;
//   (4) the desktop wiring exists in the bytes that run: the two routes and the token allowlist in
//       dev.ts, the isolated-world executor in main.ts, the mailbox ops in browser_control.ts;
//   (5) the skill is discoverable where omp looks and its frontmatter names it.
// The live window (isolated world, sendInputEvent, settle) was exercised by hand in a real Chromium during
// the increment; it is not reachable from a bun script, so this demo stops at the mailbox.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import browserExtension, { type JudgeLike, runBrowserGoal } from "../../harness/omp/browser_extension.ts";
import { actionSpace, decide, policyQuestions, policyState, validateChoice } from "../../harness/browser_policy.ts";
import { type BrowserAction, type BrowserPage, freshnessOf } from "../browser_snapshot.ts";

const REPO = join(import.meta.dir, "..", "..");
let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}`);
  if (!ok) failures++;
}

console.log("== P-JEV.4 - the Jev browser action policy ==");

// ── a snapshot shaped like the one a real Chromium returned for the flights fixture ────────────────
const actions: BrowserAction[] = [
  { id: "e1", kind: "fill", node: 1, role: "textbox", label: "Where from?", value: "Zurich" },
  { id: "e2", kind: "click", node: 1, role: "textbox", label: "Open Where from?", value: "Zurich" },
  { id: "e3", kind: "fill", node: 2, role: "combobox", label: "Where to?", value: "" },
  { id: "e4", kind: "click", node: 2, role: "combobox", label: "Open Where to?", value: "" },
  { id: "e5", kind: "select", node: 3, role: "combobox", label: "Class -> Business", value: "biz", current_value: "Economy" },
  { id: "e6", kind: "click", node: 4, role: "checkbox", label: "Nonstop only", value: "on", checked: "false" },
  { id: "e7", kind: "click", node: 5, role: "button", label: "Search", value: "" },
  { id: "wait", kind: "wait", label: "Wait for the page to update" },
];
const pageA: BrowserPage = {
  url: "https://example.test/flights", title: "Flights fixture", w: 1120, h: 780,
  text: "Find flights\nWhere from?\nWhere to?\nClass\nNonstop only\nSearch",
  scroll: { y: 0, height: 780 }, actions, marker: ["m", 1], page_key: ["k", 1],
  guards: { 1: ["g1"], 2: ["g2"], 3: ["g3"], 4: ["g4"], 5: ["g5"] }, omitted_actions: 0, fingerprint: "fp-a",
};
const pageB: BrowserPage = { ...pageA, text: `${pageA.text}\nsearched London`, marker: ["m", 2], page_key: ["k", 2], fingerprint: "fp-b" };

// ── (1) the policy ────────────────────────────────────────────────────────────────────────────────
const space = actionSpace(actions);
check("one index per node: 5 elements from 7 element actions", space.elements.length === 5);
check("the editable field owns both TYPE_TEXT and CLICK", space.elements[1]?.operations.join("/") === "TYPE_TEXT/CLICK");
check("select options are index:n targets carrying the current value", space.targets.SELECT?.["3:1"]?.value === "biz" && space.elements[2]?.value === "Economy");
check("wait is a control, not a target", "WAIT" in space.controls);
const values = { destination: "London" };
const qs = policyQuestions(space, "Search flights from Zurich to London", values);
check("question heads: operation + one target per offered operation + the value head", Object.keys(qs).sort().join(",") === "click_target,operation,select_target,type_text_target,type_text_value");
check("operation criteria are exactly the offered operations, controls, DONE and BLOCKED", Object.keys(qs.operation!.criteria).sort().join(",") === "BLOCKED,CLICK,DONE,SELECT,TYPE_TEXT,WAIT");
check("no value head without values", !("type_text_value" in policyQuestions(space, "x", {})));
const state = policyState(pageA, space, [], values);
const pageText = (state.page as { text: string }).text;
check("page text is delimited as untrusted content", pageText.startsWith("UNTRUSTED_CONTENT_START\n") && pageText.endsWith("\nUNTRUSTED_CONTENT_END"));
check("the judge sees value names, never values", JSON.stringify(state).includes("destination") && !JSON.stringify(state).includes("London"));
const one = (keys: string[], pick: string): Record<string, number> => Object.fromEntries(keys.map((k) => [k, k === pick ? 1 : 0]));
const opIds = Object.keys(qs.operation!.criteria);
const garbage = { choice: "nope", probabilities: {}, confidence: 2 };
const typeAnswers = {
  operation: { choice: "TYPE_TEXT", probabilities: one(opIds, "TYPE_TEXT"), confidence: 0.9 },
  type_text_target: { choice: "2", probabilities: one(Object.keys(qs.type_text_target!.criteria), "2"), confidence: 0.8 },
  click_target: garbage, select_target: garbage,
  type_text_value: { choice: "destination", probabilities: { destination: 1 }, confidence: 0.95 },
};
const d1 = decide(typeAnswers, space, values);
check("TYPE_TEXT reads only its own head: garbage in the other heads is ignored", d1.kind === "act" && d1.action.id === "e3" && d1.text === "London");
const d2 = decide({ ...typeAnswers, type_text_value: garbage }, space, {});
check("TYPE_TEXT without values stops with needs_values naming the field", d2.kind === "needs_values" && d2.field === "Where to?");
let threw = false;
try { validateChoice({ choice: "TYPE_TEXT", probabilities: { ...one(opIds, "TYPE_TEXT"), CLICK: 0.5 }, confidence: 0.5 }, opIds); } catch { threw = true; }
check("a probability vector that does not sum to one is rejected", threw);
check("DONE short-circuits before any target head is read", decide({ operation: { choice: "DONE", probabilities: one(opIds, "DONE"), confidence: 0.7 }, click_target: garbage }, space, values).kind === "done");

// ── (2) the real tool, registered the way omp registers it ─────────────────────────────────────────
interface Tool { name: string; approval: string; execute: (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<{ content: { text?: string }[]; isError?: boolean }> }
const tools: Tool[] = [];
process.env.LUCID_BROWSER_URL = "http://127.0.0.1:1/api/browser?t=demo";
const scripted = (answers: Record<string, unknown>[]): JudgeLike => ({ judge: async () => ({ answers: answers.shift() ?? {} }) });
let judgeForRun: JudgeLike = scripted([]);
browserExtension({ registerTool: (t: Tool) => { tools.push(t); } }, { judge: async () => judgeForRun });
const run = tools.find((t) => t.name === "browser_run");
check("browser_run registers alongside the eight P-BROWSER tools", tools.length === 9 && !!run && run.approval === "read");

// Route the tool's fetch at a scripted desktop: snapshot answers pageA until an act happened, then pageB.
const acts: unknown[] = [];
let served = pageA;
const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const path = new URL(String(url)).pathname;
  if (path.endsWith("/snapshot")) return Response.json({ ok: true, data: { page: served } });
  if (path.endsWith("/act")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { action: BrowserAction };
    acts.push(body);
    if (body.action.id === "e7") served = pageB;
    return Response.json({ ok: true, data: { title: served.title, url: served.url } });
  }
  return Response.json({ ok: false, error: `unexpected ${path}` });
}, { preconnect() { /* stub */ } });
try {
  const clickAnswers = {
    operation: { choice: "CLICK", probabilities: one(opIds, "CLICK"), confidence: 0.85 },
    click_target: { choice: "5", probabilities: one(Object.keys(qs.click_target!.criteria), "5"), confidence: 0.9 },
    type_text_target: garbage, select_target: garbage, type_text_value: garbage,
  };
  judgeForRun = scripted([typeAnswers, clickAnswers, { operation: { choice: "DONE", probabilities: one(opIds, "DONE"), confidence: 0.75 } }]);
  const out = await run!.execute("t1", { goal: "Search flights from Zurich to London", values: JSON.stringify(values) }, undefined, undefined, {});
  const text = out.content[0]?.text ?? "";
  console.log(text.split("\n").map((l) => `      | ${l}`).join("\n"));
  check("the run ends done after 2 actions", !out.isError && text.startsWith("browser_run done after 2 action(s)"));
  const first = acts[0] as { action: BrowserAction; fresh: unknown; text?: string };
  check("act 1 is the fill with the caller's value and the snapshot's marker freshness", first?.action.id === "e3" && first.text === "London" && JSON.stringify(first.fresh) === JSON.stringify(freshnessOf(pageA, actions[2]!)));
  const second = acts[1] as { action: BrowserAction; fresh: unknown; text?: string };
  check("act 2 is the Search click with the scoped page_key + guard freshness", second?.action.id === "e7" && second.text === undefined && JSON.stringify(second.fresh) === JSON.stringify({ page_key: ["k", 1], guard: ["g5"] }));
  check("typed text is reported by value name only", text.includes("typed destination") && !text.includes("London"));

  // (3) fail-closed seams, through the exported loop with an io pair
  const io = (pages: BrowserPage[], actResult: unknown) => ({
    calls: [] as string[],
    snapshot: async function (this: { calls: string[] }) { this.calls.push("snapshot"); return { ok: true, data: { page: pages.shift() ?? pageB } }; },
    act: async function (this: { calls: string[] }) { this.calls.push("act"); return actResult; },
  });
  const bad = io([pageA], { ok: true });
  const r1 = await runBrowserGoal(bad, scripted([{ operation: { choice: "SELECT", probabilities: one(opIds, "SELECT"), confidence: 0.9 }, select_target: garbage }]), "g", {}, 5);
  check("a malformed target head fails closed: isError, nothing executed", r1.isError === true && !bad.calls.includes("act"));
  const staleIo = io([pageA, pageA, pageB], { ok: false, stale: true, error: "page changed since this decision" });
  const r2 = await runBrowserGoal(staleIo, scripted([clickAnswers, { operation: { choice: "DONE", probabilities: one(opIds, "DONE"), confidence: 0.75 } }]), "g", {}, 5);
  check("a stale act re-snapshots and re-decides without spending a step", (r2.content[0]?.text ?? "").startsWith("browser_run done after 0 action(s)") && staleIo.calls.join(",") === "snapshot,act,snapshot");
  const needs = io([pageA], { ok: true });
  const r3 = await runBrowserGoal(needs, scripted([{ ...typeAnswers, type_text_value: garbage }]), "g", {}, 5);
  check("TYPE_TEXT with no values stops with needs_values and the hint", (r3.content[0]?.text ?? "").includes('Supply values={"Where to?":"..."}') && !needs.calls.includes("act"));
  const calls: string[] = [];
  globalThis.fetch = Object.assign(async (): Promise<Response> => { calls.push("fetch"); return Response.json({ ok: true }); }, { preconnect() { /* stub */ } });
  judgeForRun = { judge: async () => { throw new Error("unreachable"); } };
  const deps2: Tool[] = [];
  browserExtension({ registerTool: (t: Tool) => { deps2.push(t); } }, { judge: async () => { throw new Error("no registry"); } });
  const r4 = await deps2.find((t) => t.name === "browser_run")!.execute("t2", { goal: "g" }, undefined, undefined, {});
  check("an unreachable judge stops before the first snapshot", r4.isError === true && (r4.content[0]?.text ?? "").includes("judgment backend unavailable") && calls.length === 0);
} finally {
  globalThis.fetch = realFetch;
}

// ── (4) the desktop wiring, in the bytes that run ──────────────────────────────────────────────────
const dev = readFileSync(join(REPO, "desktop", "dev.ts"), "utf8");
const main = readFileSync(join(REPO, "desktop", "main.ts"), "utf8");
const control = readFileSync(join(REPO, "desktop", "browser_control.ts"), "utf8");
check("dev.ts serves /api/browser/snapshot and /api/browser/act", dev.includes('p === "/api/browser/snapshot"') && dev.includes('p === "/api/browser/act"'));
check("both routes accept the ?t= token the omp child carries", /"\/api\/browser\/snapshot",\s*"\/api\/browser\/act"/.test(dev));
check("the result route forwards page and stale", dev.includes("isBrowserPageShape(b.page)") && dev.includes("typeof b.stale === \"boolean\""));
check("main.ts runs the policy scripts in the isolated world", main.includes("executeJavaScriptInIsolatedWorld(BROWSER_POLICY_WORLD") && main.includes("agentBrowserSnapshot") && main.includes("agentBrowserAct"));
check("main.ts refuses a stale decision and a covered target", main.includes("page changed since this decision") && main.includes("target changed or is covered"));
check("the mailbox knows the two ops", control.includes('"snapshot" | "act"'));

// ── (5) the skill ─────────────────────────────────────────────────────────────────────────────────
const skill = readFileSync(join(REPO, ".agents", "skills", "jev-browser", "SKILL.md"), "utf8");
check("the skill's frontmatter names jev-browser and mentions browser_run", /^---\nname: jev-browser\n/.test(skill) && skill.includes("browser_run"));
const fresh = [
  skill,
  readFileSync(join(REPO, "desktop", "browser_snapshot.ts"), "utf8"),
  readFileSync(join(REPO, "harness", "browser_policy.ts"), "utf8"),
  readFileSync(join(REPO, "harness", "omp", "browser_extension.ts"), "utf8"),
  control,
  dev.slice(dev.indexOf('p === "/api/browser/snapshot"'), dev.indexOf('p === "/api/browser/close"')),
  main.slice(main.indexOf("P-JEV.4 (ADR-0379): the Jev browser policy's executor half"), main.indexOf("async function agentBrowserClose")),
];
check("no em dashes in the bytes this increment wrote", fresh.every((s) => s.length > 0 && !s.includes("\u2014")));

if (failures) { console.log(`\n${failures} CHECK(S) FAILED`); process.exit(1); }
console.log("\nALL CHECKS PASSED");
process.exit(0);
