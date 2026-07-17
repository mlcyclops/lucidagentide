// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/lucid_welcome_extension.ts
//
// P-BRAND.1 (issue #314): the omp `-e` that paints the LUCID welcome over omp's suppressed welcome box.
// Thin wrapper around the PURE core (lucid_welcome.ts): on `session_start` it gathers the same content
// omp's own welcome carried — the workspace's LSP servers (from omp's config) and recent sessions — plus
// the static tips, then sets an above-editor widget with the LUCID wordmark (accent-coloured by the
// P-THEME.1 skin). It clears the banner on the first `turn_start` so it greets without lingering.
//
// omp's own welcome box is a frozen module constant with no injection seam, so — extending, never forking
// (invariant #1) — the launcher suppresses it per-session via a `--config` overlay (startup.quiet) and
// this extension paints the brand instead. FAIL-OPEN throughout (the deliberate inverse of the security
// gate, which is a separate mandatory `-e`): no UI, a throwing setWidget, or failed LSP/session discovery
// each degrade to "not applied"/an empty section — never throwing, never weakening the fail-closed gate.
// Escape hatch: LUCID_WELCOME=off restores omp's own welcome (the launcher then drops both the `-e` and
// the overlay).
//
// LSP note: `discoverStartupLspServers(cwd, "available")` returns exactly what omp's welcome shows in lazy
// mode (the default) — the applicable servers as "available". Live "ready" status (non-lazy warmup) is
// emitted only when omp's own welcome is NOT suppressed, so the banner shows the configured/available set.

import { discoverStartupLspServers } from "@oh-my-pi/pi-coding-agent/lsp";
import { getRecentSessions } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import type { createAgentSession } from "@oh-my-pi/pi-coding-agent";
import { applyWelcome, lucidVersion, WIDGET_KEY, welcomeEnabled } from "./lucid_welcome.ts";
import type { WelcomeLsp, WelcomePaint, WelcomeSession } from "./lucid_welcome.ts";

type SessionOpts = NonNullable<Parameters<typeof createAgentSession>[0]>;
type ExtensionFactory = NonNullable<SessionOpts["extensions"]>[number];

const lucidWelcome: ExtensionFactory = (pi) => {
  pi.on("session_start", async (_event, ctx) => {
    try {
      if (!ctx.hasUI) return; // print / RPC / ACP: no interactive widget surface
      if (!welcomeEnabled(process.env)) return; // LUCID_WELCOME=off restores omp's default welcome
      const theme = ctx.ui.theme;
      const paint: WelcomePaint = {
        accent: (s) => theme.fg("accent", s),
        muted: (s) => theme.fg("muted", s),
        bold: (s) => theme.bold(s),
      };
      const model = ctx.model?.name ?? ctx.models.current()?.name ?? "";

      // The workspace's applicable LSP servers (name + file types), from omp's own config resolution.
      // Fail-open: any failure just drops the LSP section.
      let lsp: WelcomeLsp[] = [];
      try {
        lsp = discoverStartupLspServers(ctx.cwd, "available").map((s) => ({ name: s.name, fileTypes: s.fileTypes }));
      } catch (error) {
        pi.logger?.debug?.(`[lucid welcome] lsp discovery failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      // The same recent-session list omp's welcome shows. Fail-open: any failure drops the section.
      let recent: WelcomeSession[] = [];
      try {
        recent = (await getRecentSessions(ctx.sessionManager.getSessionDir())).map((s) => ({
          name: s.name,
          timeAgo: s.timeAgo,
        }));
      } catch (error) {
        pi.logger?.debug?.(`[lucid welcome] recent sessions failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      const r = applyWelcome({
        hasUI: ctx.hasUI,
        paint,
        version: lucidVersion(),
        model,
        lsp,
        recent,
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
