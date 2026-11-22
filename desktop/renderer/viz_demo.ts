// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_demo.ts - P-VIZ.1 (ADR-0622): the Visualize view's DEMO feed, for screenshots and QA.
//
// Reached ONLY with `?vizDemo=1` in the renderer URL, and the header then says DEMO in so many words. It is
// a fixed 48 second script, pure and deterministic (no randomness, no clock of its own): four agents (six since P-VIZ.7) and
// Main stream estimated tokens with scripted surges, one agent's tool fails twice, one is paused, one dies on
// an error and respawns, Main delegates two subagent runs and an agent delegates one. The view feeds it
// through the SAME model calls a real fleet uses (applyFleet, applyRuns, applyEvent), so the demo exercises
// the real rules instead of a parallel fake. The node action menu acts on the demo too, locally.
// P-VIZ.6 (ADR-0635): it also reports measured usage, makes a few edits and writes (one of them fails), and
// says which folder each agent works in, so the session ledger fills through the same calls.
// P-VIZ.7 (ADR-0641): six agents on six sponsors and every size class (a self-hosted model wears TL187), and
// three git commits a cycle (a lane's commit then push, a private lane's commit, Main's commit-namespace commit).
// P-WORLDS.BUILD1 (ADR-0653): one build per demo agent a cycle on a separate build channel (DemoStep.builds: pieces,
// lock-ins, a red flicker, the reveal), each ending in DEMO_GAME, a small sample game labeled as a demo sample.

import type { VizBusEvent } from "./viz_bus.ts";
import { HUB_ID, type VizAsk, type VizLaneInput, type VizRunInput } from "./viz_model.ts";

export const DEMO_CYCLE_MS = 48_000;
/** How long a demo action (Stop turn, End, Kill from the node menu) holds before the agent comes back. */
export const DEMO_ACT_MS = 8000;

interface DemoLane { id: string; name: string; model: string; base: number; wobble: number }

const LANES: readonly DemoLane[] = [
  { id: "demo-1", name: "api-refactor", model: "anthropic/claude-sonnet-4.6", base: 55, wobble: 20 },
  { id: "demo-2", name: "test-suite", model: "openai/gpt-5.2", base: 35, wobble: 10 },
  { id: "demo-3", name: "security-audit", model: "google/gemini-3-pro", base: 28, wobble: 6 },
  { id: "demo-4", name: "docs-writer", model: "xai/grok-4.7", base: 40, wobble: 12 },
  // P-VIZ.7 (ADR-0641): a small model and a private (self-hosted) one, so every size class and the TL187 emblem show.
  { id: "demo-5", name: "lint-fixer", model: "anthropic/claude-haiku-4.5", base: 30, wobble: 8 },
  { id: "demo-6", name: "data-pipeline", model: "dgx-spark/llama-4-70b", base: 25, wobble: 7 },
];

/** Scripted status windows per lane, in seconds of the cycle: [from, to, status]. Outside them: working. */
const WINDOWS: Record<string, readonly [number, number, string][]> = {
  "demo-1": [[34, 37, "done"]],
  "demo-3": [[19, 28, "done"]],
  "demo-4": [[30, 38, "error"], [38, 39, "starting"]],
};

/** Surges: [source, from s, to s, est. tok/s]. */
const SURGES: readonly [string, number, number, number][] = [
  [HUB_ID, 12, 13.2, 220], [HUB_ID, 36, 37, 180], ["demo-1", 6, 7, 260], ["demo-2", 15, 15.8, 200],
];

/** P-VIZ.6 (ADR-0635): the folder each demo agent works in (the session ledger's repo column). */
const CWD: Record<string, string> = {
  [HUB_ID]: "/work/lucid_live_demo", "demo-1": "/work/lucid_api", "demo-2": "/work/lucid_live_demo", "demo-3": "/work/lucid_auth", "demo-4": "/work/lucid_docs",
  "demo-5": "/work/lucid_api", "demo-6": "/work/pipeline",
};

const demoLines = (word: string, n: number): string => Array.from({ length: n }, (_, i) => `${word} ${i + 1}\n`).join("");
const demoTool = (id: string, name: string, path: string, code: Record<string, string>, status?: "open") =>
  ({ type: "tool", id, name, detail: path.slice(path.lastIndexOf("/") + 1), code: { path, ...code }, ...(status ? { status } : {}) });
/** An edit replacing `del` lines with `add` new ones (Main's chat tool events carry no status; a lane's say "open"). */
const demoEdit = (id: string, path: string, status: "open" | undefined, del: number, add: number) =>
  demoTool(id, "edit", path, { oldText: demoLines("old", del), newText: demoLines("new", add) }, status);
const demoWrite = (id: string, path: string, lines: number) => demoTool(id, "write", path, { content: demoLines("line", lines) }, "open");

