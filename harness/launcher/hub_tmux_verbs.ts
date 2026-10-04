// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-TUI.3 (ADR-0431) + P-TUI.5 (ADR-0433): the ONE command parser for the hub control plane.
// `lucid hub <args>` on the CLI, the control server's /cmd body, and the TUI's `:` prompt all turn argv
// into a HubOp here, so a verb cannot mean one thing typed and another thing scripted. Two
// vocabularies map onto the same ops:
//
//   grouped:  status | space <list|create|rename|close|focus> | tab <list|create|rename|close|focus> |
//             pane <list|split|close|focus|zoom|rebind|swap|resize|read|send> |
//             agent <list|spawn|prompt|status|read|cancel>
//   tmux:     split-window select-pane kill-pane swap-pane resize-pane list-panes send-keys
//             new-window kill-window rename-window select-window list-windows         (window = TAB)
//             new-session kill-session rename-session switch-client list-sessions     (session = SPACE)
//
// Spaces are tmux sessions, tabs are tmux windows, panes are panes (ids s1, s1:t2, s1:p2). Pure: no
// I/O, nothing executes here.

import { HubOpError } from "./hub_spaces.ts";

export type HubOp =
  | { op: "status" }
  | { op: "space.list" }
  | { op: "space.create"; name?: string }
  | { op: "space.rename"; target?: string; name: string }
  | { op: "space.close"; target?: string }
  | { op: "space.focus"; target: string }
  | { op: "tab.list"; space?: string; all: boolean }
  | { op: "tab.create"; space?: string; name?: string }
  | { op: "tab.rename"; target?: string; name: string }
  | { op: "tab.close"; target?: string }
  | { op: "tab.focus"; target: string }
  | { op: "pane.list"; space?: string; tab?: string; all: boolean }
  | { op: "pane.split"; target?: string; dir: "right" | "down" }
  | { op: "pane.close"; target?: string }
  | { op: "pane.focus"; target: string }
  | { op: "pane.zoom"; target?: string }
  | { op: "pane.rebind"; target?: string; deck: string; lane?: string }
  | { op: "pane.swap"; source: string; target: string }
  | { op: "pane.resize"; target?: string; dir: "L" | "R" | "U" | "D"; n: number }
  | { op: "pane.read"; target?: string; lines: number; width: number }
  | { op: "pane.keys"; target?: string; keys: string[] }
  | { op: "agent.list" }
  | { op: "agent.spawn"; cwd?: string; name?: string; model?: string; session?: string }
  | { op: "agent.prompt"; lane: string; text: string }
  | { op: "agent.status"; lane: string }
  | { op: "agent.read"; lane: string; turns: number }
  | { op: "agent.cancel"; lane: string }
  | { op: "agent.priority"; lane: string; n: number };

export const HUB_USAGE =
  "lucid hub [status | space list|create|rename|close|focus | tab list|create|rename|close|focus | " +
  "pane list|split|close|focus|zoom|rebind|swap|resize|read|send | agent list|spawn|prompt|status|read|cancel|priority | " +
  "split-window|select-pane|kill-pane|swap-pane|resize-pane|list-panes|send-keys | " +
  "new-window|kill-window|rename-window|select-window|list-windows (tabs) | " +
  "new-session|kill-session|rename-session|switch-client|list-sessions (spaces)]";

const usage = (msg: string): HubOpError => new HubOpError("usage", `${msg} (usage: ${HUB_USAGE})`);

/** Split argv into flags and positionals. `valued` flags consume the next arg; `bare` flags do not;
 *  any other dash-arg is a usage error (a typo must not silently become a positional). */
function flags(args: readonly string[], valued: readonly string[], bare: readonly string[] = []): { f: Record<string, string | true>; pos: string[] } {
  const f: Record<string, string | true> = {};
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (valued.includes(a)) {
      const v = args[++i];
      if (v === undefined) throw usage(`${a} needs a value`);
      f[a] = v;
    } else if (bare.includes(a)) f[a] = true;
    else if (a.startsWith("-") && a.length > 1 && !/^-\d+$/.test(a)) throw usage(`unknown flag ${a}`);
    else pos.push(a);
  }
  return { f, pos };
}

const val = (f: Record<string, string | true>, k: string): string | undefined => (typeof f[k] === "string" ? (f[k] as string) : undefined);

function int(raw: string | undefined, dflt: number, min: number, max: number, what: string): number {
  if (raw === undefined) return dflt;
  if (!/^\d+$/.test(raw)) throw usage(`${what} must be a whole number`);
  return Math.min(max, Math.max(min, Number(raw)));
}

function one(pos: string[], what: string): string {
  if (pos.length !== 1) throw usage(`expected exactly one ${what}`);
  return pos[0]!;
}

function none(pos: string[]): void {
  if (pos.length) throw usage(`unexpected argument "${pos[0]}"`);
}

const RESIZE_DIRS = ["-L", "-R", "-U", "-D"] as const;

