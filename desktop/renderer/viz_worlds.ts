// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_worlds.ts - P-WORLDS.1 (ADR-0648): the Lucid Agent Worlds registry for Visualize.
//
// loadWorlds lists the installed world packages (engine GET /api/worlds), imports each one's module from its
// same-origin URL (/worlds/<id>/<version>/world.js), calls its default export with the host (viz_world_kit) and
// VALIDATES what it returns (validateWorld: the contract version, the id, exactly three throwables with unique
// kinds and plain SVG path icons, the storm, the options and their defaults, the environment, the cast roles (v2,
// ADR-0649) and the factories). A module built for any apiVersion up to WORLD_API_VERSION loads. v2 (ADR-0652):
// edges may be "plasma-light" with a packet token, and environmentFor(options) must be a function whose patch for
// the default options validates; worldEnvironment merges it over the environment for the user's values.
// A world that fails to load or validate is still listed, with its error, and is never offered.
//
// Activation (the store's rule, market_gate's provider): with no provider configured a world is allowed. With one,
// a fresh receipt (an entitlement seen active within RECEIPT_TTL_MS, kept in localStorage RECEIPTS_KEY so an
// offline machine keeps working) allows it without asking; otherwise the signed-in user's entitlement is checked
// once (harness/market/entitlement.decidePackAction) and an active one writes the receipt. Not signed in or not
// entitled: the world shows as "Get" (the view opens the store) instead of being selected.
//
// A world's option values persist per world id under OPTIONS_KEY; mergeOptions keeps only values valid for the
// option (a saved color, a choice or swatch still offered, a boolean), anything else falls back to the default.
// Pure helpers are exported for viz_worlds.test.ts; only loadWorlds and the storage helpers touch the outside.

import { decidePackAction, type AuthState, type Entitlement } from "../../harness/market/entitlement.ts";
import type { EntitlementProvider } from "./market_gate.ts";
import type { VizStyle } from "./viz_model.ts";
import {
  WORLD_API_VERSION, worldKey, type InstalledWorld, type WorldDefinition, type WorldEdges, type WorldEnvironment, type WorldHost, type WorldOption,
  type WorldOptionValues,
} from "./viz_world_api.ts";

export const RECEIPTS_KEY = "lucid.worlds.receipts.v1";
export const OPTIONS_KEY = "lucid.worlds.options.v1";
/** An entitlement seen active keeps the world usable this long without asking again (offline machines). */
export const RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** SVG path data only: commands, numbers, separators. No markup, no exponents, no units. */
const ICON_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9 ,.\-]+$/;
const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** allowed: selectable; signin / checkout: the store sells it (the view shows "Get"). */
export type WorldAccess = "allowed" | "signin" | "checkout";

export interface WorldEntry {
  readonly installed: InstalledWorld;
  /** The key ("christmas"), or the package id when it is not a world id (then `error` says so). */
  readonly key: string;
  readonly style: VizStyle;
  /** The world's label once loaded, else the package name. */
  readonly label: string;
  readonly tagline: string;
  /** Null when it failed to load or validate. */
  readonly def: WorldDefinition | null;
  readonly error: string | null;
  readonly access: WorldAccess;
}

/** True when the entry can be selected now. */
export function worldUsable(e: WorldEntry): e is WorldEntry & { def: WorldDefinition } {
  return !!e.def && !e.error && e.access === "allowed";
}

// ------------------------------------------------------------------------------------------ style ids

export function worldStyle(key: string): VizStyle { return `world:${key}`; }

/** "world:christmas" -> "christmas"; a built-in style or a malformed id -> null. */
export function worldKeyOfStyle(style: string): string | null {
  if (!style.startsWith("world:")) return null;
  const key = style.slice(6);
  return KEY_RE.test(key) ? key : null;
}

/** A saved style preference: a built-in, or a well-formed world id (whether it is still installed is decided
 *  once the worlds load); anything else is "anime". */
export function parseStyle(raw: unknown): VizStyle {
  if (raw === "anime" || raw === "professional") return raw;
  if (typeof raw === "string") { const key = worldKeyOfStyle(raw); if (key) return worldStyle(key); }
  return "anime";
}

// ------------------------------------------------------------------------------------------ validation

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isFn = (v: unknown): boolean => typeof v === "function";
const isIcon = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0 && ICON_RE.test(v);

