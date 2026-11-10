// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0535; P-HERD.1, ADR-0490): the hub is a SERVER that outlives its terminal. What a user
// notices, pinned against a real server, real TUI clients over /attach and a fake engine on loopback:
// detaching leaves the hub and its engine running; reattaching shows the same panes; several clients
// share one layout rendered at the smallest size; a second named instance keeps its own files;
// `server stop` ends the server and a spawned engine with it, while an engine it only attached to
// stays up; the classic layout seeds `main` without being touched; a truncated layout restores from
// its snapshot; the token, Host and Origin guards hold on /attach and /cmd; and no approval key is
// reachable from /cmd. Every wait below awaits a frame or an engine request, never a clock.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineDiscovery } from "../../../desktop/engine_discovery.ts";
import { callHub, type HubDiscovery } from "../../../harness/launcher/hub_control.ts";
import { Spaces, spacesPath } from "../../../harness/launcher/hub_spaces.ts";
import type { AttachedEngine } from "../../../harness/launcher/hub_tui.ts";
import { attachHub, type HubAttachment } from "../src/hub_client.ts";
import { renderSize, startHubServer, type HubServer } from "../src/hub_server.ts";
import { connectInstance, instancePaths } from "../src/instance.ts";

let data: string;
let classic: string;
let engine: { port: number; stop(close: boolean): void };
let engineRecord: EngineDiscovery;
let enginePaths: string[] = [];
let engineWaiters: (() => void)[] = [];
const servers: HubServer[] = [];

/** Just enough engine for the hub's poll: one working lane, nothing quarantined. Every request is
 *  recorded, so a test can prove which routes the hub reached (and that no approval route was). */
function fakeEngine(): void {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      enginePaths.push(pathname);
      for (const w of engineWaiters.splice(0)) w();
      const body: Record<string, unknown> =
        pathname === "/api/build-info" ? { productName: "LucidAgentIDE", version: "9.9", flavor: "agent" }
        : pathname === "/api/security" ? { live: { quarantined: [] } }
        : pathname === "/api/fleet/status" ? { lanes: [{ id: "lane_1", name: "scout", status: "working", model: "m" }] }
        : pathname === "/api/fleet/transcript" ? { turns: [] }
        : {};
      return Response.json(body);
    },
  });
  engine = { port: server.port!, stop: (close) => { void server.stop(close); } };
  engineRecord = { v: 1, pid: process.pid, port: engine.port, nonce: "n", version: "9.9", flavor: "agent", startedAt: new Date().toISOString(), token: "engine-ui-token" };
}
/** Resolves on the engine's next request: the server's own poll clock, observed, not imitated. */
function nextEngineRequest(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  engineWaiters.push(resolve);
  return promise;
}

const attachedTo = (child: AttachedEngine["child"] = null): AttachedEngine => ({ engine: engineRecord, spawned: child !== null, child });

function serve(name?: string, child: AttachedEngine["child"] = null): HubServer {
  const s = startHubServer({ data, classic, ...(name ? { name } : {}), attached: attachedTo(child) });
  servers.push(s);
  return s;
}

/** A headless TUI client: every frame it is sent, plain text, and a way to wait for one. */
interface Client { att: HubAttachment; frames: string[][]; until(pred: (f: string[]) => boolean): Promise<string[]> }

async function client(d: HubDiscovery, cols = 120, rows = 40): Promise<Client> {
  const frames: string[][] = [];
  const waiters: (() => void)[] = [];
  const att = await attachHub(d, {
    cols, rows,
    onFrame: (lines) => { frames.push(lines.map((l) => Bun.stripANSI(l))); for (const w of waiters.splice(0)) w(); },
  });
  const until = async (pred: (f: string[]) => boolean): Promise<string[]> => {
    for (;;) {
      const last = frames.at(-1);
      if (last && pred(last)) return last;
      const next = Promise.withResolvers<void>();
      waiters.push(next.resolve);
      await next.promise; // the next frame is the signal; the test timeout bounds it
    }
  };
  return { att, frames, until };
}

