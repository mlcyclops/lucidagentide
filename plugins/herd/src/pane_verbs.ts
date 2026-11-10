// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0535; P-HERD.3, ADR-0492 item 4): the pane verbs Herd adds to the control plane, answered
// through the `commands` seam ahead of the classic parser (whose vocabulary stays as it is):
//
//   pane focus [-t <pane>] --direction left|right|up|down      (tmux: select-pane -L|-R|-U|-D)
//   pane swap  [-t <pane>] --direction left|right|up|down
//   pane resize [-t <pane>] -L|-R|-U|-D --cells <n>           (the classic -L 5 stays percent)
//   pane move <pane> --tab <tab> --split right|down
//   pane move <pane> --new-tab [-n <name>]
//   pane rename <pane> <label...> | pane rename <pane> --clear
//
// Directions resolve by geometry on the rects the hub renders (hub_tui.paneRects at the size the
// server renders at), so `--direction left` and `prefix+h` land on the same pane, and `--cells`
// moves the divider by the same cells the resize-mode key does. Pane ids never change on a move
// within a space (ADR-0436: ids are never reused).

import { paneRects } from "../../../harness/launcher/hub_tui.ts";
import { HubOpError, leaves, neighborPane, type PaneDirection, type Spaces } from "../../../harness/launcher/hub_spaces.ts";

export type HerdPaneOp =
  | { op: "pane.focus.direction"; target?: string; dir: PaneDirection }
  | { op: "pane.swap.direction"; target?: string; dir: PaneDirection }
  | { op: "pane.resize.cells"; target?: string; dir: "L" | "R" | "U" | "D"; cells: number }
  | { op: "pane.move"; target: string; tab: string; split: "right" | "down" }
  | { op: "pane.move.new"; target: string; name?: string }
  | { op: "pane.rename"; target: string; label: string | null };

export const HERD_PANE_USAGE =
  "pane focus|swap [-t <pane>] --direction left|right|up|down | pane resize [-t <pane>] -L|-R|-U|-D --cells <n> | " +
  "pane move <pane> --tab <tab> --split right|down | pane move <pane> --new-tab [-n <name>] | pane rename <pane> <label>|--clear";

const usage = (msg: string): HubOpError => new HubOpError("usage", `${msg} (usage: ${HERD_PANE_USAGE})`);
const DIRS: Record<string, PaneDirection> = { left: "left", right: "right", up: "up", down: "down" };
const TMUX_DIRS: Record<string, PaneDirection> = { "-L": "left", "-R": "right", "-U": "up", "-D": "down" };

/** Flags with values, the bare flags, and positionals. Unknown dash-args refuse. */
function scan(args: readonly string[], valued: readonly string[], bare: readonly string[]): { f: Record<string, string>; on: Record<string, true>; pos: string[] } {
  const f: Record<string, string> = {};
  const on: Record<string, true> = {};
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (valued.includes(a)) {
      const v = args[++i];
      if (v === undefined) throw usage(`${a} needs a value`);
      f[a] = v;
    } else if (bare.includes(a)) on[a] = true;
    else if (a.startsWith("-") && a.length > 1) throw usage(`unknown flag ${a}`);
    else pos.push(a);
  }
  return { f, on, pos };
}

const direction = (raw: string | undefined): PaneDirection => {
  const d = raw !== undefined && Object.hasOwn(DIRS, raw) ? DIRS[raw] : undefined;
  if (!d) throw usage("--direction is left, right, up or down");
  return d;
};

