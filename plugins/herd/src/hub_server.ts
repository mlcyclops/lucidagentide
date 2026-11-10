// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0535; P-HERD.1, ADR-0490 items 1 to 6): the hub SERVER. One process owns what dies with
// the terminal in the classic `lucid hub`: the Spaces model and its layout file, the engine
// attachment (and the engine it spawned, ADR-0420), the per-lane /api/fleet/watch streams, the poll,
// and the control plane. TUI CLIENTS (hub_client.ts) attach over the control server's /attach
// WebSocket (hub_control.ts `attach`), tmux and Herdr style:
//
//   server -> client  {t:"frame",lines}  the whole hub as rendered, every row one physical line
//                     {t:"lanes",lanes}  {id,name,status} per lane, for the client's own OSC 7501
//                     {t:"bye",reason}   "detached" (that client's q/Q) or "stopped" (server stop)
//   client -> server  {t:"input",data}   raw terminal input: keys, pastes, SGR mouse reports
//                     {t:"resize",cols,rows}
//                     {t:"detach"}  {t:"ping"} (keepalive)
//
// There is ONE keymap and ONE executor: a client's bytes go to the same HubComponent.handleInput the
// classic hub uses, so the `:` prompt, the palette, clicks and every deck key mean the same thing from
// any client. Layout, focus, zoom and the open overlay are server state; every client sees the same
// frame, rendered at the SMALLEST attached size so no client sees a cropped pane. Per-client focus is
// out of scope (ADR-0490 item 3).
//
// Lifetime: q, Q and ctrl+c DETACH the client whose key it was; the server, its engine and every lane
// stay up. Only `lucid herd server stop` (the `server stop` verb over /cmd, which this server owns
// through the control plane's `commands` seam, or SIGTERM/SIGINT to a foreground `server start`) ends
// it: clients get "stopped", the layout is saved, a spawned engine is stopped and awaited, and only
// then does the discovery file go, so "the hub answers no more" means its engine is down too. An
// engine the server only attached to is never touched.
//
// Security (ADR-0490 item 6): the client holds the hub token only; the engine UI token never leaves
// this process. The human-only keys (a, i, y, s, d) act only through an attached client's keystrokes,
// never through /cmd, whose parser has no op for them and whose send-keys reaches agent composers only.

import { discoveryDir } from "../../../desktop/engine_discovery.ts";
import { startHubControl, type HubClientSocket, type HubControl } from "../../../harness/launcher/hub_control.ts";
import { HubOpError, Spaces } from "../../../harness/launcher/hub_spaces.ts";
import { attachOrSpawnEngine, DECKS, HubComponent, type AttachedEngine } from "../../../harness/launcher/hub_tui.ts";
import { classicSeed, connectInstance, herdDataDir, instanceName, instancePaths, LayoutStore } from "./instance.ts";

export type HubServerMsg =
  | { t: "frame"; lines: string[] }
  | { t: "lanes"; lanes: { id: string; name: string; status: string }[] }
  | { t: "bye"; reason: "detached" | "stopped" };

export type HubClientMsg =
  | { t: "input"; data: string }
  | { t: "resize"; cols: number; rows: number }
  | { t: "detach" }
  | { t: "ping" };

/** The size a server renders at with nobody attached (a /cmd `pane read` still works). */
const IDLE_SIZE = { cols: 120, rows: 40 };
const MAX_INPUT = 64 * 1024;
const FRAME_MS = 16;

type Env = Readonly<Record<string, string | undefined>>;

const isDeck = (d: string): boolean => DECKS.some((x) => x.id === d);

/** The smallest attached terminal (tmux and Herdr style), or IDLE_SIZE with nobody attached. */
export function renderSize(clients: Iterable<{ cols: number; rows: number }>): { cols: number; rows: number } {
  let cols = Infinity;
  let rows = Infinity;
  for (const c of clients) { cols = Math.min(cols, c.cols); rows = Math.min(rows, c.rows); }
  return cols === Infinity ? IDLE_SIZE : { cols, rows };
}

