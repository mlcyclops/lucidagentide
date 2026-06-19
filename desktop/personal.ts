// desktop/personal.ts - server-side lifecycle for the encrypted personalization
// store (ADR-0010 P9.1 + ADR-0012 compartments). The Bun dev server uses PASSPHRASE
// custody (the OS-keystore path needs Electron safeStorage in the packaged app - a
// documented seam, not wired here). The passphrase lives only in this process's memory
// for the moment of derivation; it is NEVER persisted and NEVER returned over the API.
// Only booleans + compartment counts ever leave the server.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { PersonalStore, type PersonalScope, type ScopeView } from "../harness/personal/store.ts";
import { load, personalAuditPath, personalCuiArchiveDir, personalStorePath, personalVaultDir, setPersonalization, setPersonalScope } from "./settings_store.ts";
import { buildRecall } from "../harness/personal/recall.ts";
import { distillTurn, heuristicExtractor } from "../harness/personal/distiller.ts";
import { ScannerClient } from "../harness/security/scanner_client.ts";
import { buildCuiArchive, buildVault, type CuiDesignation, type VaultFile } from "../harness/export/vault_export.ts";
import { Telemetry } from "../harness/telemetry/events.ts";
import { Snowflake } from "@oh-my-pi/pi-utils";

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

// ── P9.4: audited Obsidian vault export + NARA-aligned CUI archive ─────────────────
export interface ExportSummary {
  ok: boolean; error?: string; dest?: string;
  entities?: number; facts?: number; files?: number; bytes?: number;
  scopes?: PersonalScope[]; includedCui?: boolean; payloadSha256?: string; manifestSha256?: string;
}

/** Write the export's files under destDir, refusing any path that escapes it. Returns bytes. */
function writeFiles(destDir: string, files: VaultFile[]): number {
  const root = normalize(destDir);
  let bytes = 0;
  for (const f of files) {
    const target = normalize(join(root, f.path));
    if (target !== root && !target.startsWith(root + sep)) throw new Error(`unsafe export path: ${f.path}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.content, "utf8");
    bytes += Buffer.byteLength(f.content, "utf8");
  }
  return bytes;
}

/** Emit a metadata-only audit event (counts + hashes; never content, never dest). */
function auditExport(event: "personal_vault_exported" | "personal_cui_archived", fields: Record<string, unknown>): void {
  try { new Telemetry({ runId: Snowflake.next(), sessionId: "personal", sink: personalAuditPath() }).emit(event, fields); }
  catch { /* audit is best-effort; the encrypted in-store trail is the source of truth */ }
}

/** Export the portable Obsidian vault. CUI is EXCLUDED unless explicitly requested
 *  (ADR-0012). Decrypt→write→audit: writes files, records the action inside the
 *  encrypted store, and emits a metadata-only telemetry event. */
export function exportVault(opts: { scopes?: PersonalScope[]; dest?: string; reviewer?: string } = {}): ExportSummary {
  const s = load();
  if (!s.personalizationEnabled || !store) return { ok: false, error: "Personalization is off or locked." };
  // Default to the portable compartments; CUI must be opted in by name.
  const scopes = (opts.scopes && opts.scopes.length ? opts.scopes : (["personal", "work"] as PersonalScope[]))
    .filter((x): x is PersonalScope => x === "personal" || x === "work" || x === "cui");
  const dest = opts.dest?.trim() || personalVaultDir();
  try {
    const build = buildVault(store.graph({ scope: "combined" }), { scopes, now: new Date().toISOString() });
    if (build.summary.entities === 0) return { ok: false, error: "Nothing to export in the selected compartment(s) yet." };
    const bytes = writeFiles(dest, build.files);
    store.recordExport({
      kind: "vault", scopes, entity_count: build.summary.entities, fact_count: build.summary.facts,
      file_count: build.summary.files, payload_sha256: build.summary.payloadSha256, dest,
      reviewer: opts.reviewer, included_cui: build.summary.includedCui,
    });
    store.save();
    auditExport("personal_vault_exported", {
      scopes, included_cui: build.summary.includedCui, entities: build.summary.entities,
      facts: build.summary.facts, files: build.summary.files, payload_sha256: build.summary.payloadSha256,
    });
    return { ok: true, dest, entities: build.summary.entities, facts: build.summary.facts, files: build.summary.files, bytes, scopes, includedCui: build.summary.includedCui, payloadSha256: build.summary.payloadSha256 };
  } catch (e) { return { ok: false, error: String((e as Error)?.message ?? e) }; }
}

/** The loud, audited CUI-compartment migration for archive requirements (National
 *  Archives / NARA records management). Exports ONLY the cui scope into a CUI-marked,
 *  records-managed package with a SHA-256 manifest. Never bundled into the normal vault. */
export function exportCuiArchive(opts: { dest?: string; designation?: CuiDesignation; reviewer?: string } = {}): ExportSummary {
  const s = load();
  if (!s.personalizationEnabled || !store) return { ok: false, error: "Personalization is off or locked." };
  if (store.scopeCounts().cui === 0) return { ok: false, error: "No CUI-compartment facts to archive." };
  const dest = opts.dest?.trim() || personalCuiArchiveDir();
  const designation = { ...opts.designation, reviewer: opts.reviewer ?? opts.designation?.reviewer };
  try {
    const build = buildCuiArchive(store.graph({ scope: "cui" }), { now: new Date().toISOString(), designation });
    const bytes = writeFiles(dest, build.files);
    store.recordExport({
      kind: "cui-archive", scopes: ["cui"], entity_count: build.summary.entities, fact_count: build.summary.facts,
      file_count: build.summary.files, payload_sha256: build.summary.payloadSha256, manifest_sha256: build.summary.manifestSha256,
      dest, reviewer: designation.reviewer, included_cui: true,
    });
    store.save();
    auditExport("personal_cui_archived", {
      scopes: ["cui"], included_cui: true, entities: build.summary.entities, facts: build.summary.facts,
      files: build.summary.files, payload_sha256: build.summary.payloadSha256, manifest_sha256: build.summary.manifestSha256,
    });
    return { ok: true, dest, entities: build.summary.entities, facts: build.summary.facts, files: build.summary.files, bytes, scopes: ["cui"], includedCui: true, payloadSha256: build.summary.payloadSha256, manifestSha256: build.summary.manifestSha256 };
  } catch (e) { return { ok: false, error: String((e as Error)?.message ?? e) }; }
}

/** The decrypt→export audit trail (metadata only), most-recent first; null when locked. */
export function exportHistory(): ReturnType<PersonalStore["exportLog"]> | null {
  return store ? store.exportLog() : null;
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
