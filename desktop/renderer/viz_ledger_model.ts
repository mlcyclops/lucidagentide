// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_ledger_model.ts - P-VIZ.6 (ADR-0635): the PURE session ledger behind Visualize's lower-right
// mini ledger (viz_ledger.ts draws it, viz_view.ts feeds it).
//
// One entry per agent of the current hub session: Main, each fleet lane, and each subagent under its parent.
// Every entry keeps what this session did:
// - Tokens. omp reports no cumulative token count; the only MEASURED figure is the context fill (`usage.used`,
//   from the stream's usage event or the fleet poll's lane.usage). An omp session's context holds the whole
//   conversation, so the ledger shows that fill plus the text streamed SINCE it was reported (chars / 4, the same
//   estimate viz_model uses), the same ctx + output sum the chat's eval turn reports. Any estimated part makes the
//   figure "est."; an agent that never reported usage shows its streamed estimate, "est.". Subagents stream
//   nothing to LUCID, so their tokens are unknown ("-"), never zero.
// - LoC. The authored code a write/edit tool call carries (the chat chips' diffstat convention, toolChip), counted
//   once per call id and taken back if that call fails. A preview long enough to have hit the engine's cap
//   (64 KiB for Main, 16 KiB for a lane) may undercount, so it marks the LoC "est.".
// - Repo or folder: the lane's repo root (else its cwd); Main's current workspace; a subagent inherits its parent's.
//
// A lane whose omp session changes (a respawn) starts over, its subagents with it; a new hub session starts the
// whole ledger over. DOM-free and IO-free; viz_ledger_model.test.ts pins the rules.

import { toolChip } from "./answer_chips.ts";
import { estTokens, HUB_ID, type Persona, type VizKind } from "./viz_model.ts";

/** The engine's preview caps (tool_code.ts callers): Main's acp_backend keeps 64 KiB, a lane 16 KiB. */
export const CODE_CAP_MAIN = 64 * 1024;
export const CODE_CAP_LANE = 16 * 1024;
/** Counted tool calls remembered per agent (so a late failure can take its lines back). */
const COUNTED_MAX = 256;

export interface LedgerAgent {
  id: string;
  kind: VizKind;
  parent: string | null;
  name: string;
  persona: Persona;
  /** The omp session behind a lane (null: not known yet). */
  session: string | null;
  /** The last MEASURED context fill (null: never reported this session). */
  ctx: number | null;
  /** The last reported cost (USD), null when never reported. */
  cost: number | null;
  /** Estimated tokens streamed since the last measured report. */
  estSince: number;
  /** Estimated tokens streamed this session. */
  estAll: number;
  added: number;
  removed: number;
  /** A counted preview may have been clipped by the engine's cap. */
  locEst: boolean;
  /** Write/edit calls counted. */
  edits: number;
  /** Full path of the repo or folder, null when unknown. */
  folder: string | null;
  lastAt: number;
  /** No longer in the scene (removed, or a subagent that ended and left); its row stays for the session. */
  gone: boolean;
  /** Counted calls by id: what each added, so a failure takes exactly that back. */
  counted: Map<string, { add: number; del: number }>;
}

export interface LedgerState {
  agents: Map<string, LedgerAgent>;
  /** The hub (Main) session the ledger counts; null until known. */
  hub: string | null;
}

/** What the ledger needs of a scene node (viz_model's VizNode satisfies it). */
export interface LedgerNodeMeta { id: string; kind: VizKind; parent: string | null; name: string; persona: Persona }

export function createLedger(): LedgerState { return { agents: new Map(), hub: null }; }

function newAgent(m: LedgerNodeMeta, now: number): LedgerAgent {
  return {
    id: m.id, kind: m.kind, parent: m.parent, name: m.kind === "hub" ? "Main" : m.name, persona: m.persona, session: null,
    ctx: null, cost: null, estSince: 0, estAll: 0, added: 0, removed: 0, locEst: false, edits: 0, folder: null,
    lastAt: now, gone: false, counted: new Map(),
  };
}

