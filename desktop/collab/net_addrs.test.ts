// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/net_addrs.test.ts — P-COLLAB.14 (ADR-0199): the bindable-address classifier (pure).

import { describe, expect, it } from "bun:test";
import { classifyBindAddresses } from "./net_addrs.ts";

describe("classifyBindAddresses (P-COLLAB.14)", () => {
  it("classifies loopback / LAN / VPN(CGNAT) / other and orders them", () => {
    const list = classifyBindAddresses({
      lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      eth0: [{ address: "192.168.1.42", family: "IPv4", internal: false }],
      wlan0: [{ address: "10.0.0.5", family: "IPv4", internal: false }],
      tailscale0: [{ address: "100.101.102.103", family: "IPv4", internal: false }],
      pub: [{ address: "203.0.113.7", family: "IPv4", internal: false }],
    });
    expect(list.map((a) => [a.address, a.kind])).toEqual([
      ["127.0.0.1", "loopback"],
      ["10.0.0.5", "lan"],
      ["192.168.1.42", "lan"],
      ["100.101.102.103", "vpn"],
      ["203.0.113.7", "other"],
    ]);
    expect(list.find((a) => a.address === "100.101.102.103")!.label).toContain("Tailscale");
    expect(list.find((a) => a.address === "192.168.1.42")!.label).toContain("LAN");
  });

  it("treats a private range on a tunnel interface (WireGuard) as VPN, not LAN", () => {
    const list = classifyBindAddresses({
      wg0: [{ address: "10.8.0.2", family: "IPv4", internal: false }],
    });
    expect(list[0]!.kind).toBe("vpn");
    expect(list[0]!.label).toContain("tunnel");
  });

  it("de-dupes repeated addresses and tolerates numeric/`IPv4` family + missing entries", () => {
    const list = classifyBindAddresses({
      a: [{ address: "192.168.0.9", family: 4 as unknown as string, internal: false }],
      b: [{ address: "192.168.0.9", family: "IPv4", internal: false }], // dupe
      c: undefined,
      d: [{ address: "", family: "IPv4", internal: false }], // empty ignored
    });
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({ address: "192.168.0.9", family: "IPv4", kind: "lan" });
  });

  it("labels use a plain hyphen, never an em dash (P-REMOTE.11: no em dashes in the Session Share UI)", () => {
    const list = classifyBindAddresses({
      lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      eth0: [{ address: "192.168.1.42", family: "IPv4", internal: false }],
      tailscale0: [{ address: "100.101.102.103", family: "IPv4", internal: false }],
      pub: [{ address: "203.0.113.7", family: "IPv4", internal: false }],
    });
    for (const a of list) expect(a.label).not.toContain("\u2014"); // U+2014 em dash
    expect(list.find((a) => a.address === "127.0.0.1")!.label).toBe("127.0.0.1 - this machine only");
  });

  it("marks anything internal as loopback even off 127.x, and an IPv6 link-local as LAN", () => {
    const list = classifyBindAddresses({
      lo6: [{ address: "::1", family: "IPv6", internal: true }],
      ll: [{ address: "fe80::1", family: "IPv6", internal: false }],
    });
    expect(list.find((a) => a.address === "::1")!.kind).toBe("loopback");
    expect(list.find((a) => a.address === "fe80::1")!.kind).toBe("lan");
  });
});
