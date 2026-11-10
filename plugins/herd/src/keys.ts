// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0535; P-HERD.3, ADR-0492): the KEY MODEL. Three modes, Herdr style:
//
//   terminal mode   a focused agent (or Main) composer: every key types, except the prefix
//   navigate mode   hub-owned focus: the classic bare keys (| - z x digits ...) stay as they are
//   prefix mode     the prefix (default ctrl+b), then ONE action, from either mode
//
// Herd sees a client's bytes before the hub keymap: the prefix and the direct chords are taken here,
// everything else goes on to HubComponent.handleInput untouched, so a composer never loses a
// printable keystroke to a hub action (direct chords need ctrl or alt for exactly that reason).
//
// `<data>/hub-keys.json` (0600) configures it:
//   { v: 1, prefix: "ctrl+b", bindings: { <action>: [<chord>, ...] }, direct: { <action>: [...] },
//     mouse: true, notify: { bell, desktop, sound } }
// over the closed HERD_ACTIONS list. An unknown action, an unparsable chord, a clash, a bad field: each
// is reported (status line, `prefix+?`) and skipped, never fatal. A missing file is the defaults.
// `lucid herd --default-keys` prints the defaults as a starting file.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { decodePrintableKey, matchesKey, type KeyId } from "@oh-my-pi/pi-tui";
import { isRecord } from "./events.ts";

export const HERD_ACTIONS = [
  "new-tab", "split-right", "split-down",
  "focus-left", "focus-down", "focus-up", "focus-right",
  "swap-left", "swap-down", "swap-up", "swap-right",
  "zoom", "close-pane", "resize-mode", "copy-mode", "rename-pane", "break-pane",
  "next-tab", "prev-tab", "tab-1", "tab-2", "tab-3", "tab-4", "tab-5", "tab-6", "tab-7", "tab-8", "tab-9",
  "rename-tab", "close-tab", "new-space", "rename-space", "close-space",
  "spaces-panel", "palette", "rail", "cycle-layout", "next", "detach", "help",
] as const;
export type HerdAction = (typeof HERD_ACTIONS)[number];

export const ACTION_HELP: Record<HerdAction, string> = {
  "new-tab": "new tab",
  "split-right": "split the pane to the right",
  "split-down": "split the pane down",
  "focus-left": "focus the pane to the left",
  "focus-down": "focus the pane below",
  "focus-up": "focus the pane above",
  "focus-right": "focus the pane to the right",
  "swap-left": "swap with the pane to the left",
  "swap-down": "swap with the pane below",
  "swap-up": "swap with the pane above",
  "swap-right": "swap with the pane to the right",
  zoom: "zoom the pane",
  "close-pane": "close the pane",
  "resize-mode": "resize mode: h j k l move the divider one cell, esc ends",
  "copy-mode": "copy mode: move, v select, y yank, / search, q leaves",
  "rename-pane": "name the pane",
  "break-pane": "move the pane to a new tab",
  "next-tab": "next tab",
  "prev-tab": "previous tab",
  "tab-1": "tab 1", "tab-2": "tab 2", "tab-3": "tab 3", "tab-4": "tab 4", "tab-5": "tab 5",
  "tab-6": "tab 6", "tab-7": "tab 7", "tab-8": "tab 8", "tab-9": "tab 9",
  "rename-tab": "rename the tab",
  "close-tab": "close the tab",
  "new-space": "new space",
  "rename-space": "rename the space",
  "close-space": "close the space",
  "spaces-panel": "the spaces panel on the rail",
  palette: "the palette",
  rail: "show or hide the rail",
  "cycle-layout": "next saved layout on this tab",
  next: "next lane waiting on you",
  detach: "detach this terminal (the server keeps running)",
  help: "these bindings",
};

export const DEFAULT_PREFIX = "ctrl+b";

/** The default prefix table, Herdr's where the hub has the action (ADR-0492 item 2). One change:
 *  the ADR binds L twice (swap right and cycle layouts); swap keeps h j k l symmetry and the layout
 *  cycle takes space, tmux's next-layout key. */
