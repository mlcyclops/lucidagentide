// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/ui_prefs.ts - P-FIRSTRUN.1 (ADR-0698): the one engine-kept preference store this window uses
// (ui_prefs_store.ts over localStorage and /api/ui/prefs). Visualize, the first-run nudge, Lucid's suggestions and the
// special theme all read and write through it, so there is one load and one mirror.

import { bridge } from "./bridge.ts";
import { createUiPrefs } from "./ui_prefs_store.ts";

export const uiPrefs = createUiPrefs(typeof localStorage === "undefined" ? null : localStorage, {
  load: () => bridge.uiPrefs(),
  save: (key, value) => bridge.setUiPref(key, value),
});
