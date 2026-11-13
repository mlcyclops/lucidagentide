// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0541; P-HERD.3, ADR-0492): the key model. The bindings file is read, never trusted: an
// unknown action or an unreadable chord is skipped with a plain reason, never fatal; a prefix or a
// direct chord that would type into a composer is refused; the table `prefix+?` shows is the active
// one; and the prefix arms the client that typed it, for one key.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindingRows,
  chordMatches,
  DEFAULT_BINDINGS,
  defaultKeysJson,
  HERD_ACTIONS,
  KeysFile,
  keysPath,
  loadKeysConfig,
  notifySettings,
  parseChord,
  parseKeysConfig,
  PrefixKeys,
  type KeysConfig,
} from "../src/keys.ts";

const rowFor = (cfg: KeysConfig, action: string) => bindingRows(cfg).find((r) => r.action === action);

describe("chords", () => {
  test("normal form: one printable key keeps its case; modifiers in a fixed order; named keys", () => {
    expect(parseChord("H")).toBe("H");
    expect(parseChord("[")).toBe("[");
    expect(parseChord("Alt+Ctrl+H")).toBe("ctrl+alt+h");
    expect(parseChord("ctrl+b")).toBe("ctrl+b");
    expect(parseChord("SPACE")).toBe("space");
    expect(parseChord("PageDown")).toBe("pageDown");
    expect(parseChord("esc")).toBe("escape");
  });

  test("unreadable chords are null", () => {
    for (const bad of ["", "ctrl+", "hyper+x", "ctrl+ctrl+x", "ctrl+toString", "ctrl+constructor", "\u0007", "é", "ctrl+xy"]) expect(parseChord(bad)).toBeNull();
  });

  test("a chord matches the bytes a terminal sends for it", () => {
    expect(chordMatches("\x02", "ctrl+b")).toBe(true);
    expect(chordMatches("b", "ctrl+b")).toBe(false);
    expect(chordMatches("v", "v")).toBe(true);
    expect(chordMatches("V", "v")).toBe(false);
    expect(chordMatches(" ", "space")).toBe(true);
    expect(chordMatches("\x1b", "escape")).toBe(true);
  });
});

describe("the bindings file", () => {
  test("no file is the defaults: prefix ctrl+b, every action bound, mouse on, notifications off", () => {
    const cfg = parseKeysConfig(null);
    expect(cfg.prefix).toBe("ctrl+b");
    expect(cfg.problems).toEqual([]);
    expect(cfg.mouse).toBe(true);
    expect(notifySettings(cfg)).toEqual({ bell: false, desktop: false, sound: false });
    for (const a of HERD_ACTIONS) expect(cfg.bindings[a].length).toBeGreaterThan(0);
    // No two actions share a default key.
    const all = cfg.prefixKeys.map((k) => k.chord);
    expect(new Set(all).size).toBe(all.length);
    expect(rowFor(cfg, "split-right")).toMatchObject({ keys: "ctrl+b v" });
  });

  test("--default-keys prints a file that reads back as exactly the defaults", () => {
    const cfg = parseKeysConfig(defaultKeysJson());
    expect(cfg.problems).toEqual([]);
    expect(cfg.bindings).toEqual(DEFAULT_BINDINGS);
  });

  test("a rebind shows in the active table; the default it took gives way; unknown actions and bad keys are skipped with a reason", () => {
    const cfg = parseKeysConfig(JSON.stringify({
      v: 1,
      bindings: { "split-right": ["s", "|"], "zoom": ["v"], "launch-missiles": ["m"], "close-pane": ["ctrl+", "x"] },
    }));
    expect(rowFor(cfg, "split-right")).toMatchObject({ keys: "ctrl+b s, ctrl+b |" });
    expect(rowFor(cfg, "zoom")).toMatchObject({ keys: "ctrl+b v" });
    expect(cfg.bindings["close-pane"]).toEqual(["x"]);
    expect(cfg.problems).toContain('unknown action "launch-missiles" in bindings; skipped');
    expect(cfg.problems).toContain('unreadable key "ctrl+" for close-pane; skipped');
    // A rebind that collides with another rebind is reported; the first keeps it.
    const clash = parseKeysConfig(JSON.stringify({ bindings: { "split-right": ["s"], "split-down": ["s"] } }));
    expect(clash.problems).toContain("ctrl+b s is bound to both split-right and split-down; split-down skips it");
    expect(rowFor(clash, "split-down")).toMatchObject({ keys: "(unbound)" });
  });

  test("a prefix or a direct key that would type into a composer is refused; direct keys with ctrl or alt work", () => {
    const cfg = parseKeysConfig(JSON.stringify({ prefix: "a", direct: { "focus-left": ["ctrl+alt+h", "h"], "detach": ["ctrl+c"] } }));
    expect(cfg.prefix).toBe("ctrl+b");
    expect(cfg.problems.some((p) => p.startsWith("the prefix a has no ctrl or alt"))).toBe(true);
    expect(cfg.direct["focus-left"]).toEqual(["ctrl+alt+h"]);
    expect(cfg.problems.some((p) => p.startsWith("direct key h for focus-left has no ctrl or alt"))).toBe(true);
    expect(cfg.problems.some((p) => p.startsWith("direct key ctrl+c for detach is reserved"))).toBe(true);
    expect(rowFor(cfg, "focus-left")).toMatchObject({ keys: "ctrl+b h, ctrl+alt+h" });
    expect(parseKeysConfig(JSON.stringify({ prefix: "ctrl+a" })).prefix).toBe("ctrl+a");
  });

  test("junk is the defaults plus one plain reason, never a throw", () => {
    for (const raw of ["{", "[]", "42", JSON.stringify({ v: 9 })]) {
      const cfg = parseKeysConfig(raw);
      expect(cfg.prefix).toBe("ctrl+b");
      expect(cfg.problems).toHaveLength(1);
    }
    const odd = parseKeysConfig(JSON.stringify({ mouse: "no", notify: { bell: true, desktop: "yes", extra: 1 }, theme: 1, bindings: [] }));
    expect(odd.mouse).toBe(true);
    expect(odd.notify).toEqual({ bell: true, desktop: false, sound: false });
    expect(odd.problems).toHaveLength(4); // mouse, notify.desktop, theme, bindings
  });

  test("mouse: false turns capture off", () => {
    expect(parseKeysConfig(JSON.stringify({ mouse: false })).mouse).toBe(false);
  });
});

