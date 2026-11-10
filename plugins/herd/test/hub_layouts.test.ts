// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0535; P-HERD.2, ADR-0491): layouts are untrusted presentation. The parser takes exactly
// the documented shape and refuses a lane id, a cwd, a model or a prompt; the tree is capped; names
// land in file names safely; slots resolve to the rail's order or a name glob; save and apply round
// trip; presets are read-only and apply with no lanes at all; import never overwrites.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubOpError, leaves, Spaces, type PaneDeck } from "../../../harness/launcher/hub_spaces.ts";
import {
  applyLayout,
  BUILTIN_LAYOUTS,
  fillSlots,
  globMatch,
  LAYOUT_LEAF_CAP,
  layoutFromTree,
  layoutJson,
  LayoutLibrary,
  layoutTemplate,
  layoutTreeOf,
  nextLayoutName,
  parseLayout,
  parseLayoutCommand,
  runLayoutOp,
  type LayoutHost,
  type LayoutNode,
} from "../src/layouts.ts";

const DECK_IDS = ["overview", "security", "fleet", "sessions", "audit", "usage", "network", "kg", "agents", "spaces"];
const isDeck = (d: string): d is PaneDeck => DECK_IDS.includes(d);
const code = (f: () => unknown): string => {
  try { f(); } catch (e) { return e instanceof HubOpError ? e.code : String(e); }
  return "no error";
};
const message = (f: () => unknown): string => {
  try { f(); } catch (e) { return e instanceof Error ? e.message : String(e); }
  return "";
};
const file = (tree: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ v: 1, name: "mine", tree, ...extra });
/** n agent panes side by side. */
const chain = (n: number): unknown => {
  let t: unknown = { deck: "agent", slot: { by: "priority", index: 1 } };
  for (let i = 1; i < n; i++) t = { dir: "v", ratio: 0.5, a: { deck: "overview" }, b: t };
  return t;
};

let data: string;
beforeEach(() => { data = mkdtempSync(join(tmpdir(), "herd-layouts-")); });
afterEach(() => { rmSync(data, { recursive: true, force: true }); });

describe("the parser: untrusted input", () => {
  test("a well-formed file parses; a split without a ratio gets 0.5", () => {
    const l = parseLayout(file({ dir: "h", a: { deck: "security" }, b: { deck: "agent", slot: { by: "name", pattern: "web-*" } } }, { rail: false }), isDeck);
    expect(l).toEqual({ v: 1, name: "mine", rail: false, tree: { dir: "h", ratio: 0.5, a: { deck: "security" }, b: { deck: "agent", slot: { by: "name", pattern: "web-*" } } } });
  });

  test("a lane id, a cwd, a model or a prompt anywhere is refused layout_invalid, by name", () => {
    for (const bad of [
      file({ deck: "agent", slot: { by: "priority", index: 1 }, lane: "lane_1" }),
      file({ deck: "agent", slot: { by: "priority", index: 1 } }, { cwd: "C:/work" }),
      file({ dir: "v", a: { deck: "overview" }, b: { deck: "agent", slot: { by: "priority", index: 1 }, model: "gpt" } }),
      file({ deck: "agent", slot: { by: "priority", index: 1 }, prompt: "rm -rf /" }),
    ]) {
      expect(code(() => parseLayout(bad, isDeck))).toBe("layout_invalid");
      expect(message(() => parseLayout(bad, isDeck))).toContain("never carries a lane id, a cwd, a model or a prompt");
    }
    // A cwd smuggled inside a slot is just as refused.
    expect(code(() => parseLayout(file({ deck: "agent", slot: { by: "name", pattern: "x", cwd: "/" } }), isDeck))).toBe("layout_invalid");
  });

  test(`more than ${LAYOUT_LEAF_CAP} panes, or a tree nested past the cap, is refused`, () => {
    expect(code(() => parseLayout(file(chain(LAYOUT_LEAF_CAP)), isDeck))).toBe("no error");
    expect(message(() => parseLayout(file(chain(LAYOUT_LEAF_CAP + 1)), isDeck))).toContain(`more than ${LAYOUT_LEAF_CAP} panes`);
    let deep: unknown = { deck: "overview" };
    for (let i = 0; i < 40; i++) deep = { dir: "v", a: deep, b: { deck: "overview" } };
    expect(code(() => parseLayout(file(deep), isDeck))).toBe("layout_invalid");
  });

  test("names are file-safe: separators, dots, upper case, device names and long names refuse", () => {
    for (const name of ["../x", "a/b", "a.b", "Mine", "con", "nul", "lpt1", "x".repeat(41), "", "-lead"]) {
      expect(code(() => parseLayout(JSON.stringify({ v: 1, name, tree: { deck: "overview" } }), isDeck))).toBe("layout_invalid");
    }
    expect(code(() => parseLayout(JSON.stringify({ v: 1, name: "a".repeat(40), tree: { deck: "overview" } }), isDeck))).toBe("no error");
  });

  test("unknown decks and fields, bad ratios, slots off-shape, other versions and junk refuse", () => {
    for (const bad of [
      file({ deck: "nope" }),
      file({ deck: "overview" }, { theme: "dark" }),
      file({ dir: "v", ratio: 0.95, a: { deck: "overview" }, b: { deck: "overview" } }),
      file({ dir: "x", a: { deck: "overview" }, b: { deck: "overview" } }),
      file({ deck: "agent" }),
      file({ deck: "agent", slot: { by: "priority", index: 0 } }),
      file({ deck: "agent", slot: { by: "main" } }),
      file({ deck: "overview", slot: { by: "priority", index: 1 } }),
      JSON.stringify({ v: 2, name: "mine", tree: { deck: "overview" } }),
      "not json",
      "[]",
      " ".repeat(70 * 1024),
    ]) expect(code(() => parseLayout(bad, isDeck))).toBe("layout_invalid");
  });

  test("an untrusted name in a message is bounded and escaped", () => {
    const msg = message(() => parseLayout(file({ deck: `\u001b]52;c;${"A".repeat(200)}` }), isDeck));
    expect(msg).not.toContain("\u001b");
    expect(msg.length).toBeLessThan(200);
  });
});