function checkOption(o: unknown, i: number): string | null {
  if (!isRec(o)) return `option ${i + 1} is not an object`;
  if (!nonEmpty(o.key)) return `option ${i + 1} has no key`;
  if (!nonEmpty(o.label)) return `option "${o.key}" has no label`;
  switch (o.type) {
    case "color":
      return typeof o.default === "string" && COLOR_RE.test(o.default) ? null : `option "${o.key}" default is not a #rrggbb color`;
    case "toggle":
      return typeof o.default === "boolean" ? null : `option "${o.key}" default is not true or false`;
    case "select": {
      if (!Array.isArray(o.choices) || !o.choices.length) return `option "${o.key}" has no choices`;
      const values = new Set<string>();
      for (const c of o.choices) {
        if (!isRec(c) || !nonEmpty(c.value) || !nonEmpty(c.label)) return `option "${o.key}" has a malformed choice`;
        if (values.has(c.value)) return `option "${o.key}" repeats the choice "${c.value}"`;
        values.add(c.value);
      }
      return typeof o.default === "string" && values.has(o.default) ? null : `option "${o.key}" default is not one of its choices`;
    }
    case "swatch": { // P-WORLDS.CAST2 (ADR-0650): a named ramp of #rrggbb colors
      if (!Array.isArray(o.swatches) || !o.swatches.length) return `option "${o.key}" has no swatches`;
      const values = new Set<string>();
      for (const s of o.swatches) {
        if (!isRec(s) || typeof s.value !== "string" || !COLOR_RE.test(s.value) || !nonEmpty(s.label)) return `option "${o.key}" has a malformed swatch (a #rrggbb value and a label)`;
        if (values.has(s.value)) return `option "${o.key}" repeats the swatch "${s.value}"`;
        values.add(s.value);
      }
      return typeof o.default === "string" && values.has(o.default) ? null : `option "${o.key}" default is not one of its swatches`;
    }
    default:
      return `option "${o.key}" has an unknown type`;
  }
}

const EDGE_STYLES: readonly string[] = ["plasma", "fiber", "plasma-light"];
const TOKENS: readonly string[] = ["orb", "coin", "petal", "snowflake", "spark", "custom"];

/** What is wrong with an environment (the base one, or one merged with environmentFor's patch), or null. */
export function environmentError(e: unknown): string | null {
  if (!isRec(e)) return "the environment is missing";
  if (typeof e.light !== "boolean") return "environment.light is not true or false";
  if (!isFn(e.paintSky)) return "environment.paintSky is not a function";
  const fog = e.fog;
  if (!isRec(fog) || typeof fog.color !== "string" || !COLOR_RE.test(fog.color) || typeof fog.density !== "number" || !Number.isFinite(fog.density) || fog.density < 0) return "environment.fog is malformed";
  const edges = e.edges;
  if (!isRec(edges) || typeof edges.style !== "string" || !EDGE_STYLES.includes(edges.style)) return "environment.edges.style is not plasma, plasma-light or fiber";
  if (typeof edges.colorA !== "string" || !COLOR_RE.test(edges.colorA) || typeof edges.colorB !== "string" || !COLOR_RE.test(edges.colorB)) return "environment.edges colors are not #rrggbb";
  // P-WORLDS.FX1 (ADR-0652): the packet token, its color and its painters
  if (edges.token !== undefined && (typeof edges.token !== "string" || !TOKENS.includes(edges.token))) return "environment.edges.token is not orb, coin, petal, snowflake, spark or custom";
  if (edges.tokenColor !== undefined && (typeof edges.tokenColor !== "string" || !COLOR_RE.test(edges.tokenColor))) return "environment.edges.tokenColor is not a #rrggbb color";
  if (edges.paintToken !== undefined && !isFn(edges.paintToken)) return "environment.edges.paintToken is not a function";
  if (edges.tokenStamp !== undefined && !isFn(edges.tokenStamp)) return "environment.edges.tokenStamp is not a function";
  if (edges.token === "custom" && !isFn(edges.paintToken)) return "environment.edges.token custom needs paintToken";
  if (typeof e.chargeColor !== "string" || !COLOR_RE.test(e.chargeColor)) return "environment.chargeColor is not a #rrggbb color";
  if (e.createAmbient !== undefined && !isFn(e.createAmbient)) return "environment.createAmbient is not a function";
  return null;
}

/** P-WORLDS.FX1 (ADR-0652): `patch` (what environmentFor returned) over `base`. Only light, paintSky, fog, edges
 *  and chargeColor are taken; fog and edges merge field by field (a patch may change only the colors). The
 *  merged environment must validate. */