/** `builds` (P-WORLDS.BUILD1, ADR-0653): the build channel. The view feeds these to the build book only (never to
 *  the model or the ledger), so the demo's nodes and totals stay as they were. */
export interface DemoStep { events: VizBusEvent[]; asks: { id: string; ask: VizAsk }[]; builds: VizBusEvent[] }

/** P-WORLDS.BUILD1 (ADR-0653): one build per demo agent a cycle: [lane, phase s it starts, helpers, then the steps
 *  at their phase seconds]. Each build starts with a subagent spawn on the build channel (its pieces) and ends with
 *  the turn's done, except demo-1, whose git commit at 27 s (a real event above) reveals its build. Every build ends
 *  in DEMO_GAME, a sample labeled as one. */
const BUILDS: readonly { lane: string; at: number; helpers: number; steps: readonly (readonly [number, "lock" | "fail" | "done"])[] }[] = [
  { lane: "demo-3", at: 3, helpers: 3, steps: [[5, "lock"], [6.5, "fail"], [8, "lock"], [10, "lock"], [12, "done"]] },
  { lane: "demo-2", at: 8, helpers: 3, steps: [[10, "lock"], [12, "lock"], [13, "fail"], [14, "lock"], [16, "done"]] },
  { lane: "demo-4", at: 14, helpers: 2, steps: [[17, "lock"], [19, "lock"], [21, "done"]] },
  { lane: "demo-1", at: 20, helpers: 2, steps: [[22, "lock"], [23.5, "lock"]] },
  { lane: "demo-5", at: 24, helpers: 3, steps: [[26, "lock"], [28, "lock"], [30, "lock"], [32, "done"]] },
  { lane: "demo-6", at: 30, helpers: 2, steps: [[33, "lock"], [34, "fail"], [36, "lock"], [38, "done"]] },
];

/** P-WORLDS.BUILD1 (ADR-0653): the demo's sample mini game, a self-contained HTML target-tap game (inline CSS and
 *  JS, no network), labeled DEMO SAMPLE in its title, its top bar and every chip and popup that shows it. It sets
 *  body[data-ready] once its script ran (the real-UI demo checks the sandbox let it run). Under 8 KB. */
export const DEMO_GAME: { readonly title: string; readonly html: string } = {
  title: "Target tap (demo sample)",
  html: `<!doctype html><html><head><meta charset="utf-8"><title>Target tap (demo sample)</title><style>
html,body{margin:0;height:100%;font:14px system-ui,sans-serif;background:#0f1724;color:#e8eefc;overflow:hidden;user-select:none}
#bar{display:flex;gap:14px;align-items:center;padding:8px 12px;background:#17233a}#bar b{color:#ffd166}
#tag{margin-left:auto;font-size:11px;letter-spacing:.08em;color:#ff9f43;border:1px solid #ff9f43;border-radius:999px;padding:1px 8px;white-space:nowrap}
#field{position:absolute;left:0;right:0;top:38px;bottom:0}
.t{position:absolute;width:44px;height:44px;margin:-22px 0 0 -22px;padding:0;border-radius:50%;border:0;cursor:pointer;animation:p .25s ease-out;
background:radial-gradient(circle,#fff 0 18%,#ff4d6d 19% 42%,#fff 43% 60%,#ff4d6d 61%)}
@keyframes p{from{transform:scale(.2)}}
#go{position:absolute;left:0;right:0;top:38px;bottom:0;display:grid;place-items:center;text-align:center}
#start{font:inherit;font-weight:700;padding:10px 22px;border-radius:10px;border:0;background:#ffd166;color:#111;cursor:pointer}
</style></head><body>
<div id="bar"><span>Score <b id="sc">0</b></span><span>Time <b id="tm">30</b></span><span id="tag">DEMO SAMPLE</span></div>
<div id="field"></div>
<div id="go"><div><p id="msg">Tap the targets before they fade.</p><button id="start" type="button">Play</button></div></div>
<script>
(function(){
var f=document.getElementById("field"),sc=document.getElementById("sc"),tm=document.getElementById("tm"),go=document.getElementById("go"),msg=document.getElementById("msg"),st=document.getElementById("start");
var score=0,left=30,spawn=0,tick=0;
function add(){var t=document.createElement("button");t.className="t";t.type="button";t.setAttribute("aria-label","target");
t.style.left=(8+Math.random()*84)+"%";t.style.top=(10+Math.random()*80)+"%";
t.onclick=function(){score++;sc.textContent=score;t.remove();};f.appendChild(t);setTimeout(function(){t.remove();},1400);}
function end(){clearInterval(spawn);clearInterval(tick);f.textContent="";msg.textContent="Time! You hit "+score+" targets.";st.textContent="Play again";go.style.display="grid";}
st.onclick=function(){score=0;left=30;sc.textContent="0";tm.textContent="30";go.style.display="none";
spawn=setInterval(add,650);tick=setInterval(function(){left--;tm.textContent=left;if(left<=0)end();},1000);add();};
document.body.setAttribute("data-ready","1");
})();
</script></body></html>`,
};

