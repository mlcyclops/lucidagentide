// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/agents_store.test.ts - P-RAIL.AGENTS1: the Agents list model. Pins the merge (recents, Main's
// folder and lane folders become Agents; auto ones leave with their source, saved ones stay), name de-dup,
// recency order versus the user's manual order, removal that stays removed until re-added, Undo, and the
// working / turn-end signals the rail animates.

import { describe, expect, it } from "bun:test";
import {
  addAgent, baseName, defaultTheme, displayNames, emptyDoc, laneFolderIds, laneSourceFolders, laneTurnEnds, loadDoc,
  mergeSources, moveAgent, normFolder, recolorAgent, removeAgent, renameAgent, restoreAgent, saveDoc, sourceFolders,
  workingFolders, THEME_KEYS, NAME_MAX, type AgentsDoc, type LaneLike, type Sources,
} from "./agents_store.ts";

const src = (main: string | null, recent: string[], lanes: string[] = []): Sources => ({ main, recent: recent.map((path) => ({ path })), lanes });
const ids = (d: AgentsDoc): string[] => d.agents.map((a) => a.id);
const lane = (id: string, cwd: string, status: string, turns = 0): LaneLike => ({ id, cwd, status, turns });

describe("normFolder / baseName", () => {
  it("folds separators, trailing slashes and case like renderWorkspaceBar's same()", () => {
    expect(normFolder("C:\\Work\\Api\\")).toBe("c:/work/api");
    expect(normFolder("c:/work//api")).toBe("c:/work/api");
    expect(normFolder("/home/u/repo/")).toBe("/home/u/repo");
    expect(normFolder("/")).toBe("/");
  });
  it("takes the last segment", () => {
    expect(baseName("C:\\work\\api-gateway")).toBe("api-gateway");
    expect(baseName("/home/u/repo/")).toBe("repo");
    expect(baseName("C:\\")).toBe("C:");
  });
});

describe("mergeSources", () => {
  it("builds the first list in recency order: Main, the recents, then lane folders, each once", () => {
    const d = mergeSources(emptyDoc(), src("C:\\w\\main", ["C:\\w\\a", "c:/w/main", "C:\\w\\b"], ["C:\\w\\lane"]));
    expect(ids(d)).toEqual(["c:/w/main", "c:/w/a", "c:/w/b", "c:/w/lane"]);
    expect(d.agents.every((a) => !a.saved && a.name === null)).toBe(true);
    expect(d.main).toBe("c:/w/main");
  });
  it("maps a LUCID worktree lane to its main checkout", () => {
    const d = mergeSources(emptyDoc(), src(null, [], ["C:\\w\\repo.lucid-worktrees\\api-1a2b"]));
    expect(ids(d)).toEqual(["c:/w/repo"]);
  });
  it("a newly used folder enters at the top; auto Agents that left every source drop out; saved ones stay", () => {
    let d = mergeSources(emptyDoc(), src("/w/a", ["/w/b", "/w/c"]));
    d = renameAgent(d, "/w/c", "Client"); // saved
    d = mergeSources(d, src("/w/a", ["/w/new"]));
    expect(ids(d)).toEqual(["/w/new", "/w/a", "/w/c"]);
    expect(d.agents.find((a) => a.id === "/w/c")?.saved).toBe(true);
  });
  it("lifts Main's new folder to the top until the user orders the list by hand", () => {
    let d = mergeSources(emptyDoc(), src("/w/a", ["/w/b", "/w/c"]));
    d = mergeSources(d, src("/w/c", ["/w/a", "/w/b"]));
    expect(ids(d)).toEqual(["/w/c", "/w/a", "/w/b"]);
    d = moveAgent(d, "/w/b", 0); // manual
    expect(ids(d)).toEqual(["/w/b", "/w/c", "/w/a"]);
    d = mergeSources(d, src("/w/a", ["/w/b", "/w/c"]));
    expect(ids(d)).toEqual(["/w/b", "/w/c", "/w/a"]); // the manual order holds
    d = mergeSources(d, src("/w/a", ["/w/b", "/w/c", "/w/fresh"]));
    expect(ids(d)[0]).toBe("/w/fresh"); // a new folder still enters at the top
  });
  it("is stable: merging the same sources twice changes nothing", () => {
    const s = src("/w/a", ["/w/b"], ["/w/c"]);
    const once = mergeSources(emptyDoc(), s);
    expect(saveDoc(mergeSources(once, s))).toBe(saveDoc(once));
  });
  it("sourceFolders keeps the original path text for display", () => {
    expect(sourceFolders(src("C:\\Work\\API", [])).map((f) => f.path)).toEqual(["C:\\Work\\API"]);
  });
});