export function mergeEnvironment(base: WorldEnvironment, patch: unknown): { ok: true; env: WorldEnvironment } | { ok: false; error: string } {
  if (patch === undefined || patch === null) return { ok: true, env: base };
  if (!isRec(patch)) return { ok: false, error: "environmentFor did not return an object" };
  if (patch.fog !== undefined && !isRec(patch.fog)) return { ok: false, error: "environmentFor's fog is not an object" };
  if (patch.edges !== undefined && !isRec(patch.edges)) return { ok: false, error: "environmentFor's edges is not an object" };
  const env: WorldEnvironment = {
    ...base,
    ...(patch.light !== undefined ? { light: patch.light as boolean } : {}),
    ...(patch.paintSky !== undefined ? { paintSky: patch.paintSky as WorldEnvironment["paintSky"] } : {}),
    ...(patch.chargeColor !== undefined ? { chargeColor: patch.chargeColor as string } : {}),
    fog: patch.fog ? { ...base.fog, ...(patch.fog as Partial<WorldEnvironment["fog"]>) } : base.fog,
    edges: patch.edges ? { ...base.edges, ...(patch.edges as Partial<WorldEdges>) } : base.edges,
  };
  const err = environmentError(env);
  return err ? { ok: false, error: `environmentFor: ${err}` } : { ok: true, env };
}

/** The world's environment for the user's option values: environmentFor's patch merged over `environment`. A
 *  patch that throws or does not validate for these values leaves the base environment (validateWorld already
 *  refused a world whose patch fails for its defaults). */
export function worldEnvironment(def: WorldDefinition, options: WorldOptionValues): WorldEnvironment {
  if (!def.environmentFor) return def.environment;
  let patch: unknown;
  try { patch = def.environmentFor(options); } catch (e) {
    console.warn(`[viz] world "${def.id}" environmentFor failed`, e);
    return def.environment;
  }
  const m = mergeEnvironment(def.environment, patch);
  if (m.ok) return m.env;
  console.warn(`[viz] world "${def.id}": ${m.error}`);
  return def.environment;
}

/** Check what a world module returned against the contract and the package it came in. */
export function validateWorld(def: unknown, installed: InstalledWorld): { ok: true; def: WorldDefinition } | { ok: false; error: string } {
  const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });
  if (!(installed.apiVersion <= WORLD_API_VERSION)) return bad(`built for a newer Visualize (world API ${installed.apiVersion}, this app has ${WORLD_API_VERSION}); update LUCID`);
  if (!isRec(def)) return bad("the module did not return a world");
  if (typeof def.apiVersion !== "number" || !Number.isInteger(def.apiVersion) || def.apiVersion < 1) return bad("apiVersion is missing");
  if (def.apiVersion > WORLD_API_VERSION) return bad(`built for a newer Visualize (world API ${def.apiVersion}, this app has ${WORLD_API_VERSION}); update LUCID`);
  const key = worldKey(installed.id);
  if (!key) return bad(`"${installed.id}" is not a world package id`);
  if (def.id !== key) return bad(`its id "${String(def.id)}" does not match the package "${installed.id}"`);
  if (!nonEmpty(def.label)) return bad("label is missing");
  if (!nonEmpty(def.tagline)) return bad("tagline is missing");
  if (!Array.isArray(def.throws) || def.throws.length !== 3) return bad("it must offer exactly three throwables");
  const kinds = new Set<string>();
  for (const t of def.throws as unknown[]) {
    if (!isRec(t) || !nonEmpty(t.kind)) return bad("a throwable has no kind");
    if (t.kind === "storm") return bad(`the throwable kind "storm" is reserved`);
    if (kinds.has(t.kind)) return bad(`the throwable kind "${t.kind}" is repeated`);
    kinds.add(t.kind);
    if (!nonEmpty(t.label) || !nonEmpty(t.tip)) return bad(`throwable "${t.kind}" has no label or tip`);
    if (!isIcon(t.icon)) return bad(`throwable "${t.kind}" icon is not plain SVG path data`);
  }
  const storm = def.storm;
  if (!isRec(storm) || !nonEmpty(storm.label) || !nonEmpty(storm.tip)) return bad("the storm is missing its label or tip");
  if (!isIcon(storm.icon)) return bad("the storm icon is not plain SVG path data");
  if (!Array.isArray(def.options)) return bad("options is not a list");
  const optKeys = new Set<string>();
  for (let i = 0; i < def.options.length; i++) {
    const o = def.options[i] as unknown;
    const err = checkOption(o, i);
    if (err) return bad(err);
    if (!isRec(o) || typeof o.key !== "string") return bad(`option ${i + 1} has no key`);
    if (optKeys.has(o.key)) return bad(`option "${o.key}" is repeated`);
    optKeys.add(o.key);
  }
  const envErr = environmentError(def.environment);
  if (envErr) return bad(envErr);
  // P-WORLDS.FX1 (ADR-0652): environmentFor is a function whose patch for the default options validates
  if (def.environmentFor !== undefined) {
    if (typeof def.environmentFor !== "function") return bad("environmentFor is not a function");
    let patch: unknown;
    try { patch = (def.environmentFor as (o: WorldOptionValues) => unknown).call(def, optionDefaults(def.options as WorldOption[])); } catch (e) {
      return bad(`environmentFor failed: ${errText(e)}`);
    }
    const merged = mergeEnvironment(def.environment as unknown as WorldEnvironment, patch);
    if (!merged.ok) return bad(merged.error);
  }
  // P-WORLDS.CAST1 (ADR-0649): which roles are people; anything but "human" or "creature" per role is refused.
  if (def.castRoles !== undefined) {
    if (!isRec(def.castRoles)) return bad("castRoles is not an object");
    for (const [role, cast] of Object.entries(def.castRoles)) {
      if (role !== "hub" && role !== "agent" && role !== "subagent") return bad(`castRoles has an unknown role "${role}"`);
      if (cast !== undefined && cast !== "human" && cast !== "creature") return bad(`castRoles.${role} is not human or creature`);
    }
  }
  if (!isFn(def.createFigure)) return bad("createFigure is not a function");
  if (!isFn(def.createProjectile)) return bad("createProjectile is not a function");
  if (!isFn(def.createStorm)) return bad("createStorm is not a function");
  if (def.createStage !== undefined && !isFn(def.createStage)) return bad("createStage is not a function");
  return { ok: true, def: def as unknown as WorldDefinition };
}

