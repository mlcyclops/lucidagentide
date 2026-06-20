// desktop/personal.ts - server-side lifecycle for the encrypted personalization
// store (ADR-0010 P9.1 + ADR-0012 compartments). The Bun dev server uses PASSPHRASE
// custody (the OS-keystore path needs Electron safeStorage in the packaged app - a
// documented seam, not wired here). The passphrase lives only in this process's memory
// for the moment of derivation; it is NEVER persisted and NEVER returned over the API.
// Only booleans + compartment counts ever leave the server.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { CUI_STORE_VERSION, PersonalStore, type PersonalGraph, type PersonalScope, type ScopeView } from "../harness/personal/store.ts";
import { load, personalAuditPath, personalCuiArchiveDir, personalCuiStorePath, personalStorePath, personalVaultDir, setPersonalization, setPersonalScope } from "./settings_store.ts";
import { buildRecall, buildRecallFromGraph } from "../harness/personal/recall.ts";
import { distillTurn, heuristicExtractor } from "../harness/personal/distiller.ts";
import { parseExport, type ImportVendor } from "../harness/personal/import_adapters.ts";
import { importConversations } from "../harness/personal/importer.ts";
import { ScannerClient } from "../harness/security/scanner_client.ts";
import { buildCuiArchive, buildVault, type CuiDesignation, type VaultFile } from "../harness/export/vault_export.ts";
import { Telemetry } from "../harness/telemetry/events.ts";
import { Snowflake } from "@oh-my-pi/pi-utils";

// Hard CUI isolation (ADR-0014, P9.5a): TWO independent encrypted stores, each with its own
// DEK in memory. `store` holds work + personal; `cuiStore` holds ONLY cui. A single key never
// decrypts both. The CUI store auto-locks the moment CUI is not the selected compartment.
let store: PersonalStore | null = null; // main: work + personal
let cuiStore: PersonalStore | null = null; // isolated CUI store

export interface PersonalStatus {
  enabled: boolean;
  configured: boolean; // the main store file exists on disk
  unlocked: boolean;
  scope: ScopeView; // the active compartment (view)
  counts: { work: number; personal: number; cui: number } | null;
  // CUI store (separate file + passphrase). cui counts come from HERE, not the main store.
  cuiConfigured: boolean;
  cuiUnlocked: boolean;
  // Legacy cui facts still sitting in the main store from before isolation (pending P9.5b
  // migration). Surfaced so the UI can prompt; they are NOT recalled or exported meanwhile.
  legacyCuiInMain: number;
}

export function personalStatus(): PersonalStatus {
  const s = load();
  const main = store ? store.scopeCounts() : null;
  const cuiUnlocked = !!cuiStore;
  return {
    enabled: !!s.personalizationEnabled,
    configured: PersonalStore.exists(personalStorePath()),
    unlocked: !!store,
    scope: (s.personalScope ?? "personal") as ScopeView,
    counts: main ? { work: main.work, personal: main.personal, cui: cuiStore ? cuiStore.scopeCounts().cui : 0 } : null,
    cuiConfigured: PersonalStore.exists(personalCuiStorePath()),
    cuiUnlocked,
    legacyCuiInMain: main ? main.cui : 0,
  };
}

export function enablePersonal(enabled: boolean): PersonalStatus {
  setPersonalization(enabled);
  if (!enabled) lockPersonal(); // disabling locks + drops BOTH in-memory keys
  return personalStatus();
}

/** First-run: create the main (work+personal) encrypted store under a new passphrase. */
export function setupPersonal(passphrase: string): { ok: boolean; error?: string } {
  if (!passphrase || passphrase.length < 8) return { ok: false, error: "Passphrase must be at least 8 characters." };
  if (PersonalStore.exists(personalStorePath())) return { ok: false, error: "A store already exists - unlock it instead." };
  try { store = PersonalStore.createWithPassphrase(personalStorePath(), passphrase); return { ok: true }; }
  catch (e) { return { ok: false, error: String((e as Error)?.message ?? e) }; }
}

/** Unlock the main store. Generic error on failure (don't distinguish wrong-pass). */
export function unlockPersonal(passphrase: string): { ok: boolean; error?: string } {
  if (!PersonalStore.exists(personalStorePath())) return { ok: false, error: "No store yet - set a passphrase to create one." };
  try { store = PersonalStore.openWithPassphrase(personalStorePath(), passphrase); return { ok: true }; }
  catch { return { ok: false, error: "Wrong passphrase, or the store could not be read." }; }
}

export function lockPersonal(): PersonalStatus {
  store?.lock(); store = null;
  lockCui();
  return personalStatus();
}

