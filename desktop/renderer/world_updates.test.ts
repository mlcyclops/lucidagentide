// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/world_updates.test.ts - P-WORLDS.UPDATE1 (ADR-0685): which purchased worlds have an update, which
// announcements are new, the store install path, the controller (one notice per world and version, Update through
// the store path, honest failures), and the engine-side memory of what was announced.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Entitlement } from "../../harness/market/entitlement.ts";
import type { InstalledPluginView, PluginInstallView } from "./bridge.ts";
import { nullProvider, type EntitlementProvider } from "./market_gate.ts";
import type { ToastOpts } from "./ui.ts";
import {
  availableCopy, createWorldUpdates, installFromStore, namesLine, outcomeToast, pendingWorldUpdates, reconcileUpdates,
  rowUpdate, type InstalledRow, type WorldUpdate,
} from "./world_updates.ts";
import { ANNOUNCED_MAX, rememberAnnounced, sanitizeAnnounced, unannounced, updateKey } from "./world_update_keys.ts";
import { setWorldUpdatesAnnounced, worldUpdatesAnnounced } from "../settings_store.ts";

const NOW_MS = Date.parse("2026-11-25T12:00:00.000Z");
const NOW = new Date(NOW_MS).toISOString();

const row = (id: string, version: string, over: Partial<InstalledRow> = {}): InstalledRow =>
  ({ id, name: `${id} package`, version, kind: "world", source: "catalog", signed: true, ...over });
const ent = (packId: string, latestVersion: string | null, over: Partial<Entitlement> = {}): Entitlement =>
  ({ packId, state: "active", method: "card", latestVersion, ...over });
const upd = (id: string, name: string, from: string, to: string): WorldUpdate => ({ id, name, from, to });

describe("pendingWorldUpdates", () => {
  test("an entitled store world with a newer latestVersion has an update, named as the store names it", () => {
    const ents = new Map([["world-christmas", ent("world-christmas", "1.2.0")]]);
    expect(pendingWorldUpdates([row("world-christmas", "1.0.0")], ents, true, NOW)).toEqual([upd("world-christmas", "Christmas", "1.0.0", "1.2.0")]);
  });

  test("the same, an older, a missing or a garbled latestVersion is no update", () => {
    for (const latest of ["1.0.0", "0.9.0", null, "", "latest", "1.2"]) {
      const ents = new Map([["world-christmas", ent("world-christmas", latest)]]);
      expect(pendingWorldUpdates([row("world-christmas", "1.0.0")], ents, true, NOW)).toEqual([]);
    }
  });

  test("fail-closed: signed out, no entitlement, expired, or lapsed is never an update", () => {
    const r = [row("world-christmas", "1.0.0")];
    expect(pendingWorldUpdates(r, new Map([["world-christmas", ent("world-christmas", "2.0.0")]]), false, NOW)).toEqual([]);
    expect(pendingWorldUpdates(r, new Map(), true, NOW)).toEqual([]);
    expect(pendingWorldUpdates(r, new Map([["world-christmas", ent("world-christmas", "2.0.0", { state: "expired" })]]), true, NOW)).toEqual([]);
    expect(pendingWorldUpdates(r, new Map([["world-christmas", ent("world-christmas", "2.0.0", { expiresAt: "2026-01-01T00:00:00.000Z" })]]), true, NOW)).toEqual([]);
  });

  test("never for a private copy or a package that is not a world", () => {
    const ents = new Map([["world-christmas", ent("world-christmas", "2.0.0")], ["pathfinder", ent("pathfinder", "2.0.0")]]);
    expect(pendingWorldUpdates([row("world-christmas", "1.0.0", { source: "private" }), row("pathfinder", "1.0.0", { kind: "web" })], ents, true, NOW)).toEqual([]);
  });

  test("in name order; an unknown store id falls back to the package name", () => {
    const ents = new Map([
      ["world-soccer", ent("world-soccer", "1.1.0")], ["world-circus", ent("world-circus", "3.0.0")], ["world-zz-new", ent("world-zz-new", "1.0.1")],
    ]);
    const got = pendingWorldUpdates([row("world-soccer", "1.0.0"), row("world-circus", "2.9.9"), row("world-zz-new", "1.0.0", { name: "Brand New" })], ents, true, NOW);
    expect(got.map((u) => u.name)).toEqual(["Brand New", "Circus", "Soccer"]);
  });
});

