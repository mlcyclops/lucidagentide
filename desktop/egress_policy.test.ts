// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/egress_policy.test.ts — pure egress decision + choice-folding (P-EGRESS.1, ADR-0062).

import { describe, expect, test } from "bun:test";
import { applyEgressChoice, clampEgress, egressVerdict, extractHost, isLocalFileTarget, type EgressStore } from "./egress_policy.ts";

describe("isLocalFileTarget (P-EGRESS.2, ADR-0094)", () => {
  test("file:// URLs are local", () => {
    expect(isLocalFileTarget("file:///C:/Users/n/game.html")).toBe(true);
    expect(isLocalFileTarget("FILE://localhost/tmp/x.html")).toBe(true);
  });
  test("absolute local paths are local (Windows drive, UNC, POSIX, home)", () => {
    expect(isLocalFileTarget("C:\\Users\\n\\game.html")).toBe(true);
    expect(isLocalFileTarget("C:/Users/n/game.html")).toBe(true);
    expect(isLocalFileTarget("\\\\server\\share\\x.html")).toBe(true);
    expect(isLocalFileTarget("/home/n/game.html")).toBe(true);
    expect(isLocalFileTarget("~/game.html")).toBe(true);
  });
  test("http(s) and other schemes are NOT local (still real egress)", () => {
    expect(isLocalFileTarget("https://example.com/game.html")).toBe(false);
    expect(isLocalFileTarget("http://localhost:3000/")).toBe(false);
    expect(isLocalFileTarget("ftp://host/x")).toBe(false);
  });
  test("ambiguous targets are NOT local (fail to the safe egress prompt)", () => {
    expect(isLocalFileTarget("example.com/path")).toBe(false); // bare host
    expect(isLocalFileTarget("game.html")).toBe(false);        // relative path
    expect(isLocalFileTarget("")).toBe(false);
    expect(isLocalFileTarget("   ")).toBe(false);
  });
});

describe("extractHost", () => {
  test("pulls the lowercased hostname from a URL", () => {
    expect(extractHost("https://Example.com/path?q=1")).toBe("example.com");
    expect(extractHost("http://sub.host.io:8080/x")).toBe("sub.host.io");
  });
  test("tolerates a scheme-less / bare host", () => {
    expect(extractHost("example.com/a")).toBe("example.com");
    expect(extractHost("EXAMPLE.COM")).toBe("example.com");
  });
  test("returns null for junk", () => {
    expect(extractHost("")).toBeNull();
    expect(extractHost("   ")).toBeNull();
  });
});

describe("egressVerdict (fail-closed to prompt)", () => {
  test("unknown host prompts", () => {
    expect(egressVerdict({}, "https://evil.test/x")).toBe("prompt");
  });
  test("an allow-listed host is auto-allowed", () => {
    const s: EgressStore = { allowHosts: ["docs.python.org"] };
    expect(egressVerdict(s, "https://docs.python.org/3/library")).toBe("allow");
    expect(egressVerdict(s, "https://other.com")).toBe("prompt");
  });
  test("danger mode allows everything...", () => {
    expect(egressVerdict({ dangerMode: true }, "https://anything.test")).toBe("allow");
  });
  test("...except hosts pinned to always-ask (override danger)", () => {
    const s: EgressStore = { dangerMode: true, alwaysAskHosts: ["bank.example"] };
    expect(egressVerdict(s, "https://bank.example/login")).toBe("prompt");
    expect(egressVerdict(s, "https://elsewhere.test")).toBe("allow");
  });
  test("an unparseable URL prompts (can't reason about an unnamed site)", () => {
    expect(egressVerdict({ dangerMode: true }, "")).toBe("prompt");
  });
});

describe("applyEgressChoice (pure, never mutates)", () => {
  test("allow-site adds the host and clears any ask-pin", () => {
    const s = applyEgressChoice({ alwaysAskHosts: ["a.com"] }, "https://a.com/x", "allow-site");
    expect(s.allowHosts).toContain("a.com");
    expect(s.alwaysAskHosts).not.toContain("a.com");
  });
  test("ask-site pins the host to always-prompt and clears any allow", () => {
    const s = applyEgressChoice({ allowHosts: ["a.com"] }, "https://a.com/x", "ask-site");
    expect(s.alwaysAskHosts).toContain("a.com");
    expect(s.allowHosts).not.toContain("a.com");
    expect(egressVerdict(s, "https://a.com")).toBe("prompt");
  });
  test("danger flips global allow-all", () => {
    expect(applyEgressChoice({}, "https://a.com", "danger").dangerMode).toBe(true);
  });
  test("allow-once and deny persist nothing", () => {
    expect(applyEgressChoice({}, "https://a.com", "allow-once")).toEqual({ dangerMode: false, allowHosts: [], alwaysAskHosts: [] });
    expect(applyEgressChoice({}, "https://a.com", "deny")).toEqual({ dangerMode: false, allowHosts: [], alwaysAskHosts: [] });
  });
  test("a full round-trip: allow-site then the same host auto-allows", () => {
    const s = applyEgressChoice({}, "https://grant.ed/path", "allow-site");
    expect(egressVerdict(s, "https://grant.ed/other")).toBe("allow");
  });
});

// ── ADR-0068 (P-ENT.1): managed egress ceiling — clampEgress only ever TIGHTENS ──────────────────
describe("clampEgress (managed ceiling, tighten-only)", () => {
  test("no managed policy ⇒ the store is returned unchanged", () => {
    const s: EgressStore = { allowHosts: ["a.test"], dangerMode: true };
    expect(clampEgress(s, undefined)).toBe(s);
  });

  test("deniedHosts can never be auto-allowed: dropped from allow + pinned to always-prompt", () => {
    const s: EgressStore = { allowHosts: ["bank.example", "ok.test"] };
    const c = clampEgress(s, { deniedHosts: ["bank.example"] });
    expect(egressVerdict(c, "https://bank.example/login")).toBe("prompt");
    expect(egressVerdict(c, "https://ok.test")).toBe("allow");
  });

  test("a denied host prompts even under user danger mode", () => {
    const c = clampEgress({ dangerMode: true }, { deniedHosts: ["bank.example"] });
    expect(egressVerdict(c, "https://bank.example/x")).toBe("prompt");
  });

  test("disableDangerMode forces allow-all OFF", () => {
    const c = clampEgress({ dangerMode: true }, { disableDangerMode: true });
    expect(c.dangerMode).toBe(false);
    expect(egressVerdict(c, "https://anything.test")).toBe("prompt");
  });

  test("a restrictive allowedHosts whitelist intersects the user's allow set AND kills danger mode", () => {
    const s: EgressStore = { allowHosts: ["in.test", "out.test"], dangerMode: true };
    const c = clampEgress(s, { allowedHosts: ["in.test"] });
    expect(egressVerdict(c, "https://in.test")).toBe("allow");   // on the org list + user-allowed
    expect(egressVerdict(c, "https://out.test")).toBe("prompt"); // user-allowed but off the org list
    expect(egressVerdict(c, "https://other.test")).toBe("prompt"); // danger no longer allows-all
    expect(c.dangerMode).toBe(false);
  });

  test("hosts on the org allow-list the user never approved still prompt (ceiling, not pre-approval)", () => {
    const c = clampEgress({ allowHosts: [] }, { allowedHosts: ["org.test"] });
    expect(egressVerdict(c, "https://org.test")).toBe("prompt");
  });
});
