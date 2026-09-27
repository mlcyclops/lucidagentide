// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/checkout_owners.test.ts - P-OWN.1: ownership ledger, peers view and briefing text.

import { describe, expect, test } from "bun:test";
import { CheckoutOwners, briefing, normalizeCheckoutPath, peersView } from "./checkout_owners.ts";

const ME = { id: "master", name: "Hub" };
const A = { id: "lane-a", name: "Alpha" };
const B = { id: "lane-b", name: "Bravo" };

describe("normalizeCheckoutPath", () => {
  test("win32: backslashes become slashes, case folds, trailing slash dropped", () => {
    expect(normalizeCheckoutPath("C:\\Users\\Me\\Repo\\", "win32")).toBe("c:/users/me/repo");
    expect(normalizeCheckoutPath("C:\\Users\\Me\\Repo\\src\\A.ts", "win32")).toBe("c:/users/me/repo/src/a.ts");
  });

  test("posix: separators normalized, case preserved", () => {
    expect(normalizeCheckoutPath("/home/Me/Repo/", "linux")).toBe("/home/Me/Repo");
    expect(normalizeCheckoutPath("/home//Me///Repo/src/A.ts", "linux")).toBe("/home/Me/Repo/src/A.ts");
  });

  test("roots and UNC prefixes survive", () => {
    expect(normalizeCheckoutPath("/", "linux")).toBe("/");
    expect(normalizeCheckoutPath("C:\\", "win32")).toBe("c:/");
    expect(normalizeCheckoutPath("\\\\nas\\share\\repo\\", "win32")).toBe("//nas/share/repo");
  });
});

describe("CheckoutOwners", () => {
  test("record then owner, keyed by normalized path on win32", () => {
    const o = new CheckoutOwners("win32");
    o.record("C:\\repo", "C:\\repo\\src\\A.ts", A, 10);
    expect(o.owner("c:/repo/", "c:/repo/src/a.ts")).toEqual(A);
    expect(o.owner("c:/repo", "c:/repo/src/b.ts")).toBeNull();
    expect(o.ownedBy("C:/repo", A.id)).toEqual(["c:/repo/src/a.ts"]);
  });

  test("posix keeps case distinct", () => {
    const o = new CheckoutOwners("linux");
    o.record("/repo", "/repo/A.ts", A, 1);
    expect(o.owner("/repo", "/repo/a.ts")).toBeNull();
    expect(o.owner("/repo", "/repo/A.ts")).toEqual(A);
  });

  test("last writer wins and keeps its own timestamp", () => {
    const o = new CheckoutOwners("linux");
    o.record("/repo", "/repo/x.ts", A, 1);
    o.record("/repo", "/repo/x.ts", B, 2);
    expect(o.owner("/repo", "/repo/x.ts")).toEqual(B);
    expect(o.owners("/repo").get("/repo/x.ts")).toEqual({ ...B, at: 2 });
    expect(o.ownedBy("/repo", A.id)).toEqual([]);
  });

  test("release drops the listed paths; releaseAll drops the root", () => {
    const o = new CheckoutOwners("linux");
    o.record("/repo", "/repo/a.ts", A, 1);
    o.record("/repo", "/repo/b.ts", A, 2);
    o.record("/other", "/other/c.ts", A, 3);
    o.release("/repo", ["/repo/a.ts", "/repo/never-recorded.ts"]);
    expect(o.ownedBy("/repo", A.id)).toEqual(["/repo/b.ts"]);
    o.releaseAll("/repo");
    expect(o.owners("/repo").size).toBe(0);
    expect(o.ownedBy("/other", A.id)).toEqual(["/other/c.ts"]);
  });

  test("owners() returns a fresh snapshot", () => {
    const o = new CheckoutOwners("linux");
    o.record("/repo", "/repo/a.ts", A, 1);
    const snap = o.owners("/repo");
    snap.delete("/repo/a.ts");
    expect(o.owner("/repo", "/repo/a.ts")).toEqual(A);
  });
});

