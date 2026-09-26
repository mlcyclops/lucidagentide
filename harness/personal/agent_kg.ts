// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/personal/agent_kg.ts - P-KG.3: the PURE decision layer that lets an AGENT read and write the
// user's encrypted personalization knowledge graph (ADR-0010 / ADR-0012), instead of only passively
// receiving the server-injected <user-profile> block (recall.ts). Two omp-native tools sit on top of it
// (harness/omp/knowledge_extension.ts: `memory_recall` / `memory_retain`), one desktop HTTP route each.
//
// Before P-KG.3 the agent had exactly ONE knowledge tool, `knowledge_search`, and it pointed at the
// NON-secret workspace KB. The personal graph was write-only from the agent's side (it could not be
// queried) and read-only from the prompt's side (a fixed 24-fact profile block). So the agent could not
// look something up on demand and could not remember anything it learned mid-session. This file is the
// decision half of closing that gap.
//
// Deliberately PURE: no fs, no crypto, no HTTP, no DOM, no Snowflake. Every ruling an agent-initiated
// read or write must survive lives here, so it is unit-testable without a vault, a passphrase, a key or a
// server. The impure half (decrypt, upsertEntity, addFact, save) stays in the desktop server routes,
// which is also the only place that knows WHICH store (main vs the isolated CUI store) is open.
//
// ┌────────────────────────────────────────────────────────────────────────────────────────────────┐
// │  NO PLAINTEXT INDEX ON DISK. This is a SECURITY DECISION, not a performance oversight.         │
// │                                                                                                │
// │  The personal KG is a single AES-256-GCM document (store.ts) precisely so its contents are     │
// │  unreadable without passphrase or OS-keystore custody. A vector index or an FTS index sitting   │
// │  next to it would be a SECOND, UNENCRYPTED copy of exactly the sentences we just went to the   │
// │  trouble of encrypting: an FTS term list leaks the vocabulary of a user's private profile       │
// │  outright, and embeddings are invertible enough to leak the gist. Either one silently undoes    │
// │  encryption-at-rest for anyone who can read the directory, which is the whole threat we are     │
// │  defending against.                                                                            │
// │                                                                                                │
// │  So ranking happens IN MEMORY, over the already-decrypted graph, ONLY while the vault is        │
// │  unlocked, and it dies with the process. The graph is small by construction (a profile, not a   │
// │  corpus: tens to low thousands of facts), so a linear scan per query is cheap. If it ever is    │
// │  not, the fix is a better IN-MEMORY structure, never a file on disk.                            │
// │                                                                                                │
// │  The separate NON-secret workspace KB (harness/kb/) keeps its embeddings index and is untouched │
// │  by this increment: that substrate holds the user's notes and documents, is not encrypted at    │
// │  rest, and already has its own retrieval path (`knowledge_search`).                             │
// └────────────────────────────────────────────────────────────────────────────────────────────────┘
//
// FAIL-CLOSED (invariant #3) in BOTH directions:
//   locked vault    -> reads return [] and writes are REFUSED with a reason. Never a partial answer, and
//                      never a silent "stored" that would teach the model it has memory it does not have.
//   blocked trust   -> a suspicious/quarantined SOURCE can never write a fact. We gate on the SAME
//                      BLOCKED_TRUST set as the semantic-promotion gate (correctness keystone #2),
//                      IMPORTED and never re-listed: two copies of that set is exactly how a poisoned
//                      fact eventually slips through one path after someone tightens the other.
//   unknown trust   -> also refused, mirroring promoteFactGated's unverifiable-provenance branch. An
//                      absent label is not a permissive default.
//   blocked trust   -> a suspicious/quarantined fact is never returned on READ either. Poison that got
//   on the way OUT     in before a gate tightened must not leak back into a prompt on recall.
//
// This module NEVER writes to semantic memory itself, so it can never route around promoteFactGated.
// It rules on the personal-KG write; the promotion gate keeps owning promotion into semantic memory.

import { TRUST_LABELS, type TrustLabel } from "../contracts.ts";
import { BLOCKED_TRUST } from "../memory/promotion_gate.ts";
import { SCOPES, type PersonalGraph, type UserKind } from "./store.ts";

// ── bounds ──────────────────────────────────────────────────────────────────────────────────────────
// An agent will happily ask for 500 hits or paste a whole document into one "fact". Both are bounded
// here rather than at the route, so the bound is tested and cannot be forgotten by a second caller.

/** Hits returned when the caller does not ask for a specific count. Deliberately small: recall is
 *  injected into a prompt tail, and 8 relevant facts beat 25 mostly-irrelevant ones. */
