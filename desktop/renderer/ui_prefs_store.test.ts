// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/ui_prefs_store.test.ts - P-VIZ.PREFS1 (ADR-0697), P-FIRSTRUN.1 (ADR-0698): renderer preferences
// kept by the engine, mirrored in localStorage. The store against a fake mirror and a fake engine, and the engine's own
// record (settings_store uiPrefs / setUiPref) against a temp settings file.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setUiPref, uiPrefs } from "../settings_store.ts";
import { UI_PREF_MAX, type UiPrefKey } from "./ui_pref_keys.ts";
import { createUiPrefs } from "./ui_prefs_store.ts";

const VIEW: UiPrefKey = "lucid.viz.v1";
const OPTS: UiPrefKey = "lucid.worlds.options.v1";

function mirror(init: Record<string, string> = {}): Storage & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  } as unknown as Storage & { data: Map<string, string> };
}

/** A fake engine: what it keeps, every save it was sent, and a load the test releases when it wants. */
function engine(kept: Record<string, string> | null) {
  const saves: Array<[string, string | null]> = [];
  const { promise: loaded, resolve: answer } = Promise.withResolvers<Record<string, string> | null>();
  return {
    saves,
    reply: () => answer(kept),
    remote: { load: () => loaded, save: async (k: UiPrefKey, v: string | null) => { saves.push([k, v]); return {}; } },
  };
}

describe("createUiPrefs", () => {
  test("a launch on a new port (empty mirror) reads what the engine kept, and mirrors it for the next paint", async () => {
    const m = mirror();
    const e = engine({ [VIEW]: '{"motion":"always"}', "lucid.other": "ignored" });
    const s = createUiPrefs(m, e.remote);
    expect(s.getItem(VIEW)).toBeNull(); // the first paint, before the engine answers
    e.reply();
    expect(await s.ready).toBe(true);
    expect(s.getItem(VIEW)).toBe('{"motion":"always"}');
    expect(m.data.get(VIEW)).toBe('{"motion":"always"}');
    expect(m.data.has("lucid.other")).toBe(false); // only Visualize keys come over
  });

  test("an install from before this existed hands its mirrored preferences to the engine once", async () => {
    const m = mirror({ [VIEW]: '{"style":"world:baseball"}', [OPTS]: '{"world-x":{"a":1}}' });
    const e = engine({});
    const s = createUiPrefs(m, e.remote);
    e.reply();
    expect(await s.ready).toBe(false); // nothing new to read
    expect(e.saves).toEqual([[VIEW, '{"style":"world:baseball"}'], [OPTS, '{"world-x":{"a":1}}']]);
    expect(s.getItem(VIEW)).toBe('{"style":"world:baseball"}');
  });

  test("a choice made before the engine answered is kept over the engine's older value", async () => {
    const e = engine({ [VIEW]: '{"motion":"system"}' });
    const s = createUiPrefs(mirror(), e.remote);
    s.setItem(VIEW, '{"motion":"always"}');
    e.reply();
    await s.ready;
    expect(s.getItem(VIEW)).toBe('{"motion":"always"}');
    expect(e.saves).toEqual([[VIEW, '{"motion":"always"}']]);
  });

  test("a write goes to the mirror and the engine; removing sends null; an engine that is down loses nothing here", async () => {
    const m = mirror();
    const saves: Array<[string, string | null]> = [];
    const s = createUiPrefs(m, { load: async () => null, save: async (k, v) => { saves.push([k, v]); throw new Error("engine down"); } });
    s.setItem("lucid.viz.panelSize.v1", '{"w":400,"h":500}');
    s.removeItem("lucid.viz.panelSize.v1");
    s.setItem("lucid.viz.autoCamera", "0");
    expect(await s.ready).toBe(false);
    expect(saves).toEqual([["lucid.viz.panelSize.v1", '{"w":400,"h":500}'], ["lucid.viz.panelSize.v1", null], ["lucid.viz.autoCamera", "0"]]);
    expect(m.data.get("lucid.viz.autoCamera")).toBe("0");
    expect(m.data.has("lucid.viz.panelSize.v1")).toBe(false);
  });

  test("P-FIRSTRUN.1: a first-run toast seen and a holiday already asked survive a launch on a new port", async () => {
    const e = engine({ "lucid.personalNudged": "1", "lucid.suggest.holiday": '{"never":false,"asked":["thanksgiving-2026"]}' });
    const s = createUiPrefs(mirror(), e.remote); // a new origin: nothing mirrored
    e.reply();
    expect(await s.ready).toBe(true);
    expect(s.getItem("lucid.personalNudged")).toBe("1");
    expect(JSON.parse(s.getItem("lucid.suggest.holiday") ?? "{}").asked).toEqual(["thanksgiving-2026"]);
  });

  test("a key that is not a kept preference stays in the mirror only", async () => {
    const m = mirror();
    const e = engine({});
    const s = createUiPrefs(m, e.remote);
    s.setItem("lucid.something.else", "x");
    e.reply();
    await s.ready;
    expect(m.data.get("lucid.something.else")).toBe("x");
    expect(e.saves).toEqual([]);
  });
});

describe("engine-side record (settings_store uiPrefs / setUiPref)", () => {
  const prev = process.env.LUCID_GUI_SETTINGS_FILE;
  const dirs: string[] = [];
  afterEach(() => {
    if (prev === undefined) delete process.env.LUCID_GUI_SETTINGS_FILE; else process.env.LUCID_GUI_SETTINGS_FILE = prev;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const isolated = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "lucid-viz-prefs-"));
    dirs.push(dir);
    const file = join(dir, "lucid-gui.json");
    process.env.LUCID_GUI_SETTINGS_FILE = file;
    return file;
  };

  test("one known key per call, kept in the settings file; null removes it", () => {
    const file = isolated();
    expect(uiPrefs()).toEqual({});
    expect(setUiPref(VIEW, '{"motion":"always"}')).toEqual({ [VIEW]: '{"motion":"always"}' });
    expect(setUiPref(OPTS, "{}")).toEqual({ [VIEW]: '{"motion":"always"}', [OPTS]: "{}" });
    expect(JSON.parse(readFileSync(file, "utf8")).uiPrefs).toEqual({ [VIEW]: '{"motion":"always"}', [OPTS]: "{}" });
    expect(setUiPref(VIEW, null)).toEqual({ [OPTS]: "{}" });
  });

  test("an unknown key, a non-string or an oversized value changes nothing", () => {
    isolated();
    setUiPref(VIEW, "{}");
    expect(setUiPref("lucid.theme", "dark")).toBeNull();
    expect(setUiPref(VIEW, 42)).toBeNull();
    expect(setUiPref(VIEW, "x".repeat(UI_PREF_MAX + 1))).toBeNull();
    expect(uiPrefs()).toEqual({ [VIEW]: "{}" });
  });
});