export const DEFAULT_BINDINGS: Record<HerdAction, string[]> = {
  "new-tab": ["c"], "split-right": ["v"], "split-down": ["-"],
  "focus-left": ["h"], "focus-down": ["j"], "focus-up": ["k"], "focus-right": ["l"],
  "swap-left": ["H"], "swap-down": ["J"], "swap-up": ["K"], "swap-right": ["L"],
  zoom: ["z"], "close-pane": ["x"], "resize-mode": ["r"], "copy-mode": ["["], "rename-pane": [","], "break-pane": ["!"],
  "next-tab": ["n"], "prev-tab": ["p"],
  "tab-1": ["1"], "tab-2": ["2"], "tab-3": ["3"], "tab-4": ["4"], "tab-5": ["5"], "tab-6": ["6"], "tab-7": ["7"], "tab-8": ["8"], "tab-9": ["9"],
  "rename-tab": ["T"], "close-tab": ["X"], "new-space": ["N"], "rename-space": ["W"], "close-space": ["D"],
  "spaces-panel": ["w"], palette: ["g"], rail: ["b"], "cycle-layout": ["space"], next: ["a"], detach: ["q"], help: ["?"],
};

export interface NotifySettings { bell: boolean; desktop: boolean; sound: boolean }
export interface KeyBinding { chord: string; action: HerdAction }

export interface KeysConfig {
  prefix: string;
  /** Effective chords per action under the prefix (after the file and its clashes). */
  bindings: Record<HerdAction, string[]>;
  /** Prefix-free chords (each with ctrl or alt). */
  direct: Partial<Record<HerdAction, string[]>>;
  prefixKeys: KeyBinding[];
  directKeys: KeyBinding[];
  /** False: the client leaves mouse reporting off, so the terminal selects text natively. */
  mouse: boolean;
  /** P-HERD.5 (ADR-0494): every notification is off until the user turns it on. */
  notify: NotifySettings;
  /** What the file got wrong, in plain words; each was skipped. */
  problems: string[];
}

const MODIFIERS = ["ctrl", "alt", "shift", "super"] as const;
const NAMED_KEYS: Record<string, string> = {
  escape: "escape", esc: "escape", enter: "enter", return: "enter", tab: "tab", space: "space",
  backspace: "backspace", delete: "delete", insert: "insert", home: "home", end: "end",
  pageup: "pageUp", pagedown: "pageDown", up: "up", down: "down", left: "left", right: "right",
  f1: "f1", f2: "f2", f3: "f3", f4: "f4", f5: "f5", f6: "f6", f7: "f7", f8: "f8", f9: "f9", f10: "f10", f11: "f11", f12: "f12",
};
const printableAscii = (s: string): boolean => s.length === 1 && s >= "!" && s <= "~";

/** A chord in normal form, or null. A single printable character keeps its case (`H` is shift+h as
 *  typed); otherwise modifiers (ctrl, alt, shift, super, in that order) and one key, lowercase:
 *  `ctrl+alt+h`, `space`, `pageUp`. */
export function parseChord(raw: string): string | null {
  const s = raw.trim();
  if (s.length === 1) return printableAscii(s) ? s : null;
  const parts = s.split("+");
  const key = parts.pop()!.toLowerCase();
  const mods = parts.map((p) => p.toLowerCase());
  if (!key || mods.some((m) => !MODIFIERS.some((x) => x === m)) || new Set(mods).size !== mods.length) return null;
  const base = Object.hasOwn(NAMED_KEYS, key) ? NAMED_KEYS[key]! : printableAscii(key) ? key : null;
  if (base === null) return null;
  return [...MODIFIERS.filter((m) => mods.includes(m)), base].join("+");
}

/** Does terminal input `data` carry `chord` (normal form)? */
export function chordMatches(data: string, chord: string): boolean {
  if (chord.length === 1) return data === chord || decodePrintableKey(data) === chord;
  return matchesKey(data, chord as KeyId); // parseChord's normal form is pi-tui's KeyId grammar
}

/** A chord that can never be typed text: it holds ctrl or alt. */
const nonText = (chord: string): boolean => chord.startsWith("ctrl+") || chord.startsWith("alt+");

const isAction = (s: string): s is HerdAction => HERD_ACTIONS.some((a) => a === s);

/** Chords from one `bindings`/`direct` entry; problems for the rest. */
function chordsOf(v: unknown, action: string, where: string, problems: string[]): string[] | null {
  const list = typeof v === "string" ? [v] : Array.isArray(v) ? v : null;
  if (list === null) { problems.push(`${where}.${action} is not a list of keys; skipped`); return null; }
  const out: string[] = [];
  for (const c of list) {
    const chord = typeof c === "string" ? parseChord(c) : null;
    if (chord === null) problems.push(`unreadable key ${JSON.stringify(c)} for ${action}; skipped`);
    else if (!out.includes(chord)) out.push(chord);
  }
  return out;
}

