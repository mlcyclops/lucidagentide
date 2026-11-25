// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/world_updates.ts - P-WORLDS.UPDATE1 (ADR-0685): updates for purchased Lucid Agent Worlds.
//
// A world installed from the store (source "catalog") has an update when this account's entitlement for it is active
// and the backend names a strictly newer `latestVersion` (the field the store cards' Update already reads). check()
// asks the provider once per installed store world (the same getEntitlement call the store cards make), and only
// when a store is configured and the user is signed in. Updating is the store card's own install path
// (installFromStore: provider.downloadUrl, then the engine's verified install-from-url with every gate; the version
// switches atomically), so an update can never install anything a fresh purchase could not.
//
// announce() shows ONE toast for the updates not announced before ("<id>@<version>"). What was announced lives
// engine-side (GET/POST /api/worlds/update-notices, settings_store worldUpdatesAnnounced): renderer localStorage is
// per origin, and a port-rolled launch (ADR-0458) starts on a new origin with an empty one.
//
// No DOM here: the engine imports sanitizeAnnounced, and world_updates.test.ts drives the controller with fakes.

import { decidePackAction, type Entitlement } from "../../harness/market/entitlement.ts";
import type { InstalledPluginView, PluginInstallView, PluginsListView } from "./bridge.ts";
import type { EntitlementProvider } from "./market_gate.ts";
import { GATE_TEXT, PREMIUM_PLUGINS, isNewerVersion, storeInstalledVersion } from "./plugin_catalog.ts";
import type { ToastOpts } from "./ui.ts";

/** One purchased world with a newer version in the store. */
export interface WorldUpdate { id: string; name: string; from: string; to: string }

/** The fields of an installed package (GET /api/plugins) the update check reads. */
export type InstalledRow = Pick<InstalledPluginView, "id" | "name" | "version" | "kind" | "source" | "signed">;

/** The store's name for a world (the card's), else the package's, else its id. */
export function worldName(id: string, fallback: string): string {
  return PREMIUM_PLUGINS.find((p) => p.id === id)?.name ?? (fallback || id);
}

/** The installed store worlds: a private copy is never updated from the store (ADR-0505). */
export function storeWorlds<T extends InstalledRow>(rows: readonly T[]): T[] {
  return rows.filter((p) => p.kind === "world" && storeInstalledVersion(p) !== null);
}

/** Which installed store worlds have an update: entitled now (decidePackAction says pull, fail-closed) and a
 *  `latestVersion` strictly newer than the installed one. In name order. Pure. */