export interface VizDemo {
  lanes(now: number): VizLaneInput[];
  runs(now: number): VizRunInput[];
  /** Everything the script emits in (prev, now]. */
  step(prev: number, now: number): DemoStep;
  /** The node menu's action on a demo agent: it powers down for DEMO_ACT_MS, then comes back. */
  act(id: string, ask: VizAsk, now: number): void;
  /** P-VIZ.6 (ADR-0635): the folder a demo agent (or Main) works in; null for an unknown id. */
  cwd(id: string): string | null;
}

export function createDemo(t0: number): VizDemo {
  const acts = new Map<string, { ask: VizAsk; at: number }>();
  const phaseOf = (now: number): number => (((now - t0) % DEMO_CYCLE_MS) + DEMO_CYCLE_MS) % DEMO_CYCLE_MS / 1000;

  const actOf = (id: string, now: number): { ask: VizAsk; at: number } | null => {
    const a = acts.get(id);
    if (!a) return null;
    if (now - a.at >= DEMO_ACT_MS) { acts.delete(id); return null; }
    return a;
  };

  const laneStatus = (id: string, now: number): string | null => {
    const a = actOf(id, now);
    if (a) return a.ask === "kill" ? null : a.ask === "end" ? "stopped" : "done";
    const p = phaseOf(now);
    for (const [from, to, st] of WINDOWS[id] ?? []) if (p >= from && p < to) return st;
    return "working";
  };

  const rateOf = (source: string, now: number): number => {
    const p = phaseOf(now);
    for (const [src, from, to, r] of SURGES) if (src === source && p >= from && p < to) return r;
    if (source === HUB_ID) return p >= 40 && p < 47 ? 0 : 22 + 8 * Math.sin(p * 0.9);
    const lane = LANES.find((l) => l.id === source);
    if (!lane || laneStatus(source, now) !== "working") return 0;
    return lane.base + lane.wobble * Math.sin(p * 1.3 + lane.base);
  };

  /** Scripted one-shot events at a phase second: [phase, source, event or the ask the view would make]. `k`
   *  is the cycle number, so every cycle's delegation and tool ids are new. */
  const oneShots = (k: number): readonly [number, string, VizAsk | { type: string; [key: string]: unknown }][] => [
    [2, HUB_ID, { type: "subagent", id: `demo-batch-${k}`, agent: "task", title: "Two helpers", assignments: ["Explore the API surface", "Review the diff for regressions"], names: [`explore-api-${k}`, `review-diff-${k}`] }],
    [5, "demo-1", { type: "subagent", id: `demo-plan-${k}`, agent: "plan", title: "Plan the split", assignments: ["Plan the endpoint split"], names: [`plan-split-${k}`] }],
    [9, "demo-2", { type: "tool", id: `demo-t1-${k}`, name: "bash", detail: "bun test", status: "failed" }],
    [18.5, "demo-3", "cancel"],
    [23, "demo-2", { type: "tool-meta", id: `demo-t2-${k}`, name: "edit", ok: false }],
    [40, HUB_ID, { type: "done" }],
    // P-VIZ.6 (ADR-0635): measured usage and authored code, so the session ledger has real-shaped rows. The
    // edit opened at 21 is the one whose tool-meta fails at 23: the ledger takes its lines back.
    ...[HUB_ID, ...LANES.map((l) => l.id)].map((id, i): [number, string, { type: string; [key: string]: unknown }] =>
      [1 + i * 0.5, id, { type: "usage", used: 12_000 + i * 6_000 + k * 3_000, size: 200_000, cost: 0.05 * (i + 1) * (k + 1) }]),
    [3, "demo-1", demoEdit(`demo-e1-${k}`, "/work/lucid_api/src/routes.ts", "open", 2, 6)],
    [4, "demo-1", { type: "tool", id: `demo-e1-${k}`, name: "edit", detail: "routes.ts", status: "done" }],
    [7, "demo-2", demoWrite(`demo-w1-${k}`, "/work/lucid_live_demo/test/api.test.ts", 24)],
    [11, HUB_ID, demoEdit(`demo-m1-${k}`, "/work/lucid_live_demo/README.md", undefined, 3, 5)],
    [14, "demo-4", demoWrite(`demo-w2-${k}`, "/work/lucid_docs/guide/agents.md", 40)],
    [16, "demo-3", demoEdit(`demo-e3-${k}`, "/work/lucid_auth/src/session.ts", "open", 8, 3)],
    [21, "demo-2", demoEdit(`demo-t2-${k}`, "/work/lucid_live_demo/test/flaky.test.ts", "open", 4, 9)],
    // P-VIZ.7 (ADR-0641): git commits. A lane opens and settles its own call; Main settles its call with tool-meta.
    // demo-1 commits then pushes back to back, so the animation holds across both calls.
    [24, "demo-1", { type: "tool", id: `demo-c1-${k}`, name: "bash", detail: "git commit", input: 'git commit -m "split the routes"', status: "open" }],
    [27, "demo-1", { type: "tool", id: `demo-c1-${k}`, name: "bash", detail: "git commit", status: "done" }],
    [27.2, "demo-1", { type: "tool", id: `demo-p1-${k}`, name: "bash", detail: "git push", input: "git push -u origin feat/routes", status: "open" }],
    [31, "demo-1", { type: "tool", id: `demo-p1-${k}`, name: "bash", detail: "git push", status: "done" }],
    [8, "demo-6", { type: "tool", id: `demo-c6-${k}`, name: "bash", detail: "git commit", input: "git -C /work/pipeline commit -am \"nightly\"", status: "open" }],
    [14, "demo-6", { type: "tool", id: `demo-c6-${k}`, name: "bash", detail: "git commit", status: "done" }],
    [30, HUB_ID, { type: "tool", id: `demo-cm-${k}`, name: "other", detail: "eval", input: 'await d.commit("docs: README", ["- refreshed"])' }],
    [35, HUB_ID, { type: "tool-meta", id: `demo-cm-${k}`, name: "eval", ok: true }],
  ];

  return {
    lanes(now) {
      const out: VizLaneInput[] = [];
      for (const l of LANES) {
        const st = laneStatus(l.id, now);
        if (st !== null) out.push({ id: l.id, name: l.name, model: l.model, status: st });
      }
      return out;
    },
    runs(now) {
      const k = Math.floor((now - t0) / DEMO_CYCLE_MS), p = phaseOf(now), start = t0 + k * DEMO_CYCLE_MS;
      if (p < 2) return [];
      const run = (name: string, assignment: string, doneAt: number): VizRunInput => {
        const done = p >= doneAt;
        const until = Math.min(p, doneAt);
        return {
          name, assignment, model: "anthropic/claude-haiku-4.5", done,
          startedAt: start + 2000, lastAt: done ? start + doneAt * 1000 : now, endedAt: done ? start + doneAt * 1000 : undefined,
          tools: Math.floor((until - 2) / 3), steps: [],
        };
      };
      return [run(`explore-api-${k}`, "Explore the API surface", 26), run(`review-diff-${k}`, "Review the diff for regressions", 44)];
    },
    step(prev, now) {
      const events: VizBusEvent[] = [];
      const asks: { id: string; ask: VizAsk }[] = [];
      const builds: VizBusEvent[] = [];
      if (now <= prev) return { events, asks, builds };
      const a = prev - t0, b = now - t0;
      const due = (k: number, phase: number): boolean => { const at = k * DEMO_CYCLE_MS + phase * 1000; return at > a && at <= b; };
      for (let k = Math.floor(a / DEMO_CYCLE_MS); k <= Math.floor(b / DEMO_CYCLE_MS); k++) {
        for (const [phase, source, what] of oneShots(k)) {
          if (!due(k, phase)) continue;
          if (typeof what === "string") asks.push({ id: source, ask: what });
          else events.push({ source, origin: "demo", e: what });
        }
        // P-WORLDS.BUILD1 (ADR-0653): the build channel, in phase order per lane.
        for (const bd of BUILDS) {
          if (due(k, bd.at)) {
            const assignments = Array.from({ length: bd.helpers }, (_, i) => `Build part ${i + 1} of the mini game`);
            const spawn = { type: "subagent", id: `build-${bd.lane}-${k}`, agent: "task", title: "Build the mini game", assignments };
            builds.push({ source: bd.lane, origin: "demo", e: spawn });
          }
          bd.steps.forEach(([phase, what], i) => {
            if (!due(k, phase)) return;
            const e = what === "done" ? { type: "done" } : { type: "tool", id: `build-${bd.lane}-${k}-${i}`, name: "edit", status: what === "lock" ? "done" : "failed" };
            builds.push({ source: bd.lane, origin: "demo", e });
          });
        }
      }
      const dt = Math.min(1000, now - prev) / 1000;
      for (const source of [HUB_ID, ...LANES.map((l) => l.id)]) {
        const chars = Math.round(rateOf(source, now) * dt * 4);
        if (chars > 0) {
          const token: { type: "token"; text: string } = { type: "token", text: "x".repeat(chars) };
          events.push({ source, origin: "demo", e: token });
        }
      }
      return { events, asks, builds };
    },
    act(id, ask, now) {
      if (LANES.some((l) => l.id === id)) acts.set(id, { ask, at: now });
    },
    cwd: (id) => CWD[id] ?? null,
  };
}