/** hub-keys.json text (null = no file) as the active key model. Never throws. */
export function parseKeysConfig(raw: string | null): KeysConfig {
  const problems: string[] = [];
  let o: Record<string, unknown> = {};
  if (raw !== null) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
    if (!isRecord(parsed)) problems.push("hub-keys.json is not a JSON object; the default keys are on");
    else if (parsed.v !== undefined && parsed.v !== 1) problems.push("hub-keys.json has an unknown version (v must be 1); the default keys are on");
    else o = parsed;
  }
  for (const k of Object.keys(o)) if (!["v", "prefix", "bindings", "direct", "mouse", "notify"].includes(k)) problems.push(`unknown field "${k.slice(0, 40)}" in hub-keys.json; skipped`);

  let prefix = DEFAULT_PREFIX;
  if (o.prefix !== undefined) {
    const p = typeof o.prefix === "string" ? parseChord(o.prefix) : null;
    if (p === null) problems.push(`unreadable prefix ${JSON.stringify(o.prefix)}; ctrl+b stays the prefix`);
    else if (!nonText(p)) problems.push(`the prefix ${p} has no ctrl or alt, so it would type into a composer; ctrl+b stays the prefix`);
    else prefix = p;
  }

  const userPrefix: Partial<Record<HerdAction, string[]>> = {};
  const direct: Partial<Record<HerdAction, string[]>> = {};
  for (const [field, into] of [["bindings", userPrefix], ["direct", direct]] as const) {
    const section = o[field];
    if (section === undefined) continue;
    if (!isRecord(section)) { problems.push(`${field} is not an object; skipped`); continue; }
    for (const [action, v] of Object.entries(section)) {
      if (!isAction(action)) { problems.push(`unknown action "${action.slice(0, 40)}" in ${field}; skipped`); continue; }
      const chords = chordsOf(v, action, field, problems);
      if (chords === null) continue;
      if (field === "direct") {
        into[action] = chords.filter((c) => {
          if (c === prefix || c === "ctrl+c") { problems.push(`direct key ${c} for ${action} is reserved; skipped`); return false; }
          if (!nonText(c)) { problems.push(`direct key ${c} for ${action} has no ctrl or alt, so it would type into a composer; skipped`); return false; }
          return true;
        });
      } else into[action] = chords;
    }
  }

  // The file's chords first; a default the file took for another action quietly gives way.
  const bindings: Record<HerdAction, string[]> = { ...DEFAULT_BINDINGS };
  const prefixKeys: KeyBinding[] = [];
  const owner = new Map<string, HerdAction>();
  for (const pass of ["file", "defaults"] as const) {
    for (const action of HERD_ACTIONS) {
      const fromFile = userPrefix[action];
      if ((pass === "file") !== (fromFile !== undefined)) continue;
      const kept: string[] = [];
      for (const chord of fromFile ?? DEFAULT_BINDINGS[action]) {
        const taken = owner.get(chord);
        if (taken !== undefined) {
          if (pass === "file") problems.push(`${prefix} ${chord} is bound to both ${taken} and ${action}; ${action} skips it`);
          continue;
        }
        owner.set(chord, action);
        kept.push(chord);
        prefixKeys.push({ chord, action });
      }
      bindings[action] = kept;
    }
  }
  const directKeys: KeyBinding[] = [];
  const directOwner = new Map<string, HerdAction>();
  for (const action of HERD_ACTIONS) {
    for (const chord of direct[action] ?? []) {
      const taken = directOwner.get(chord);
      if (taken !== undefined) { problems.push(`direct key ${chord} is bound to both ${taken} and ${action}; ${action} skips it`); continue; }
      directOwner.set(chord, action);
      directKeys.push({ chord, action });
    }
  }

  let mouse = true;
  if (o.mouse !== undefined) {
    if (typeof o.mouse === "boolean") mouse = o.mouse;
    else problems.push("mouse is true or false; mouse stays on");
  }
  const notify: NotifySettings = { bell: false, desktop: false, sound: false };
  if (o.notify !== undefined) {
    if (!isRecord(o.notify)) problems.push("notify is not an object; notifications stay off");
    else {
      for (const k of ["bell", "desktop", "sound"] as const) {
        const v = o.notify[k];
        if (v === undefined) continue;
        if (typeof v === "boolean") notify[k] = v;
        else problems.push(`notify.${k} is true or false; it stays off`);
      }
    }
  }
  return { prefix, bindings, direct, prefixKeys, directKeys, mouse, notify, problems };
}

