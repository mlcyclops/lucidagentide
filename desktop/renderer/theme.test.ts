// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/theme.test.ts
//
// P-THEME.1. Two jobs here, and the second is the load-bearing one.
//
// 1. Pin the theme.ts contract app.ts renders against (ids, count, resolve/fallback precedence).
// 2. PARSE styles.css AND trainer.html OFF DISK and prove every palette block declares every
//    token the base declares. A theme system does not fail loudly: a light palette that forgot
//    --txt inherits the dark base's near-white and ships unreadable white-on-white. Nothing in
//    a typecheck or a render smoke test catches that, so it is caught here, structurally.
//    Same reason the hex/rgb agreement and the WCAG ratios are computed rather than eyeballed.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_THEME_ID, SYSTEM_THEME_ID, monacoThemeFor, resolveTheme, THEMES, themeAttr, themeGroups } from "./theme.ts";

const HERE = import.meta.dir;
const CSS = readFileSync(join(HERE, "styles.css"), "utf8");
const TRAINER = readFileSync(join(HERE, "trainer.html"), "utf8");

const EXPECTED_IDS = ["lucid-dark", "lucid-light", "midnight", "slate", "ember", "paper", "contrast"];
const EM_DASH = "\u2014";

// ── the registry ──────────────────────────────────────────────────────────────────────

