// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-TUI.1 (part) - `lucid hub`: the terminal hub as a PANE MULTIPLEXER (docs/TUI.md).
//
// The operator's model is herdr/tmux, not a single switched view: split the terminal into panes,
// put any capability deck in any pane, move focus between them, zoom one, close one. Every deck is
// a thin renderer over the SAME engine /api the desktop renderer calls (capability parity by
// construction); the engine is found and proven through the P-TUI.0 discovery seam (ADR-0416),
// never guessed. The gate stays in the engine's omp child - this client scans nothing, releases
// nothing by itself, and only calls the same human-only routes the GUI's Security panel calls.
//
// Layout is a binary split tree (pure, tested): leaves hold decks, splits are equal halves with a
// one-cell border. Keys: | split right, - split down, tab/shift+tab focus, z zoom, x close pane,
// 1-6 put a deck in the focused pane, j/k select rows, a approve / i dismiss (Security), r refresh,
// q quit. Resize-to-ratio, chat deck, palette and spawn-own-engine are the rest of P-TUI.1.

import chalk from "@oh-my-pi/pi-utils/chalk";
import { matchesKey, ProcessTerminal, TUI, truncateToWidth, type Component } from "@oh-my-pi/pi-tui";
import { discoveryDir, listDiscoveries, verifyDiscovery, type EngineDiscovery } from "../../desktop/engine_discovery.ts";

// ---- decks -------------------------------------------------------------------------------------

export type DeckId = "overview" | "security" | "fleet" | "sessions" | "audit" | "usage";
export const DECKS: readonly { id: DeckId; key: string; title: string }[] = [
  { id: "overview", key: "1", title: "Overview" },
  { id: "security", key: "2", title: "Security" },
  { id: "fleet", key: "3", title: "Fleet" },
  { id: "sessions", key: "4", title: "Sessions" },
  { id: "audit", key: "5", title: "Audit" },
  { id: "usage", key: "6", title: "Usage" },
];

/** The engine payload slices the decks draw. Fetched as unknown, narrowed field by field:
 *  a hub must render an older/newer engine's answer or say "?", never crash on it. */
export interface HubData {
  build: Record<string, unknown>;
  security: Record<string, unknown>;
  fleet: Record<string, unknown>;
  sessions: unknown[];
  audit: Record<string, unknown>;
  usage: Record<string, unknown>;
}

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "?");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Pure deck bodies: plain rows (no ANSI - the pane frame styles them), each row already truncated. */
export function deckLines(deck: DeckId, data: HubData | null, width: number, selected: number): string[] {
  if (!data) return ["loading from the engine…"];
  const w = Math.max(8, width);
  // One row is ONE physical line: engine strings (session titles, findings) can carry newlines,
  // tabs or stray controls, and a single leaked "\n" shears the whole pane geometry.
  const t = (s: string) => truncateToWidth(s.replace(/[\u0000-\u001f\u007f]+/g, " "), w);
  switch (deck) {
    case "overview": {
      const b = data.build;
      const live = rec(data.security.live);
      const lanes = arr(data.fleet.lanes);
      return [
        t(`engine   ${str(b.productName)} v${str(b.version)} (${str(b.flavor)}) on :${str(b.port)}`),
        t(`workspace ${str(b.workspace ?? b.dataRoot ?? "")}`),
        t(`blocks   ${arr(live.quarantined).length} quarantined · ${arr(live.dismissed).length} dismissed`),
        t(`fleet    ${lanes.length} lane${lanes.length === 1 ? "" : "s"}`),
        t(`sessions ${data.sessions.length} on disk`),
      ];
    }
    case "security": {
      const live = rec(data.security.live);
      const q = arr(live.quarantined).map(rec);
      if (q.length === 0) return ["no active blocks - the gate is quiet"];
      return q.map((blk, i) =>
        t(`${i === selected ? "▸" : " "} ${str(blk.at).slice(11, 19)} ${str(blk.tool)} [${str(blk.severity)}] ${str(blk.findings) || str(blk.reason)}`),
      );
    }
    case "fleet": {
      const lanes = arr(data.fleet.lanes).map(rec);
      if (lanes.length === 0) return ["no lanes - spawn one from the composer or /api/fleet/spawn"];
      return lanes.map((l) =>
        t(`${str(l.status).padEnd(8)} ${str(l.name)} · ${str(l.turns)} turn${str(l.turns) === "1" ? "" : "s"} · ${str(l.model)}${rec(l.pendingApproval).summary ? " · WAITING ON YOU" : ""}`),
      );
    }
    case "sessions": {
      const s = data.sessions.map(rec);
      if (s.length === 0) return ["no sessions yet"];
      return s.slice(0, 50).map((x) => t(`${str(x.updatedAt ?? x.mtime).slice(0, 16)} ${str(x.title ?? x.id)}`));
    }
    case "audit": {
      const events = arr(data.audit.events).map(rec);
      if (events.length === 0) return ["no security events recorded"];
      return events.slice(0, 100).map((e) => t(`${str(e.at ?? e.ts).slice(11, 19)} ${str(e.category)}/${str(e.type)} ${str(e.decision)}`));
    }
    case "usage": {
      const models = arr(data.usage.models ?? data.usage.rows).map(rec);
      if (models.length === 0) return ["no usage recorded yet"];
      return models.map((m) => t(`${str(m.model ?? m.id)} · $${str(m.costUsd ?? m.cost)} · ${str(m.turns ?? m.calls)} turns`));
    }
  }
}

