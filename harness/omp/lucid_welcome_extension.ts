// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/lucid_welcome_extension.ts
//
// P-BRAND.1 (issue #314): the LUCID welcome banner for gated terminal sessions. omp's own welcome box
// (the block-Π logo + the "omp v…" title) is a frozen module constant with no injection seam, so it can't
// be re-skinned in place without forking omp (invariant #1). Instead the launcher suppresses omp's welcome
// per-session via a `--config` overlay (lucid_tui.config.yml -> startup.quiet), and THIS optional `-e`
// extension paints the LUCID brand in its place: on `session_start` it sets an above-editor widget with the
// LUCID wordmark (coloured with the pink skin's accent), then clears it on the first `turn_start` so the
// banner behaves like a one-shot welcome instead of permanent chrome.
//
// FAIL-OPEN — like the sibling theme extension (ADR-0160), the deliberate inverse of the security gate
// (invariant #3 governs scan results, not paint). Any failure (no UI in print/ACP mode, a throwing
// setWidget, an unreadable version file) is caught and logged at debug; it NEVER throws, blocks, or kills a
// session. Escape hatch: LUCID_WELCOME=off|0|false restores omp's default welcome (the launcher then also
// skips the suppression overlay so omp paints its own box).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { createAgentSession } from "@oh-my-pi/pi-coding-agent";

type SessionOpts = NonNullable<Parameters<typeof createAgentSession>[0]>;
type ExtensionFactory = NonNullable<SessionOpts["extensions"]>[number];

type Env = Record<string, string | undefined>;

// ── pure core (no omp imports, unit-tested) ─────────────────────────────────────────────────────────

/** The widget slot key; reused to CLEAR the banner on the first turn. */
export const WIDGET_KEY = "lucid-welcome";

/** Env escape hatch, mirroring LUCID_THEME. */
export const WELCOME_ENV = "LUCID_WELCOME";

/** The LUCID brand tagline. Omp-free by construction — the splash names LUCID, never omp. */
export const TAGLINE = "security · provenance · memory";

/** The LUCID wordmark, block-lettered (the same letterforms as .github/assets/cli-banner.txt, trimmed of
 *  the installer-only side text). Plain block/box-drawing glyphs — no omp, no hidden unicode. */
export const LUCID_LOGO: readonly string[] = [
  "██╗      ██╗   ██╗  ██████╗ ██╗ ██████╗ ",
  "██║      ██║   ██║ ██╔════╝ ██║ ██╔══██╗",
  "██║      ██║   ██║ ██║      ██║ ██║  ██║",
  "██║      ██║   ██║ ██║      ██║ ██║  ██║",
  "███████╗ ╚██████╔╝ ╚██████╗ ██║ ██████╔╝",
  "╚══════╝  ╚═════╝   ╚═════╝ ╚═╝ ╚═════╝ ",
];

/** Whether the LUCID welcome should paint. `off|0|false` (case-insensitive) disables it. */
export function welcomeEnabled(env: Env = process.env): boolean {
  const raw = (env[WELCOME_ENV] ?? "").trim();
  return !/^(off|0|false)$/i.test(raw);
}

/** LUCID's product version, read from desktop/package.json (which mirrors desktop/version.ts APP_VERSION).
 *  Cheap fs read resolved beside this file; any failure yields "" (fail-open — the banner just omits it). */
export function lucidVersion(
  pkgPath: string = join(import.meta.dir, "..", "..", "desktop", "package.json"),
): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (parsed && typeof parsed === "object" && "version" in parsed) {
      const v = parsed.version;
      return typeof v === "string" ? v : "";
    }
  } catch {
    // fall through to the empty fallback
  }
  return "";
}

/** Minimal painter so the line builder stays PURE + headless-testable: identity paint in tests, the real
 *  omp Theme's fg/bold in the extension. */
export interface WelcomePaint {
  accent(s: string): string;
  muted(s: string): string;
  bold(s: string): string;
}

const IDENTITY_PAINT: WelcomePaint = { accent: (s) => s, muted: (s) => s, bold: (s) => s };

/** Build the LUCID welcome banner lines (a string[] for ctx.ui.setWidget). PURE. Always names LUCID, never
 *  omp; `version`/`model` are appended when known. */
export function renderWelcomeLines(
  o: { paint?: WelcomePaint; version?: string; model?: string } = {},
): string[] {
  const p = o.paint ?? IDENTITY_PAINT;
  const lines: string[] = [""];
  for (const glyphRow of LUCID_LOGO) lines.push(p.accent(glyphRow));
  lines.push("");
  const ver = o.version && o.version.length > 0 ? `LUCID v${o.version}` : "LUCID";
  lines.push(
    o.model && o.model.length > 0
      ? `${p.bold(p.accent(ver))}  ${p.muted(`· ${o.model}`)}`
      : p.bold(p.accent(ver)),
  );
  lines.push(p.muted(TAGLINE));
  lines.push("");
  return lines;
}

// ── testable session_start seam (DI) ────────────────────────────────────────────────────────────────

/** Widget setter shape, mirrored from omp's ExtensionUIContext.setWidget so this seam stays omp-free and
 *  unit-testable (a spy in tests; ctx.ui.setWidget in the extension). */
export type WidgetSetter = (
  key: string,
  content: string[] | undefined,
  opts?: { placement?: "aboveEditor" | "belowEditor" },
) => void;

/** Paint the LUCID welcome widget against injected seams. Cosmetic + FAIL-OPEN: no UI, a disabled
 *  LUCID_WELCOME, or a throwing setWidget all degrade to "not applied" and NEVER throw. */
export function applyWelcome(o: {
  env?: Env;
  hasUI: boolean;
  paint: WelcomePaint;
  version?: string;
  model?: string;
  setWidget: WidgetSetter;
}): { applied: boolean; detail: string } {
  try {
    if (!o.hasUI) return { applied: false, detail: "no UI (print/ACP mode)" };
    if (!welcomeEnabled(o.env ?? process.env)) return { applied: false, detail: "disabled via LUCID_WELCOME" };
    o.setWidget(WIDGET_KEY, renderWelcomeLines({ paint: o.paint, version: o.version, model: o.model }), {
      placement: "aboveEditor",
    });
    return { applied: true, detail: "painted" };
  } catch (error) {
    return { applied: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

// ── the omp extension (thin wrapper) ────────────────────────────────────────────────────────────────

const lucidWelcome: ExtensionFactory = (pi) => {
  pi.on("session_start", async (_event, ctx) => {
    try {
      const theme = ctx.ui.theme;
      const paint: WelcomePaint = {
        accent: (s) => theme.fg("accent", s),
        muted: (s) => theme.fg("muted", s),
        bold: (s) => theme.bold(s),
      };
      const model = ctx.model?.name ?? ctx.models.current()?.name ?? "";
      const r = applyWelcome({
        hasUI: ctx.hasUI,
        paint,
        version: lucidVersion(),
        model,
        setWidget: (key, content, opts) => ctx.ui.setWidget(key, content, opts),
      });
      if (!r.applied) pi.logger?.debug?.(`[lucid welcome] not applied: ${r.detail}`);
    } catch (error) {
      pi.logger?.debug?.(`[lucid welcome] not applied: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // A welcome should greet, not linger: clear the banner once the conversation starts so it never becomes
  // permanent chrome above the editor. Cosmetic — a failure here is swallowed.
  pi.on("turn_start", (_event, ctx) => {
    try {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    } catch {
      // cosmetic: nothing to recover
    }
  });
};

export default lucidWelcome;
