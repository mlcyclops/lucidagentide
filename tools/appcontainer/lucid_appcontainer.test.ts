// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/appcontainer/lucid_appcontainer.test.ts — P-SANDBOX.7 (ADR-0173).
//
// Covers the PURE, cross-platform surface of the AppContainer helper: the flag-contract parser (which
// fail-closes on anything malformed BEFORE a spawn) and the Windows command-line quoting. The Win32 FFI
// (`runInAppContainer`) is Windows-only and verified live by demo-P-SANDBOX.7 (a curl inside the
// deny-network container cannot reach the net); the parser is where the boundary correctness lives.

import { expect, test } from "bun:test";
import { aclTargets, buildCommandLine, buildExplicitAccessW, buildStartupInfoExW, creationFlags, inheritableHandleList, checkNetIsolationArgs, icaclsListsSid, isPackageReadablePath, main, parentDir, parseAclMode, parseHelperArgs, quoteArg } from "./lucid_appcontainer.ts";
import type { HelperPlan } from "./lucid_appcontainer.ts";

// ── the flag-contract parser ──────────────────────────────────────────────────
test("parses a valid --deny-network plan", () => {
  expect(parseHelperArgs(["--workspace", "C:\\ws", "--deny-network", "--", "curl.exe", "--version"]))
    .toEqual({ workspace: "C:\\ws", home: undefined, net: "deny", grantRx: [], grantRw: [], cmd: "curl.exe", cmdArgs: ["--version"] });
});

test("parses --loopback-only + --home", () => {
  const p = parseHelperArgs(["--workspace", "C:\\ws", "--home", "C:\\Users\\d", "--loopback-only", "--", "omp", "acp"]);
  expect(p).toEqual({ workspace: "C:\\ws", home: "C:\\Users\\d", net: "loopback", grantRx: [], grantRw: [], cmd: "omp", cmdArgs: ["acp"] });
});

test("parses repeatable --grant-rx / --grant-rw in order", () => {
  const p = parseHelperArgs(["--workspace", "C:\\ws", "--deny-network", "--grant-rx", "C:\\tools", "--grant-rw", "D:\\scratch", "--grant-rx", "C:\\sdk", "--", "x"]);
  expect(p).toEqual({ workspace: "C:\\ws", home: undefined, net: "deny", grantRx: ["C:\\tools", "C:\\sdk"], grantRw: ["D:\\scratch"], cmd: "x", cmdArgs: [] });
});

test("fail-closed: --grant-rx / --grant-rw need a path", () => {
  expect(parseHelperArgs(["--workspace", "C:\\ws", "--deny-network", "--grant-rx"])).toEqual({ error: "--grant-rx needs a path" });
  expect(parseHelperArgs(["--workspace", "C:\\ws", "--deny-network", "--grant-rw"])).toEqual({ error: "--grant-rw needs a path" });
});

test("fail-closed: no command after -- is an error", () => {
  expect(parseHelperArgs(["--workspace", "C:\\ws", "--deny-network", "--"])).toEqual({ error: "no command after --" });
});

test("fail-closed: a missing -- (no command) is an error", () => {
  expect("error" in parseHelperArgs(["--workspace", "C:\\ws", "--deny-network"])).toBe(true);
});

test("fail-closed: exactly one net posture is required (neither / both error)", () => {
  expect(parseHelperArgs(["--workspace", "C:\\ws", "--", "x"])).toEqual({ error: "exactly one of --deny-network / --loopback-only is required" });
  expect(parseHelperArgs(["--workspace", "C:\\ws", "--deny-network", "--loopback-only", "--", "x"]))
    .toEqual({ error: "exactly one of --deny-network / --loopback-only is required" });
});

test("fail-closed: --workspace is required", () => {
  expect(parseHelperArgs(["--deny-network", "--", "x"])).toEqual({ error: "--workspace is required" });
});

test("fail-closed: an unknown flag is refused", () => {
  expect(parseHelperArgs(["--workspace", "C:\\ws", "--yolo", "--", "x"])).toEqual({ error: "unknown flag: --yolo" });
});

