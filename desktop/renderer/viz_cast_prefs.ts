// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_cast_prefs.ts - P-WORLDS.CAST2 (ADR-0650): the user's cast preferences for world figures.
//
// Persisted under CAST_KEY as `{ fleet, pinned: { [nodeId]: pin } }` (in the store viz_view passes, engine-kept
// since P-VIZ.PREFS1), shared by every world, so a look follows the lane (or the hub) across worlds and restarts.
//   fleet:  the mode ("balanced", the default: viz_cast's balanced sequence; "same": every human figure takes the
//           fleet's skin step, hair style and hair color), and the undertone every unpinned skin is drawn in.
//   pinned: a node's own look (the View panel's "Customize look"): any of presentation, skin step, undertone,
//           hair style and hair color. A pin wins over the fleet (viz_cast.applyCastPrefs).
// parseCastPrefs keeps only what is valid (a missing key, bad JSON or an older shape is the default; each field
// falls back on its own), so a stored value can never cast an unknown style or a free hex color. Pure but for
// loadCastPrefs and saveCastPrefs; values are frozen, every change returns a new object.

import { HAIR_COLORS, HAIR_STYLES, HAIR_SWATCHES, SKIN_RAMP, UNDERTONES, hairSuits, type HairStyle, type Presentation, type Undertone } from "./viz_cast.ts";

export const CAST_KEY = "lucid.viz.cast.v1";
/** Pins kept at most; the least recently set go first. */
export const PINS_MAX = 200;
const ID_MAX = 200;

export type CastMode = "balanced" | "same";
export interface FleetCast { mode: CastMode; skin: number; undertone: Undertone; hair: HairStyle; hairColor: string }
export interface CastPin { presentation?: Presentation; skin?: number; undertone?: Undertone; hair?: HairStyle; hairColor?: string }
export interface CastPrefs { readonly fleet: Readonly<FleetCast>; readonly pinned: Readonly<Record<string, Readonly<CastPin>>> }

export const PRESENTATIONS: readonly { readonly id: Presentation; readonly label: string }[] = Object.freeze([
  { id: "feminine", label: "Feminine" }, { id: "masculine", label: "Masculine" }, { id: "neutral", label: "Neutral" },
] as const);

const FLEET_DEFAULTS: FleetCast = { mode: "balanced", skin: 4, undertone: "neutral", hair: "short", hairColor: HAIR_COLORS[2]! };
export const DEFAULT_FLEET: Readonly<FleetCast> = Object.freeze(FLEET_DEFAULTS);
const EMPTY_PINS: Record<string, Readonly<CastPin>> = {};
const NO_PINS: Readonly<Record<string, Readonly<CastPin>>> = Object.freeze(EMPTY_PINS);

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isSkin = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < SKIN_RAMP.length;
const isUndertone = (v: unknown): v is Undertone => UNDERTONES.some((u) => u.id === v);
const isPresentation = (v: unknown): v is Presentation => PRESENTATIONS.some((p) => p.id === v);
const isHair = (v: unknown): v is HairStyle => HAIR_STYLES.some((h) => h.id === v);
const isHairColor = (v: unknown): v is string => HAIR_SWATCHES.some((s) => s.value === v);

export function defaultCastPrefs(): CastPrefs {
  return Object.freeze({ fleet: DEFAULT_FLEET, pinned: NO_PINS });
}

function parseFleet(v: unknown): Readonly<FleetCast> {
  if (!isRec(v)) return DEFAULT_FLEET;
  const fleet: FleetCast = {
    mode: v.mode === "same" ? "same" : "balanced",
    skin: isSkin(v.skin) ? v.skin : DEFAULT_FLEET.skin,
    undertone: isUndertone(v.undertone) ? v.undertone : DEFAULT_FLEET.undertone,
    hair: isHair(v.hair) ? v.hair : DEFAULT_FLEET.hair,
    hairColor: isHairColor(v.hairColor) ? v.hairColor : DEFAULT_FLEET.hairColor,
  };
  return Object.freeze(fleet);
}

/** A pin's valid fields (a hair style that does not suit its pinned presentation is dropped); null when none. */
export function parsePin(v: unknown): Readonly<CastPin> | null {
  if (!isRec(v)) return null;
  const pin: CastPin = {};
  if (isPresentation(v.presentation)) pin.presentation = v.presentation;
  if (isSkin(v.skin)) pin.skin = v.skin;
  if (isUndertone(v.undertone)) pin.undertone = v.undertone;
  if (isHair(v.hair) && (!pin.presentation || hairSuits(v.hair, pin.presentation))) pin.hair = v.hair;
  if (isHairColor(v.hairColor)) pin.hairColor = v.hairColor;
  return Object.keys(pin).length ? Object.freeze(pin) : null;
}

/** Whatever was stored, as valid preferences. */
export function parseCastPrefs(raw: unknown): CastPrefs {
  if (!isRec(raw)) return defaultCastPrefs();
  const pins: [string, Readonly<CastPin>][] = [];
  if (isRec(raw.pinned)) {
    for (const [id, v] of Object.entries(raw.pinned)) {
      const pin = id && id.length <= ID_MAX ? parsePin(v) : null;
      if (pin) pins.push([id, pin]);
    }
  }
  // Object.fromEntries defines own data properties, so an id like "__proto__" is just a key.
  return Object.freeze({ fleet: parseFleet(raw.fleet), pinned: Object.freeze(Object.fromEntries(pins.slice(-PINS_MAX))) });
}

type Store = Pick<Storage, "getItem" | "setItem">;

export function loadCastPrefs(storage: Store): CastPrefs {
  try { return parseCastPrefs(JSON.parse(storage.getItem(CAST_KEY) ?? "null")); } catch { return defaultCastPrefs(); }
}

export function saveCastPrefs(storage: Store, prefs: CastPrefs): void {
  try { storage.setItem(CAST_KEY, JSON.stringify(prefs)); } catch { /* still applies for this session */ }
}

/** The preferences with fleet fields changed (invalid values are ignored). */
export function withFleet(prefs: CastPrefs, patch: Partial<FleetCast>): CastPrefs {
  return Object.freeze({ fleet: parseFleet({ ...prefs.fleet, ...patch }), pinned: prefs.pinned });
}

/** The node's pin, or null. */
export function pinOf(prefs: CastPrefs, id: string): Readonly<CastPin> | null {
  return Object.prototype.hasOwnProperty.call(prefs.pinned, id) ? prefs.pinned[id]! : null;
}

/** The preferences with the node's pin replaced (null, or a pin with no valid field, removes it). A pin set last
 *  is kept longest. */
export function withPin(prefs: CastPrefs, id: string, pin: CastPin | null): CastPrefs {
  const next = Object.entries(prefs.pinned).filter(([k]) => k !== id);
  const p = pin && id && id.length <= ID_MAX ? parsePin(pin) : null;
  if (p) next.push([id, p]);
  return Object.freeze({ fleet: prefs.fleet, pinned: Object.freeze(Object.fromEntries(next.slice(-PINS_MAX))) });
}
