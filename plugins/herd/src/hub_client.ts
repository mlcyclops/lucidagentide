// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0535; P-HERD.1, ADR-0490 items 2 and 3): the terminal CLIENT. Bare `lucid herd [--name
// <name>]` attaches this terminal to the newest verified server of that instance, or starts one
// (detached, so it outlives this terminal) and attaches. The client is a thin pi-tui view: it draws
// the frames the server streams, forwards every key, paste and click as raw bytes to the server's ONE
// keymap, reports its terminal size, and writes the fleet's OSC 7501 records (ADR-0530) to its own
// terminal. Q (and q, ctrl+c) detaches; closing the terminal detaches too. The server, its engine and
// every lane keep running.
//
// The client finds the server through run/<name>/hub-discovery-<pid>.json in the add-on data dir and
// wins the nonce handshake (connectHub) before the hub token goes anywhere. It holds that token only,
// never the engine UI token: every engine call happens in the server.

import { closeSync, mkdirSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { ProcessTerminal, TUI, truncateToWidth, type Component } from "@oh-my-pi/pi-tui";
import type { HubDiscovery } from "../../../harness/launcher/hub_control.ts";
import { HubOpError } from "../../../harness/launcher/hub_spaces.ts";
import { programStatusEnabled, ProgramStatusEmitter } from "./hub_program_status.ts";
import type { HubClientMsg, HubServerMsg } from "./hub_server.ts";
import { connectInstance, herdDataDir, instanceName, instancePaths } from "./instance.ts";

type Env = Readonly<Record<string, string | undefined>>;

export type HubDetachReason = "detached" | "stopped" | "lost";

export interface HubAttachment {
  /** Raw terminal input, exactly as the terminal sent it. */
  send(data: string): void;
  resize(cols: number, rows: number): void;
  /** Leave the server running and end this attachment. */
  detach(): void;
  /** Settles when the stream ends: "detached" (Q, or detach()), "stopped" (server stop), "lost"
   *  (the socket dropped without a goodbye). */
  readonly closed: Promise<HubDetachReason>;
}

const KEEPALIVE_MS = 30_000;

/** Attach to a server that already WON the handshake (connectInstance). Resolves once the stream is
 *  open; rejects when the server refuses the upgrade. */
export function attachHub(d: HubDiscovery, opts: { cols: number; rows: number; onFrame(lines: string[]): void; onLanes?(lanes: Record<string, unknown>[]): void }): Promise<HubAttachment> {
  const ws = new WebSocket(`ws://127.0.0.1:${d.port}/attach?cols=${opts.cols}&rows=${opts.rows}`, { headers: { "x-lucid-hub-token": d.token } });
  const closed = Promise.withResolvers<HubDetachReason>();
  const opened = Promise.withResolvers<HubAttachment>();
  let reason: HubDetachReason = "lost";
  let isOpen = false;
  const post = (m: HubClientMsg) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
  const keepalive = setInterval(() => post({ t: "ping" }), KEEPALIVE_MS);
  const attachment: HubAttachment = {
    send: (data) => post({ t: "input", data }),
    resize: (cols, rows) => post({ t: "resize", cols, rows }),
    detach: () => { if (ws.readyState === WebSocket.OPEN) post({ t: "detach" }); else { reason = "detached"; ws.close(); } },
    closed: closed.promise,
  };
  ws.onopen = () => { isOpen = true; opened.resolve(attachment); };
  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") return;
    // The server is the one this client proved with the nonce handshake; its messages are HubServerMsg.
    let m: HubServerMsg;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === "frame" && Array.isArray(m.lines)) opts.onFrame(m.lines);
    else if (m.t === "lanes" && Array.isArray(m.lanes)) opts.onLanes?.(m.lanes);
    else if (m.t === "bye") reason = m.reason === "stopped" ? "stopped" : "detached";
  };
  ws.onclose = () => {
    clearInterval(keepalive);
    if (!isOpen) opened.reject(new Error("the hub refused the attach"));
    closed.resolve(reason);
  };
  return opened.promise;
}

const SERVER_START_MS = 60_000; // an engine spawn alone may take 45s (attachOrSpawnEngine)

/** Start a DETACHED server for instance `name` (its own process group, no terminal, so closing this
 *  one does not end it) by running `entry server start --name <name>` with this bun, and wait for it
 *  to win the handshake. Its output goes to hub-<name>-server.log (0600) in the add-on data dir. */
