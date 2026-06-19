// desktop/personal.ts - server-side lifecycle for the encrypted personalization
// store (ADR-0010 P9.1 + ADR-0012 compartments). The Bun dev server uses PASSPHRASE
// custody (the OS-keystore path needs Electron safeStorage in the packaged app - a
// documented seam, not wired here). The passphrase lives only in this process's memory
// for the moment of derivation; it is NEVER persisted and NEVER returned over the API.
// Only booleans + compartment counts ever leave the server.

import { PersonalStore, type PersonalScope, type ScopeView } from "../harness/personal/store.ts";
import { load, personalStorePath, setPersonalization, setPersonalScope } from "./settings_store.ts";
import { buildRecall } from "../harness/personal/recall.ts";
import { distillTurn, heuristicExtractor } from "../harness/personal/distiller.ts";
import { ScannerClient } from "../harness/security/scanner_client.ts";

let store: PersonalStore | null = null; // the unlocked store, DEK in memory

export interface PersonalStatus {
  enabled: boolean;
  configured: boolean; // an encrypted store file exists on disk
  unlocked: boolean;
  scope: ScopeView; // the active compartment (view)
  counts: { work: number; personal: number; cui: number } | null;
}

export function personalStatus(): PersonalStatus {
  const s = load();
  return {
    enabled: !!s.personalizationEnabled,
    configured: PersonalStore.exists(personalStorePath()),
    unlocked: !!store,
    scope: (s.personalScope ?? "personal") as ScopeView,
    counts: store ? store.scopeCounts() : null,
  };
}

export function enablePersonal(enabled: boolean): PersonalStatus {
  setPersonalization(enabled);
  if (!enabled) lockPersonal(); // disabling locks + drops the in-memory key
  return personalStatus();
}

/** First-run: create the encrypted store under a new passphrase. */
export function setupPersonal(passphrase: string): { ok: boolean; error?: string } {
  if (!passphrase || passphrase.length < 8) return { ok: false, error: "Passphrase must be at least 8 characters." };
  if (PersonalStore.exists(personalStorePath())) return { ok: false, error: "A store already exists - unlock it instead." };
  try { store = PersonalStore.createWithPassphrase(personalStorePath(), passphrase); return { ok: true }; }
  catch (e) { return { ok: false, error: String((e as Error)?.message ?? e) }; }
}

/** Unlock an existing store. Generic error on failure (don't distinguish wrong-pass). */
export function unlockPersonal(passphrase: string): { ok: boolean; error?: string } {
  if (!PersonalStore.exists(personalStorePath())) return { ok: false, error: "No store yet - set a passphrase to create one." };
  try { store = PersonalStore.openWithPassphrase(personalStorePath(), passphrase); return { ok: true }; }
  catch { return { ok: false, error: "Wrong passphrase, or the store could not be read." }; }
}

export function lockPersonal(): PersonalStatus {
  store?.lock();
  store = null;
  return personalStatus();
}

/** Switch the active compartment (persisted; used to scope future learning + recall). */
export function setScope(scope: ScopeView): PersonalStatus {
  setPersonalScope(scope);
  return personalStatus();
}

/** The unlocked store, or null. */
export function currentStore(): PersonalStore | null { return store; }

// ── P9.3: knowledge-graph view data + edits ───────────────────────────────────────
export interface GraphNode { id: string; name: string; kind: string; trust: string; count: number }
export interface GraphEdge { from: string; to: string; relation: string }
export interface GraphFact { id: string; entity_id: string; statement: string; scope: string; trust: string; confidence: number; session?: string; at: string }
export interface PersonalGraphData { nodes: GraphNode[]; edges: GraphEdge[]; facts: GraphFact[] }

/** The node/edge graph for the active (or given) compartment, or null when off/locked. */
export function personalGraph(scopeArg?: ScopeView): PersonalGraphData | null {
  const s = load();
  if (!s.personalizationEnabled || !store) return null;
  const scope = scopeArg ?? ((s.personalScope ?? "personal") as ScopeView);
  const g = store.graph({ scope });
  const byEntity = new Map<string, typeof g.facts>();
  for (const f of g.facts) (byEntity.get(f.entity_id) ?? byEntity.set(f.entity_id, []).get(f.entity_id)!).push(f);
  const nodes: GraphNode[] = g.entities
    .filter((e) => byEntity.has(e.id))
    .map((e) => ({ id: e.id, name: e.name, kind: e.kind, trust: e.trust_label, count: byEntity.get(e.id)!.length }));
  const ids = new Set(nodes.map((n) => n.id));
  const edges: GraphEdge[] = g.links
    .filter((l) => ids.has(l.from_entity_id) && ids.has(l.to_entity_id))
    .map((l) => ({ from: l.from_entity_id, to: l.to_entity_id, relation: l.relation }));
  const facts: GraphFact[] = g.facts.map((f) => ({ id: f.id, entity_id: f.entity_id, statement: f.statement, scope: f.scope, trust: f.trust_label, confidence: f.confidence, session: f.source_session_id, at: f.promoted_at }));
  return { nodes, edges, facts };
}

/** Forget (soft-delete) a fact the user no longer wants remembered. */
export function forgetFact(factId: string): { ok: boolean } {
  if (!store) return { ok: false };
  const ok = store.forgetFact(factId);
  if (ok) store.save();
  return { ok };
}

// ── P9.2: learn from / recall into conversations ───────────────────────────────────
let distillScanner: ScannerClient | null = null;
function getScanner(): ScannerClient {
  if (!distillScanner) { distillScanner = new ScannerClient(); distillScanner.start(); }
  return distillScanner;
}

/** The <user-profile> recall block for the active compartment, or "" when off/locked.
 *  The agent uses it to tailor responses; it enters the user turn, never the frozen prefix. */
export function recallPreamble(): string {
  const s = load();
  if (!s.personalizationEnabled || !store) return "";
  try { return buildRecall(store, { scope: (s.personalScope ?? "personal") as ScopeView }).block; }
  catch { return ""; }
}

/** Learn durable user-facts from one finished turn (best-effort). Fail-closed: only a
 *  clean, trusted user message contributes facts (the distiller scans before storing).
 *  Uses the offline heuristic extractor (no per-turn model cost); the model extractor is
 *  available in the harness for an opt-in upgrade. New facts join the active compartment
 *  (Combined view defaults them to Personal). */
export async function learnFromTurn(userText: string, assistantText: string): Promise<void> {
  const s = load();
  if (!s.personalizationEnabled || !store || !userText.trim()) return; // off, locked, or empty
  const view = (s.personalScope ?? "personal") as ScopeView;
  const scope: PersonalScope = view === "combined" ? "personal" : view;
  try { await distillTurn(store, getScanner(), { userText, assistantText, scope, extract: heuristicExtractor }); }
  catch { /* best-effort; the turn already happened */ }
}
