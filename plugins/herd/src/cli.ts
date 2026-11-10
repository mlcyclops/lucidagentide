// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0541): what `lucid herd [--name <name>] <args>` means once core has handed argv to the
// installed add-on's client.js.
//   (bare)          attach this terminal to instance <name> (default `main`), starting its server
//                   first when none runs (hub_client.ts). Q detaches; the server stays up.
//   server start    run the server for <name> in this process until stopped.
//   server stop     end the server: clients detach, a spawned engine stops with it.
//   server list     every instance with a verified server.
//   --help          this list.
//   anything else   a hub control command (the classic hub's grammar, hub_tmux_verbs.ts) sent to the
//                   RUNNING server of <name>.
// `--name <name>` leads (`lucid herd --name work split-window -h`); `server start|stop` also take it
// after the verb. Contract for scripts, as `lucid hub`: JSON on stdout and exit 0, or JSON
// {"error":code,"message"} on stderr and exit 1. No server running is {"error":"no_hub"}.

import { callHub, verifyHub, type HubDiscovery, type HubReply } from "../../../harness/launcher/hub_control.ts";
import { resolve } from "node:path";
import { HubOpError, type PaneDeck } from "../../../harness/launcher/hub_spaces.ts";
import { HUB_USAGE, parseHubCommand } from "../../../harness/launcher/hub_tmux_verbs.ts";
import { DECKS } from "../../../harness/launcher/hub_tui.ts";
import { streamHub } from "./events.ts";
import { defaultKeysJson } from "./keys.ts";
import { isFileLayoutOp, LAYOUT_USAGE, LayoutLibrary, parseLayoutCommand, runLayoutOp } from "./layouts.ts";
import { HERD_PANE_USAGE, parseHerdPaneCommand } from "./pane_verbs.ts";
import { runHubClient } from "./hub_client.ts";
import { runHubServer } from "./hub_server.ts";
import { connectInstance, DEFAULT_INSTANCE, herdDataDir, instanceName, liveInstances } from "./instance.ts";
import { finalReply, parseHerdVerb, type HerdVerb } from "./waits.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** The decks a Herd server draws (the classic ones and Main), for the shell-side layout parser. */
const cliIsDeck = (d: string): d is PaneDeck => d === "main" || DECKS.some((x) => x.id === d);

export const HERD_HELP =
  "lucid herd [--name <name>]               attach this terminal (starting the server if none runs); Q detaches\n" +
  "lucid herd server start|stop [--name n]  run the server here, or end it (a spawned engine stops with it)\n" +
  "lucid herd server list                   every running instance\n" +
  "lucid herd [--name <name>] <command>     drive the running server, as `lucid hub <command>`:\n" +
  `  ${HUB_USAGE.replace(/^lucid hub /, "")}\n` +
  "lucid herd main prompt <text> [--wait]   prompt Main as typed (refused agent_blocked while it waits on you)\n" +
  "lucid herd session list | open <id> [--as main|lane]   open as Main is refused busy while Main works\n" +
  "lucid herd machine list | add <name> --dir <discovery folder> | remove <name>   other engines on this box\n" +
  "  agent verbs take <machine>/<lane>; agent spawn|list take --machine <name>\n" +
  "lucid herd agent wait <lane> [--until <status>]... [--timeout <ms>]   block until the lane gets there\n" +
  "lucid herd agent prompt --wait [--until <status>]... [--timeout <ms>] <lane> <text>   refused agent_blocked on an open ask\n" +
  "lucid herd agent spawn ... --wait [--timeout <ms>]   return once the lane is ready\n" +
  "lucid herd agent events [--lane <lane>] [--since <cursor>]   NDJSON lane transitions until you stop it\n" +
  "lucid herd pane wait-output <pane> (--match <text> | --regex <re>) [--timeout <ms>]   on a deck pane\n" +
  "lucid herd next | notify <title> [--body <text>] [--lane <lane>]   jump to who needs you; a script's notification\n" +
  `lucid herd ${LAYOUT_USAGE}\n` +
  "  list, show, delete, export and import work on the files, server or no server; presets are read-only\n" +
  `lucid herd ${HERD_PANE_USAGE}\n` +
  "lucid herd --default-keys                 print the default hub-keys.json (prefix ctrl+b, then one key)\n" +
  "Herd is an optional free add-on (Plugins, Free, Herd); the classic `lucid hub` is unchanged.\n";

const fail = (body: Record<string, unknown>): number => {
  process.stderr.write(JSON.stringify(body) + "\n");
  return 1;
};

/** `--name <name>` before the verb, or after `server start|stop`; the rest of argv without it. */
export function splitName(argv: readonly string[]): { name: string; rest: string[] } {
  let rest = [...argv];
  let raw: string | undefined;
  if (rest[0] === "--name") {
    if (rest[1] === undefined) throw new HubOpError("usage", "--name needs an instance name");
    raw = rest[1];
    rest = rest.slice(2);
  }
  if (rest[0] === "server" && rest[2] === "--name") {
    if (raw !== undefined) throw new HubOpError("usage", "--name given twice");
    if (rest[3] === undefined) throw new HubOpError("usage", "--name needs an instance name");
    raw = rest[3];
    rest = [rest[0], rest[1]!, ...rest.slice(4)];
  }
  return { name: instanceName(raw), rest };
}

/** First words only the Herd server knows (P-HERD.6 and P-HERD.7): the classic parser would refuse them. */
const HOST_ONLY_VERBS: Record<string, true> = { main: true, session: true, machine: true };
const STOP_WAIT_MS = 60_000; // a spawned engine is stopped and awaited before the server lets go

