// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/role_icons.ts - premium animated SVG glyphs for the onboarding role splash.
//
// PURE string builders (no DOM), so the demo + test assert on the markup without a browser. Each is a
// 28×28 stroke glyph in the app's icon family (currentColor, round caps) with one or two CSS-animated
// parts (styles.css `.ri-*`). Color comes from the card (.role-ic.r-<role>); motion respects
// prefers-reduced-motion. These are bigger, livelier siblings of the static picker glyphs.

import type { UserRole } from "./bridge.ts";

const SVG_OPEN =
  '<svg class="ri ri-{k}" viewBox="0 0 28 28" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';

// Developer - a code window with a `< >` and a blinking caret.
const DEVELOPER = `${SVG_OPEN.replace("{k}", "dev")}
  <rect x="3.5" y="5" width="21" height="18" rx="3.5"/>
  <path d="M3.5 9.5h21" opacity=".45"/>
  <path class="ri-dev-l" d="M11 13.6 8.6 16l2.4 2.4"/>
  <path class="ri-dev-r" d="M17 13.6 19.4 16 17 18.4"/>
  <line class="ri-caret" x1="13.2" y1="19.6" x2="14.8" y2="19.6"/>
</svg>`;

// Security - a shield with a checkmark that re-draws on a loop.
const SECURITY = `${SVG_OPEN.replace("{k}", "sec")}
  <path d="M14 3.4 22 6.4v6c0 5-3.4 8.9-8 11-4.6-2.1-8-6-8-11v-6z"/>
  <path class="ri-check" d="M10.2 13.8 12.8 16.4 18 11"/>
</svg>`;

// Manager - a bar chart whose bars rise in a staggered pulse, with a trend arrow.
const MANAGER = `${SVG_OPEN.replace("{k}", "mgr")}
  <path d="M4.5 23h19" opacity=".45"/>
  <line class="ri-bar ri-bar1" x1="8.5" y1="23" x2="8.5" y2="17.5"/>
  <line class="ri-bar ri-bar2" x1="14" y1="23" x2="14" y2="13.5"/>
  <line class="ri-bar ri-bar3" x1="19.5" y1="23" x2="19.5" y2="9.5"/>
  <path class="ri-trend" d="M6.5 16.5 11 13l4 2 6.5-6.5"/>
  <path class="ri-trend" d="M18.5 8.5H22V12" opacity=".9"/>
</svg>`;

// Executive - a featureless person-in-a-suit bust (round head, suit shoulders, tie) that gently breathes.
const EXECUTIVE = `${SVG_OPEN.replace("{k}", "exec")}
  <g class="ri-bust">
    <circle cx="14" cy="8.2" r="3.9"/>
    <path d="M5.5 24c0-4.9 3.8-8.3 8.5-8.3s8.5 3.4 8.5 8.3"/>
    <path d="M10.7 16.5 14 20.1l3.3-3.6"/>
    <path class="ri-tie" d="M14 20.1l-1.05 2.9 1.05 1.3 1.05-1.3z" fill="currentColor" stroke="none"/>
  </g>
</svg>`;

const ICONS: Record<UserRole, string> = {
  developer: DEVELOPER,
  security: SECURITY,
  manager: MANAGER,
  executive: EXECUTIVE,
};

/** The premium animated role glyph for the onboarding splash card. */
export function roleIcon(role: UserRole): string {
  return ICONS[role] ?? DEVELOPER;
}
