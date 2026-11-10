// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0541; P-HERD.2 and P-HERD.3, ADR-0491 and ADR-0492): what a client's bytes meet BEFORE the
// hub keymap, in the Herd server. The prefix and its one action, the direct chords, resize mode,
// copy mode, the rename prompts, the live bindings (`prefix+?`) and divider drags live here; every
// other byte goes on to HubComponent.handleInput exactly as the classic hub would take it, so terminal
// mode (a composer) and navigate mode (the bare keys) are the component's own, unchanged.
//
// It also answers Herd's verbs (layouts, directional and cell-sized pane ops, move, rename) for the
// control plane and the `:` prompt, fills waiting layout slots as lanes appear, adds layouts to the
// palette, and draws its overlays over the frame the component rendered.
//
// The human-only keys (approvals) are not here and never reachable from here: the prefix table is a
// closed list of layout and navigation actions (keys.ts HERD_ACTIONS).

import chalk from "@oh-my-pi/pi-utils/chalk";
import { matchesKey, parseSgrMouse, truncateToWidth } from "@oh-my-pi/pi-tui";
import type { PaletteItem } from "../../../harness/launcher/hub_palette.ts";
import { dividerAt, HubOpError, type PaneDirection } from "../../../harness/launcher/hub_spaces.ts";
import { fitBlock, HUB_COLORS, paneRects, type HubComponent } from "../../../harness/launcher/hub_tui.ts";
import { CopyMode, type CopyRow } from "./copy_mode.ts";
import { bindingRows, PrefixKeys, type HerdAction, type KeysConfig, type KeysFile } from "./keys.ts";
import {
  applyLayout,
  fillSlots,
  nextLayoutName,
  parseLayoutCommand,
  runLayoutOp,
  type LayoutCaller,
  type LayoutHost,
  type LayoutLibrary,
} from "./layouts.ts";
import { parseHerdPaneCommand, runHerdPaneOp, type PaneRegion } from "./pane_verbs.ts";

const { ACCENT, ACCENT_2, CYAN, TXT, TXT_3, AMBER } = HUB_COLORS;

/** An action handler: a returned (or resolved) string goes to the status line; a HubOpError shows as
 *  "refused: ...". `client` is the attached client whose key it was. */
export type HerdActionFn = (client: number) => string | void | Promise<string | void>;

export interface HerdInputHost {
  readonly component: HubComponent;
  readonly library: LayoutLibrary;
  readonly keys: KeysFile;
  /** The size frames render at (the smallest attached terminal). */
  size(): { cols: number; rows: number };
  /** Detach the client whose key it was. */
  detach(client: number): void;
  /** Put `text` on the clipboard of that client's terminal (OSC 52, hub_client.ts). */
  yank(client: number, text: string): void;
  /** Hand bytes to the hub keymap (a press on a divider that turned out to be a click). */
  forward(data: string): void;
  /** Schedule a frame. */
  render(): void;
  /** The host has the Main pane (P-HERD.6): `main` in a layout is that pane, not a waiting one. */
  mainReady(): boolean;
}

/** Yanks past this many characters refuse: OSC 52 is meant for a selection, not a dump. */
export const MAX_YANK = 64 * 1024;

const RESIZE_HINT = "resize: h j k l move the divider one cell (H J K L five) · esc ends";
const COPY_HINT = "copy: h j k l w b move · / search · v select · y yank · q leaves";

export class HerdInput {
  readonly #host: HerdInputHost;
  readonly #prefix = new PrefixKeys();
  readonly #actions = new Map<HerdAction, HerdActionFn>();
  /** The layout the cycle key (or `layout apply`) last put on each tab. */
  readonly #cycled = new Map<string, string>();
  readonly #layouts: LayoutHost;
  #help = false;
  #resize = false;
  #copy: CopyMode | null = null;
  #prompt: { kind: "tab" | "space" | "pane"; target: string; text: string } | null = null;
  #drag: { tab: string; path: string; vertical: boolean; origin: number; at: number; last: number; w: number; h: number; press: string; moved: boolean } | null = null;

