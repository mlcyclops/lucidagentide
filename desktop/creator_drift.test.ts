// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import {
  DriftActivityLog, DriftClient, defaultDriftExePaths, driftSessionEndpointDef, driftSessionPath, driftSessionStatus,
  parseDriftSession, planDriftLibraryImport,
} from "./creator_drift.ts";

const SESSION = JSON.stringify({ port: 4731, url: "http://127.0.0.1:4731/mcp", token: "abc123def456", pid: 5152 });

const rpcRes = (result: unknown, status = 200) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status, headers: { "content-type": "application/json" } });
const toolRes = (payload: unknown, isError = false, extra: unknown[] = []) =>
  rpcRes({ content: [{ type: "text", text: JSON.stringify(payload) }, ...extra], isError });

describe("Drift session discovery", () => {
  test("the session path follows the platform, and DRIFT_MCP_SESSION_PATH overrides it", () => {
    expect(driftSessionPath({}, "win32", "C:\\Users\\nick")).toBe("C:\\Users\\nick/drift/mcp-session.json");
    expect(driftSessionPath({}, "darwin", "/Users/nick")).toBe("/Users/nick/Library/Application Support/drift/mcp-session.json");
    expect(driftSessionPath({ XDG_RUNTIME_DIR: "/run/user/1000" }, "linux", "/home/nick")).toBe("/run/user/1000/drift/mcp-session.json");
    expect(driftSessionPath({}, "linux", "/home/nick")).toBe("/tmp/drift/mcp-session.json");
    expect(driftSessionPath({ DRIFT_MCP_SESSION_PATH: "D:\\drift\\s.json" }, "win32", "C:\\Users\\nick")).toBe("D:\\drift\\s.json");
  });

  test("a complete loopback session parses; anything incomplete or non-loopback is null", () => {
    expect(parseDriftSession(SESSION)).toEqual({ port: 4731, url: "http://127.0.0.1:4731/mcp", token: "abc123def456", pid: 5152 });
    expect(parseDriftSession("{")).toBeNull();
    expect(parseDriftSession("[]")).toBeNull();
    expect(parseDriftSession(JSON.stringify({ port: 4731, url: "http://127.0.0.1:4731/mcp", pid: 5152 }))).toBeNull();
    expect(parseDriftSession(JSON.stringify({ port: 0, token: "t", pid: 1 }))).toBeNull();
    expect(parseDriftSession(JSON.stringify({ port: 4731, token: "t", pid: 1, url: "http://10.0.0.5:4731/mcp" }))).toBeNull();
    expect(parseDriftSession(JSON.stringify({ port: 4731, token: "t", pid: 1 }))?.url).toBe("http://127.0.0.1:4731/mcp");
  });

  test("the default executable paths per platform", () => {
    expect(defaultDriftExePaths("win32", { LOCALAPPDATA: "C:\\Users\\nick\\AppData\\Local" }))
      .toEqual(["C:\\Program Files\\Drift\\drift.exe", "C:\\Users\\nick\\AppData\\Local\\Programs\\Drift\\drift.exe"]);
    expect(defaultDriftExePaths("darwin", {})).toEqual(["/Applications/Drift.app/Contents/MacOS/Drift"]);
    expect(defaultDriftExePaths("linux", { HOME: "/home/nick" })).toContain("/home/nick/.local/share/flatpak/exports/bin/org.cutwire.Drift");
  });

  test("the synthesized endpoint is loopback, enabled, and carries no token", () => {
    const def = driftSessionEndpointDef(parseDriftSession(SESSION)!);
    expect(def).toEqual({ id: "drift-session", providerId: "drift", label: "Drift (Agent access session)", baseUrl: "http://127.0.0.1:4731", zone: "local", enabled: true });
    expect(JSON.stringify(def)).not.toContain("abc123def456");
  });

  test("the status payload's session block carries port, pid, and path, never the token", () => {
    const path = "C:\\Users\\nick/drift/mcp-session.json";
    const present = driftSessionStatus({ path, session: parseDriftSession(SESSION), error: "" });
    expect(present).toEqual({ path, present: true, port: 4731, pid: 5152, error: "" });
    expect("token" in present).toBe(false);
    expect(JSON.stringify(present)).not.toContain("abc123def456");
    expect(driftSessionStatus({ path, session: null, error: "ENOENT" })).toEqual({ path, present: false, port: 0, pid: 0, error: "ENOENT" });
  });
});

