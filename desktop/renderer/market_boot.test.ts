// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/market_boot.test.ts — P-KGMARKET.4 part 2 (ADR-0206): the sign-in orchestration. Pins the
// pure mode/URL helpers and the injectable init: stub mode signs in locally + the deep-link callback applies,
// firebase mode opens the hosted URL (with redirect + login hint) and stays signed-out until the callback,
// and "off" leaves the fail-closed nullProvider. Storage + browser-open + clock are injected — no Electron.

import { afterEach, describe, expect, test } from "bun:test";
import {
  buildSignInUrl, chooseMarketMode, initMarket, beginSignIn, handleAuthCallback, marketUser, marketSignOut,
  __resetMarketBootForTest,
} from "./market_boot.ts";
import { getMarketProvider } from "./market_gate.ts";
import type { AuthStorage } from "./market_auth.ts";

afterEach(() => __resetMarketBootForTest());

const mem = (): AuthStorage => { let v: string | null = null; return { get: () => v, set: (x) => { v = x; }, remove: () => { v = null; } }; };
const NOW = 1_700_000_000_000;

describe("chooseMarketMode", () => {
  test("infers firebase from a functionsBaseUrl, else off", () => {
    expect(chooseMarketMode({ functionsBaseUrl: "https://f.example" })).toBe("firebase");
    expect(chooseMarketMode({})).toBe("off");
    expect(chooseMarketMode(null)).toBe("off");
  });
  test("explicit mode wins, but firebase without a base falls back to off", () => {
    expect(chooseMarketMode({ mode: "stub" })).toBe("stub");
    expect(chooseMarketMode({ mode: "off", functionsBaseUrl: "https://f.example" })).toBe("off");
    expect(chooseMarketMode({ mode: "firebase" })).toBe("off");
  });
});

describe("buildSignInUrl", () => {
  test("adds the deep-link redirect + optional login hint", () => {
    const u = new URL(buildSignInUrl("https://lucid-agent.web.app/signin", "buyer@x.com"));
    expect(u.origin + u.pathname).toBe("https://lucid-agent.web.app/signin");
    expect(u.searchParams.get("redirect_uri")).toBe("lucid://auth");
    expect(u.searchParams.get("login_hint")).toBe("buyer@x.com");
  });
  test("empty for a missing/garbage base", () => {
    expect(buildSignInUrl(undefined)).toBe("");
    expect(buildSignInUrl("not a url")).toBe("");
  });
});

describe("initMarket + beginSignIn", () => {
  test("stub mode: begins signed-in locally; the provider sees the user; sign-out clears", () => {
    expect(initMarket({ mode: "stub" }, { storage: mem(), now: () => NOW })).toBe("stub");
    expect(marketUser().signedIn).toBe(false);
    const r = beginSignIn("dev@lucid.local");
    expect(r).toEqual({ opened: false, signedIn: true });
    expect(marketUser()).toEqual({ signedIn: true, email: "dev@lucid.local" });
    expect(getMarketProvider().configured()).toBe(true);
    marketSignOut();
    expect(marketUser().signedIn).toBe(false);
  });

  test("firebase mode: opens the hosted URL and stays signed-out until the deep link arrives", () => {
    const opened: string[] = [];
    initMarket(
      { mode: "firebase", functionsBaseUrl: "https://f.example", signInUrl: "https://lucid-agent.web.app/signin" },
      { storage: mem(), now: () => NOW, openExternal: (u) => opened.push(u) },
    );
    const r = beginSignIn("buyer@x.com");
    expect(r.opened).toBe(true);
    expect(r.signedIn).toBe(false);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain("redirect_uri=lucid%3A%2F%2Fauth");
    expect(marketUser().signedIn).toBe(false); // not signed in until the callback

    // the browser bounces back to lucid://auth?token=... → main forwards it here
    expect(handleAuthCallback("lucid://auth?token=real-token&email=buyer%40x.com&exp=1700000900")).toBe(true);
    expect(marketUser()).toEqual({ signedIn: true, email: "buyer@x.com" });
  });

  test("off mode: nullProvider stays, sign-in is a no-op", () => {
    expect(initMarket({}, { storage: mem() })).toBe("off");
    expect(getMarketProvider().configured()).toBe(false);
    const r = beginSignIn();
    expect(r).toEqual({ opened: false, signedIn: false, reason: "marketplace sign-in is not configured" });
  });

  test("an invalid deep link does not sign the user in", () => {
    initMarket({ mode: "firebase", functionsBaseUrl: "https://f.example", signInUrl: "https://s.example" }, { storage: mem(), now: () => NOW, openExternal: () => {} });
    expect(handleAuthCallback("lucid://nope")).toBe(false);
    expect(marketUser().signedIn).toBe(false);
  });
});
