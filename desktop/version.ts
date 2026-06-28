// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/version.ts — the single source of truth for the LUCID Agent IDE app version.
//
// The About panel reads APP_VERSION (bundled into the renderer), so bumping the version here
// updates the UI everywhere with no hardcoded duplicate in the markup. desktop/package.json
// MIRRORS this string (electron's app.getVersion() / electron-builder read package.json);
// version.test.ts asserts the two stay equal, so a bump in one is forced into the other.
//
// Launch baseline: v1.8.7.
export const APP_VERSION = "1.8.7";