// ── CUI store: separate file, separate passphrase, separate DEK (P9.5a) ─────────────
/** First-run for the isolated CUI store. A DISTINCT passphrase is recommended (not forced). */
export function setupCui(passphrase: string): { ok: boolean; error?: string } {
  if (!load().personalizationEnabled) return { ok: false, error: "Enable personalization first." };
  if (!passphrase || passphrase.length < 8) return { ok: false, error: "Passphrase must be at least 8 characters." };
  if (PersonalStore.exists(personalCuiStorePath())) return { ok: false, error: "A CUI store already exists - unlock it instead." };
  try { cuiStore = PersonalStore.createWithPassphrase(personalCuiStorePath(), passphrase, { version: CUI_STORE_VERSION }); return { ok: true }; }
  catch (e) { return { ok: false, error: String((e as Error)?.message ?? e) }; }
}

/** Unlock the isolated CUI store for this session (until CUI is deselected). */
export function unlockCui(passphrase: string): { ok: boolean; error?: string } {
  if (!PersonalStore.exists(personalCuiStorePath())) return { ok: false, error: "No CUI store yet - set a passphrase to create one." };
  try { cuiStore = PersonalStore.openWithPassphrase(personalCuiStorePath(), passphrase, { version: CUI_STORE_VERSION }); return { ok: true }; }
  catch { return { ok: false, error: "Wrong passphrase, or the CUI store could not be read." }; }
}

/** Lock the CUI store: zero its DEK + drop it. Called on deselect, lock, and disable. */
export function lockCui(): PersonalStatus {
  cuiStore?.lock(); cuiStore = null;
  return personalStatus();
}

/** Switch the active compartment. ADR-0014 decision: the CUI store AUTO-LOCKS the moment CUI
 *  is not the selected compartment — returning to CUI requires re-entering its passphrase. */
export function setScope(scope: ScopeView): PersonalStatus {
  setPersonalScope(scope);
  if (scope !== "cui") lockCui();
  return personalStatus();
}

/** The unlocked main store, or null. */
export function currentStore(): PersonalStore | null { return store; }
/** Drop the cui-scoped facts from a main-store graph (legacy pre-migration facts never surface). */
function nonCui(g: PersonalGraph): PersonalGraph { return { ...g, facts: g.facts.filter((f) => f.scope !== "cui") }; }
/** Which unlocked store backs the active scope: cui → the CUI store, everything else → main. */
function storeForScope(scope: ScopeView): PersonalStore | null { return scope === "cui" ? cuiStore : store; }

// ── P9.3: knowledge-graph view data + edits ───────────────────────────────────────
export interface GraphNode { id: string; name: string; kind: string; trust: string; count: number }
export interface GraphEdge { from: string; to: string; relation: string }
export interface GraphFact { id: string; entity_id: string; statement: string; scope: string; trust: string; confidence: number; session?: string; at: string }
export interface PersonalGraphData { nodes: GraphNode[]; edges: GraphEdge[]; facts: GraphFact[] }

/** The node/edge graph for the active (or given) compartment, or null when off/locked.
 *  Routes cui → the isolated CUI store; everything else → main (cui facts never surface). */