const hub = async (name = "main"): Promise<HubDiscovery> => {
  const d = await connectInstance(data, name);
  if (!d) throw new Error(`instance ${name} did not answer the handshake`);
  return d;
};
const cmd = async (d: HubDiscovery, ...argv: string[]) => (await callHub(d, argv)).body;
async function paneCount(d: HubDiscovery): Promise<number> {
  const panes = (await cmd(d, "pane", "list")).data;
  return Array.isArray(panes) ? panes.length : -1;
}
const text = (f: string[]) => f.join("\n");
/** Pane tops on the first body row: 2 once a split-right is on screen. */
const topsOnRow1 = (f: string[]) => (f[1]?.match(/╭/g) ?? []).length;
/** Pane tops anywhere in the frame: one more once any split is on screen. */
const boxes = (f: string[]) => (text(f).match(/╭/g) ?? []).length;

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), "herd-data-"));
  classic = mkdtempSync(join(tmpdir(), "herd-classic-"));
  enginePaths = [];
  engineWaiters = [];
  fakeEngine();
});
afterEach(async () => {
  for (const s of servers.splice(0)) { s.stop(); await s.done; }
  engine.stop(true);
  rmSync(data, { recursive: true, force: true });
  rmSync(classic, { recursive: true, force: true });
});

describe("attach, detach and reattach", () => {
  test("Q detaches: the server, its layout and its engine stay up, and a reattach shows the same panes", async () => {
    serve();
    const d = await hub();
    const a = await client(d);
    await a.until((f) => text(f).includes("herd main · 1 attached"));
    a.att.send("|"); // split right, a key through the ONE keymap
    // The key is applied before the frame that shows it is sent, so /cmd agrees from here on.
    const seen = await a.until((f) => topsOnRow1(f) === 2 && text(f).includes("scout"));
    expect(await paneCount(d)).toBe(2);
    a.att.send("Q");
    expect(await a.att.closed).toBe("detached");

    // Nobody attached, everything still running: the control plane answers and the engine is polled.
    expect((await cmd(d, "status")).data).toMatchObject({ hub: { name: "main" } });
    const before = enginePaths.length;
    await nextEngineRequest();
    expect(enginePaths.length).toBeGreaterThan(before);

    const b = await client(d);
    const again = await b.until((f) => text(f).includes("herd main · 1 attached") && text(f).includes("scout") && topsOnRow1(f) === 2);
    expect(await paneCount(d)).toBe(2);
    // Same hub, same layout: the frame matches what the first client saw, status line aside.
    expect(again.slice(0, -1)).toEqual(seen.slice(0, -1));
    b.att.detach();
    expect(await b.att.closed).toBe("detached");
  }, 20_000);

  test("q from one client detaches that client only", async () => {
    serve();
    const d = await hub();
    const a = await client(d);
    const b = await client(d);
    await b.until((f) => text(f).includes("2 attached"));
    a.att.send("q");
    expect(await a.att.closed).toBe("detached");
    await b.until((f) => text(f).includes("1 attached"));
    expect((await cmd(d, "status")).data).toMatchObject({ hub: { clients: 1 } });
    b.att.detach();
    await b.att.closed;
  }, 20_000);
});

