// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0541; P-HERD.2 and P-HERD.3, ADR-0491 and ADR-0492), end to end: a real Herd server, a
// headless client fed real key bytes over /attach, the control plane, and a fake engine on loopback.
// The prefix splits while a composer is focused and the composer keeps its text; directional focus
// lands on the geometric neighbor; resize mode moves a divider by cells and the CLI reads the same
// ratio; a rebound key shows in `prefix+?` and an unknown action is reported; a moved pane keeps its
// id; copy mode yanks to the client; a name slot fills when its lane appears; a saved layout applies
// to a new tab as the same tree; the cycle comes back to the start; a divider drag resizes. Every wait
// awaits a frame or an engine request, never a clock.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineDiscovery } from "../../../desktop/engine_discovery.ts";
import { callHub, type HubDiscovery } from "../../../harness/launcher/hub_control.ts";
import { splitBoxes, type PaneDeck } from "../../../harness/launcher/hub_spaces.ts";
import { DECKS } from "../../../harness/launcher/hub_tui.ts";
import { osc52 } from "../src/copy_mode.ts";
import { attachHub, type HubAttachment } from "../src/hub_client.ts";
import { startHubServer, type HubServer } from "../src/hub_server.ts";
import { connectInstance } from "../src/instance.ts";
import { keysPath } from "../src/keys.ts";
import { LayoutLibrary, nextLayoutName } from "../src/layouts.ts";

let data: string;
let classic: string;
let engine: { port: number; stop(close: boolean): void };
let engineRecord: EngineDiscovery;
let lanes: Record<string, unknown>[] = [];
let engineWaiters: (() => void)[] = [];
const servers: HubServer[] = [];

/** One idle lane with one user turn; `lanes` can grow mid-test (a lane appearing). */
function fakeEngine(): void {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      for (const w of engineWaiters.splice(0)) w();
      const body: Record<string, unknown> =
        pathname === "/api/build-info" ? { productName: "LucidAgentIDE", version: "9.9", flavor: "agent" }
        : pathname === "/api/security" ? { live: { quarantined: [] } }
        : pathname === "/api/fleet/status" ? { lanes }
        : pathname === "/api/fleet/transcript" ? { turns: [{ role: "user", text: "hello herd" }] }
        : {};
      return Response.json(body);
    },
  });
  engine = { port: server.port!, stop: (close) => { void server.stop(close); } };
  engineRecord = { v: 1, pid: process.pid, port: engine.port, nonce: "n", version: "9.9", flavor: "agent", startedAt: new Date().toISOString(), token: "engine-ui-token" };
}
const nextEngineRequest = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  engineWaiters.push(resolve);
  return promise;
};

function serve(): HubServer {
  const s = startHubServer({ data, classic, attached: { engine: engineRecord, spawned: false, child: null } });
  servers.push(s);
  return s;
}

interface Client { att: HubAttachment; yanks: string[]; until(pred: (f: string[]) => boolean): Promise<string[]> }

async function client(d: HubDiscovery, cols = 120, rows = 40): Promise<Client> {
  const frames: string[][] = [];
  const yanks: string[] = [];
  const waiters: (() => void)[] = [];
  const wake = () => { for (const w of waiters.splice(0)) w(); };
  const att = await attachHub(d, {
    cols, rows,
    onFrame: (lines) => { frames.push(lines.map((l) => Bun.stripANSI(l))); wake(); },
    onYank: (text) => { yanks.push(text); wake(); },
  });
  const until = async (pred: (f: string[]) => boolean): Promise<string[]> => {
    for (;;) {
      const last = frames.at(-1);
      if (last && pred(last)) return last;
      const next = Promise.withResolvers<void>();
      waiters.push(next.resolve);
      await next.promise;
    }
  };
  return { att, yanks, until };
}

