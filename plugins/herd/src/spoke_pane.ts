// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0541; P-HERD.7b, ADR-0559): A SPOKE TASK IN A PANE. An agent pane bound to a
// `spokes/<node>:<task>` ref (the same `pane rebind <pane> agent <ref>` verb, the same rail ⏎ and the
// same prefix+a jump that bind a pane to one of this engine's lanes) is drawn here, through the hub's
// host-lanes seam (hub_tui.ts HubHostLanes), as a READ-ONLY view of that task:
//
//   header    the spoke's label, the task's name, its state and turns, from the machine poll
//             (ADR-0549); `stale` with the hub's reason while the spokes machine is not connected
//   body      the task's journal through POST /api/remote-spokes/recall {node, task} on this server's
//             own engine, which scans every entry fail-closed first (desktop/remote_spokes.ts
//             gateRecall): a flagged entry arrives withheld and shows as one note. Newest at the
//             bottom, at most the last 200 entries and 64 KiB of text. Recalled again only when the
//             task's turns or state change, at most once every 5 s, never while a recall is in flight.
//   ⏎         one line, sent as a follow-up through `agent prompt spokes/<node>:<task> <text>`, the
//             very verb a script runs (the same fresh agent_blocked check and the hub's refusals)
//
// Recalled text is UNTRUSTED: escape sequences are removed whole and every other control or format
// character but the newline is stripped before it reaches a terminal; nothing in it is executed or
// interpreted. There are no approve, deny or answer keys: a decision is a person's, in the IDE's
// Remote Spokes panel (ADR-0549 item 4), so those keys are refused `human_only` and send nothing.

import { matchesKey, truncateToWidth } from "@oh-my-pi/pi-tui";
import { HubOpError, type Spaces } from "../../../harness/launcher/hub_spaces.ts";
import { parseHubCommand, type HubOp } from "../../../harness/launcher/hub_tmux_verbs.ts";
import { fitBlock, HUB_COLORS, wrapText, type HubHostLanes } from "../../../harness/launcher/hub_tui.ts";
import { spokeTaskRef, SPOKES_MACHINE, spokeText, type MachineLane, type MachineSet } from "./engines.ts";

const { ACCENT, ACCENT_2, AMBER, CYAN, LINE, TXT, TXT_3 } = HUB_COLORS;

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** A spoke pane's lane ref starts with this. */
const PREFIX = `${SPOKES_MACHINE}/`;
/** The most journal entries one pane keeps (the engine's own recall cap is the same 200). */
export const MAX_PANE_ENTRIES = 200;
/** The most recalled text one pane keeps, in UTF-8 bytes. */
export const MAX_PANE_TEXT = 64 * 1024;
/** The least time between two recalls of one task. */
export const SPOKE_RECALL_MIN_MS = 5000;
const DECIDE = "approvals and every decision on a spoke are a person's, in the IDE's Remote Spokes panel";
const WAITING = "waiting on a person's approval: decide it in the IDE's Remote Spokes panel";

/** Recalled journal text made safe to draw: escape sequences removed whole, then every control or
 *  format character but the newline (C0, DEL, C1, bidi and zero-width marks, line separators). A tab
 *  becomes a space. */
export function spokeBody(v: unknown): string {
  return Bun.stripANSI(str(v)).replace(/\t/g, " ").replace(/(?!\n)[\p{Cc}\p{Cf}\u2028\u2029]/gu, "");
}

/** One recalled entry as the pane keeps it. `withheld`: the engine's scanner flagged it; its text
 *  never left the engine. `trimmed`: only its newest bytes fit the pane's text budget. */
export interface SpokeEntry { seq: number; kind: string; suspicious: boolean; withheld: boolean; text: string; trimmed: boolean }

/** The `entries` of a recall reply, terminal-safe and bounded: the newest MAX_PANE_ENTRIES, then the
 *  newest MAX_PANE_TEXT bytes of text. `omitted` counts what the engine and this bound left out. */