// ── Windows command-line quoting (CommandLineToArgvW round-trip rules) ─────────
test("quoteArg leaves simple tokens bare, quotes on spaces, escapes embedded quotes/backslashes", () => {
  expect(quoteArg("curl.exe")).toBe("curl.exe");
  expect(quoteArg("--version")).toBe("--version");
  expect(quoteArg("a b")).toBe('"a b"');
  expect(quoteArg('say "hi"')).toBe('"say \\"hi\\""');
  expect(quoteArg("C:\\path with space\\")).toBe('"C:\\path with space\\\\"'); // trailing backslash doubled before the close quote
});

test("buildCommandLine joins the quoted argv", () => {
  expect(buildCommandLine("cmd", ["/c", "echo hi"])).toBe('cmd /c "echo hi"');
  expect(buildCommandLine("omp", ["acp", "-e", "gate.ts"])).toBe("omp acp -e gate.ts");
});

// ── main() fail-closed behaviour (no spawn happens on the error / non-Windows paths) ──
test("main() returns 2 on a bad-args (parser) failure", () => {
  expect(main(["--deny-network", "--"])).toBe(2); // no command
  expect(main(["--revoke-acl"])).toBe(2); // the revoke subcommand needs its path
});

test("main() fail-closes to a non-zero code when it cannot contain (non-Windows ⇒ every mode refuses)", () => {
  if (process.platform !== "win32") {
    expect(main(["--workspace", "/ws", "--deny-network", "--", "true"])).toBe(3); // no AppContainer off-Windows ⇒ refuse
    expect(main(["--workspace", "/ws", "--loopback-only", "--", "true"])).toBe(3);
    expect(main(["--register-loopback"])).toBe(3); // loopback exemption is Windows-only
  }
});

// ── ACL grant planning (aclTargets + its path helpers) ─────────────────────────
const plan = (over: Partial<HelperPlan> = {}): HelperPlan =>
  ({ workspace: "C:\\ws", home: undefined, net: "deny", grantRx: [], grantRw: [], cmd: "x", cmdArgs: [], ...over });

test("aclTargets: workspace rw + resolved tool dir rx", () => {
  expect(aclTargets(plan(), "C:\\Python314\\python.exe"))
    .toEqual([{ path: "C:\\ws", mode: "rw" }, { path: "C:\\Python314", mode: "rx" }]);
});

test("aclTargets: tool dirs under C:\\Windows / Program Files are skipped (already package-readable)", () => {
  expect(aclTargets(plan(), "C:\\Windows\\System32\\curl.exe")).toEqual([{ path: "C:\\ws", mode: "rw" }]);
  expect(aclTargets(plan(), "C:\\Program Files\\Git\\cmd\\git.exe")).toEqual([{ path: "C:\\ws", mode: "rw" }]);
  expect(aclTargets(plan(), "C:\\Program Files (x86)\\foo\\foo.exe")).toEqual([{ path: "C:\\ws", mode: "rw" }]);
});

test("aclTargets: an unresolved cmd grants nothing for the tool; home is rx ONLY, never rw", () => {
  expect(aclTargets(plan({ home: "C:\\Users\\d" }), null))
    .toEqual([{ path: "C:\\ws", mode: "rw" }, { path: "C:\\Users\\d", mode: "rx" }]);
});

test("aclTargets: --grant-rx/--grant-rw pass through; duplicates dedupe with rw winning", () => {
  expect(aclTargets(plan({ grantRx: ["C:\\tools"], grantRw: ["D:\\scratch"] }), null))
    .toEqual([{ path: "C:\\ws", mode: "rw" }, { path: "C:\\tools", mode: "rx" }, { path: "D:\\scratch", mode: "rw" }]);
  // the workspace re-listed as rx (case/separator-insensitively) must NOT downgrade or duplicate …
  expect(aclTargets(plan({ grantRx: ["c:/WS/"] }), null)).toEqual([{ path: "C:\\ws", mode: "rw" }]);
  // … and an rx dir re-listed as rw upgrades in place.
  expect(aclTargets(plan({ grantRx: ["C:\\tools"], grantRw: ["C:\\tools"] }), null))
    .toEqual([{ path: "C:\\ws", mode: "rw" }, { path: "C:\\tools", mode: "rw" }]);
});

