// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/personal/distiller.ts — P9.2: learn durable facts ABOUT THE USER from a
// conversation turn, gate them fail-closed, and remember the clean ones in the active
// compartment (ADR-0010 / ADR-0012).
//
// Pipeline per turn: extract candidate user-facts -> SCAN the source (the user's own
// text) -> only when it is clean+trusted do the facts enter the store (suspicious or
// quarantined or unscannable => learn NOTHING — keystone #2 on the personal path).
//
// The extractor is pluggable. `heuristicExtractor` is deterministic + offline (the
// testable default). `modelExtractor(callModel)` wraps an LLM call (the production path
// the user chose) — its output is just CANDIDATES; the gate + store still govern what is
// actually remembered, so a hallucinated or injected "fact" can't bypass the scan.

import { DEFAULT_POLICY, scanAndDecide } from "../security/gate.ts";
import type { ScannerClient } from "../security/scanner_client.ts";
import type { Telemetry } from "../telemetry/events.ts";
import type { PersonalScope, PersonalStore, UserKind } from "./store.ts";

export interface FactCandidate {
  kind: UserKind;
  entity: string; // the node this fact attaches to (e.g. "editor", "Rust", "coffee")
  statement: string; // a short, readable fact
  confidence?: number; // 0..1
  relations?: { to: string; relation: string }[];
}
export type Extractor = (turn: { user: string; assistant: string }) => FactCandidate[] | Promise<FactCandidate[]>;

const clip = (s: string, n = 140): string => s.replace(/\s+/g, " ").trim().slice(0, n);