describe("two clients, one layout", () => {
  test("a split from one client shows in the other, both at the smallest attached size", async () => {
    serve();
    const d = await hub();
    const big = await client(d, 140, 44);
    const small = await client(d, 100, 30);
    const f = await small.until((x) => text(x).includes("2 attached"));
    expect(f).toHaveLength(30);
    expect(Math.max(...f.map((l) => Bun.stringWidth(l)))).toBeLessThanOrEqual(100);
    big.att.send("-"); // split down from the BIG client
    await small.until((x) => boxes(x) > boxes(f) && text(x).includes("2 attached"));
    expect(await paneCount(d)).toBe(2);
    // One frame for everyone: the big client's latest is the small client's latest.
    await big.until((x) => text(x) === text(small.frames.at(-1)!));
    small.att.detach();
    await small.att.closed;
    const grown = await big.until((x) => x.length === 44);
    expect(Math.max(...grown.map((l) => Bun.stringWidth(l)))).toBeLessThanOrEqual(140);
    big.att.detach();
    await big.att.closed;
  }, 20_000);

  test("renderSize is the smallest attached terminal, or a default with nobody attached", () => {
    expect(renderSize([{ cols: 140, rows: 30 }, { cols: 90, rows: 50 }])).toEqual({ cols: 90, rows: 30 });
    expect(renderSize([])).toEqual({ cols: 120, rows: 40 });
  });
});

describe("named instances", () => {
  test("a second named instance has its own server, layout, priorities and discovery folder", async () => {
    serve();
    serve("work");
    const main = await hub();
    const work = await hub("work");
    expect(work.port).not.toBe(main.port);
    await cmd(main, "split-window", "-h");
    expect(await paneCount(main)).toBe(2); // same connection, so no race: /cmd answers after the split
    expect(await paneCount(work)).toBe(1);
    expect((await cmd(work, "status")).data).toMatchObject({ hub: { name: "work" } });
    expect((await cmd(work, "agent", "priority", "scout", "7")).data).toMatchObject({ priority: 7 });
    const m = instancePaths(data, "main");
    const w = instancePaths(data, "work");
    expect(Spaces.restore(readFileSync(m.spaces, "utf8"), () => true)?.paneList()).toHaveLength(2);
    // work never changed structurally; whatever it wrote (if anything) is its own single pane.
    if (existsSync(w.spaces)) expect(Spaces.restore(readFileSync(w.spaces, "utf8"), () => true)?.paneList()).toHaveLength(1);
    expect(existsSync(w.priorities)).toBe(true);
    expect(existsSync(m.priorities)).toBe(false);
    expect(readdirSync(m.run).filter((n) => n.startsWith("hub-discovery-"))).toHaveLength(1);
    expect(readdirSync(w.run).filter((n) => n.startsWith("hub-discovery-"))).toHaveLength(1);
    // Nothing Herd writes lands beside the classic hub's files.
    expect(readdirSync(classic)).toEqual([]);
  }, 20_000);
});

describe("server stop", () => {
  test("ends the server: clients are told, the discovery file goes, a SPAWNED engine stops with it", async () => {
    // A stand-in for the engine the server spawned: a child that idles until it is killed (its own
    // timer keeps it alive; nothing in this test waits on a clock).
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
    const s = serve(undefined, child);
    const d = await hub();
    const a = await client(d);
    await a.until(() => true);
    expect((await cmd(d, "server", "stop")).data).toMatchObject({ stopping: "main" });
    expect(await a.att.closed).toBe("stopped");
    await s.done;
    expect(await connectInstance(data, "main")).toBeNull();
    expect(readdirSync(instancePaths(data, "main").run).some((n) => n.startsWith("hub-discovery-"))).toBe(false);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }, 20_000);

  test("an engine the server only attached to keeps running", async () => {
    const s = serve();
    const d = await hub();
    await cmd(d, "server", "stop");
    await s.done;
    expect(await connectInstance(data, "main")).toBeNull();
    expect((await fetch(`http://127.0.0.1:${engine.port}/api/build-info`)).ok).toBe(true);
  }, 20_000);

  test("server list and start are shell verbs, refused through a running server", async () => {
    serve();
    const d = await hub();
    const r = await callHub(d, ["server", "list"]);
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: "usage" });
  }, 20_000);
});

