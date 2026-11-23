// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/plugin_restore.ts - P-WORLDS.HEAL1: what to do about purchases the engine could not put back.
//
// The engine records every store install and world import in its install ledger and, at start, restores a missing or
// damaged one from its verified backup (desktop/plugins/restore.ts). What is still missing after that "needs the
// store": the Plugins drawer (plugins_flyout.ts restorePurchases) asks the store about each one and planRestore
// decides, fail-closed: entitled -> reinstall through the normal store install; signed out -> ask to sign in; the store
// not reachable -> say so and offer Retry; answered but not on the account any more -> say so once and stop asking
// (only Restore purchases asks again); not a store item -> only its own file can bring it back. The toast copy is here
// too, so the decision and the words stay in one tested place. Pure: no DOM, no fetch, no storage.

import { isEntitled, type Entitlement } from "../../harness/market/entitlement.ts";
import type { PluginHealthItem, PluginKind, PluginRepairView } from "./bridge.ts";
import { PREMIUM_PLUGINS, isBundle, type SoldPlugin } from "./plugin_catalog.ts";

/** localStorage: the newest engine repair already announced (an ISO time), so "Repaired N" shows once. */
export const REPAIRS_SEEN_KEY = "lucid.plugins.repairs-seen.v1";
/** localStorage: ids the user was told can no longer be restored automatically; automatic runs skip them. */
export const RESTORE_GIVEN_UP_KEY = "lucid.plugins.restore-given-up.v1";

/** The store card an id restores from: a sold, available store item with a package (a world pack has none), else null. */
export function restorableStoreItem(id: string): SoldPlugin | null {
  const p = PREMIUM_PLUGINS.find((x) => x.id === id);
  return p && p.sale === "buy" && p.available && !isBundle(p) ? p : null;
}

/** What the store said about one id: an entitlement record (null: none on the account) or that it could not answer. */
export type EntitlementAnswer = Entitlement | null | "unreachable";

export interface RestoreFacts {
  signedIn: boolean;
  /** A store is set up in this build and the machine reports a network. */
  storeReachable: boolean;
  /** The store's answer per id (asked only when signed in and reachable); a missing answer reads as unreachable. */
  entitlements: ReadonlyMap<string, EntitlementAnswer>;
  nowIso: string;
  /** Ids already reported as not restorable; an automatic run skips them, Restore purchases (`manual`) asks again. */
  givenUp: ReadonlySet<string>;
  manual: boolean;
}

export interface RestorePlan {
  /** Entitled: reinstall from the store now. */
  install: string[];
  /** Signed out: the account is needed first. */
  signin: string[];
  /** The store could not be asked (no store in this build, offline, or the lookup failed). */
  offline: string[];
  /** The store answered: no active entitlement any more. */
  notEntitled: string[];
  /** Not sold in the store: only its own package file restores it. */
  notInStore: string[];
}

/** Decide, per purchase still not whole on disk, how it comes back. Pure. */
export function planRestore(items: readonly Pick<PluginHealthItem, "id" | "status">[], f: RestoreFacts): RestorePlan {
  const plan: RestorePlan = { install: [], signin: [], offline: [], notEntitled: [], notInStore: [] };
  for (const it of items) {
    if (it.status === "ok") continue;
    if (!f.manual && f.givenUp.has(it.id)) continue;
    if (!restorableStoreItem(it.id)) { plan.notInStore.push(it.id); continue; }
    if (!f.storeReachable) { plan.offline.push(it.id); continue; }
    if (!f.signedIn) { plan.signin.push(it.id); continue; }
    const a = f.entitlements.get(it.id);
    if (a === undefined || a === "unreachable") plan.offline.push(it.id);
    else if (isEntitled(a, f.nowIso)) plan.install.push(it.id);
    else plan.notEntitled.push(it.id);
  }
  return plan;
}

/** "Lucid Agent World(s)" when every item is a world, "plugin(s)" when none is, else "purchase(s)". */
export function purchaseNoun(kinds: readonly PluginKind[]): string {
  const n = kinds.length;
  const worlds = kinds.filter((k) => k === "world").length;
  const base = worlds === n ? "Lucid Agent World" : worlds === 0 ? "plugin" : "purchase";
  return n === 1 ? base : `${base}s`;
}