const hub = async (): Promise<HubDiscovery> => {
  const d = await connectInstance(data, "main");
  if (!d) throw new Error("the server did not answer the handshake");
  return d;
};
const cmd = async (d: HubDiscovery, ...argv: string[]) => (await callHub(d, argv)).body;
interface PaneRow { id: string; tab: string; deck: string; lane?: string; slot?: unknown; label?: string; focused: boolean }
const panes = async (d: HubDiscovery): Promise<PaneRow[]> => (await cmd(d, "pane", "list")).data as PaneRow[];
const focused = async (d: HubDiscovery): Promise<string | undefined> => (await panes(d)).find((p) => p.focused)?.id;
const text = (f: string[]) => f.join("\n");
const topsOnRow1 = (f: string[]) => (f[1]?.match(/╭/g) ?? []).length;
const ARMED = "one action key";
/** Every key sent before this has been handled: the prefix's own status shows only after them. */
async function settle(c: Client): Promise<void> {
  c.att.send("\x02");
  await c.until((f) => text(f).includes(ARMED));
  c.att.send("\x1b");
  await c.until((f) => !text(f).includes(ARMED));
}
const keys = (c: Client, ...k: string[]) => { for (const x of k) c.att.send(x); };

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), "herd-keys-it-"));
  classic = mkdtempSync(join(tmpdir(), "herd-keys-classic-"));
  lanes = [{ id: "lane_1", name: "scout", status: "idle", model: "m" }];
  engineWaiters = [];
  fakeEngine();
});
afterEach(async () => {
  for (const s of servers.splice(0)) { s.stop(); await s.done; }
  engine.stop(true);
  rmSync(data, { recursive: true, force: true });
  rmSync(classic, { recursive: true, force: true });
});

