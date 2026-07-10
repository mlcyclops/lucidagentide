// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/net_addrs.ts — P-COLLAB.14 (ADR-0199): this machine's bindable network addresses.
//
// A loopback relay reaches only the same machine. To let a peer on your LAN / VPN reach you directly (no
// third party), you bind the relay to a NETWORK address instead. This enumerates + classifies the host's own
// interface addresses so the "be the relay" toggle can OFFER them (loopback, LAN, VPN/tunnel) rather than
// making you know + type your IP. It never opens anything - the bind is still authorized fail-closed by the
// managed policy (authorizeRelayBind, P-COLLAB.6), so surfacing an address does not bypass governance.
//
// PURE + DOM-free: `classifyBindAddresses` takes the raw `os.networkInterfaces()` shape so it is unit-testable
// without real interfaces; `localBindAddresses` is the thin OS-reading wrapper.

import { networkInterfaces } from "node:os";

export type BindKind = "loopback" | "lan" | "vpn" | "other";
export interface BindAddress {
  address: string;
  family: "IPv4" | "IPv6";
  kind: BindKind;
  /** A human label + reachability hint for the picker. */
  label: string;
}

interface RawIface { address: string; family: string | number; internal: boolean }

function isLoopback(addr: string): boolean {
  return addr === "::1" || /^127\./.test(addr);
}
/** RFC 1918 private ranges (a normal LAN). */
function isLan(addr: string): boolean {
  return /^10\./.test(addr)
    || /^192\.168\./.test(addr)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(addr)
    || /^fe80:/i.test(addr); // IPv6 link-local
}
/** Tailscale's CGNAT range 100.64.0.0/10 - a strong "you're on a tunnel/overlay" signal. */
function isCgnat(addr: string): boolean {
  const m = /^100\.(\d{1,3})\./.exec(addr);
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

function labelFor(kind: BindKind, address: string, ifaceName: string): string {
  switch (kind) {
    case "loopback": return `${address} — this machine only`;
    case "lan": return `${address} — your LAN (reachable on this network)`;
    case "vpn": return `${address} — VPN / tunnel${/tail/i.test(ifaceName) ? " (Tailscale)" : ""} (reachable over the tunnel)`;
    default: return `${address} — ${ifaceName} (public / other)`;
  }
}

/**
 * Classify the raw `os.networkInterfaces()` map into a de-duplicated, ordered list of bindable addresses:
 * loopback first (the safe default), then LAN, then VPN/tunnel, then anything else. IPv4 before IPv6.
 * VPN classification (by interface name OR the CGNAT range) wins over LAN when both could apply.
 */
export function classifyBindAddresses(ifaces: Record<string, RawIface[] | undefined>): BindAddress[] {
  const out: BindAddress[] = [];
  const seen = new Set<string>();
  for (const [name, list] of Object.entries(ifaces)) {
    for (const ni of list ?? []) {
      const address = (ni.address ?? "").trim();
      if (!address || seen.has(address)) continue;
      const fam = String(ni.family).replace(/^IPv?/i, "");
      const family: "IPv4" | "IPv6" = fam === "6" || /6/.test(fam) ? "IPv6" : "IPv4";
      const looksTunnel = /(tailscale|wg|wireguard|zerotier|tun|utun|ppp|nord|proton)/i.test(name);
      let kind: BindKind;
      if (isLoopback(address) || ni.internal) kind = "loopback";
      else if (isCgnat(address) || (looksTunnel && !isLan(address))) kind = "vpn";
      else if (isLan(address)) kind = looksTunnel ? "vpn" : "lan";
      else kind = "other";
      seen.add(address);
      out.push({ address, family, kind, label: labelFor(kind, address, name) });
    }
  }
  const order: Record<BindKind, number> = { loopback: 0, lan: 1, vpn: 2, other: 3 };
  return out.sort((a, b) =>
    order[a.kind] - order[b.kind]
    || (a.family === b.family ? 0 : a.family === "IPv4" ? -1 : 1)
    || a.address.localeCompare(b.address),
  );
}

/** The live list from this host's interfaces. Always includes 127.0.0.1 (the safe default) even if the OS
 *  enumeration is odd. */
export function localBindAddresses(): BindAddress[] {
  const list = classifyBindAddresses(networkInterfaces() as Record<string, RawIface[] | undefined>);
  if (!list.some((a) => a.address === "127.0.0.1")) {
    list.unshift({ address: "127.0.0.1", family: "IPv4", kind: "loopback", label: "127.0.0.1 — this machine only" });
  }
  return list;
}
