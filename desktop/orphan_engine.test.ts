// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-PORTGUARD.3 (ADR-0382): the line between "our orphan, reap it after a warning" and "someone else's
// listener, never touch it". A wrong `ours` kills a user's unrelated service; a wrong `foreign` strands an
// upgrader on a dead port forever. Both directions are pinned.

import { describe, expect, test } from "bun:test";
import { classifyPortHolder, orphanDialog, reapSpec } from "./orphan_engine.ts";

const SELF = 4242;
const sq = (o: Partial<{ pid: number | null; name: string | null; startedAt: string | null; command: string | null }>) =>
  ({ pid: 999, name: null, startedAt: null, command: null, ...o });

describe("classifyPortHolder", () => {
  test("the compiled engine is ours by process name, whatever its install path", () => {
    expect(classifyPortHolder(sq({ name: "lucid-engine" }), SELF)).toEqual({ kind: "ours", pid: 999, evidence: "process name lucid-engine" });
    expect(classifyPortHolder(sq({ name: "lucid-engine.exe" }), SELF).kind).toBe("ours");
  });
  test("the compiled engine is ours by image path when the name is missing", () => {
    const r = classifyPortHolder(sq({ command: "C:\\Users\\x\\AppData\\Local\\Programs\\LucidAgentIDE\\resources\\repo\\bin\\lucid-engine.exe" }), SELF);
    expect(r.kind).toBe("ours");
    expect(classifyPortHolder(sq({ command: "/Applications/LucidAgent.app/Contents/Resources/repo/bin/lucid-engine" }), SELF).kind).toBe("ours");
  });
  test("the dev fallback `bun run desktop/dev.ts` is ours", () => {
    expect(classifyPortHolder(sq({ name: "bun", command: "\"C:\\bun\\bun.exe\" run desktop/dev.ts" }), SELF).kind).toBe("ours");
    expect(classifyPortHolder(sq({ name: "bun", command: "bun run desktop\\dev.ts" }), SELF).kind).toBe("ours");
  });
  test("a stranger's server is foreign even when it is also bun (the ADR-0305 field incident)", () => {
    expect(classifyPortHolder(sq({ name: "bun", command: "bun server.ts" }), SELF)).toEqual({ kind: "foreign" });
    expect(classifyPortHolder(sq({ name: "node", command: "node lucid-engine-clone/index.js" }), SELF)).toEqual({ kind: "foreign" });
    expect(classifyPortHolder(sq({ name: "python", command: "python -m http.server 5319" }), SELF)).toEqual({ kind: "foreign" });
  });
  test("a name that merely contains the engine's name is not the engine", () => {
    expect(classifyPortHolder(sq({ name: "lucid-engine-proxy" }), SELF).kind).toBe("foreign");
    expect(classifyPortHolder(sq({ name: "my-lucid-engine" }), SELF).kind).toBe("foreign");
  });
  test("no attribution, no pid, or our own pid is unknown, never ours", () => {
    expect(classifyPortHolder(null, SELF)).toEqual({ kind: "unknown" });
    expect(classifyPortHolder(sq({ pid: null, name: "lucid-engine" }), SELF)).toEqual({ kind: "unknown" });
    expect(classifyPortHolder(sq({ pid: SELF, name: "lucid-engine" }), SELF)).toEqual({ kind: "unknown" });
    expect(classifyPortHolder(sq({ pid: 0, name: "lucid-engine" }), SELF)).toEqual({ kind: "unknown" });
  });
});

describe("reapSpec", () => {
  test("Windows kills the TREE (the orphan's omp session and whisper die with it), by pid, forced", () => {
    expect(reapSpec("win32", 1234)).toEqual({ cmd: "taskkill.exe", args: ["/PID", "1234", "/T", "/F"] });
  });
  test("POSIX has no one-argv tree kill; main signals through process.kill", () => {
    expect(reapSpec("darwin", 1)).toBeNull();
    expect(reapSpec("linux", 1)).toBeNull();
  });
});

describe("orphanDialog", () => {
  const d = orphanDialog({ port: 5319, productName: "LUCID", observed: sq({ pid: 77, name: "lucid-engine", startedAt: "2026-09-22T01:00:00.000Z", command: "C:\\x\\lucid-engine.exe" }), evidence: "process name lucid-engine" });
  test("names the process, the port, and the fact that its session is over, and defaults to stopping it", () => {
    expect(d.message).toContain("process 77");
    expect(d.message).toContain("port 5319");
    expect(d.message).toContain("already over");
    expect(d.buttons[0]).toBe("Stop it and continue");
    expect(d.defaultId).toBe(0);
    expect(d.cancelId).toBe(1);
  });
  test("the detail carries the forensics and the evidence, never an em dash", () => {
    expect(d.detail).toContain("PID: 77");
    expect(d.detail).toContain("Command: C:\\x\\lucid-engine.exe");
    expect(d.detail).toContain("process name lucid-engine");
    expect(`${d.title}${d.message}${d.detail}`).not.toContain("\u2014");
  });
});
