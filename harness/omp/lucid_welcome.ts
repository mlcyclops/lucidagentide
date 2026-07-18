// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/lucid_welcome.ts
//
// P-BRAND.1 (issue #314): the PURE core of the LUCID TUI welcome banner — layout + copy + the fail-open
// apply seam, with ZERO omp runtime imports so it stays cheap + headless-testable. The omp-coupled data
// gathering (LSP servers, recent sessions) lives in lucid_welcome_extension.ts, which feeds this renderer.
//
// The banner reproduces the content omp's own welcome box carried (tips, LSP servers, recent sessions) so
// suppressing omp's box (startup.quiet) loses no information — only the omp branding. Names LUCID, never omp.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The widget slot key; reused to CLEAR the banner on the first turn. */
export const WIDGET_KEY = "lucid-welcome";

/** Env escape hatch, mirroring LUCID_THEME. */
export const WELCOME_ENV = "LUCID_WELCOME";

/** The LUCID brand tagline. Omp-free by construction — the splash names LUCID, never omp. */
export const TAGLINE = "security · provenance · memory";

/** The static composer affordances omp's welcome lists under "Tips" (stable omp behaviour). */
export const TIP_HINTS = "# prompt actions  ·  / commands  ·  ! bash  ·  $ python";

/** Cap LSP + recent-session rows so the banner height stays bounded (mirrors omp's welcome slot caps). */
export const LSP_MAX = 4;
export const SESSION_MAX = 3;

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

/** A workspace-applicable LSP server (name + the file extensions it handles). */
export interface WelcomeLsp {
  name: string;
  fileTypes: readonly string[];
}

/** A recent session row (display name + relative time). */
export interface WelcomeSession {
  name: string;
  timeAgo: string;
}

/** Whether the LUCID welcome should paint. `off|0|false` (case-insensitive) disables it. */
export function welcomeEnabled(env: Record<string, string | undefined> = process.env): boolean {
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

/** Left-pad a section label to a fixed width so the value columns line up. */
function label(text: string, p: WelcomePaint): string {
  return p.accent(text.padEnd(7));
}

/** Build the LUCID welcome banner lines (a string[] for ctx.ui.setWidget). PURE. Always names LUCID, never
 *  omp; the version, model, LSP servers, and recent sessions are shown when known. */
export function renderWelcomeLines(
  o: {
    paint?: WelcomePaint;
    version?: string;
    model?: string;
    lsp?: readonly WelcomeLsp[];
    recent?: readonly WelcomeSession[];
  } = {},
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
  lines.push("");

  // Tips — the static composer affordances (always accurate).
  lines.push(`${label("Tips", p)}${p.muted(TIP_HINTS)}`);

  // LSP servers — the workspace-applicable servers omp would run (name + file types).
  const lsp = (o.lsp ?? []).slice(0, LSP_MAX);
  lsp.forEach((server, i) => {
    const value = `${server.name} ${server.fileTypes.slice(0, 4).join(" ")}`.trimEnd();
    lines.push(`${label(i === 0 ? "LSP" : "", p)}${p.muted(value)}`);
  });

  // Recent sessions — the same list omp's welcome shows.
  const recent = (o.recent ?? []).slice(0, SESSION_MAX);
  recent.forEach((session, i) => {
    lines.push(`${label(i === 0 ? "Recent" : "", p)}${p.muted(`· ${session.name} (${session.timeAgo})`)}`);
  });

  lines.push("");
  lines.push(p.muted(TAGLINE));
  lines.push("");
  return lines;
}

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
  env?: Record<string, string | undefined>;
  hasUI: boolean;
  paint: WelcomePaint;
  version?: string;
  model?: string;
  lsp?: readonly WelcomeLsp[];
  recent?: readonly WelcomeSession[];
  setWidget: WidgetSetter;
}): { applied: boolean; detail: string } {
  try {
    if (!o.hasUI) return { applied: false, detail: "no UI (print/ACP mode)" };
    if (!welcomeEnabled(o.env ?? process.env)) return { applied: false, detail: "disabled via LUCID_WELCOME" };
    o.setWidget(
      WIDGET_KEY,
      renderWelcomeLines({ paint: o.paint, version: o.version, model: o.model, lsp: o.lsp, recent: o.recent }),
      { placement: "aboveEditor" },
    );
    return { applied: true, detail: "painted" };
  } catch (error) {
    return { applied: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
