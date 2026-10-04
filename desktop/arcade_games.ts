// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

/** Original, offline HTML games served through the existing sandboxed Preview. */
export const ARCADE_GAMES = {
  "signal-garden": { name: "Signal Garden: Heartbloom", file: "signal-garden.html" },
  "nebula-fusion": { name: "Nebula Fusion: Voyage", file: "nebula-fusion.html" },
  "brick-brigade": { name: "Brick Brigade: Rescue Run", file: "brick-brigade.html" },
  "deck-guard": { name: "Deck Guard: Swarm Break", file: "deck-guard.html" },
  "chroma-cadence": { name: "Chroma Cadence: Neon Rhythm", file: "chroma-cadence.html" },
  "gravity-gambit": { name: "Gravity Gambit: Orbital Golf", file: "gravity-gambit.html" },
  "silent-fathom": { name: "Silent Fathom: Sonar Descent", file: "silent-fathom.html" },
  "skyhook": { name: "Skyhook: Cascade Run", file: "skyhook.html" },
} as const;

export type ArcadeGameId = keyof typeof ARCADE_GAMES;
