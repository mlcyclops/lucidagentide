// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/admin_window.ts - P-RS-WINDOW.1 (ADR-0537): the pure rules of the Remote Spokes admin window.
//
// Electron main opens the Remote Spokes plugin's panel top level in its own window. This file holds what that window
// may load and where it sits, so both are testable without Electron: the panel URL must be a plugin loopback origin,
// the window stays on that one origin (an https link goes to the system browser, anything else is refused), and the
// saved size and position are read back only when they are sane and still on a screen.

import { externalHttpUrl } from "./navigation_policy.ts";
import { pluginOrigin } from "./plugins/ports.ts";

export const ADMIN_WINDOW_TITLE = "Remote Spokes admin";
/** The window's own session. No `persist:` prefix, so it lives in memory and its cookie never mixes with the app's. */
export const ADMIN_PARTITION = "lucid-remote-spokes-admin";
export const ADMIN_BOUNDS_FILE = "remote-spokes-admin-window.json";
export const ADMIN_DEFAULT_SIZE = { width: 1280, height: 860 } as const;
export const ADMIN_MIN_SIZE = { width: 720, height: 480 } as const;

export interface AdminBounds { x?: number; y?: number; width: number; height: number }
export interface ScreenArea { x: number; y: number; width: number; height: number }

/** What the window does with a URL it is asked to open or navigate to. */
export type AdminNavigation = "allow" | "external" | "deny";

/** `panelOrigin` is plugins/ports.ts pluginOrigin of the panel URL (a URL without one never opens the window).
 *  Same origin as the panel stays in the window; an https URL elsewhere goes to the system browser; the rest is denied. */
export function adminNavigation(panelOrigin: string, url: unknown): AdminNavigation {
  if (pluginOrigin(url) === panelOrigin) return "allow";
  const out = externalHttpUrl(url);
  return out !== null && new URL(out).protocol === "https:" ? "external" : "deny";
}

const whole = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** Read the saved bounds. A bad file, a size under the minimum or a position off every screen falls back to the
 *  default size (and the OS's placement). */
export function adminBounds(text: string | null, screens: readonly ScreenArea[]): AdminBounds {
  const fallback: AdminBounds = { ...ADMIN_DEFAULT_SIZE };
  if (!text) return fallback;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return fallback; }
  if (typeof raw !== "object" || raw === null || !("width" in raw) || !("height" in raw)) return fallback;
  const { width, height } = raw;
  if (!whole(width) || !whole(height) || width < ADMIN_MIN_SIZE.width || height < ADMIN_MIN_SIZE.height || width > 20_000 || height > 20_000) return fallback;
  const x = "x" in raw ? raw.x : undefined;
  const y = "y" in raw ? raw.y : undefined;
  if (!whole(x) || !whole(y)) return { width, height };
  // The title bar must land on a screen, or a window saved on an unplugged monitor would open where no one sees it.
  const onScreen = screens.some((s) => x + width > s.x + 40 && x < s.x + s.width - 40 && y >= s.y && y < s.y + s.height - 40);
  return onScreen ? { x, y, width, height } : { width, height };
}