describe("removal, hiding and Undo", () => {
  it("a removed auto Agent stays hidden until the user adds it again", () => {
    let d = mergeSources(emptyDoc(), src("/w/a", ["/w/b"]));
    const r = removeAgent(d, "/w/b");
    expect(r.removed?.index).toBe(1);
    d = mergeSources(r.doc, src("/w/a", ["/w/b"]));
    expect(ids(d)).toEqual(["/w/a"]);
    d = addAgent(d, "/w/b");
    expect(ids(d)).toEqual(["/w/b", "/w/a"]);
    expect(d.hidden).toEqual([]);
    expect(d.agents[0]!.saved).toBe(true);
  });
  it("Undo puts the same record back where it was", () => {
    let d = mergeSources(emptyDoc(), src("/w/a", ["/w/b", "/w/c"]));
    d = recolorAgent(d, "/w/b", { hue: 200 });
    const r = removeAgent(d, "/w/b");
    const back = restoreAgent(r.doc, r.removed!);
    expect(ids(back)).toEqual(["/w/a", "/w/b", "/w/c"]);
    expect(back.agents[1]).toEqual(d.agents[1]!);
    expect(back.hidden).toEqual([]);
  });
  it("removing an unknown id is a no-op", () => {
    const d = mergeSources(emptyDoc(), src("/w/a", []));
    expect(removeAgent(d, "/nope")).toEqual({ doc: d, removed: null });
  });
});

describe("rename, recolor, move", () => {
  it("rename trims, caps and marks saved; blank goes back to the auto name", () => {
    let d = mergeSources(emptyDoc(), src("/w/a", []));
    d = renameAgent(d, "/w/a", `  ${"x".repeat(80)}  `);
    expect(d.agents[0]!.name).toHaveLength(NAME_MAX);
    expect(d.agents[0]!.saved).toBe(true);
    d = renameAgent(d, "/w/a", "   ");
    expect(d.agents[0]!.name).toBeNull();
    expect(displayNames(d.agents).get("/w/a")).toBe("a");
  });
  it("recolor to a preset or a custom hue marks saved", () => {
    let d = mergeSources(emptyDoc(), src("/w/a", []));
    d = recolorAgent(d, "/w/a", { theme: "ember" });
    expect(d.agents[0]).toMatchObject({ theme: "ember", saved: true });
    d = recolorAgent(d, "/w/a", { hue: 725 });
    expect(d.agents[0]).toMatchObject({ theme: null, hue: 5 });
  });
  it("move places the Agent at the final index, clamps, and makes the order manual", () => {
    let d = mergeSources(emptyDoc(), src("/w/a", ["/w/b", "/w/c", "/w/d"]));
    d = moveAgent(d, "/w/a", 2);
    expect(ids(d)).toEqual(["/w/b", "/w/c", "/w/a", "/w/d"]);
    expect(d.manual).toBe(true);
    expect(d.agents[2]!.saved).toBe(true);
    d = moveAgent(d, "/w/d", -5);
    expect(ids(d)[0]).toBe("/w/d");
    d = moveAgent(d, "/w/d", 99);
    expect(ids(d)[3]).toBe("/w/d");
  });
  it("the manual order persists through save and load", () => {
    let d = mergeSources(emptyDoc(), src("/w/a", ["/w/b", "/w/c"]));
    d = moveAgent(d, "/w/c", 0);
    const back = loadDoc(saveDoc(d));
    expect(ids(back)).toEqual(["/w/c", "/w/a", "/w/b"]);
    expect(back.manual).toBe(true);
    expect(ids(mergeSources(back, src("/w/a", ["/w/b", "/w/c"])))).toEqual(["/w/c", "/w/a", "/w/b"]);
  });
});

