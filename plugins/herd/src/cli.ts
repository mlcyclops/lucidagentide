// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0535): what `lucid herd [--name <name>] <args>` means once core has handed argv to the
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

import { callHub, verifyHub, type HubReply } from "../../../harness/launcher/hub_control.ts";
import { HubOpError } from "../../../harness/launcher/hub_spaces.ts";
import { HUB_USAGE, parseHubCommand } from "../../../harness/launcher/hub_tmux_verbs.ts";
import { runHubClient } from "./hub_client.ts";
import { runHubServer } from "./hub_server.ts";
import { connectInstance, DEFAULT_INSTANCE, herdDataDir, instanceName, liveInstances } from "./instance.ts";

type Env = Readonly<Record<string, string | undefined>>;

export const HERD_HELP =
  "lucid herd [--name <name>]               attach this terminal (starting the server if none runs); Q detaches\n" +
  "lucid herd server start|stop [--name n]  run the server here, or end it (a spawned engine stops with it)\n" +
  "lucid herd server list                   every running instance\n" +
  "lucid herd [--name <name>] <command>     drive the running server, as `lucid hub <command>`:\n" +
  `  ${HUB_USAGE.replace(/^lucid hub /, "")}\n` +
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

const STOP_WAIT_MS = 60_000; // a spawned engine is stopped and awaited before the server lets go

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
  const data = herdDataDir(env);
  if (rest[0] === "server") {
    if (rest.length === 2 && rest[1] === "start") return runHubServer(env, { name });
    if (rest.length === 2 && rest[1] === "list") {
      process.stdout.write(JSON.stringify(await liveInstances(data), null, 2) + "\n");
      return 0;
    }
    if (!(rest.length === 2 && rest[1] === "stop")) return fail({ error: "usage", message: "server start|stop|list [--name <name>]" });
  } else {
    try {
      parseHubCommand(rest); // usage errors answer locally, server or no server
    } catch (e) {
      if (e instanceof HubOpError) return fail({ error: e.code, message: e.message });
      throw e;
    }
  }
  const hub = await connectInstance(data, name);
  if (!hub) return fail({ error: "no_hub", message: `no Herd instance "${name}" answered the handshake (start one with \`lucid herd${named}\` or \`lucid herd server start${named}\`)` });
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