// ---- pane tree (pure) --------------------------------------------------------------------------

export type PaneNode =
  | { kind: "leaf"; deck: DeckId }
  | { kind: "split"; dir: "h" | "v"; a: PaneNode; b: PaneNode };

/** In-order leaves - the focus ring. */
export function leaves(node: PaneNode): { kind: "leaf"; deck: DeckId }[] {
  return node.kind === "leaf" ? [node] : [...leaves(node.a), ...leaves(node.b)];
}

/** Replace the `index`-th leaf via `f` (split it, retitle it) - returns a new tree. */
export function mapLeaf(node: PaneNode, index: number, f: (leaf: { kind: "leaf"; deck: DeckId }) => PaneNode): PaneNode {
  let seen = 0;
  const walk = (n: PaneNode): PaneNode => {
    if (n.kind === "leaf") return seen++ === index ? f(n) : n;
    return { kind: "split", dir: n.dir, a: walk(n.a), b: walk(n.b) };
  };
  return walk(node);
}

/** Drop the `index`-th leaf; its sibling takes the whole region. Null = last pane, not removable. */
export function closeLeaf(node: PaneNode, index: number): PaneNode | null {
  if (node.kind === "leaf") return null;
  let seen = 0;
  const walk = (n: PaneNode): PaneNode | null => {
    if (n.kind === "leaf") return seen++ === index ? null : n;
    const a = walk(n.a);
    const b = walk(n.b);
    if (a === null) return b;
    if (b === null) return a;
    return { kind: "split", dir: n.dir, a, b };
  };
  return walk(node);
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

export class HubComponent implements Component {
  readonly #ui: HubUi;
  readonly #base: string;
  readonly #token: string;
  readonly #engine: EngineDiscovery;
  readonly #done = Promise.withResolvers<void>();
  #tree: PaneNode = { kind: "leaf", deck: "overview" };
  #focus = 0;
  #zoom = false;
  #selected = 0;
  #data: HubData | null = null;
  #status = "";
  #timer: NodeJS.Timeout | undefined;
  #disposed = false;

  constructor(ui: HubUi, engine: EngineDiscovery) {
    this.#ui = ui;
    this.#engine = engine;
    this.#base = `http://127.0.0.1:${engine.port}`;
    this.#token = engine.token;
  }

  run(): Promise<void> {
    void this.refresh();
    this.#timer = setInterval(() => void this.refresh(), POLL_MS);
    return this.#done.promise;
  }

  dispose(): void {
    this.#disposed = true;
    clearInterval(this.#timer);
  }

  async #get(path: string): Promise<unknown> {
    const res = await fetch(`${this.#base}${path}`, { headers: { "x-lucid-token": this.#token }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    const body = rec(await res.json());
    return body.data ?? body;
  }

  async #post(path: string, payload: Record<string, unknown>): Promise<void> {
    await fetch(`${this.#base}${path}`, {
      method: "POST",
      headers: { "x-lucid-token": this.#token, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
  }

  async refresh(): Promise<void> {
    try {
      const [build, security, fleet, sessions, audit, usage] = await Promise.all([
        this.#get("/api/build-info"), this.#get("/api/security"), this.#get("/api/fleet/status"),
        this.#get("/api/sessions"), this.#get("/api/audit"), this.#get("/api/usage"),
      ]);
      if (this.#disposed) return;
      this.#data = {
        build: rec(build), security: rec(security), fleet: rec(fleet),
        sessions: arr(rec(sessions).sessions ?? sessions), audit: rec(audit), usage: rec(usage),
      };
      this.#status = "";
    } catch (err) {
      this.#status = `engine unreachable: ${err instanceof Error ? err.message : String(err)}`;
    }
    this.#ui.requestRender();
  }

  #focusedDeck(): DeckId {
    return leaves(this.#tree)[this.#focus]?.deck ?? "overview";
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c") || data === "q") { this.#done.resolve(); return; }
    const count = leaves(this.#tree).length;
    if (data === "|") this.#tree = mapLeaf(this.#tree, this.#focus, (l) => ({ kind: "split", dir: "v", a: l, b: { kind: "leaf", deck: l.deck } }));
    else if (data === "-") this.#tree = mapLeaf(this.#tree, this.#focus, (l) => ({ kind: "split", dir: "h", a: l, b: { kind: "leaf", deck: l.deck } }));
    else if (matchesKey(data, "tab")) { this.#focus = (this.#focus + 1) % count; this.#selected = 0; }
    else if (matchesKey(data, "shift+tab")) { this.#focus = (this.#focus + count - 1) % count; this.#selected = 0; }
    else if (data === "z") this.#zoom = !this.#zoom;
    else if (data === "x") {
      const next = closeLeaf(this.#tree, this.#focus);
      if (next) { this.#tree = next; this.#focus = Math.min(this.#focus, leaves(next).length - 1); this.#zoom = false; }
      else this.#status = "last pane - q quits";
    } else if (DECKS.some((d) => d.key === data)) {
      const deck = DECKS.find((d) => d.key === data)!.id;
      this.#tree = mapLeaf(this.#tree, this.#focus, () => ({ kind: "leaf", deck }));
      this.#selected = 0;
    } else if (data === "j" || matchesKey(data, "down")) this.#selected++;
    else if (data === "k" || matchesKey(data, "up")) this.#selected = Math.max(0, this.#selected - 1);
    else if (data === "r") { void this.refresh(); return; }
    else if (data === "a" || data === "i") { void this.#judge(data === "a"); return; }
    this.#ui.requestRender();
  }

  /** Security deck actions: the SAME audited human-only routes the GUI panel calls. Approve releases
   *  one quarantined call (ADR-0019 C); dismiss acknowledges without releasing. Nothing local. */
  async #judge(approve: boolean): Promise<void> {
    if (this.#focusedDeck() !== "security" || !this.#data) return;
    const q = arr(rec(this.#data.security.live).quarantined).map(rec);
    const blk = q[Math.min(this.#selected, q.length - 1)];
    if (!blk) { this.#status = "no block selected"; this.#ui.requestRender(); return; }
    await this.#post(approve ? "/api/security/approve" : "/api/security/dismiss", { id: str(blk.id) });
    this.#status = `${approve ? "approved" : "dismissed"} ${str(blk.tool)} block ${str(blk.id)}`;
    await this.refresh();
  }

  // -- render ------------------------------------------------------------------------------------

  #pane(deck: DeckId, w: number, h: number, focused: boolean): string[] {
    const title = DECKS.find((d) => d.id === deck)!.title;
    const body = fitBlock(deckLines(deck, this.#data, w - 2, focused ? this.#selected : -1), w - 2, h - 2);
    const bar = truncateToWidth(` ${title} `, Math.max(0, w - 2));
    const top = `┌${bar}${"─".repeat(Math.max(0, w - 2 - Bun.stringWidth(bar)))}┐`;
    const bottom = `└${"─".repeat(Math.max(0, w - 2))}┘`;
    const paint = focused ? chalk.cyan : chalk.dim;
    return [paint(top), ...body.map((l) => paint("│") + l + paint("│")), paint(bottom)];
  }

  #renderNode(node: PaneNode, w: number, h: number, ring: { i: number }): string[] {
    if (node.kind === "leaf") return this.#pane(node.deck, w, h, ring.i++ === this.#focus);
    if (node.dir === "v") {
      const wa = Math.floor(w / 2);
      const a = this.#renderNode(node.a, wa, h, ring);
      const b = this.#renderNode(node.b, w - wa, h, ring);
      return a.map((line, i) => line + (b[i] ?? ""));
    }
    const ha = Math.floor(h / 2);
    return [...this.#renderNode(node.a, w, ha, ring), ...this.#renderNode(node.b, w, h - ha, ring)];
  }

  render(width: number): readonly string[] {
    const height = Math.max(8, this.#ui.terminal.rows);
    const bodyH = height - 1;
    const tree: PaneNode = this.#zoom ? { kind: "leaf", deck: this.#focusedDeck() } : this.#tree;
    const ring = { i: 0 };
    if (this.#zoom) ring.i = this.#focus; // the zoomed pane is the focused one
    const body = this.#renderNode(tree, width, bodyH, ring);
    const hints = "| split · - split down · tab focus · z zoom · x close · 1-6 deck · j/k select · a/i approve/dismiss · r refresh · q quit";
    // The right label (which engine this hub is attached to) always survives; the hints truncate.
    const rightPlain = `lucid hub → :${this.#engine.port} v${this.#engine.version} `;
    const leftPlain = truncateToWidth(this.#status ? ` ${this.#status}` : ` ${hints}`, Math.max(0, width - Bun.stringWidth(rightPlain) - 1));
    const pad = Math.max(1, width - Bun.stringWidth(leftPlain) - Bun.stringWidth(rightPlain));
    const left = this.#status ? chalk.yellow(leftPlain) : chalk.dim(leftPlain);
    return [...body, `${left}${" ".repeat(pad)}${chalk.dim(rightPlain)}`];
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

/** `lucid hub` - attach to the running engine and run the pane multiplexer until quit. */
export async function runHubCli(env: Readonly<Record<string, string | undefined>> = process.env): Promise<number> {
  const engine = await findEngine(env);
  if (!engine) {
    process.stderr.write(
      "[lucid hub] no running engine found (or none passed the nonce handshake).\n" +
      "Start one first - the desktop app, or: bun desktop/dev.ts - then rerun `lucid hub`.\n",
    );
    return 1;
  }
  const ui = new TUI(new ProcessTerminal());
  const component = new HubComponent(ui, engine);
  const overlay = ui.showOverlay(component, { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0, fullscreen: true, mouseTracking: false });
  ui.setFocus(component);
  ui.start();
  try {
    await component.run();
  } finally {
    component.dispose();
    overlay.hide();
    ui.stop();
  }
  return 0;
}