test("parentDir / isPackageReadablePath handle both separators and trailing slashes", () => {
  expect(parentDir("C:\\a\\b\\c.exe")).toBe("C:\\a\\b");
  expect(parentDir("C:/a/b/")).toBe("C:/a");
  expect(isPackageReadablePath("c:/windows/system32")).toBe(true);
  expect(isPackageReadablePath("C:\\WindowsOld\\bin")).toBe(false); // prefix must be a whole component
  expect(isPackageReadablePath("C:\\Program FilesX")).toBe(false);
});

// ── EXPLICIT_ACCESS_W (x64, 48 bytes) — the byte layout SetEntriesInAclW consumes ──
test("buildExplicitAccessW lays out access/mode/inheritance and the SID trustee at the x64 offsets", () => {
  const sid = 0x1122334455667788n;
  const ea = buildExplicitAccessW(0xa0000000, 1, sid); // rx, GRANT_ACCESS
  expect(ea.length).toBe(48);
  const dv = new DataView(ea.buffer);
  expect(dv.getUint32(0, true)).toBe(0xa0000000); // grfAccessPermissions = GENERIC_READ|GENERIC_EXECUTE
  expect(dv.getUint32(4, true)).toBe(1); // grfAccessMode = GRANT_ACCESS
  expect(dv.getUint32(8, true)).toBe(3); // grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT
  expect(dv.getBigUint64(16, true)).toBe(0n); // TRUSTEE_W.pMultipleTrustee = NULL
  expect(dv.getUint32(24, true)).toBe(0); // MultipleTrusteeOperation = NO_MULTIPLE_TRUSTEE
  expect(dv.getUint32(32, true)).toBe(0); // TrusteeForm = TRUSTEE_IS_SID
  expect(dv.getUint32(36, true)).toBe(0); // TrusteeType = TRUSTEE_IS_UNKNOWN
  expect(dv.getBigUint64(40, true)).toBe(sid); // ptstrName = the AppContainer PSID
  // and the revoke shape: mode 4, mask still well-formed.
  expect(new DataView(buildExplicitAccessW(0x10000000, 4, sid).buffer).getUint32(4, true)).toBe(4);
});

// ── P-SANDBOX.7b: the loopback exemption command (pure arg construction) ───────
test("checkNetIsolationArgs builds the CheckNetIsolation LoopbackExempt add/delete for our AppContainer", () => {
  expect(checkNetIsolationArgs("add")).toEqual(["LoopbackExempt", "-a", "-n=LucidAgentIDE.Sandbox.v1"]);
  expect(checkNetIsolationArgs("delete")).toEqual(["LoopbackExempt", "-d", "-n=LucidAgentIDE.Sandbox.v1"]);
});

// ── P-SANDBOX.8: the standalone --apply-acl / --check-acl subcommands (arg validation only — the
// Win32/icacls sides mutate host state and are verified live, like runInAppContainer) ──────────────
test("parseAclMode accepts only the rx/rw vocabulary", () => {
  expect(parseAclMode("rx")).toBe("rx");
  expect(parseAclMode("rw")).toBe("rw");
  expect(parseAclMode("read")).toBeNull(); // the tool-facing words never reach the helper untranslated
  expect(parseAclMode("")).toBeNull();
  expect(parseAclMode(undefined)).toBeNull();
});

test("main() fail-closes --apply-acl on a missing/invalid mode or path (exit 2, no mutation attempted)", () => {
  expect(main(["--apply-acl"])).toBe(2);
  expect(main(["--apply-acl", "rx"])).toBe(2); // no path
  expect(main(["--apply-acl", "rz", "C:\\data"])).toBe(2); // unknown mode
});

