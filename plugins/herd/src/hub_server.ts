// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0541; P-HERD.1, ADR-0490 items 1 to 6): the hub SERVER. One process owns what dies with
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
import { HubOpError, Spaces, type PaneDeck } from "../../../harness/launcher/hub_spaces.ts";
import { parseHubCommand } from "../../../harness/launcher/hub_tmux_verbs.ts";
import { attachOrSpawnEngine, DECKS, HubComponent, type AttachedEngine } from "../../../harness/launcher/hub_tui.ts";
import { HerdAttention, MAIN_TARGET, type HerdAlert } from "./attention.ts";
import { MachineSet, machinesPath } from "./engines.ts";
import { engineFeedDeps, LaneFeed, REAL_TIMERS } from "./events.ts";
import { classicSeed, connectInstance, herdDataDir, instanceName, instancePaths, LayoutStore } from "./instance.ts";
import { HerdInput } from "./herd_input.ts";
import { KeysFile, loadKeysConfig, notifySettings } from "./keys.ts";
import { LayoutLibrary } from "./layouts.ts";
import { MainPane } from "./main_pane.ts";
import { herdWaitCommands } from "./waits.ts";

export type HubServerMsg =
  | { t: "frame"; lines: string[] }
  | { t: "lanes"; lanes: { id: string; name: string; status: string }[] }
  | { t: "bye"; reason: "detached" | "stopped" }
  | { t: "yank"; text: string } // P-HERD.3 (ADR-0492 item 5): copy mode's yank, to the yanking client only
  | HerdAlert; // P-HERD.5 (ADR-0494): BEL and/or a desktop notification, lane name and status only

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

