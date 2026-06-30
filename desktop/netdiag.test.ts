// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/netdiag.test.ts - the pure parse/diff helpers behind the OAuth-callback network watcher.
// (The OS calls + timer are impure and exercised by the demo; these are the deterministic keystones.)

import { describe, expect, test } from "bun:test";
import {
  parseNetstatLine, parseLsofLine, parseTasklistCsv, portOf, isLoopback, relevant,
  socketKey, diffSockets, type NetSocket,
} from "./netdiag.ts";

describe("portOf / isLoopback", () => {
  test("ports from v4 and v6 addresses", () => {
    expect(portOf("127.0.0.1:1455")).toBe(1455);
    expect(portOf("[::1]:1455")).toBe(1455);
    expect(portOf("0.0.0.0:5173")).toBe(5173);
    expect(portOf("*:*")).toBeNaN();
  });
  test("loopback detection covers v4 and v6", () => {
    expect(isLoopback("127.0.0.1:1455")).toBe(true);
    expect(isLoopback("[::1]:1455")).toBe(true);
    expect(isLoopback("0.0.0.0:5173")).toBe(false);
    expect(isLoopback("192.168.1.5:443")).toBe(false);
  });
});

describe("parseNetstatLine (Windows)", () => {
  test("a TCP LISTENING row maps to a loopback listener with the resolved process", () => {
    const s = parseNetstatLine("  TCP    127.0.0.1:1455         0.0.0.0:0              LISTENING       1234", (pid) => (pid === "1234" ? "omp.exe" : `pid ${pid}`));
    expect(s).not.toBeNull();
    expect(s!).toMatchObject({ proto: "TCP", local: "127.0.0.1:1455", state: "LISTENING", pid: "1234", proc: "omp.exe", port: 1455, loopback: true });
  });
  test("a UDP row has no state and the PID shifts to column 4", () => {
    const s = parseNetstatLine("  UDP    127.0.0.1:1900         *:*                                   4567");
    expect(s!).toMatchObject({ proto: "UDP", state: "", pid: "4567", port: 1900, loopback: true });
  });
  test("headers and blank lines are skipped", () => {
    expect(parseNetstatLine("  Proto  Local Address          Foreign Address        State           PID")).toBeNull();
    expect(parseNetstatLine("")).toBeNull();
    expect(parseNetstatLine("Active Connections")).toBeNull();
  });
});

describe("parseLsofLine (macOS / Linux)", () => {
  test("a LISTEN row becomes a LISTENING loopback socket using the command as the process", () => {
    const s = parseLsofLine("omp     1234 nick   7u  IPv4 0x1  0t0  TCP 127.0.0.1:1455 (LISTEN)");
    expect(s!).toMatchObject({ proto: "TCP", local: "127.0.0.1:1455", state: "LISTENING", pid: "1234", proc: "omp", port: 1455, loopback: true });
  });
  test("an ESTABLISHED row splits local->foreign", () => {
    const s = parseLsofLine("firefox 9999 nick  30u  IPv4 0x2  0t0  TCP 127.0.0.1:53998->127.0.0.1:1455 (ESTABLISHED)");
    expect(s!).toMatchObject({ local: "127.0.0.1:53998", foreign: "127.0.0.1:1455", state: "ESTABLISHED", port: 53998, loopback: true });
  });
  test("the header line is skipped", () => {
    expect(parseLsofLine("COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME")).toBeNull();
  });
});

describe("parseTasklistCsv", () => {
  test("maps PID -> image name", () => {
    const m = parseTasklistCsv('"omp.exe","1234","Console","1","52,340 K"\r\n"chrome.exe","42","Console","1","9,000 K"');
    expect(m.get("1234")).toBe("omp.exe");
    expect(m.get("42")).toBe("chrome.exe");
    expect(m.size).toBe(2);
  });
});

describe("relevant", () => {
  const mk = (over: Partial<NetSocket>): NetSocket =>
    ({ proto: "TCP", local: "", foreign: "", state: "", pid: "1", proc: "x", port: 0, loopback: false, ...over });
  test("keeps loopback traffic and every listener; drops non-loopback non-listeners", () => {
    expect(relevant(mk({ loopback: true, state: "ESTABLISHED" }))).toBe(true);
    expect(relevant(mk({ loopback: false, state: "LISTENING" }))).toBe(true); // a 0.0.0.0 callback bind
    expect(relevant(mk({ loopback: false, state: "ESTABLISHED" }))).toBe(false);
  });
});

describe("diffSockets", () => {
  const mk = (over: Partial<NetSocket>): NetSocket =>
    ({ proto: "TCP", local: "", foreign: "", state: "", pid: "1", proc: "x", port: 0, loopback: false, ...over });
  const snap = (...ss: NetSocket[]) => new Map(ss.map((s) => [socketKey(s), s]));

  test("a new listener on the watched callback port is flagged as a candidate", () => {
    const before = snap();
    const after = snap(mk({ local: "127.0.0.1:1455", state: "LISTENING", proc: "omp.exe", port: 1455, loopback: true }));
    const ev = diffSockets(before, after, 1000, [1455]);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: "listener", port: 1455, proc: "omp.exe", candidate: true });
  });

  test("a closed socket emits a close event; an unwatched non-loopback listener is not a candidate", () => {
    const sock = mk({ local: "127.0.0.1:1455", state: "LISTENING", port: 1455, loopback: true });
    const closed = diffSockets(snap(sock), snap(), 2000, [1455]);
    expect(closed[0]).toMatchObject({ kind: "close", port: 1455 });

    const pub = mk({ local: "0.0.0.0:8080", state: "LISTENING", port: 8080, loopback: false });
    const ev = diffSockets(snap(), snap(pub), 3000, [1455]);
    expect(ev[0]).toMatchObject({ kind: "listener", candidate: false });
  });

  test("an unchanged snapshot produces no events", () => {
    const sock = mk({ local: "127.0.0.1:1455", state: "LISTENING", port: 1455, loopback: true });
    expect(diffSockets(snap(sock), snap(sock), 4000, [1455])).toHaveLength(0);
  });
});