describe("rowUpdate and reconcileUpdates", () => {
  const pending = [upd("world-christmas", "Christmas", "1.0.0", "1.2.0")];
  test("a row offers Update only when allowed and still older", () => {
    expect(rowUpdate("world-christmas", "1.0.0", true, pending)).toEqual(pending[0]!);
    expect(rowUpdate("world-christmas", "1.0.0", false, pending)).toBeNull();
    expect(rowUpdate("world-christmas", "1.2.0", true, pending)).toBeNull();
    expect(rowUpdate("world-soccer", "1.0.0", true, pending)).toBeNull();
  });
  test("an installed version that caught up, or a removed world, drops out", () => {
    expect(reconcileUpdates(pending, [{ id: "world-christmas", version: "1.0.0" }])).toEqual(pending);
    expect(reconcileUpdates(pending, [{ id: "world-christmas", version: "1.2.0" }])).toEqual([]);
    expect(reconcileUpdates(pending, [])).toEqual([]);
  });
});

describe("announcements", () => {
  test("sanitizeAnnounced keeps well-formed keys once (last position), the newest ANNOUNCED_MAX", () => {
    expect(sanitizeAnnounced(null)).toEqual([]);
    expect(sanitizeAnnounced("world-christmas@1.0.0")).toEqual([]);
    expect(sanitizeAnnounced(["world-christmas@1.0.0", 7, "BAD@1.0.0", "world-x@1.2", "<b>@1.0.0", "world-soccer@2.0.0-beta.1", "world-christmas@1.0.0"]))
      .toEqual(["world-soccer@2.0.0-beta.1", "world-christmas@1.0.0"]);
    const many = Array.from({ length: ANNOUNCED_MAX + 5 }, (_, i) => `world-a@1.0.${i}`);
    const kept = sanitizeAnnounced(many);
    expect(kept.length).toBe(ANNOUNCED_MAX);
    expect(kept[0]).toBe("world-a@1.0.5");
    expect(kept.at(-1)).toBe(`world-a@1.0.${ANNOUNCED_MAX + 4}`);
  });

  test("an update is announced once per world and version; a newer version announces again", () => {
    const first = [upd("world-christmas", "Christmas", "1.0.0", "1.2.0")];
    expect(unannounced(first, [])).toEqual(first);
    const after = rememberAnnounced([], first);
    expect(after).toEqual([updateKey(first[0]!)]);
    expect(unannounced(first, after)).toEqual([]);
    const next = [upd("world-christmas", "Christmas", "1.0.0", "1.3.0")];
    expect(unannounced(next, after)).toEqual(next);
  });

  test("the notice lists up to 3 names, then +N more", () => {
    expect(namesLine(["A", "B"])).toBe("A, B");
    expect(namesLine(["A", "B", "C", "D", "E"])).toBe("A, B, C +2 more");
    expect(availableCopy([upd("w-a", "Christmas", "1.0.0", "1.2.0")])).toEqual({ title: "World updates available", desc: "Christmas has a new version, 1.2.0." });
    const five = ["Circus", "Farm", "Soccer", "Texas", "Wave"].map((n, i) => upd(`w-${i}`, n, "1.0.0", "1.1.0"));
    expect(availableCopy(five).desc).toBe("New versions of Circus, Farm, Soccer +2 more.");
  });

  test("the outcome toast: what installed, or the honest first failure", () => {
    expect(outcomeToast([{ id: "a", name: "Christmas", ok: true, version: "1.2.0" }])).toMatchObject({ tone: "ok", title: "Christmas updated" });
    expect(outcomeToast([{ id: "a", name: "Christmas", ok: true, version: "1.2.0" }, { id: "b", name: "Soccer", ok: true, version: "2.0.0" }]))
      .toMatchObject({ tone: "ok", title: "2 worlds updated", desc: "Christmas 1.2.0, Soccer 2.0.0" });
    const one = outcomeToast([{ id: "a", name: "Christmas", ok: false, reason: "The package could not be downloaded: download failed (404)" }]);
    expect(one).toMatchObject({ tone: "danger", title: "Christmas was not updated", desc: "The package could not be downloaded: download failed (404)", timeout: 0 });
    const mixed = outcomeToast([{ id: "a", name: "Christmas", ok: true, version: "1.2.0" }, { id: "b", name: "Soccer", ok: false, reason: "No link" }, { id: "c", name: "Farm", ok: false, reason: "x" }]);
    expect(mixed).toMatchObject({ tone: "danger", title: "2 of 3 world updates failed", desc: "Soccer: No link", meta: "Updated: Christmas. 1 more not updated" });
  });
});

/** A signed-in store that owns every id in `latest` and can hand out a download link for each. */
function fakeStore(latest: Record<string, string>, opts: { signedIn?: boolean; link?: boolean } = {}): EntitlementProvider & { asked: string[] } {
  const asked: string[] = [];
  return {
    ...nullProvider,
    asked,
    configured: () => true,
    auth: async () => ({ signedIn: opts.signedIn !== false }),
    entitlement: async (id) => { asked.push(id); return id in latest ? ent(id, latest[id]!) : null; },
    downloadUrl: async (id) => (opts.link === false ? null : `https://store.example/${id}.zip`),
  };
}

