// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Throwaway visual QA for P-MASCOT.5: the arcade cabinet. Mounts one arcade per board (obstacle
// course + the three mini games), opens each panel, and starts the mini games so every canvas shows
// a live frame. Delete once the user has looked.

import { mountAgentArcade } from "../renderer/mascot_game.ts";

const games = ["course", "shuriken", "kata", "stack"];
for (const id of games) {
  const wrap = document.createElement("div");
  const label = document.createElement("h2");
  label.textContent = id;
  const host = document.createElement("div");
  wrap.append(label, host);
  document.body.appendChild(wrap);
  const handle = mountAgentArcade(host);
  handle.update(true);
  const reveal = host.querySelector<HTMLButtonElement>(".agent-arcade-reveal")!;
  reveal.click();
  if (id !== "course") {
    const select = host.querySelector<HTMLSelectElement>("[data-game-select]")!;
    select.value = id;
    select.dispatchEvent(new Event("change"));
    host.querySelector<HTMLButtonElement>(".mini-game-start")?.click();
  }
}
