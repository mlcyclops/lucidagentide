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

export interface DemoStep { events: VizBusEvent[]; asks: { id: string; ask: VizAsk }[] }

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
      if (now <= prev) return { events, asks };
      const a = prev - t0, b = now - t0;
      for (let k = Math.floor(a / DEMO_CYCLE_MS); k <= Math.floor(b / DEMO_CYCLE_MS); k++) {
        for (const [phase, source, what] of oneShots(k)) {
          const at = k * DEMO_CYCLE_MS + phase * 1000;
          if (at <= a || at > b) continue;
          if (typeof what === "string") asks.push({ id: source, ask: what });
          else events.push({ source, origin: "demo", e: what });
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
      return { events, asks };
    },
    act(id, ask, now) {
      if (LANES.some((l) => l.id === id)) acts.set(id, { ask, at: now });
    },
    cwd: (id) => CWD[id] ?? null,
  };
}