describe("the file on disk", () => {
  let data: string;
  beforeEach(() => { data = mkdtempSync(join(tmpdir(), "herd-keys-")); });
  afterEach(() => { rmSync(data, { recursive: true, force: true }); });

  test("an edit is picked up on the next look, without a restart", () => {
    const keys = new KeysFile(data);
    expect(keys.current()).toMatchObject({ changed: false });
    writeFileSync(keysPath(data), JSON.stringify({ bindings: { zoom: ["Z"] } }));
    const next = keys.current();
    expect(next.changed).toBe(true);
    expect(next.cfg.bindings.zoom).toEqual(["Z"]);
    expect(keys.current().changed).toBe(false);
    writeFileSync(keysPath(data), JSON.stringify({ bindings: { zoom: ["Z", "ctrl+z"] } }));
    expect(keys.current().cfg.bindings.zoom).toEqual(["Z", "ctrl+z"]);
  });

  test("a file over 64 KiB is refused whole", () => {
    writeFileSync(keysPath(data), " ".repeat(65 * 1024));
    const cfg = loadKeysConfig(data);
    expect(cfg.prefix).toBe("ctrl+b");
    expect(cfg.problems[0]).toContain("larger than 64 KiB");
  });
});

describe("prefix mode", () => {
  const cfg = parseKeysConfig(null);

  test("the prefix arms the client that typed it, for exactly one key", () => {
    const p = new PrefixKeys();
    expect(p.feed("v", 1, cfg)).toEqual({ kind: "pass" }); // navigate or terminal mode: not Herd's
    expect(p.feed("\x02", 1, cfg)).toEqual({ kind: "armed" });
    expect(p.feed("v", 2, cfg)).toEqual({ kind: "pass" }); // another client's key is its own
    expect(p.feed("v", 1, cfg)).toEqual({ kind: "action", action: "split-right" });
    expect(p.feed("v", 1, cfg)).toEqual({ kind: "pass" });
  });

  test("an unbound key reports and disarms; esc or the prefix again cancels; a departed client is forgotten", () => {
    const p = new PrefixKeys();
    p.feed("\x02", 1, cfg);
    expect(p.feed("~", 1, cfg)).toEqual({ kind: "unbound", key: '"~"' });
    p.feed("\x02", 1, cfg);
    expect(p.feed("\x1b", 1, cfg)).toEqual({ kind: "cancel" });
    p.feed("\x02", 1, cfg);
    expect(p.feed("\x02", 1, cfg)).toEqual({ kind: "cancel" });
    p.feed("\x02", 3, cfg);
    p.forget(3);
    expect(p.armed(3)).toBe(false);
  });

  test("a direct chord acts without the prefix", () => {
    const direct = parseKeysConfig(JSON.stringify({ direct: { "focus-left": ["alt+h"] } }));
    expect(new PrefixKeys().feed("\x1bh", 1, direct)).toEqual({ kind: "action", action: "focus-left" });
    expect(new PrefixKeys().feed("h", 1, direct)).toEqual({ kind: "pass" }); // a composer keeps its h
  });
});