export interface HubServer {
  readonly name: string;
  readonly control: HubControl;
  readonly component: HubComponent;
  /** Where the layout came from when the layout file itself did not parse (null = it did). */
  readonly restored: string | null;
  /** True when instance main began from the classic hub's layout (read only). */
  readonly seeded: boolean;
  clients(): number;
  /** Ask the server to stop; `done` settles once it has. */
  stop(): void;
  readonly done: Promise<void>;
}

/** Start a server for instance `name` on an engine that is already attached (attachOrSpawnEngine).
 *  `data` is the add-on's data dir; `classic` the classic hub's data root, read once to seed main. */
export function startHubServer(opts: { data: string; classic: string | null; name?: string; attached: AttachedEngine }): HubServer {
  const { data, attached } = opts;
  const name = instanceName(opts.name);
  const paths = instancePaths(data, name);
  const store = new LayoutStore(paths.spaces, paths.snapshots);
  const { spaces: loaded, restored } = store.load(isDeck);
  const seed = loaded ? null : classicSeed(store, name, opts.classic, isDeck);
  const spaces = loaded ?? seed ?? new Spaces();
  spaces.onChange = () => store.save(spaces);
  if (restored || seed) spaces.onChange(); // the instance's own file parses from here on

  const clients = new Map<number, { sock: HubClientSocket; last: string }>();
  let typing: HubClientSocket | null = null; // whose input handleInput is running for right now
  let lanesMsg = "";
  let timer: NodeJS.Timeout | undefined;
  let stopping = false;

  const bye = (c: HubClientSocket, reason: "detached" | "stopped") => {
    try { c.send(JSON.stringify({ t: "bye", reason } satisfies HubServerMsg)); c.close(1000, reason); } catch { /* already gone */ }
  };
  const size = () => renderSize([...clients.values()].map((c) => c.sock));
  const flush = () => {
    timer = undefined;
    if (clients.size === 0) return;
    const body = JSON.stringify({ t: "frame", lines: [...component.render(size().cols)] } satisfies HubServerMsg);
    for (const c of clients.values()) if (c.last !== body) { c.last = body; try { c.sock.send(body); } catch { /* closing */ } }
  };
  const schedule = () => { timer ??= setTimeout(flush, FRAME_MS); };
  const ui = { requestRender: schedule, terminal: { get rows() { return size().rows; } } };

  const stop = () => {
    if (stopping) return;
    stopping = true;
    // Let the /cmd reply that asked for this leave first; run() then ends and the finally below runs.
    setTimeout(() => component.quit(), 50);
  };
  const component = new HubComponent(ui, attached.engine, {
    spawned: attached.spawned,
    spaces,
    prioritiesPath: paths.priorities,
    server: { name, clients: () => clients.size },
    detach: () => { if (typing) bye(typing, "detached"); },
    notice: restored ? `layout file did not parse: restored ${restored}` : seed ? "started from the classic hub's layout (read only)" : undefined,
    onFleet: (lanes) => {
      // ADR-0490 item 5: a pane whose lane came back under a new id follows it by name.
      spaces.relinkLanes(lanes.flatMap((l) => (typeof l.id === "string" ? [{ id: l.id, name: typeof l.name === "string" ? l.name : "" }] : [])));
      const body = JSON.stringify({
        t: "lanes",
        lanes: lanes.map((l) => ({ id: String(l.id ?? ""), name: String(l.name ?? ""), status: String(l.status ?? "") })),
      } satisfies HubServerMsg);
      if (body === lanesMsg) return;
      lanesMsg = body;
      for (const c of clients.values()) {
        try { c.sock.send(body); } catch { /* closing */ }
      }
    },
  });

  /** The verbs this server owns ahead of the hub parser. Nothing here reaches an engine route. */
  const commands = (argv: readonly string[]): Promise<unknown> | undefined => {
    const [verb, sub, ...rest] = argv;
    if (verb === "server" && sub === "stop" && rest.length === 0) {
      stop();
      return Promise.resolve({ stopping: name, pid: process.pid });
    }
    if (verb === "server") throw new HubOpError("usage", "server list|start run from the shell (lucid herd server list|start); a running server only answers `server stop`");
    if (verb === "status" && sub === undefined) {
      return component.exec({ op: "status" }).then((s) => ({ ...(typeof s === "object" && s !== null ? s : {}), hub: { pid: process.pid, name, clients: clients.size } }));
    }
    return undefined;
  };

  const control = startHubControl({
    dir: paths.run,
    exec: (op) => component.exec(op),
    commands,
    attach: {
      open(c) {
        if (stopping) { bye(c, "stopped"); return; }
        clients.set(c.id, { sock: c, last: "" });
        if (lanesMsg) c.send(lanesMsg);
        schedule();
      },
      message(c, raw) {
        let m: unknown;
        try { m = JSON.parse(raw); } catch { return; }
        if (typeof m !== "object" || m === null || !("t" in m)) return;
        if (m.t === "input" && "data" in m && typeof m.data === "string" && m.data.length <= MAX_INPUT) {
          typing = c;
          try { component.handleInput(m.data); } finally { typing = null; }
          schedule();
        } else if (m.t === "resize" && "cols" in m && "rows" in m && typeof m.cols === "number" && typeof m.rows === "number" && Number.isInteger(m.cols) && Number.isInteger(m.rows)) {
          c.cols = Math.min(2000, Math.max(20, m.cols));
          c.rows = Math.min(2000, Math.max(5, m.rows));
          schedule();
        } else if (m.t === "detach") bye(c, "detached");
      },
      close(c) {
        clients.delete(c.id);
        schedule(); // the smallest size may have grown, and the attached count changed
      },
    },
  });

  const done = (async () => {
    try {
      await component.run();
    } finally {
      stopping = true;
      for (const c of clients.values()) bye(c.sock, "stopped");
      clearTimeout(timer);
      component.dispose();
      spaces.onChange(); // focus and zoom moves are not structural; this is when they persist
      if (attached.child) { try { attached.child.kill("SIGTERM"); } catch { /* gone */ } await attached.child.exited; }
      await Bun.sleep(50); // the "stopped" goodbyes flush before the sockets are cut
      control.stop();
    }
  })();

  return { name, control, component, restored, seeded: seed !== null, clients: () => clients.size, stop, done };
}