export function keysPath(data: string): string {
  return join(data, "hub-keys.json");
}

const MAX_KEYS_BYTES = 64 * 1024;

/** The active key model from `<data>/hub-keys.json`; never throws. */
export function loadKeysConfig(data: string): KeysConfig {
  const path = keysPath(data);
  try {
    if (statSync(path).size > MAX_KEYS_BYTES) return { ...parseKeysConfig(null), problems: ["hub-keys.json is larger than 64 KiB; the default keys are on"] };
  } catch { return parseKeysConfig(null); }
  try { return parseKeysConfig(readFileSync(path, "utf8")); } catch { return parseKeysConfig(null); }
}

/** P-HERD.5 (ADR-0494): the notification switches, all off unless the file turns one on. */
export function notifySettings(cfg: KeysConfig): NotifySettings {
  return cfg.notify;
}

/** `lucid herd --default-keys`: the defaults as a hub-keys.json to start from. */
export function defaultKeysJson(): string {
  return JSON.stringify({ v: 1, prefix: DEFAULT_PREFIX, mouse: true, notify: { bell: false, desktop: false, sound: false }, bindings: DEFAULT_BINDINGS, direct: {} }, null, 2) + "\n";
}

/** The ACTIVE table `prefix+?` shows: every action with its keys as the file has them now. */
export function bindingRows(cfg: KeysConfig): { keys: string; action: HerdAction; help: string }[] {
  return HERD_ACTIONS.map((action) => {
    const keys = [...cfg.bindings[action].map((c) => `${cfg.prefix} ${c}`), ...(cfg.direct[action] ?? [])];
    return { keys: keys.length ? keys.join(", ") : "(unbound)", action, help: ACTION_HELP[action] };
  });
}

/** The hub-keys.json of a data dir, read again whenever it changed since the last look, so an edit
 *  shows in `prefix+?` without a restart. */
export class KeysFile {
  #stamp = "";
  #cfg: KeysConfig;
  constructor(readonly data: string) {
    this.#stamp = this.#stampNow();
    this.#cfg = loadKeysConfig(data);
  }

  #stampNow(): string {
    try {
      const st = statSync(keysPath(this.data));
      return `${st.mtimeMs}:${st.size}`;
    } catch { return "none"; }
  }

  /** The model now; `changed` when the file was re-read on this call. */
  current(): { cfg: KeysConfig; changed: boolean } {
    const stamp = this.#stampNow();
    if (stamp === this.#stamp) return { cfg: this.#cfg, changed: false };
    this.#stamp = stamp;
    this.#cfg = loadKeysConfig(this.data);
    return { cfg: this.#cfg, changed: true };
  }
}

export type KeyOutcome =
  | { kind: "pass" }
  | { kind: "armed" }
  | { kind: "cancel" }
  | { kind: "action"; action: HerdAction }
  | { kind: "unbound"; key: string };

/** Prefix mode per attached client: the prefix arms THAT client, its next key is one action. */
export class PrefixKeys {
  readonly #armed = new Set<number>();

  armed(client: number): boolean {
    return this.#armed.has(client);
  }

  /** A client left: its half-typed prefix goes with it. */
  forget(client: number): void {
    this.#armed.delete(client);
  }

  feed(data: string, client: number, cfg: KeysConfig): KeyOutcome {
    if (this.#armed.delete(client)) {
      const hit = cfg.prefixKeys.find((k) => chordMatches(data, k.chord));
      if (hit) return { kind: "action", action: hit.action };
      if (chordMatches(data, "escape") || chordMatches(data, cfg.prefix)) return { kind: "cancel" };
      return { kind: "unbound", key: JSON.stringify(data.slice(0, 16)) };
    }
    if (chordMatches(data, cfg.prefix)) {
      this.#armed.add(client);
      return { kind: "armed" };
    }
    const direct = cfg.directKeys.find((k) => chordMatches(data, k.chord));
    return direct ? { kind: "action", action: direct.action } : { kind: "pass" };
  }
}