function upsert(L: LedgerState, m: LedgerNodeMeta, now: number): LedgerAgent {
  let a = L.agents.get(m.id);
  if (!a) { a = newAgent(m, now); L.agents.set(m.id, a); return a; }
  a.kind = m.kind; a.parent = m.parent; a.persona = m.persona; a.gone = false;
  if (m.kind !== "hub") a.name = m.name;
  return a;
}

/** Bring the entries in line with the scene's nodes: new nodes join, known ones take the current name and persona,
 *  and an entry whose node left is kept (the session's history), marked gone. */
export function syncLedger(L: LedgerState, nodes: Iterable<LedgerNodeMeta & { goneAt?: number | null }>, now: number): void {
  const seen = new Set<string>();
  for (const n of nodes) {
    if (n.goneAt !== null && n.goneAt !== undefined) continue;
    seen.add(n.id);
    upsert(L, n, now);
  }
  for (const a of L.agents.values()) if (!seen.has(a.id)) a.gone = true;
}

type Loose = { type: string; text?: unknown; used?: unknown; cost?: unknown; id?: unknown; name?: unknown; detail?: unknown; status?: unknown; ok?: unknown; code?: unknown };
type Code = { path?: unknown; content?: unknown; oldText?: unknown; newText?: unknown; patch?: unknown };

/** One event the scene's model TOOK (viz_model.applyEvent returned true, so a second stream's copy never counts
 *  twice), on the node `m` it came from. */
export function ledgerEvent(L: LedgerState, m: LedgerNodeMeta, ev: { readonly type: string }, now: number): void {
  const a = upsert(L, m, now);
  const e = ev as Loose;
  switch (e.type) {
    case "token":
    case "thinking": {
      const t = typeof e.text === "string" ? estTokens(e.text) : 0;
      if (t <= 0) return;
      a.estSince += t; a.estAll += t; a.lastAt = now;
      return;
    }
    case "usage":
      if (typeof e.used === "number" && Number.isFinite(e.used)) measure(a, e.used, typeof e.cost === "number" ? e.cost : null, now);
      return;
    case "tool": {
      const id = typeof e.id === "string" && e.id ? e.id : null;
      if (e.status === "failed") { if (id) takeBack(a, id); return; }
      const code = e.code && typeof e.code === "object" ? e.code as Code : null;
      if (!code || (id && a.counted.has(id))) return;
      const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
      const c = { content: str(code.content), oldText: str(code.oldText), newText: str(code.newText), patch: str(code.patch) };
      const stat = toolChip(typeof e.name === "string" ? e.name : "tool", "", c).diffstat;
      if (!stat || (stat.add === 0 && stat.del === 0)) return;
      a.added += stat.add; a.removed += stat.del; a.edits++; a.lastAt = now;
      const cap = a.kind === "hub" ? CODE_CAP_MAIN : CODE_CAP_LANE;
      if ([c.content, c.oldText, c.newText, c.patch].some((s) => s !== undefined && s.length >= cap)) a.locEst = true;
      if (id) {
        a.counted.set(id, { add: stat.add, del: stat.del });
        if (a.counted.size > COUNTED_MAX) a.counted.delete(a.counted.keys().next().value!);
      }
      return;
    }
    case "tool-meta":
      if (e.ok === false && typeof e.id === "string" && e.id) takeBack(a, e.id);
      return;
    default:
      return;
  }
}

/** A failed call never changed the file: its counted lines come back off. It stays in `counted` (zeroed), so a
 *  late copy of the same call does not count it again. */
function takeBack(a: LedgerAgent, id: string): void {
  const c = a.counted.get(id);
  if (!c || (c.add === 0 && c.del === 0)) return;
  a.added -= c.add; a.removed -= c.del; a.edits--;
  a.counted.set(id, { add: 0, del: 0 });
}