describe("DriftClient", () => {
  test("initialize sends the bearer token in the header only, and reads the version", async () => {
    const seen: { url: string; auth: string | null; method: string }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      const body: unknown = JSON.parse(String(init?.body));
      seen.push({ url, auth: h.get("authorization"), method: body && typeof body === "object" && "method" in body && typeof body.method === "string" ? body.method : "" });
      return rpcRes({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "drift", version: "0.7.3" }, instructions: "hi" });
    };
    const c = new DriftClient({ baseUrl: "http://127.0.0.1:4731/", token: "secret-token", fetchImpl });
    const r = await c.initialize();
    expect(r).toEqual({ ok: true, version: "0.7.3", instructions: "hi" });
    expect(seen).toEqual([{ url: "http://127.0.0.1:4731/mcp", auth: "Bearer secret-token", method: "initialize" }]);
  });

  test("401 is unauthorized, a dead port is a refusal naming Agent access, never a throw", async () => {
    const unauth = new DriftClient({ baseUrl: "http://127.0.0.1:4731", token: "x", fetchImpl: async () => new Response('{"error":"unauthorized"}', { status: 401 }) });
    expect(await unauth.initialize()).toEqual({ ok: false, error: "unauthorized", status: 401 });
    const dead = new DriftClient({ baseUrl: "http://127.0.0.1:4731", token: "x", fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
    const r = await dead.call("inspect");
    expect(r.ok).toBe(false);
    expect(r.isError).toBe(true);
    expect(r.status).toBe(0);
    expect(r.error).toContain("Agent access");
    expect(await dead.health()).toEqual({ ok: false, status: 0 });
  });

  test("tools/call parses the text payload, collects images, and flags isError from the payload", async () => {
    const ok = new DriftClient({ baseUrl: "http://127.0.0.1:4731", token: "x", fetchImpl: async () => toolRes({ ok: true, revision: 7 }, false, [{ type: "image", data: "AAAA", mimeType: "image/jpeg" }]) });
    const r = await ok.call("capture", { at: 2 });
    expect(r.ok).toBe(true);
    expect(r.payload).toEqual({ ok: true, revision: 7 });
    expect(r.images).toEqual([{ mimeType: "image/jpeg", data: "AAAA" }]);
    const soft = new DriftClient({ baseUrl: "http://127.0.0.1:4731", token: "x", fetchImpl: async () => toolRes({ ok: false, error: "not_found", detail: "clip u9" }) });
    const e = await soft.call("set_duration", { clip: "u9" });
    expect(e.ok).toBe(false);
    expect(e.isError).toBe(true);
    expect(e.error).toBe("set_duration: not_found (clip u9)");
    const flagged = new DriftClient({ baseUrl: "http://127.0.0.1:4731", token: "x", fetchImpl: async () => toolRes({ ok: true }, true) });
    expect((await flagged.call("inspect")).isError).toBe(true);
    const rpcErr = new DriftClient({ baseUrl: "http://127.0.0.1:4731", token: "x", fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } }), { status: 200 }) });
    const m = await rpcErr.call("nope");
    expect(m.ok).toBe(false);
    expect(m.error).toContain("Method not found");
  });
});

describe("DriftActivityLog", () => {
  const entry = (tool: string) => ({ at: 1, source: "agent" as const, tool, ok: true, summary: tool, undoable: false, revision: null });

  test("sequences monotonically, latest is newest-first, since is ascending and exclusive", () => {
    const log = new DriftActivityLog();
    const a = log.push(entry("a"));
    const b = log.push(entry("b"));
    const c = log.push(entry("c"));
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    expect(log.latest(2).map((e) => e.tool)).toEqual(["c", "b"]);
    expect(log.since(1).map((e) => e.tool)).toEqual(["b", "c"]);
    expect(log.since(3)).toEqual([]);
  });

  test("the ring keeps the last 200 and seq keeps counting", () => {
    const log = new DriftActivityLog();
    for (let i = 0; i < 230; i++) log.push(entry(`t${i}`));
    expect(log.latest(500)).toHaveLength(200);
    expect(log.latest(1)[0]!.seq).toBe(230);
    expect(log.since(0)[0]!.tool).toBe("t30");
  });
});

describe("library import planning", () => {
  const MP4 = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x00]);
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  test("magic bytes decide the kind; the extension is ignored", () => {
    expect(planDriftLibraryImport("C:\\out\\cut.webm", MP4)).toEqual({ ok: true, kind: "video", mime: "video/mp4" });
    expect(planDriftLibraryImport("/home/n/anim.mp4", GIF)).toEqual({ ok: true, kind: "gif", mime: "image/gif" });
  });

  test("relative paths, empty files, and non-media bytes are refused with a reason", () => {
    expect(planDriftLibraryImport("out/cut.mp4", MP4)).toMatchObject({ ok: false, error: expect.stringContaining("absolute") });
    expect(planDriftLibraryImport("C:\\out\\cut.mp4", new Uint8Array(0))).toMatchObject({ ok: false, error: expect.stringContaining("empty") });
    expect(planDriftLibraryImport("C:\\out\\cut.mp4", PNG)).toMatchObject({ ok: false, error: expect.stringContaining("image/png") });
  });
});