export function personalGraph(scopeArg?: ScopeView): PersonalGraphData | null {
  const s = load();
  if (!s.personalizationEnabled || !store) return null;
  const scope = scopeArg ?? ((s.personalScope ?? "personal") as ScopeView);
  const src = storeForScope(scope);
  if (!src) return { nodes: [], edges: [], facts: [] }; // cui selected but its store is locked
  const g = scope === "cui" ? src.graph({ scope: "cui" }) : nonCui(src.graph({ scope }));
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

/** Forget (soft-delete) a fact the user no longer wants remembered. Looks in whichever store
 *  currently holds it (main, then the CUI store if unlocked). */
export function forgetFact(factId: string): { ok: boolean } {
  for (const src of [store, cuiStore]) {
    if (src?.forgetFact(factId)) { src.save(); return { ok: true }; }
  }
  return { ok: false };
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
function auditExport(event: "personal_vault_exported" | "personal_cui_archived" | "personal_cui_migrated" | "personal_cui_destroyed", fields: Record<string, unknown>): void {
  try { new Telemetry({ runId: Snowflake.next(), sessionId: "personal", sink: personalAuditPath() }).emit(event, fields); }
  catch { /* audit is best-effort; the encrypted in-store trail is the source of truth */ }
}

/** Export the portable Obsidian vault. CUI is EXCLUDED unless explicitly requested
 *  (ADR-0012). Decrypt→write→audit: writes files, records the action inside the
 *  encrypted store, and emits a metadata-only telemetry event. */
export function exportVault(opts: { scopes?: PersonalScope[]; dest?: string; reviewer?: string } = {}): ExportSummary {
  const s = load();
  if (!s.personalizationEnabled || !store) return { ok: false, error: "Personalization is off or locked." };
  // The portable vault reads the MAIN store only — CUI lives in its own isolated store and is
  // never in the vault (P9.5a). CUI is exported solely via the audited CUI-archive path.
  const scopes = (opts.scopes && opts.scopes.length ? opts.scopes : (["personal", "work"] as PersonalScope[]))
    .filter((x): x is PersonalScope => x === "personal" || x === "work");
  if (!scopes.length) return { ok: false, error: "Select Personal and/or Work to export. CUI uses the CUI archive." };
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
  if (!s.personalizationEnabled) return { ok: false, error: "Personalization is off." };
  if (!cuiStore) return { ok: false, error: "Unlock the CUI store first (select the CUI compartment and enter its passphrase)." };
  if (cuiStore.scopeCounts().cui === 0) return { ok: false, error: "No CUI-compartment facts to archive." };
  const dest = opts.dest?.trim() || personalCuiArchiveDir();
  const designation = { ...opts.designation, reviewer: opts.reviewer ?? opts.designation?.reviewer };
  try {
    const build = buildCuiArchive(cuiStore.graph({ scope: "cui" }), { now: new Date().toISOString(), designation });
    const bytes = writeFiles(dest, build.files);
    cuiStore.recordExport({
      kind: "cui-archive", scopes: ["cui"], entity_count: build.summary.entities, fact_count: build.summary.facts,
      file_count: build.summary.files, payload_sha256: build.summary.payloadSha256, manifest_sha256: build.summary.manifestSha256,
      dest, reviewer: designation.reviewer, included_cui: true,
    });
    cuiStore.save();
    auditExport("personal_cui_archived", {
      scopes: ["cui"], included_cui: true, entities: build.summary.entities, facts: build.summary.facts,
      files: build.summary.files, payload_sha256: build.summary.payloadSha256, manifest_sha256: build.summary.manifestSha256,
    });
    return { ok: true, dest, entities: build.summary.entities, facts: build.summary.facts, files: build.summary.files, bytes, scopes: ["cui"], includedCui: true, payloadSha256: build.summary.payloadSha256, manifestSha256: build.summary.manifestSha256 };
  } catch (e) { return { ok: false, error: String((e as Error)?.message ?? e) }; }
}

/** The decrypt→export audit trail (metadata only), most-recent first; null when locked.
 *  Merges the main store's vault exports with the CUI store's archive exports (when unlocked). */
export function exportHistory(): ReturnType<PersonalStore["exportLog"]> | null {
  if (!store) return null;
  const merged = [...store.exportLog(), ...(cuiStore?.exportLog() ?? [])];
  return merged.sort((a, b) => b.at.localeCompare(a.at));
}

// ── P9.5b: audited migration + records destruction (ADR-0014) ──────────────────────
/** MOVE legacy cui facts out of the main store into the isolated CUI store. Explicit +
 *  audited (it relocates controlled data). Idempotent: re-running after a complete move is a
 *  no-op. Requires BOTH stores unlocked (the destination must be open to receive). */
export function migrateCuiIntoStore(): { ok: boolean; error?: string; moved?: number; entities?: number } {
  if (!load().personalizationEnabled) return { ok: false, error: "Personalization is off." };
  if (!store) return { ok: false, error: "Unlock your main store first." };
  if (!cuiStore) return { ok: false, error: "Unlock the CUI store first (select CUI and enter its passphrase)." };
  try {
    const active = store.graph({ scope: "cui" }); // active cui facts + entities + links
    const cuiFacts = active.facts;
    if (!cuiFacts.length) return { ok: true, moved: 0, entities: 0 };
    const entityIds = new Set(cuiFacts.map((f) => f.entity_id));
    // 1) copy the cui subgraph into the isolated store (ids + timestamps preserved)
    for (const e of active.entities) if (entityIds.has(e.id)) cuiStore.importEntity(e);
    for (const f of cuiFacts) cuiStore.importFact(f);
    for (const l of active.links) if (entityIds.has(l.from_entity_id) && entityIds.has(l.to_entity_id)) cuiStore.importLink(l);
    cuiStore.save();
    // 2) only after the destination is durably saved, remove ALL cui facts (incl. forgotten)
    //    from the main store so no cui data lingers in the wrong place.
    const allCui = store.graph({ includeForgotten: true, scope: "cui" }).facts;
    for (const f of allCui) store.removeFact(f.id);
    store.save();
    auditExport("personal_cui_migrated", { facts: cuiFacts.length, entities: entityIds.size });
    return { ok: true, moved: cuiFacts.length, entities: entityIds.size };
  } catch (e) { return { ok: false, error: String((e as Error)?.message ?? e) }; }
}

/** Destroy the CUI records: zeroize the in-memory key and DELETE the encrypted CUI file.
 *  IRREVERSIBLE — the NARA-aligned records-destruction action. Audited. */
export function destroyCui(): { ok: boolean; error?: string; destroyed?: boolean; facts?: number } {
  if (!load().personalizationEnabled) return { ok: false, error: "Personalization is off." };
  const existed = PersonalStore.exists(personalCuiStorePath());
  const facts = cuiStore ? cuiStore.scopeCounts().cui : undefined; // known only if unlocked
  lockCui(); // zeroize the DEK + drop the store first
  try { if (existed) rmSync(personalCuiStorePath()); }
  catch (e) { return { ok: false, error: String((e as Error)?.message ?? e) }; }
  auditExport("personal_cui_destroyed", { existed, facts: facts ?? null });
  return { ok: true, destroyed: existed, facts };
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
  const scope = (s.personalScope ?? "personal") as ScopeView;
  try {
    if (scope === "cui") return cuiStore ? buildRecall(cuiStore, { scope: "cui" }).block : "";
    if (scope === "combined") return buildRecallFromGraph(nonCui(store.graph({ scope: "combined" }))).block; // never CUI (it's locked)
    return buildRecall(store, { scope }).block;
  } catch { return ""; }
}

/** Learn durable user-facts from one finished turn (best-effort). Fail-closed: only a
 *  clean, trusted user message contributes facts (the distiller scans before storing).
 *  Uses the offline heuristic extractor (no per-turn model cost); the model extractor is
 *  available in the harness for an opt-in upgrade. New facts join the active compartment
 *  (Combined view defaults them to Personal). */
export async function learnFromTurn(userText: string, assistantText: string): Promise<void> {
  const s = load();
  if (!s.personalizationEnabled || !userText.trim()) return; // off or empty
  const view = (s.personalScope ?? "personal") as ScopeView;
  // Route cui learning to the isolated CUI store; if it's locked, learn NOTHING (fail-closed —
  // a cui-scoped fact must never be written into the main store). Combined defaults to Personal.
  const scope: PersonalScope = view === "combined" ? "personal" : view;
  const target = scope === "cui" ? cuiStore : store;
  if (!target) return; // main locked, or cui selected but its store is locked
  try { await distillTurn(target, getScanner(), { userText, assistantText, scope, extract: heuristicExtractor }); }
  catch { /* best-effort; the turn already happened */ }
}

// ── P9.7: import a third-party chat export (ChatGPT / Claude) into the active compartment ──
export interface ImportResult {
  ok: boolean; error?: string;
  vendor?: ImportVendor; conversations?: number; messages?: number; learned?: number; blocked?: number;
}

/** Import a ChatGPT or Claude data export into the active (unlocked) compartment. `pathArg` may
 *  be the extracted export FOLDER (we look for conversations.json inside) or the JSON file
 *  itself. Every imported user message passes the fail-closed scanner gate (keystone #2); cui
 *  routes to the isolated CUI store, and learns nothing if that store is locked. */
export async function importChatExport(pathArg: string, vendorHint?: ImportVendor): Promise<ImportResult> {
  const s = load();
  if (!s.personalizationEnabled) return { ok: false, error: "Personalization is off." };
  const view = (s.personalScope ?? "personal") as ScopeView;
  const scope: PersonalScope = view === "combined" ? "personal" : view;
  const target = scope === "cui" ? cuiStore : store;
  if (!target) return { ok: false, error: scope === "cui" ? "Unlock the CUI store first (select CUI and enter its passphrase)." : "Unlock your store first." };

  const raw = String(pathArg ?? "").trim();
  if (!raw) return { ok: false, error: "Choose your exported folder (the one containing conversations.json)." };
  let file = raw;
  try { if (statSync(raw).isDirectory()) file = join(raw, "conversations.json"); } catch { /* treat as a file path */ }
  let text: string;
  try { text = readFileSync(file, "utf8"); }
  catch { return { ok: false, error: "No conversations.json found there. Unzip your export and pick the folder that contains it." }; }
  let data: unknown;
  try { data = JSON.parse(text); }
  catch { return { ok: false, error: "That conversations.json isn't valid JSON." }; }

  let parsed: ReturnType<typeof parseExport>;
  try { parsed = parseExport(data, vendorHint); }
  catch (e) { return { ok: false, error: String((e as Error)?.message ?? e) }; }
  if (!parsed.conversations.length) return { ok: false, error: "No conversations found in that export." };

  try {
    const tel = new Telemetry({ runId: Snowflake.next(), sessionId: "personal", sink: personalAuditPath() });
    const sum = await importConversations(target, getScanner(), parsed.conversations, { vendor: parsed.vendor, scope, telemetry: tel });
    return { ok: true, ...sum };
  } catch (e) { return { ok: false, error: String((e as Error)?.message ?? e) }; }
}
