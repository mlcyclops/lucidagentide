// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/sandbox_panel.test.ts — P-SANDBOX.5 (ADR-0169): the "Runtime sandbox" panel builder.

import { expect, test } from "bun:test";
import { addFolderRow, controlSection, renderSandboxSection } from "./sandbox_panel.ts";
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

// ── P-SANDBOX.12 (ADR-0390): the sandbox switch ──
const ctl = (o: Partial<{ available: boolean; userOff: boolean; policyLocked: boolean; registered: boolean }> = {}) =>
  ({ available: true, userOff: false, policyLocked: false, registered: true, ...o });

test("the switch: on offers Turn off; off offers Turn on (+ Remove from Windows while registered)", () => {
  expect(controlSection(ctl())).toContain('data-sbx-mode="off"');
  const off = controlSection(ctl({ userOff: true }));
  expect(off).toContain('data-sbx-mode="auto"');
  expect(off).toContain('data-sbx-mode="unregister"');
  expect(controlSection(ctl({ userOff: true, registered: false }))).not.toContain("unregister");
});

test("policy-locked shows a note and never a button; unavailable shows nothing", () => {
  const locked = controlSection(ctl({ policyLocked: true }));
  expect(locked).toContain("policy");
  expect(locked).not.toContain("data-sbx-mode");
  expect(controlSection(ctl({ available: false }))).toBe("");
  expect(controlSection(undefined)).toBe("");
});

test("the switch renders even before the first spawn, and Off reads as the user's choice", () => {
  expect(renderSandboxSection({ state: null, egressBlocks: [], grants: [], control: ctl() })).toContain('data-sbx-mode="off"');
  const h = renderSandboxSection({ state: { backend: "noop", isolated: false, disclosed: true, platform: "win32", execBlocked: null, proxied: false, at: "" }, egressBlocks: [], control: ctl({ userOff: true }) });
  expect(h).toContain("you turned the Windows sandbox off");
});

// ── P-SANDBOX.13 (ADR-0391): add folders, and see everything the sandbox can reach ──
test("Add folder offers read-only and read-write, and never carries a path (the engine opens the picker)", () => {
  const h = addFolderRow(ctl());
  expect(h).toContain('data-sbx-add="rx"');
  expect(h).toContain('data-sbx-add="rw"');
  expect(h).not.toContain(":\\");
  expect(addFolderRow(ctl({ available: false }))).toBe("");
});

test("the section lists user folders (with Revoke) and LUCID's always-allowed folders (without)", () => {
  const h = renderSandboxSection({
    state: { backend: "appcontainer", isolated: true, disclosed: false, platform: "win32", execBlocked: null, proxied: true, at: "" },
    egressBlocks: [],
    control: ctl(),
    grants: [{ path: "C:\\Users\\U\\Pictures\\Screenshots", mode: "rx", grantedAt: "2026-09-24T00:00:00.000Z", reason: "added by you in the Security panel" }],
    runtimeFolders: [{ path: "C:\\ws", mode: "rw", why: "the current workspace" }],
  });
  expect(h).toContain("Screenshots");
  expect(h).toContain("data-grant-revoke");
  expect(h).toContain("Always allowed");
  expect(h).toContain("the current workspace");
  expect((h.match(/data-grant-revoke/g) ?? []).length).toBe(1); // the runtime folders are not revocable
});
