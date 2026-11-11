// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/plugin_catalog.test.ts - P-PLUGINS.1 (ADR-0461/0463/0465): the catalog invariants that money
// and access depend on, and the premium card state machine.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  FREE_PLUGINS, PREMIUM_PLUGINS, cardActionLabel, decideCardAction, isNewerVersion, parseCageOrUei, parseTierPref, sortFree,
  type CardFacts, type PremiumPlugin,
} from "./plugin_catalog.ts";
import type { Entitlement, GovAccessStatus } from "../../harness/market/entitlement.ts";

const NOW = "2026-10-31T12:00:00.000Z";
const facts = (over: Partial<CardFacts> = {}): CardFacts =>
  ({ signedIn: true, entitlement: null, gov: "none", installedVersion: null, busy: false, nowIso: NOW, ...over });
const owned = (over: Partial<Entitlement> = {}): Entitlement => ({ packId: "x", state: "active", method: "card", ...over });
const GOV: GovAccessStatus[] = ["none", "pending", "approved", "declined"];

/** Every combination of the facts a card can see, for the "no fact can ever ..." invariants. */
function* everyFacts(): Generator<CardFacts> {
  for (const signedIn of [false, true])
    for (const entitlement of [null, owned(), owned({ state: "expired" }), owned({ latestVersion: "9.0.0" })])
      for (const gov of GOV)
        for (const installedVersion of [null, "1.0.0"])
          for (const busy of [false, true]) yield facts({ signedIn, entitlement, gov, installedVersion, busy });
}

// The PLUGINS-CONTRACT catalog table, verbatim: id -> section, and the Stripe lookup key or null for a link-out.
const CONTRACT: Record<string, { section: "civilian" | "government"; lookupKey: string | null }> = {
  pathfinder: { section: "civilian", lookupKey: "PLG-PATHFINDER-OTF" },
  myhome: { section: "civilian", lookupKey: "PLG-MYHOME-OTF" },
  agentictrade187: { section: "civilian", lookupKey: "PLG-AT187-OTF" },
  homeschooltutor: { section: "civilian", lookupKey: "PLG-HST-OTF" },
  "tactical-genai-trainer": { section: "civilian", lookupKey: "PLG-TGT-OTF" },
  "lucid-meeting-hub": { section: "civilian", lookupKey: "PLG-MEETHUB-OTF" },
  "rapid-survey": { section: "government", lookupKey: "PLG-RAPID-OTF" },
  "quantum-cloak": { section: "government", lookupKey: "PLG-QCLOAK-OTF" },
  leaps: { section: "civilian", lookupKey: null },
  "mdmp-engine": { section: "government", lookupKey: null },
  "joint-planning-engine": { section: "government", lookupKey: null },
};