// ------------------------------------------------------------------------------------------ options

export function optionDefaults(options: readonly WorldOption[]): WorldOptionValues {
  const out: Record<string, string | boolean> = {};
  for (const o of options) out[o.key] = o.default;
  return Object.freeze(out);
}

/** The saved values that are still valid for each option; the default for the rest. Unknown keys are dropped. */
export function mergeOptions(options: readonly WorldOption[], saved: unknown): WorldOptionValues {
  const src = isRec(saved) ? saved : {};
  const out: Record<string, string | boolean> = {};
  for (const o of options) {
    const v = src[o.key];
    let ok = false;
    if (o.type === "color") ok = typeof v === "string" && COLOR_RE.test(v);
    else if (o.type === "toggle") ok = typeof v === "boolean";
    else if (o.type === "swatch") ok = typeof v === "string" && o.swatches.some((s) => s.value === v);
    else ok = typeof v === "string" && o.choices.some((c) => c.value === v);
    out[o.key] = ok ? (v as string | boolean) : o.default;
  }
  return Object.freeze(out);
}

type Store = Pick<Storage, "getItem" | "setItem">;

function readJson(storage: Store, key: string): Rec {
  try { const v: unknown = JSON.parse(storage.getItem(key) ?? "{}"); return isRec(v) ? v : {}; } catch { return {}; }
}

function writeJson(storage: Store, key: string, v: Rec): void {
  try { storage.setItem(key, JSON.stringify(v)); } catch { /* still applies for this session */ }
}

/** A world's option values on this machine (by world id), merged over its defaults. */
export function loadOptions(storage: Store, def: WorldDefinition): WorldOptionValues {
  return mergeOptions(def.options, readJson(storage, OPTIONS_KEY)[def.id]);
}

/** Save one option value; returns the world's merged values after it. */
export function saveOption(storage: Store, def: WorldDefinition, key: string, value: string | boolean): WorldOptionValues {
  const all = readJson(storage, OPTIONS_KEY);
  const prev = all[def.id];
  const cur = isRec(prev) ? prev : {};
  const merged = mergeOptions(def.options, { ...cur, [key]: value });
  all[def.id] = { ...merged };
  writeJson(storage, OPTIONS_KEY, all);
  return merged;
}

