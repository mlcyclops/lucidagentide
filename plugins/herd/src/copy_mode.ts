// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0541; P-HERD.3, ADR-0492 item 5): COPY MODE. `prefix+[` freezes the focused pane's text
// (the pane as the hub renders it, frame removed: HubComponent.paneText) and hands the keys to this
// cursor until `q` or `esc`:
//
//   h j k l / arrows   move           w b        next / previous word
//   0 $                line start/end g G        top / bottom
//   ctrl+u ctrl+d      half a page    pageUp pageDown   a page
//   /                  search (enter runs it, esc cancels)   n N   next / previous match
//   v                  start or drop a selection
//   y, enter           yank the selection (or the cursor's line) and leave
//
// A yank becomes OSC 52 bytes on the yanking client's own terminal (and the OS clipboard command when
// there is one, hub_client.ts). The text is what the pane shows, never more: decks keep secrets off
// screen already, so copy mode cannot reach one. Pure state: no I/O, no clock.

import { matchesKey } from "@oh-my-pi/pi-tui";

export interface CopyPoint { row: number; col: number }
export type CopyOutcome = { kind: "none" } | { kind: "exit" } | { kind: "yank"; text: string };
/** One visible row: text, the selected column span [from, to) and the cursor column, in code points. */
export interface CopyRow { text: string; sel: [number, number] | null; cursor: number | null }

const before = (a: CopyPoint, b: CopyPoint): boolean => a.row < b.row || (a.row === b.row && a.col <= b.col);
const isWord = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);

export class CopyMode {
  readonly lines: readonly string[][];
  cursor: CopyPoint;
  anchor: CopyPoint | null = null;
  /** The search being typed (null = not typing one). */
  typing: string | null = null;
  query = "";
  /** A short note for the status line ("no match for ..."). */
  note = "";
  #top = 0;

  constructor(readonly pane: string, readonly title: string, text: readonly string[]) {
    this.lines = (text.length ? text : [""]).map((l) => Array.from(l));
    this.cursor = { row: this.lines.length - 1, col: 0 };
  }

