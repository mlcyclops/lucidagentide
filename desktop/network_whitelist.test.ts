// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/network_whitelist.test.ts — P-NETWL.1 (ADR-0106): the pure matching + verdict engine behind the
// curated network whitelist. Over-tested because it can GRANT egress: every match path and every fail-closed
// fall-through matters.

import { describe, expect, test } from "bun:test";
import {
  emptyStore, ipv4ToInt, isIpv4, matchDomain, matchIp, normalizeHost, removeEntry, sanitizeStore,
  upsertEntry, whitelistMatch, whitelistVerdict, type WhitelistEntry, type WhitelistStore,
} from "./network_whitelist.ts";

const entry = (o: Partial<WhitelistEntry> & Pick<WhitelistEntry, "id" | "pattern">): WhitelistEntry =>
  ({ kind: "domain", zone: "external", scope: "always", ...o });
const store = (...es: WhitelistEntry[]): WhitelistStore => ({ version: 1, entries: es });

describe("normalizeHost", () => {
  test("pulls the host from a URL, a bare host, and a scheme-less URL; strips port + case", () => {
    expect(normalizeHost("https://API.Example.com:8443/x?y=1")).toBe("api.example.com");
    expect(normalizeHost("example.com/path")).toBe("example.com");
    expect(normalizeHost("HTTP://10.0.0.5")).toBe("10.0.0.5");
    expect(normalizeHost("bing.com")).toBe("bing.com");
  });
  test("empty / junk → null", () => {
    expect(normalizeHost("")).toBeNull();
    expect(normalizeHost("   ")).toBeNull();
  });
});

describe("matchDomain", () => {
  test("exact match only itself", () => {
    expect(matchDomain("api.example.com", "api.example.com")).toBe(true);
    expect(matchDomain("api.example.com", "www.example.com")).toBe(false);
    expect(matchDomain("api.example.com", "example.com")).toBe(false);
  });
  test("wildcard matches the base and any subdomain", () => {
    expect(matchDomain("*.example.com", "example.com")).toBe(true);
    expect(matchDomain("*.example.com", "api.example.com")).toBe(true);
    expect(matchDomain("*.example.com", "a.b.example.com")).toBe(true);
    expect(matchDomain("*.example.com", "notexample.com")).toBe(false);
    expect(matchDomain("*.example.com", "example.com.evil.com")).toBe(false);
  });
  test("TLD-level wildcard (*.com) matches any .com host but not a look-alike", () => {
    expect(matchDomain("*.com", "bing.com")).toBe(true);
    expect(matchDomain("*.com", "a.bing.com")).toBe(true);
    expect(matchDomain("*.com", "bing.net")).toBe(false);
    expect(matchDomain("*.com", "notcom")).toBe(false);
  });
  test("case-insensitive; leading dot tolerated; empty guards", () => {
    expect(matchDomain("Example.COM", "example.com")).toBe(true);
    expect(matchDomain(".example.com", "example.com")).toBe(true);
    expect(matchDomain("", "example.com")).toBe(false);
    expect(matchDomain("*.", "x.com")).toBe(false);
  });
});

describe("ipv4ToInt / isIpv4 / matchIp", () => {
  test("valid + invalid dotted quads", () => {
    expect(ipv4ToInt("0.0.0.0")).toBe(0);
    expect(ipv4ToInt("255.255.255.255")).toBe(4294967295);
    expect(ipv4ToInt("10.0.0.5")).toBe(167772165);
    expect(ipv4ToInt("256.0.0.1")).toBeNull();
    expect(ipv4ToInt("10.0.0")).toBeNull();
    expect(ipv4ToInt("example.com")).toBeNull();
    expect(isIpv4("192.168.1.1")).toBe(true);
    expect(isIpv4("nope")).toBe(false);
  });
  test("single-IP match", () => {
    expect(matchIp("10.0.0.5", "10.0.0.5")).toBe(true);
    expect(matchIp("10.0.0.5", "10.0.0.6")).toBe(false);
  });
  test("CIDR membership", () => {
    expect(matchIp("10.0.0.0/8", "10.255.3.9")).toBe(true);
    expect(matchIp("10.0.0.0/8", "11.0.0.1")).toBe(false);
    expect(matchIp("192.168.1.0/24", "192.168.1.200")).toBe(true);
    expect(matchIp("192.168.1.0/24", "192.168.2.1")).toBe(false);
    expect(matchIp("0.0.0.0/0", "8.8.8.8")).toBe(true); // /0 = everything
  });
  test("malformed CIDR / non-ip host → false (fail-closed)", () => {
    expect(matchIp("10.0.0.0/33", "10.0.0.1")).toBe(false);
    expect(matchIp("10.0.0.0/x", "10.0.0.1")).toBe(false);
    expect(matchIp("10.0.0.0/8", "example.com")).toBe(false);
  });
});

