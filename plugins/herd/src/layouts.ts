// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0541; P-HERD.2, ADR-0491): named LAYOUTS as files. A layout is presentation only:
//
//   <data>/hub-layouts/<name>.json           a saved layout (0600, tmp + rename)
//   <data>/hub-layouts/builtin/<name>.json   the shipped presets, rewritten from this module
//
//   { v: 1, name, tree, rail?: boolean, strip?: boolean }
//   tree  = { dir: "h" | "v", ratio, a, b }            a split ("v" side by side, "h" stacked)
//         | { deck }                                    a capability deck, or "main" (P-HERD.6)
//         | { deck: "agent", slot }                     an agent pane waiting on a slot
//   slot  = { by: "priority", index }                   the index-th lane (1-based) in the rail's order
//         | { by: "name", pattern }                     the first lane whose name matches the glob
//
// A layout file is UNTRUSTED input (shared by hand, ADR-0491 item 4): the parser takes exactly these
// keys at every level, caps the tree at LAYOUT_LEAF_CAP panes and the nesting at the same depth, caps
// the file at MAX_LAYOUT_BYTES, and refuses a file that carries a lane id, a cwd, a model or a prompt
// (ADR-0489 default c) as `layout_invalid`. Nothing here fetches anything from a network.
//
// Node-safe on purpose (node:fs and node:path only, no Bun API): the GUI mirror (P-HERD.8) and the
// Node-side runtime host can read the same files with the same parser.

import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  HubOpError,
  leaves,
  parsePaneSlot,
  type PaneDeck,
  type PaneNode,
  type PaneSlot,
  type PaneTemplate,
  type Spaces,
} from "../../../harness/launcher/hub_spaces.ts";
import { isRecord } from "./events.ts";
import { writeAtomic } from "./instance.ts";

export const LAYOUT_LEAF_CAP = 32;
export const MAX_LAYOUT_BYTES = 64 * 1024;
/** A layout name lands in a file name: lowercase letters, digits, `-` and `_`, 1-40, starting
 *  alphanumeric. No separator, no dot, nothing a case-blind file system folds together. */
export const LAYOUT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
/** Device names Windows refuses as file names, with or without an extension. */
const WINDOWS_DEVICE_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;
/** Keys that would make a layout carry a lane, a place, a model or words for an agent. */
const FORBIDDEN_KEYS: Record<string, true> = { lane: true, laneName: true, id: true, cwd: true, model: true, prompt: true, session: true, text: true };

export type LayoutSlot = { by: "priority"; index: number } | { by: "name"; pattern: string };
export interface LayoutLeaf { deck: PaneDeck; slot?: LayoutSlot }
export interface LayoutSplit { dir: "h" | "v"; ratio: number; a: LayoutNode; b: LayoutNode }
export type LayoutNode = LayoutSplit | LayoutLeaf;
export interface LayoutFile { v: 1; name: string; tree: LayoutNode; rail?: boolean; strip?: boolean }

const invalid = (why: string): HubOpError => new HubOpError("layout_invalid", `not a Herd layout: ${why}`);
/** Untrusted text quoted in a message: bounded, control bytes escaped. */
const quote = (s: string): string => JSON.stringify(s.slice(0, 40));

/** A layout name, or HubOpError("bad_name"). */
export function layoutName(raw: string): string {
  if (!LAYOUT_NAME_RE.test(raw) || WINDOWS_DEVICE_RE.test(raw)) {
    throw new HubOpError("bad_name", `a layout name is 1-40 of a-z 0-9 - _, starting with a letter or digit (got ${quote(raw)})`);
  }
  return raw;
}

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const k of Object.keys(o)) {
    if (allowed.includes(k)) continue;
    if (Object.hasOwn(FORBIDDEN_KEYS, k)) throw invalid(`a layout never carries a lane id, a cwd, a model or a prompt (found ${quote(k)} in ${where})`);
    throw invalid(`unknown field ${quote(k)} in ${where}`);
  }
}

/** Parse an untrusted layout. `isDeck` says which capability decks this hub has ("agent" and
 *  "main" are always understood). Throws HubOpError("layout_invalid") with the reason. */