export const DEFAULT_LIMIT = 8;
/** Hard ceiling, applied even when the caller asks for more. */
export const MAX_LIMIT = 25;
/** An entity name is a short noun phrase ("dark mode", "deployment target"), never a paragraph. */
export const MAX_SUBJECT_CHARS = 160;
/** A fact is ONE durable statement. Longer means the agent is trying to store a transcript. */
export const MAX_TEXT_CHARS = 600;

// ── the closed kind allow-list ──────────────────────────────────────────────────────────────────────
// EXACTLY the `UserKind` taxonomy store.ts already uses (store.ts:29-31); no parallel vocabulary. The
// explicit `readonly UserKind[]` annotation is load-bearing: a typo or an invented kind is a COMPILE
// error here, so this list cannot silently drift away from the type the store accepts. store.ts exposes
// the union as a TYPE only (there is no runtime array to import), which is why it is spelled out.

export const AGENT_KG_KINDS: readonly UserKind[] = [
  "user:preference",
  "user:decision",
  "user:goal",
  "user:interest",
  "user:skill",
  "user:behavior",
  "user:personality",
  "user:relationship",
  "user:link",
];

// Static membership tables, derived from the canonical arrays rather than re-listed (re-listing
// TRUST_LABELS or SCOPES would be exactly the drift invariant #7 and ADR-0012 exist to prevent).
// The `as const` is load-bearing: without it `.map` infers `(UserKind | boolean)[]`, an ARRAY rather
// than the `readonly [PropertyKey, true]` tuple Object.fromEntries requires, and the assignment fails.
const KIND_ALLOWED: Record<string, true> = Object.fromEntries(AGENT_KG_KINDS.map((k) => [k, true] as const));
const TRUST_ALLOWED: Record<string, true> = Object.fromEntries(TRUST_LABELS.map((t) => [t, true] as const));
const SCOPE_ALLOWED: Record<string, true> = Object.fromEntries(SCOPES.map((s) => [s, true] as const));

// ── refusal copy ────────────────────────────────────────────────────────────────────────────────────
// These strings are read by a MODEL, so each one has to say what happened AND what would fix it,
// otherwise the agent retries the identical call forever (or worse, assumes it succeeded).

/** A locked vault is a NORMAL outcome, not an error to retry: only the user can clear it. */
export const LOCKED_WRITE_REASON =
  "The personal knowledge graph is locked, so nothing was stored. The user can unlock it in the " +
  "Knowledge panel; ask them to unlock it if this fact is worth keeping. Do not retry until then.";

/** Shown for a read against a locked vault. Same shape, and explicitly NOT "no facts exist". */
export const LOCKED_READ_REASON =
  "The personal knowledge graph is locked, so it could not be searched. This does not mean the user " +
  "has no stored facts. They can unlock it in the Knowledge panel. Do not retry until then.";

// ── read side ───────────────────────────────────────────────────────────────────────────────────────

export interface KgQuery {
  query: string;
  /** Optional kind filter. Bare kinds ("preference") and prefixed kinds ("user:preference") both work. */
  kinds?: string[];
  limit?: number;
}

export interface KgHit {
  id: string;
  kind: string;
  subject: string;
  text: string;
  trust: TrustLabel;
  confidence?: number;
  score: number;
}

/** Case-fold and collapse whitespace so "Dark   Mode" and "dark mode" score identically. */
function fold(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** True only for a REAL trust label from the closed set (invariant #7). `undefined`, `""` and
 *  "trustworthy" are all false: an unrecognized label is never treated as permissive. */
function isTrustLabel(v: unknown): v is TrustLabel {
  return typeof v === "string" && TRUST_ALLOWED[v] === true;
}

/** May this trust label participate at all? A real label that the promotion gate does not block.
 *  Used on BOTH directions: a quarantined fact may neither be written nor recalled. */
export function trustAdmits(v: unknown): v is TrustLabel {
  return isTrustLabel(v) && !BLOCKED_TRUST.has(v);
}

/** Map an agent-supplied kind onto the closed allow-list, or `undefined` if it is not on it.
 *  Accepts the bare form because models overwhelmingly write `preference`, not `user:preference`;
 *  normalizing an alias is ergonomics, NOT a widening of the list. */
export function normalizeKind(raw: unknown): UserKind | undefined {
  const s = fold(typeof raw === "string" ? raw : "");
  if (!s) return undefined;
  const full = s.startsWith("user:") ? s : `user:${s}`;
  return KIND_ALLOWED[full] === true ? (full as UserKind) : undefined;
}

/** Clamp a requested hit count into [1, MAX_LIMIT], defaulting a missing/garbage value. */
function clampLimit(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, n));
}

/** Resolve `kinds` into a match set, or `null` for "no filter".
 *  A filter the caller ASKED for but which contains no recognizable kind resolves to an EMPTY set
 *  (matches nothing) rather than to `null`: silently ignoring a filter we failed to parse would widen
 *  the answer beyond what was requested, which is the wrong direction to fail. */
