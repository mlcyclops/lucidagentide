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
  return out.filter((c) => { const k = `${c.kind}|${c.statement.toLowerCase()}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 12);
};

// ── model extractor (production path) ────────────────────────────────────────────
// `callModel` performs ONE LLM call returning text; we parse a strict JSON array. The
// model's output is untrusted structure, but every candidate still passes the gate +
// store rules below, so it cannot inject anything dangerous into memory.
export const EXTRACT_SYSTEM =
  "Extract DURABLE facts about the USER from their message (preferences, decisions, " +
  "behaviors, interests, personality, skills, goals, and links they value). Ignore " +
  "ephemeral task details. Output ONLY a JSON array of objects " +
  '{"kind","entity","statement","confidence"} where kind is one of ' +
  "user:preference|decision|interest|behavior|personality|link|skill|goal|relationship. " +
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
      out.push({ kind, entity: entity.toLowerCase().slice(0, 48), statement, confidence });
    }
    return out.slice(0, 16);
  };
}

// ── the gated pipeline ───────────────────────────────────────────────────────────
export interface DistillResult { learned: number; blocked: boolean; reason?: string }

/** Distil + remember durable user-facts from one turn. Fail-closed: only a clean,
 *  trusted source contributes facts. Best-effort; the caller treats failures as no-op. */
export async function distillTurn(
  store: PersonalStore,
  scanner: ScannerClient,
  opts: { userText: string; assistantText?: string; scope: PersonalScope; sessionId?: string; runId?: string; extract: Extractor; telemetry?: Telemetry },
): Promise<DistillResult> {
  // 1. Scan the SOURCE (the user's own text). Anything not clean+trusted => learn nothing.
  const decision = await scanAndDecide(scanner, opts.userText, DEFAULT_POLICY);
  if (decision.block || decision.trustLabel !== "trusted") {
    return { learned: 0, blocked: true, reason: decision.block ? decision.reason : `source is ${decision.trustLabel}` };
  }
  // 2. Extract candidates, then write the clean ones into the active compartment.
  const candidates = await opts.extract({ user: opts.userText, assistant: opts.assistantText ?? "" });
  let learned = 0;
  for (const c of candidates) {
    const entityId = store.upsertEntity(c.entity, c.kind, "trusted", c.confidence ?? 1);
    store.addFact({ entityId, statement: c.statement, trustLabel: "trusted", scope: opts.scope, confidence: c.confidence, sourceSessionId: opts.sessionId, sourceRunId: opts.runId });
    for (const rel of c.relations ?? []) {
      if (!rel?.to) continue;
      store.addLink(entityId, store.upsertEntity(clip(rel.to, 60).toLowerCase(), c.kind, "trusted"), String(rel.relation || "related"));
    }
    learned++;
    opts.telemetry?.emit("personal_fact_learned", { kind: c.kind, scope: opts.scope });
  }
  if (learned) store.save();
  return { learned, blocked: false };
}