export function pendingWorldUpdates(rows: readonly InstalledRow[], ents: ReadonlyMap<string, Entitlement | null>, signedIn: boolean, nowIso: string): WorldUpdate[] {
  const out: WorldUpdate[] = [];
  for (const p of storeWorlds(rows)) {
    const ent = ents.get(p.id) ?? null;
    if (decidePackAction({ signedIn }, ent, nowIso) !== "pull") continue;
    const to = (ent?.latestVersion ?? "").trim();
    if (!to || !isNewerVersion(to, p.version)) continue;
    out.push({ id: p.id, name: worldName(p.id, p.name), from: p.version, to });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The Update a Worlds menu row offers: its pending update while the world is usable on this account and the
 *  installed version is still older (an install from the store drawer may have caught it up). Pure. */
export function rowUpdate(id: string, installedVersion: string, allowed: boolean, pending: readonly WorldUpdate[]): WorldUpdate | null {
  if (!allowed) return null;
  const u = pending.find((x) => x.id === id);
  return u && isNewerVersion(u.to, installedVersion) ? u : null;
}

/** The pending updates still older than what is installed now (a world updated or removed elsewhere drops out). */
export function reconcileUpdates(pending: readonly WorldUpdate[], installed: readonly { id: string; version: string }[]): WorldUpdate[] {
  return pending.filter((u) => {
    const i = installed.find((x) => x.id === u.id);
    return !!i && isNewerVersion(u.to, i.version);
  });
}

// ------------------------------------------------------------------------------------------ announcements

/** At most this many announced keys are kept (the newest). */
export const ANNOUNCED_MAX = 200;
const ANNOUNCED_RE = /^[a-z0-9][a-z0-9-]{0,63}@v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** "<id>@<version>": one announcement. */
export const updateKey = (u: Pick<WorldUpdate, "id" | "to">): string => `${u.id}@${u.to}`;

/** Only well-formed keys, each once (its last position), the newest ANNOUNCED_MAX. Anything else reads as none. */
export function sanitizeAnnounced(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = raw.length - 1; i >= 0 && out.length < ANNOUNCED_MAX; i--) {
    const k: unknown = raw[i];
    if (typeof k !== "string" || !ANNOUNCED_RE.test(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out.reverse();
}

/** The updates not announced before. Pure. */
export function unannounced(pending: readonly WorldUpdate[], announced: readonly string[]): WorldUpdate[] {
  const s = new Set(announced);
  return pending.filter((u) => !s.has(updateKey(u)));
}

/** The announced keys after announcing `fresh`. Pure. */
export function rememberAnnounced(announced: readonly string[], fresh: readonly WorldUpdate[]): string[] {
  return sanitizeAnnounced([...announced, ...fresh.map(updateKey)]);
}

/** "A, B, C +2 more". */
export function namesLine(names: readonly string[], max = 3): string {
  const shown = names.slice(0, max).join(", ");
  return names.length > max ? `${shown} +${names.length - max} more` : shown;
}

/** The "World updates available" toast's text for every pending update. Pure. */
export function availableCopy(pending: readonly WorldUpdate[]): { title: string; desc: string } {
  const one = pending.length === 1 ? pending[0] : null;
  return {
    title: "World updates available",
    desc: one ? `${one.name} has a new version, ${one.to}.` : `New versions of ${namesLine(pending.map((u) => u.name))}.`,
  };
}

// ------------------------------------------------------------------------------------------ installing

export type StoreInstallResult = { ok: true; version: string } | { ok: false; refused: boolean; reason: string };

/** The store card's install path (Install and Update in the Plugins drawer, Update in the Worlds menu): a signed
 *  download link only an entitled account gets, then the engine's install-from-url, which runs every gate before it
 *  switches the version. `refused`: an install gate said no (the reason names the gate). `onVerify` runs once the
 *  download link is in hand. */
export async function installFromStore(
  id: string,
  d: { provider: EntitlementProvider; installFromUrl: (url: string, expectId: string) => Promise<PluginInstallView | null> },
  onVerify?: () => void,
): Promise<StoreInstallResult> {
  const url = await d.provider.downloadUrl(id).catch(() => null);
  if (!url) return { ok: false, refused: false, reason: "No download link came back. The purchase may still be processing, or the package is not published yet." };
  onVerify?.();
  const r = await d.installFromUrl(url, id).catch(() => null);
  if (!r) return { ok: false, refused: false, reason: "The install service did not answer. Is the LUCID engine running?" };
  if (!r.ok) return { ok: false, refused: true, reason: `${GATE_TEXT[r.gate]}: ${r.reason}` };
  return { ok: true, version: r.version };
}

export type UpdateOutcome = { id: string; name: string; ok: true; version: string } | { id: string; name: string; ok: false; reason: string };

/** The one toast after an update run: what installed, or the first honest failure (and how many more). Pure. */
export function outcomeToast(outcomes: readonly UpdateOutcome[]): ToastOpts {
  const done = outcomes.filter((o): o is Extract<UpdateOutcome, { ok: true }> => o.ok);
  const failed = outcomes.filter((o): o is Extract<UpdateOutcome, { ok: false }> => !o.ok);
  if (!failed.length) {
    const one = done.length === 1 ? done[0] : null;
    return one
      ? { tone: "ok", title: `${one.name} updated`, desc: `Version ${one.version} is installed. Visualize draws it now.`, timeout: 6000 }
      : { tone: "ok", title: `${done.length} worlds updated`, desc: namesLine(done.map((o) => `${o.name} ${o.version}`)), timeout: 6000 };
  }
  const first = failed[0]!;
  const more = failed.length > 1 ? `${failed.length - 1} more not updated` : "";
  const ok = done.length ? `Updated: ${namesLine(done.map((o) => o.name))}` : "";
  return {
    tone: "danger",
    title: outcomes.length === 1 ? `${first.name} was not updated` : `${failed.length} of ${outcomes.length} world updates failed`,
    desc: outcomes.length === 1 ? first.reason : `${first.name}: ${first.reason}`,
    ...(more || ok ? { meta: [ok, more].filter(Boolean).join(". ") } : {}),
    timeout: 0,
    actions: [{ label: "OK" }],
  };
}

// ------------------------------------------------------------------------------------------ the controller

export interface WorldUpdatesDeps {
  provider: () => EntitlementProvider;
  pluginsList: () => Promise<PluginsListView | null>;
  installFromUrl: (url: string, expectId: string) => Promise<PluginInstallView | null>;
  /** The engine's announced keys; null when the engine did not answer (then nothing is announced). */
  loadAnnounced: () => Promise<string[] | null>;
  saveAnnounced: (keys: string[]) => Promise<unknown>;
  toast: (t: ToastOpts) => unknown;
  now: () => number;
}

/** pending: the list changed; busy: an update started or ended; installed: a world's new version is on disk. */
export type WorldUpdatesChange = "pending" | "busy" | "installed";

export interface WorldUpdates {
  /** The purchased worlds with an update, as of the last check. */
  pending(): readonly WorldUpdate[];
  /** An update of this world is in flight. */
  busy(id: string): boolean;
  /** Ask the store again (signed in only); resolves to the new pending list. */
  check(): Promise<readonly WorldUpdate[]>;
  /** Check, then toast the updates not announced before (once per world and version, remembered engine-side).
   *  True when it toasted. */
  announce(): Promise<boolean>;
  /** Install these worlds' updates one at a time through the store path, then toast the outcome. */
  update(ids: readonly string[]): Promise<UpdateOutcome[]>;
  /** Drop pending updates the installed versions already caught up with. */
  reconcile(installed: readonly { id: string; version: string }[]): void;
  onChange(fn: (why: WorldUpdatesChange) => void): () => void;
}

export function createWorldUpdates(deps: WorldUpdatesDeps): WorldUpdates {
  let pending: WorldUpdate[] = [];
  let seq = 0;
  const inFlight = new Set<string>();
  const listeners = new Set<(why: WorldUpdatesChange) => void>();
  const emit = (why: WorldUpdatesChange): void => { for (const fn of listeners) { try { fn(why); } catch { /* one listener never breaks another */ } } };
  const setPending = (next: WorldUpdate[]): void => {
    if (JSON.stringify(next) === JSON.stringify(pending)) return;
    pending = next;
    emit("pending");
  };

  async function check(): Promise<readonly WorldUpdate[]> {
    const mine = ++seq;
    const prov = deps.provider();
    let next: WorldUpdate[] = [];
    if (prov.configured()) {
      const auth = await prov.auth().catch(() => null);
      if (auth?.signedIn) {
        const list = await deps.pluginsList().catch(() => null);
        const rows = storeWorlds(list?.plugins ?? []);
        const ents = new Map(await Promise.all(rows.map(async (w) => [w.id, await prov.entitlement(w.id).catch(() => null)] as const)));
        next = pendingWorldUpdates(rows, ents, true, new Date(deps.now()).toISOString());
      }
    }
    if (mine === seq) setPending(next);
    return pending;
  }

  async function announce(): Promise<boolean> {
    const now = await check();
    if (!now.length) return false;
    const announced = await deps.loadAnnounced().catch(() => null);
    if (announced === null) return false;
    const fresh = unannounced(now, announced);
    if (!fresh.length) return false;
    await deps.saveAnnounced(rememberAnnounced(announced, fresh)).catch(() => null);
    const copy = availableCopy(now);
    deps.toast({
      tone: "info", ...copy, timeout: 0,
      actions: [{ label: "Update all", kind: "ok", run: () => void update(pending.map((u) => u.id)) }, { label: "Later" }],
    });
    return true;
  }

  async function update(ids: readonly string[]): Promise<UpdateOutcome[]> {
    const todo = ids.map((id) => pending.find((u) => u.id === id)).filter((u): u is WorldUpdate => !!u && !inFlight.has(u.id));
    if (!todo.length) return [];
    for (const u of todo) inFlight.add(u.id);
    emit("busy");
    const outcomes: UpdateOutcome[] = [];
    try {
      for (const u of todo) {
        const r = await installFromStore(u.id, { provider: deps.provider(), installFromUrl: deps.installFromUrl });
        inFlight.delete(u.id);
        if (r.ok) {
          outcomes.push({ id: u.id, name: u.name, ok: true, version: r.version });
          pending = pending.filter((x) => x.id !== u.id || isNewerVersion(x.to, r.version));
          emit("installed");
        } else {
          outcomes.push({ id: u.id, name: u.name, ok: false, reason: r.reason });
          emit("busy");
        }
      }
    } finally {
      for (const u of todo) inFlight.delete(u.id);
    }
    deps.toast(outcomeToast(outcomes));
    return outcomes;
  }

  return {
    pending: () => pending,
    busy: (id) => inFlight.has(id),
    check,
    announce,
    update,
    reconcile: (installed) => setPending(reconcileUpdates(pending, installed)),
    onChange: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}