describe("layout durability", () => {
  test("the classic hub-spaces.json seeds instance main once and is never moved or written", async () => {
    const legacy = new Spaces();
    legacy.create("review");
    const classicFile = spacesPath(classic);
    const bytes = JSON.stringify(legacy) + "\n";
    writeFileSync(classicFile, bytes);
    const s = serve();
    expect(s.seeded).toBe(true);
    const d = await hub();
    expect((await cmd(d, "space", "list")).data).toMatchObject([{ name: "main" }, { name: "review" }]);
    expect(readFileSync(classicFile, "utf8")).toBe(bytes);
    expect(existsSync(instancePaths(data, "main").spaces)).toBe(true);
    // Another instance never seeds from the classic file.
    expect(serve("work").seeded).toBe(false);
  }, 20_000);

  test("a truncated layout file restores from the newest snapshot and says so", async () => {
    const first = serve();
    const d = await hub();
    await cmd(d, "split-window", "-h");
    first.stop();
    await first.done;
    const paths = instancePaths(data, "main");
    expect(readdirSync(paths.snapshots).length).toBeGreaterThan(0);
    writeFileSync(paths.spaces, "\0\0\0\0"); // Herdr's NUL-filled session file after a crash
    const second = serve();
    expect(second.restored).toContain("hub-snapshots");
    expect(second.seeded).toBe(false);
    const d2 = await hub();
    expect(await paneCount(d2)).toBe(2);
    const c = await client(d2, 200, 40);
    await c.until((f) => text(f).includes("layout file did not parse"));
    expect(Spaces.restore(readFileSync(paths.spaces, "utf8"), () => true)).not.toBeNull(); // written back whole
    c.att.detach();
    await c.att.closed;
  }, 20_000);
});

describe("security posture (ADR-0490 item 6)", () => {
  test("/attach needs the token, a loopback Host, no Origin, and a terminal size", async () => {
    serve();
    const d = await hub();
    const url = `http://127.0.0.1:${d.port}/attach?cols=100&rows=30`;
    expect((await fetch(url, { headers: { "x-lucid-hub-token": "wrong" } })).status).toBe(403);
    expect((await fetch(url)).status).toBe(403);
    expect((await fetch(url, { headers: { "x-lucid-hub-token": d.token, origin: "http://evil.example" } })).status).toBe(403);
    expect((await fetch(url.replace("cols=100", "cols=abc"), { headers: { "x-lucid-hub-token": d.token } })).status).toBe(400);
    // A WebSocket with the wrong token never opens.
    await expect(attachHub({ ...d, token: "wrong" }, { cols: 100, rows: 30, onFrame: () => {} })).rejects.toThrow("refused");
    expect((await cmd(d, "status")).data).toMatchObject({ hub: { clients: 0 } });
  }, 20_000);

  test("/cmd refuses a wrong token and a browser Origin", async () => {
    serve();
    const d = await hub();
    const post = (headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${d.port}/cmd`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ argv: ["server", "stop"] }) });
    expect((await post({ "x-lucid-hub-token": "wrong" })).status).toBe(403);
    expect((await post({ "x-lucid-hub-token": d.token, origin: "http://evil.example" })).status).toBe(403);
    expect(await connectInstance(data, "main")).not.toBeNull(); // neither stopped it
  }, 20_000);

  test("approval keys are refused on /cmd and never reach an approval route", async () => {
    serve();
    const d = await hub();
    await cmd(d, "pane", "rebind", "s1:p1", "security");
    for (const key of ["a", "i", "y", "s", "d"]) {
      const bare = await callHub(d, [key]);
      expect(bare.status).toBe(400);
      expect(bare.body).toMatchObject({ error: "usage" });
      const typed = await callHub(d, ["send-keys", "-t", "s1:p1", key]);
      expect(typed.status).toBe(409);
      expect(typed.body).toMatchObject({ error: "not_agent" });
    }
    expect(enginePaths.some((p) => p.startsWith("/api/security/approve") || p.startsWith("/api/security/dismiss") || p.startsWith("/api/fleet/answer"))).toBe(false);
  }, 20_000);
});