/** The classic decks plus Main (P-HERD.6), which only a Herd server draws. */
const isDeck = (d: string): boolean => d === "main" || DECKS.some((x) => x.id === d);
/** P-HERD.2: the same answer, narrowing for the layout parser. */
const isPaneDeck = (d: string): d is PaneDeck => isDeck(d);

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
    const cols = size().cols;
    const body = JSON.stringify({ t: "frame", lines: [...keys.decorate(component.render(cols), cols)] } satisfies HubServerMsg);
    for (const c of clients.values()) if (c.last !== body) { c.last = body; try { c.sock.send(body); } catch { /* closing */ } }
  };
  const schedule = () => { timer ??= setTimeout(flush, FRAME_MS); };
  // P-HERD.4/5 (ADR-0493, ADR-0494): every redraw request re-marks seen lanes and re-checks
  // `pane wait-output` waits, so neither runs on a timer of its own.
  const redrawn = new Set<() => void>();
  const ui = { requestRender: () => { schedule(); for (const fn of [...redrawn]) fn(); }, terminal: { get rows() { return size().rows; } } };

  const stop = () => {
    if (stopping) return;
    stopping = true;
    // Let the /cmd reply that asked for this leave first; run() then ends and the finally below runs.
    setTimeout(() => component.quit(), 50);
  };
  // ---- P-HERD.6 and P-HERD.7 (ADR-0495, ADR-0496): the Main pane and the other machines ----
  const mainPane = new MainPane({ base: `http://127.0.0.1:${attached.engine.port}`, token: attached.engine.token }, { changed: () => ui.requestRender() });
  const machines = new MachineSet(machinesPath(data, name), attached.engine, {
    onChange: () => ui.requestRender(),
    annotate: (lane) => attention.annotate(lane),
  });
  // ---- P-HERD.2 and P-HERD.3 (ADR-0491, ADR-0492): layouts and the key model ----
  const keysFile = new KeysFile(data);
  const keysProblem = keysFile.current().cfg.problems[0];
  const library = new LayoutLibrary(data, isPaneDeck);
  library.writeBuiltins();
  const component = new HubComponent(ui, attached.engine, {
    commands: (argv) => keys.command(argv, "prompt") ?? commands(argv), // P-HERD.2: `:layout ...`
    palette: { items: () => keys.paletteItems(), act: (id) => keys.paletteAct(id) }, // P-HERD.2
    hostDeck: mainPane,
    machines: () => machines.railGroups(),
    spawned: attached.spawned,
    spaces,
    prioritiesPath: paths.priorities,
    server: { name, clients: () => clients.size },
    detach: () => { if (typing) bye(typing, "detached"); },
    notice: restored ? `layout file did not parse: restored ${restored}` : seed ? "started from the classic hub's layout (read only)" : keysProblem === undefined ? undefined : `hub-keys.json: ${keysProblem}`,
    attention: (laneId) => attention.attention(laneId), // P-HERD.5: rail order, hues, ◎ badges
    onFleet: (lanes) => {
      // ADR-0490 item 5: a pane whose lane came back under a new id follows it by name.
      spaces.relinkLanes(lanes.flatMap((l) => (typeof l.id === "string" ? [{ id: l.id, name: typeof l.name === "string" ? l.name : "" }] : [])));
      keys.fillSlots(); // P-HERD.2: a waiting layout pane takes its lane once it is there
      feed.snapshot(lanes); // P-HERD.4: new lanes get their watch streams
      attention.update(lanes); // P-HERD.5: seen, needs-you, alerts
      mainPane.setLanes(lanes); // P-HERD.6: Main's spokes count
      machines.setLocalLanes(lanes); // P-HERD.7: this engine's rows in the combined list
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

  // P-HERD.3 (ADR-0492): a client's bytes meet the prefix, the modes and the drags before the keymap.
  const keys = new HerdInput({
    component,
    library,
    keys: keysFile,
    size,
    detach: (id) => { const c = clients.get(id); if (c) bye(c.sock, "detached"); },
    yank: (id, text) => { try { clients.get(id)?.sock.send(JSON.stringify({ t: "yank", text } satisfies HubServerMsg)); } catch { /* closing */ } },
    forward: (data) => component.handleInput(data),
    render: schedule,
    mainReady: () => isDeck("main"),
  });
  keys.register("next", () => attention.focusNext()); // P-HERD.5 (ADR-0494): prefix+a

  /** The verbs this server owns ahead of the hub parser. Nothing here reaches an approval route. */
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
    // P-HERD.2 / P-HERD.3 (ADR-0491, ADR-0492): layouts, directional and cell-sized pane ops, move,
    // rename. Over /cmd, layout export and import refuse (they name files; the shell runs them).
    const herdVerb = keys.command(argv, "control");
    if (herdVerb) return herdVerb;
    // P-HERD.5 (ADR-0494): `:next` and `lucid herd next`, the same jump as prefix+a.
    if (verb === "next" && sub === undefined) return attention.focusNext().then((message) => ({ message }));
    // P-HERD.6 (ADR-0495): `main prompt` rides /api/chat as a typed prompt; `session open --as main`
    // loads through /api/session/load. Neither reaches /api/chat/permission: that is a client key.
    if (verb === "main") return mainPane.mainCommand(argv);
    if (verb === "session") return mainPane.sessionCommand(argv, (op) => component.exec(op));
    // P-HERD.7 (ADR-0496): machines, and the agent verbs across them (`<machine>/<lane>`, --machine).
    if (verb === "machine") return Promise.resolve(machines.machineCommand(argv));
    return machines.command(argv, (op) => component.exec(op));
  };

  // ---- P-HERD.4 and P-HERD.5 (ADR-0493, ADR-0494): the lane feed, attention, waits and events ----
  const feed = new LaneFeed(engineFeedDeps({ base: `http://127.0.0.1:${attached.engine.port}`, token: attached.engine.token }));
  const attention = new HerdAttention({
    focused: () => {
      const { leaf } = spaces.pane();
      return leaf.deck === "main" ? MAIN_TARGET : leaf.deck === "agent" && leaf.lane ? leaf.lane : null;
    },
    clients: () => clients.size,
    show: async (id, laneName) => {
      const shown = spaces.paneList({}).find((p) => p.lane === id);
      if (shown) spaces.focusPane(shown.id);
      else spaces.rebind(undefined, "agent", { id, name: laneName }); // the ADR-0420 bind
      await component.refresh();
    },
    alert: (a) => {
      const body = JSON.stringify(a satisfies HubServerMsg);
      for (const c of clients.values()) { try { c.sock.send(body); } catch { /* closing */ } }
    },
    settings: () => notifySettings(loadKeysConfig(data)),
    now: Date.now,
    // P-HERD.6: prefix+a counts Main's parked ask and jumps to a Main pane (else puts Main in this one).
    main: {
      ask: () => mainPane.ask(),
      show: async () => {
        const shown = spaces.paneList({}).find((p) => p.deck === "main");
        if (shown) spaces.focusPane(shown.id);
        else spaces.rebind(undefined, "main");
        ui.requestRender();
      },
    },
  });
  redrawn.add(() => attention.touch());
  // /cmd only, ahead of every other verb: the `:` prompt never reaches waits or the event stream.
  const herdWaits = herdWaitCommands({
    feed,
    attention,
    run: (argv) => commands(argv) ?? component.exec(parseHubCommand(argv)),
    paneDeck: (ref) => spaces.pane(ref).leaf.deck,
    paneLines: (ref, width, lines) => component.paneText(ref, width, lines).lines,
    onChange: (fn) => {
      redrawn.add(fn);
      return () => { redrawn.delete(fn); };
    },
    timers: REAL_TIMERS,
    now: Date.now,
  });

  // P-HERD.2 (ADR-0491 item 3): the first tab of a fresh instance opens on the `solo` preset.
  if (!loaded && !seed) void keys.command(["layout", "apply", "solo"], "control");

  const control = startHubControl({
    dir: paths.run,
    exec: (op) => component.exec(op),
    commands: (argv) => herdWaits(argv) ?? commands(argv),
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
          try { if (!keys.input(m.data, c.id)) component.handleInput(m.data); } finally { typing = null; }
          schedule();
        } else if (m.t === "resize" && "cols" in m && "rows" in m && typeof m.cols === "number" && typeof m.rows === "number" && Number.isInteger(m.cols) && Number.isInteger(m.rows)) {
          c.cols = Math.min(2000, Math.max(20, m.cols));
          c.rows = Math.min(2000, Math.max(5, m.rows));
          schedule();
        } else if (m.t === "detach") bye(c, "detached");
      },
      close(c) {
        clients.delete(c.id);
        keys.forget(c.id); // P-HERD.3: its half-typed prefix and any drag go with it
        schedule(); // the smallest size may have grown, and the attached count changed
      },
    },
  });

  mainPane.start();
  machines.start();
  const done = (async () => {
    try {
      await component.run();
    } finally {
      stopping = true;
      for (const c of clients.values()) bye(c.sock, "stopped");
      clearTimeout(timer);
      feed.close(); // every lane's watch stream
      mainPane.stop(); // its poll and the turn it observes
      machines.stop(); // every machine's own clock
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