/** P-HERD.4 (ADR-0493): a reply that streams. `agent events` prints each transition as one NDJSON
 *  line until the server ends it; a wait prints its result once it settles. A failure is the usual
 *  JSON on stderr and exit 1. No deadline here: a wait lasts as long as its own --timeout. */
async function runStreamed(hub: HubDiscovery, argv: readonly string[], events: boolean): Promise<number> {
  const lines: string[] = [];
  try {
    await streamHub(hub, argv, (line) => {
      if (events && line.startsWith('{"ts":')) process.stdout.write(`${line}\n`);
      else lines.push(line);
    });
  } catch (e) {
    return fail({ error: "hub_unreachable", message: e instanceof Error ? e.message : String(e) });
  }
  const last = lines.at(-1) ?? null;
  if (events && last === null) return 0; // the server stopped: the stream simply ends
  const r = finalReply(last);
  if (!r.ok) return fail(r.body);
  process.stdout.write(JSON.stringify(r.data, null, 2) + "\n");
  return 0;
}

/** `entry` is the script a detached server runs (client.js when installed, process.argv[1]). */
export async function runHerdCli(argv: readonly string[], env: Env, entry: string): Promise<number> {
  let name: string;
  let rest: string[];
  try { ({ name, rest } = splitName(argv)); } catch (e) {
    if (e instanceof HubOpError) return fail({ error: e.code, message: e.message });
    throw e;
  }
  const named = name === DEFAULT_INSTANCE ? "" : ` --name ${name}`;
  if (rest.length === 0) return runHubClient(env, { name, entry });
  if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
    process.stdout.write(HERD_HELP);
    return 0;
  }
  if (rest.length === 1 && rest[0] === "--default-keys") {
    process.stdout.write(defaultKeysJson()); // P-HERD.3 (ADR-0492 item 3), as Herdr's --default-config
    return 0;
  }
  const data = herdDataDir(env);
  // P-HERD.2 / P-HERD.3 (ADR-0491, ADR-0492): the layout files are read and written right here (export
  // and import resolve their paths against this shell), with or without a server; save, apply and
  // tree, and Herd's pane verbs, go to the server past the classic parser.
  let herdOwn = false;
  try {
    const layout = parseLayoutCommand(rest);
    if (layout && isFileLayoutOp(layout)) {
      const op = layout.op === "layout.export" || layout.op === "layout.import" ? { ...layout, path: resolve(layout.path) } : layout;
      const result = runLayoutOp({ library: new LayoutLibrary(data, cliIsDeck), mainReady: () => true, lanes: () => [] }, op, "shell");
      process.stdout.write(JSON.stringify(result ?? null, null, 2) + "\n");
      return 0;
    }
    // P-HERD.6/7 (ADR-0495, ADR-0496): main, session and machine verbs, and `--machine`, are the server's own.
    herdOwn = layout !== null || parseHerdPaneCommand(rest) !== null || HOST_ONLY_VERBS[rest[0] ?? ""] === true || rest.includes("--machine");
  } catch (e) {
    if (e instanceof HubOpError) return fail({ error: e.code, message: e.message });
    throw e;
  }
  if (rest[0] === "server") {
    if (rest.length === 2 && rest[1] === "start") return runHubServer(env, { name });
    if (rest.length === 2 && rest[1] === "list") {
      process.stdout.write(JSON.stringify(await liveInstances(data), null, 2) + "\n");
      return 0;
    }
    if (!(rest.length === 2 && rest[1] === "stop")) return fail({ error: "usage", message: "server start|stop|list [--name <name>]" });
  }
  // P-HERD.4/5 (ADR-0493, ADR-0494): waits, events, notify and next are Herd's own verbs.
  let herd: HerdVerb | null = null;
  if (rest[0] !== "server") {
    try {
      herd = parseHerdVerb(rest);
      if (!herd && !herdOwn) parseHubCommand(rest); // usage errors answer locally, server or no server
    } catch (e) {
      if (e instanceof HubOpError) return fail({ error: e.code, message: e.message });
      throw e;
    }
  }
  const hub = await connectInstance(data, name);
  if (!hub) return fail({ error: "no_hub", message: `no Herd instance "${name}" answered the handshake (start one with \`lucid herd${named}\` or \`lucid herd server start${named}\`)` });
  if (herd && herd.verb !== "notify" && herd.verb !== "next") return runStreamed(hub, rest, herd.verb === "agent.events");
  let r: HubReply;
  try { r = await callHub(hub, rest); }
  catch (e) { return fail({ error: "hub_unreachable", message: e instanceof Error ? e.message : String(e) }); }
  if (r.status !== 200 || r.body.ok !== true) return fail(r.body);
  if (rest[0] === "server") {
    // `server stop` returns once the server is GONE (its spawned engine stopped first), so the next
    // command a script runs never races the shutdown.
    const deadline = Date.now() + STOP_WAIT_MS;
    while (Date.now() < deadline && (await verifyHub(hub))) await Bun.sleep(200);
    if (await verifyHub(hub)) return fail({ error: "stop_timeout", message: `Herd instance "${name}" (pid ${hub.pid}) still answers after ${STOP_WAIT_MS / 1000}s` });
    process.stdout.write(JSON.stringify({ stopped: name, pid: hub.pid }, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(JSON.stringify(r.body.data, null, 2) + "\n");
  return 0;
}