const fail = (body: Record<string, unknown>): number => {
  process.stderr.write(JSON.stringify(body) + "\n");
  return 1;
};

/** `lucid herd server start [--name]`: attach or spawn the engine, serve until stopped. One server
 *  per instance name: a second start of a running name is refused. An engine is spawned only from the
 *  checkout `lucid herd` names (LUCID_HERD_REPO); the plugin runtime passes none, so there it attaches
 *  to the IDE's own engine or fails. */
export async function runHubServer(env: Env, opts: { name?: string } = {}): Promise<number> {
  let name: string;
  try { name = instanceName(opts.name); } catch (e) {
    if (e instanceof HubOpError) return fail({ error: e.code, message: e.message });
    throw e;
  }
  const data = herdDataDir(env);
  const running = await connectInstance(data, name);
  if (running) return fail({ error: "hub_running", message: `Herd instance "${name}" is already running (pid ${running.pid}); attach with \`lucid herd${name === "main" ? "" : ` --name ${name}`}\`` });
  // A client that started this server forced its own color level for the frames (hub_client.ts);
  // that is the server's rendering business, not the engine's or its lanes'.
  const engineEnv = { ...env };
  if (env.LUCID_HUB_FORCED_COLOR === "1") { delete engineEnv.FORCE_COLOR; delete engineEnv.LUCID_HUB_FORCED_COLOR; }
  const attached = await attachOrSpawnEngine(engineEnv, env.LUCID_HERD_REPO || null);
  if (!attached) return fail({ error: "no_engine", message: env.LUCID_HERD_REPO ? "none running, and spawning one failed (port busy or missing deps); try `bun desktop/dev.ts` to see why" : "no LUCID engine is running; open the IDE, or start Herd with `lucid herd`" });
  const hub = startHubServer({ data, classic: discoveryDir(env), name, attached });
  const quit = () => hub.stop();
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, quit);
  process.stdout.write(JSON.stringify({ herd: "ready", name, pid: process.pid, port: hub.control.discovery.port, engine: attached.engine.port, spawnedEngine: attached.spawned }) + "\n");
  try { await hub.done; } finally {
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.off(sig, quit);
  }
  return 0;
}
