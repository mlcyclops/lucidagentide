// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-TUI.1 (part) - `lucid hub`: the terminal hub as a PANE MULTIPLEXER (docs/TUI.md, ADR-0420).
//
// The operator's model is herdr/cmux, not a page switcher: a branded chrome (top bar, deck sidebar
// with live badges, status bar), panes split out of a binary tree, any capability deck in any pane.
// Every deck is a thin renderer over the SAME engine /api the desktop renderer calls (capability
// parity by construction). The engine is found and proven through the P-TUI.0 discovery seam
// (ADR-0419) - and when none is running the hub SPAWNS its own headless engine and owns its
// lifetime, so `lucid hub` is one command with no setup. The gate stays in the engine's omp child:
// this client scans nothing and releases nothing by itself; the Security deck's a/i call the same
// audited human-only routes as the GUI panel.
//
// Keys: | split right, - split down, tab/shift+tab focus ring, z zoom, x close, b sidebar,
// 1-6 rebind the focused pane, j/k select rows, a approve / i dismiss (Security), r refresh, q quit.
// Chat deck, palette and directional focus/resize are the rest of P-TUI.1.
//
// P-TUI.3 (ADR-0431): the layout lives in SPACES (hub_spaces.ts: named root layouts, stable pane ids
// s1:p2), `:` opens a command prompt running the same tmux/hub verbs as `lucid hub <cmd>`, and a
// loopback control server (hub_control.ts) lets an agent drive this hub. `lucid hub --headless` is
// this same hub with no terminal attached.
//
// The colors are the desktop design system (styles.css → the P-THEME.1 palette), so the hub and the
// gated `lucid tui` read as one product: LUCID magenta chrome, cyan focus, the styles.css status hues.

import chalk from "@oh-my-pi/pi-utils/chalk";
import { matchesKey, ProcessTerminal, TUI, truncateToWidth, type Component } from "@oh-my-pi/pi-tui";
import { join } from "node:path";
import { discoveryDir, listDiscoveries, verifyDiscovery, type EngineDiscovery } from "../../desktop/engine_discovery.ts";
import { createHubExecutor, startHubControl } from "./hub_control.ts";
import { HubOpError, leaves, loadSpaces, saveSpaces, Spaces, spacesPath, type PaneDeck, type PaneLeaf, type PaneNode } from "./hub_spaces.ts";
import { parseHubCommand, tokenize, type HubOp } from "./hub_tmux_verbs.ts";

// styles.css palette (desktop/renderer/styles.css) - the single source of the brand.
const ACCENT = chalk.hex("#c64bd6");   // --accent: LUCID magenta
const ACCENT_2 = chalk.hex("#e07bf0"); // --accent-2
const CYAN = chalk.hex("#46c8dc");     // --cyan: focus
const TXT = chalk.hex("#edeff6");      // --txt
const TXT_3 = chalk.hex("#727a90");    // --txt-3: chrome, hints
const LINE = chalk.hex("#252a3a");     // --line: unfocused borders
const GREEN = chalk.hex("#46d27e");
const AMBER = chalk.hex("#e8b23c");
const RED = chalk.hex("#ef5f5f");

// ---- decks -------------------------------------------------------------------------------------

export type DeckId = "overview" | "security" | "fleet" | "sessions" | "audit" | "usage" | "network" | "kg" | "agents" | "spaces";
export const DECKS: readonly { id: DeckId; key: string; title: string; icon: string }[] = [
  { id: "overview", key: "1", title: "Overview", icon: "◆" },
  { id: "security", key: "2", title: "Security", icon: "⛨" },
  { id: "fleet", key: "3", title: "Fleet", icon: "⛬" },
  { id: "sessions", key: "4", title: "Sessions", icon: "≡" },
  { id: "audit", key: "5", title: "Audit", icon: "✎" },
  { id: "usage", key: "6", title: "Usage", icon: "$" },
  { id: "network", key: "7", title: "Network", icon: "⇄" },
  { id: "kg", key: "8", title: "Knowledge", icon: "◈" },
  // P-TUI.4: the herdr-parity surfaces - the agent table and the spaces list.
  { id: "agents", key: "9", title: "Agents", icon: "◎" },
  { id: "spaces", key: "0", title: "Spaces", icon: "▦" },
];

/** The engine payload slices the decks draw. Fetched as unknown, narrowed field by field:
 *  a hub must render an older/newer engine's answer or say "?", never crash on it. */
export interface HubData {
  build: Record<string, unknown>;
  security: Record<string, unknown>;
  fleet: Record<string, unknown>;
  sessions: unknown[];
  audit: Record<string, unknown>;
  whitelist: unknown[];
  posture: Record<string, unknown>;
  usage: Record<string, unknown>;
  /** omp's raw configOptions (the model entry carries the catalog + the current pick). */
  config: unknown[];
  /** /api/kb/list: the KG registry ({kgs, activeId}) - always cheap. */
  kg: Record<string, unknown>;
  /** /api/kb/graph for the ACTIVE KG - fetched only while a Knowledge pane is open. */
  kgGraph: Record<string, unknown> | null;
}

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "?");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export function quarantineOf(data: HubData | null): Record<string, unknown>[] {
  return data ? arr(rec(data.security.live).quarantined).map(rec) : [];
}

/** The Knowledge deck's selectable page rows: the graph's pages under the type-to-filter. */
export function kgPages(data: HubData | null, filter: string): Record<string, unknown>[] {
  const pages = arr(rec(data?.kgGraph).pages).map(rec);
  const f = filter.trim().toLowerCase();
  return f ? pages.filter((p) => str(p.title).toLowerCase().includes(f) || str(p.slug).toLowerCase().includes(f)) : pages;
}

// ---- P-TUI.4: the Spaces deck's row shape ------------------------------------------------------
// The deck renders a PROJECTION of the P-TUI.3 Spaces model (hub_spaces.ts): one row per space,
// pane count derived from its tree, focus derived from the model's active id. The pure builder
// below sees only this shape, so it stays testable without the model.
export interface HubSpace { id: string; name: string; panes: number; focused: boolean }