export function parseLayout(raw: string, isDeck: (deck: string) => deck is PaneDeck): LayoutFile {
  if (raw.length > MAX_LAYOUT_BYTES) throw invalid(`larger than ${MAX_LAYOUT_BYTES / 1024} KiB`);
  let o: unknown;
  try { o = JSON.parse(raw); } catch { throw invalid("not JSON"); }
  if (!isRecord(o)) throw invalid("not a JSON object");
  onlyKeys(o, ["v", "name", "tree", "rail", "strip"], "the file");
  if (o.v !== 1) throw invalid("v must be 1");
  if (typeof o.name !== "string" || !LAYOUT_NAME_RE.test(o.name) || WINDOWS_DEVICE_RE.test(o.name)) throw invalid("name is 1-40 of a-z 0-9 - _, starting with a letter or digit");
  if (o.rail !== undefined && typeof o.rail !== "boolean") throw invalid("rail is true or false");
  if (o.strip !== undefined && typeof o.strip !== "boolean") throw invalid("strip is true or false");
  let count = 0;
  const node = (v: unknown, depth: number): LayoutNode => {
    if (depth > LAYOUT_LEAF_CAP) throw invalid("the tree is nested too deep");
    if (!isRecord(v)) throw invalid("a tree node is not an object");
    if ("dir" in v) {
      onlyKeys(v, ["dir", "ratio", "a", "b"], "a split");
      if (v.dir !== "h" && v.dir !== "v") throw invalid('a split\'s dir is "h" or "v"');
      if (v.ratio !== undefined && (typeof v.ratio !== "number" || !(v.ratio >= 0.1 && v.ratio <= 0.9))) throw invalid("a split's ratio is a number from 0.1 to 0.9");
      const a = node(v.a, depth + 1);
      const b = node(v.b, depth + 1);
      return { dir: v.dir, ratio: typeof v.ratio === "number" ? v.ratio : 0.5, a, b };
    }
    onlyKeys(v, ["deck", "slot"], "a pane");
    if (++count > LAYOUT_LEAF_CAP) throw invalid(`more than ${LAYOUT_LEAF_CAP} panes`);
    if (typeof v.deck !== "string") throw invalid("a pane's deck is a string");
    if (v.deck === "agent") {
      const slot = parsePaneSlot(v.slot);
      if (!slot || slot.by === "main") throw invalid(`an agent pane needs a slot: { "by": "priority", "index": 1-${LAYOUT_LEAF_CAP} } or { "by": "name", "pattern": "<glob>" }`);
      return { deck: "agent", slot };
    }
    if (v.slot !== undefined) throw invalid("only an agent pane has a slot");
    if (v.deck === "main") return { deck: "main" };
    if (!isDeck(v.deck)) throw invalid(`unknown deck ${quote(v.deck)}`);
    return { deck: v.deck };
  };
  const tree = node(o.tree, 0);
  return { v: 1, name: o.name, tree, ...(o.rail === undefined ? {} : { rail: o.rail }), ...(o.strip === undefined ? {} : { strip: o.strip }) };
}

/** The file body for a layout (stable key order, one trailing newline). */
export function layoutJson(file: LayoutFile): string {
  return JSON.stringify(file, null, 2) + "\n";
}

export function layoutPanes(node: LayoutNode): number {
  return "dir" in node ? layoutPanes(node.a) + layoutPanes(node.b) : 1;
}

// ---- presets (ADR-0491 item 3) ------------------------------------------------------------------

const agent = (index: number): LayoutLeaf => ({ deck: "agent", slot: { by: "priority", index } });
const deck = (d: PaneDeck): LayoutLeaf => ({ deck: d });
const across = (ratio: number, a: LayoutNode, b: LayoutNode): LayoutSplit => ({ dir: "v", ratio, a, b });
const stacked = (a: LayoutNode, b: LayoutNode): LayoutSplit => ({ dir: "h", ratio: 0.5, a, b });
/** Full-height agent columns, then a stacked utility column of Security over Audit, all equal width. */
function columns(n: number): LayoutNode {
  let tree: LayoutNode = stacked(deck("security"), deck("audit"));
  for (let i = n; i >= 1; i--) tree = across(Math.round((1 / (n - i + 2)) * 10_000) / 10_000, agent(i), tree);
  return tree;
}

