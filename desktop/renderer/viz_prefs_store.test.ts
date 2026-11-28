// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_prefs_store.test.ts - P-VIZ.PREFS1 (ADR-0697): Visualize's preferences kept by the engine,
// mirrored in localStorage. The store against a fake mirror and a fake engine, and the engine's own record
// (settings_store vizPrefs / setVizPref) against a temp settings file.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setVizPref, vizPrefs } from "../settings_store.ts";
import { VIZ_PREF_MAX, type VizPrefKey } from "./viz_pref_keys.ts";
import { createVizPrefs } from "./viz_prefs_store.ts";

const VIEW: VizPrefKey = "lucid.viz.v1";
const OPTS: VizPrefKey = "lucid.worlds.options.v1";

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
    remote: { load: () => loaded, save: async (k: VizPrefKey, v: string | null) => { saves.push([k, v]); return {}; } },
  };
}

describe("createVizPrefs", () => {
  test("a launch on a new port (empty mirror) reads what the engine kept, and mirrors it for the next paint", async () => {
    const m = mirror();
    const e = engine({ [VIEW]: '{"motion":"always"}', "lucid.other": "ignored" });
    const s = createVizPrefs(m, e.remote);
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
    const s = createVizPrefs(m, e.remote);
    e.reply();
    expect(await s.ready).toBe(false); // nothing new to read
    expect(e.saves).toEqual([[VIEW, '{"style":"world:baseball"}'], [OPTS, '{"world-x":{"a":1}}']]);
    expect(s.getItem(VIEW)).toBe('{"style":"world:baseball"}');
  });

  test("a choice made before the engine answered is kept over the engine's older value", async () => {
    const e = engine({ [VIEW]: '{"motion":"system"}' });
    const s = createVizPrefs(mirror(), e.remote);
    s.setItem(VIEW, '{"motion":"always"}');
    e.reply();
    await s.ready;
    expect(s.getItem(VIEW)).toBe('{"motion":"always"}');
    expect(e.saves).toEqual([[VIEW, '{"motion":"always"}']]);
  });

  test("a write goes to the mirror and the engine; removing sends null; an engine that is down loses nothing here", async () => {
    const m = mirror();
    const saves: Array<[string, string | null]> = [];
    const s = createVizPrefs(m, { load: async () => null, save: async (k, v) => { saves.push([k, v]); throw new Error("engine down"); } });
    s.setItem("lucid.viz.panelSize.v1", '{"w":400,"h":500}');
    s.removeItem("lucid.viz.panelSize.v1");
    s.setItem("lucid.viz.autoCamera", "0");
    expect(await s.ready).toBe(false);
    expect(saves).toEqual([["lucid.viz.panelSize.v1", '{"w":400,"h":500}'], ["lucid.viz.panelSize.v1", null], ["lucid.viz.autoCamera", "0"]]);
    expect(m.data.get("lucid.viz.autoCamera")).toBe("0");
    expect(m.data.has("lucid.viz.panelSize.v1")).toBe(false);
  });

  test("a key that is not a Visualize preference stays in the mirror only", async () => {
    const m = mirror();
    const e = engine({});
    const s = createVizPrefs(m, e.remote);
    s.setItem("lucid.something.else", "x");
    e.reply();
    await s.ready;
    expect(m.data.get("lucid.something.else")).toBe("x");
    expect(e.saves).toEqual([]);
  });
});

describe("engine-side record (settings_store vizPrefs / setVizPref)", () => {
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
    expect(vizPrefs()).toEqual({});
    expect(setVizPref(VIEW, '{"motion":"always"}')).toEqual({ [VIEW]: '{"motion":"always"}' });
    expect(setVizPref(OPTS, "{}")).toEqual({ [VIEW]: '{"motion":"always"}', [OPTS]: "{}" });
    expect(JSON.parse(readFileSync(file, "utf8")).vizPrefs).toEqual({ [VIEW]: '{"motion":"always"}', [OPTS]: "{}" });
    expect(setVizPref(VIEW, null)).toEqual({ [OPTS]: "{}" });
  });

  test("an unknown key, a non-string or an oversized value changes nothing", () => {
    isolated();
    setVizPref(VIEW, "{}");
    expect(setVizPref("lucid.theme", "dark")).toBeNull();
    expect(setVizPref(VIEW, 42)).toBeNull();
    expect(setVizPref(VIEW, "x".repeat(VIZ_PREF_MAX + 1))).toBeNull();
    expect(vizPrefs()).toEqual({ [VIEW]: "{}" });
  });
});
