// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/platform.ts - OS-aware keyboard-shortcut labels.
//
// The shortcut HANDLERS are already cross-platform (`e.ctrlKey || e.metaKey`); this is purely for
// what we DISPLAY. macOS users expect the ⌘ glyph; Windows/Linux users expect "Ctrl". Reading the
// platform is guarded so these stay safe (and deterministic → "Ctrl") in Node/tests where there is
// no `navigator`.

/** True on macOS (renderer only). Falls back to false off-browser, so Node/tests render "Ctrl". */
export function isMac(): boolean {
  try {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    const p = nav.userAgentData?.platform || nav.platform || nav.userAgent || "";
    return /mac|iphone|ipad|ipod/i.test(p);
  } catch { return false; }
}

/** The command/control modifier label for this OS: "⌘" on macOS, "Ctrl" everywhere else. */
export function modKey(): string { return isMac() ? "⌘" : "Ctrl"; }

/** A formatted shortcut for a letter/number key: "⌘K" on macOS, "Ctrl+K" on Windows/Linux. */
export function modCombo(key: string): string {
  return isMac() ? `${modKey()}${key}` : `${modKey()}+${key}`;
}

/** A modifier + a symbol key with a thin space (zoom: "⌘ +" on macOS, "Ctrl +" elsewhere). */
export function modSymbol(symbol: string): string { return `${modKey()} ${symbol}`; }