/** Shipped read-only; written under hub-layouts/builtin/ for the GUI mirror (P-HERD.8) to read. */
export const BUILTIN_LAYOUTS: readonly LayoutFile[] = [
  { v: 1, name: "solo", tree: agent(1) },
  { v: 1, name: "columns-3", tree: columns(3) },
  { v: 1, name: "columns-4", tree: columns(4) },
  { v: 1, name: "review", tree: across(0.5, agent(1), stacked(deck("security"), deck("fleet"))) },
  { v: 1, name: "orbit", tree: across(0.5, deck("fleet"), stacked(deck("agents"), deck("usage"))) },
  { v: 1, name: "command", tree: across(0.5, deck("main"), stacked(agent(1), agent(2))) },
];
const builtin = (name: string): LayoutFile | undefined => BUILTIN_LAYOUTS.find((l) => l.name === name);

// ---- the model side: apply, save, slots ---------------------------------------------------------

/** The tab template a layout applies as. `main` is the Main pane when the host has one (P-HERD.6),
 *  else an agent pane waiting on the Main slot. */
export function layoutTemplate(node: LayoutNode, mainReady: boolean): PaneTemplate {
  if ("dir" in node) return { kind: "split", dir: node.dir, ratio: node.ratio, a: layoutTemplate(node.a, mainReady), b: layoutTemplate(node.b, mainReady) };
  if (node.deck === "main") return mainReady ? { kind: "leaf", deck: "main" } : { kind: "leaf", deck: "agent", slot: { by: "main" } };
  return node.slot ? { kind: "leaf", deck: node.deck, slot: node.slot } : { kind: "leaf", deck: node.deck };
}

/** A live tab's tree as a layout (`layout save`): agent panes become priority slots at their lane's
 *  place in the rail (`rank`), or their order among the tab's agent panes when the lane is gone.
 *  Waiting panes keep their slot. Pane names, ids and lanes stay out (presentation only). */
export function layoutFromTree(name: string, tree: PaneNode, rail: boolean, rank: (lane: string) => number | null): LayoutFile {
  if (leaves(tree).length > LAYOUT_LEAF_CAP) throw invalid(`more than ${LAYOUT_LEAF_CAP} panes`);
  return { v: 1, name: layoutName(name), tree: layoutTreeOf(tree, rank), rail };
}

/** A live tree in layout form (what `layout save` writes, and `layout tree` shows). */
export function layoutTreeOf(tree: PaneNode, rank: (lane: string) => number | null): LayoutNode {
  let ordinal = 0;
  const walk = (n: PaneNode): LayoutNode => {
    if (n.kind === "split") return { dir: n.dir, ratio: n.ratio ?? 0.5, a: walk(n.a), b: walk(n.b) };
    if (n.deck !== "agent") return { deck: n.deck };
    ordinal++;
    if (n.slot) return n.slot.by === "main" ? { deck: "main" } : { deck: "agent", slot: n.slot };
    const r = n.lane ? rank(n.lane) : null;
    return agent(Math.min(LAYOUT_LEAF_CAP, r ?? ordinal));
  };
  return walk(tree);
}

/** Case-blind glob: `*` any run, `?` one character. Iterative (no regex built from input). */
export function globMatch(pattern: string, text: string): boolean {
  const p = pattern.toLowerCase();
  const t = text.toLowerCase();
  let pi = 0;
  let ti = 0;
  let star = -1;
  let mark = 0;
  while (ti < t.length) {
    if (pi < p.length && (p[pi] === "?" || p[pi] === t[ti])) { pi++; ti++; }
    else if (pi < p.length && p[pi] === "*") { star = pi++; mark = ti; }
    else if (star >= 0) { pi = star + 1; ti = ++mark; }
    else return false;
  }
  while (pi < p.length && p[pi] === "*") pi++;
  return pi === p.length;
}

/** Fill every waiting pane whose slot now has a lane: a priority slot takes the index-th lane in the
 *  rail's order (`lanes` is that order); a name slot the first matching lane that no agent pane shows
 *  yet; a Main slot becomes the Main pane once the host has one. Returns how many panes filled. */
