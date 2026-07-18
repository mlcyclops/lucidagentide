// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/share_dock.ts — P-SHARE.1 (ADR-0232): the PURE geometry + persisted state for the floating
// Session Share DOCK. The Share panel used to be a centered blocking modal; it's now a movable/resizable
// popover that snaps beside the rails, minimizes to a bottom-right pill, and remembers its shape + which
// sections the user collapsed. All the math + persistence lives here (DOM-free) so it's unit-tested headless;
// app.ts owns the pointer wiring + DOM.

/** The dock's on-screen rectangle (viewport px). */
export interface DockShape { x: number; y: number; w: number; h: number }
/** Where the dock is anchored: freely floating, or snapped beside the left rails / to the right frame. */
export type DockSide = "float" | "left" | "right";
/** Everything persisted between sessions: shape, minimized-to-pill, snap side, and per-section collapse. */
export interface DockState { shape: DockShape; minimized: boolean; side: DockSide; collapsed: Record<string, boolean> }

export const DOCK_MIN_W = 296;
export const DOCK_MIN_H = 200;
export const DOCK_DEF_W = 372;
export const DOCK_DEF_H = 496;
/** How close (px) a dragged edge must get to a frame to snap to it. */
export const SNAP_PX = 40;
const MARGIN = 12;

function num(v: unknown, fallback: number): number { const n = Number(v); return Number.isFinite(n) ? n : fallback; }

/** The first-open placement: a comfortable size docked at the bottom-right (above the status bar). */
export function defaultShape(vw: number, vh: number): DockShape {
  const w = Math.min(DOCK_DEF_W, Math.max(DOCK_MIN_W, vw - 2 * MARGIN));
  const h = Math.min(DOCK_DEF_H, Math.max(DOCK_MIN_H, vh - 96));
  return { x: Math.max(MARGIN, vw - w - MARGIN), y: Math.max(MARGIN, vh - h - 56), w, h };
}

/** Keep the dock fully on-screen at its minimum size (used after every move/resize + on viewport resize). */
export function clampToViewport(s: DockShape, vw: number, vh: number): DockShape {
  const w = Math.max(DOCK_MIN_W, Math.min(Math.round(s.w), Math.max(DOCK_MIN_W, vw - 2 * MARGIN)));
  const h = Math.max(DOCK_MIN_H, Math.min(Math.round(s.h), Math.max(DOCK_MIN_H, vh - 2 * MARGIN)));
  const x = Math.max(MARGIN, Math.min(Math.round(s.x), Math.max(MARGIN, vw - w - MARGIN)));
  const y = Math.max(MARGIN, Math.min(Math.round(s.y), Math.max(MARGIN, vh - h - MARGIN)));
  return { x, y, w, h };
}

/** After a drag ends, decide whether to snap: near the RIGHT frame -> flush right; near the LEFT frame (just
 *  right of the rail column) -> beside the rails; else stay floating. `railW` = the left rail width so a
 *  left-snap sits BESIDE the rails, never under them. */
export function snapDecision(s: DockShape, vw: number, vh: number, railW: number): { side: DockSide; shape: DockShape } {
  const c = clampToViewport(s, vw, vh);
  if (c.x + c.w >= vw - SNAP_PX) return { side: "right", shape: clampToViewport({ ...c, x: vw - c.w - MARGIN }, vw, vh) };
  if (c.x <= railW + SNAP_PX) return { side: "left", shape: clampToViewport({ ...c, x: railW + MARGIN }, vw, vh) };
  return { side: "float", shape: c };
}

/** Injected storage seam (localStorage in the app; a Map-backed fake in tests). */
export interface DockStorage { get(k: string): string | null; set(k: string, v: string): void }
const KEY = "lucid.shareDock.v1";
/** P-COLLAB.20 (ADR-0242): the JOIN dock persists under its own key, so watching a session and sharing one
 *  keep independent geometry (and can be on screen at the same time). */
export const JOIN_DOCK_KEY = "lucid.joinDock.v1";

/** Restore the dock state, clamped to the CURRENT viewport; falls back to the default on any bad/absent data.
 *  `key` selects WHICH dock (share vs join); `fallbackShape` overrides the first-open placement (the join dock
 *  lands bottom-LEFT so it never stacks on the share dock's bottom-right default). */
