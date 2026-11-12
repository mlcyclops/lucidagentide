// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-TUI.3 (ADR-0436): control-plane auth is fail-closed. The token never leaves the client until the
// server behind the discovery file echoes that file's nonce, and nothing executes without the token.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callHub, connectHub, hubDiscoveryPath, startHubControl, type HubControl } from "./hub_control.ts";
import type { HubOp } from "./hub_tmux_verbs.ts";

let dir: string;
let ctl: HubControl;
let ran: HubOp[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-ctl-"));
  ran = [];
  ctl = startHubControl({ dir, exec: async (op) => { ran.push(op); return { echoed: op.op }; } });
});
afterEach(() => { ctl.stop(); rmSync(dir, { recursive: true, force: true }); });

const post = (headers: Record<string, string>, body: unknown = { argv: ["status"] }) =>
  fetch(`http://127.0.0.1:${ctl.discovery.port}/cmd`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("discovery + handshake", () => {
  test("the file is 0600, wins the handshake, and is removed on stop", async () => {
    // POSIX perms only: Windows ACLs do not map to a mode bitmask (stat reports 0o666).
    if (process.platform !== "win32") expect(statSync(ctl.path).mode & 0o777).toBe(0o600);
    const d = await connectHub(dir);
    expect(d?.port).toBe(ctl.discovery.port);
    const r = await callHub(d!, ["status"]);
    expect(r).toEqual({ status: 200, body: { ok: true, data: { echoed: "status" } } });
    ctl.stop();
    expect(existsSync(ctl.path)).toBe(false);
  });

  test("a wrong nonce is refused and the squatter never receives the token", async () => {
    const seen: string[] = [];
    const squat = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
      seen.push(`${new URL(req.url).pathname} ${req.headers.get("x-lucid-hub-token") ?? ""}`);
      return Response.json({ ok: true, nonce: "not-the-files-nonce" });
    } });
    try {
      rmSync(ctl.path);
      writeFileSync(hubDiscoveryPath(dir, 4242), JSON.stringify({ v: 1, pid: 4242, port: squat.port, nonce: "the-files-nonce", token: "secret-token" }));
      expect(await connectHub(dir)).toBeNull();
      expect(seen).toEqual(["/health "]);
      // The real server presented with a file carrying the wrong nonce is refused just the same.
      writeFileSync(hubDiscoveryPath(dir, 4242), JSON.stringify({ ...ctl.discovery, pid: 4242, nonce: "stale" }));
      expect(await connectHub(dir)).toBeNull();
    } finally { squat.stop(true); }
  });

  test("a stale file (nothing listening) is inert", async () => {
    const dead = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = dead.port;
    dead.stop(true);
    rmSync(ctl.path);
    writeFileSync(hubDiscoveryPath(dir, 4243), JSON.stringify({ v: 1, pid: 4243, port, nonce: "n", token: "t" }));
    expect(await connectHub(dir)).toBeNull();
  });
});

describe("/cmd auth", () => {
  test("wrong or missing token is 403 and nothing executes", async () => {
    expect((await post({ "x-lucid-hub-token": "wrong" })).status).toBe(403);
    // A one-character near miss. Flip the last char rather than force it to "0": a token that already
    // ends in "0" (1 in 16) would otherwise be sent back unchanged and authenticate.
    const t = ctl.discovery.token;
    expect((await post({ "x-lucid-hub-token": t.slice(0, -1) + (t.endsWith("0") ? "1" : "0") })).status).toBe(403);
    expect((await post({})).status).toBe(403);
    expect(ran).toEqual([]);
  });

  test("a browser Origin is 403 even with the token", async () => {
    expect((await post({ "x-lucid-hub-token": ctl.discovery.token, origin: "http://evil.example" })).status).toBe(403);
    expect(ran).toEqual([]);
  });

  test("bad bodies and bad commands are 400 with a machine-readable code", async () => {
    const t = { "x-lucid-hub-token": ctl.discovery.token };
    expect((await post(t, { argv: "status" })).status).toBe(400);
    const r = await post(t, { argv: ["frobnicate"] });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: "usage" });
    expect(ran).toEqual([]);
  });
});