export function paneEntries(raw: unknown, engineOmitted: number): { entries: SpokeEntry[]; omitted: number } {
  const all = Array.isArray(raw) ? raw : [];
  const recent = all.slice(-MAX_PANE_ENTRIES);
  let omitted = Math.max(0, engineOmitted) + (all.length - recent.length);
  let budget = MAX_PANE_TEXT;
  const out: SpokeEntry[] = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    if (budget <= 0) { omitted += i + 1; break; }
    const e = typeof recent[i] === "object" && recent[i] !== null ? (recent[i] as Record<string, unknown>) : {};
    const seq = typeof e.seq === "number" && Number.isSafeInteger(e.seq) ? e.seq : -1;
    if (e.trust === "quarantined" || e.kind === "withheld") {
      out.push({ seq, kind: "", suspicious: false, withheld: true, text: "", trimmed: false });
      continue;
    }
    const text = spokeBody(e.text);
    const bytes = Buffer.byteLength(text);
    // Cut at a byte offset; a code point split there decodes to U+FFFD, which is dropped.
    const kept = bytes <= budget ? text : Buffer.from(text).subarray(bytes - budget).toString("utf8").replace(/^\uFFFD+/, "");
    budget -= Buffer.byteLength(kept);
    out.push({ seq, kind: spokeText(e.kind) || "?", suspicious: e.trust === "suspicious", withheld: false, text: kept, trimmed: kept.length < text.length });
  }
  return { entries: out.reverse(), omitted };
}

/** The body rows of a spoke pane before scrolling. A leading \u0001 marks a dim row and \u0002 an
 *  amber one (stripped before paint); recalled text is sanitized, so it can never carry either. */
export function spokeRows(v: { task: MachineLane | undefined; entries: readonly SpokeEntry[]; omitted: number; recalled: boolean; error: string; down: string }, innerW: number): string[] {
  const lines: string[] = [];
  const note = (mark: string, text: string) => { for (const row of wrapText(text, innerW)) lines.push(mark + row); };
  if (v.down) note("\u0002", v.down);
  if (v.task?.taskState === "awaiting_approval") note("\u0002", `⚠ ${WAITING}; nothing is decided from here`);
  if (!v.task) note("\u0001", "this task is not in the last listing (closed, or not listed yet)");
  if (v.error) note("\u0001", v.error);
  if (v.omitted > 0) lines.push(`\u0001… ${v.omitted} earlier entr${v.omitted === 1 ? "y" : "ies"} not shown`);
  for (const e of v.entries) {
    lines.push("");
    if (e.withheld) { lines.push(`\u0001#${e.seq} withheld by the scanner`); continue; }
    lines.push(`\u0001#${e.seq} ${e.kind}${e.suspicious ? " (suspicious)" : ""}${e.trimmed ? " (earliest text cut)" : ""}`);
    for (const row of wrapText(e.text, Math.max(1, innerW - 2))) lines.push(`  ${row}`);
  }
  if (v.entries.length === 0) lines.push("", v.recalled ? "\u0001no journal entries yet" : "\u0001recalling…");
  return lines;
}

