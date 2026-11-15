// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/bench/devset/policies.ts - P-BENCH.2a (ADR-0591): two scripted reference models for the dev set.
//
// Neither is a model. They are the two ends a real model's score sits between, and they keep the harness
// honest without a network:
//   reads-view   answers from what it was SHOWN, as well as that can be done. It reads the tool result omp
//                hands it and never calls another tool. This is the ceiling for a model that does not use
//                the artifact tools: when the answer is in the part it was not shown, it cannot be right.
//   uses-tools   calls the artifact tool that fits the question and answers from what comes back. This is
//                the ceiling for the mechanism: it shows the tools CAN answer every task at every length.
// A real model lands between the two, and how close it gets to uses-tools is what the dev set measures.
//
// A policy is a pure function from what has happened so far to the next step, so the same policy drives
// omp's in-process mock model and a stand-in OpenAI-compatible server.

export interface Transcript {
  /** The task prompt the model was given. */
  prompt: string;
  /** Every tool result so far, in order. */
  results: { name: string; text: string }[];
}
export type Step = { call: { name: string; arguments: Record<string, unknown> } } | { answer: string };
export type Policy = (t: Transcript) => Step;

export const FETCH_TOOL = "mcp__bench_fetch";

/** What the question asks for, read back out of the dev set's own question wording. */
interface Ask { family: "needle" | "count" | "track" | "rank"; key: string }
function ask(prompt: string): Ask | null {
  let m = /deploy token for service ([\w-]+) rotated/.exec(prompt);
  if (m) return { family: "needle", key: m[1]! };
  if (/how many lines start with FAIL/.test(prompt)) return { family: "count", key: "FAIL" };
  m = /what is the value of ([\w-]+)\?/.exec(prompt);
  if (m) return { family: "track", key: m[1]! };
  m = /Which files mention (E_[A-Z_]+) most often/.exec(prompt);
  if (m) return { family: "rank", key: m[1]! };
  return null;
}

/** Answer as well as the given text allows. Used on the whole result when it was not cut, and on the view. */
function solveFromText(a: Ask, text: string): string {
  const lines = text.split("\n");
  if (a.family === "needle") {
    for (const l of lines) { const m = new RegExp(`token for service ${a.key} rotated to revision (r\\d+)`).exec(l); if (m) return m[1]!; }
    return "unknown";
  }
  if (a.family === "count") return String(lines.filter((l) => /^FAIL /.test(l)).length);
  if (a.family === "track") {
    const state = new Map<string, string>();
    for (const l of lines) { const m = /set ([\w-]+) = (\S+)/.exec(l); if (m) state.set(m[1]!, state.has(m[2]!) && m[2] !== m[1] ? state.get(m[2]!)! : m[2]!); }
    return state.get(a.key) ?? "unknown";
  }
  const counts = new Map<string, number>();
  for (const l of lines) { const m = new RegExp(`^(src/[^:]+):\\d+: .*${a.key}`).exec(l); if (m) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1); }
  const ranked = [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([p]) => p);
  return ranked.length ? ranked.join(", ") : "unknown";
}

const say = (answer: string): Step => ({ answer: `ANSWER: ${answer}` });
const handleIn = (text: string): string | null => /artifact:\/\/(\d+)/.exec(text)?.[0] ?? null;

/** Reads what it is shown and never calls an artifact tool. */
export const readsView: Policy = (t) => {
  if (t.results.length === 0) return { call: { name: FETCH_TOOL, arguments: { n: 1 } } };
  const a = ask(t.prompt);
  return a ? say(solveFromText(a, t.results[0]!.text)) : say("unknown");
};

/** Calls the artifact tool that fits the question, when the result was stored as an artifact. */
export const usesTools: Policy = (t) => {
  if (t.results.length === 0) return { call: { name: FETCH_TOOL, arguments: { n: 1 } } };
  const a = ask(t.prompt);
  if (!a) return say("unknown");
  const first = t.results[0]!.text;
  const artifact = handleIn(first);
  if (artifact === null) return say(solveFromText(a, first)); // short enough to be shown whole
  if (t.results.length === 1) {
    if (a.family === "needle") return { call: { name: "artifact_lookup", arguments: { artifact, keys: [a.key] } } };
    if (a.family === "count") return { call: { name: "artifact_count", arguments: { artifact, pattern: "^FAIL ", regex: true } } };
    if (a.family === "track") return { call: { name: "artifact_track", arguments: { artifact, pattern: "set (?<key>[\\w-]+) = (?<value>\\S+)", keys: [a.key], follow: true } } };
    return { call: { name: "artifact_count", arguments: { artifact, pattern: `^(src/[^:]+):\\d+: .*${a.key}`, regex: true, distinct: true } } };
  }
  const out = t.results[t.results.length - 1]!.text;
  if (a.family === "needle") return say(new RegExp(`${a.key} rotated to revision (r\\d+)`).exec(out)?.[1] ?? "unknown");
  if (a.family === "count") return say(/^([\d,]+) occurrences? of /m.exec(out)?.[1] ?? (/^0: nothing/m.test(out) ? "0" : "unknown"));
  if (a.family === "track") return say(new RegExp(`key "${a.key}": (\\S+) after`).exec(out)?.[1] ?? "unknown");
  const ranked = [...out.matchAll(/^[\d,]+x (src\/\S+)$/gm)].slice(0, 5).map((m) => m[1]!);
  return say(ranked.length ? ranked.join(", ") : "unknown");
};

export const POLICIES: Record<string, Policy> = { "reads-view": readsView, "uses-tools": usesTools };