export function fillSlots(spaces: Spaces, lanes: readonly { id: string; name: string }[], mainReady: boolean): number {
  const waiting: { id: string; slot: PaneSlot }[] = [];
  const shown = new Set<string>();
  for (const s of spaces.spaces) for (const t of s.tabs) for (const l of leaves(t.tree)) {
    if (l.deck !== "agent") continue;
    if (l.lane) shown.add(l.lane);
    else if (l.slot) waiting.push({ id: l.id, slot: l.slot });
  }
  let filled = 0;
  for (const { id, slot } of waiting) {
    if (slot.by === "main") {
      if (mainReady) { spaces.rebind(id, "main"); filled++; }
      continue;
    }
    let lane: { id: string; name: string } | undefined;
    if (slot.by === "priority") lane = lanes[slot.index - 1];
    else for (const l of lanes) if (!shown.has(l.id) && globMatch(slot.pattern, l.name)) { lane = l; break; }
    if (!lane) continue;
    spaces.rebind(id, "agent", lane);
    shown.add(lane.id);
    filled++;
  }
  return filled;
}

// ---- the files ----------------------------------------------------------------------------------

export interface LayoutEntry { name: string; builtin: boolean; panes: number; error?: string }

/** The layouts of one data dir. Every read parses again: the files are the truth, never a cache. */
export class LayoutLibrary {
  readonly dir: string;
  constructor(data: string, readonly isDeck: (deck: string) => deck is PaneDeck) {
    this.dir = join(data, "hub-layouts");
  }

