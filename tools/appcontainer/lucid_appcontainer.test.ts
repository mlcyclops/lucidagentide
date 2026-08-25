// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/appcontainer/lucid_appcontainer.test.ts — P-SANDBOX.7 (ADR-0173).
//
// Covers the PURE, cross-platform surface of the AppContainer helper: the flag-contract parser (which
// fail-closes on anything malformed BEFORE a spawn) and the Windows command-line quoting. The Win32 FFI
// (`runInAppContainer`) is Windows-only and verified live by demo-P-SANDBOX.7 (a curl inside the
// deny-network container cannot reach the net); the parser is where the boundary correctness lives.

import { expect, test } from "bun:test";
import { buildCommandLine, checkNetIsolationArgs, main, parseHelperArgs, quoteArg } from "./lucid_appcontainer.ts";

// ── the flag-contract parser ──────────────────────────────────────────────────
test("parses a valid --deny-network plan", () => {
  expect(parseHelperArgs(["--workspace", "C:\\ws", "--deny-network", "--", "curl.exe", "--version"]))
    .toEqual({ workspace: "C:\\ws", home: undefined, net: "deny", cmd: "curl.exe", cmdArgs: ["--version"] });
});

test("parses --loopback-only + --home", () => {
  const p = parseHelperArgs(["--workspace", "C:\\ws", "--home", "C:\\Users\\d", "--loopback-only", "--", "omp", "acp"]);
  expect(p).toEqual({ workspace: "C:\\ws", home: "C:\\Users\\d", net: "loopback", cmd: "omp", cmdArgs: ["acp"] });
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
});

test("main() fail-closes to a non-zero code when it cannot contain (non-Windows ⇒ every mode refuses)", () => {
  if (process.platform !== "win32") {
    expect(main(["--workspace", "/ws", "--deny-network", "--", "true"])).toBe(3); // no AppContainer off-Windows ⇒ refuse
    expect(main(["--workspace", "/ws", "--loopback-only", "--", "true"])).toBe(3);
    expect(main(["--register-loopback"])).toBe(3); // loopback exemption is Windows-only
  }
});

// ── P-SANDBOX.7b: the loopback exemption command (pure arg construction) ───────
test("checkNetIsolationArgs builds the CheckNetIsolation LoopbackExempt add/delete for our AppContainer", () => {
  expect(checkNetIsolationArgs("add")).toEqual(["LoopbackExempt", "-a", "-n=LucidAgentIDE.Sandbox.v1"]);
  expect(checkNetIsolationArgs("delete")).toEqual(["LoopbackExempt", "-d", "-n=LucidAgentIDE.Sandbox.v1"]);
});
