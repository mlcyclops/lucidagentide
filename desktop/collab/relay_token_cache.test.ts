// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/relay_token_cache.test.ts — P-REMOTE.2c (ADR-0226/0227): the backend relay-auth token cache.
//
// Pins the fail-closed behavior the host socket depends on: a fresh token is served, an about-to-expire or
// absent one reads as null (→ anonymous connect, refused by a gated relay), and set() rejects empty/stale.

import { describe, expect, it } from "bun:test";
import { RelayTokenCache } from "./relay_token_cache.ts";

const NOW = 1_800_000_000_000;

describe("RelayTokenCache (P-REMOTE.2c)", () => {
  it("serves a cached token while it has more than the skew window left", () => {
    const c = new RelayTokenCache({ now: () => NOW, skewMs: 60_000 });
    c.set("tok", NOW + 3600_000);
    expect(c.get()).toBe("tok");
    expect(c.present).toBe(true);
  });

  it("reads null within the skew window (never presents an about-to-die token)", () => {
    let clock = NOW;
    const c = new RelayTokenCache({ now: () => clock, skewMs: 60_000 });
    c.set("tok", NOW + 90_000); // 90s out
    expect(c.get()).toBe("tok"); // >60s skew → still served
    clock = NOW + 40_000; // now 50s from expiry, inside the 60s skew
    expect(c.get()).toBeNull();
    expect(c.present).toBe(false);
  });

  it("is empty by default and after clear()", () => {
    const c = new RelayTokenCache({ now: () => NOW });
    expect(c.get()).toBeNull();
    c.set("tok", NOW + 3600_000);
    c.clear();
    expect(c.get()).toBeNull();
  });

  it("set() rejects an empty token or a non-finite/past expiry (fail-closed)", () => {
    const c = new RelayTokenCache({ now: () => NOW });
    c.set("", NOW + 3600_000);
    expect(c.get()).toBeNull();
    c.set("tok", NOW - 1); // already past
    expect(c.get()).toBeNull();
    c.set("tok", Number.NaN);
    expect(c.get()).toBeNull();
  });

  it("a newer push replaces an older token", () => {
    const c = new RelayTokenCache({ now: () => NOW });
    c.set("old", NOW + 120_000);
    c.set("new", NOW + 3600_000);
    expect(c.get()).toBe("new");
  });
});