describe("peersView", () => {
  test("omits me, lists dirty-file owners, running peers without files, and unowned", () => {
    const owners = new CheckoutOwners("linux");
    owners.record("/repo", "/repo/src/mine.ts", ME, 1);
    owners.record("/repo", "/repo/src/b.ts", A, 2);
    owners.record("/repo", "/repo/src/a.ts", A, 3);
    owners.record("/repo", "/repo/clean.ts", B, 4); // recorded but no longer dirty
    const view = peersView({
      root: "/repo",
      me: ME,
      dirtyRel: ["src/mine.ts", "src/b.ts", "src/a.ts", "README.md", "zeta.ts"],
      owners,
      sessions: [
        { id: ME.id, name: ME.name, task: "hub work", running: true },
        { id: A.id, name: A.name, task: "parser refactor", running: false },
        { id: B.id, name: B.name, task: "docs", running: false },
        { id: "lane-c", name: "Charlie", task: "fresh lane", running: true },
      ],
      platform: "linux",
    });
    expect(view.peers).toEqual([
      { id: A.id, name: A.name, task: "parser refactor", running: false, files: ["src/a.ts", "src/b.ts"] },
      { id: "lane-c", name: "Charlie", task: "fresh lane", running: true, files: [] },
    ]);
    expect(view.unowned).toEqual(["README.md", "zeta.ts"]);
  });

  test("owner missing from sessions still appears with the ledger name", () => {
    const owners = new CheckoutOwners("linux");
    owners.record("/repo", "/repo/x.ts", A, 1);
    const view = peersView({ root: "/repo", me: ME, dirtyRel: ["x.ts"], owners, sessions: [], platform: "linux" });
    expect(view.peers).toEqual([{ id: A.id, name: A.name, task: "", running: false, files: ["x.ts"] }]);
  });

  test("win32: git's on-disk casing matches ledger keys, output keeps git's spelling", () => {
    const owners = new CheckoutOwners("win32");
    owners.record("C:\\Repo", "C:\\Repo\\Src\\File.ts", A, 1);
    const view = peersView({ root: "C:/Repo", me: ME, dirtyRel: ["Src/File.ts"], owners, sessions: [], platform: "win32" });
    expect(view.peers[0]?.files).toEqual(["Src/File.ts"]);
    expect(view.unowned).toEqual([]);
  });

  test("unowned is capped at 40", () => {
    const owners = new CheckoutOwners("linux");
    const dirtyRel = Array.from({ length: 50 }, (_, i) => `f${String(i).padStart(2, "0")}.ts`);
    const view = peersView({ root: "/repo", me: ME, dirtyRel, owners, sessions: [], platform: "linux" });
    expect(view.unowned.length).toBe(40);
    expect(view.unowned[0]).toBe("f00.ts");
    expect(view.peers).toEqual([]);
  });
});

describe("briefing", () => {
  const peer = (id: string, name: string, files: string[], running = false, task = "some task") => ({ id, name, task, running, files });

  test("empty when there are no peers and no unowned files", () => {
    expect(briefing({ peers: [], unowned: [] })).toBe("");
  });

  test("names peers, state, task, files and the rules; no em or en dashes", () => {
    const text = briefing({
      root: "/repo",
      me: ME,
      peers: [peer(A.id, A.name, ["src/a.ts", "src/b.ts"], true, "parser refactor"), peer("lane-c", "Charlie", [], true, "")],
      unowned: ["README.md"],
    });
    expect(text.startsWith("<checkout-peers>\n")).toBe(true);
    expect(text.endsWith("\n</checkout-peers>")).toBe(true);
    expect(text).toContain(`"Alpha" (lane-a), running, task: parser refactor`);
    expect(text).toContain("files: src/a.ts, src/b.ts");
    expect(text).toContain(`"Charlie" (lane-c), running`);
    expect(text).toContain("files: none");
    expect(text).toContain("README.md");
    expect(text).toContain("checkin_send");
    expect(text).toContain("git add -A");
    expect(text).not.toMatch(/[\u2013\u2014]/);
    expect(text.length).toBeLessThanOrEqual(900);
  });

  test("caps files at 12 and task at 160 chars", () => {
    const files = Array.from({ length: 15 }, (_, i) => `f${String(i).padStart(2, "0")}.ts`);
    const text = briefing({ peers: [peer(A.id, A.name, files, false, "x".repeat(200))], unowned: [] }, { maxChars: 2000 });
    expect(text).toContain("f11.ts (+3 more)");
    expect(text).not.toContain("f12.ts");
    expect(text).toContain(`${"x".repeat(157)}...`);
    expect(text).not.toContain("x".repeat(158));
  });

  test("shrinks to fit maxChars: files first, then tasks, then peers", () => {
    const files = Array.from({ length: 12 }, (_, i) => `src/some/long/path/file${i}.ts`);
    const peers = Array.from({ length: 6 }, (_, i) => peer(`lane-${i}`, `Lane ${i}`, files, true, "a fairly descriptive task summary for this lane"));
    const full = briefing({ peers, unowned: [] }, { maxChars: 100000 });
    expect(full).toContain("src/some/long/path/file0.ts");
    const mid = briefing({ peers, unowned: [] }, { maxChars: 1500 });
    expect(mid.length).toBeLessThanOrEqual(1500);
    expect(mid).toContain(`"Lane 5" (lane-5)`);
    expect(mid).toContain("file0.ts");
    expect(mid).toContain("(+9 more)");
    expect(mid).not.toContain("file3.ts");
    const tasksTrimmed = briefing({ peers, unowned: [] }, { maxChars: 1000 });
    expect(tasksTrimmed.length).toBeLessThanOrEqual(1000);
    expect(tasksTrimmed).toContain(`"Lane 5" (lane-5)`);
    expect(tasksTrimmed).toContain("12 files");
    const tight = briefing({ peers, unowned: [] }, { maxChars: 600 });
    expect(tight.length).toBeLessThanOrEqual(600);
    expect(tight).toMatch(/\+\d+ more sessions?\n/);
    expect(tight.endsWith("</checkout-peers>")).toBe(true);
    // Same input, same output.
    expect(briefing({ peers, unowned: [] }, { maxChars: 600 })).toBe(tight);
  });
});