describe("displayNames", () => {
  it("de-duplicates equal basenames with parent hints, climbing until they differ", () => {
    const n = displayNames([
      { id: "1", path: "C:\\work\\api", name: null },
      { id: "2", path: "C:\\games\\api", name: null },
      { id: "3", path: "/x/one/svc/web", name: null },
      { id: "4", path: "/x/two/svc/web", name: null },
      { id: "5", path: "/solo/tool", name: null },
    ]);
    expect(n.get("1")).toBe("work/api");
    expect(n.get("2")).toBe("games/api");
    expect(n.get("3")).toBe("one/svc/web");
    expect(n.get("4")).toBe("two/svc/web");
    expect(n.get("5")).toBe("tool");
  });
  it("the user's name always wins and is never decorated", () => {
    const n = displayNames([{ id: "1", path: "/a/api", name: "Gateway" }, { id: "2", path: "/b/api", name: null }]);
    expect(n.get("1")).toBe("Gateway");
    expect(n.get("2")).toBe("api");
  });
  it("is case-insensitive about collisions", () => {
    const n = displayNames([{ id: "1", path: "/a/API", name: null }, { id: "2", path: "/b/api", name: null }]);
    expect(n.get("1")).toBe("a/API");
  });
});

describe("loadDoc", () => {
  it("never throws and drops malformed rows", () => {
    expect(loadDoc(null)).toEqual(emptyDoc());
    expect(loadDoc("{oops")).toEqual(emptyDoc());
    expect(loadDoc(JSON.stringify({ v: 2, agents: [] }))).toEqual(emptyDoc());
    const d = loadDoc(JSON.stringify({ v: 1, manual: true, hidden: ["C:\\X", 5], agents: [
      { path: "C:\\w\\a", theme: "bogus", hue: "x", saved: 1, name: "  A  " }, { path: "c:/w/a/" }, { nope: true }, null,
    ] }));
    expect(ids(d)).toEqual(["c:/w/a"]);
    expect(d.agents[0]).toMatchObject({ theme: null, hue: 145, saved: true, name: "A", path: "C:\\w\\a" });
    expect(d.hidden).toEqual(["c:/x"]);
  });
  it("default themes are stable per folder and always a mascot palette", () => {
    expect(defaultTheme("/w/a")).toBe(defaultTheme("/w/a"));
    for (const id of ["/a", "/b", "/c", "/dd", "c:/x"]) expect(THEME_KEYS).toContain(defaultTheme(id));
  });
});

describe("working and turn-end signals", () => {
  it("an Agent types while Main works in its folder or any busy lane's folder (worktrees count for the checkout)", () => {
    const w = workingFolders({ folder: "C:\\w\\main", busy: true }, [
      lane("1", "C:\\w\\repo.lucid-worktrees\\x-1", "working"),
      lane("2", "C:\\w\\idle", "awaiting-input"),
      lane("3", "C:\\w\\ask", "needs-approval"),
    ]);
    expect([...w].sort()).toEqual(["c:/w/ask", "c:/w/main", "c:/w/repo", "c:/w/repo.lucid-worktrees/x-1"]);
    expect(workingFolders({ folder: "C:\\w\\main", busy: false }, []).size).toBe(0);
  });
  it("laneFolderIds and laneSourceFolders", () => {
    expect(laneFolderIds("/w/r")).toEqual(["/w/r"]);
    expect(laneFolderIds("/w/r.lucid-worktrees/a-1")).toEqual(["/w/r.lucid-worktrees/a-1", "/w/r"]);
    expect(laneSourceFolders([lane("1", "/w/a", "working"), lane("2", "/w/b", "stopped"), lane("3", "", "done")])).toEqual(["/w/a"]);
  });
  it("reports a turn end on busy -> idle or a rising turn count, never on the first poll", () => {
    const first = laneTurnEnds(null, [lane("1", "/w/a", "working", 1)]);
    expect(first.ended).toEqual([]);
    const idle = laneTurnEnds(first.next, [lane("1", "/w/a", "awaiting-input", 1)]);
    expect(idle.ended).toEqual(["/w/a"]);
    const quick = laneTurnEnds(idle.next, [lane("1", "/w/a", "awaiting-input", 2)]); // a whole turn between polls
    expect(quick.ended).toEqual(["/w/a"]);
    const still = laneTurnEnds(quick.next, [lane("1", "/w/a", "awaiting-input", 2)]);
    expect(still.ended).toEqual([]);
    const fresh = laneTurnEnds(still.next, [lane("9", "/w/z", "awaiting-input", 3)]); // a new lane is not news
    expect(fresh.ended).toEqual([]);
  });
});
