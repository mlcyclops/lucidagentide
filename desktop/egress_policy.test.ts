// desktop/egress_policy.test.ts — pure egress decision + choice-folding (P-EGRESS.1, ADR-0062).

import { describe, expect, test } from "bun:test";
import { applyEgressChoice, egressVerdict, extractHost, type EgressStore } from "./egress_policy.ts";

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