function kindFilter(raw: unknown): Set<string> | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out = new Set<string>();
  for (const k of raw) {
    const norm = normalizeKind(k);
    if (norm) out.add(norm);
  }
  return out;
}

/** Deterministic relevance band for one fact. Bands never overlap:
 *    3    exact phrase   (the whole query appears verbatim in subject/text/kind)
 *    2    all terms      (every term present, any order, any distance)
 *    1.x  some terms     (1 + half the matched fraction, so it is always < 1.5 and never reaches 2)
 *    0    no term        (excluded entirely)
 *  Denser partial matches outrank sparser ones WITHIN the any-term band without ever jumping a band. */
function scoreFact(needle: string, terms: string[], subject: string, text: string, kind: string): number {
  if (terms.length === 0) return 0;
  // Fields are joined with a NON-whitespace separator on purpose: `fold` collapses newlines to spaces,
  // so a plain "\n" join would let a phrase straddle two fields (subject ending "dark" + text starting
  // "mode" would falsely satisfy the query "dark mode"). The kind is searchable in both spellings so
  // "preference" and "user:preference" each match.
  const hay = fold(`${subject} | ${text} | ${kind} ${kind.replace(/^user:/, "")}`);
  if (hay.includes(needle)) return 3;
  let matched = 0;
  for (const t of terms) if (hay.includes(t)) matched++;
  if (matched === 0) return 0;
  if (matched === terms.length) return 2;
  // Rounded so float arithmetic can never make the confidence/id tie-break non-deterministic.
  return Math.round((1 + 0.5 * (matched / terms.length)) * 1e4) / 1e4;
}

/**
 * P-KG.3: rank the unlocked graph against a free-text query and return the top `limit` hits.
 *
 * PURE and deterministic: same graph plus same query always yields the same ordered array, which is what
 * makes the ranking testable and makes recall reproducible in a replay run. Ordering is score desc, then
 * `confidence` desc, then `id` ascending as the final stable tie-break (never insertion order, which
 * would drift as the user edits unrelated facts).
 *
 * FAIL-CLOSED on lock. While the vault is locked there IS no decrypted graph, so the route passes
 * `null`; `ctx.unlocked === false` says the same thing explicitly. Either yields `[]`. Being handed a
 * `PersonalGraph` is itself proof of unlock (only a successful decrypt produces one), which is why
 * `ctx` is optional rather than a required unlocked:true that every caller would have to restate.
 *
 * FAIL-CLOSED on trust, on the way OUT: a fact whose label is in BLOCKED_TRUST, or is not a real label
 * at all, is dropped. `forgotten` facts are dropped too: the user pressed forget, so recall must honor
 * it even though the row is still in the encrypted document.
 */
