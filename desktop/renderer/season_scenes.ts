// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/season_scenes.ts - P-SEASON.1 (ADR-0525): the registry of animated backdrops.
// One file per scene under scenes/; the Record type makes a missing SceneId a compile error.

import type { SceneDef } from "./scene_kit.ts";
import type { SceneId } from "./seasons.ts";
import { scene as beach } from "./scenes/beach.ts";
import { scene as blossoms } from "./scenes/blossoms.ts";
import { scene as canyon } from "./scenes/canyon.ts";
import { scene as clover } from "./scenes/clover.ts";
import { scene as fireworks } from "./scenes/fireworks.ts";
import { scene as haunt } from "./scenes/haunt.ts";
import { scene as hearts } from "./scenes/hearts.ts";
import { scene as leaves } from "./scenes/leaves.ts";
import { scene as meadow } from "./scenes/meadow.ts";
import { scene as monument } from "./scenes/monument.ts";
import { scene as pitch } from "./scenes/pitch.ts";
import { scene as snow } from "./scenes/snow.ts";
import { scene as stadium } from "./scenes/stadium.ts";
import { scene as sunrise } from "./scenes/sunrise.ts";
import { scene as torch } from "./scenes/torch.ts";
import { scene as yosemite } from "./scenes/yosemite.ts";

export const SCENES: Record<SceneId, SceneDef> = {
  fireworks, sunrise, hearts, monument, clover, meadow, blossoms, yosemite,
  beach, canyon, haunt, leaves, snow, stadium, pitch, torch,
};

/** Picker order: the calendar order of the seasons that use each scene first. */
export const SCENE_ORDER: readonly SceneId[] = [
  "fireworks", "sunrise", "stadium", "hearts", "monument", "clover", "meadow", "blossoms", "yosemite",
  "beach", "pitch", "torch", "canyon", "haunt", "leaves", "snow",
];