describe("whitelistMatch — only `always` scope is enforced in P-NETWL.1", () => {
  test("an always-scoped domain wildcard grants an otherwise-unknown host", () => {
    const s = store(entry({ id: "1", pattern: "*.example.com", scope: "always" }));
    expect(whitelistMatch(s, "https://api.example.com/x")?.id).toBe("1");
    expect(whitelistVerdict(s, "https://api.example.com/x")).toBe("allow");
  });
  test("an always-scoped IP CIDR grants a literal-IP host", () => {
    const s = store(entry({ id: "ip", kind: "ip", pattern: "10.0.0.0/8", zone: "internal", scope: "always" }));
    expect(whitelistVerdict(s, "http://10.1.2.3:9000")).toBe("allow");
    expect(whitelistVerdict(s, "http://11.1.2.3")).toBe("none");
  });
  test("project + loop scoped entries do NOT grant yet (deferred to P-NETWL.2/.3)", () => {
    expect(whitelistVerdict(store(entry({ id: "p", pattern: "*.example.com", scope: "project" })), "https://api.example.com")).toBe("none");
    expect(whitelistVerdict(store(entry({ id: "l", pattern: "*.example.com", scope: "loop" })), "https://api.example.com")).toBe("none");
  });
  test("no match / empty store / null store → none (fail-closed)", () => {
    expect(whitelistVerdict(store(entry({ id: "1", pattern: "example.com" })), "https://other.com")).toBe("none");
    expect(whitelistVerdict(emptyStore(), "https://example.com")).toBe("none");
    expect(whitelistVerdict(null, "https://example.com")).toBe("none");
    expect(whitelistVerdict(undefined, "https://example.com")).toBe("none");
  });
  test("a malformed entry is skipped, never granted", () => {
    const bad = { id: "x", scope: "always" } as unknown as WhitelistEntry; // no pattern
    expect(whitelistVerdict(store(bad, entry({ id: "ok", pattern: "example.com" })), "https://example.com")).toBe("allow");
    expect(whitelistVerdict(store(bad), "https://example.com")).toBe("none");
  });
});

describe("sanitizeStore / upsertEntry / removeEntry", () => {
  test("sanitize drops entries missing id or pattern and normalizes enums", () => {
    const s = sanitizeStore({ entries: [
      { id: "a", pattern: "example.com", kind: "weird", zone: "nope", scope: "bogus" },
      { pattern: "no-id.com" },
      { id: "b" },
      "junk",
    ] });
    expect(s.version).toBe(1);
    expect(s.entries.length).toBe(1);
    expect(s.entries[0]).toMatchObject({ id: "a", kind: "domain", zone: "external", scope: "always" });
  });
  test("sanitize keeps a valid auth ref but drops a secret-less / bad-kind one", () => {
    const s = sanitizeStore({ entries: [
      { id: "a", pattern: "x.com", auth: { kind: "jwt", vaultRef: "cred_1", username: "u" } },
      { id: "b", pattern: "y.com", auth: { kind: "jwt" } },        // no vaultRef
      { id: "c", pattern: "z.com", auth: { kind: "nope", vaultRef: "r" } }, // bad kind
    ] });
    const byId = Object.fromEntries(s.entries.map((e) => [e.id, e]));
    expect(byId.a!.auth).toMatchObject({ kind: "jwt", vaultRef: "cred_1", username: "u" });
    expect(byId.b!.auth).toBeUndefined();
    expect(byId.c!.auth).toBeUndefined();
  });
  test("sanitize NEVER stores a raw secret field even if present in input", () => {
    const s = sanitizeStore({ entries: [{ id: "a", pattern: "x.com", auth: { kind: "jwt", vaultRef: "r", secret: "TOPSECRET" } }] });
    expect(JSON.stringify(s)).not.toContain("TOPSECRET");
  });
  test("upsert replaces by id; remove deletes by id (both pure)", () => {
    let s = emptyStore();
    s = upsertEntry(s, entry({ id: "1", pattern: "a.com" }));
    s = upsertEntry(s, entry({ id: "1", pattern: "b.com" })); // replace
    expect(s.entries.length).toBe(1);
    expect(s.entries[0]!.pattern).toBe("b.com");
    s = upsertEntry(s, entry({ id: "2", pattern: "c.com" }));
    expect(s.entries.length).toBe(2);
    s = removeEntry(s, "1");
    expect(s.entries.map((e) => e.id)).toEqual(["2"]);
  });
});
