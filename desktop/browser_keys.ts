// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/browser_keys.ts - P-BROWSER.2: parse an agent-supplied key combo ("Control+a", "Escape",
// "Shift+Tab") into the { keyCode, modifiers } pair Electron's webContents.sendInputEvent expects.
//
// Pure and shared by BOTH processes: dev.ts validates the agent's argument at the route so a typo comes
// back as a precise error instead of a 10s timeout, and the Electron main uses the same parse as the
// authority when it actually presses the key. One implementation, one set of accepted names.
//
// FAIL-CLOSED on unknown names. Electron documents keyCode as "the valid key codes in Accelerator", and
// an unrecognised string is silently swallowed by Chromium: the agent would see a successful ack and a
// page that never changed, then loop. A named error ("unknown key \"pgdown\"") is the useful answer.

/** Electron modifier tokens, in a stable order so the same combo always produces the same array. */
const MODIFIER_ORDER = ["control", "alt", "shift", "meta"] as const;

/** Accepted spellings for each modifier. "cmd"/"super" fold onto meta so one combo string works on
 *  every host OS; the agent never has to know which platform the desktop is running. */
const MODIFIER_ALIASES: Record<string, (typeof MODIFIER_ORDER)[number]> = {
  ctrl: "control", control: "control",
  alt: "alt", option: "alt",
  shift: "shift",
  meta: "meta", cmd: "meta", command: "meta", super: "meta", win: "meta",
};

/** Named (non-printable) keys, alias -> the Accelerator keyCode Electron wants. */
const NAMED_KEYS: Record<string, string> = {
  escape: "Escape", esc: "Escape",
  enter: "Return", return: "Return",
  tab: "Tab",
  space: "Space", spacebar: "Space",
  backspace: "Backspace",
  delete: "Delete", del: "Delete",
  insert: "Insert", ins: "Insert",
  up: "Up", arrowup: "Up",
  down: "Down", arrowdown: "Down",
  left: "Left", arrowleft: "Left",
  right: "Right", arrowright: "Right",
  home: "Home",
  end: "End",
  pageup: "PageUp", pgup: "PageUp",
  pagedown: "PageDown", pgdn: "PageDown",
};

/** The four modifier tokens, as the literal union Electron's sendInputEvent accepts (a plain string[]
 *  is rejected there, and rightly: a typo'd modifier would be dropped silently). */
export type KeyModifier = (typeof MODIFIER_ORDER)[number];

export interface KeyCombo {
  keyCode: string;
  modifiers: KeyModifier[];
}

/** The canonical key names, spelled once for the error message and the tool description. Fixed list on
 *  purpose: NAMED_KEYS above maps many aliases onto these, and only these need naming back to the agent. */
const CANONICAL_KEYS = ["Backspace", "Delete", "Down", "End", "Escape", "Home", "Insert", "Left", "PageDown", "PageUp", "Return", "Right", "Space", "Tab", "Up"];

/** Every key name this parser accepts, for the error message and the tool description. */
export function supportedKeyNames(): string[] {
  return [...CANONICAL_KEYS, "F1 to F24", "any single character"];
}

/** Parse "Control+Shift+t" into { keyCode: "t", modifiers: ["control", "shift"] }.
 *  Returns an `error` string instead of throwing, so both callers can forward it verbatim. */
export function parseKeyCombo(input: string): KeyCombo | { error: string } {
  const raw = (input ?? "").trim();
  if (!raw) return { error: "no key combo given (examples: \"Escape\", \"Control+a\", \"Shift+Tab\")" };
  if (raw.length > 60) return { error: "key combo is too long to be a real combo" };

  // Split on + but keep a trailing literal "+" as the key itself: "+" alone is the plus key, and
  // "Control++" is control plus that same key. Appending before the empty-token filter covers both.
  const parts = raw.endsWith("+")
    ? [...raw.slice(0, -1).split("+"), "+"]
    : raw.split("+");
  const tokens = parts.map((p) => p.trim()).filter((p) => p.length > 0);
  if (!tokens.length) return { error: `"${raw}" has no key in it` };

  const keyToken = tokens[tokens.length - 1]!;
  const modTokens = tokens.slice(0, -1);

  const modifiers: KeyModifier[] = [];
  for (const m of modTokens) {
    const norm = MODIFIER_ALIASES[m.toLowerCase()];
    if (!norm) return { error: `unknown modifier "${m}" (use Control, Alt, Shift, or Meta)` };
    if (!modifiers.includes(norm)) modifiers.push(norm);
  }

  const keyCode = normalizeKey(keyToken);
  if (!keyCode) return { error: `unknown key "${keyToken}" (supported: ${supportedKeyNames().join(", ")})` };

  return { keyCode, modifiers: MODIFIER_ORDER.filter((m) => modifiers.includes(m)) };
}

/** One key token -> its Accelerator keyCode, or null when nothing recognises it. */
function normalizeKey(token: string): string | null {
  const named = NAMED_KEYS[token.toLowerCase()];
  if (named) return named;
  // Function keys: F1 to F24, case-insensitive, no zero padding.
  const fn = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(token);
  if (fn) return `F${fn[1]}`;
  // A single printable character passes through as itself (Electron accepts "a", "7", "/").
  if ([...token].length === 1 && token >= " ") return token;
  return null;
}