  #path(name: string): string {
    return join(this.dir, `${layoutName(name)}.json`);
  }

  /** Write the presets under builtin/ when a copy is missing or differs; never throws. */
  writeBuiltins(): void {
    for (const l of BUILTIN_LAYOUTS) {
      const path = join(this.dir, "builtin", `${l.name}.json`);
      const body = layoutJson(l);
      try {
        if (existsSync(path) && readFileSync(path, "utf8") === body) continue;
        writeAtomic(path, body);
      } catch { /* a read-only data dir costs the copies, never the presets */ }
    }
  }

  /** Built-ins first, then the saved layouts by name; a saved file that does not parse is listed with
   *  its reason so the user can fix or delete it. */
  list(): LayoutEntry[] {
    const out: LayoutEntry[] = BUILTIN_LAYOUTS.map((l) => ({ name: l.name, builtin: true, panes: layoutPanes(l.tree) }));
    let files: string[];
    try { files = readdirSync(this.dir); } catch { return out; }
    const names = files.flatMap((f) => (f.endsWith(".json") ? [f.slice(0, -5)] : [])).sort();
    for (const name of names) {
      if (!LAYOUT_NAME_RE.test(name) || WINDOWS_DEVICE_RE.test(name) || builtin(name)) continue;
      try { out.push({ name, builtin: false, panes: layoutPanes(this.read(name).tree) }); }
      catch (e) {
        if (!(e instanceof HubOpError)) throw e;
        out.push({ name, builtin: false, panes: 0, error: e.message });
      }
    }
    return out;
  }

  /** The names `cycle` walks: every layout that parses, built-ins first. */
  names(): string[] {
    return this.list().filter((l) => !l.error).map((l) => l.name);
  }

  read(name: string): LayoutFile {
    const b = builtin(name);
    if (b) return b;
    const path = this.#path(name);
    const file = readLimited(path);
    if (file === null) throw new HubOpError("not_found", `no layout "${name}" (lucid herd layout list)`);
    const parsed = parseLayout(file, this.isDeck);
    if (parsed.name !== name) throw invalid(`the name inside (${quote(parsed.name)}) is not the file's name`);
    return parsed;
  }

  /** Save (or replace) a user layout. A built-in name refuses: presets are read-only. */
  write(file: LayoutFile): void {
    if (builtin(file.name)) throw new HubOpError("builtin_layout", `"${file.name}" is a built-in layout; save under another name`);
    writeAtomic(this.#path(file.name), layoutJson(file));
  }

  delete(name: string): void {
    if (builtin(name)) throw new HubOpError("builtin_layout", `"${name}" is a built-in layout and cannot be deleted`);
    const path = this.#path(name);
    if (!existsSync(path)) throw new HubOpError("not_found", `no layout "${name}"`);
    rmSync(path, { force: true });
  }

  /** Write a layout to `path` for sharing; an existing file there is never overwritten. */
  exportTo(name: string, path: string): { name: string; path: string } {
    const file = this.read(name);
    try { writeFileSync(path, layoutJson(file), { flag: "wx" }); } catch (e) {
      if (e instanceof Error && "code" in e && e.code === "EEXIST") throw new HubOpError("exists", `${path} already exists; export never overwrites`);
      throw new HubOpError("io", `could not write ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { name, path };
  }

  /** Import a shared layout through the same parser, under its own name (or `as`), or a new name
   *  (`-2`, `-3`, ...) when that one is taken. */
  importFrom(path: string, as?: string): { name: string; renamed: boolean; panes: number } {
    const raw = readLimited(path);
    if (raw === null) throw new HubOpError("not_found", `cannot read ${path}`);
    const parsed = parseLayout(raw, this.isDeck);
    const wanted = as === undefined ? parsed.name : layoutName(as);
    let name = wanted;
    for (let i = 2; builtin(name) || existsSync(this.#path(name)); i++) {
      if (i > 999) throw new HubOpError("exists", `too many layouts named like "${wanted}"`);
      const suffix = `-${i}`;
      name = `${wanted.slice(0, 40 - suffix.length)}${suffix}`;
    }
    this.write({ ...parsed, name });
    return { name, renamed: name !== wanted, panes: layoutPanes(parsed.tree) };
  }
}

/** A file's text when it is a regular file no larger than MAX_LAYOUT_BYTES; null when unreadable.
 *  Larger refuses (an import never reads a huge file into memory). */
function readLimited(path: string): string | null {
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    size = st.size;
  } catch { return null; }
  if (size > MAX_LAYOUT_BYTES) throw invalid(`larger than ${MAX_LAYOUT_BYTES / 1024} KiB`);
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

// ---- the verbs (ADR-0491 items 2 and 4) ---------------------------------------------------------

export type LayoutOp =
  | { op: "layout.list" }
  | { op: "layout.show"; name: string }
  | { op: "layout.delete"; name: string }
  | { op: "layout.save"; name: string; tab?: string }
  | { op: "layout.apply"; name: string; tab?: string }
  | { op: "layout.tree"; tab?: string }
  | { op: "layout.export"; name: string; path: string }
  | { op: "layout.import"; path: string; as?: string };

export const LAYOUT_USAGE =
  "layout list | show <name> | save <name> [-t <tab>] | apply <name> [-t <tab>] | delete <name> | tree [-t <tab>] | export <name> <path> | import <path> [--as <name>]";

/** `layout ...` argv as an op; null when argv is not a layout verb. Never executes anything. */
export function parseLayoutCommand(argv: readonly string[]): LayoutOp | null {
  if (argv[0] !== "layout") return null;
  const usage = (msg: string) => new HubOpError("usage", `${msg} (usage: ${LAYOUT_USAGE})`);
  const sub = argv[1];
  let tab: string | undefined;
  let as: string | undefined;
  const pos: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-t" || a === "--as") {
      const v = argv[++i];
      if (v === undefined) throw usage(`${a} needs a value`);
      if (a === "-t") tab = v;
      else as = v;
    } else if (a.startsWith("-") && a.length > 1) throw usage(`unknown flag ${a}`);
    else pos.push(a);
  }
  const takesTab = sub === "save" || sub === "apply" || sub === "tree";
  if (tab !== undefined && !takesTab) throw usage(`-t goes with save, apply and tree`);
  if (as !== undefined && sub !== "import") throw usage("--as goes with import");
  const want = sub === "list" || sub === "tree" ? 0 : sub === "export" ? 2 : 1;
  if (pos.length !== want) throw usage(`layout ${sub ?? ""} takes ${want} argument${want === 1 ? "" : "s"}`);
  const t = tab === undefined ? {} : { tab };
  switch (sub) {
    case "list": return { op: "layout.list" };
    case "tree": return { op: "layout.tree", ...t };
    case "show": return { op: "layout.show", name: layoutName(pos[0]!) };
    case "delete": return { op: "layout.delete", name: layoutName(pos[0]!) };
    case "save": return { op: "layout.save", name: layoutName(pos[0]!), ...t };
    case "apply": return { op: "layout.apply", name: layoutName(pos[0]!), ...t };
    case "export": return { op: "layout.export", name: layoutName(pos[0]!), path: pos[1]! };
    case "import": return { op: "layout.import", path: pos[0]!, ...(as === undefined ? {} : { as: layoutName(as) }) };
  }
  throw usage(`unknown layout command "${sub ?? ""}"`);
}

/** The ops that touch only the files: the shell runs them itself, with or without a server. */
export function isFileLayoutOp(op: LayoutOp): boolean {
  return op.op !== "layout.save" && op.op !== "layout.apply" && op.op !== "layout.tree";
}

/** What a layout op runs against. `lanes` is the rail's agents order (priority slots index it). */
export interface LayoutHost {
  readonly library: LayoutLibrary;
  readonly spaces?: Spaces;
  mainReady(): boolean;
  lanes(): { id: string; name: string }[];
}

/** Where an op came from. Export and import read and write paths the user names, so they run from the
 *  user's shell or a person's `:` prompt, never from the control plane an agent can script. */
export type LayoutCaller = "shell" | "prompt" | "control";

export function runLayoutOp(host: LayoutHost, op: LayoutOp, from: LayoutCaller): unknown {
  const { library } = host;
  if ((op.op === "layout.export" || op.op === "layout.import") && from === "control") {
    throw new HubOpError("shell_only", `layout ${op.op.slice(7)} reads or writes a file you name; run it from a shell: lucid herd ${op.op === "layout.export" ? "layout export <name> <path>" : "layout import <path>"}`);
  }
  if ((op.op === "layout.export" || op.op === "layout.import") && !isAbsolute(op.path)) {
    throw new HubOpError("usage", `give the full path of the file (got ${quote(op.path)})`);
  }
  switch (op.op) {
    case "layout.list": return library.list();
    case "layout.show": return library.read(op.name);
    case "layout.delete": library.delete(op.name); return { deleted: op.name };
    case "layout.export": return library.exportTo(op.name, op.path);
    case "layout.import": return library.importFrom(op.path, op.as);
  }
  const { spaces } = host;
  if (!spaces) throw new HubOpError("no_hub", `layout ${op.op.slice(7)} needs the running Herd server`);
  const order = host.lanes();
  const rank = (lane: string): number | null => {
    const i = order.findIndex((l) => l.id === lane);
    return i < 0 ? null : i + 1;
  };
  switch (op.op) {
    case "layout.tree": {
      const { tab } = spaces.findTab(op.tab);
      return { tab: tab.id, rail: spaces.rail, tree: layoutTreeOf(tab.tree, rank) };
    }
    case "layout.save": {
      const { tab } = spaces.findTab(op.tab);
      const file = layoutFromTree(op.name, tab.tree, spaces.rail, rank);
      library.write(file);
      return { saved: file.name, tab: tab.id, panes: layoutPanes(file.tree) };
    }
    case "layout.apply": return applyLayout(host, spaces, op.name, op.tab);
  }
}

/** Rebuild a tab from a layout: fresh pane ids, the rail as the layout says, and every slot that
 *  already has its lane filled right away (the rest wait and fill as lanes appear). */
export function applyLayout(host: LayoutHost, spaces: Spaces, name: string, tabRef?: string): { applied: string; tab: string; panes: number; waiting: number } {
  const file = host.library.read(name);
  const tab = spaces.applyTree(tabRef, layoutTemplate(file.tree, host.mainReady()));
  if (file.rail !== undefined && file.rail !== spaces.rail) spaces.setRail(file.rail);
  fillSlots(spaces, host.lanes(), host.mainReady());
  const panes = leaves(tab.tree);
  return { applied: file.name, tab: tab.id, panes: panes.length, waiting: panes.filter((p) => p.slot).length };
}

/** The layout after `current` in `names`, wrapping; the first when `current` is not among them. */
export function nextLayoutName(names: readonly string[], current: string | undefined): string | null {
  if (names.length === 0) return null;
  const i = current === undefined ? -1 : names.indexOf(current);
  return names[(i + 1) % names.length]!;
}
