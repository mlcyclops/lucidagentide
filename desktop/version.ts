// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/version.ts — the single source of truth for the LUCID Agent IDE app version.
//
// The About panel reads APP_VERSION (bundled into the renderer), so bumping the version here
// updates the UI everywhere with no hardcoded duplicate in the markup. desktop/package.json
// MIRRORS this string (electron's app.getVersion() / electron-builder read package.json);
// version.test.ts asserts the two stay equal, so a bump in one is forced into the other.
//
// Launch baseline: v1.8.7. v1.8.8 = role onboarding + tour + providers reorg.
// v1.8.10 = Perplexity→Providers, set-note readability, Gemini model cards, macOS .pkg/cask.
// v1.8.11 = in-app network diagnostics (OAuth callback watcher) + OAuth re-login self-heal.
// v1.8.12 = OAuth broker lifespan fix (stdin:pipe) + device-flow support + auto-refresh.
// v1.8.14 = agent-trust UX (honest tool-failure chip, local-file egress, AI-LOC discoverability) +
//           role user guides + in-app browser Preview (panel, auto-surface-on-write, hardened sandbox).
//           (v1.8.13 skipped.)
// v1.8.15 = full-tree workspace folder browser (open a folder anywhere, ADR-0103) + bun trustedDependencies
//           so a from-source `bun install` actually installs Electron's binary.
// v1.8.16 = preview remote egress-gating (P-PREVIEW.3b) + every gate denial auditable & attributed
//           (P-ENT.4). Also carries the defensive, functionally-unverified agent preview_open (P-PREVIEW.3a).
// v1.8.17 = preview actually RENDERS the agent's apps: per-frame served CSP (P-PREVIEW.4b) fixes games that
//           showed only their HUD (a srcdoc frame inherited script-src 'self' and blocked inline scripts) +
//           agent-driven preview_open finalized against the real omp API + PREVIEW_POLICY steers the agent
//           to the panel instead of browser/eval/bash (P-PREVIEW.3a, PREFIX_VERSION 6).
// v1.8.18 = the agent can SEE its own rendered UI: preview_screenshot returns a PNG of the live preview as
//           ImageContent (P-PREVIEW.3a-shot) — renderer caches the shot, the read-tier tool fetches it.
// v1.8.19 = MULTI-FILE apps preview: fold an app's own relative css/js/img/fonts inline before serving
//           (P-PREVIEW.4c) so index.html + style.css + game.js renders under the same egress-blocked CSP.
// v1.8.20 = inline expandable code preview for tool steps (P-CHAT.1) — writes syntax-highlighted (Monaco),
//           edits as red/green diffs, "Open in editor →" into the full Monaco panel; FIX file-edit failures
//           via edit.mode=replace + native folder Browse (P-EDIT.1); preview auto-shows (no toast) + renders
//           nested-iframe wrappers (P-PREVIEW.4c follow-up); bigger default zoom + memory→$ icon.
// v1.8.21 = network whitelist FOUNDATION (P-NETWL.1, ADR-0106): a curated allow-list — internal/external
//           domain patterns (TLD `*.com` + exact sub-level) and IP/CIDR ranges, per-entry trust scope
//           (always|project|loop) + call budget — auto-allows egress on top of the per-site gate, always
//           under the enterprise-managed ceiling (fail-closed). Adds an OS-encrypted credential vault
//           (Electron safeStorage/DPAPI) for JWT/OAuth/SAML/PEM/API-key/basic secrets — stored encrypted or
//           REFUSED (never plaintext); native file picker + vault IPC/bridge plumbing. UI lands in .2–.4.
// v1.8.22 = network whitelist Settings UI (P-NETWL.2, ADR-0106): a "Network Whitelist" section to add/list/
//           remove domain patterns (`*.com` + exact) and IP/CIDR ranges by internal/external zone + trust
//           scope + call budget, with an optional auth credential (paste or native file upload) stored in the
//           OS-encrypted vault (fail-closed: refused, never plaintext). CRUD via /api/whitelist; a match is
//           read by the live egress gate to auto-allow under the managed ceiling.
// v1.8.23 = finish the whitelist set: ENFORCE project/loop trust scopes + per-loop call budget (P-NETWL.3 -
//           egressDecisionDetailed threads project+loop context; the loop runner caps auto-allows per host);
//           credential last-4 masking (P-KEYS.1, ADR-0107 - the vault stores <=4 chars, the UI shows ••••XXXX);
//           and click-to-whitelist on the Network-diagnostics DNS pills (P-NETWL.4 - a quick-add popover with
//           zone/scope/budget). All still under the managed ceiling, fail-closed.
export const APP_VERSION = "1.8.23";
