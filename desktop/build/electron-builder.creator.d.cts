// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Types for desktop/build/electron-builder.creator.cjs. The overlay is a .cjs because
// electron-builder loads it as a config module, but two TypeScript programs now read it: the desktop
// test that guards the identity + update-feed contract, and harness/scripts/demo_creator0.ts. The root
// program has noImplicitAny, so an untyped require there is a build error rather than a silent `any`.
//
// Only the fields something actually asserts on are named. The index signature carries the rest of
// electron-builder's surface (it is large, versioned by them, and not our contract to restate), so
// adding an override in the .cjs never requires editing this file.

declare const config: {
  appId: string;
  productName: string;
  /** Creator's auto-update feed. Isolated from Agent's on purpose: see the .cjs for the mechanism and
   *  for why a shared feed would have installed Agent bytes over a Creator install. */
  publish?: { provider: string; owner?: string; repo?: string; url?: string; channel?: string }[];
  [key: string]: unknown;
};

export = config;
