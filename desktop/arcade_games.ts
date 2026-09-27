// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

/** Original, offline HTML games served through the existing sandboxed Preview. */
export const ARCADE_GAMES = {
  "orbit-loom": { name: "Orbit Loom", file: "orbit-loom.html" },
  "signal-garden": { name: "Signal Garden", file: "signal-garden.html" },
  "nebula-fusion": { name: "Nebula Fusion: Voyage", file: "nebula-fusion.html" },
} as const;

export type ArcadeGameId = keyof typeof ARCADE_GAMES;
