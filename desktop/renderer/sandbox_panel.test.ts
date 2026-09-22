// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/sandbox_panel.test.ts — P-SANDBOX.5 (ADR-0169): the "Runtime sandbox" panel builder.

import { expect, test } from "bun:test";
import { renderSandboxSection } from "./sandbox_panel.ts";
import type { SandboxStateView, SandboxStatusView } from "./bridge.ts";

const st = (over: Partial<SandboxStateView> = {}): SandboxStatusView => ({
  state: { backend: "seatbelt", isolated: true, disclosed: false, platform: "darwin", execBlocked: null, proxied: true, at: "t", ...over },
  egressBlocks: [],
});

test("no state yet → empty string (nothing to show before the first spawn)", () => {
  expect(renderSandboxSection(null)).toBe("");
  expect(renderSandboxSection({ state: null, egressBlocks: [] })).toBe("");
});

test("isolated backend renders the green 'isolated' posture, named, and the mediated-egress line", () => {
  const h = renderSandboxSection(st({ backend: "bwrap", proxied: true }));
  expect(h).toContain("Runtime sandbox");
  expect(h).toContain("Linux bubblewrap");
  expect(h).toContain("sbx-row good");
  expect(h).toContain("mediated");
});

test("a network-off isolated session says so (no proxy this session)", () => {
  const h = renderSandboxSection(st({ isolated: true, proxied: false }));
  expect(h).toContain("network-off");
});

test("disclosed passthrough renders the amber 'not isolated' posture with the platform and AUTO-OPENS", () => {
  const h = renderSandboxSection(st({ backend: "noop", isolated: false, disclosed: true, platform: "win32", proxied: false }));
  expect(h).toContain("not isolated");
  expect(h).toContain("win32");
  expect(h).toContain('class="acc open"'); // not-isolated auto-opens to draw the eye
});

test("fail-closed exec-blocked renders the red posture with the reason and auto-opens", () => {
  const h = renderSandboxSection(st({ backend: null, isolated: false, disclosed: false, execBlocked: "no bwrap installed", proxied: false }));
  expect(h).toContain("sbx-row bad");
  expect(h).toContain("fail-closed BLOCKED");
  expect(h).toContain("no bwrap installed");
  expect(h).toContain('class="acc open"');
});

test("refused subprocess reach-outs are listed with a count; hostile host/reason are ESCAPED (no HTML injection)", () => {
  const status: SandboxStatusView = {
    state: st().state,
    egressBlocks: [
      { host: "<img src=x onerror=alert(1)>.cn", channel: "dns", type: "dns_query_blocked", reason: "subprocess DNS denied <b>", at: "t" },
      { host: "evil.example", channel: "connect", type: "subprocess_egress_blocked", reason: "denied", at: "t" },
    ],
  };
  const h = renderSandboxSection(status);
  expect(h).toContain("Subprocess reach-outs refused");
  expect(h).not.toContain("<img src=x"); // escaped
  expect(h).toContain("&lt;img");
  expect(h).toContain("evil.example");
  expect(h).toContain('<span class="count">2</span>'); // the block count badge
});

test("isolated + no blocks shows the reassuring 'none refused' line", () => {
  const h = renderSandboxSection(st({ isolated: true }));
  expect(h).toContain("No subprocess reach-outs have been refused");
});

// ── P-SANDBOX.8: the standing directory-grants list ──────────────────────────
test("directory grants render path, mode label, date, and a Revoke button; hostile paths are ESCAPED", () => {
  const status: SandboxStatusView = {
    ...st(),
    grants: [
      { path: "C:\\data\\<img src=x>", mode: "rw", grantedAt: "2026-02-03T10:00:00.000Z", reason: "user asked" },
      { path: "D:\\repo", mode: "rx", grantedAt: "2026-02-01T09:00:00.000Z", reason: "" },
    ],
  };
  const h = renderSandboxSection(status);
  expect(h).toContain("Directory grants");
  expect(h).toContain("read-write");
  expect(h).toContain("read-only");
  expect(h).toContain("2026-02-03");
  expect(h).not.toContain("<img src=x"); // escaped
  expect(h).toContain('data-grant-revoke="D:\\repo"');
});

test("grants stay visible/revocable even before a spawn resolves a state (grants-only accordion)", () => {
  const h = renderSandboxSection({ state: null, egressBlocks: [], grants: [{ path: "C:\\data", mode: "rx", grantedAt: "2026-02-01T00:00:00.000Z", reason: "r" }] });
  expect(h).toContain("Runtime sandbox");
  expect(h).toContain("1 directory grant");
  expect(h).toContain("data-grant-revoke");
});

test("no grants → no grants section (and the no-state guard still returns empty)", () => {
  expect(renderSandboxSection({ state: null, egressBlocks: [], grants: [] })).toBe("");
  expect(renderSandboxSection(st())).not.toContain("Directory grants");
});