describe("the prefix and the modes", () => {
  test("a fresh instance opens on solo; ctrl+b v splits while a composer is focused, and the composer keeps its text", async () => {
    serve();
    const d = await hub();
    const a = await client(d);
    await a.until((f) => text(f).includes("▶ scout")); // solo's agent slot took the first lane
    keys(a, "\r", "draft");
    await a.until((f) => text(f).includes("› draft▌"));
    keys(a, "\x02", "v");
    const f = await a.until((x) => topsOnRow1(x) === 2);
    expect(text(f)).toContain("› draft▌");
    expect(await panes(d)).toHaveLength(2);
    keys(a, " more"); // still typing into the same composer
    await a.until((x) => text(x).includes("› draft more▌"));
    a.att.detach();
    await a.att.closed;
  }, 20_000);

  test("ctrl+b h j l land on the geometric neighbor in columns-3; the edge refuses with a status line", async () => {
    serve();
    const d = await hub();
    const a = await client(d);
    await a.until((f) => text(f).includes("▶ scout"));
    await cmd(d, "layout", "apply", "columns-3");
    const [a1, a2, a3, sec, audit] = (await panes(d)).map((p) => p.id);
    await cmd(d, "pane", "focus", sec!);
    keys(a, "\x02", "j");
    await settle(a);
    expect(await focused(d)).toBe(audit);
    keys(a, "\x02", "h");
    await settle(a);
    expect(await focused(d)).toBe(a3);
    keys(a, "\x02", "h", "\x02", "h");
    await settle(a);
    expect(await focused(d)).toBe(a1);
    keys(a, "\x02", "h");
    await a.until((f) => text(f).includes("refused: no pane to the left"));
    expect(await focused(d)).toBe(a1);
    // The control plane resolves the same geometry.
    expect((await cmd(d, "pane", "focus", "--direction", "right")).data).toMatchObject({ focused: a2 });
    a.att.detach();
    await a.att.closed;
  }, 20_000);

  test("resize mode moves the divider by cells, and the CLI reads the matching ratio and moves it back", async () => {
    serve();
    const d = await hub();
    const a = await client(d);
    await a.until((f) => text(f).includes("▶ scout"));
    await cmd(d, "layout", "apply", "review");
    const agent = (await panes(d))[0]!.id;
    await cmd(d, "pane", "focus", agent);
    keys(a, "\x02", "r", "l");
    const f = await a.until((x) => /\d+ of \d+ cells \(ratio [\d.]+\)/.test(text(x)));
    const [, cells, size, ratio] = /(\d+) of (\d+) cells \(ratio ([\d.]+)\)/.exec(text(f))!;
    keys(a, "\x1b");
    await settle(a);
    expect(Number(cells)).toBe(Math.floor(Number(size) * 0.5) + 1);
    const tree = (await cmd(d, "layout", "tree")).data as { tree: { ratio: number } };
    expect(tree.tree.ratio).toBe(Number(ratio));
    expect(Math.floor(Number(size) * tree.tree.ratio)).toBe(Number(cells));
    expect((await cmd(d, "pane", "resize", "-t", agent, "-L", "--cells", "1")).data).toMatchObject({ cells: Number(cells) - 1, size: Number(size) });
    a.att.detach();
    await a.att.closed;
  }, 20_000);

  test("a rebound key shows in ctrl+b ?, an unknown action is reported in the status line, and an edit reloads", async () => {
    writeFileSync(keysPath(data), JSON.stringify({ v: 1, bindings: { "split-right": ["s"], launch: ["m"] } }));
    serve();
    const d = await hub();
    const a = await client(d);
    await a.until((f) => text(f).includes('hub-keys.json: unknown action "launch" in bindings; skipped'));
    keys(a, "\x02", "?");
    let help = await a.until((f) => text(f).includes("from hub-keys.json"));
    expect(help.some((l) => l.includes("ctrl+b s") && l.includes("split the pane to the right"))).toBe(true);
    keys(a, "x"); // any key closes the table, and never reaches the keymap (x would close a pane)
    await a.until((f) => !text(f).includes("from hub-keys.json"));
    keys(a, "\x02", "s");
    await a.until((f) => topsOnRow1(f) === 2);
    expect(await panes(d)).toHaveLength(2);
    writeFileSync(keysPath(data), JSON.stringify({ v: 1, bindings: { "split-right": ["S", "ctrl+s"] } }));
    keys(a, "\x02", "?");
    help = await a.until((f) => text(f).includes("ctrl+b S, ctrl+b ctrl+s"));
    expect(text(help)).not.toContain('unknown action "launch"');
    keys(a, "q");
    a.att.detach();
    await a.att.closed;
  }, 20_000);

  test("copy mode yanks the selected line to the yanking client, as OSC 52", async () => {
    serve();
    const d = await hub();
    const a = await client(d);
    await a.until((f) => text(f).includes("› hello herd"));
    keys(a, "\x02", "[");
    await a.until((f) => text(f).includes("copy mode ·"));
    keys(a, "0", "v", "$", "y");
    await a.until((f) => text(f).includes("yanked 1 line"));
    expect(a.yanks).toEqual(["› hello herd"]);
    expect(osc52(a.yanks[0]!)).toBe(`\x1b]52;c;${Buffer.from("› hello herd").toString("base64")}\x07`);
    a.att.detach();
    await a.att.closed;
  }, 20_000);

  test("a press and drag on a divider resizes through the same split; a press without a drag is a click", async () => {
    const s = serve();
    const d = await hub();
    const a = await client(d);
    await a.until((f) => text(f).includes("▶ scout"));
    await cmd(d, "split-window", "-h");
    await settle(a);
    const g = s.component.geometry!;
    const w = 120 - g.left;
    const box = splitBoxes(s.component.spaces.tab.tree, w, g.height)[0]!;
    const col = g.left + box.at; // the right pane's left border, 0-based
    const row = g.top + 3;
    keys(a, `\x1b[<0;${col + 1};${row + 1}M`, `\x1b[<32;${col + 6};${row + 1}M`, `\x1b[<0;${col + 6};${row + 1}m`);
    await a.until((f) => text(f).includes(`divider at ${box.at + 5} of ${w} cells`));
    const tree = (await cmd(d, "layout", "tree")).data as { tree: { ratio: number } };
    expect(Math.floor(w * tree.tree.ratio)).toBe(box.at + 5);
    // A press and release on the (moved) border with no motion focuses the pane under it.
    const [left, right] = (await panes(d)).map((p) => p.id);
    expect(await focused(d)).toBe(left);
    keys(a, `\x1b[<0;${col + 6};${row + 1}M`, `\x1b[<0;${col + 6};${row + 1}m`);
    await settle(a);
    expect(await focused(d)).toBe(right);
    a.att.detach();
    await a.att.closed;
  }, 20_000);
});