  #len(row: number): number {
    return this.lines[row]?.length ?? 0;
  }

  #clampCol(): void {
    this.cursor.col = Math.max(0, Math.min(this.cursor.col, Math.max(0, this.#len(this.cursor.row) - 1)));
  }

  #moveRows(n: number): void {
    this.cursor.row = Math.max(0, Math.min(this.lines.length - 1, this.cursor.row + n));
    this.#clampCol();
  }

  #word(step: 1 | -1): void {
    let { row, col } = this.cursor;
    const at = () => this.lines[row]?.[col];
    const advance = (): boolean => {
      col += step;
      if (col >= 0 && col < this.#len(row)) return true;
      if (step === 1 ? row >= this.lines.length - 1 : row <= 0) { col -= step; return false; }
      row += step;
      col = step === 1 ? 0 : Math.max(0, this.#len(row) - 1);
      return true;
    };
    if (step === 1) {
      // Off the current word, then over the gap, to the next word's first character.
      const start = row;
      while (isWord(at()) && advance() && row === start);
      while (!isWord(at()) && advance());
    } else {
      if (!advance()) return;
      while (!isWord(at()) && advance());
      while (col > 0 && isWord(this.lines[row]?.[col - 1])) col--;
    }
    this.cursor = { row, col };
  }

  /** Find `query` after (or before) the cursor, wrapping; case-blind. */
  #find(query: string, step: 1 | -1): void {
    const q = query.toLowerCase();
    if (!q) return;
    const n = this.lines.length;
    for (let i = 0; i <= n; i++) {
      const row = (((this.cursor.row + step * i) % n) + n) % n;
      const line = this.lines[row]!.join("").toLowerCase();
      // Code units vs code points: search the joined string, then map back to a code point column.
      let hit = -1;
      if (step === 1) hit = line.indexOf(q, i === 0 ? this.#unitOf(row, this.cursor.col + 1) : 0);
      else {
        const limit = i === 0 ? this.#unitOf(row, this.cursor.col) - 1 : line.length;
        hit = limit < 0 ? -1 : line.lastIndexOf(q, limit);
      }
      if (hit >= 0) {
        this.cursor = { row, col: Array.from(line.slice(0, hit)).length };
        this.note = "";
        return;
      }
    }
    this.note = `no match for "${query.slice(0, 40)}"`;
  }

  #unitOf(row: number, col: number): number {
    return this.lines[row]!.slice(0, col).join("").length;
  }

  /** The selection (or, with none, the cursor's line) as text; trailing blanks dropped per line. */
  selection(): string {
    if (!this.anchor) return this.lines[this.cursor.row]!.join("").trimEnd();
    const [a, b] = before(this.anchor, this.cursor) ? [this.anchor, this.cursor] : [this.cursor, this.anchor];
    const out: string[] = [];
    for (let r = a.row; r <= b.row; r++) {
      const line = this.lines[r]!;
      out.push(line.slice(r === a.row ? a.col : 0, r === b.row ? b.col + 1 : line.length).join("").trimEnd());
    }
    return out.join("\n");
  }

  /** One key. `viewH` is how many rows the view shows (paging moves by it). */
  feed(data: string, viewH: number): CopyOutcome {
    if (this.typing !== null) {
      if (matchesKey(data, "escape")) this.typing = null;
      else if (matchesKey(data, "backspace")) this.typing = this.typing.slice(0, -1);
      else if (data === "\r" || data === "\n" || data === "\r\n" || matchesKey(data, "enter")) {
        this.query = this.typing;
        this.typing = null;
        this.#find(this.query, 1);
      } else for (const ch of data) if (ch >= " " && ch !== "\u007f") this.typing += ch;
      return { kind: "none" };
    }
    this.note = "";
    const page = Math.max(1, viewH);
    if (data === "q") return { kind: "exit" };
    if (matchesKey(data, "escape")) {
      if (this.anchor) { this.anchor = null; return { kind: "none" }; }
      return { kind: "exit" };
    }
    if (data === "y" || data === "\r" || data === "\n" || data === "\r\n" || matchesKey(data, "enter")) return { kind: "yank", text: this.selection() };
    if (data === "h" || matchesKey(data, "left")) this.cursor.col = Math.max(0, this.cursor.col - 1);
    else if (data === "l" || matchesKey(data, "right")) { this.cursor.col++; this.#clampCol(); }
    else if (data === "j" || matchesKey(data, "down")) this.#moveRows(1);
    else if (data === "k" || matchesKey(data, "up")) this.#moveRows(-1);
    else if (data === "w") this.#word(1);
    else if (data === "b") this.#word(-1);
    else if (data === "0" || matchesKey(data, "home")) this.cursor.col = 0;
    else if (data === "$" || matchesKey(data, "end")) this.cursor.col = Math.max(0, this.#len(this.cursor.row) - 1);
    else if (data === "g") this.cursor = { row: 0, col: 0 };
    else if (data === "G") this.cursor = { row: this.lines.length - 1, col: 0 };
    else if (matchesKey(data, "ctrl+u")) this.#moveRows(-Math.ceil(page / 2));
    else if (matchesKey(data, "ctrl+d")) this.#moveRows(Math.ceil(page / 2));
    else if (matchesKey(data, "pageUp")) this.#moveRows(-page);
    else if (matchesKey(data, "pageDown")) this.#moveRows(page);
    else if (data === "/") this.typing = "";
    else if (data === "n") this.#find(this.query, 1);
    else if (data === "N") this.#find(this.query, -1);
    else if (data === "v") this.anchor = this.anchor ? null : { ...this.cursor };
    return { kind: "none" };
  }

  /** The `h` rows on screen, scrolled so the cursor stays visible. */
  view(h: number): CopyRow[] {
    const rows = Math.max(1, h);
    if (this.cursor.row < this.#top) this.#top = this.cursor.row;
    if (this.cursor.row >= this.#top + rows) this.#top = this.cursor.row - rows + 1;
    this.#top = Math.max(0, Math.min(this.#top, Math.max(0, this.lines.length - rows)));
    const [a, b] = !this.anchor ? [null, null] : before(this.anchor, this.cursor) ? [this.anchor, this.cursor] : [this.cursor, this.anchor];
    const out: CopyRow[] = [];
    for (let r = this.#top; r < Math.min(this.lines.length, this.#top + rows); r++) {
      const line = this.lines[r]!;
      const sel: [number, number] | null = a && b && r >= a.row && r <= b.row
        ? [r === a.row ? a.col : 0, r === b.row ? b.col + 1 : Math.max(line.length, 1)]
        : null;
      out.push({ text: line.join(""), sel, cursor: r === this.cursor.row ? this.cursor.col : null });
    }
    return out;
  }
}

/** The bytes that put `text` on the terminal's clipboard (OSC 52, clipboard selection "c"). */
export function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
}

/** The OS clipboard command a client runs beside OSC 52, or null. Over SSH the machine's clipboard is
 *  not the user's, so there OSC 52 alone carries the yank. */
export function clipboardCommand(platform: string, env: Readonly<Record<string, string | undefined>>): string[] | null {
  if (env.SSH_CONNECTION || env.SSH_TTY) return null;
  if (platform === "darwin") return ["pbcopy"];
  if (platform === "win32") return ["clip.exe"];
  if (env.WAYLAND_DISPLAY) return ["wl-copy"];
  if (env.DISPLAY) return ["xclip", "-selection", "clipboard"];
  return null;
}