const view = (id: string, version: string): InstalledPluginView => ({
  id, name: id, version, kind: "world", tier: "premium", section: "civilian", state: "installed", license: "LUCID-Premium-Plugin-1.0", hasMcp: false, source: "catalog", signed: true,
});

describe("installFromStore", () => {
  test("no download link, no engine, a refused gate, and a success each say so", async () => {
    const ok: PluginInstallView = { ok: true, id: "world-christmas", version: "1.2.0" };
    expect(await installFromStore("world-christmas", { provider: fakeStore({}, { link: false }), installFromUrl: async () => ok })).toMatchObject({ ok: false, refused: false });
    expect(await installFromStore("world-christmas", { provider: fakeStore({}), installFromUrl: async () => null })).toMatchObject({ ok: false, refused: false });
    expect(await installFromStore("world-christmas", { provider: fakeStore({}), installFromUrl: async () => { throw new Error("socket"); } })).toMatchObject({ ok: false, refused: false });
    expect(await installFromStore("world-christmas", { provider: fakeStore({}), installFromUrl: async () => ({ ok: false, gate: "signature", reason: "unknown key" }) }))
      .toEqual({ ok: false, refused: true, reason: "The package is not signed by a trusted publisher: unknown key" });
    let verified = false;
    const sent: string[] = [];
    expect(await installFromStore("world-christmas", { provider: fakeStore({}), installFromUrl: async (url, id) => { sent.push(`${id} ${url}`); return ok; } }, () => { verified = true; }))
      .toEqual({ ok: true, version: "1.2.0" });
    expect(verified).toBe(true);
    expect(sent).toEqual(["world-christmas https://store.example/world-christmas.zip"]);
  });
});