/** One error or reason on one line, terminal-safe. */
const oneLine = (e: unknown): string => spokeBody(e instanceof HubOpError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim();

export interface SpokePaneDeps {
  machines: Pick<MachineSet, "spokeLanes" | "spokesConn" | "spokeRecall">;
  /** The control verbs: a typed line goes to `agent prompt spokes/<node>:<task> <text>` here. */
  run(argv: readonly string[]): Promise<unknown>;
  /** Something a pane shows changed. */
  changed(): void;
  now?: () => number;
}

interface PaneState {
  entries: SpokeEntry[];
  omitted: number;
  /** `<turns>|<state>` when the shown entries were recalled; null until a recall succeeds. */
  recalledKey: string | null;
  /** When the last recall started (ms), or null. */
  lastAt: number | null;
  inFlight: boolean;
  error: string;
  notice: string;
  /** The task row last seen in the listing: the header survives the task dropping out of it. */
  last: MachineLane | undefined;
  scroll: number;
}

export class SpokePanes implements HubHostLanes {
  readonly #deps: SpokePaneDeps;
  readonly #now: () => number;
  readonly #panes = new Map<string, PaneState>();
  #composer: { lane: string; text: string } | null = null;

  constructor(deps: SpokePaneDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  owns(lane: string): boolean {
    return lane.startsWith(PREFIX);
  }

  #pane(lane: string): PaneState {
    let p = this.#panes.get(lane);
    if (!p) {
      p = { entries: [], omitted: 0, recalledKey: null, lastAt: null, inFlight: false, error: "", notice: "", last: undefined, scroll: 0 };
      this.#panes.set(lane, p);
    }
    return p;
  }

  #task(lane: string): MachineLane | undefined {
    const t = this.#deps.machines.spokeLanes().find((l) => l.id === lane);
    if (t) this.#pane(lane).last = t;
    return t;
  }

  /** The spoke panes open anywhere right now: recall the ones whose task changed since their last
   *  recall (the 5 s floor and one recall in flight per task), and forget the closed ones. Resolves
   *  once the recalls it started have landed. */
  sync(lanes: readonly string[]): Promise<void> {
    const open = new Set(lanes.filter((l) => this.owns(l)));
    for (const lane of [...this.#panes.keys()]) if (!open.has(lane)) this.#panes.delete(lane);
    if (this.#composer && !open.has(this.#composer.lane)) this.#composer = null; // its pane closed
    const conn = this.#deps.machines.spokesConn();
    const started: Promise<void>[] = [];
    for (const lane of open) {
      const p = this.#pane(lane);
      const t = this.#task(lane);
      // A hub that is not connected keeps the last content; the next listing brings the recall back.
      if (!t || p.inFlight || conn?.state !== "connected") continue;
      const key = `${str(t.turns)}|${str(t.taskState)}`;
      if (key === p.recalledKey) continue;
      if (p.lastAt !== null && this.#now() - p.lastAt < SPOKE_RECALL_MIN_MS) continue;
      started.push(this.#recall(lane, p, key));
    }
    return Promise.all(started).then(() => {});
  }

  async #recall(lane: string, p: PaneState, key: string): Promise<void> {
    p.inFlight = true;
    p.lastAt = this.#now();
    try {
      const { node, task } = spokeTaskRef(lane.slice(PREFIX.length));
      const view = await this.#deps.machines.spokeRecall(node, task);
      const bounded = paneEntries(view.entries, typeof view.omitted === "number" ? view.omitted : 0);
      p.entries = bounded.entries;
      p.omitted = bounded.omitted;
      p.recalledKey = key;
      p.error = "";
    } catch (e) {
      p.error = `recall failed: ${oneLine(e)}`;
    } finally {
      p.inFlight = false;
      this.#deps.changed();
    }
  }

  async #send(lane: string, text: string): Promise<void> {
    const p = this.#pane(lane);
    p.notice = "sending the follow-up…";
    this.#deps.changed();
    try {
      await this.#deps.run(["agent", "prompt", lane, text]);
      p.notice = "follow-up sent";
    } catch (e) {
      p.notice = oneLine(e);
    }
    this.#deps.changed();
  }

  // -- HubHostLanes -------------------------------------------------------------------------------

  modal(): boolean {
    return this.#composer !== null;
  }

  hint(lane: string): string {
    const c = this.#composer;
    if (c) return `follow up ${truncateToWidth(str(this.#task(c.lane)?.name ?? this.#panes.get(c.lane)?.last?.name) || "the spoke task", 32)}: ⏎ sends · esc cancels`;
    const p = this.#pane(lane);
    if (p.notice) return p.notice;
    if (this.#task(lane)?.taskState === "awaiting_approval") return WAITING;
    return "⏎ follow up · j/k scroll · decisions stay in the IDE's Remote Spokes panel";
  }

  input(lane: string, data: string, enter: boolean): boolean {
    const c = this.#composer;
    if (c) {
      if (matchesKey(data, "escape")) { this.#composer = null; return true; }
      if (matchesKey(data, "backspace")) { c.text = c.text.slice(0, -1); return true; }
      // A pasted chunk with a newline submits what came before it; an empty enter keeps the composer.
      for (const ch of data) {
        if (ch === "\r" || ch === "\n") {
          const text = c.text.trim();
          if (!text) continue;
          this.#composer = null;
          void this.#send(c.lane, text);
          return true;
        }
        if (ch >= " " && ch !== "\u007f") c.text += ch;
      }
      return true;
    }
    const p = this.#pane(lane);
    p.notice = "";
    if (enter) {
      if (this.#task(lane)?.taskState === "awaiting_approval") { p.notice = `${WAITING}; a follow-up waits until then`; return true; }
      this.#composer = { lane, text: "" };
      p.scroll = 0;
      return true;
    }
    if (["y", "s", "d", "a", "i"].includes(data)) { p.notice = `human_only: ${DECIDE}; nothing was sent`; return true; }
    if (data === "c" || data === "m" || data === "M") { p.notice = "not_supported: cancel, close and the model stay with the IDE's Remote Spokes panel"; return true; }
    if (data === "j" || matchesKey(data, "down")) { p.scroll = Math.max(0, p.scroll - 1); return true; }
    if (data === "k" || matchesKey(data, "up")) { p.scroll++; return true; }
    if (matchesKey(data, "ctrl+u")) { p.scroll += 10; return true; }
    if (matchesKey(data, "ctrl+d")) { p.scroll = Math.max(0, p.scroll - 10); return true; }
    if (data === "G") { p.scroll = 0; return true; }
    return false;
  }

  pane(lane: string, w: number, h: number, focused: boolean): string[] {
    const p = this.#pane(lane);
    const task = this.#task(lane);
    const shown = task ?? p.last;
    const conn = this.#deps.machines.spokesConn();
    const stale = conn?.state !== "connected";
    const down = !conn ? "no spokes machine on this server (machine add spokes)" : stale ? `Remote Spokes hub ${conn.state}${conn.error ? `: ${oneLine(conn.error)}` : ""}; showing the last content` : "";
    const innerW = Math.max(8, w - 4);
    const composing = this.#composer?.lane === lane && focused;
    const bodyH = Math.max(0, h - 2 - (composing ? 1 : 0));
    const lines = spokeRows({ task, entries: p.entries, omitted: p.omitted, recalled: p.recalledKey !== null, error: p.error, down }, innerW);
    const maxScroll = Math.max(0, lines.length - bodyH);
    const scroll = focused ? Math.min(p.scroll, maxScroll) : 0;
    if (focused) p.scroll = scroll; // keep the clamp, or k past the top banks phantom offset
    const end = lines.length - scroll;
    const tail = lines.slice(Math.max(0, end - bodyH), end);
    if (scroll > 0 && tail.length > 0) tail[tail.length - 1] = `\u0001── ${scroll} line${scroll === 1 ? "" : "s"} below · j follows down · G jumps to the newest ──`;
    const body = fitBlock(tail, innerW, bodyH);
    const paint = focused ? CYAN : LINE;
    const turns = typeof shown?.turns === "number" ? shown.turns : 0;
    const title = ` ▶ ${SPOKES_MACHINE} · ${str(shown?.spoke) || "?"} · ${str(shown?.name) || lane.slice(PREFIX.length)} · ${str(shown?.taskState) || "unknown"} · ${turns} turn${turns === 1 ? "" : "s"}${p.inFlight ? " · recalling" : ""}${stale ? " · stale" : ""} `;
    const cut = truncateToWidth(title, Math.max(1, w - 4));
    const top = paint("╭─") + (focused ? ACCENT_2.bold(cut) : TXT_3(cut)) + paint("─".repeat(Math.max(0, w - 3 - Bun.stringWidth(cut))) + "╮");
    const bottom = paint("╰" + "─".repeat(Math.max(0, w - 2)) + "╯");
    const rows = body.map((line) => {
      const painted = line.startsWith("\u0002") ? AMBER(line.slice(1)) : line.startsWith("\u0001") || stale ? TXT_3(line.replace(/^\u0001/, "")) : TXT(line);
      return paint("│") + " " + painted + " " + paint("│");
    });
    if (composing) {
      const t = truncateToWidth(this.#composer?.text ?? "", Math.max(1, innerW - 4));
      rows.push(paint("│") + " " + ACCENT.bold("› ") + TXT(t) + ACCENT("▌") + " ".repeat(Math.max(0, innerW - 3 - Bun.stringWidth(t))) + " " + paint("│"));
    }
    return [top, ...rows, bottom];
  }
}

/** The control verbs Herd answers for spoke panes ahead of the hub parser: `pane rebind [-t <pane>]
 *  agent spokes/<node>:<task>` binds a pane to a task in the last listing (the hub's own rebind looks
 *  in this engine's lanes only), and send-keys into a spoke pane is refused (a follow-up is `agent
 *  prompt`). Undefined for everything else. */
export function spokePaneCommand(argv: readonly string[], spaces: Spaces, lanes: () => readonly MachineLane[]): Promise<unknown> | undefined {
  if (argv[0] !== "pane" && argv[0] !== "send-keys") return undefined;
  let op: HubOp;
  try { op = parseHubCommand(argv); } catch { return undefined; } // the hub parser answers its own usage
  if (op.op === "pane.rebind" && op.deck === "agent" && op.lane?.startsWith(PREFIX)) {
    const lane = op.lane;
    spokeTaskRef(lane.slice(PREFIX.length));
    const task = lanes().find((l) => l.id === lane);
    if (!task) throw new HubOpError("not_found", `no spoke task "${lane}" in the last listing; see \`agent list --machine ${SPOKES_MACHINE}\``);
    return Promise.resolve(spaces.rebind(op.target, "agent", { id: lane, name: str(task.name) || lane }));
  }
  if (op.op === "pane.keys" && spaces.pane(op.target).leaf.lane?.startsWith(PREFIX)) {
    throw new HubOpError("not_supported", `send-keys types into this engine's agent panes; a spoke task is followed up with \`agent prompt ${SPOKES_MACHINE}/<node>:<task> <text>\` (or ⏎ in its pane)`);
  }
  return undefined;
}