// ── heuristic extractor (offline, deterministic) ─────────────────────────────────
// Conservative self-statement patterns over the USER's text. Better to miss a fact
// than to remember noise; the model extractor is for nuance.
const PATTERNS: { re: RegExp; kind: UserKind; verb: string }[] = [
  { re: /\bi (?:prefer|favou?r)\s+([^.,;!?\n]{2,60})/gi, kind: "user:preference", verb: "Prefers" },
  { re: /\bi (?:like|love|enjoy|am into|am a fan of)\s+([^.,;!?\n]{2,60})/gi, kind: "user:interest", verb: "Likes" },
  { re: /\bi (?:dislike|hate|avoid|can'?t stand|don'?t like)\s+([^.,;!?\n]{2,60})/gi, kind: "user:preference", verb: "Avoids" },
  { re: /\bi (?:use|work with|code in|write|build with|am on|run|develop in)\s+([^.,;!?\n]{2,50})/gi, kind: "user:skill", verb: "Uses" },
  { re: /\bi (?:decided|chose|went with|picked|am going with|will go with)\s+(?:to use\s+)?([^.,;!?\n]{2,60})/gi, kind: "user:decision", verb: "Chose" },
  { re: /\bi (?:always|usually|tend to|generally|never)\s+([^.,;!?\n]{3,70})/gi, kind: "user:behavior", verb: "Tends to" },
  { re: /\bi(?:'m| am)\s+(?:working on|building|focused on|trying to)\s+([^.,;!?\n]{3,70})/gi, kind: "user:goal", verb: "Working on" },
  { re: /\bmy (?:goal|aim|plan) is to\s+([^.,;!?\n]{3,70})/gi, kind: "user:goal", verb: "Goal:" },
  { re: /\bi(?:'m| am)\s+(?:an?\s+)?([a-z][\w /+-]{2,40}?(?:engineer|developer|dev|designer|manager|analyst|scientist|architect|consultant|lead|founder|student|researcher|admin|devops|sre|pm|operator|hacker))\b/gi, kind: "user:personality", verb: "Is a" },
  { re: /\b(?:remember|note|keep in mind) that\s+([^.\n]{3,120})/gi, kind: "user:preference", verb: "Note" },
  { re: /\b(?:call me|my name is|i'?m called)\s+([a-z][\w'-]{1,30})\b/gi, kind: "user:personality", verb: "Goes by" },
];
const URL_RE = /\bhttps?:\/\/[^\s)\]<>"']{6,200}/gi;

export const heuristicExtractor = (turn: { user: string; assistant: string }): FactCandidate[] => {
  const { user } = turn;
  const out: FactCandidate[] = [];
  for (const { re, kind, verb } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of user.matchAll(re)) {
      const obj = clip(m[1] ?? "", 60);
      if (obj.length < 2) continue;
      out.push({ kind, entity: obj.toLowerCase().slice(0, 48), statement: `${verb} ${obj}`, confidence: 0.6 });
    }
  }
  for (const m of user.matchAll(URL_RE)) {
    const url = m[0];
    out.push({ kind: "user:link", entity: url.slice(0, 80), statement: `Saved link: ${url}`, confidence: 0.5 });
  }
  // de-dupe by (kind, statement)
  const seen = new Set<string>();
  const facts = out.filter((c) => { const k = `${c.kind}|${c.statement.toLowerCase()}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 12);
  // Co-occurrence: facts stated in the SAME turn are related context. Chain the non-link
  // facts (URLs don't chain) with a weak, clearly-labelled "mentioned with" relation so the
  // graph shows connections offline. The model extractor supplies richer, semantic relations.
  const chainable = facts.filter((c) => c.kind !== "user:link");
  for (let i = 0; i < chainable.length - 1; i++) (chainable[i]!.relations ??= []).push({ to: chainable[i + 1]!.entity, relation: "mentioned with" });
  return facts;
};

// ── model extractor (production path) ────────────────────────────────────────────
// `callModel` performs ONE LLM call returning text; we parse a strict JSON array. The
// model's output is untrusted structure, but every candidate still passes the gate +
// store rules below, so it cannot inject anything dangerous into memory.
export const EXTRACT_SYSTEM =
  "Extract DURABLE facts about the USER from their message (preferences, decisions, " +
  "behaviors, interests, personality, skills, goals, and links they value). Ignore " +
  "ephemeral task details. Output ONLY a JSON array of objects " +
  '{"kind","entity","statement","confidence","relations"} where kind is one of ' +
  "user:preference|decision|interest|behavior|personality|link|skill|goal|relationship. " +
  '"relations" is an OPTIONAL array of {"to","relation"} connecting this entity to another ' +
  'one you also extracted, e.g. {"to":"kubernetes","relation":"deploys with"} or ' +
  '{"to":"rust","relation":"used for"}. Use it to show how the user\'s facts connect. ' +
  "Return [] if there is nothing durable.";

export function modelExtractor(callModel: (system: string, user: string) => Promise<string>): Extractor {
  const KINDS = new Set<UserKind>(["user:preference", "user:decision", "user:interest", "user:behavior", "user:personality", "user:link", "user:skill", "user:goal", "user:relationship"]);
  return async ({ user }) => {
    let raw: string;
    try { raw = await callModel(EXTRACT_SYSTEM, user); } catch { return []; }
    const start = raw.indexOf("["), end = raw.lastIndexOf("]");
    if (start < 0 || end <= start) return [];
    let arr: unknown;
    try { arr = JSON.parse(raw.slice(start, end + 1)); } catch { return []; }
    if (!Array.isArray(arr)) return [];
    const out: FactCandidate[] = [];
    for (const it of arr as any[]) {
      const kind = String(it?.kind ?? "") as UserKind;
      const entity = clip(String(it?.entity ?? ""), 60);
      const statement = clip(String(it?.statement ?? ""), 140);
      if (!KINDS.has(kind) || entity.length < 2 || statement.length < 3) continue;
      const confidence = Math.max(0, Math.min(1, Number(it?.confidence ?? 0.7)));
      // Optional relations: each links this entity to another the model named. The target
      // is just a name here; distillTurn resolves it to the real node (or upserts one).
      const relations: { to: string; relation: string }[] = [];
      if (Array.isArray(it?.relations)) {
        for (const r of it.relations as any[]) {
          const to = clip(String(r?.to ?? ""), 60).toLowerCase().slice(0, 48);
          if (to.length < 2) continue;
          relations.push({ to, relation: clip(String(r?.relation ?? "related"), 40) || "related" });
        }
      }
      out.push({ kind, entity: entity.toLowerCase().slice(0, 48), statement, confidence, relations: relations.length ? relations : undefined });
    }
    return out.slice(0, 16);
  };
}

// ── the gated pipeline ───────────────────────────────────────────────────────────
export interface DistillResult { learned: number; blocked: boolean; reason?: string }

// Cross-turn linking (#1): when a new turn RE-MENTIONS a concept already in the graph, connect
// this turn's new fact to that prior entity with a weak "mentioned with" edge — so related ideas
// from different turns join up. Conservative + offline: whole-word match on a significant
// (>=4-char, non-stopword) token of the prior entity's name, capped per turn so it never floods.
const CROSS_LINK_CAP = 3;
const CROSS_LINK_STOP = new Set([
  "this", "that", "with", "from", "your", "have", "they", "them", "what", "when", "about", "into",
  "over", "also", "just", "very", "much", "such", "then", "than", "each", "some", "like", "really",
  "want", "need", "make", "made", "does", "done", "using", "used", "would", "could", "should", "more",
]);

/** Distil + remember durable user-facts from one turn. Fail-closed: only a clean,
 *  trusted source contributes facts. Best-effort; the caller treats failures as no-op. */
export async function distillTurn(
  store: PersonalStore,
  scanner: ScannerClient,
  opts: { userText: string; assistantText?: string; scope: PersonalScope; sessionId?: string; runId?: string; extract: Extractor; telemetry?: Telemetry; persist?: boolean },
): Promise<DistillResult> {
  // 1. Scan the SOURCE (the user's own text). Anything not clean+trusted => learn nothing.
  const decision = await scanAndDecide(scanner, opts.userText, DEFAULT_POLICY);
  if (decision.block || decision.trustLabel !== "trusted") {
    return { learned: 0, blocked: true, reason: decision.block ? decision.reason : `source is ${decision.trustLabel}` };
  }
  // 2. Extract candidates, then write the clean ones into the active compartment.
  const candidates = await opts.extract({ user: opts.userText, assistant: opts.assistantText ?? "" });
  // Snapshot the graph BEFORE this turn writes to it, so cross-turn linking (below) can tell which
  // entities are pre-existing and which links already exist.
  const before = store.graph();
  const priorIds = new Set(before.entities.map((e) => e.id));
  const linkKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const existingLinks = new Set(before.links.map((l) => linkKey(l.from_entity_id, l.to_entity_id)));
  // Create every candidate entity FIRST so a relation can resolve to the real node (with its
  // own kind) instead of duplicating it under the source fact's kind.
  const idByName = new Map<string, string>();
  for (const c of candidates) idByName.set(c.entity.toLowerCase(), store.upsertEntity(c.entity, c.kind, "trusted", c.confidence ?? 1));

  let learned = 0;
  const linkSeen = new Set<string>();
  for (const c of candidates) {
    const entityId = idByName.get(c.entity.toLowerCase())!;
    store.addFact({ entityId, statement: c.statement, trustLabel: "trusted", scope: opts.scope, confidence: c.confidence, sourceSessionId: opts.sessionId, sourceRunId: opts.runId });
    for (const rel of c.relations ?? []) {
      const toName = clip(String(rel?.to ?? ""), 60).toLowerCase().slice(0, 48);
      if (toName.length < 2 || toName === c.entity.toLowerCase()) continue; // no self-loops
      // Prefer an entity created this turn (keeps its real kind); else upsert a generic node.
      let toId = idByName.get(toName);
      if (!toId) { toId = store.upsertEntity(toName, c.kind, "trusted"); idByName.set(toName, toId); }
      const relation = String(rel.relation || "related");
      // Dedup undirected: A↔B with the same relation is one edge, not two.
      const key = entityId < toId ? `${entityId}|${toId}|${relation}` : `${toId}|${entityId}|${relation}`;
      if (linkSeen.has(key)) continue;
      linkSeen.add(key);
      store.addLink(entityId, toId, relation);
    }
    learned++;
    opts.telemetry?.emit("personal_fact_learned", { kind: c.kind, scope: opts.scope });
  }
  // 3. Cross-turn linking: connect this turn's PRIMARY new entity to PRIOR entities the user
  //    re-mentions (whole-word token match), so concepts from different turns join up.
  const newIds = [...idByName.values()].filter((id) => !priorIds.has(id));
  if (learned && newIds.length) {
    const subject = newIds[0]!; // the turn's first new entity
    const turnWords = new Set(opts.userText.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    let added = 0;
    for (const pe of before.entities) {
      if (added >= CROSS_LINK_CAP) break;
      if (pe.id === subject) continue;
      const tokens = pe.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !CROSS_LINK_STOP.has(w));
      if (!tokens.some((w) => turnWords.has(w))) continue; // not re-mentioned
      const key = linkKey(subject, pe.id);
      if (existingLinks.has(key)) continue; // already connected
      existingLinks.add(key);
      store.addLink(subject, pe.id, "mentioned with");
      added++;
    }
  }
  // Bulk callers (the importer) defer the write and save once at the end — re-encrypting the
  // whole graph per message would be O(n²) over a large export.
  if (learned && opts.persist !== false) store.save();
  return { learned, blocked: false };
}
