// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-HERD-OSC.1 (ADR-0530, in the Herd add-on since ADR-0535): the OSC 7501 report builder. A valid
// report is the exact byte string the spec's own examples show; every input a terminal would DISCARD
// (bad state, id, kind, progress, app, control characters, over-limit text) is refused with a reason
// instead of written.

import { describe, expect, test } from "bun:test";
import { buildProgramStatus, CLEAR_ALL_PROGRAM_STATUS, cleanStatusText, validStatusId, type ProgramStatusReport } from "../src/program_status.ts";

const seq = (r: ProgramStatusReport): string => {
  const out = buildProgramStatus(r);
  if (!out.ok) throw new Error(out.error);
  return out.seq;
};
const refusal = (r: ProgramStatusReport): string => {
  const out = buildProgramStatus(r);
  if (out.ok) throw new Error(`expected a refusal, got ${JSON.stringify(out.seq)}`);
  return out.error;
};
/** What a terminal reads: the pairs, with title/msg base64-decoded. */
const decode = (s: string): Record<string, string> => {
  expect(s.startsWith("\x1b]7501;")).toBe(true);
  expect(s.endsWith("\x1b\\")).toBe(true);
  const pairs = s.slice(7, -2).split(":").map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)] as const);
  return Object.fromEntries(pairs.map(([k, v]) => [k, k === "title" || k === "msg" ? Buffer.from(v, "base64").toString("utf8") : v]));
};

describe("buildProgramStatus: valid reports", () => {
  test("the spec's own examples come out byte for byte", () => {
    expect(seq({ state: "blocked", kind: "permission", app: "terraform", msg: "Apply 3 to add, 1 to change, 0 to destroy?" }))
      .toBe("\x1b]7501;state=blocked:kind=permission:app=terraform:msg=QXBwbHkgMyB0byBhZGQsIDEgdG8gY2hhbmdlLCAwIHRvIGRlc3Ryb3k/\x1b\\");
    expect(seq({ state: "working", id: "us-east", title: "US East", progress: 40, msg: "Pushing image" }))
      .toBe("\x1b]7501;state=working:id=us-east:title=VVMgRWFzdA==:progress=40:msg=UHVzaGluZyBpbWFnZQ==\x1b\\");
    expect(seq({ state: "clear", id: "us-east" })).toBe("\x1b]7501;state=clear:id=us-east\x1b\\");
    expect(seq({ state: "clear" })).toBe(CLEAR_ALL_PROGRAM_STATUS);
    expect(CLEAR_ALL_PROGRAM_STATUS).toBe("\x1b]7501;state=clear\x1b\\");
  });
  test("UTF-8 title and msg decode back to the same text", () => {
    const d = decode(seq({ state: "done", id: "a/b.c/d_e+f-1", title: "café ✓ 🚀", msg: "Turn finished, ñ" }));
    expect(d).toEqual({ state: "done", id: "a/b.c/d_e+f-1", title: "café ✓ 🚀", msg: "Turn finished, ñ" });
  });
  test("every state, progress at both ends, all three kinds", () => {
    for (const state of ["idle", "working", "done", "blocked", "error"] as const) expect(decode(seq({ state })).state).toBe(state);
    expect(decode(seq({ state: "working", progress: 0 })).progress).toBe("0");
    expect(decode(seq({ state: "blocked", kind: "auth", progress: 100 })).progress).toBe("100");
    for (const kind of ["permission", "question", "auth"] as const) expect(decode(seq({ state: "blocked", kind })).kind).toBe(kind);
  });
  test("the limits themselves are allowed: 192-byte title, 2048-byte msg, 8 levels, 128-byte id", () => {
    const id = ["a".repeat(15), ...Array.from({ length: 7 }, () => "b".repeat(15))].join("/"); // 8*15 + 7 = 127
    expect(validStatusId(id)).toBe(true);
    const out = seq({ state: "blocked", kind: "question", id, title: "é".repeat(96), progress: 50, app: "a".repeat(32), msg: "€".repeat(682) + "xx" });
    expect(out.length).toBeLessThanOrEqual(4096);
    expect(decode(out).title).toBe("é".repeat(96));
  });
});

describe("buildProgramStatus: refusals (a terminal would discard these whole)", () => {
  test("state: missing from the set", () => {
    expect(refusal({ state: "busy" as never })).toContain("unknown state");
  });
  test("kind: only with blocked, only the three values", () => {
    expect(refusal({ state: "working", kind: "permission" })).toContain("only for state blocked");
    expect(refusal({ state: "blocked", kind: "approval" as never })).toContain("unknown kind");
  });
  test("id: grammar, segment length, depth, total bytes", () => {
    for (const id of ["", "a//b", "/a", "a/", "a b", "a:b", "a;b", "naïve", "x".repeat(33), Array(9).fill("a").join("/")])
      expect(refusal({ state: "idle", id })).toContain("breaks the grammar");
    const long = Array.from({ length: 5 }, () => "c".repeat(32)).join("/"); // 164 bytes, 5 levels
    expect(refusal({ state: "idle", id: long })).toContain("128 bytes");
  });
  test("progress: an integer 0..100, only while working or blocked", () => {
    for (const progress of [-1, 101, 1.5, Number.NaN]) expect(refusal({ state: "working", progress })).toContain("not an integer 0..100");
    expect(refusal({ state: "done", progress: 100 })).toContain("only for state working or blocked");
  });
  test("app: [A-Za-z0-9_.+-]{1,32}", () => {
    for (const app of ["", "my app", "lucid/hub", "a".repeat(33)]) expect(refusal({ state: "idle", app })).toContain("app");
  });
  test("title and msg: no control character of any range, well-formed, within the byte cap", () => {
    for (const bad of ["two\nlines", "tab\there", "esc\x1b]0;x", "del\x7f", "c1\u009b", "nul\u0000"]) {
      expect(refusal({ state: "idle", title: bad })).toContain("control character");
      expect(refusal({ state: "idle", msg: bad })).toContain("control character");
    }
    expect(refusal({ state: "idle", msg: "lone \ud800" })).toContain("lone surrogate");
    expect(refusal({ state: "idle", title: "a".repeat(193) })).toContain("limit is 192");
    expect(refusal({ state: "idle", title: "é".repeat(97) })).toContain("limit is 192"); // 194 bytes, 97 chars
    expect(refusal({ state: "idle", msg: "a".repeat(2049) })).toContain("limit is 2048");
  });
  test("clear takes only an id", () => {
    expect(refusal({ state: "clear", msg: "bye" })).toContain("clear takes only an id");
    expect(refusal({ state: "clear", app: "lucid" })).toContain("clear takes only an id");
  });
});

describe("cleanStatusText", () => {
  test("control runs become one space; the result always builds", () => {
    const t = cleanStatusText("  line one\r\n\tline two\x1b[31m red\u0085 ", 192);
    expect(t).toBe("line one line two [31m red");
    expect(buildProgramStatus({ state: "idle", title: t }).ok).toBe(true);
  });
  test("cut at a code point boundary within the byte cap, never mid-character", () => {
    expect(cleanStatusText("é".repeat(100), 5)).toBe("éé");
    expect(cleanStatusText("ab🚀cd", 5)).toBe("ab");
    expect(cleanStatusText("ab🚀cd", 6)).toBe("ab🚀");
    expect(cleanStatusText("lone \ud800 surrogate", 64)).toBe("lone \ufffd surrogate");
  });
});
