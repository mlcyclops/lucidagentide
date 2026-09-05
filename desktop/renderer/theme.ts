// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/theme.ts
//
// P-THEME.1: the single registry of app themes. PURE and DOM-free on purpose, so the whole
// resolve/fallback story is unit-testable without a renderer (see theme.test.ts, which also
// reads styles.css off disk and fails when a palette block is missing a token).
//
// Division of labour:
//   * this file      - which themes exist, their ids, labels, swatches, and the resolve rules
//   * styles.css     - one `:root[data-theme="<id>"]` palette block per id (base `:root` IS
//                      lucid-dark, so a JS failure still paints today's app)
//   * app.ts (Main)  - reads the persisted id, calls resolveTheme(), sets the attribute on
//                      `document.documentElement`, and renders the picker from THEMES
//   * ide_panel.ts   - maps the app theme onto a registered Monaco theme via monacoThemeFor()
//
// Adding a theme is a three-step contract and all three steps are enforced: add the ThemeDef
// here, add the `[data-theme]` palette block in styles.css, and the token-completeness test
// refuses a block that omits any token the base declares. That refusal is the whole point: a
// half-declared light palette inherits dark text tokens and ships unreadable dark-on-light UI.

export interface ThemeDef {
  id: string;          // stable persisted key, kebab-case
  label: string;       // one-line UI label, must not wrap (invariant 11)
  scheme: "dark" | "light";
  blurb: string;       // one short sentence for the settings row
  swatch: [string, string, string]; // bg, accent, text preview hexes for the picker chip
}

// The swatch triplet is literally (--bg-0, --accent, --txt) out of that theme's palette block.
// Keep them in sync by hand: theme.test.ts pins the shape, and a wrong swatch is a cosmetic
// lie in the picker rather than a rendering bug, which is why it is not derived from the CSS.
export const THEMES: readonly ThemeDef[] = [
  {
    id: "lucid-dark",
    label: "Lucid Dark",
    scheme: "dark",
    blurb: "The original: near-black ground, magenta accent, cyan for data.",
    swatch: ["#0a0b0f", "#c64bd6", "#edeff6"],
  },
  {
    id: "midnight",
    label: "Midnight",
    scheme: "dark",
    blurb: "Deep indigo, cooler and quieter than the default.",
    swatch: ["#070a18", "#a86cf0", "#e9ecff"],
  },
  {
    id: "slate",
    label: "Slate",
    scheme: "dark",
    blurb: "Neutral grey with the colour turned right down.",
    swatch: ["#101114", "#a878b8", "#e8eaee"],
  },
  {
    id: "ember",
    label: "Ember",
    scheme: "dark",
    blurb: "Warm amber and red over a roasted dark ground.",
    swatch: ["#120c0a", "#f2653a", "#f8ece4"],
  },
  {
    // AAA body text on a pure-black ground. Kept in the dark group because it IS dark; it is
    // an accessibility choice, not a taste one, so the blurb says who it is for.
    id: "contrast",
    label: "High Contrast",
    scheme: "dark",
    blurb: "Pure black with maximum-contrast text for low vision.",
    swatch: ["#000000", "#ff6ee8", "#ffffff"],
  },
  {
    id: "lucid-light",
    label: "Lucid Light",
    scheme: "light",
    blurb: "The same brand hues on a light neutral ground.",
    swatch: ["#f6f7fb", "#a324b4", "#14161f"],
  },
  {
    id: "paper",
    label: "Paper",
    scheme: "light",
    blurb: "Warm sepia light, easy on the eyes in a bright room.",
    swatch: ["#f6f0e4", "#9c2b6d", "#2b2418"],
  },
];

export const DEFAULT_THEME_ID = "lucid-dark";

// The light theme an OS "prefers light" hint lands on when the user has never chosen. Only
// used for the never-chosen case: see resolveTheme.
const OS_LIGHT_THEME_ID = "lucid-light";

const BY_ID: ReadonlyMap<string, ThemeDef> = new Map(THEMES.map((t) => [t.id, t]));

/** Resolve a persisted id (possibly stale/absent) plus the OS preference into a real theme. */
export function resolveTheme(id: string | undefined | null, prefersLight: boolean): ThemeDef {
  // An EXPLICIT choice always wins. Letting the OS preference override a known id is the bug
  // where a user picks Paper, their machine flips to dark at sunset, and the app silently
  // disagrees with Settings. The OS hint only fills the "never chosen / id we retired" hole.
  const known = id ? BY_ID.get(id) : undefined;
  if (known) return known;
  const fallbackId = prefersLight ? OS_LIGHT_THEME_ID : DEFAULT_THEME_ID;
  // Non-null: both ids are in THEMES and theme.test.ts pins that.
  return BY_ID.get(fallbackId) as ThemeDef;
}

/** The value for the document's [data-theme] attribute. */
export function themeAttr(id: string): string {
  // Always an id that has a palette block, so the attribute can never select nothing. Passing
  // an unknown id through would silently fall back to the base `:root` (dark), which is right
  // for dark but catastrophic for a stale light id.
  return resolveTheme(id, false).id;
}

/** Which registered Monaco theme an app theme maps to. */
export function monacoThemeFor(id: string): "lucid-dark" | "lucid-light" {
  // Resolve first so garbage cannot throw: Monaco.setTheme on an unregistered name is an
  // exception mid-render, and an editor is not worth crashing a panel over.
  return resolveTheme(id, false).scheme === "light" ? "lucid-light" : "lucid-dark";
}

/** Themes grouped for the settings picker, dark group first. */
export function themeGroups(): { scheme: "dark" | "light"; themes: ThemeDef[] }[] {
  // Dark first because the default is dark: the active row should be in the first group the
  // eye lands on. Order WITHIN a group is THEMES order (curated, not alphabetical).
  return (["dark", "light"] as const)
    .map((scheme) => ({ scheme, themes: THEMES.filter((t) => t.scheme === scheme) }))
    .filter((g) => g.themes.length > 0);
}