describe("pane ops and layouts over the control plane", () => {
  test("pane move to a new tab keeps the id; a pane name shows in its title", async () => {
    serve();
    const d = await hub();
    const a = await client(d);
    await a.until((f) => text(f).includes("▶ scout"));
    await cmd(d, "split-window", "-h");
    const moved = (await panes(d))[1]!.id;
    expect((await cmd(d, "pane", "move", moved, "--new-tab", "-n", "side")).data).toMatchObject({ pane: moved, from: moved, tab: "s1:t2" });
    expect((await panes(d)).find((p) => p.id === moved)).toMatchObject({ tab: "s1:t2", focused: true });
    await cmd(d, "pane", "rename", moved, "builder");
    await a.until((f) => text(f).includes("▶ builder · scout"));
    expect((await callHub(d, ["pane", "move", moved, "--new-tab"])).body).toMatchObject({ error: "last_pane" });
    a.att.detach();
    await a.att.closed;
  }, 20_000);

  test("a saved three-column tab applies to a new tab as the same tree; the cycle key comes back to the start", async () => {
    serve();
    const d = await hub();
    const a = await client(d);
    await a.until((f) => text(f).includes("▶ scout"));
    await cmd(d, "layout", "apply", "columns-3");
    expect((await cmd(d, "layout", "save", "three")).data).toMatchObject({ saved: "three", panes: 5 });
    await cmd(d, "tab", "create");
    await cmd(d, "layout", "apply", "three", "-t", "s1:t2");
    const t1 = (await cmd(d, "layout", "tree", "-t", "s1:t1")).data as { tree: unknown };
    const t2 = (await cmd(d, "layout", "tree", "-t", "s1:t2")).data as { tree: unknown };
    expect(t2.tree).toEqual(t1.tree);
    const all = await panes(d);
    expect(all.filter((p) => p.tab === "s1:t1")).toHaveLength(5);
    expect(all.filter((p) => p.tab === "s1:t2").map((p) => p.deck)).toEqual(all.filter((p) => p.tab === "s1:t1").map((p) => p.deck));

    const listed = (await cmd(d, "layout", "list")).data as { name: string; error?: string }[]; // layout list's reply shape
    const names = listed.filter((l) => !l.error).map((l) => l.name);
    let cur: string | undefined = "three";
    for (let i = 0; i < names.length; i++) {
      cur = nextLayoutName(names, cur)!;
      keys(a, "\x02", " ");
      await a.until((f) => text(f).includes(`layout → ${cur} (`));
    }
    expect(cur).toBe("three");
    const back = (await cmd(d, "layout", "tree", "-t", "s1:t2")).data as { tree: unknown }; // layout tree's reply shape
    expect(back.tree).toEqual(t1.tree);
    a.att.detach();
    await a.att.closed;
  }, 30_000);

  test("a name slot waits, then fills when a matching lane is spawned", async () => {
    const isDeck = (x: string): x is PaneDeck => DECKS.some((k) => k.id === x);
    new LayoutLibrary(data, isDeck).write({ v: 1, name: "web", tree: { dir: "v", ratio: 0.5, a: { deck: "fleet" }, b: { deck: "agent", slot: { by: "name", pattern: "web-*" } } } });
    serve();
    const d = await hub();
    expect((await cmd(d, "layout", "apply", "web")).data).toMatchObject({ applied: "web", waiting: 1 });
    const slotPane = (await panes(d))[1]!;
    expect(slotPane).toMatchObject({ deck: "agent", slot: { by: "name", pattern: "web-*" } });
    lanes = [...lanes, { id: "lane_2", name: "web-a", status: "idle", model: "m" }];
    for (;;) {
      const now = (await panes(d)).find((p) => p.id === slotPane.id);
      if (now?.lane === "lane_2") break;
      await nextEngineRequest(); // the server's own poll brings the new lane
    }
    expect((await panes(d)).find((p) => p.id === slotPane.id)?.slot).toBeUndefined();
  }, 20_000);

  test("layout export and import are refused over the control plane; a cwd-bearing layout is refused", async () => {
    serve();
    const d = await hub();
    expect((await callHub(d, ["layout", "export", "solo", join(data, "x.json")])).body).toMatchObject({ error: "shell_only" });
    expect((await callHub(d, ["layout", "import", join(data, "x.json")])).body).toMatchObject({ error: "shell_only" });
    writeFileSync(join(data, "hub-layouts", "evil.json"), JSON.stringify({ v: 1, name: "evil", tree: { deck: "overview" }, cwd: "C:/" }));
    expect((await callHub(d, ["layout", "apply", "evil"])).body).toMatchObject({ error: "layout_invalid" });
  }, 20_000);
});