describe("premium catalog matches the contract", () => {
  test("exactly the contract ids, each in its section, sold ones with their lookup key and link-outs with none", () => {
    expect(PREMIUM_PLUGINS.map((p) => p.id).sort()).toEqual(Object.keys(CONTRACT).sort());
    for (const p of PREMIUM_PLUGINS) {
      const c = CONTRACT[p.id]!;
      expect(p.section).toBe(c.section);
      expect(p.sale === "buy" ? p.lookupKey : null).toBe(c.lookupKey);
    }
  });

  test("the owner grant and Mission Forge are never cards", () => {
    const ids = PREMIUM_PLUGINS.map((p) => p.id);
    expect(ids).not.toContain("premium-all");
    expect(ids.some((id) => /mission/i.test(id))).toBe(false);
    expect(PREMIUM_PLUGINS.some((p) => /mission forge/i.test(`${p.name} ${p.pitch} ${p.lucid}`))).toBe(false);
  });

  test("partner and subscription link-outs say what they are", () => {
    for (const id of ["mdmp-engine", "joint-planning-engine"]) {
      const p = PREMIUM_PLUGINS.find((x) => x.id === id)!;
      expect(p.sale === "link" && p.partner).toBe("Black Arrow Systems");
      expect(p.sale === "link" && /^https:\/\//.test(p.href)).toBe(true);
    }
    const leaps = PREMIUM_PLUGINS.find((x) => x.id === "leaps")!;
    expect(leaps.sale === "link" && leaps.linkLabel).toBe("Subscription on leaps");
  });

  test("every card carries a pitch and a With LUCID Agent line in plain text (no em dashes)", () => {
    for (const p of [...PREMIUM_PLUGINS.map((x) => [x.pitch, x.lucid, x.kicker]), ...FREE_PLUGINS.map((x) => [x.desc, x.lucid])].flat()) {
      expect(p.trim().length).toBeGreaterThan(0);
      expect(p).not.toContain("\u2014");
    }
  });

  test("every bundled media file a card names is actually shipped (offline, no broken posters)", () => {
    const dir = join(import.meta.dir, "assets", "plugins");
    for (const p of PREMIUM_PLUGINS) {
      if (p.media.poster === "webp") expect(existsSync(join(dir, `${p.id}-poster.webp`))).toBe(true);
      if (p.media.loop) expect(existsSync(join(dir, `${p.id}-loop.mp4`))).toBe(true);
    }
  });
});

describe("decideCardAction", () => {
  const allSold = PREMIUM_PLUGINS.filter((p): p is Extract<PremiumPlugin, { sale: "buy" }> => p.sale === "buy");
  const sold = allSold.filter((p) => p.available);
  const unavailable = allSold.filter((p) => !p.available);
  const civilian = sold.filter((p) => p.section === "civilian");
  const government = sold.filter((p) => p.section === "government");

  test("only the packaged and verified plugins are on sale", () => {
    expect(sold.map((p) => p.id).sort()).toEqual(["agentictrade187", "myhome", "pathfinder", "quantum-cloak"]);
    expect(unavailable.map((p) => p.id).sort()).toEqual(["homeschooltutor", "lucid-meeting-hub", "rapid-survey", "tactical-genai-trainer"]);
  });

  test("an unavailable plugin is Coming soon whatever the facts: never Buy, Request access, Install or Update", () => {
    for (const p of unavailable) for (const f of everyFacts()) expect(decideCardAction(p, f)).toEqual({ kind: "coming-soon" });
    expect(cardActionLabel({ kind: "coming-soon" })).toBe("Coming soon");
  });

  test("every sold plugin walks Sign in -> Buy -> Install -> Installing -> Open -> Update", () => {
    for (const p of sold) {
      const gov: GovAccessStatus = p.section === "government" ? "approved" : "none";
      expect(decideCardAction(p, facts({ signedIn: false, gov })).kind).toBe("signin");
      expect(decideCardAction(p, facts({ gov })).kind).toBe("buy");
      expect(decideCardAction(p, facts({ gov, entitlement: owned() })).kind).toBe("install");
      expect(decideCardAction(p, facts({ gov, entitlement: owned(), busy: true })).kind).toBe("installing");
      expect(decideCardAction(p, facts({ gov, entitlement: owned({ latestVersion: "1.0.0" }), installedVersion: "1.0.0" })).kind).toBe("open");
      expect(decideCardAction(p, facts({ gov, entitlement: owned({ latestVersion: "1.1.0" }), installedVersion: "1.0.0" }))).toEqual({ kind: "update", to: "1.1.0" });
    }
  });

  test("link-outs never offer Buy, Install or Open, whatever the facts", () => {
    for (const p of PREMIUM_PLUGINS.filter((x) => x.sale === "link")) {
      for (const f of everyFacts()) expect(decideCardAction(p, f).kind).toBe("visit");
    }
  });

  test("a Government plugin offers Buy only with approved access", () => {
    for (const p of government) {
      for (const f of everyFacts()) {
        if (decideCardAction(p, f).kind === "buy") expect(f.gov).toBe("approved");
      }
      expect(decideCardAction(p, facts({ gov: "none" }))).toEqual({ kind: "request-access", declined: false });
      expect(decideCardAction(p, facts({ gov: "declined" }))).toEqual({ kind: "request-access", declined: true });
      expect(decideCardAction(p, facts({ gov: "pending" })).kind).toBe("access-pending");
      expect(decideCardAction(p, facts({ gov: "approved" })).kind).toBe("buy");
    }
  });

  test("Civilian plugins never ask for government access", () => {
    for (const p of civilian) for (const f of everyFacts()) expect(["request-access", "access-pending"]).not.toContain(decideCardAction(p, f).kind);
  });

  test("fail-closed: an expired or stale entitlement buys again; an installed plugin still opens offline", () => {
    const p = civilian[0]!;
    expect(decideCardAction(p, facts({ entitlement: owned({ state: "expired" }) })).kind).toBe("buy");
    expect(decideCardAction(p, facts({ entitlement: owned({ expiresAt: "2026-01-01T00:00:00.000Z" }) })).kind).toBe("buy");
    // Perpetual (ADR-0463): signed out or no longer entitled, an installed plugin opens; it just never updates.
    expect(decideCardAction(p, facts({ signedIn: false, installedVersion: "1.0.0" })).kind).toBe("open");
    expect(decideCardAction(p, facts({ entitlement: owned({ state: "expired", latestVersion: "2.0.0" }), installedVersion: "1.0.0" })).kind).toBe("open");
  });

  test("labels name the price and the target version", () => {
    expect(cardActionLabel({ kind: "buy" })).toBe("Buy $29.99");
    expect(cardActionLabel({ kind: "update", to: "1.2.0" })).toBe("Update to 1.2.0");
    expect(cardActionLabel({ kind: "visit", url: "https://x", label: "Visit partner" })).toBe("Visit partner");
  });
});

describe("isNewerVersion", () => {
  test("numeric semver, prereleases below their release, garbage never newer", () => {
    expect(isNewerVersion("0.10.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false);
    expect(isNewerVersion("1.0.0", "1.0.0-beta.2")).toBe(true);
    expect(isNewerVersion("1.0.0-beta.10", "1.0.0-beta.2")).toBe(true);
    expect(isNewerVersion("1.0.0-beta.2", "1.0.0")).toBe(false);
    expect(isNewerVersion("latest", "1.0.0")).toBe(false);
    expect(isNewerVersion(null, "1.0.0")).toBe(false);
  });
});

describe("drawer preferences and forms", () => {
  test("the toggle defaults to PREMIUM; only an explicit FREE sticks", () => {
    expect(parseTierPref(null)).toBe("premium");
    expect(parseTierPref("")).toBe("premium");
    expect(parseTierPref("FREE")).toBe("premium");
    expect(parseTierPref("free")).toBe("free");
  });

  test("CAGE or UEI: 5 or 12 alphanumerics, blank allowed", () => {
    expect(parseCageOrUei(" 1abc2 ")).toEqual({ cage: "1ABC2" });
    expect(parseCageOrUei("ab12cd34ef56")).toEqual({ uei: "AB12CD34EF56" });
    expect(parseCageOrUei("")).toEqual({});
    expect("error" in parseCageOrUei("12-34")).toBe(true);
  });
});

describe("free catalog", () => {
  test("Excalidraw stays first; Obsidian, Git and the shipped capabilities are built-in", () => {
    expect(sortFree(FREE_PLUGINS)[0]!.id).toBe("excalidraw");
    const status = Object.fromEntries(FREE_PLUGINS.map((p) => [p.id, p.status]));
    for (const id of ["obsidian", "git", "browser", "codegraph", "openfilm", "whisper", "knowledge-graph"]) expect(status[id]).toBe("built-in");
  });

  test("ids and ranks are unique, retired ids stay retired, and every project link is an https GitHub repo", () => {
    expect(new Set(FREE_PLUGINS.map((p) => p.id)).size).toBe(FREE_PLUGINS.length);
    expect(new Set(FREE_PLUGINS.map((p) => p.rank)).size).toBe(FREE_PLUGINS.length);
    for (const retired of ["copilot", "brat", "url-into-selection", "readwise"]) expect(FREE_PLUGINS.some((p) => p.id === retired)).toBe(false);
    for (const p of FREE_PLUGINS) if (p.repo) expect(p.repo).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
    expect(FREE_PLUGINS.filter((p) => p.status === "planned").every((p) => !!p.repo)).toBe(true);
  });
});