/** A measured context fill. A repeat of the same figure (the fleet poll echoing the stream's report) changes
 *  nothing; a new one replaces the estimate streamed since the previous report. */
function measure(a: LedgerAgent, used: number, cost: number | null, now: number): void {
  if (cost !== null) a.cost = cost;
  if (a.ctx === used) return;
  a.ctx = used; a.estSince = 0; a.lastAt = now;
}

function resetAgent(L: LedgerState, a: LedgerAgent): void {
  a.ctx = null; a.cost = null; a.estSince = 0; a.estAll = 0; a.added = 0; a.removed = 0; a.locEst = false; a.edits = 0; a.counted.clear();
  for (const c of [...L.agents.values()]) if (c.parent === a.id && c.kind === "subagent") L.agents.delete(c.id);
}

export interface LedgerLaneInput { id: string; session: string | null; folder: string | null; usage?: { used: number; cost: number } }

/** The hub (Main) session the fleet poll reports. A different one starts the whole ledger over (true when it did);
 *  null (not known) changes nothing. */
export function ledgerHub(L: LedgerState, hub: string | null): boolean {
  if (hub === null) return false;
  const reset = L.hub !== null && hub !== L.hub;
  if (reset) L.agents.clear();
  L.hub = hub;
  return reset;
}

/** The fleet poll: each lane's session, folder and measured usage. A lane whose session changed (it respawned)
 *  starts its own entry over, its subagents with it. Call after syncLedger, so new lanes have entries. */
export function ledgerFleet(L: LedgerState, lanes: readonly LedgerLaneInput[], now: number): void {
  for (const l of lanes) {
    const a = L.agents.get(l.id);
    if (!a) continue; // the scene adds the node first (syncLedger)
    if (l.session !== null && a.session !== null && l.session !== a.session) resetAgent(L, a);
    if (l.session !== null) a.session = l.session;
    if (l.folder) a.folder = l.folder;
    if (l.usage && Number.isFinite(l.usage.used)) measure(a, l.usage.used, l.usage.cost, now);
  }
}

/** Main's folder (the current workspace). */
export function ledgerFolder(L: LedgerState, id: string, folder: string | null): void {
  const a = L.agents.get(id);
  if (a && folder) a.folder = folder;
}

// ------------------------------------------------------------------------------------------ rows

export interface LedgerRow {
  id: string;
  kind: VizKind;
  name: string;
  persona: Persona;
  gone: boolean;
  /** Subagents this agent started this session. They stream no tokens or edits to LUCID, so they are a count on
   *  their parent's row, not rows of their own (five rows of dashes would hide the agents). */
  subs: number;
  tokens: number;
  tokEst: boolean;
  ctx: number | null;
  estSince: number;
  cost: number | null;
  added: number;
  removed: number;
  locEst: boolean;
  edits: number;
  folder: string | null;
  /** The folder's last segment (what the row shows; the full path is its tooltip). */
  folderName: string;
  lastAt: number;
}

/** An entry's tokens: the measured context plus the estimate streamed since, or the streamed estimate alone. */
export function tokensOf(a: LedgerAgent): { n: number; est: boolean } {
  if (a.ctx !== null) return { n: a.ctx + a.estSince, est: a.estSince > 0 };
  return { n: a.estAll, est: a.estAll > 0 };
}