/** argv as a Herd pane op; null when argv is not one (the classic parser takes it). */
export function parseHerdPaneCommand(argv: readonly string[]): HerdPaneOp | null {
  const [verb, sub, ...rest] = argv;
  if (verb === "select-pane") {
    const all = argv.slice(1);
    if (!all.some((a) => Object.hasOwn(TMUX_DIRS, a))) return null;
    const { f, on, pos } = scan(all, ["-t"], Object.keys(TMUX_DIRS));
    const dirs = Object.keys(on);
    if (dirs.length !== 1 || pos.length) throw usage("select-pane takes one of -L -R -U -D and an optional -t <pane>");
    return { op: "pane.focus.direction", ...(f["-t"] === undefined ? {} : { target: f["-t"] }), dir: TMUX_DIRS[dirs[0]!]! };
  }
  if (verb !== "pane") return null;
  if ((sub === "focus" || sub === "swap") && rest.includes("--direction")) {
    const { f, pos } = scan(rest, ["-t", "--direction"], []);
    if (pos.length) throw usage(`pane ${sub} --direction takes no other argument`);
    return { op: sub === "focus" ? "pane.focus.direction" : "pane.swap.direction", ...(f["-t"] === undefined ? {} : { target: f["-t"] }), dir: direction(f["--direction"]) };
  }
  if (sub === "resize" && rest.includes("--cells")) {
    const { f, on, pos } = scan(rest, ["-t", "--cells"], ["-L", "-R", "-U", "-D"]);
    const dirs = Object.keys(on);
    if (dirs.length !== 1 || pos.length) throw usage("pane resize --cells takes exactly one of -L -R -U -D");
    const raw = f["--cells"]!;
    if (!/^\d{1,4}$/.test(raw) || Number(raw) < 1) throw usage("--cells is a whole number of cells, 1 or more");
    const dir = dirs[0] === "-L" ? "L" : dirs[0] === "-R" ? "R" : dirs[0] === "-U" ? "U" : "D";
    return { op: "pane.resize.cells", ...(f["-t"] === undefined ? {} : { target: f["-t"] }), dir, cells: Number(raw) };
  }
  if (sub === "move") {
    const { f, on, pos } = scan(rest, ["--tab", "--split", "-n"], ["--new-tab"]);
    if (pos.length !== 1) throw usage("pane move names one pane");
    const target = pos[0]!;
    if (on["--new-tab"]) {
      if (f["--tab"] !== undefined || f["--split"] !== undefined) throw usage("--new-tab goes alone (with an optional -n <name>)");
      return { op: "pane.move.new", target, ...(f["-n"] === undefined ? {} : { name: f["-n"] }) };
    }
    if (f["--tab"] === undefined) throw usage("pane move needs --tab <tab> or --new-tab");
    if (f["-n"] !== undefined) throw usage("-n names a new tab; it goes with --new-tab");
    const split = f["--split"] ?? "right";
    if (split !== "right" && split !== "down") throw usage("--split is right or down");
    return { op: "pane.move", target, tab: f["--tab"], split };
  }
  if (sub === "rename") {
    const [target, ...words] = rest;
    if (target === undefined || target.startsWith("-")) throw usage("pane rename names one pane first");
    if (words.length === 1 && words[0] === "--clear") return { op: "pane.rename", target, label: null };
    const label = words.join(" ").trim();
    if (!label) throw usage("pane rename <pane> <label> (or --clear)");
    return { op: "pane.rename", target, label };
  }
  return null;
}

/** The pane region the hub renders at right now (cells): directions and cells resolve against it. */
export interface PaneRegion { w: number; h: number }

export function runHerdPaneOp(spaces: Spaces, op: HerdPaneOp, region: PaneRegion): unknown {
  switch (op.op) {
    case "pane.focus.direction":
    case "pane.swap.direction": {
      const { tab, index, leaf } = spaces.pane(op.target);
      const ring = leaves(tab.tree);
      const next = neighborPane(paneRects(tab.tree, region.w, region.h), index, op.dir);
      if (next === null) throw new HubOpError("no_pane", `no pane ${op.dir === "up" ? "above" : op.dir === "down" ? "below" : `to the ${op.dir}`} of ${leaf.id}`);
      const other = ring[next]!;
      if (op.op === "pane.focus.direction") return { focused: spaces.focusPane(other.id).id, from: leaf.id };
      spaces.swap(leaf.id, other.id);
      spaces.focusPane(leaf.id); // focus travels with the pane that moved
      return { swapped: [leaf.id, other.id] };
    }
    case "pane.resize.cells":
      return spaces.resizeCells(op.target, op.dir, op.cells, region.w, region.h);
    case "pane.move": {
      const r = spaces.movePane(op.target, { tab: op.tab, split: op.split });
      return { pane: r.pane.id, from: r.from, tab: r.tab.id };
    }
    case "pane.move.new": {
      const r = spaces.movePane(op.target, { newTab: true, ...(op.name === undefined ? {} : { name: op.name }) });
      return { pane: r.pane.id, from: r.from, tab: r.tab.id };
    }
    case "pane.rename": {
      const leaf = spaces.renamePane(op.target, op.label);
      return { pane: leaf.id, label: leaf.label ?? null };
    }
  }
}