/** "A", "A and B", "A, B and C", "A, B, C and 2 more". */
export function nameList(names: readonly string[], max = 3): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length > max) return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export interface RestoreCopy { title: string; desc: string }

/** The store reinstalled these. */
export function restoredCopy(items: readonly { name: string; kind: PluginKind }[]): RestoreCopy {
  const noun = purchaseNoun(items.map((i) => i.kind));
  return { title: `Restored ${items.length} ${noun}`, desc: `${nameList(items.map((i) => i.name))} ${items.length === 1 ? "was" : "were"} missing or damaged and ${items.length === 1 ? "is" : "are"} reinstalled from the LUCID store.` };
}

/** The engine reinstalled these from their verified backups. */
export function repairedCopy(repairs: readonly { name: string; kind: PluginKind }[]): RestoreCopy {
  const noun = purchaseNoun(repairs.map((r) => r.kind));
  return {
    title: `Repaired ${repairs.length} ${noun} after an update`,
    desc: `${nameList(repairs.map((r) => r.name))} ${repairs.length === 1 ? "was" : "were"} missing or damaged on disk. LUCID put ${repairs.length === 1 ? "it" : "them"} back from the copy it kept at install, after checking the signature, checksums and security scan again.`,
  };
}

/** Still not restored: signed out, or the store not reachable. */
export function pendingCopy(names: readonly string[], signedOut: boolean): RestoreCopy {
  const n = names.length;
  return {
    title: `${n} purchased ${n === 1 ? "item needs" : "items need"} restoring`,
    desc: signedOut
      ? `${nameList(names)} ${n === 1 ? "is" : "are"} missing or damaged on this machine. Sign in with the account that bought ${n === 1 ? "it" : "them"} and LUCID reinstalls ${n === 1 ? "it" : "them"} from the store.`
      : `${nameList(names)} ${n === 1 ? "is" : "are"} missing or damaged on this machine, and the LUCID store could not be reached to reinstall ${n === 1 ? "it" : "them"}. Check your connection, then Retry.`,
  };
}

/** The store answered that these are not on the account any more. */
export function notEntitledCopy(names: readonly string[]): RestoreCopy {
  const n = names.length;
  return {
    title: n === 1 ? `${names[0]} is no longer on your account` : `${n} items are no longer on your account`,
    desc: `${nameList(names)} ${n === 1 ? "is" : "are"} missing or damaged on this machine, and the account you are signed in with no longer owns ${n === 1 ? "it" : "them"}, so LUCID cannot reinstall ${n === 1 ? "it" : "them"} and will not keep trying. Sign in with the account that bought ${n === 1 ? "it" : "them"}, or buy ${n === 1 ? "it" : "them"} again from the Premium tab, then press Restore purchases on the Installed tab.`,
  };
}

/** Not sold in the store: the user's own file brings it back. */
export function notInStoreCopy(names: readonly string[]): RestoreCopy {
  const n = names.length;
  return {
    title: `${n} ${n === 1 ? "item" : "items"} could not be restored`,
    desc: `${nameList(names)} ${n === 1 ? "is" : "are"} missing or damaged and not sold in the LUCID store. Import ${n === 1 ? "its" : "their"} package file again (Plugins, Import world file) to put ${n === 1 ? "it" : "them"} back.`,
  };
}

/** The engine repairs not announced yet: newer than the stored marker. Pure. */
export function unseenRepairs(repairs: readonly PluginRepairView[], seenAt: string | null): PluginRepairView[] {
  return repairs.filter((r) => !seenAt || r.at > seenAt);
}

/** The newest repair time, the marker to store once they are announced. */
export function newestRepairAt(repairs: readonly PluginRepairView[], seenAt: string | null): string | null {
  return repairs.reduce<string | null>((m, r) => (!m || r.at > m ? r.at : m), seenAt);
}

/** A stored id list (RESTORE_GIVEN_UP_KEY); anything malformed reads as empty. */
export function parseIdList(raw: string | null | undefined): Set<string> {
  try {
    const v: unknown = JSON.parse(raw ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(x)) : []);
  } catch { return new Set(); }
}