describe("slots", () => {
  test("globs are case-blind, * and ? only, and never a regex", () => {
    expect(globMatch("web-*", "Web-API")).toBe(true);
    expect(globMatch("w?b", "web")).toBe(true);
    expect(globMatch("web-*", "api")).toBe(false);
    expect(globMatch("(a+)+$", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaab")).toBe(false);
    expect(globMatch("*", "")).toBe(true);
  });

  test("a priority slot takes that place in the rail; a name slot the first match no pane shows yet; the rest wait", () => {
    const h = new Spaces();
    h.applyTree(undefined, layoutTemplate({ dir: "v", ratio: 0.5, a: { deck: "agent", slot: { by: "priority", index: 2 } }, b: { dir: "h", ratio: 0.5, a: { deck: "agent", slot: { by: "name", pattern: "web-*" } }, b: { deck: "agent", slot: { by: "name", pattern: "web-*" } } } }, true));
    const lanes = [{ id: "l1", name: "api" }, { id: "l2", name: "web-a" }];
    expect(fillSlots(h, lanes, true)).toBe(1);
    expect(h.paneList().map((p) => p.lane ?? p.slot)).toEqual(["l2", { by: "name", pattern: "web-*" }, { by: "name", pattern: "web-*" }]);
    // web-a is shown already (by the priority slot), so the name slots wait for another web lane.
    expect(fillSlots(h, [...lanes, { id: "l3", name: "web-b" }], true)).toBe(1);
    expect(h.paneList().map((p) => p.lane ?? "waiting")).toEqual(["l2", "l3", "waiting"]);
  });

  test("Main waits until the host has a Main pane, then becomes it", () => {
    const h = new Spaces();
    h.applyTree(undefined, layoutTemplate({ deck: "main" }, false));
    expect(h.paneList()[0]).toMatchObject({ deck: "agent", slot: { by: "main" } });
    expect(fillSlots(h, [], false)).toBe(0);
    expect(fillSlots(h, [], true)).toBe(1);
    expect(h.paneList()[0]).toMatchObject({ deck: "main" });
    h.applyTree(undefined, layoutTemplate({ deck: "main" }, true));
    expect(h.paneList()[0]).toMatchObject({ deck: "main" });
  });
});

describe("save, apply, cycle", () => {
  const host = (library: LayoutLibrary, spaces: Spaces, lanes: { id: string; name: string }[] = []): LayoutHost => ({ library, spaces, mainReady: () => false, lanes: () => lanes });

  test("save writes the tab with agent panes as priority slots at their rail place; apply on a new tab reads back the same tree", () => {
    const lib = new LayoutLibrary(data, isDeck);
    const h = new Spaces();
    const lanes = [{ id: "l1", name: "api" }, { id: "l2", name: "web" }, { id: "l3", name: "docs" }];
    applyLayout(host(lib, h, lanes), h, "columns-3");
    expect(h.paneList().map((p) => p.lane ?? p.deck)).toEqual(["l1", "l2", "l3", "security", "audit"]);
    expect(runLayoutOp(host(lib, h, lanes), parseLayoutCommand(["layout", "save", "three"])!, "control")).toMatchObject({ saved: "three", panes: 5 });
    const saved = JSON.parse(readFileSync(join(lib.dir, "three.json"), "utf8"));
    expect(JSON.stringify(saved)).not.toContain("l1"); // no lane ids on disk, only slots
    h.createTab();
    applyLayout(host(lib, h, lanes), h, "three");
    const rank = (lane: string) => lanes.findIndex((l) => l.id === lane) + 1;
    expect(layoutTreeOf(h.findTab("s1:t2").tab.tree, rank)).toEqual(layoutTreeOf(h.findTab("s1:t1").tab.tree, rank));
    expect(h.paneList({ tab: "s1:t2" }).map((p) => p.lane ?? p.deck)).toEqual(["l1", "l2", "l3", "security", "audit"]);
  });

  test("every preset applies on an engine with zero lanes, its agent panes waiting", () => {
    const lib = new LayoutLibrary(data, isDeck);
    const h = new Spaces();
    for (const l of BUILTIN_LAYOUTS) {
      const r = applyLayout(host(lib, h), h, l.name);
      expect(r.panes).toBe(leaves(h.tab.tree).length);
      expect(h.paneList().every((p) => p.deck !== "agent" || p.slot !== undefined)).toBe(true);
    }
    expect(Spaces.restore(JSON.stringify(h), isDeck)).not.toBeNull();
  });

  test("the cycle walks every layout and returns to the start", () => {
    const names = ["solo", "columns-3", "mine"];
    let cur: string | undefined;
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) { cur = nextLayoutName(names, cur)!; seen.push(cur); }
    expect(seen).toEqual(["solo", "columns-3", "mine", "solo"]);
    expect(nextLayoutName([], undefined)).toBeNull();
    expect(nextLayoutName(names, "deleted")).toBe("solo");
  });

  test("save refuses a tab over the cap and a preset's name", () => {
    const lib = new LayoutLibrary(data, isDeck);
    const h = new Spaces();
    expect(code(() => lib.write(layoutFromTree("solo", h.tab.tree, true, () => null)))).toBe("builtin_layout");
    for (let i = 0; i < LAYOUT_LEAF_CAP; i++) h.split(undefined, "right");
    expect(code(() => layoutFromTree("big", h.tab.tree, true, () => null))).toBe("layout_invalid");
  });
});

describe("the library: files", () => {
  test("presets are written under builtin/ and are read-only to the verbs", () => {
    const lib = new LayoutLibrary(data, isDeck);
    lib.writeBuiltins();
    for (const l of BUILTIN_LAYOUTS) expect(readFileSync(join(lib.dir, "builtin", `${l.name}.json`), "utf8")).toBe(layoutJson(l));
    expect(code(() => lib.delete("solo"))).toBe("builtin_layout");
    // A tampered copy on disk changes nothing: the preset is this module's, and the copy is rewritten.
    writeFileSync(join(lib.dir, "builtin", "solo.json"), "{}");
    expect(lib.read("solo")).toEqual(BUILTIN_LAYOUTS[0]!);
    lib.writeBuiltins();
    expect(readFileSync(join(lib.dir, "builtin", "solo.json"), "utf8")).toBe(layoutJson(BUILTIN_LAYOUTS[0]!));
  });

  test("import parses like load, takes a new name on collision, and never overwrites on export", () => {
    const lib = new LayoutLibrary(data, isDeck);
    const src = join(data, "shared.json");
    writeFileSync(src, file({ dir: "v", a: { deck: "agent", slot: { by: "priority", index: 1 } }, b: { deck: "fleet" } }));
    expect(lib.importFrom(src)).toEqual({ name: "mine", renamed: false, panes: 2 });
    expect(lib.importFrom(src)).toEqual({ name: "mine-2", renamed: true, panes: 2 });
    writeFileSync(src, JSON.stringify({ v: 1, name: "solo", tree: { deck: "fleet" } }));
    expect(lib.importFrom(src).name).toBe("solo-2"); // a preset's name is taken too
    expect(lib.list().map((l) => l.name)).toEqual([...BUILTIN_LAYOUTS.map((l) => l.name), "mine", "mine-2", "solo-2"]);
    const out = join(data, "out.json");
    expect(lib.exportTo("mine", out)).toEqual({ name: "mine", path: out });
    expect(parseLayout(readFileSync(out, "utf8"), isDeck).name).toBe("mine");
    expect(code(() => lib.exportTo("mine", out))).toBe("exists");
  });

  test("an import over the leaf cap, naming a cwd, or too large is refused and writes nothing", () => {
    const lib = new LayoutLibrary(data, isDeck);
    const src = join(data, "shared.json");
    for (const body of [file(chain(LAYOUT_LEAF_CAP + 1)), file({ deck: "overview" }, { cwd: "/etc" }), `${file({ deck: "overview" })}${" ".repeat(70 * 1024)}`]) {
      writeFileSync(src, body);
      expect(code(() => lib.importFrom(src))).toBe("layout_invalid");
    }
    expect(existsSync(join(lib.dir, "mine.json"))).toBe(false);
  });

  test("a saved file that does not parse is listed with its reason, and skipped by the cycle", () => {
    const lib = new LayoutLibrary(data, isDeck);
    lib.write({ v: 1, name: "good", tree: { deck: "fleet" } });
    writeFileSync(join(lib.dir, "broken.json"), file({ deck: "overview" }, { prompt: "hi" }));
    writeFileSync(join(lib.dir, "renamed.json"), JSON.stringify({ v: 1, name: "other", tree: { deck: "fleet" } }));
    const listed = lib.list().filter((l) => !l.builtin);
    expect(listed.map((l) => [l.name, l.error === undefined])).toEqual([["broken", false], ["good", true], ["renamed", false]]);
    expect(lib.names()).toEqual([...BUILTIN_LAYOUTS.map((l) => l.name), "good"]);
  });
});

describe("the verbs", () => {
  test("parse: names checked, flags placed, unknown verbs refused", () => {
    expect(parseLayoutCommand(["pane", "list"])).toBeNull();
    expect(parseLayoutCommand(["layout", "apply", "solo", "-t", "s1:t2"])).toEqual({ op: "layout.apply", name: "solo", tab: "s1:t2" });
    expect(parseLayoutCommand(["layout", "import", "x.json", "--as", "mine"])).toEqual({ op: "layout.import", path: "x.json", as: "mine" });
    expect(code(() => parseLayoutCommand(["layout", "show", "../etc"]))).toBe("bad_name");
    expect(code(() => parseLayoutCommand(["layout", "list", "-t", "s1:t1"]))).toBe("usage");
    expect(code(() => parseLayoutCommand(["layout", "fetch", "https://x"]))).toBe("usage");
  });

  test("export and import name files: the control plane is refused, the shell and a typed prompt are not", () => {
    const lib = new LayoutLibrary(data, isDeck);
    const h: LayoutHost = { library: lib, spaces: new Spaces(), mainReady: () => false, lanes: () => [] };
    const out = join(data, "x.json");
    expect(code(() => runLayoutOp(h, { op: "layout.export", name: "solo", path: out }, "control"))).toBe("shell_only");
    expect(code(() => runLayoutOp(h, { op: "layout.import", path: out }, "control"))).toBe("shell_only");
    expect(existsSync(out)).toBe(false);
    expect(code(() => runLayoutOp(h, { op: "layout.export", name: "solo", path: "relative.json" }, "prompt"))).toBe("usage");
    expect(runLayoutOp(h, { op: "layout.export", name: "solo", path: out }, "prompt")).toEqual({ name: "solo", path: out });
  });

  test("save and apply need a server; the file verbs do not", () => {
    const lib = new LayoutLibrary(data, isDeck);
    const shell: LayoutHost = { library: lib, mainReady: () => false, lanes: () => [] };
    expect(code(() => runLayoutOp(shell, { op: "layout.apply", name: "solo" }, "shell"))).toBe("no_hub");
    expect(runLayoutOp(shell, { op: "layout.show", name: "review" }, "shell")).toMatchObject({ name: "review" });
  });

  test("a tree read back from a template is the template (the GUI mirror's contract)", () => {
    for (const l of BUILTIN_LAYOUTS) {
      const h = new Spaces();
      h.applyTree(undefined, layoutTemplate(l.tree, true));
      const back: LayoutNode = layoutTreeOf(h.tab.tree, () => null);
      expect(back).toEqual(l.tree);
    }
  });
});