test("main() fail-closes --check-acl without a path (exit 2)", () => {
  expect(main(["--check-acl"])).toBe(2);
});

test("icaclsListsSid matches an EXPLICIT ACE case-insensitively, never an empty SID", () => {
  const out = "C:\\data S-1-15-2-111-222:(OI)(CI)(RX)\n        BUILTIN\\Administrators:(F)\n";
  expect(icaclsListsSid(out, "s-1-15-2-111-222")).toBe(true);
  expect(icaclsListsSid(out, "S-1-15-2-999-888")).toBe(false);
  expect(icaclsListsSid(out, "")).toBe(false); // an empty needle must not read as "granted everywhere"
});

test("icaclsListsSid ignores INHERITED ACEs — (I) flows from a parent grant and is not this path's row", () => {
  const inheritedOnly = "C:\\data S-1-15-2-111-222:(I)(F)\n        S-1-15-2-111-222:(I)(OI)(CI)(IO)(F)\n";
  expect(icaclsListsSid(inheritedOnly, "S-1-15-2-111-222")).toBe(false);
  // …but (IO) alone is inherit-only propagation of an EXPLICIT ACE here, not an inherited one.
  expect(icaclsListsSid("C:\\d S-1-15-2-111-222:(OI)(CI)(IO)(RX)\n", "S-1-15-2-111-222")).toBe(true);
});

test("icaclsListsSid survives console-width wrapping that splits an ACE mid-SID (observed live)", () => {
  const wrapped = "C:\\data S-1-15-2-111-2225555\n55:(OI)(CI)(RX)\n";
  expect(icaclsListsSid(wrapped, "S-1-15-2-111-222555555")).toBe(true);
  const wrappedInherited = "C:\\data S-1-15-2-111-2225555\n55:(I)(OI)(CI)(RX)\n";
  expect(icaclsListsSid(wrappedInherited, "S-1-15-2-111-222555555")).toBe(false);
});

// ── P-SANDBOX.9 (ADR-0384): the child owns the helper's std handles (ACP rides stdio) ──
test("inheritableHandleList drops NULL / INVALID_HANDLE_VALUE and dedupes (HANDLE_LIST rejects repeats)", () => {
  const INVALID = 0xffffffffffffffffn;
  expect(inheritableHandleList({ stdin: 0x10n, stdout: 0x20n, stderr: 0x30n })).toEqual([0x10n, 0x20n, 0x30n]);
  expect(inheritableHandleList({ stdin: 0x10n, stdout: 0x20n, stderr: 0x20n })).toEqual([0x10n, 0x20n]);
  expect(inheritableHandleList({ stdin: 0n, stdout: INVALID, stderr: 0x30n })).toEqual([0x30n]);
  expect(inheritableHandleList({ stdin: 0n, stdout: 0n, stderr: INVALID })).toEqual([]);
});

test("buildStartupInfoExW: cb=112, STARTF_USESTDHANDLES, std handles at +80/+88/+96, attr list at +104", () => {
  const si = buildStartupInfoExW(0xabcdefn, { stdin: 0x11n, stdout: 0x22n, stderr: 0xffffffffffffffffn });
  const dv = new DataView(si.buffer);
  expect(si.length).toBe(112);
  expect(dv.getUint32(0, true)).toBe(112);
  expect(dv.getUint32(60, true)).toBe(0x100);
  expect(dv.getBigUint64(80, true)).toBe(0x11n);
  expect(dv.getBigUint64(88, true)).toBe(0x22n);
  expect(dv.getBigUint64(96, true)).toBe(0n); // INVALID_HANDLE_VALUE is never handed to the child
  expect(dv.getBigUint64(104, true)).toBe(0xabcdefn);
});

test("creationFlags: always EXTENDED_STARTUPINFO_PRESENT; CREATE_NO_WINDOW only when the helper has no console", () => {
  expect(creationFlags(true)).toBe(0x00080000);
  expect(creationFlags(false)).toBe(0x08080000);
});