async function startServer(env: Env, entry: string, data: string, name: string): Promise<{ hub: HubDiscovery | null; log: string }> {
  mkdirSync(data, { recursive: true });
  const { log } = instancePaths(data, name);
  const fd = openSync(log, "w", 0o600);
  // Frames are rendered in the server, which has no terminal to detect colors from: it renders at
  // THIS terminal's level. The marker tells the server not to hand the forced level to its engine.
  const color = env.FORCE_COLOR === undefined ? { FORCE_COLOR: String(chalk.level), LUCID_HUB_FORCED_COLOR: "1" } : {};
  let exited = false;
  try {
    const child = spawn(process.execPath, [entry, "server", "start", "--name", name], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
      env: { ...env, ...color, LUCID_PLUGIN_DATA: data },
    });
    child.on("exit", () => { exited = true; });
    child.on("error", () => { exited = true; });
    child.unref();
  } finally { closeSync(fd); }
  const deadline = Date.now() + SERVER_START_MS;
  while (Date.now() < deadline && !exited) {
    const hub = await connectInstance(data, name);
    if (hub) return { hub, log };
    await Bun.sleep(250);
  }
  return { hub: await connectInstance(data, name), log };
}

/** Bare `lucid herd [--name <name>]`: attach this terminal, or start the server first. `entry` is the
 *  script that runs `server start` (client.js when installed). */
export async function runHubClient(env: Env, opts: { name?: string; entry: string }): Promise<number> {
  let name: string;
  try { name = instanceName(opts.name); } catch (e) {
    if (e instanceof HubOpError) { process.stderr.write(JSON.stringify({ error: e.code, message: e.message }) + "\n"); return 1; }
    throw e;
  }
  const data = herdDataDir(env);
  const again = name === "main" ? "lucid herd" : `lucid herd --name ${name}`;
  let hub = await connectInstance(data, name);
  if (!hub) {
    process.stderr.write(`[herd] starting Herd instance "${name}" (it keeps running after this terminal closes; \`lucid herd server stop${name === "main" ? "" : ` --name ${name}`}\` ends it)...\n`);
    const started = await startServer(env, opts.entry, data, name);
    hub = started.hub;
    if (!hub) {
      process.stderr.write(`[herd] the Herd server did not come up; see ${started.log}\n`);
      return 1;
    }
  }
  const tui = new TUI(new ProcessTerminal());
  // P-HERD-OSC.1 (ADR-0530): the fleet's records go to THIS terminal, through the same writer as the
  // frames; a real TTY only, and LUCID_PROGRAM_STATUS=0 turns it off.
  const status = programStatusEnabled(env, process.stdout.isTTY === true) ? new ProgramStatusEmitter((bytes) => tui.terminal.write(bytes)) : null;
  let frame: readonly string[] = [];
  let out: readonly string[] = [];
  let drawn = { frame, width: 0, rows: 0 };
  let att: HubAttachment | null = null;
  let sent = { cols: tui.terminal.columns, rows: tui.terminal.rows };
  const view: Component = {
    render(width: number): readonly string[] {
      const rows = tui.terminal.rows;
      if (att && (width !== sent.cols || rows !== sent.rows)) { sent = { cols: width, rows }; att.resize(width, rows); }
      if (drawn.frame !== frame || drawn.width !== width || drawn.rows !== rows) {
        // The server renders at the smallest attached size, so a frame is never wider than this
        // terminal, except for the moment between a shrink and the server's next frame.
        out = frame.slice(0, rows).map((l) => (Bun.stringWidth(l) > width ? truncateToWidth(l, width) : l));
        drawn = { frame, width, rows };
      }
      return out;
    },
    handleInput(data: string): void { att?.send(data); },
  };
  try {
    att = await attachHub(hub, {
      cols: Math.max(20, sent.cols),
      rows: Math.max(5, sent.rows),
      onFrame: (lines) => { frame = lines; tui.requestRender(); },
      onLanes: status ? (lanes) => status.update(lanes) : undefined,
    });
  } catch (e) {
    process.stderr.write(`[herd] could not attach to Herd instance "${name}": ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  const leave = () => att?.detach();
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, leave);
  // mouseTracking: pi-tui turns SGR click reporting on while this fullscreen overlay holds the screen
  // and off again on hide/stop, so the parent shell gets its native selection back on detach.
  const overlay = tui.showOverlay(view, { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0, fullscreen: true, mouseTracking: true });
  tui.setFocus(view);
  tui.start();
  let reason: HubDetachReason;
  try {
    reason = await att.closed;
  } finally {
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.off(sig, leave);
    status?.clear();
    overlay.hide();
    tui.stop();
  }
  process.stderr.write(
    reason === "detached" ? `[herd] detached from "${name}"; it is still running. Reattach: ${again}\n`
    : reason === "stopped" ? `[herd] Herd instance "${name}" stopped.\n`
    : `[herd] lost the connection to Herd instance "${name}". Reattach: ${again}\n`,
  );
  return reason === "lost" ? 1 : 0;
}