describe("THEMES registry", () => {
  test("ships exactly the seven ids app.ts and styles.css agree on", () => {
    expect(THEMES.map((t) => t.id).sort()).toEqual([...EXPECTED_IDS].sort());
    expect(THEMES).toHaveLength(7);
  });

  test("has unique kebab-case ids", () => {
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
    for (const t of THEMES) expect(t.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  test("has exactly two light themes", () => {
    expect(THEMES.filter((t) => t.scheme === "light").map((t) => t.id)).toEqual(["lucid-light", "paper"]);
  });

  test("defaults to lucid-dark", () => {
    expect(DEFAULT_THEME_ID).toBe("lucid-dark");
    expect(THEMES.some((t) => t.id === DEFAULT_THEME_ID)).toBe(true);
  });

  test("has a one-line label and a blurb on every theme, with no em dash anywhere", () => {
    for (const t of THEMES) {
      expect(t.label.trim().length).toBeGreaterThan(0);
      expect(t.blurb.trim().length).toBeGreaterThan(0);
      // A label that wraps breaks invariant 11 in a fixed-width picker cell; keep them short.
      expect(t.label.length).toBeLessThanOrEqual(20);
      expect(t.label).not.toContain("\n");
      expect(t.label).not.toContain(EM_DASH);
      expect(t.blurb).not.toContain(EM_DASH);
    }
  });

  test("gives every theme a 3-tuple of valid #rrggbb swatches", () => {
    for (const t of THEMES) {
      expect(t.swatch).toHaveLength(3);
      for (const hex of t.swatch) expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  test("groups dark first for the picker", () => {
    const groups = themeGroups();
    expect(groups.map((g) => g.scheme)).toEqual(["dark", "light"]);
    // Every theme lands in exactly one group, and nothing is dropped.
    expect(groups.flatMap((g) => g.themes.map((t) => t.id)).sort()).toEqual([...EXPECTED_IDS].sort());
    for (const g of groups) for (const t of g.themes) expect(t.scheme).toBe(g.scheme);
  });
});

// ── resolve precedence ────────────────────────────────────────────────────────────────

describe("resolveTheme", () => {
  test("P-THEME.2: UNSET means Lucid Dark, and never the OS hint", () => {
    // THE REGRESSION THIS PINS: "never chosen" and "follow the OS" used to be the same stored value, so
    // a long-time user whose machine prefers light and who had never opened the theme panel was moved off
    // the dark UI they had always had, the day light mode shipped. An install nobody configured must not
    // change appearance because of a system setting the user never pointed at LUCID.
    expect(resolveTheme(undefined, true).id).toBe("lucid-dark");
    expect(resolveTheme(undefined, false).id).toBe("lucid-dark");
    expect(resolveTheme(null, true).id).toBe("lucid-dark");
    expect(resolveTheme("", true).id).toBe("lucid-dark");
    expect(resolveTheme("", false).id).toBe("lucid-dark");
    expect(resolveTheme(undefined, true).id).toBe(DEFAULT_THEME_ID);
  });

  test("P-THEME.2: following the OS is an EXPLICIT choice, and it still works", () => {
    // Nothing was taken away: a user who wants their app to track the system asks for it by id.
    expect(resolveTheme(SYSTEM_THEME_ID, true).id).toBe("lucid-light");
    expect(resolveTheme(SYSTEM_THEME_ID, false).id).toBe("lucid-dark");
    // The sentinel is deliberately NOT a palette id, so it can never collide with a real theme.
    expect(THEMES.map((t) => t.id)).not.toContain(SYSTEM_THEME_ID);
  });

  test("lets an explicit choice beat the OS preference, in both directions", () => {
    // The bug this pins: user picks Paper, the machine flips to dark at sunset, and the app
    // silently disagrees with what Settings shows.
    expect(resolveTheme("paper", false).id).toBe("paper");
    expect(resolveTheme("lucid-dark", true).id).toBe("lucid-dark");
    expect(resolveTheme("contrast", true).id).toBe("contrast");
    for (const t of THEMES) {
      expect(resolveTheme(t.id, true).id).toBe(t.id);
      expect(resolveTheme(t.id, false).id).toBe(t.id);
    }
  });

  test("treats a retired or corrupt stored id as the DEFAULT, not as the OS hint", () => {
    // Same direction as unset, and for the same reason: a theme we retired must not silently hand the
    // user's appearance to their OS setting. Dark is also the safe direction, because the bare `:root`
    // palette IS lucid-dark, so the CSS and the attribute agree even if JS never runs.
    expect(resolveTheme("nonsense", false).id).toBe("lucid-dark");
    expect(resolveTheme("nonsense", true).id).toBe("lucid-dark");
    expect(resolveTheme("LUCID-DARK", false).id).toBe("lucid-dark"); // ids are case-sensitive
    expect(resolveTheme("LUCID-DARK", true).id).toBe("lucid-dark");
  });
});

describe("themeAttr", () => {
  test("only ever emits an id that has a palette block", () => {
    for (const t of THEMES) expect(themeAttr(t.id)).toBe(t.id);
    // Never pass an unknown id through: a stale light id would select nothing and silently
    // fall through to the dark base.
    expect(themeAttr("nonsense")).toBe("lucid-dark");
    expect(themeAttr("")).toBe("lucid-dark");
  });
});

describe("monacoThemeFor", () => {
  test("maps by scheme and never throws on garbage", () => {
    for (const t of THEMES) expect(monacoThemeFor(t.id)).toBe(t.scheme === "light" ? "lucid-light" : "lucid-dark");
    for (const junk of ["", "nonsense", "../../etc", "lucid", "LIGHT", "null", "undefined", "0"]) {
      expect(() => monacoThemeFor(junk)).not.toThrow();
      expect(monacoThemeFor(junk)).toBe("lucid-dark");
    }
  });
});

// ── CSS parsing helpers ───────────────────────────────────────────────────────────────

interface Palette { id: string; selector: string; tokens: Record<string, string> }

/** Every `@palette <id>` marker block in a stylesheet, plus its declared custom properties. */
function palettes(css: string): Palette[] {
  const out: Palette[] = [];
  const re = /\/\* @palette ([a-z0-9-]+) \*\/\s*\n(:root[^{]*)\{([\s\S]*?)\n\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    out.push({ id: m[1]!, selector: m[2]!.trim(), tokens: decls(m[3]!) });
  }
  return out;
}

/** The `--name:value` pairs in a declaration body, comments stripped. */
function decls(block: string): Record<string, string> {
  const body = block.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}


function rgbOf(hex: string): [number, number, number] {
  const h = hex.trim().replace(/^#/, "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG 2.2 relative luminance / contrast ratio, computed so nobody has to trust a screenshot. */
function luminance(hex: string): number {
  const [r, g, b] = rgbOf(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// ── token completeness: the test that stops light mode rotting ────────────────────────

describe("styles.css palette blocks", () => {
  const pal = palettes(CSS);
  const byId = new Map(pal.map((p) => [p.id, p]));
  const base = byId.get("lucid-dark")!;

  test("declares one palette block per registered theme id, and nothing extra", () => {
    expect(pal.map((p) => p.id).sort()).toEqual(THEMES.map((t) => t.id).sort());
    expect(pal).toHaveLength(THEMES.length);
  });

  test("implements lucid-dark AS the bare :root, so a JS failure still paints today's app", () => {
    // Deliberate: the default theme is the fallback, claimed by ONE grouped selector rather than
    // duplicated into a second block. `:root` handles "attribute never set", and the attribute
    // half of the selector is what lets an explicit dark pick beat the prefers-color-scheme guard
    // (they are mutually exclusive matches, so there is no specificity race).
    expect(base.selector).toBe(':root, :root[data-theme="lucid-dark"]');
    for (const p of pal) {
      if (p.id === "lucid-dark") continue;
      expect(p.selector).toBe(`:root[data-theme="${p.id}"]`);
    }
  });

  test("has every theme declare EVERY token the base declares", () => {
    const want = Object.keys(base.tokens).sort();
    expect(want.length).toBeGreaterThan(60); // guard against a parser that silently matched nothing
    for (const p of pal) {
      // Both directions on purpose: a MISSING token inherits the dark base (the unreadable-light-mode
      // bug), and an EXTRA token is one the base forgot, so every other theme is missing it.
      expect(Object.keys(p.tokens).sort(), `theme "${p.id}" token set drifted from the base`).toEqual(want);
    }
  });

  test("P-THEME.2: has NO prefers-color-scheme fallback, because unset means Lucid Dark", () => {
    // The inverse of the assertion this replaces. P-THEME.1 duplicated the lucid-light palette into an
    // `@media (prefers-color-scheme: light) { :root:not([data-theme]) { ... } }` block, and a test kept
    // the copy honest. That whole mechanism existed because an unset preference FOLLOWED the OS, which
    // is exactly what moved long-time users off the dark UI they already had. Unset now resolves to
    // lucid-dark, the bare `:root` above already IS lucid-dark, so the correct no-attribute first paint
    // needs no media query and no second copy of a palette that could drift.
    expect(CSS).not.toContain("@palette-osfallback");
    expect(CSS).not.toMatch(/@media \(prefers-color-scheme: light\)\s*\{\s*\n\s*:root:not\(\[data-theme\]\)/);
    // And the reason it is safe to have none: the base selector still carries the default theme.
    expect(base.selector).toContain(":root,");
  });

  test("declares a color-scheme on every palette block so native controls follow", () => {
    for (const p of pal) {
      const want = THEMES.find((t) => t.id === p.id)!.scheme;
      const m = CSS.match(new RegExp(`@palette ${p.id} \\*/[\\s\\S]*?color-scheme:(dark|light);`));
      expect(m?.[1], `theme "${p.id}" is missing color-scheme`).toBe(want);
    }
  });

  test("keeps every --x-rgb triplet in step with its --x hex", () => {
    // The one real cost of carrying both forms. A drifted triplet shows up only in animation
    // glows and alpha washes, which is exactly where nobody looks.
    for (const p of pal) {
      for (const [name, value] of Object.entries(p.tokens)) {
        if (!name.endsWith("-rgb")) continue;
        const hexToken = name.slice(0, -4);
        const hex = p.tokens[hexToken];
        if (!hex || !hex.startsWith("#")) continue; // -sh-/-scrim-/-glass- inks have no hex twin
        expect(value.split(/\s+/).map(Number), `${p.id} ${name} != ${hexToken}`).toEqual([...rgbOf(hex)]);
      }
    }
  });

  test("matches every swatch in theme.ts to that palette's (bg-0, accent, txt)", () => {
    for (const t of THEMES) {
      const p = byId.get(t.id)!;
      expect([p.tokens["--bg-0"], p.tokens["--accent"], p.tokens["--txt"]], `swatch for "${t.id}"`).toEqual(t.swatch);
    }
  });

  test("hits its accessibility target for body text on the page ground", () => {
    for (const t of THEMES) {
      const p = byId.get(t.id)!;
      const ratio = contrast(p.tokens["--txt"]!, p.tokens["--bg-0"]!);
      // `contrast` exists to be AAA; every other theme must at minimum clear AA body text, and
      // the two light ones are called out because that is where a naive port breaks down.
      const min = t.id === "contrast" ? 7 : 4.5;
      expect(ratio, `${t.id}: --txt on --bg-0 is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(min);
    }
    expect(contrast(byId.get("lucid-light")!.tokens["--txt"]!, byId.get("lucid-light")!.tokens["--bg-0"]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(byId.get("paper")!.tokens["--txt"]!, byId.get("paper")!.tokens["--bg-0"]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(byId.get("contrast")!.tokens["--txt"]!, byId.get("contrast")!.tokens["--bg-0"]!)).toBeGreaterThanOrEqual(7);
  });

  test("keeps the light themes' state-hue text legible on their own tint", () => {
    // The subtle half of a light port: --red/--green/--amber were picked to glow on near-black,
    // and a straight copy leaves 2:1 text on a pale wash. --*-txt is the light-side answer.
    for (const id of ["lucid-light", "paper"]) {
      const p = byId.get(id)!;
      for (const tok of ["--red-txt", "--amber-txt", "--green-txt", "--blue-txt", "--cyan-txt", "--violet-txt"]) {
        const ratio = contrast(p.tokens[tok]!, p.tokens["--bg-2"]!);
        expect(ratio, `${id} ${tok} on --bg-2 is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

// ── the trainer iframe carries its own copy of the contract ───────────────────────────

describe("trainer.html palette blocks", () => {
  const pal = palettes(TRAINER);
  const byId = new Map(pal.map((p) => [p.id, p]));

  test("covers the same theme ids as theme.ts", () => {
    // The trainer is a same-origin iframe with its OWN document: styles.css cannot reach it (and
    // must not, the class names collide), so it duplicates the token contract for the 36 colours
    // it uses. If an id is added to THEMES and not here, the trainer silently stays dark.
    expect(pal.map((p) => p.id).sort()).toEqual(THEMES.map((t) => t.id).sort());
  });

  test("has every trainer theme declare EVERY token its base declares", () => {
    const want = Object.keys(byId.get("lucid-dark")!.tokens).sort();
    expect(want.length).toBeGreaterThan(30);
    for (const p of pal) expect(Object.keys(p.tokens).sort(), `trainer theme "${p.id}" drifted`).toEqual(want);
  });

  test("P-THEME.2: has no prefers-color-scheme fallback either, matching styles.css", () => {
    // The trainer mirrors the PARENT's [data-theme] in an inline head script, and app.ts always stamps a
    // real id, so this block only ever applied before app.js ran. Unset means Lucid Dark now, and the
    // trainer's bare `:root` already IS lucid-dark, so there is nothing left for a media query to fix.
    expect(TRAINER).not.toContain("@palette-osfallback");
    expect(TRAINER).not.toMatch(/@media \(prefers-color-scheme: light\)/);
  });

  test("mirrors the parent document's [data-theme] from <head>, before first paint", () => {
    const head = TRAINER.slice(0, TRAINER.indexOf("</head>"));
    expect(head).toContain("window.parent.document.documentElement");
    expect(head).toContain('attributeFilter: ["data-theme"]');
  });
});