  constructor(host: HerdInputHost) {
    this.#host = host;
    const component = host.component;
    this.#layouts = {
      library: host.library,
      spaces: component.spaces,
      mainReady: () => host.mainReady(),
      lanes: () => (component.agentsPanel?.rows() ?? []).map((r) => ({ id: r.id, name: r.name })),
    };
    const sp = component.spaces;
    const dirs: [HerdAction, HerdAction, PaneDirection][] = [
      ["focus-left", "swap-left", "left"], ["focus-down", "swap-down", "down"], ["focus-up", "swap-up", "up"], ["focus-right", "swap-right", "right"],
    ];
    for (const [focus, swap, dir] of dirs) {
      this.register(focus, () => { runHerdPaneOp(sp, { op: "pane.focus.direction", dir }, this.#region()); });
      this.register(swap, () => { runHerdPaneOp(sp, { op: "pane.swap.direction", dir }, this.#region()); });
    }
    const tabKeys = ["tab-1", "tab-2", "tab-3", "tab-4", "tab-5", "tab-6", "tab-7", "tab-8", "tab-9"] as const satisfies readonly HerdAction[];
    for (const [i, action] of tabKeys.entries()) {
      this.register(action, () => {
        const tab = sp.current.tabs[i];
        if (!tab) return `this space has no tab ${i + 1}`;
        sp.focusTab(tab.id);
      });
    }
    const stepTab = (step: 1 | -1) => () => {
      const s = sp.current;
      const i = s.tabs.findIndex((t) => t.id === s.activeTab);
      return `tab → ${sp.focusTab(s.tabs[(i + step + s.tabs.length) % s.tabs.length]!.id).name}`;
    };
    this.register("new-tab", () => `tab → ${sp.createTab().name}`);
    this.register("split-right", () => { sp.split(undefined, "right"); });
    this.register("split-down", () => { sp.split(undefined, "down"); });
    this.register("zoom", () => { sp.zoom(); });
    this.register("close-pane", () => `closed ${sp.closePane().id}`);
    this.register("resize-mode", () => { this.#resize = true; return RESIZE_HINT; });
    this.register("copy-mode", () => this.#openCopy());
    this.register("rename-pane", () => {
      const { leaf } = sp.pane();
      return this.#ask({ kind: "pane", target: leaf.id, text: leaf.label ?? "" });
    });
    this.register("break-pane", () => {
      const r = sp.movePane(sp.pane().leaf.id, { newTab: true });
      return `${r.pane.id} → new tab ${r.tab.name}`;
    });
    this.register("next-tab", stepTab(1));
    this.register("prev-tab", stepTab(-1));
    this.register("rename-tab", () => this.#ask({ kind: "tab", target: sp.tab.id, text: sp.tab.name }));
    this.register("close-tab", () => `closed tab ${sp.closeTab().name}`);
    this.register("new-space", () => `space → ${sp.create().name}`);
    this.register("rename-space", () => this.#ask({ kind: "space", target: sp.current.id, text: sp.current.name }));
    this.register("close-space", () => `closed space ${sp.close().name}`);
    this.register("spaces-panel", () => { component.focusRail(); });
    this.register("palette", () => { component.openPalette(); });
    this.register("rail", () => { sp.setRail(!sp.rail); });
    this.register("cycle-layout", () => this.#cycle());
    this.register("detach", (client) => { host.detach(client); });
    this.register("help", () => { this.#help = true; });
  }

  /** Bind (or rebind) the handler of an action; the prefix table and hub-keys.json pick the keys. */
  register(action: HerdAction, fn: HerdActionFn): void {
    this.#actions.set(action, fn);
  }

  get keys(): KeysConfig {
    return this.#host.keys.current().cfg;
  }

  /** A client went away: a prefix it armed is dropped, and so is a drag. */
  forget(client: number): void {
    this.#prefix.forget(client);
    this.#drag = null;
  }

  #status(text: string): void {
    this.#host.component.setStatus(text);
  }

  #refused(e: unknown): void {
    if (e instanceof HubOpError) this.#status(`refused: ${e.message}`);
    else this.#status(`failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  /** The pane region as rendered at the current size: geometry is the renderer's, never a guess. */
  #region(): PaneRegion {
    const { cols, rows } = this.#host.size();
    this.#host.component.render(cols);
    const g = this.#host.component.geometry;
    return g ? { w: cols - g.left, h: g.height } : { w: cols, h: Math.max(1, rows - 3) };
  }

  /** Raw bytes from client `client`: true when Herd took them, false to hand them to the hub keymap. */
  input(data: string, client: number): boolean {
    if (data.startsWith("\x1b[<")) return this.#mouse(data);
    if (this.#help) { this.#help = false; this.#status(""); return true; }
    if (this.#copy) { this.#copyKey(data, client); return true; }
    if (this.#resize) { this.#resizeKey(data); return true; }
    if (this.#prompt) { this.#promptKey(data); return true; }
    const { cfg, changed } = this.#host.keys.current();
    if (changed && cfg.problems.length) this.#status(`hub-keys.json: ${cfg.problems[0]}${cfg.problems.length > 1 ? ` (+${cfg.problems.length - 1} more; ${cfg.prefix} ? lists them)` : ""}`);
    const out = this.#prefix.feed(data, client, cfg);
    switch (out.kind) {
      case "pass": return false;
      case "armed": this.#status(`${cfg.prefix}: one action key · ${cfg.prefix} ? lists them · esc cancels`); return true;
      case "cancel": this.#status(""); return true;
      case "unbound": this.#status(`${cfg.prefix} ${out.key} is not bound (${cfg.prefix} ? lists the keys)`); return true;
      case "action": this.#run(out.action, client); return true;
    }
  }

  #run(action: HerdAction, client: number): void {
    const fn = this.#actions.get(action);
    if (!fn) { this.#status(`${action} is not available in this Herd build`); return; }
    try {
      const r = fn(client);
      if (r instanceof Promise) {
        r.then((s) => { this.#status(typeof s === "string" ? s : ""); this.#host.render(); }, (e: unknown) => { this.#refused(e); this.#host.render(); });
      } else this.#status(typeof r === "string" ? r : "");
    } catch (e) {
      if (!(e instanceof HubOpError)) throw e;
      this.#refused(e);
    }
    this.#host.render();
  }

  #ask(p: { kind: "tab" | "space" | "pane"; target: string; text: string }): string {
    this.#prompt = p;
    return this.#promptLine();
  }

  #promptLine(): string {
    const p = this.#prompt!;
    return `name the ${p.kind}: ${p.text}▌  (⏎ save${p.kind === "pane" ? ", empty clears" : ""} · esc cancel)`;
  }

  #promptKey(data: string): void {
    const p = this.#prompt!;
    if (matchesKey(data, "escape")) { this.#prompt = null; this.#status(""); return; }
    if (matchesKey(data, "backspace")) { p.text = p.text.slice(0, -1); this.#status(this.#promptLine()); return; }
    for (const ch of data) {
      if (ch === "\r" || ch === "\n") {
        this.#prompt = null;
        const sp = this.#host.component.spaces;
        try {
          if (p.kind === "tab") this.#status(`tab renamed → ${sp.renameTab(p.target, p.text).name}`);
          else if (p.kind === "space") this.#status(`space renamed → ${sp.rename(p.target, p.text).name}`);
          else {
            const leaf = sp.renamePane(p.target, p.text.trim() ? p.text : null);
            this.#status(leaf.label ? `${leaf.id} named ${leaf.label}` : `${leaf.id} name cleared`);
          }
        } catch (e) {
          if (!(e instanceof HubOpError)) throw e;
          this.#refused(e);
        }
        return;
      }
      if (ch >= " " && ch !== "\u007f") p.text += ch;
    }
    this.#status(this.#promptLine());
  }

  #resizeKey(data: string): void {
    if (matchesKey(data, "escape") || data === "q" || data === "r" || data === "\r" || data === "\n" || data === "\r\n" || matchesKey(data, "enter")) { this.#resize = false; this.#status(""); return; }
    const lower = data.toLowerCase();
    const dir = lower === "h" || matchesKey(data, "left") ? "L" : lower === "l" || matchesKey(data, "right") ? "R" : lower === "k" || matchesKey(data, "up") ? "U" : lower === "j" || matchesKey(data, "down") ? "D" : null;
    if (dir === null) return;
    const cells = data.length === 1 && data !== lower ? 5 : 1;
    try {
      const region = this.#region();
      const r = this.#host.component.spaces.resizeCells(undefined, dir, cells, region.w, region.h);
      this.#status(`${r.cells} of ${r.size} cells (ratio ${r.ratio}) · ${RESIZE_HINT}`);
    } catch (e) {
      if (!(e instanceof HubOpError)) throw e;
      this.#refused(e);
    }
  }

  /** Freeze the focused pane's text at its own width, the way it is on screen. */
  #openCopy(): string {
    const sp = this.#host.component.spaces;
    const { tab, index, leaf } = sp.pane();
    const region = this.#region();
    const rect = tab.zoom ? { w: region.w } : paneRects(tab.tree, region.w, region.h)[index] ?? { w: region.w };
    const text = this.#host.component.paneText(leaf.id, Math.max(20, rect.w), 1000);
    this.#copy = new CopyMode(leaf.id, text.title, text.lines);
    return COPY_HINT;
  }

  #copyKey(data: string, client: number): void {
    const copy = this.#copy!;
    const out = copy.feed(data, Math.max(1, this.#host.size().rows - 5));
    if (out.kind === "exit") { this.#copy = null; this.#status(""); return; }
    if (out.kind === "yank") {
      this.#copy = null;
      if (!out.text) { this.#status("nothing to yank on that line"); return; }
      if (out.text.length > MAX_YANK) { this.#status(`the selection is ${out.text.length} characters; a yank holds at most ${MAX_YANK}`); return; }
      this.#host.yank(client, out.text);
      const lines = out.text.split("\n").length;
      this.#status(`yanked ${lines} line${lines === 1 ? "" : "s"} (${out.text.length} characters) to the clipboard`);
      return;
    }
    this.#status(copy.typing !== null ? `search: /${copy.typing}▌  (⏎ find · esc cancel)` : copy.note || COPY_HINT);
  }

  #mouse(data: string): boolean {
    // A modal Herd surface owns the screen: a pointer event never edits or closes it.
    if (this.#help || this.#copy || this.#resize || this.#prompt) return true;
    if (!this.keys.mouse) return false;
    const ev = parseSgrMouse(data);
    if (!ev) return false;
    const sp = this.#host.component.spaces;
    const drag = this.#drag;
    if (drag) {
      const g = this.#host.component.geometry;
      const pos = drag.vertical ? ev.col - (g?.left ?? 0) : ev.row - (g?.top ?? 1);
      if (ev.release) {
        this.#drag = null;
        if (!drag.moved) { this.#host.forward(drag.press); return false; } // a click on a border, not a drag
        return true;
      }
      if (ev.motion && (ev.button & 3) === 0) {
        const cells = drag.at + (pos - drag.origin);
        if (cells !== drag.last) {
          try {
            const r = sp.setSplitCells(drag.tab, drag.path, cells, drag.w, drag.h);
            drag.last = cells;
            drag.moved = true;
            this.#status(`divider at ${r.cells} of ${r.size} cells (ratio ${r.ratio})`);
          } catch (e) {
            if (!(e instanceof HubOpError)) throw e;
            this.#drag = null; // the split went away under the pointer
          }
          this.#host.render();
        }
      }
      return true;
    }
    if (!ev.leftClick) return false;
    const g = this.#host.component.geometry;
    if (!g || g.panes.length === 0 || sp.tab.zoom) return false;
    const w = this.#host.size().cols - g.left;
    const x = ev.col - g.left;
    const y = ev.row - g.top;
    if (x < 0 || y < 0 || x >= w || y >= g.height) return false;
    const box = dividerAt(sp.tab.tree, w, g.height, x, y);
    if (!box) return false;
    const vertical = box.dir === "v";
    this.#drag = { tab: sp.tab.id, path: box.path, vertical, origin: vertical ? x : y, at: box.at, last: box.at, w, h: g.height, press: data, moved: false };
    return true;
  }

  #cycle(): string {
    const sp = this.#host.component.spaces;
    const names = this.#host.library.names();
    const name = nextLayoutName(names, this.#cycled.get(sp.tab.id));
    if (name === null) return "no layouts to cycle";
    const r = applyLayout(this.#layouts, sp, name, sp.tab.id);
    this.#cycled.set(r.tab, name);
    return `layout → ${name} (${names.indexOf(name) + 1} of ${names.length})${r.waiting ? ` · ${r.waiting} pane${r.waiting === 1 ? "" : "s"} waiting for an agent` : ""}`;
  }

  /** Herd's verbs for the control plane (`control`) and the `:` prompt (`prompt`); undefined hands
   *  argv on. Synchronous refusals throw HubOpError, as the parser's do. */
  command(argv: readonly string[], from: LayoutCaller): Promise<unknown> | undefined {
    const layout = parseLayoutCommand(argv);
    if (layout) {
      const r = runLayoutOp(this.#layouts, layout, from);
      if (layout.op === "layout.apply") {
        const { tab } = this.#host.component.spaces.findTab(layout.tab);
        this.#cycled.set(tab.id, layout.name);
      }
      this.#host.render();
      return Promise.resolve(r);
    }
    const pane = parseHerdPaneCommand(argv);
    if (pane) {
      const r = runHerdPaneOp(this.#host.component.spaces, pane, this.#region());
      this.#host.render();
      return Promise.resolve(r);
    }
    return undefined;
  }

  /** A fresh lane snapshot arrived: waiting layout panes whose lane is there now fill. */
  fillSlots(): void {
    if (fillSlots(this.#host.component.spaces, this.#layouts.lanes(), this.#host.mainReady())) this.#host.render();
  }

  /** Every layout as a palette row (kind "host"): Enter applies it to the tab on screen. */
  paletteItems(): PaletteItem[] {
    return this.#host.library.names().map((name) => ({ kind: "host", id: `layout:${name}`, label: `layout ${name}`, hint: "apply to this tab", icon: "▤" }));
  }

  paletteAct(id: string): void {
    if (!id.startsWith("layout:")) return;
    const sp = this.#host.component.spaces;
    try {
      const r = applyLayout(this.#layouts, sp, id.slice("layout:".length), sp.tab.id);
      this.#cycled.set(r.tab, r.applied);
      this.#status(`layout → ${r.applied}${r.waiting ? ` · ${r.waiting} waiting for an agent` : ""}`);
    } catch (e) {
      if (!(e instanceof HubOpError)) throw e;
      this.#refused(e);
    }
  }

  /** The frame with Herd's overlay (bindings or copy mode) over the pane body; else unchanged. */
  decorate(frame: readonly string[], cols: number): readonly string[] {
    if (!this.#help && !this.#copy) return frame;
    const h = Math.max(1, frame.length - 3); // top bar, body, strip, status line
    const block = this.#help ? this.#helpBlock(cols, h) : this.#copyBlock(this.#copy!, cols, h);
    const out = [...frame];
    for (let i = 0; i < h; i++) out[1 + i] = block[i] ?? "";
    return out;
  }

  #box(title: string, rows: readonly string[], w: number, h: number): string[] {
    const boxW = Math.max(10, w);
    const top = ACCENT("╭─") + ACCENT_2.bold(title) + ACCENT("─".repeat(Math.max(0, boxW - 3 - Bun.stringWidth(title))) + "╮");
    const body = rows.slice(0, Math.max(0, h - 2));
    while (body.length < h - 2) body.push("");
    const lines = body.map((r) => {
      const cut = truncateToWidth(r, boxW - 4);
      return ACCENT("│") + " " + cut + " ".repeat(Math.max(0, boxW - 4 - Bun.stringWidth(cut))) + " " + ACCENT("│");
    });
    return [top, ...lines, ACCENT("╰" + "─".repeat(Math.max(0, boxW - 2)) + "╯")];
  }

  /** `prefix+?`: the ACTIVE table, read from hub-keys.json now, and what the file got wrong. */
  #helpBlock(w: number, h: number): string[] {
    const cfg = this.keys;
    const rows = bindingRows(cfg);
    const keyW = Math.min(26, Math.max(...rows.map((r) => Bun.stringWidth(r.keys))) + 2);
    const cell = (r: (typeof rows)[number]): string => {
      const k = truncateToWidth(r.keys, keyW - 1);
      return (r.keys === "(unbound)" ? TXT_3(k) : CYAN(k)) + " ".repeat(Math.max(1, keyW - Bun.stringWidth(k))) + TXT(r.help);
    };
    const inner = w - 4;
    const room = h - 2 - Math.min(cfg.problems.length, 4) - (cfg.problems.length ? 1 : 0);
    const twoCols = rows.length > room && inner >= 2 * (keyW + 30);
    const lines: string[] = [];
    if (twoCols) {
      const colW = Math.floor(inner / 2);
      const half = Math.ceil(rows.length / 2);
      for (let i = 0; i < half; i++) {
        const left = truncateToWidth(cell(rows[i]!), colW - 1);
        const right = rows[i + half] ? cell(rows[i + half]!) : "";
        lines.push(left + " ".repeat(Math.max(1, colW - Bun.stringWidth(left))) + right);
      }
    } else lines.push(...rows.map(cell));
    if (cfg.problems.length) {
      lines.push("");
      for (const p of cfg.problems.slice(0, 4)) lines.push(AMBER(`hub-keys.json: ${p}`));
    }
    return fitBlock(this.#box(` ◆ keys · prefix ${cfg.prefix} · from hub-keys.json · any key closes `, lines, w, h), w, h);
  }

  #copyBlock(copy: CopyMode, w: number, h: number): string[] {
    const paint = (row: CopyRow): string => {
      const chars = Array.from(row.text);
      if (row.cursor !== null) while (chars.length <= row.cursor) chars.push(" ");
      let out = "";
      for (const [i, ch] of chars.entries()) {
        const sel = row.sel !== null && i >= row.sel[0] && i < row.sel[1];
        out += i === row.cursor ? chalk.inverse(CYAN(ch)) : sel ? chalk.inverse(TXT(ch)) : TXT(ch);
      }
      return out;
    };
    const title = ` ◈ copy mode · ${truncateToWidth(copy.title, Math.max(10, w - 60))} · v select · y yank · / search · q leaves `;
    return fitBlock(this.#box(title, copy.view(h - 2).map(paint), w, h), w, h);
  }
}