// ------------------------------------------------------------------------------------------ receipts + access

export interface WorldReceipt { at: number }

/** True when `r` is a receipt seen within RECEIPT_TTL_MS of `now` (a receipt from the future is not trusted). */
export function receiptFresh(r: unknown, now: number): boolean {
  if (!isRec(r) || typeof r.at !== "number" || !Number.isFinite(r.at)) return false;
  const age = now - r.at;
  return age >= 0 && age < RECEIPT_TTL_MS;
}

/** The access decision from what the provider said (pure; `auth`/`ent` null when unknown). */
export function decideWorldAccess(configured: boolean, receipt: unknown, auth: AuthState | null, ent: Entitlement | null, now: number): WorldAccess {
  if (!configured || receiptFresh(receipt, now)) return "allowed";
  const action = decidePackAction(auth, ent, new Date(now).toISOString());
  return action === "pull" ? "allowed" : action;
}

/** Whether this machine may use the world now; asks the provider only when there is no fresh receipt, and keeps
 *  a receipt when the entitlement is active. */
export async function worldAccess(packageId: string, provider: EntitlementProvider, storage: Store, now: number): Promise<WorldAccess> {
  if (!provider.configured()) return "allowed";
  const receipts = readJson(storage, RECEIPTS_KEY);
  if (receiptFresh(receipts[packageId], now)) return "allowed";
  const auth = await provider.auth().catch((): AuthState | null => null);
  const ent = auth?.signedIn ? await provider.entitlement(packageId).catch((): Entitlement | null => null) : null;
  const access = decideWorldAccess(true, null, auth, ent, now);
  if (access === "allowed") { receipts[packageId] = { at: now } satisfies WorldReceipt; writeJson(storage, RECEIPTS_KEY, receipts); }
  return access;
}

// ------------------------------------------------------------------------------------------ loading

export interface WorldsDeps {
  /** The installed worlds (bridge.worldsList). */
  list(): Promise<InstalledWorld[]>;
  /** Import a module by URL (the view passes a dynamic import the bundler leaves alone). */
  importModule(url: string): Promise<unknown>;
  host: WorldHost;
  provider: EntitlementProvider;
  storage: Store;
  now(): number;
  /** The last load's entries: a world whose module URL (id and version) is unchanged keeps its definition
   *  (a selected world is not rebuilt by a refresh); access is checked again. */
  previous?: readonly WorldEntry[];
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function loadOne(w: InstalledWorld, d: WorldsDeps): Promise<WorldEntry> {
  const key = worldKey(w.id);
  const base = { installed: w, key: key ?? w.id, style: worldStyle(key ?? w.id), label: w.name || w.id, tagline: "" };
  const broken = (error: string): WorldEntry => ({ ...base, def: null, error, access: "allowed" });
  if (!key) return broken(`"${w.id}" is not a world package id`);
  if (!(w.apiVersion <= WORLD_API_VERSION)) return broken(`built for a newer Visualize (world API ${w.apiVersion}, this app has ${WORLD_API_VERSION}); update LUCID`);
  const prev = d.previous?.find((p) => p.installed.id === w.id && p.installed.module === w.module && p.def);
  if (prev?.def) {
    const access = await worldAccess(w.id, d.provider, d.storage, d.now());
    return { ...base, label: prev.def.label, tagline: prev.def.tagline, def: prev.def, error: null, access };
  }
  let raw: unknown;
  try {
    const mod = await d.importModule(w.module);
    const make = isRec(mod) ? mod.default : undefined;
    if (typeof make !== "function") return broken("the module has no default export");
    raw = (make as (host: WorldHost) => unknown)(d.host);
  } catch (e) {
    return broken(`it failed to load: ${errText(e)}`);
  }
  const v = validateWorld(raw, w);
  if (!v.ok) return broken(v.error);
  const access = await worldAccess(w.id, d.provider, d.storage, d.now());
  return { ...base, label: v.def.label, tagline: v.def.tagline, def: v.def, error: null, access };
}

/** Every installed world, loaded and validated, in label order. Never throws: a failed list is an empty one. */
export async function loadWorlds(d: WorldsDeps): Promise<WorldEntry[]> {
  let list: InstalledWorld[];
  try { list = await d.list(); } catch { return []; }
  const out = await Promise.all(list.map((w) => loadOne(w, d)));
  return out.sort((a, b) => a.label.localeCompare(b.label));
}