function resizeOp(args: readonly string[]): HubOp {
  const { f, pos } = flags(args, ["-t"], [...RESIZE_DIRS, "-Z"]);
  if (f["-Z"]) { none(pos); return { op: "pane.zoom", target: val(f, "-t") }; }
  const dirs = RESIZE_DIRS.filter((d) => f[d]);
  if (dirs.length !== 1) throw usage("resize needs exactly one of -L -R -U -D (or -Z to zoom)");
  if (pos.length > 1) throw usage("resize takes one adjustment");
  return { op: "pane.resize", target: val(f, "-t"), dir: dirs[0]!.slice(1) as "L" | "R" | "U" | "D", n: int(pos[0], 5, 1, 80, "adjustment") };
}

function splitOp(args: readonly string[]): HubOp {
  const { f, pos } = flags(args, ["-t"], ["-h", "-v"]);
  none(pos);
  if (f["-h"] && f["-v"]) throw usage("-h and -v are exclusive");
  return { op: "pane.split", target: val(f, "-t"), dir: f["-h"] ? "right" : "down" };
}

function readOp(args: readonly string[]): HubOp {
  const { f, pos } = flags(args, ["-t", "-n", "-w"]);
  none(pos);
  return { op: "pane.read", target: val(f, "-t"), lines: int(val(f, "-n"), 40, 1, 1000, "-n"), width: int(val(f, "-w"), 100, 20, 400, "-w") };
}

/** send-keys: `-t <pane>` then every remaining word is a key, even one that starts with a dash. */
function keysOp(args: readonly string[]): HubOp {
  let target: string | undefined;
  let rest = args;
  if (rest[0] === "-t") {
    target = rest[1];
    if (target === undefined) throw usage("-t needs a value");
    rest = rest.slice(2);
  }
  if (!rest.length) throw usage("send-keys needs keys");
  return { op: "pane.keys", target, keys: [...rest] };
}

function spaceGroup(cmd: string | undefined, args: readonly string[]): HubOp {
  const { f, pos } = flags(args, ["-t", "-n"]);
  const t = val(f, "-t");
  switch (cmd) {
    case "list": none(pos); return { op: "space.list" };
    case "create": {
      if (pos.length > 1) throw usage("one name");
      const name = val(f, "-n") ?? pos[0];
      return name === undefined ? { op: "space.create" } : { op: "space.create", name };
    }
    case "rename": return { op: "space.rename", target: t, name: one(pos, "name") };
    case "close": return { op: "space.close", target: t ?? (pos.length ? one(pos, "space") : undefined) };
    case "focus": return { op: "space.focus", target: t ?? one(pos, "space") };
  }
  throw usage(`unknown space command "${cmd ?? ""}"`);
}

function tabGroup(cmd: string | undefined, args: readonly string[]): HubOp {
  const { f, pos } = flags(args, ["-t", "-n"]);
  const t = val(f, "-t");
  switch (cmd) {
    // `tab list` is every tab (like `pane list`); -t narrows to one space.
    case "list": none(pos); return t === undefined ? { op: "tab.list", all: true } : { op: "tab.list", space: t, all: false };
    case "create": {
      if (pos.length > 1) throw usage("one name");
      const name = val(f, "-n") ?? pos[0];
      return { op: "tab.create", ...(t === undefined ? {} : { space: t }), ...(name === undefined ? {} : { name }) };
    }
    case "rename": return { op: "tab.rename", target: t, name: one(pos, "name") };
    case "close": return { op: "tab.close", target: t ?? (pos.length ? one(pos, "tab") : undefined) };
    case "focus": return { op: "tab.focus", target: t ?? one(pos, "tab") };
  }
  throw usage(`unknown tab command "${cmd ?? ""}"`);
}

function paneGroup(cmd: string | undefined, args: readonly string[]): HubOp {
  switch (cmd) {
    case "split": return splitOp(args);
    case "resize": return resizeOp(args);
    case "read": return readOp(args);
    case "send": return keysOp(args);
  }
  const { f, pos } = flags(args, ["-t", "-s"]);
  const t = val(f, "-t");
  switch (cmd) {
    case "list": none(pos); return t === undefined ? { op: "pane.list", all: true } : { op: "pane.list", space: t, all: false };
    case "close": return { op: "pane.close", target: t ?? (pos.length ? one(pos, "pane") : undefined) };
    case "focus": return { op: "pane.focus", target: t ?? one(pos, "pane") };
    case "zoom": return { op: "pane.zoom", target: t ?? (pos.length ? one(pos, "pane") : undefined) };
    case "rebind": {
      if (pos.length < 1 || pos.length > 2) throw usage("rebind <deck> [lane]");
      return { op: "pane.rebind", target: t, deck: pos[0]!, ...(pos[1] ? { lane: pos[1] } : {}) };
    }
    case "swap": {
      const s = val(f, "-s");
      if (!s || !t) throw usage("swap needs -s <pane> -t <pane>");
      none(pos);
      return { op: "pane.swap", source: s, target: t };
    }
  }
  throw usage(`unknown pane command "${cmd ?? ""}"`);
}

