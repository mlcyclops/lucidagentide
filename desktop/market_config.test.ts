// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/market_config.test.ts — ADR-0223: the marketplace boot config the preload injects. Verifies the
// default enables firebase at the official endpoints (so "Get pack" reaches Stripe), and that the env knobs
// disable it / point it elsewhere. Pure (env injected).

import { describe, expect, test } from "bun:test";
import { marketBootConfig } from "./market_config.ts";

describe("marketBootConfig", () => {
  test("default → firebase mode at the official lucid-agent endpoints", () => {
    const c = marketBootConfig({});
    expect(c.mode).toBe("firebase");
    expect(c.functionsBaseUrl).toBe("https://us-central1-lucid-agent.cloudfunctions.net");
    expect(c.signInUrl).toBe("https://lucid-agent.web.app/signin");
  });
  test("LUCID_MARKET_MODE=off → disabled (storefront-hint fallback)", () => {
    expect(marketBootConfig({ LUCID_MARKET_MODE: "off" })).toEqual({ mode: "off" });
    expect(marketBootConfig({ LUCID_MARKET_MODE: "OFF" })).toEqual({ mode: "off" }); // case-insensitive
  });
  test("LUCID_MARKET_MODE=stub → the local dev stub", () => {
    expect(marketBootConfig({ LUCID_MARKET_MODE: "stub" })).toEqual({ mode: "stub" });
  });
  test("URL overrides win, with a trailing slash trimmed off the functions base", () => {
    const c = marketBootConfig({ LUCID_MARKET_FUNCTIONS_URL: "https://fn.example.com/", LUCID_MARKET_SIGNIN_URL: "https://s.example.com/signin" });
    expect(c.functionsBaseUrl).toBe("https://fn.example.com");
    expect(c.signInUrl).toBe("https://s.example.com/signin");
  });
});