describe("createWorldUpdates", () => {
  function harness(store: EntitlementProvider, installed: InstalledPluginView[], install: (url: string, id: string) => Promise<PluginInstallView | null>) {
    let announced: string[] | null = [];
    const toasts: ToastOpts[] = [];
    const saves: string[][] = [];
    let waiter: ((t: ToastOpts) => void) | null = null;
    const u = createWorldUpdates({
      provider: () => store,
      pluginsList: async () => ({ plugins: installed, offered: [] }),
      installFromUrl: install,
      loadAnnounced: async () => announced,
      saveAnnounced: async (keys) => { saves.push(keys); announced = keys; },
      toast: (t) => { toasts.push(t); const w = waiter; waiter = null; w?.(t); },
      now: () => NOW_MS,
    });
    /** The next toast shown (the outcome of an update the toast action started). */
    const nextToast = (): Promise<ToastOpts> => { const { promise, resolve } = Promise.withResolvers<ToastOpts>(); waiter = resolve; return promise; };
    return { u, toasts, saves, nextToast, setAnnounced: (a: string[] | null) => { announced = a; } };
  }

  test("signed out or no store: nothing is asked and nothing is pending", async () => {
    const out = fakeStore({ "world-christmas": "2.0.0" }, { signedIn: false });
    const h = harness(out, [view("world-christmas", "1.0.0")], async () => null);
    expect(await h.u.check()).toEqual([]);
    expect(out.asked).toEqual([]);
    const none = harness(nullProvider, [view("world-christmas", "1.0.0")], async () => null);
    expect(await none.u.announce()).toBe(false);
    expect(none.toasts).toEqual([]);
  });

  test("one entitlement call per installed store world; the notice shows once and is remembered engine-side", async () => {
    const store = fakeStore({ "world-christmas": "1.2.0", "world-soccer": "1.0.0" });
    const h = harness(store, [view("world-christmas", "1.0.0"), view("world-soccer", "1.0.0"), { ...view("pathfinder", "1.0.0"), kind: "web" }], async () => null);
    let changes = 0;
    h.u.onChange(() => { changes++; });
    expect(await h.u.announce()).toBe(true);
    expect(store.asked.sort()).toEqual(["world-christmas", "world-soccer"]);
    expect(h.u.pending().map((x) => x.id)).toEqual(["world-christmas"]);
    expect(changes).toBeGreaterThan(0);
    expect(h.saves).toEqual([["world-christmas@1.2.0"]]);
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0]).toMatchObject({ title: "World updates available", desc: "Christmas has a new version, 1.2.0.", timeout: 0 });
    expect(h.toasts[0]!.actions?.map((a) => a.label)).toEqual(["Update all", "Later"]);
    // a second launch: the engine remembers, so no second notice
    expect(await h.u.announce()).toBe(false);
    expect(h.toasts).toHaveLength(1);
  });

  test("no notice when the engine cannot say what was announced (never a repeat on every launch)", async () => {
    const h = harness(fakeStore({ "world-christmas": "1.2.0" }), [view("world-christmas", "1.0.0")], async () => null);
    h.setAnnounced(null);
    expect(await h.u.announce()).toBe(false);
    expect(h.toasts).toEqual([]);
    expect(h.u.pending()).toHaveLength(1); // the menu still offers Update
  });

  test("Update installs through the store path, shows busy, drops the update and toasts the new version", async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const calls: string[] = [];
    const h = harness(fakeStore({ "world-christmas": "1.2.0" }), [view("world-christmas", "1.0.0")], async (url, id) => {
      calls.push(`${id} ${url}`);
      await gate;
      return { ok: true, id, version: "1.2.0" };
    });
    await h.u.check();
    const whys: string[] = [];
    h.u.onChange((w) => whys.push(w));
    const run = h.u.update(["world-christmas"]);
    expect(h.u.busy("world-christmas")).toBe(true);
    expect(await h.u.update(["world-christmas"])).toEqual([]); // a second press while it runs does nothing
    release();
    expect(await run).toEqual([{ id: "world-christmas", name: "Christmas", ok: true, version: "1.2.0" }]);
    expect(calls).toEqual(["world-christmas https://store.example/world-christmas.zip"]);
    expect(h.u.busy("world-christmas")).toBe(false);
    expect(h.u.pending()).toEqual([]);
    expect(whys).toEqual(["busy", "installed"]);
    expect(h.toasts.at(-1)).toMatchObject({ tone: "ok", title: "Christmas updated" });
  });

  test("a refused update keeps the update pending and toasts the gate's reason", async () => {
    const h = harness(fakeStore({ "world-christmas": "1.2.0" }), [view("world-christmas", "1.0.0")], async () => ({ ok: false, gate: "download", reason: "download failed (404)" }));
    await h.u.check();
    const [o] = await h.u.update(["world-christmas"]);
    expect(o).toEqual({ id: "world-christmas", name: "Christmas", ok: false, reason: "The package could not be downloaded: download failed (404)" });
    expect(h.u.pending()).toHaveLength(1);
    expect(h.toasts.at(-1)).toMatchObject({ tone: "danger", title: "Christmas was not updated" });
  });

  test("Update all from the notice updates every pending world", async () => {
    const done: string[] = [];
    const h = harness(fakeStore({ "world-christmas": "1.2.0", "world-soccer": "2.0.0" }), [view("world-christmas", "1.0.0"), view("world-soccer", "1.0.0")],
      async (_url, id) => { done.push(id); return { ok: true, id, version: id === "world-soccer" ? "2.0.0" : "1.2.0" }; });
    await h.u.announce();
    const result = h.nextToast();
    h.toasts[0]!.actions![0]!.run!();
    expect(await result).toMatchObject({ tone: "ok", title: "2 worlds updated" });
    expect(done).toEqual(["world-christmas", "world-soccer"]);
  });

  test("reconcile drops what an install elsewhere caught up", async () => {
    const h = harness(fakeStore({ "world-christmas": "1.2.0" }), [view("world-christmas", "1.0.0")], async () => null);
    await h.u.check();
    h.u.reconcile([{ id: "world-christmas", version: "1.2.0" }]);
    expect(h.u.pending()).toEqual([]);
  });
});

describe("engine-side memory (settings_store)", () => {
  const prev = process.env.LUCID_GUI_SETTINGS_FILE;
  const dirs: string[] = [];
  afterEach(() => {
    if (prev === undefined) delete process.env.LUCID_GUI_SETTINGS_FILE; else process.env.LUCID_GUI_SETTINGS_FILE = prev;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("announced keys persist in the settings file, sanitized; a fresh renderer origin reads them back", () => {
    const dir = mkdtempSync(join(tmpdir(), "lucid-world-upd-"));
    dirs.push(dir);
    const file = join(dir, "lucid-gui.json");
    process.env.LUCID_GUI_SETTINGS_FILE = file;
    expect(worldUpdatesAnnounced()).toEqual([]);
    expect(setWorldUpdatesAnnounced(["world-christmas@1.2.0", "nope", 3, "world-soccer@2.0.0"])).toEqual(["world-christmas@1.2.0", "world-soccer@2.0.0"]);
    expect(JSON.parse(readFileSync(file, "utf8")).worldUpdatesAnnounced).toEqual(["world-christmas@1.2.0", "world-soccer@2.0.0"]);
    expect(worldUpdatesAnnounced()).toEqual(["world-christmas@1.2.0", "world-soccer@2.0.0"]);
    expect(setWorldUpdatesAnnounced("garbage")).toEqual([]);
  });
});
