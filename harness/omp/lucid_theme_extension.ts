// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/lucid_theme_extension.ts
//
// P-THEME.1 (ADR-0160): the LUCID skin for gated terminal sessions — omp's native TUI wearing the
// desktop design system (styles.css palette → themes/lucid.json), applied per-session through omp's
// supported theming surface (invariant #1: a theme file + `ctx.ui.setTheme`, never a fork).
//
// On `session_start` it (1) provisions themes/lucid.json into omp's custom-themes dir (idempotent:
// write only when bytes differ) and (2) calls `pi.ui.setTheme("lucid")`. setTheme swaps the IN-MEMORY
// theme singleton only — it never persists `theme.dark` to config.yml — so ONLY the gated session is
// skinned; a bare `omp` keeps the user's own theme. The skin is also the visible tell: a branded
// terminal IS a gated terminal.
//
// FAIL-OPEN — deliberately the opposite of the security gate (invariant #3 applies to scan results,
// not paint). A theme failure (unwritable dir, malformed JSON, headless/ACP mode where setTheme is
// stubbed unavailable) logs and leaves omp's default theme; it must NEVER block or kill a session.
//
// Escape hatch: LUCID_THEME=off|0|false disables; LUCID_THEME=<name> applies that theme instead
// (no provisioning — the name must already resolve for omp).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { createAgentSession } from "@oh-my-pi/pi-coding-agent";

type SessionOpts = NonNullable<Parameters<typeof createAgentSession>[0]>;
type ExtensionFactory = NonNullable<SessionOpts["extensions"]>[number];

type Env = Record<string, string | undefined>;

// ── pure core (no omp imports, unit-tested) ─────────────────────────────────────────────────────────

export const THEME_NAME = "lucid";

/** The bundled theme asset, resolved beside this file (assets() loads the extension by repo path,
 *  so import.meta.dir is <repo>/harness/omp in dev checkouts and packaged resources alike). */
export const THEME_SOURCE = join(import.meta.dir, "themes", "lucid.json");

/** omp's custom-themes dir: `$PI_CODING_AGENT_DIR/themes` when overridden, else `~/.omp/agent/themes`
 *  (mirrors getCustomThemesDir() in omp's modes/theme/theme.ts — see omp docs/theme.md). */
export function themesDir(env: Env = process.env, home: string = homedir()): string {
  const agentDir = env.PI_CODING_AGENT_DIR;
  return join(agentDir && agentDir.length > 0 ? agentDir : join(home, ".omp", "agent"), "themes");
}

/** The theme this session should wear: `null` = theming disabled, otherwise a theme name. */
export function requestedTheme(env: Env = process.env): string | null {
  const raw = (env.LUCID_THEME ?? "").trim();
  if (raw === "") return THEME_NAME;
  if (/^(off|0|false)$/i.test(raw)) return null;
  return raw;
}

/** Idempotently install the theme JSON into `dir`. Read-then-compare (never existsSync-then-read —
 *  TOCTOU) and write only when bytes differ, so omp's theme file-watcher isn't poked on every launch. */
export function provisionTheme(dir: string, sourceJson: string): "written" | "unchanged" {
  const dest = join(dir, `${THEME_NAME}.json`);
  let existing: string | undefined;
  try {
    existing = readFileSync(dest, "utf8");
  } catch {
    existing = undefined;
  }
  if (existing === sourceJson) return "unchanged";
  mkdirSync(dir, { recursive: true });
  writeFileSync(dest, sourceJson, "utf8");
  return "written";
}

/** The full session_start behavior against injected seams (DI / test): provision when wearing the
 *  bundled skin, then apply. Cosmetic = every failure is caught and reported as a string, never thrown. */
export async function applyLucidTheme(o: {
  env?: Env;
  setTheme: (name: string) => Promise<{ success: boolean; error?: string }>;
  readSource?: () => string;
  dir?: string;
}): Promise<{ applied: boolean; detail: string }> {
  try {
    const name = requestedTheme(o.env ?? process.env);
    if (name === null) return { applied: false, detail: "disabled via LUCID_THEME" };
    if (name === THEME_NAME) {
      const source = (o.readSource ?? (() => readFileSync(THEME_SOURCE, "utf8")))();
      provisionTheme(o.dir ?? themesDir(o.env ?? process.env), source);
    }
    const r = await o.setTheme(name);
    if (!r.success) return { applied: false, detail: r.error ?? "setTheme failed" };
    return { applied: true, detail: name };
  } catch (error) {
    return { applied: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

// ── the omp extension (thin wrapper) ────────────────────────────────────────────────────────────────

const lucidTheme: ExtensionFactory = (pi) => {
  pi.on("session_start", async (_event, ctx) => {
    const r = await applyLucidTheme({ setTheme: (name) => ctx.ui.setTheme(name) });
    // Headless/print/ACP stubs answer "UI not available" — expected, debug-level noise only.
    if (!r.applied) pi.logger?.debug?.(`[lucid theme] not applied: ${r.detail}`);
  });
};

export default lucidTheme;