function agentGroup(cmd: string | undefined, args: readonly string[]): HubOp {
  if (cmd === "prompt") {
    const [lane, ...words] = args;
    const text = words.join(" ").trim();
    if (!lane || !text) throw usage("agent prompt <lane> <text...>");
    return { op: "agent.prompt", lane, text };
  }
  const { f, pos } = flags(args, ["--cwd", "--name", "--model", "--session", "-n"]);
  switch (cmd) {
    case "list": none(pos); return { op: "agent.list" };
    case "spawn": {
      none(pos);
      const o: Extract<HubOp, { op: "agent.spawn" }> = { op: "agent.spawn" };
      for (const [flag, key] of [["--cwd", "cwd"], ["--name", "name"], ["--model", "model"], ["--session", "session"]] as const) {
        const v = val(f, flag);
        if (v !== undefined) o[key] = v;
      }
      return o;
    }
    case "status": return { op: "agent.status", lane: one(pos, "lane") };
    case "read": return { op: "agent.read", lane: one(pos, "lane"), turns: int(val(f, "-n"), 20, 1, 200, "-n") };
    case "cancel": return { op: "agent.cancel", lane: one(pos, "lane") };
    case "priority": {
      // DISPLAY ORDER in the hub's agents panel, not scheduling: the engine never sees this number.
      if (pos.length !== 2) throw usage("agent priority <name|id> <1-9> (display order in the agents panel, not scheduling)");
      return { op: "agent.priority", lane: pos[0]!, n: int(pos[1], 0, 1, 9, "priority (display order, 1-9)") };
    }
  }
  throw usage(`unknown agent command "${cmd ?? ""}"`);
}

/** argv -> HubOp, or a HubOpError("usage"). Never executes anything. */
export function parseHubCommand(argv: readonly string[]): HubOp {
  const [verb, ...rest] = argv;
  switch (verb) {
    case "status": none([...rest]); return { op: "status" };
    case "space": return spaceGroup(rest[0], rest.slice(1));
    case "tab": return tabGroup(rest[0], rest.slice(1));
    case "pane": return paneGroup(rest[0], rest.slice(1));
    case "agent": return agentGroup(rest[0], rest.slice(1));
    // ---- tmux vocabulary ----
    case "split-window": return splitOp(rest);
    case "select-pane": return paneGroup("focus", rest);
    case "kill-pane": return paneGroup("close", rest);
    case "swap-pane": return paneGroup("swap", rest);
    case "resize-pane": return resizeOp(rest);
    case "send-keys": return keysOp(rest);
    // window = TAB (in the active space unless -t names one).
    case "new-window": {
      none(flags(rest, ["-n", "-t"]).pos); // a name is -n only, like tmux
      return tabGroup("create", rest);
    }
    case "kill-window": return tabGroup("close", rest);
    case "rename-window": return tabGroup("rename", rest);
    case "select-window": return tabGroup("focus", rest);
    case "list-windows": {
      // tmux: the current session's windows; -a every window; -t a session.
      const { f, pos } = flags(rest, ["-t"], ["-a"]);
      none(pos);
      return f["-a"] ? { op: "tab.list", all: true } : { op: "tab.list", space: val(f, "-t") ?? "", all: false };
    }
    // session = SPACE.
    case "new-session": {
      const { f, pos } = flags(rest, ["-s"]);
      none(pos);
      const name = val(f, "-s");
      return name === undefined ? { op: "space.create" } : { op: "space.create", name };
    }
    case "kill-session": return spaceGroup("close", rest);
    case "rename-session": return spaceGroup("rename", rest);
    case "switch-client": {
      const { f, pos } = flags(rest, ["-t"]);
      none(pos);
      const t = val(f, "-t");
      if (t === undefined) throw usage("switch-client needs -t <space>");
      return { op: "space.focus", target: t };
    }
    case "list-sessions": none([...rest]); return { op: "space.list" };
    case "list-panes": {
      // tmux: the current window's panes; -s the current session's; -a every pane; -t a window.
      const { f, pos } = flags(rest, ["-t"], ["-a", "-s"]);
      none(pos);
      const t = val(f, "-t");
      if (f["-a"]) return { op: "pane.list", all: true };
      if (f["-s"]) return { op: "pane.list", space: t ?? "", all: false };
      return { op: "pane.list", tab: t ?? "", all: false };
    }
  }
  throw usage(`unknown command "${verb ?? ""}"`);
}

/** Shell-ish word split for the `:` prompt: whitespace separates, '...' and "..." group, \ escapes. */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
    } else if (c === "'" || c === '"') { quote = c; has = true; }
    else if (c === "\\" && i + 1 < line.length) { cur += line[++i]; has = true; }
    else if (/\s/.test(c)) { if (has) out.push(cur); cur = ""; has = false; }
    else { cur += c; has = true; }
  }
  if (quote) throw usage("unterminated quote");
  if (has) out.push(cur);
  return out;
}
