// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/hub_button.ts - P-TUI.2: the Fleet grid's and the orbit's "Terminal" buttons share one
// click behaviour: hold the button while the engine opens the window, so a double click cannot open two.
// Whether it worked is told by the caller's `open` (app.ts toasts a refusal with the engine's reason).

export async function openHubFrom(btn: HTMLButtonElement, open: () => Promise<unknown> | undefined): Promise<void> {
  if (btn.disabled) return;
  btn.disabled = true;
  try { await open(); } finally { btn.disabled = false; }
}