/** Elapsed-since for the Agents table: how long an agent has been alive, herdr-style. */
export function fmtElapsed(startMs: number, now = Date.now()): string {
  if (!Number.isFinite(startMs) || startMs <= 0 || now < startMs) return "?";
  const s = Math.floor((now - startMs) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86_400)}d`;
}

/** The Agents deck's table rows (pure): name, status (the LaneStatus vocabulary verbatim), elapsed
 *  since spawn, model, repo#branch (+ ·wt for a linked worktree) when the lane's background repo
 *  probe has landed. One lane is ONE row; every cell truncates, never wraps (invariant 11). */
export function agentTableLines(lanes: Record<string, unknown>[], selected: number, now = Date.now()): string[] {
  if (lanes.length === 0)
    return ["", "  no agents running", "", "  n  spawn a new agent in this workspace", "  ⏎  attach the selected agent into this pane"];
  const head = `  ${"agent".padEnd(14)} ${"status".padEnd(14)} ${"elapsed".padStart(7)}  ${"model".padEnd(26)} repo`;
  const rows = lanes.map((l, i) => {
    const rv = rec(rec(l.repo).repo);
    const repoName = str(rv.name);
    const branch = str(rv.branch);
    const repoCell = repoName !== "?" && repoName
      ? `${repoName}${branch !== "?" && branch ? `#${branch}` : ""}${rv.worktree === true ? " ·wt" : ""}`
      : "";
    const ask = rec(l.pendingApproval).summary ? " · WAITING ON YOU" : "";
    return `${i === selected ? "▸" : " "} ${truncateToWidth(str(l.name), 14).padEnd(14)} ${str(l.status).padEnd(14)} ${fmtElapsed(Number(l.createdAt), now).padStart(7)}  ${truncateToWidth(str(l.model), 26).padEnd(26)} ${repoCell}${ask}`;
  });
  return ["", head, "", ...rows];
}

/** The Spaces deck's rows (pure): focus marker, name, pane count. */
export function spaceTableLines(spaces: readonly HubSpace[], selected: number): string[] {
  if (spaces.length === 0) return ["", "  no spaces yet - n creates one"];
  const rows = spaces.map((s, i) => {
    const panes = Number.isFinite(s.panes) ? s.panes : 0;
    return `${i === selected ? "▸" : " "} ${s.focused ? "●" : " "} ${truncateToWidth(s.name, 28).padEnd(28)} ${panes} pane${panes === 1 ? "" : "s"}`;
  });
  return ["", ...rows, "", "  ⏎ focus · n new · r rename · x close"];
}

/** Pure deck bodies: plain rows (no ANSI - styling is a later pass), each row one physical line. */
export function deckLines(deck: DeckId, data: HubData | null, width: number, selected: number, filter = "", spaces: readonly HubSpace[] = []): string[] {
  if (!data) return ["loading from the engine…"];
  const w = Math.max(8, width);
  // One row is ONE physical line: engine strings (session titles, findings) can carry newlines,
  // tabs or stray controls, and a single leaked "\n" shears the whole pane geometry.
  const t = (s: string) => truncateToWidth(s.replace(/[\u0000-\u001f\u007f]+/g, " "), w);
  switch (deck) {
    case "overview": {
      const b = data.build;
      const lanes = arr(data.fleet.lanes);
      return [
        "",
        t(`  engine    ${str(b.productName)} v${str(b.version)}`),
        t(`  flavor    ${str(b.flavor)} · port ${str(b.port)}`),
        t(`  blocks    ${quarantineOf(data).length} quarantined`),
        t(`  fleet     ${lanes.length} lane${lanes.length === 1 ? "" : "s"}`),
        t(`  sessions  ${data.sessions.length} on disk`),
      ];
    }
    case "security": {
      const q = quarantineOf(data);
      if (q.length === 0) return ["no active blocks - the gate is quiet"];
      return q.map((blk, i) =>
        t(`${i === selected ? "▸" : " "} ${str(blk.at).slice(11, 19)}  ${str(blk.tool).padEnd(16)} ${str(blk.severity).padEnd(6)} ${str(blk.findings) || str(blk.reason)}`),
      );
    }
    case "fleet": {
      const lanes = arr(data.fleet.lanes).map(rec);
      if (lanes.length === 0) return ["", "  no agents running", "", "  n  spawn a new agent in this workspace", "  ⏎  open the selected agent in this pane"];
      return lanes.map((l, i) =>
        t(`${i === selected ? "▸" : " "} ${str(l.status).padEnd(9)} ${str(l.name)} · ${str(l.turns)} turn${str(l.turns) === "1" ? "" : "s"} · ${str(l.model)}${rec(l.pendingApproval).summary ? " · WAITING ON YOU" : ""}`),
      );
    }
    case "sessions": {
      const s = data.sessions.map(rec);
      if (s.length === 0) return ["no sessions yet"];
      return s.slice(0, 100).map((x, i) =>
        t(`${i === selected ? "▸" : " "} ${fmtAgo(Number(x.updatedAt ?? 0)).padStart(7)}  ${String(str(x.turns)).padStart(3)}⛁  ${str(x.title ?? x.id)}`),
      );
    }
    case "audit": {
      const events = arr(data.audit.events).map(rec);
      if (events.length === 0) return ["no security events recorded"];
      return events.slice(0, 200).map((e) => t(`${str(e.at ?? e.ts).slice(11, 19)}  ${str(e.category)}/${str(e.type)}  ${str(e.decision)}`));
    }
    case "usage": {
      // The ledger's real shape (tools/memory_data.ts UsageLedger): nested cost/tokens objects.
      const models = arr(data.usage.models).map(rec);
      if (models.length === 0) return ["no usage recorded yet"];
      const totals = rec(data.usage.totals);
      const cost = (v: unknown) => { const n = Number(rec(v).total ?? v); return Number.isFinite(n) ? `$${n.toFixed(2)}` : "$0.00"; };
      const tok = (v: unknown) => { const n = Number(rec(v).total ?? 0); return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n); };
      const head = t(`  ${"model".padEnd(34)} ${"cost".padStart(8)} ${"tokens".padStart(8)} ${"turns".padStart(6)}  cache`);
      const rows = models.slice(0, 40).map((m) => {
        const hit = Number(m.cacheHitRate);
        return t(`  ${truncateToWidth(str(m.model), 34).padEnd(34)} ${cost(m.cost).padStart(8)} ${tok(m.tokens).padStart(8)} ${str(m.turns).padStart(6)}  ${Number.isFinite(hit) ? `${Math.round(hit * 100)}%` : "-"}`);
      });
      const sum = t(`  ${"all models".padEnd(34)} ${`$${Number(totals.cost ?? 0).toFixed(2)}`.padStart(8)} ${tok({ total: totals.tokens }).padStart(8)} ${str(totals.turns).padStart(6)}`);
      return ["", head, "", ...rows, "", sum];
    }
    case "network": {
      const posture = data.posture;
      const entries = data.whitelist.map(rec);
      const head = [
        "",
        t(`  allow-all ${posture.allowAll === true ? "ON  - every site + local LAN allowed; the whitelist is standing exceptions" : "OFF - ONLY whitelisted hosts pass"}${posture.managedLocked === true ? " (locked by policy)" : ""}`),
        t(`  web-search ${posture.allowWebSearch === true ? "ON" : "OFF"}`),
        "",
        t(`  ${"host / pattern".padEnd(38)} ${"kind".padEnd(7)} ${"zone".padEnd(9)} scope`),
        "",
      ];
      if (entries.length === 0) return [...head, "  no whitelist entries - w adds one (subprocess egress denials land here)"];
      return [...head, ...entries.map((e, i) =>
        t(`${i === selected ? "▸" : " "} ${truncateToWidth(str(e.pattern), 38).padEnd(38)} ${str(e.kind).padEnd(7)} ${str(e.zone).padEnd(9)} ${str(e.scope)}`),
      )];
    }
    case "kg": {
      const kgs = arr(data.kg.kgs).map(rec);
      if (kgs.length === 0) return ["no knowledge graphs yet - build one in the GUI or `lucid kb`"];
      const activeId = str(data.kg.activeId);
      // Every KG names WHERE its knowledge comes from: the source kind (chat export / obsidian
      // vault / installed pack / manual) plus its free-text origin, and a lock for read-only packs.
      const sourceLabel: Record<string, string> = { chat: "AI chat export", obsidian: "Obsidian vault", pack: "installed pack", manual: "written by you / your agents" };
      const head = ["", ...kgs.map((k) => {
        const prov = str(k.provenance);
        const origin = prov !== "?" && prov && prov !== "default" ? ` · ${prov}` : "";
        return t(`  ${str(k.kg_id) === activeId ? "●" : " "} ${str(k.name)}  ·  ${sourceLabel[str(k.source_kind)] ?? str(k.source_kind)}${origin}${k.read_only === true ? " · read-only" : ""}`);
      }), ""];
      const g = data.kgGraph;
      if (!g) return [...head, "  loading the graph…"];
      const pages = kgPages(data, filter);
      const titleOf = new Map(arr(g.pages).map(rec).map((p) => [str(p.page_id), str(p.title)]));
      const linksFrom = new Map<string, string[]>();
      for (const l of arr(g.links).map(rec)) {
        const from = str(l.from_page_id);
        (linksFrom.get(from) ?? linksFrom.set(from, []).get(from)!).push(titleOf.get(str(l.to_page_id)) ?? "?");
      }
      const stats = t(`  ${str(g.totalPages)} page${str(g.totalPages) === "1" ? "" : "s"} · ${str(g.totalLinks)} link${str(g.totalLinks) === "1" ? "" : "s"}${filter ? ` · filter: ${filter}` : ""}`);
      if (pages.length === 0) return [...head, stats, "", filter ? "  nothing matches the filter (/ edits, esc clears)" : "  this knowledge graph is empty"];
      return [...head, stats, "", ...pages.map((p, i) => {
        const out = linksFrom.get(str(p.page_id)) ?? [];
        const arrow = out.length ? `  →  ${out.slice(0, 4).join(" · ")}${out.length > 4 ? ` · +${out.length - 4}` : ""}` : "";
        const trust = str(p.trust_label);
        return t(`${i === selected ? "▸" : " "} [${trust}] ${str(p.title)} (${str(p.degree)})${arrow}`);
      })];
    }
    case "agents":
      return agentTableLines(arr(data.fleet.lanes).map(rec), selected).map(t);
    case "spaces":
      return spaceTableLines(spaces, selected).map(t);
  }
}

/** Pull the model catalog out of omp's raw configOptions: the entry that owns a model list, its
 *  options as {value,name}, and the currently-active value. Fail-soft: no catalog is an empty list
 *  (the picker explains), never a crash on a shape from an older/newer omp. */
export interface ModelOption { value: string; name: string }
export function modelCatalog(config: unknown[]): { models: ModelOption[]; current: string } {
  for (const raw of config.map(rec)) {
    if (!/model/i.test(str(raw.id))) continue;
    const models = arr(raw.options).map(rec)
      .map((o) => ({ value: str(o.value), name: str(o.name ?? o.value) }))
      .filter((m) => m.value !== "?");
    if (models.length) return { models, current: str(raw.value ?? raw.currentValue ?? "") };
  }
  return { models: [], current: "" };
}

/** The picker's visible rows under its type-ahead filter (name OR id substring, case-blind). */
export function pickerMatches(pk: { models: ModelOption[]; filter: string }): ModelOption[] {
  const f = pk.filter.trim().toLowerCase();
  return f ? pk.models.filter((m) => m.name.toLowerCase().includes(f) || m.value.toLowerCase().includes(f)) : pk.models;
}

/** The status-bar teaching line, per focused surface: what THIS pane responds to right now. */
export const DECK_HINTS: Record<DeckId | "agent" | "prompting", string> = {
  overview: "| - split · tab focus · 1-9,0 decks",
  security: "j/k select · a approve · i dismiss",
  fleet: "n new agent · j/k select · ⏎ open agent here",
  sessions: "j/k select · ⏎ resume session as a live agent",
  audit: "j/k scroll · r refresh",
  usage: "r refresh",
  network: "w whitelist a host · j/k select · D remove · t toggle allow-all",
  kg: "j/k select · ⏎ read page · / filter · c switch KG",
  agents: "j/k select · ⏎ attach here · n spawn · c cancel turn · x dismiss stopped",
  spaces: "j/k select · ⏎ focus · n new space · r rename · x close space",
  agent: "⏎ prompt · m model · j/k scroll · G live · y/s/d answer ask · x close",
  prompting: "type your prompt · ⏎ send · esc cancel",
};

/** Style one plain deck row (widths already fixed - only color changes here, never geometry). */
export function colorizeRow(deck: DeckId, row: string): string {
  if (deck === "security") return row.replace(/\b(high|critical)\b/, (m) => RED(m)).replace(/\bmedium\b/, (m) => AMBER(m));
  if (deck === "fleet")
    return row
      .replace(/^(running|working)\b/, (m) => GREEN(m))
      .replace(/^(failed|dead|stopped)\b/, (m) => RED(m))
      .replace(/WAITING ON YOU/, (m) => AMBER(m));
  if (deck === "audit") return row.replace(/\bblock\b/, (m) => RED(m)).replace(/\ballow\b/, (m) => GREEN(m));
  if (deck === "kg")
    return row
      .replace(/\[trusted\]/, (m) => GREEN(m))
      .replace(/\[(untrusted|suspicious)\]/, (m) => AMBER(m))
      .replace(/\[quarantined\]/, (m) => RED(m));
  // The Agents table carries the status mid-row at a fixed column (the LaneStatus vocabulary).
  if (deck === "agents")
    return row
      .replace(/\b(working|starting)\b/, (m) => GREEN(m))
      .replace(/\b(error|stopped)\b/, (m) => RED(m))
      .replace(/\b(needs-approval|awaiting-input)\b/, (m) => AMBER(m))
      .replace(/WAITING ON YOU/, (m) => AMBER(m));
  return row;
}

/** Relative timestamps for the Sessions deck - "2h ago" reads; raw epoch millis never do. */
export function fmtAgo(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "?";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/** Greedy word wrap for agent transcript text (pane bodies are physical rows). */
export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    let line = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ");
    if (line === "") { out.push(""); continue; }
    while (Bun.stringWidth(line) > width) {
      let cut = width;
      const slice = line.slice(0, width + 1);
      const space = slice.lastIndexOf(" ");
      if (space > width * 0.5) cut = space;
      out.push(line.slice(0, cut));
      line = line.slice(cut).trimStart();
    }
    out.push(line);
  }
  return out;
}

/** Pad/clip a block of rows to exactly w x h (plain text in, plain text out). */
export function fitBlock(lines: readonly string[], w: number, h: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < h; i++) {
    const line = lines[i] ?? "";
    const width = Bun.stringWidth(line);
    out.push(width >= w ? truncateToWidth(line, w) : line + " ".repeat(w - width));
  }
  return out;
}

// ---- the component -----------------------------------------------------------------------------

interface HubUi { requestRender(): void; terminal: { rows: number } }

const POLL_MS = 2000;
const SIDEBAR_W = 20;

export class HubComponent implements Component {
  readonly #ui: HubUi;
  readonly #base: string;
  readonly #token: string;
  readonly #engine: EngineDiscovery;
  readonly #spawned: boolean;
  readonly #done = Promise.withResolvers<void>();
  readonly #spaces: Spaces;
  readonly #exec: (op: HubOp) => Promise<unknown>;
  // The focused space's tree/focus/zoom: every pane key below reads and writes the ACTIVE space.
  get #tree(): PaneNode { return this.#spaces.current.tree; }
  get #focus(): number { return this.#spaces.current.focus; }
  set #focus(i: number) { this.#spaces.current.focus = i; }
  get #zoom(): boolean { return this.#spaces.current.zoom; }
  set #zoom(z: boolean) { this.#spaces.current.zoom = z; }
  #sidebar = true;
  #help = false;
  #selected = 0;
  #scroll = 0; // agent-pane scrollback offset, lines up from the live tail (0 = follow)
  #transcripts: Record<string, { role: string; text: string }[]> = {};
  /** Mid-turn state per open agent pane, fed by the /api/fleet/watch NDJSON stream (token deltas,
   *  tool calls, status flips) - what makes a working model VISIBLE instead of a frozen pane. */
  #live: Record<string, { text: string; thinking: string; tools: string[]; working: boolean; trimmed?: boolean }> = {};
  #watchers: Record<string, AbortController> = {};
  #prompt: { lane: string; text: string } | null = null;
  #picker: { lane: string; models: ModelOption[]; sel: number; filter: string; busy?: boolean } | null = null;
  #promptKind: "agent" | "wl-add" | "kg-filter" | "command" | "space-rename" = "agent";
  #kgFilter = "";
  #reader: { title: string; rows: string[] } | null = null;
  #data: HubData | null = null;
  #status = "";
  #timer: NodeJS.Timeout | undefined;
  #disposed = false;

  constructor(ui: HubUi, engine: EngineDiscovery, opts: { spawned?: boolean; spaces?: Spaces } = {}) {
    this.#ui = ui;
    this.#engine = engine;
    this.#spawned = !!opts.spawned;
    this.#base = `http://127.0.0.1:${engine.port}`;
    this.#token = engine.token;
    this.#spaces = opts.spaces ?? new Spaces();
    this.#exec = createHubExecutor({
      spaces: this.#spaces,
      engine: { base: this.#base, token: engine.token, port: engine.port, version: engine.version, flavor: engine.flavor },
      isDeck: (d) => DECKS.some((x) => x.id === d),
      paneText: (id, w, n) => this.paneText(id, w, n),
      refresh: () => this.refresh(),
      changed: () => this.#ui.requestRender(),
    });
  }

  get spaces(): Spaces {
    return this.#spaces;
  }

  /** Run one control op (the control server and the `:` prompt both land here). */
  exec(op: HubOp): Promise<unknown> {
    return this.#exec(op);
  }

  quit(): void {
    this.#done.resolve();
  }

  /** A pane as the hub draws it: ANSI stripped, frame removed, trailing blank rows dropped. */
  paneText(ref: string | undefined, width: number, lines: number): { id: string; title: string; lines: string[] } {
    const { leaf } = this.#spaces.pane(ref);
    const rows = this.#pane(leaf, width, lines + 2, false).map((r) => Bun.stripANSI(r));
    const body = rows.slice(1, -1).map((r) => r.slice(2, -2).trimEnd());
    while (body.length && !body[body.length - 1]) body.pop();
    return { id: leaf.id, title: rows[0]!.replace(/^╭─|─*╮$/g, "").trim(), lines: body };
  }

  run(): Promise<void> {
    void this.refresh();
    this.#timer = setInterval(() => void this.refresh(), POLL_MS);
    return this.#done.promise;
  }

  dispose(): void {
    this.#disposed = true;
    clearInterval(this.#timer);
    for (const ctl of Object.values(this.#watchers)) ctl.abort();
    this.#watchers = {};
  }

  async #get(path: string): Promise<unknown> {
    const res = await fetch(`${this.#base}${path}`, { headers: { "x-lucid-token": this.#token }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    const body = rec(await res.json());
    return body.data ?? body;
  }

  async #post(path: string, payload: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${this.#base}${path}`, {
      method: "POST",
      headers: { "x-lucid-token": this.#token, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000), // a spawn boots an omp child; give it room
    });
    const body = rec(await res.json().catch(() => null));
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return body.data ?? body;
  }

  async refresh(): Promise<void> {
    try {
      const kgVisible = leaves(this.#tree).some((l) => l.deck === "kg");
      const [build, security, fleet, sessions, audit, usage, whitelist, posture, config, kg, kgGraph] = await Promise.all([
        this.#get("/api/build-info"), this.#get("/api/security"), this.#get("/api/fleet/status"),
        this.#get("/api/sessions"), this.#get("/api/audit"), this.#get("/api/usage"),
        this.#get("/api/whitelist"), this.#get("/api/whitelist/posture"), this.#get("/api/config"),
        this.#get("/api/kb/list"),
        // The graph opens one DuckDB per KG - only paid while a Knowledge pane is actually open.
        kgVisible ? this.#get("/api/kb/graph").catch(() => null) : Promise.resolve(this.#data?.kgGraph ?? null),
      ]);
      if (this.#disposed) return;
      this.#data = {
        build: rec(build), security: rec(security), fleet: rec(fleet),
        sessions: arr(rec(sessions).sessions ?? sessions), audit: rec(audit), usage: rec(usage),
        whitelist: arr(whitelist), posture: rec(posture), config: arr(config),
        kg: rec(kg), kgGraph: kgGraph === null ? null : rec(kgGraph),
      };
      // Live transcripts for every open agent pane, same poll tick.
      const laneIds = [...new Set(leaves(this.#tree).flatMap((l) => (l.deck === "agent" && l.lane ? [l.lane] : [])))];
      const fetched = await Promise.all(laneIds.map(async (id) => {
        try {
          const r = rec(await this.#get(`/api/fleet/transcript?laneId=${encodeURIComponent(id)}`));
          return [id, arr(r.turns).map(rec).map((x) => ({ role: str(x.role), text: str(x.text) }))] as const;
        } catch { return [id, this.#transcripts[id] ?? []] as const; }
      }));
      this.#transcripts = Object.fromEntries(fetched);
      this.#syncWatchers(laneIds);
      // Only an unreachable-engine banner self-clears on recovery; action messages stay until the next action.
      if (this.#status.startsWith("engine unreachable")) this.#status = "";
    } catch (err) {
      this.#status = `engine unreachable: ${err instanceof Error ? err.message : String(err)}`;
    }
    this.#ui.requestRender();
  }

  /** One long-lived watch stream per open agent pane; panes that closed lose theirs. A stream that
   *  drops (engine restart) is simply restarted by the next poll tick - never a tight loop. */
  #syncWatchers(laneIds: string[]): void {
    for (const id of laneIds) if (!this.#watchers[id]) this.#watch(id);
    for (const id of Object.keys(this.#watchers)) if (!laneIds.includes(id)) { this.#watchers[id]!.abort(); delete this.#watchers[id]; delete this.#live[id]; }
  }

  #watch(lane: string): void {
    const ctl = new AbortController();
    this.#watchers[lane] = ctl;
    void (async () => {
      try {
        const res = await fetch(`${this.#base}/api/fleet/watch`, {
          method: "POST",
          headers: { "x-lucid-token": this.#token, "content-type": "application/json" },
          body: JSON.stringify({ laneId: lane }),
          signal: ctl.signal,
        });
        const reader = res.body?.getReader();
        if (!reader) return;
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) this.#liveEvent(lane, line);
          }
        }
      } catch { /* aborted or engine gone - the poll tick restarts live streams */ }
      if (this.#watchers[lane] === ctl) delete this.#watchers[lane];
    })();
  }

  #liveEvent(lane: string, line: string): void {
    let e: Record<string, unknown>;
    try { e = rec(JSON.parse(line)); } catch { return; }
    const s = this.#live[lane] ?? (this.#live[lane] = { text: "", thinking: "", tools: [], working: false });
    if (e.type === "token") { s.text += str(e.text); s.working = true; }
    // Whole-turn retention: the START of the reasoning is what gets inspected after the fact, so the
    // cap exists only to bound a runaway stream, not to trim a real turn. 500k chars ≈ well past any
    // real thinking phase; a turn that exceeds it keeps its tail and the pane says nothing false.
    else if (e.type === "thinking") {
      const grown = s.thinking + str(e.text);
      s.trimmed = s.trimmed || grown.length > 500_000;
      s.thinking = grown.slice(-500_000);
      s.working = true;
    }
    else if (e.type === "tool") { s.tools.push(str(e.name)); if (s.tools.length > 6) s.tools.shift(); s.working = true; }
    else if (e.type === "status") s.working = str(e.status) === "working";
    // A settled turn clears the streamed reply text (the transcript now carries it) but KEEPS the
    // thinking and tool trail visible until the NEXT prompt - a reply must never clobber the
    // reasoning that produced it (field report 2026-09-28). #sendPrompt does the real reset.
    else if (e.type === "done") { s.text = ""; s.working = false; void this.refresh(); return; }
    this.#ui.requestRender();
  }

  #focusedLeaf(): PaneLeaf {
    return this.#spaces.pane().leaf;
  }

  #focusedDeck(): PaneDeck {
    return this.#focusedLeaf().deck;
  }

  handleInput(data: string): void {
    // Enter arrives as \r, \n or \r\n depending on the terminal's line discipline; byte-exact
    // matching silently killed the key on CRLF terminals (field report 2026-09-28).
    const isEnter = data === "\r" || data === "\n" || data === "\r\n" || matchesKey(data, "enter");
    if (this.#help) { if (isEnter) return; this.#help = false; this.#ui.requestRender(); if (data === "q" || matchesKey(data, "ctrl+c")) this.#done.resolve(); return; }
    // Page reader: a fullscreen read view anchored at the TOP; j/k move down/up, esc or q closes.
    if (this.#reader) {
      if (matchesKey(data, "escape") || data === "q") { this.#reader = null; this.#scroll = 0; }
      else if (data === "j" || matchesKey(data, "down")) this.#scroll++;
      else if (data === "k" || matchesKey(data, "up")) this.#scroll = Math.max(0, this.#scroll - 1);
      else if (matchesKey(data, "ctrl+d")) this.#scroll += 10;
      else if (matchesKey(data, "ctrl+u")) this.#scroll = Math.max(0, this.#scroll - 10);
      this.#ui.requestRender();
      return;
    }
    // Prompt mode: the focused agent pane owns the keyboard until Enter (send) or Esc (cancel).
    // Pasted/chunked input arrives as one string, so walk it char by char; a newline inside a
    // chunk submits what was typed before it (terminal paste semantics). An EMPTY enter is a
    // no-op that keeps the composer open - it used to close it, dumping the next keystrokes onto
    // the global keymap ("-" split a pane mid-sentence).
    if (this.#prompt) {
      const isKgFilter = this.#promptKind === "kg-filter";
      if (matchesKey(data, "escape")) {
        if (isKgFilter) { this.#kgFilter = ""; this.#selected = 0; }
        this.#prompt = null; this.#promptKind = "agent"; this.#ui.requestRender(); return;
      }
      if (matchesKey(data, "backspace")) {
        this.#prompt.text = this.#prompt.text.slice(0, -1);
        if (isKgFilter) { this.#kgFilter = this.#prompt.text; this.#selected = 0; }
        this.#ui.requestRender(); return;
      }
      for (const ch of data) {
        if (ch === "\r" || ch === "\n") {
          if (isKgFilter) { this.#prompt = null; this.#promptKind = "agent"; this.#ui.requestRender(); return; } // filter stays applied
          if (this.#prompt.text.trim()) { void this.#sendPrompt(); return; }
          continue; // empty enter: stay in the composer
        }
        if (ch >= " " && ch !== "\u007f") this.#prompt.text += ch;
      }
      if (isKgFilter) { this.#kgFilter = this.#prompt.text; this.#selected = 0; } // LIVE: the deck narrows as you type
      this.#ui.requestRender();
      return;
    }
    // Model picker: type to filter, arrows move, enter applies, esc clears the filter then closes.
    if (this.#picker) {
      if (this.#picker.busy) return; // parked until the engine answers - keys cannot leak
      const pk = this.#picker;
      if (matchesKey(data, "escape")) {
        if (pk.filter) { pk.filter = ""; pk.sel = 0; } else this.#picker = null;
      } else if (matchesKey(data, "backspace")) { pk.filter = pk.filter.slice(0, -1); pk.sel = 0; }
      else if (matchesKey(data, "down")) pk.sel = Math.min(Math.max(0, pickerMatches(pk).length - 1), pk.sel + 1);
      else if (matchesKey(data, "up")) pk.sel = Math.max(0, pk.sel - 1);
      else if (isEnter) { void this.#applyModel(); return; }
      else { for (const ch of data) if (ch >= " " && ch !== "\u007f") pk.filter += ch; pk.sel = 0; }
      this.#ui.requestRender();
      return;
    }
    if (matchesKey(data, "ctrl+c") || data === "q") { this.#done.resolve(); return; }
    if (data === "?") { this.#help = true; this.#ui.requestRender(); return; }
    const count = leaves(this.#tree).length;
    const sp = this.#spaces;
    if (data === "|" || data === "-") sp.split(undefined, data === "|" ? "right" : "down");
    else if (matchesKey(data, "tab")) { this.#focus = (this.#focus + 1) % count; this.#selected = 0; this.#scroll = 0; }
    else if (matchesKey(data, "shift+tab")) { this.#focus = (this.#focus + count - 1) % count; this.#selected = 0; this.#scroll = 0; }
    else if (data === "z") this.#zoom = !this.#zoom;
    else if (data === "b") this.#sidebar = !this.#sidebar;
    else if (data === ":") { this.#promptKind = "command"; this.#prompt = { lane: "", text: "" }; }
    else if (data === "x" && this.#focusedDeck() === "agents") { void this.#dismissLane(); return; }
    else if (data === "x" && this.#focusedDeck() === "spaces") { this.#closeSpace(); return; }
    else if (data === "x") {
      try { sp.closePane(); } catch (e) { if (!(e instanceof HubOpError)) throw e; this.#status = "last pane - q quits"; }
    } else if (DECKS.some((d) => d.key === data)) {
      sp.rebind(undefined, DECKS.find((d) => d.key === data)!.id);
      this.#selected = 0; this.#scroll = 0;
    } else if (data === "j" || matchesKey(data, "down")) {
      if (this.#focusedDeck() === "agent") this.#scroll = Math.max(0, this.#scroll - 1);
      else this.#selected++;
    } else if (data === "k" || matchesKey(data, "up")) {
      if (this.#focusedDeck() === "agent") this.#scroll++;
      else this.#selected = Math.max(0, this.#selected - 1);
    } else if (matchesKey(data, "ctrl+u") && this.#focusedDeck() === "agent") this.#scroll += 10;
    else if (matchesKey(data, "ctrl+d") && this.#focusedDeck() === "agent") this.#scroll = Math.max(0, this.#scroll - 10);
    else if (data === "G" && this.#focusedDeck() === "agent") this.#scroll = 0;
    else if (data === "r" && this.#focusedDeck() === "spaces") { this.#startRenameSpace(); return; }
    else if (data === "r") { void this.refresh(); return; }
    else if (data === "a" || data === "i") { void this.#judge(data === "a"); return; }
    else if (data === "n" && this.#focusedDeck() === "spaces") { this.#createSpace(); return; }
    else if (data === "n") { void this.#spawnAgent(null); return; }
    else if (data === "c" && this.#focusedDeck() === "agents") { void this.#cancelLane(); return; }
    else if (data === "w" && this.#focusedDeck() === "network") { this.#promptKind = "wl-add"; this.#prompt = { lane: "", text: "" }; }
    else if (data === "D" && this.#focusedDeck() === "network") { void this.#removeWhitelistEntry(); return; }
    else if (data === "t" && this.#focusedDeck() === "network") { void this.#togglePosture(); return; }
    else if (data === "/" && this.#focusedDeck() === "kg") { this.#promptKind = "kg-filter"; this.#prompt = { lane: "", text: this.#kgFilter }; }
    else if (data === "c" && this.#focusedDeck() === "kg") { void this.#cycleKg(); return; }
    else if ((data === "y" || data === "s" || data === "d") && this.#pendingApprovalLane()) { void this.#answerApproval(data); return; }
    else if (isEnter) { void this.#enter(); return; }
    else if (data === "m") { this.#openModelPicker(); return; }
    this.#ui.requestRender();
  }

  /** `m` on an agent pane: the model catalog from omp's configOptions, current pick preselected. */
  #openModelPicker(): void {
    const leaf = this.#focusedLeaf();
    if (leaf.deck !== "agent" || !leaf.lane) { this.#status = "m switches an AGENT pane's model - open one first (Fleet, ⏎)"; this.#ui.requestRender(); return; }
    const { models, current } = modelCatalog(this.#data?.config ?? []);
    if (models.length === 0) { this.#status = "the engine reports no model catalog yet - it warms up with the first session"; this.#ui.requestRender(); return; }
    const lane = arr(this.#data?.fleet.lanes).map(rec).find((l) => str(l.id) === leaf.lane);
    const active = (lane && str(lane.model)) || current;
    const sel = Math.max(0, models.findIndex((m) => m.value === active || m.name === active));
    this.#picker = { lane: leaf.lane, models, sel, filter: "" };
    this.#ui.requestRender();
  }

  /** Switch the lane's model through the engine (fleet.setModel) - the same seam the GUI uses.
   *  The picker stays up (busy, input parked) until the engine answers, so keystrokes during the
   *  switch can never leak onto the global keymap. */
  async #applyModel(): Promise<void> {
    const pk = this.#picker;
    if (!pk || pk.busy) return;
    const pick = pickerMatches(pk)[pk.sel];
    if (!pick) { this.#status = "no model matches that filter"; this.#ui.requestRender(); return; }
    pk.busy = true;
    this.#ui.requestRender();
    try {
      const r = rec(await this.#post("/api/fleet/model", { laneId: pk.lane, model: pick.value }));
      this.#status = r.ok === false ? `model switch refused: ${str(r.reason ?? r.error ?? "engine said no")}` : `model → ${pick.name}`;
    } catch (err) {
      this.#status = `model switch failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    this.#picker = null;
    await this.refresh();
  }

  /** The focused agent pane's lane id, when its lane is parked on a tool approval. */
  #pendingApprovalLane(): string | null {
    const leaf = this.#focusedLeaf();
    if (leaf.deck !== "agent" || !leaf.lane) return null;
    const lane = arr(this.#data?.fleet.lanes).map(rec).find((l) => str(l.id) === leaf.lane);
    return lane && rec(lane.pendingApproval).summary ? leaf.lane : null;
  }

  /** Answer the lane's parked ask through the SAME route the GUI's lane card drives: y = allow once,
   *  s = allow for the whole session (this ask kind stops asking), d = deny. The in-omp security gate
   *  still scans every call either way - this answers the HUMAN ask only (P-FLEET.L6 discipline). */
  async #answerApproval(key: string): Promise<void> {
    const lane = this.#pendingApprovalLane();
    if (!lane) return;
    const allow = key !== "d";
    await this.#post("/api/fleet/answer", { laneId: lane, allow, ...(key === "s" ? { scope: "session" } : allow ? { scope: "once" } : {}) });
    this.#status = key === "d" ? "denied the tool call" : key === "s" ? "allowed - and for the rest of this session" : "allowed once";
    await this.refresh();
  }

  /** Enter, by pane kind: Fleet opens the selected agent HERE; Sessions RESUMES the selected session
   *  as a live agent (fleet spawn with sessionId - the engine replays its memory); an agent pane
   *  starts prompt mode. The whole herdr loop: spawn, open, talk, watch. */
  async #enter(): Promise<void> {
    const leaf = this.#focusedLeaf();
    if (leaf.deck === "agent" && leaf.lane) {
      // A parked ask owns the pane: opening the composer here is how "y + enter" became a prompt
      // named "y" (field report 2026-09-28). Answer first; the composer comes back after.
      if (this.#pendingApprovalLane()) { this.#status = "this agent is waiting on the ask above - answer it: y allow once · s allow for session · d deny"; this.#ui.requestRender(); return; }
      this.#promptKind = "agent"; this.#prompt = { lane: leaf.lane, text: "" }; this.#scroll = 0; this.#ui.requestRender(); return;
    }
    // P-TUI.4: the Agents table attaches exactly like Fleet - the ADR-0420 live-agent-pane bind.
    if ((leaf.deck === "fleet" || leaf.deck === "agents") && this.#data) {
      const lanes = arr(this.#data.fleet.lanes).map(rec);
      const lane = lanes[Math.min(this.#selected, lanes.length - 1)];
      if (!lane) { this.#status = "no agent selected - n spawns one"; this.#ui.requestRender(); return; }
      this.#spaces.rebind(undefined, "agent", { id: str(lane.id), name: str(lane.name) });
      await this.refresh();
      return;
    }
    if (leaf.deck === "spaces") { this.#focusSpace(); return; }
    if (leaf.deck === "sessions" && this.#data) {
      const s = this.#data.sessions.map(rec);
      const sess = s[Math.min(this.#selected, s.length - 1)];
      if (!sess) { this.#status = "no session selected"; this.#ui.requestRender(); return; }
      await this.#spawnAgent(str(sess.id));
      return;
    }
    if (leaf.deck === "kg" && this.#data) {
      const pages = kgPages(this.#data, this.#kgFilter);
      const page = pages[Math.min(this.#selected, pages.length - 1)];
      if (!page) { this.#status = "no page selected"; this.#ui.requestRender(); return; }
      await this.#openKgPage(str(rec(this.#data.kgGraph).kgId), str(page.page_id));
      return;
    }
    this.#ui.requestRender();
  }

  /** Fetch one knowledge page and open the fullscreen reader. Content renders as wrapped text. */
  async #openKgPage(kgId: string, pageId: string): Promise<void> {
    try {
      const page = rec(await this.#get(`/api/kb/page?kgId=${encodeURIComponent(kgId)}&pageId=${encodeURIComponent(pageId)}`));
      const body = str(page.body_md ?? page.content ?? page.body ?? "");
      // Lead with provenance: what this page IS, how far it is trusted, where it sits, and when.
      const meta = `${str(page.kind)} · trust: ${str(page.trust_label)}${str(page.classification) !== "?" && page.classification ? ` · ${str(page.classification)}` : ""} · updated ${str(page.updated_at).slice(0, 10)}`;
      this.#reader = { title: str(page.title), rows: [meta, "", ...(body === "?" || !body ? ["(this page has no readable body)"] : body.split("\n"))] };
      this.#scroll = 0;
    } catch (err) {
      this.#status = `could not load the page: ${err instanceof Error ? err.message : String(err)}`;
    }
    this.#ui.requestRender();
  }

  /** `c`: activate the NEXT KG in the registry - same /api/kb/activate the GUI picker calls. */
  async #cycleKg(): Promise<void> {
    const kgs = arr(this.#data?.kg.kgs).map(rec);
    if (kgs.length < 2) { this.#status = kgs.length === 0 ? "no knowledge graphs" : "only one knowledge graph"; this.#ui.requestRender(); return; }
    const activeId = str(this.#data?.kg.activeId);
    const idx = Math.max(0, kgs.findIndex((k) => str(k.kg_id) === activeId));
    const next = kgs[(idx + 1) % kgs.length]!;
    await this.#post("/api/kb/activate", { kgId: str(next.kg_id) });
    this.#kgFilter = ""; this.#selected = 0;
    this.#status = `knowledge graph → ${str(next.name)}`;
    await this.refresh();
  }

  /** Spawn a lane (optionally resuming a session) and open it in the focused pane. Refusals (a held
   *  session, lane cap) surface verbatim in the status bar - the engine's answer, not a guess. */
  async #spawnAgent(sessionId: string | null): Promise<void> {
    this.#status = "spawning agent…";
    this.#ui.requestRender();
    try {
      // A lane needs a real folder to work in: the engine's CURRENT workspace, asked for, never guessed.
      const ws = rec(await this.#get("/api/workspace"));
      const body: Record<string, unknown> = { cwd: str(ws.current), ...(sessionId ? { sessionId } : {}) };
      const reply = rec(await this.#post("/api/fleet/spawn", body));
      const lane = rec(reply.lane);
      const id = str(lane.id);
      if (id === "?") { this.#status = `spawn refused: ${str(reply.reason ?? reply.error ?? reply.detail ?? "no lane in reply")}`; this.#ui.requestRender(); return; }
      this.#spaces.rebind(undefined, "agent", { id, name: str(lane.name) });
      this.#status = sessionId ? `resumed session as agent ${str(lane.name)}` : `spawned agent ${str(lane.name)}`;
      await this.refresh();
    } catch (err) {
      this.#status = `spawn failed: ${err instanceof Error ? err.message : String(err)}`;
      this.#ui.requestRender();
    }
  }

  async #sendPrompt(): Promise<void> {
    const p = this.#prompt;
    if (!p) return;
    const kind = this.#promptKind;
    this.#promptKind = "agent";
    const text = p.text.trim();
    this.#prompt = null;
    if (!text) { this.#ui.requestRender(); return; }
    try {
      if (kind === "command") {
        // Same parser + executor as `lucid hub <cmd>`: what works typed works scripted.
        const r = await this.exec(parseHubCommand(tokenize(text)));
        this.#status = `:${text} → ${truncateToWidth(JSON.stringify(r) ?? "ok", 120)}`;
      } else if (kind === "space-rename") {
        // p.lane carries the SPACE id here; a refused rename (HubOpError) surfaces verbatim in the catch.
        this.#spaces.rename(p.lane, text);
        this.#status = `space renamed → ${text}`;
      } else if (kind === "wl-add") {
        // Same audited whitelist route the GUI settings panel drives (P-NETWL.2). IP/CIDR-looking
        // input files as an ip entry; anything else is a domain pattern. Internal zone, standing.
        const isIp = /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(text);
        await this.#post("/api/whitelist", { kind: isIp ? "ip" : "domain", pattern: text, zone: "internal", scope: "always" });
        this.#status = `whitelisted ${text} (internal, standing) - revocable here with D`;
      } else {
        // A fresh turn begins: NOW the previous turn's thinking/tool trail makes way.
        this.#live[p.lane] = { text: "", thinking: "", tools: [], working: true };
        await this.#post("/api/fleet/prompt", { laneId: p.lane, text });
        this.#status = "prompt sent";
      }
    } catch (err) {
      this.#status = kind === "command" ? `:${text} → ${err instanceof HubOpError ? err.code : "error"}: ${err instanceof Error ? err.message : String(err)}` : kind === "space-rename" ? `rename refused: ${err instanceof Error ? err.message : String(err)}` : `${kind === "wl-add" ? "whitelist" : "prompt"} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    await this.refresh();
  }

  // -- P-TUI.4: Agents deck verbs (existing fleet routes only; approvals are NEVER answered here) --

  /** The Agents table's selected lane, from the same /api/fleet/status rows the deck renders. */
  #selectedLane(): Record<string, unknown> | null {
    const lanes = arr(this.#data?.fleet.lanes).map(rec);
    return lanes[Math.min(this.#selected, lanes.length - 1)] ?? null;
  }

  /** `c`: cancel the selected lane's RUNNING turn - /api/fleet/cancel, the GUI's own route. */
  async #cancelLane(): Promise<void> {
    const lane = this.#selectedLane();
    if (!lane) { this.#status = "no agent selected - n spawns one"; this.#ui.requestRender(); return; }
    try {
      const r = rec(await this.#post("/api/fleet/cancel", { laneId: str(lane.id) }));
      this.#status = r.ok === false ? `cancel refused: ${str(r.reason ?? "no running turn")}` : `cancelled ${str(lane.name)}'s turn`;
    } catch (err) {
      this.#status = `cancel failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    await this.refresh();
  }

  /** `x` on Agents: dismiss the selected STOPPED lane (/api/fleet/remove, never force). A live lane
   *  is refused client-side with the way out named; the engine's own refusal surfaces verbatim too. */
  async #dismissLane(): Promise<void> {
    const lane = this.#selectedLane();
    if (!lane) { this.#status = "no agent selected"; this.#ui.requestRender(); return; }
    const status = str(lane.status);
    if (!["done", "error", "stopped"].includes(status)) {
      this.#status = `x dismisses a STOPPED agent - ${str(lane.name)} is ${status} (c cancels its turn)`;
      this.#ui.requestRender();
      return;
    }
    try {
      const r = rec(await this.#post("/api/fleet/remove", { laneId: str(lane.id) }));
      if (r.ok === false) { this.#status = `dismiss refused: ${str(r.reason ?? "engine said no")}`; }
      else { this.#status = `dismissed ${str(lane.name)}`; this.#selected = Math.max(0, this.#selected - 1); }
    } catch (err) {
      this.#status = `dismiss failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    await this.refresh();
  }

  // -- P-TUI.4: Spaces deck verbs over the P-TUI.3 model (hub_spaces.ts). Every refusal is the
  // model's own HubOpError message, surfaced verbatim - never a local guess. ------------------------

  /** The deck's rows: a projection of the model (pane count from each tree, focus from `active`). */
  #spaceRows(): HubSpace[] {
    return this.#spaces.spaces.map((s) => ({ id: s.id, name: s.name, panes: leaves(s.tree).length, focused: s.id === this.#spaces.active }));
  }

  #selectedSpace(): HubSpace | null {
    const rows = this.#spaceRows();
    return rows[Math.min(this.#selected, rows.length - 1)] ?? null;
  }

  #createSpace(): void {
    try {
      this.#status = `created space ${this.#spaces.create().name}`;
    } catch (err) {
      this.#status = `new space refused: ${err instanceof Error ? err.message : String(err)}`;
    }
    this.#ui.requestRender();
  }

  #focusSpace(): void {
    const sp = this.#selectedSpace();
    if (!sp) { this.#status = "no space selected - n creates one"; this.#ui.requestRender(); return; }
    try {
      this.#spaces.focus(sp.id);
      this.#status = `space → ${sp.name}`;
    } catch (err) {
      this.#status = `focus refused: ${err instanceof Error ? err.message : String(err)}`;
    }
    this.#ui.requestRender();
  }

  #startRenameSpace(): void {
    const sp = this.#selectedSpace();
    if (!sp) { this.#status = "no space selected - n creates one"; this.#ui.requestRender(); return; }
    this.#promptKind = "space-rename";
    this.#prompt = { lane: sp.id, text: sp.name }; // lane carries the space id through the composer
    this.#ui.requestRender();
  }

  #closeSpace(): void {
    const sp = this.#selectedSpace();
    if (!sp) { this.#status = "no space selected"; this.#ui.requestRender(); return; }
    try {
      this.#spaces.close(sp.id);
      this.#status = `closed space ${sp.name}`;
      this.#selected = Math.max(0, this.#selected - 1);
    } catch (err) {
      this.#status = `close refused: ${err instanceof Error ? err.message : String(err)}`;
    }
    this.#ui.requestRender();
  }

  /** Remove the selected whitelist entry - standing access leaves the ledger the moment you say so. */
  async #removeWhitelistEntry(): Promise<void> {
    const entries = (this.#data?.whitelist ?? []).map(rec);
    const e = entries[Math.min(this.#selected, entries.length - 1)];
    if (!e) { this.#status = "no entry selected"; this.#ui.requestRender(); return; }
    await this.#post("/api/whitelist/remove", { id: str(e.id) });
    this.#status = `removed ${str(e.pattern)} from the whitelist`;
    await this.refresh();
  }

  /** Flip allow-all. The engine clamps under managed policy (managedLocked), so this can only ever
   *  TIGHTEN when an enterprise ceiling says so - the refusal comes back in the posture we redraw. */
  async #togglePosture(): Promise<void> {
    const cur = this.#data?.posture.allowAll === true;
    await this.#post("/api/whitelist/posture", { allowAll: !cur });
    this.#status = `allow-all ${!cur ? "ON" : "OFF (whitelist-only egress)"}`;
    await this.refresh();
  }

  /** Security deck actions: the SAME audited human-only routes the GUI panel calls. Approve releases
   *  one quarantined call (ADR-0019 C); dismiss acknowledges without releasing. Nothing local. */
  async #judge(approve: boolean): Promise<void> {
    if (this.#focusedDeck() !== "security" || !this.#data) return;
    const q = quarantineOf(this.#data);
    const blk = q[Math.min(this.#selected, q.length - 1)];
    if (!blk) { this.#status = "no block selected"; this.#ui.requestRender(); return; }
    await this.#post(approve ? "/api/security/approve" : "/api/security/dismiss", { id: str(blk.id) });
    this.#status = `${approve ? "approved" : "dismissed"} ${str(blk.tool)} block ${str(blk.id)}`;
    await this.refresh();
  }

  // -- render ------------------------------------------------------------------------------------

  #badge(id: DeckId): string {
    // The Spaces count is client-side state - it shows even before the first engine answer.
    if (id === "spaces") return TXT_3(String(this.#spaceRows().length));
    if (!this.#data) return "";
    if (id === "security") { const n = quarantineOf(this.#data).length; return n ? RED(String(n)) : GREEN("0"); }
    if (id === "fleet") return TXT_3(String(arr(this.#data.fleet.lanes).length));
    if (id === "sessions") return TXT_3(String(this.#data.sessions.length));
    if (id === "agents") return TXT_3(String(arr(this.#data.fleet.lanes).length));
    return "";
  }

  #sidebarBlock(h: number): string[] {
    const w = SIDEBAR_W;
    const visible = new Set(leaves(this.#tree).map((l) => l.deck));
    const focused = this.#focusedDeck();
    const rows: string[] = ["", TXT_3.bold("  DECKS"), "", ...DECKS.map((d) => {
      const badge = this.#badge(d.id);
      const label = `  ${TXT_3(d.key)}  ${d.icon} ${d.title}`;
      const pad = Math.max(1, w - 2 - Bun.stringWidth(label) - Bun.stringWidth(badge));
      const line = `${label}${" ".repeat(pad)}${badge}`;
      if (d.id === focused) return ACCENT("▎") + TXT.bold(line.slice(1));
      if (visible.has(d.id)) return " " + TXT(line.slice(1));
      return " " + TXT_3(line.slice(1));
    })];
    const body = [...rows, ...Array(Math.max(0, h - rows.length)).fill("")].slice(0, h);
    return body.map((line) => {
      // Exact track width or the whole pane column to the right shears (invariant 11's spirit).
      const cut = truncateToWidth(line, w - 1);
      const pad = Math.max(0, w - 1 - Bun.stringWidth(cut));
      return cut + " ".repeat(pad) + LINE("│");
    });
  }

  /** The `?` overlay: every key, grouped, centered in the pane region. Rendered INSTEAD of the
   *  panes (never spliced into styled rows), so it is always legible at any size. */
  #helpBlock(w: number, h: number): string[] {
    const entries: [string, string][] = [
      ["Panes", ""],
      ["  |", "split the focused pane to the right"],
      ["  -", "split the focused pane downward"],
      ["  tab / shift+tab", "move focus around the ring"],
      ["  z", "zoom the focused pane (again to unzoom)"],
      ["  x", "close the focused pane"],
      ["  b", "show / hide the deck sidebar"],
      ["", ""],
      ["Decks", ""],
      ["  1-9, 0", "put that deck in the focused pane"],
      ["  j / k or ↓ / ↑", "move the row selection"],
      ["", ""],
      ["Agents (decks 3 + 9)", ""],
      ["  n", "spawn a NEW agent (on the Fleet deck)"],
      ["  ⏎ on Fleet/Agents", "attach the selected agent into this pane"],
      ["  ⏎ on Sessions", "resume that session as a live agent"],
      ["  c on Agents", "cancel the selected agent's turn"],
      ["  x on Agents", "dismiss a STOPPED agent (done/error/stopped)"],
      ["  ⏎ on an agent", "type a prompt · ⏎ sends · esc cancels"],
      ["  y / s / d", "answer a parked ask: once / session / deny"],
      ["  m", "switch the agent's model (picker)"],
      ["", ""],
      ["Knowledge (deck 8)", ""],
      ["  ⏎", "read the selected page"],
      ["  /", "filter pages as you type"],
      ["  c", "switch the active knowledge graph"],
      ["", ""],
      ["Spaces (deck 0)", ""],
      ["  ⏎", "focus the selected space"],
      ["  n", "create a space · r rename it (inline)"],
      ["  x", "close it (the last space refuses)"],
      ["", ""],
      ["Security", ""],
      ["  a", "approve the selected block (audited release)"],
      ["  i", "dismiss the selected block (acknowledge only)"],
      ["", ""],
      ["General", ""],
      ["  r", "refresh now (auto-refreshes every 2s)"],
      ["  ?", "this help · any key closes it"],
      ["  q", "quit (a hub-spawned engine exits too)"],
    ];
    const boxW = Math.min(64, w - 4);
    const lines = entries.map(([k, v]) =>
      v === "" ? ACCENT_2.bold(` ${k}`) : `  ${CYAN(k.padEnd(18))}${TXT(truncateToWidth(v, boxW - 24))}`,
    );
    const inner = fitBlock([""].concat(lines.map((l) => l), [""]), boxW - 2, Math.min(lines.length + 2, h - 2));
    const top = ACCENT("╭─") + ACCENT_2.bold(" ◆ LUCID HUB · keys ") + ACCENT("─".repeat(Math.max(0, boxW - 23)) + "╮");
    const box = [top, ...inner.map((l) => ACCENT("│") + l + ACCENT("│")), ACCENT("╰" + "─".repeat(boxW - 2) + "╯")];
    const padTop = Math.max(0, Math.floor((h - box.length) / 2));
    const padLeft = " ".repeat(Math.max(0, Math.floor((w - boxW) / 2)));
    const out = [...Array(padTop).fill(""), ...box.map((l) => padLeft + l)];
    return fitBlock(out, w, h).map((l) => l); // exact geometry like any pane region
  }

  /** A live AGENT pane: settled transcript, then the CURRENT turn streaming in (token deltas, tool
   *  activity, thinking tail) from /api/fleet/watch; model + status + spinner in the title; a
   *  composer line at the bottom in prompt mode. */
  #agentPane(leaf: PaneLeaf, w: number, h: number, focused: boolean): string[] {
    const lane = arr(this.#data?.fleet.lanes).map(rec).find((l) => str(l.id) === leaf.lane);
    const status = lane ? str(lane.status) : "gone";
    const live = this.#live[leaf.lane ?? ""];
    const working = status === "working" || !!live?.working;
    const turns = this.#transcripts[leaf.lane ?? ""] ?? [];
    const innerW = w - 4;
    const lines: string[] = [];
    for (const turn of turns) {
      lines.push("");
      for (const [j, row] of wrapText(turn.text, innerW - 2).entries())
        lines.push(turn.role === "user" ? (j === 0 ? `› ${row}` : `  ${row}`) : `  ${row}`);
    }
    // The turn's reasoning trail: thinking + tool activity while working, and STILL there after the
    // reply settles (a labeled dim block above the incoming text), until the next prompt resets it.
    if (live && (live.text || live.thinking || live.tools.length || working)) {
      lines.push("");
      if (live.thinking) {
        if (live.trimmed) lines.push("\u0001  … the earliest thinking exceeded the 500k retention cap and was trimmed");
        lines.push(`\u0001thinking${working && !live.text ? "" : " (this turn)"}`);
        for (const row of wrapText(live.thinking, innerW - 4)) lines.push(`\u0001  ${row}`);
      }
      if (live.tools.length) lines.push(`\u0001⚙ ${live.tools.join(" · ")}`);
      if (live.text) for (const row of wrapText(live.text, innerW - 2)) lines.push(`  ${row}`);
      else if (working) lines.push("\u0001… the model is working");
    }
    // The parked ask, impossible to miss: what the agent wants, and the keys that answer it.
    const ask = lane ? rec(lane.pendingApproval) : {};
    if (ask.summary) {
      lines.push("");
      lines.push(`\u0002⚠ approval needed (${str(ask.kind)})`);
      for (const row of wrapText(str(ask.summary), innerW - 4)) lines.push(`\u0002  ${row}`);
      lines.push(`\u0002  y allow once · s allow for this session · d deny`);
    }
    if (lines.length === 0) lines.push("", status === "gone" ? "  this agent is gone (x closes the pane)" : "  no turns yet - press ⏎ and type to talk to this agent");
    const promptOn = focused && this.#prompt?.lane === leaf.lane;
    const bodyH = h - 2 - (promptOn ? 1 : 0);
    // Scrollback: #scroll is the offset UP from the live tail (0 = follow). Clamped so the top of
    // history is the ceiling; a "more below" marker replaces the last row while scrolled.
    const maxScroll = Math.max(0, lines.length - bodyH);
    const scroll = focused ? Math.min(this.#scroll, maxScroll) : 0;
    if (focused) this.#scroll = scroll; // keep the clamp, or k past the top would bank phantom offset
    const end = lines.length - scroll;
    const tail = lines.slice(Math.max(0, end - bodyH), end);
    if (scroll > 0 && tail.length > 0) tail[tail.length - 1] = `\u0001── ${scroll} line${scroll === 1 ? "" : "s"} below · j follows down · G jumps to live ──`;
    const body = fitBlock(tail, innerW, bodyH);
    const paint = focused ? CYAN : LINE;
    const spin = working ? ` ${"⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[Math.floor(Date.now() / 200) % 10]}` : "";
    // The lane's own model, else the engine's current default - the pane always names its model.
    const model = (lane && str(lane.model)) || modelCatalog(this.#data?.config ?? []).current;
    const title = ` ▶ ${leaf.laneName ?? leaf.lane}${model && model !== "?" ? ` · ${model}` : ""} · ${status}${spin}${lane && rec(lane.pendingApproval).summary ? " · WAITING" : ""} `;
    const titlePainted = focused ? ACCENT_2.bold(title) : TXT_3(title);
    const dashes = Math.max(0, w - 2 - Bun.stringWidth(title) - 1);
    const top = paint("╭─") + titlePainted + paint("─".repeat(dashes) + "╮");
    const bottom = paint("╰" + "─".repeat(Math.max(0, w - 2)) + "╯");
    const rows = body.map((line) => {
      // \u0001 marks a dim "activity" row (thinking / tools / working note); stripped before paint.
      const painted = line.startsWith("\u0002") ? AMBER(line.slice(1)) : line.startsWith("\u0001") ? TXT_3(line.slice(1)) : line.startsWith("›") ? ACCENT_2(line) : TXT(line);
      return paint("│") + " " + painted + " " + paint("│");
    });
    if (promptOn) {
      const p = truncateToWidth(this.#prompt!.text, innerW - 4);
      const promptRow = ACCENT.bold("› ") + TXT(p) + ACCENT("▌") + " ".repeat(Math.max(0, innerW - 3 - Bun.stringWidth(p)));
      rows.push(paint("│") + " " + promptRow + " " + paint("│"));
    }
    return [top, ...rows, bottom];
  }
  /** The model picker, centered like help: catalog rows, current pick marked, selection inverted. */
  #pickerBlock(w: number, h: number): string[] {
    const pk = this.#picker!;
    const current = modelCatalog(this.#data?.config ?? []).current;
    const matches = pickerMatches(pk);
    pk.sel = Math.min(pk.sel, Math.max(0, matches.length - 1));
    const boxW = Math.min(70, w - 4);
    const maxRows = Math.max(3, h - 8);
    const from = Math.max(0, Math.min(pk.sel - Math.floor(maxRows / 2), matches.length - maxRows));
    const slice = matches.slice(from, from + maxRows);
    const pad4 = (plain: string) => plain + " ".repeat(Math.max(0, boxW - 4 - Bun.stringWidth(plain)));
    const filterRow = ACCENT.bold("› ") + TXT(truncateToWidth(pk.filter, boxW - 8)) + ACCENT("▌") + " ".repeat(Math.max(0, boxW - 7 - Bun.stringWidth(truncateToWidth(pk.filter, boxW - 8))));
    const rows = slice.length
      ? slice.map((m, i) => {
          const idx = from + i;
          const mark = m.value === current || m.name === current ? " ●" : "";
          const padded = pad4(truncateToWidth(` ${m.name}${mark}`, boxW - 4));
          return idx === pk.sel ? chalk.inverse(TXT(padded)) : TXT_3(padded);
        })
      : [TXT_3(pad4("  nothing matches - backspace edits, esc clears"))];
    const title = pk.busy ? " switching model… " : " type to filter · ⇅ move · ⏎ apply · esc ";
    const top = ACCENT("╭─") + ACCENT_2.bold(title) + ACCENT("─".repeat(Math.max(0, boxW - 3 - Bun.stringWidth(title))) + "╮");
    const box = [top, ACCENT("│") + " " + filterRow + " " + ACCENT("│"), ...rows.map((r) => ACCENT("│") + " " + r + " " + ACCENT("│")), ACCENT("╰" + "─".repeat(boxW - 2) + "╯")];
    const padTop = Math.max(0, Math.floor((h - box.length) / 2));
    const padLeft = " ".repeat(Math.max(0, Math.floor((w - boxW) / 2)));
    return fitBlock([...Array(padTop).fill(""), ...box.map((l) => padLeft + l)], w, h);
  }


  #pane(leaf: PaneLeaf, w: number, h: number, focused: boolean): string[] {
    if (leaf.deck === "agent") return this.#agentPane(leaf, w, h, focused);
    const deck = leaf.deck;
    const meta = DECKS.find((d) => d.id === deck)!;
    const badge = deck === "security" ? quarantineOf(this.#data).length : deck === "fleet" || deck === "agents" ? arr(this.#data?.fleet.lanes).length : deck === "sessions" ? this.#data?.sessions.length ?? 0 : deck === "spaces" ? this.#spaceRows().length : 0;
    const body = fitBlock(deckLines(deck, this.#data, w - 4, focused ? this.#selected : -1, this.#kgFilter, deck === "spaces" ? this.#spaceRows() : []), w - 4, h - 2);
    const paint = focused ? CYAN : LINE;
    const title = ` ${meta.icon} ${meta.title}${badge ? ` · ${badge}` : ""} `;
    const titlePainted = focused ? ACCENT_2.bold(title) : TXT_3(title);
    const dashes = Math.max(0, w - 2 - Bun.stringWidth(title) - 1);
    const top = paint("╭─") + titlePainted + paint("─".repeat(dashes) + "╮");
    const bottom = paint("╰" + "─".repeat(Math.max(0, w - 2)) + "╯");
    const rows = body.map((line) => {
      const isSel = focused && line.startsWith("▸");
      const painted = isSel ? chalk.inverse(TXT(line)) : colorizeRow(deck, line);
      return paint("│") + " " + painted + " " + paint("│");
    });
    return [top, ...rows, bottom];
  }

  #renderNode(node: PaneNode, w: number, h: number, ring: { i: number }): string[] {
    if (node.kind === "leaf") return this.#pane(node, w, h, ring.i++ === this.#focus);
    if (node.dir === "v") {
      const wa = Math.floor(w * (node.ratio ?? 0.5));
      const a = this.#renderNode(node.a, wa, h, ring);
      const b = this.#renderNode(node.b, w - wa, h, ring);
      return a.map((line, i) => line + (b[i] ?? ""));
    }
    const ha = Math.floor(h * (node.ratio ?? 0.5));
    return [...this.#renderNode(node.a, w, ha, ring), ...this.#renderNode(node.b, w, h - ha, ring)];
  }

  #topBar(width: number): string {
    const q = this.#data ? quarantineOf(this.#data).length : 0;
    // Everything that names THIS hub's engine lives in one labeled cluster on the left; the right
    // edge belongs to the alert alone. A bare ":5319" floating after a field of padding reads as
    // debris (operator report 2026-09-28), so the port never appears without its label.
    const brand =
      ACCENT.bold(" ◆ LUCID ") + TXT("HUB") +
      TXT_3(`  ·  engine 127.0.0.1:${this.#engine.port} · v${this.#engine.version}${this.#spawned ? " · spawned by hub" : ""}`);
    const right = q > 0 ? RED.bold(`⛨ ${q} blocked `) : "";
    // The spaces, tmux-window style: the active one bracketed in the focus color.
    const tabs = this.#spaces.spaces.map((s) => (s.id === this.#spaces.active ? CYAN.bold(`[${s.name}]`) : TXT_3(s.name))).join(" ");
    const brandCut = truncateToWidth(`${brand}  ${tabs}`, Math.max(0, width - Bun.stringWidth(right) - 1));
    const pad = Math.max(1, width - Bun.stringWidth(brandCut) - Bun.stringWidth(right));
    return brandCut + " ".repeat(pad) + right;
  }

  /** The fullscreen page reader: wrapped body, top-anchored scroll, LUCID-accent frame. */
  #readerBlock(w: number, h: number): string[] {
    const rd = this.#reader!;
    const innerW = Math.max(20, w - 6);
    const wrapped = rd.rows.flatMap((row) => (row === "" ? [""] : wrapText(row, innerW)));
    const maxScroll = Math.max(0, wrapped.length - (h - 2));
    this.#scroll = Math.min(this.#scroll, maxScroll);
    const view = wrapped.slice(this.#scroll, this.#scroll + h - 2);
    const pos = maxScroll > 0 ? ` · ${Math.round((this.#scroll / maxScroll) * 100)}%` : "";
    const title = ` ◈ ${truncateToWidth(rd.title, w - 30)}${pos} `;
    const top = ACCENT("╭─") + ACCENT_2.bold(title) + ACCENT("─".repeat(Math.max(0, w - 3 - Bun.stringWidth(title))) + "╮");
    const bottom = ACCENT("╰" + "─".repeat(Math.max(0, w - 2)) + "╯");
    const rows = fitBlock(view, w - 4, h - 2).map((line) => ACCENT("│") + " " + TXT(line) + " " + ACCENT("│"));
    return [top, ...rows, bottom];
  }

  render(width: number): readonly string[] {
    const height = Math.max(10, this.#ui.terminal.rows);
    const bodyH = height - 2;
    const sidebarOn = this.#sidebar && width >= 72;
    const paneW = sidebarOn ? width - SIDEBAR_W : width;
    const tree: PaneNode = this.#zoom ? this.#focusedLeaf() : this.#tree;
    const ring = { i: this.#zoom ? this.#focus : 0 };
    const panes = this.#reader ? this.#readerBlock(paneW, bodyH) : this.#picker ? this.#pickerBlock(paneW, bodyH) : this.#help ? this.#helpBlock(paneW, bodyH) : this.#renderNode(tree, paneW, bodyH, ring);
    const body = sidebarOn ? this.#sidebarBlock(bodyH).map((s, i) => s + (panes[i] ?? "")) : panes;
    const rightPlain = `${this.#engine.flavor} engine · lucid hub `;
    const composing = this.#prompt && this.#promptKind === "wl-add"
      ? ` add host to whitelist: ${this.#prompt.text}▌  (⏎ save · esc cancel)`
      : this.#prompt && this.#promptKind === "kg-filter"
        ? ` filter pages: ${this.#prompt.text}▌  (live · ⏎ keep · esc clear)`
        : this.#prompt && this.#promptKind === "command"
          ? ` :${this.#prompt.text}▌  (⏎ run · esc cancel)`
          : this.#prompt && this.#promptKind === "space-rename"
            ? ` rename space: ${this.#prompt.text}▌  (⏎ save · esc cancel)`
          : "";
    const hint = this.#reader ? " j/k scroll · ctrl+u/d page · esc closes the page" : this.#help ? " any key closes help" : composing || ` ${DECK_HINTS[this.#prompt ? "prompting" : this.#focusedDeck()]} · ? help`;
    const leftPlain = truncateToWidth(composing || (this.#status ? ` ${this.#status}` : hint), Math.max(0, width - Bun.stringWidth(rightPlain) - 1));
    const pad = Math.max(1, width - Bun.stringWidth(leftPlain) - Bun.stringWidth(rightPlain));
    const statusBar = (this.#status ? AMBER(leftPlain) : TXT_3(leftPlain)) + " ".repeat(pad) + TXT_3(rightPlain);
    return [this.#topBar(width), ...body, statusBar];
  }
}

// ---- entry -------------------------------------------------------------------------------------

/** Find and PROVE an engine via the discovery seam; null when none verifies (fail-closed). */
export async function findEngine(env: Readonly<Record<string, string | undefined>>): Promise<EngineDiscovery | null> {
  for (const { discovery } of listDiscoveries(discoveryDir(env))) {
    if (await verifyDiscovery(discovery)) return discovery;
  }
  return null;
}

export interface AttachedEngine { engine: EngineDiscovery; spawned: boolean; child: Bun.Subprocess | null }

/** Attach to a running engine, or SPAWN a headless one and wait for its discovery file. The spawned
 *  child belongs to the hub: quit the hub, the engine goes with it (and removes its own file). */
export async function attachOrSpawnEngine(env: Readonly<Record<string, string | undefined>>): Promise<AttachedEngine | null> {
  const running = await findEngine(env);
  if (running) return { engine: running, spawned: false, child: null };
  const repo = join(import.meta.dir, "..", "..");
  const child = Bun.spawn([process.execPath, join(repo, "desktop", "dev.ts")], {
    cwd: repo,
    env: { ...env } as Record<string, string | undefined>,
    stdout: "ignore",
    stderr: "ignore",
  });
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const engine = await findEngine(env);
    if (engine) return { engine, spawned: true, child };
    if (child.exitCode !== null) break; // engine died (port busy, missing deps) - fail honestly
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 250);
    await promise;
  }
  try { child.kill(); } catch { /* already gone */ }
  return null;
}

/** `lucid hub` - attach or spawn, then run the pane multiplexer until quit. Headless = the same hub,
 *  control plane and all, with no terminal (an agent's or CI's hub); SIGTERM/SIGINT quit it cleanly. */
export async function runHubCli(env: Readonly<Record<string, string | undefined>> = process.env, opts: { headless?: boolean } = {}): Promise<number> {
  const attached = await attachOrSpawnEngine(env);
  if (!attached) {
    process.stderr.write("[lucid hub] no engine: none running, and spawning one failed (port busy or missing deps). Try `bun desktop/dev.ts` to see why.\n");
    return 1;
  }
  const dir = discoveryDir(env);
  const layoutFile = spacesPath(dir);
  const spaces = loadSpaces(layoutFile, (d) => DECKS.some((x) => x.id === d)) ?? new Spaces();
  spaces.onChange = () => { try { saveSpaces(layoutFile, spaces); } catch { /* layout is convenience, never fatal */ } };
  const tui = opts.headless ? null : new TUI(new ProcessTerminal());
  const ui: HubUi = tui ?? { requestRender() { /* no terminal */ }, terminal: { rows: 40 } };
  const component = new HubComponent(ui, attached.engine, { spawned: attached.spawned, spaces });
  const control = startHubControl({ dir, exec: (op) => component.exec(op) });
  const quit = () => component.quit();
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, quit);
  const overlay = tui?.showOverlay(component, { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0, fullscreen: true, mouseTracking: false });
  if (tui) { tui.setFocus(component); tui.start(); }
  else process.stdout.write(JSON.stringify({ hub: "ready", pid: process.pid, port: control.discovery.port, engine: attached.engine.port }) + "\n");
  try {
    await component.run();
  } finally {
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.off(sig, quit);
    control.stop();
    component.dispose();
    spaces.onChange();
    overlay?.hide();
    tui?.stop();
    if (attached.child) { try { attached.child.kill("SIGTERM"); } catch { /* gone */ } await attached.child.exited; }
  }
  return 0;
}