export function searchGraph(
  graph: PersonalGraph | null | undefined,
  q: KgQuery,
  ctx: { unlocked?: boolean } = {},
): KgHit[] {
  if (ctx?.unlocked === false) return []; // explicit lock signal
  if (!graph) return []; // locked: there is no decrypted graph to search
  const needle = fold(typeof q?.query === "string" ? q.query : "");
  if (!needle) return [];

  const limit = clampLimit(q?.limit);
  const kinds = kindFilter(q?.kinds);
  const terms = [...new Set(needle.split(" ").filter(Boolean))];

  const entities = Array.isArray(graph.entities) ? graph.entities : [];
  const kindOf = new Map(entities.map((e) => [e.id, e.kind] as const));
  const nameOf = new Map(entities.map((e) => [e.id, e.name] as const));

  const hits: KgHit[] = [];
  for (const f of Array.isArray(graph.facts) ? graph.facts : []) {
    if (f.status !== "active") continue; // the user forgot it; recall must not resurrect it
    if (!trustAdmits(f.trust_label)) continue; // keystone #2, on the read path
    const kind = kindOf.get(f.entity_id) ?? "";
    if (kinds && !kinds.has(kind)) continue;
    const subject = nameOf.get(f.entity_id) ?? "";
    const text = typeof f.statement === "string" ? f.statement : "";
    const score = scoreFact(needle, terms, subject, text, kind);
    if (score <= 0) continue;
    hits.push({ id: f.id, kind, subject, text, trust: f.trust_label, confidence: f.confidence, score });
  }

  hits.sort(
    (a, b) =>
      b.score - a.score ||
      (b.confidence ?? 0) - (a.confidence ?? 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return hits.slice(0, limit);
}

// ── write side ──────────────────────────────────────────────────────────────────────────────────────

export interface KgWrite {
  kind: string;
  subject: string;
  text: string;
  confidence?: number;
  /** An EXISTING entity id to attach the fact to. Omit and the route upserts by (subject, kind). */
  entity?: string;
}

export type KgWriteVerdict = { ok: true; write: KgWrite } | { ok: false; reason: string };

const refuse = (reason: string): KgWriteVerdict => ({ ok: false, reason });

/** Read one string field defensively: `input` arrives from a model over JSON, so it may be any shape. */
function str(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  return typeof v === "string" ? v.trim() : "";
}

/**
 * P-KG.3: validate and trust-gate an agent-proposed fact BEFORE it reaches the encrypted store.
 *
 * Returns the NORMALIZED write on success (canonical `user:` kind, trimmed fields, clamped confidence)
 * so the route persists exactly what was vetted rather than re-deriving it and drifting. On refusal it
 * returns a reason written FOR THE MODEL: what was rejected and what would make it acceptable.
 *
 * Order is deliberate: context gates (lock, trust, compartment) run before shape validation, so a
 * locked or poisoned caller never learns which field of its payload was malformed.
 *
 * The trust label is the SOURCE's, resolved by the caller from provenance, never the agent's say-so:
 * the agent does not get to declare its own input trusted. Same discipline as promoteFactGated.
 */
export function vetAgentWrite(
  input: unknown,
  ctx: { trust: TrustLabel; unlocked: boolean; scope: string },
): KgWriteVerdict {
  // 1. Lock. Only the user can clear this, so say so instead of inviting a retry.
  if (ctx?.unlocked !== true) return refuse(LOCKED_WRITE_REASON);

  // 2. Trust, fail-closed. An absent or unrecognized label is NOT a permissive default; this mirrors
  //    promoteFactGated's "provenance unverifiable" branch (correctness keystone #2).
  if (!isTrustLabel(ctx?.trust)) {
    return refuse(
      "Not stored (fail-closed): the source trust label for this fact is missing or unrecognized, so " +
        "its provenance cannot be verified. Nothing was written.",
    );
  }
  if (BLOCKED_TRUST.has(ctx.trust)) {
    return refuse(
      `Not stored: the source of this fact is ${ctx.trust}, and ${ctx.trust} content can never be ` +
        "promoted into durable memory without human review. Nothing was written.",
    );
  }

  // 3. Compartment. Unknown scope is fail-closed. `cui` is refused on the AGENT path specifically:
  //    CUI is heightened-handling data in its own isolated store with its own key (ADR-0014), and an
  //    agent classifying something as CUI on its own is a decision only the user may make.
  if (SCOPE_ALLOWED[String(ctx?.scope ?? "")] !== true) {
    return refuse(
      "Not stored (fail-closed): the target compartment is unknown, so there is no safe store to " +
        "write to. Nothing was written.",
    );
  }
  if (ctx.scope === "cui") {
    return refuse(
      "Not stored: CUI-scoped facts are heightened-handling data and must be added by the user in the " +
        "Knowledge panel, never by an agent. Nothing was written.",
    );
  }

  // 4. Shape. Everything below is the model's payload.
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return refuse("Not stored: expected an object with `kind`, `subject` and `text`. Nothing was written.");
  }
  const rec = input as Record<string, unknown>;

  const kind = normalizeKind(rec.kind);
  if (!kind) {
    return refuse(
      `Not stored: \`kind\` must be one of ${AGENT_KG_KINDS.join(", ")} (the bare form, for example ` +
        "\"preference\", also works). Nothing was written.",
    );
  }

  const subject = str(rec, "subject");
  if (!subject) return refuse("Not stored: `subject` is empty. Give the short thing this fact is about.");
  if (subject.length > MAX_SUBJECT_CHARS) {
    return refuse(
      `Not stored: \`subject\` is ${subject.length} characters, over the ${MAX_SUBJECT_CHARS} limit. ` +
        "It should be a short noun phrase, not a sentence.",
    );
  }

  const text = str(rec, "text");
  if (!text) return refuse("Not stored: `text` is empty. State the fact in one sentence.");
  if (text.length > MAX_TEXT_CHARS) {
    return refuse(
      `Not stored: \`text\` is ${text.length} characters, over the ${MAX_TEXT_CHARS} limit. Store ONE ` +
        "durable fact per call instead of a transcript.",
    );
  }

  // 5. Optional fields. A malformed confidence is a malformed call, so refuse rather than guess a value
  //    that would then rank this fact against honestly-scored ones.
  const write: KgWrite = { kind, subject, text };
  if (rec.confidence !== undefined && rec.confidence !== null) {
    if (typeof rec.confidence !== "number" || !Number.isFinite(rec.confidence)) {
      return refuse("Not stored: `confidence` must be a number between 0 and 1 when provided.");
    }
    write.confidence = Math.max(0, Math.min(1, rec.confidence));
  }
  const entity = str(rec, "entity");
  if (entity) {
    if (entity.length > MAX_SUBJECT_CHARS) {
      return refuse(`Not stored: \`entity\` is over the ${MAX_SUBJECT_CHARS} character limit.`);
    }
    write.entity = entity;
  }

  return { ok: true, write };
}