export function loadDockState(storage: DockStorage, vw: number, vh: number, key: string = KEY, fallbackShape?: DockShape): DockState {
  const fb: DockState = { shape: fallbackShape ? clampToViewport(fallbackShape, vw, vh) : defaultShape(vw, vh), minimized: false, side: "float", collapsed: {} };
  let raw: string | null = null;
  try { raw = storage.get(key); } catch { return fb; }
  if (!raw) return fb;
  try {
    const p = JSON.parse(raw) as { shape?: Partial<DockShape>; minimized?: unknown; side?: unknown; collapsed?: unknown };
    const shape = p.shape
      ? clampToViewport({ x: num(p.shape.x, fb.shape.x), y: num(p.shape.y, fb.shape.y), w: num(p.shape.w, DOCK_DEF_W), h: num(p.shape.h, DOCK_DEF_H) }, vw, vh)
      : fb.shape;
    return {
      shape,
      minimized: p.minimized === true,
      side: p.side === "left" || p.side === "right" ? p.side : "float",
      collapsed: p.collapsed && typeof p.collapsed === "object" ? { ...(p.collapsed as Record<string, boolean>) } : {},
    };
  } catch { return fb; }
}

export function saveDockState(storage: DockStorage, s: DockState, key: string = KEY): void {
  try { storage.set(key, JSON.stringify(s)); } catch { /* storage disabled / quota - non-fatal, the dock still works */ }
}

export interface Participant { name: string; access?: string }
export interface ParticipantSummary { count: number; people: { name: string; access: "edit" | "view" }[] }
/** Normalize the roster for the header count + the by-email dropdown (name is the guest's email for a PWA). */
export function participantSummary(participants: Participant[] | null | undefined): ParticipantSummary {
  const people = (participants ?? []).map((p) => ({
    name: (p.name ?? "").toString().trim() || "guest",
    access: p.access === "edit" ? ("edit" as const) : ("view" as const),
  }));
  return { count: people.length, people };
}

/** Whether a section is collapsed, honoring the user's stored choice over the section's default. */
export function isCollapsed(collapsed: Record<string, boolean>, id: string, defaultCollapsed: boolean): boolean {
  return Object.prototype.hasOwnProperty.call(collapsed, id) ? collapsed[id] === true : defaultCollapsed;
}

// ── P-SHARE.2 (ADR-0234): Session Share dock UI polish (pure, DOM-free helpers) ────────────────────────────

/** A "be the relay" bind address, kept STRUCTURAL (mirrors bridge's CollabBindAddress) so this module stays
 *  free of any bridge/DOM import. */
export interface BindAddrLike { family: "IPv4" | "IPv6"; kind: "loopback" | "lan" | "vpn" | "other" }

/** Order the relay bind addresses so the DEFAULT (first) is one a GUEST can actually reach: routable
 *  (lan/vpn/other) before loopback, and IPv4 before IPv6 within each group; input order is otherwise preserved
 *  (stable). Loopback reaches only this machine (or a guest over a tunnel/VPN) — useless as the invite target —
 *  so it sinks to the bottom and is never the default. Returns a NEW array; the input is not mutated. */
export function orderBindAddresses<T extends BindAddrLike>(addrs: readonly T[]): T[] {
  // Sort key: loopback (+2) sinks below routable (0); IPv6 (+1) follows IPv4 within a group; index breaks ties
  // so same-group order is preserved (a stable sort).
  return addrs
    .map((a, i) => ({ a, i, key: (a.kind === "loopback" ? 2 : 0) + (a.family === "IPv6" ? 1 : 0) }))
    .sort((x, y) => x.key - y.key || x.i - y.i)
    .map((e) => e.a);
}

/** The P2P config a Share snapshot may carry. `turnCredential` is a SECRET and is never cached. */
export interface RedactableP2P { preferDirect: boolean; iceUrls: string[]; turnUsername?: string; turnCredential?: string }
/** The secret-free Share snapshot cached (localStorage) for an INSTANT first paint so a cold-boot dock is never
 *  a blank "Loading…". It deliberately holds ONLY the non-secret relay descriptor, the be-the-relay status, and
 *  a redacted P2P config — NEVER an invite link or room id (both carry the E2E key in the link fragment) and
 *  NEVER a TURN credential. There is also no `active`/roster: first paint always renders the idle shell, so a
 *  restart can never show a stale "Live" pointing at a dead room. draw() revalidates immediately after. */
export interface ShareSnapshot<R, V> { relay: R | null; serve: V; p2pCfg: RedactableP2P | null }
/** Build the cache snapshot by WHITELISTING only safe fields — a blacklist would silently leak any new secret
 *  field added upstream. Returns a NEW object; inputs are not mutated. */
export function redactShareSnapshot<R, V>(relay: R | null, serve: V, p2pCfg: RedactableP2P | null): ShareSnapshot<R, V> {
  const p2p = p2pCfg ? { preferDirect: p2pCfg.preferDirect, iceUrls: p2pCfg.iceUrls, turnUsername: p2pCfg.turnUsername } : null;
  return { relay, serve, p2pCfg: p2p };
}
