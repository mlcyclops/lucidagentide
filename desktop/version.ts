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
export const APP_VERSION = "1.8.15";