/** The last segment of a path, either separator, trailing ones ignored. */
export function baseName(path: string | null): string {
  if (!path) return "";
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function rowOf(a: LedgerAgent, subs: number): LedgerRow {
  const t = tokensOf(a);
  return {
    id: a.id, kind: a.kind, name: a.name, persona: a.persona, gone: a.gone, subs, tokens: t.n, tokEst: t.est, ctx: a.ctx, estSince: a.estSince,
    cost: a.cost, added: a.added, removed: a.removed, locEst: a.locEst, edits: a.edits, folder: a.folder, folderName: baseName(a.folder), lastAt: a.lastAt,
  };
}

/** The ledger's rows: Main first (the hub), then the agents by tokens, most first (ties by name). Each row counts
 *  the subagents it started this session; a subagent whose parent has no entry is not counted. */
export function ledgerRows(L: LedgerState): LedgerRow[] {
  const all = [...L.agents.values()];
  const subs = new Map<string, number>();
  for (const a of all) if (a.kind === "subagent" && a.parent) subs.set(a.parent, (subs.get(a.parent) ?? 0) + 1);
  const tok = (a: LedgerAgent): number => tokensOf(a).n;
  return all.filter((a) => a.kind !== "subagent").sort((x, y) =>
    Number(y.id === HUB_ID) - Number(x.id === HUB_ID) || tok(y) - tok(x) || x.name.localeCompare(y.name))
    .map((a) => rowOf(a, subs.get(a.id) ?? 0));
}

// ------------------------------------------------------------------------------------ formatting

/** 999, 1.0k, 12.4k, 312k, 1.2M, 48M: at most four characters of number. */
export function fmtCompact(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v < 1000) return String(v);
  for (const [div, unit] of [[1e3, "k"], [1e6, "M"], [1e9, "B"]] as const) {
    const x = v / div;
    if (x < 99.95) return `${x.toFixed(1)}${unit}`;
    if (Math.round(x) < 1000) return `${Math.round(x)}${unit}`;
  }
  return `${Math.round(v / 1e9)}B`;
}

/** A row's tokens cell: "12.4k" or "12.4k est.". */
export function fmtTokCell(r: Pick<LedgerRow, "tokens" | "tokEst">): string {
  return `${fmtCompact(r.tokens)}${r.tokEst ? " est." : ""}`;
}

/** A row's LoC cell: "+312 / -40" ("est." when a preview may have been clipped). */
export function fmtLocCell(r: Pick<LedgerRow, "added" | "removed" | "locEst">): string {
  return `+${fmtCompact(r.added)} / -${fmtCompact(r.removed)}${r.locEst ? " est." : ""}`;
}

export interface LedgerSummary { empty: boolean; line1: string; line2: string }

/** The collapsed box's two lines. Line 1: "3 agents · 2 sub · 48.2k tok · +312 / -40 LoC" (agents are the fleet
 *  lanes, as the header census counts them). Line 2: "Busiest: <name> · <folder>", the top-level row with the most
 *  tokens (else the most lines changed). Before any data: "No activity yet this session". */
export function ledgerSummary(rows: readonly LedgerRow[]): LedgerSummary {
  const agents = rows.filter((r) => r.kind === "agent").length;
  let subs = 0, tok = 0, est = false, add = 0, del = 0, locEst = false;
  for (const r of rows) {
    subs += r.subs;
    tok += r.tokens; if (r.tokEst) est = true;
    add += r.added; del += r.removed; if (r.locEst) locEst = true;
  }
  const line1 = `${agents} agent${agents === 1 ? "" : "s"} \u00b7 ${subs} sub \u00b7 ${fmtCompact(tok)} tok${est ? " est." : ""} \u00b7 +${fmtCompact(add)} / -${fmtCompact(del)} LoC${locEst ? " est." : ""}`;
  const tops = rows.filter((r) => r.tokens > 0 || r.added > 0 || r.removed > 0);
  if (!tops.length) return { empty: true, line1, line2: "No activity yet this session" };
  const loc = (r: LedgerRow): number => r.added + r.removed;
  const best = tops.reduce((b, r) => (r.tokens > b.tokens || (r.tokens === b.tokens && loc(r) > loc(b)) ? r : b));
  return { empty: false, line1, line2: `Busiest: ${best.name}${best.folderName ? ` \u00b7 ${best.folderName}` : ""}` };
}
