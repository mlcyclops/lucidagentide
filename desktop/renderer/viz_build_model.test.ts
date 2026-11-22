// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_build_model.test.ts - P-WORLDS.BUILD1 (ADR-0653): event-to-step mapping, template artifacts,
// the demo sample, keep and discard, build sites and templates from a world, tier budgets, and the popup's verdict
// handling (fail-closed) and iframe sandbox.

import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_MAX_CHARS, ARTIFACT_SANDBOX, armSample, armTemplate, artifactOf, BUILD_MAX_PIECES, buildEvent, buildSiteFor, createBuildBook, DEFAULT_MINI_GAMES,
  DEFAULT_SITE_ANCHOR, discardArtifact, extractHtmlArtifact, frameAttrs, keepArtifact, MINI_GAMES_MAX, miniGamesFor, readVerdict, scaffoldBudget,
} from "./viz_build_model.ts";
import type { WorldDefinition } from "./viz_world_api.ts";
import { createDemo, DEMO_CYCLE_MS, DEMO_GAME } from "./viz_demo.ts";

const N = "lane-1";
const T = 1_000_000;
const GAME = "```html\n<!doctype html><html><body><button>Go</button><script>1</script></body></html>\n```";

describe("event to build step mapping", () => {
  test("a subagent spawn adds one piece per assignment", () => {
    const b = createBuildBook();
    expect(buildEvent(b, N, { type: "subagent", assignments: ["a", "b", "c"] } as never, T)).toEqual([{ kind: "add", node: N, count: 3 }]);
    expect(buildEvent(b, N, { type: "subagent" } as never, T)).toEqual([{ kind: "add", node: N, count: 1 }]);
    expect(b.builds.get(N)!.pieces).toBe(4);
  });

  test("pieces cap at BUILD_MAX_PIECES", () => {
    const b = createBuildBook();
    buildEvent(b, N, { type: "subagent", assignments: Array.from({ length: 20 }, (_, i) => `a${i}`) } as never, T);
    expect(b.builds.get(N)!.pieces).toBe(BUILD_MAX_PIECES);
    expect(buildEvent(b, N, { type: "subagent", assignments: ["more"] } as never, T)).toEqual([]);
  });

  test("a lane's tool done locks a piece; a failed one flickers; nothing to lock does nothing", () => {
    const b = createBuildBook();
    expect(buildEvent(b, N, { type: "tool", id: "t0", status: "done" } as never, T)).toEqual([]); // no build yet
    buildEvent(b, N, { type: "subagent", assignments: ["a", "b"] } as never, T);
    expect(buildEvent(b, N, { type: "tool", id: "t1", status: "done" } as never, T)).toEqual([{ kind: "lock", node: N }]);
    expect(buildEvent(b, N, { type: "tool", id: "t2", status: "failed" } as never, T)).toEqual([{ kind: "fail", node: N }]);
    expect(buildEvent(b, N, { type: "tool", id: "t3", status: "done" } as never, T)).toEqual([{ kind: "lock", node: N }]);
    expect(buildEvent(b, N, { type: "tool", id: "t4", status: "done" } as never, T)).toEqual([]); // all locked
    expect(b.builds.get(N)).toMatchObject({ pieces: 2, locked: 2, failed: 1 });
  });

  test("Main settles with tool-meta; a call settled twice locks once", () => {
    const b = createBuildBook();
    buildEvent(b, "main", { type: "subagent", assignments: ["a", "b"] } as never, T);
    expect(buildEvent(b, "main", { type: "tool-meta", id: "m1", ok: true } as never, T)).toEqual([{ kind: "lock", node: "main" }]);
    expect(buildEvent(b, "main", { type: "tool", id: "m1", status: "done" } as never, T)).toEqual([]);
    expect(buildEvent(b, "main", { type: "tool-meta", id: "m2", ok: false } as never, T)).toEqual([{ kind: "fail", node: "main" }]);
    expect(buildEvent(b, "main", { type: "tool-meta", id: "m3" } as never, T)).toEqual([]); // no verdict yet
  });

  test("done reveals a build in progress; a revealed build starts over on the next spawn", () => {
    const b = createBuildBook();
    expect(buildEvent(b, N, { type: "done" } as never, T)).toEqual([]); // nothing building
    buildEvent(b, N, { type: "subagent", assignments: ["a"] } as never, T);
    expect(buildEvent(b, N, { type: "done" } as never, T)).toEqual([{ kind: "reveal", node: N, artifact: null }]);
    expect(buildEvent(b, N, { type: "done" } as never, T)).toEqual([]);
    expect(buildEvent(b, N, { type: "tool", id: "x", status: "done" } as never, T)).toEqual([]); // nothing to lock once revealed
    expect(buildEvent(b, N, { type: "subagent", assignments: ["a", "b"] } as never, T)).toEqual([{ kind: "reset", node: N }, { kind: "add", node: N, count: 2 }]);
  });

  test("a git commit (or push) settling reveals the build", () => {
    const b = createBuildBook();
    buildEvent(b, N, { type: "subagent", assignments: ["a", "b"] } as never, T);
    buildEvent(b, N, { type: "tool", id: "c1", input: 'git commit -m "x"', status: "open" } as never, T);
    expect(buildEvent(b, N, { type: "tool", id: "c1", status: "done" } as never, T)).toEqual([{ kind: "reveal", node: N, artifact: null }]);
    const m = createBuildBook();
    buildEvent(m, "main", { type: "subagent", assignments: ["a"] } as never, T);
    buildEvent(m, "main", { type: "tool", id: "e1", input: 'await d.commit("docs", [])' } as never, T);
    expect(buildEvent(m, "main", { type: "tool-meta", id: "e1", ok: true } as never, T)[0]?.kind).toBe("reveal");
  });

  test("an error fails a piece and drops a template run", () => {
    const b = createBuildBook();
    armTemplate(b, N, { id: "g", label: "Game" }, false, T);
    buildEvent(b, N, { type: "subagent", assignments: ["a"] } as never, T);
    expect(buildEvent(b, N, { type: "error", message: "boom" } as never, T)).toEqual([{ kind: "fail", node: N }]);
    expect(b.builds.get(N)!.template).toBeNull();
  });
});

describe("artifacts", () => {
  test("only a template run's output becomes an artifact", () => {
    const b = createBuildBook();
    buildEvent(b, N, { type: "subagent", assignments: ["a"] } as never, T);
    buildEvent(b, N, { type: "token", text: GAME } as never, T); // no template armed: ignored
    expect(buildEvent(b, N, { type: "done" } as never, T)).toEqual([{ kind: "reveal", node: N, artifact: null }]);

    const c = createBuildBook();
    armTemplate(c, N, { id: "tap", label: "Target tap" }, false, T);
    buildEvent(c, N, { type: "token", text: "Here it is:\n" } as never, T);
    buildEvent(c, N, { type: "token", text: GAME } as never, T);
    const steps = buildEvent(c, N, { type: "done" } as never, T + 5);
    expect(steps.map((s) => s.kind)).toEqual(["add", "reveal"]); // no subagents: one piece, then the reveal
    const art = artifactOf(c, N)!;
    expect(art).toMatchObject({ node: N, title: "Target tap", demo: false, kept: false });
    expect(art.html.startsWith("<!doctype html>")).toBe(true);
    expect(c.builds.get(N)!.template).toBeNull();
  });

  test("a staged template lets the running turn end first", () => {
    const b = createBuildBook();
    armTemplate(b, N, { id: "tap", label: "Tap" }, true, T);
    buildEvent(b, N, { type: "token", text: "old turn" } as never, T);
    expect(buildEvent(b, N, { type: "done" } as never, T)).toEqual([]);
    buildEvent(b, N, { type: "token", text: GAME } as never, T);
    expect(buildEvent(b, N, { type: "done" } as never, T).at(-1)).toMatchObject({ kind: "reveal" });
    expect(artifactOf(b, N)?.title).toBe("Tap");
  });

  test("a run without HTML reveals with no artifact", () => {
    const b = createBuildBook();
    armTemplate(b, N, { id: "tap", label: "Tap" }, false, T);
    buildEvent(b, N, { type: "token", text: "I could not build it." } as never, T);
    expect(buildEvent(b, N, { type: "done" } as never, T).at(-1)).toEqual({ kind: "reveal", node: N, artifact: null });
  });

  test("the demo sample comes only through armSample, labeled demo", () => {
    const b = createBuildBook();
    armSample(b, N, DEMO_GAME);
    buildEvent(b, N, { type: "subagent", assignments: ["a"] } as never, T);
    const s = buildEvent(b, N, { type: "done" } as never, T);
    expect(s.at(-1)).toMatchObject({ kind: "reveal", artifact: { demo: true, title: DEMO_GAME.title } });
  });

  test("keep survives a new build; discard empties the node", () => {
    const b = createBuildBook();
    armSample(b, N, DEMO_GAME);
    buildEvent(b, N, { type: "subagent", assignments: ["a"] } as never, T);
    buildEvent(b, N, { type: "done" } as never, T);
    const a = artifactOf(b, N)!;
    expect(keepArtifact(b, a.id)?.kept).toBe(true);
    buildEvent(b, N, { type: "subagent", assignments: ["a"] } as never, T);
    expect(artifactOf(b, N)?.id).toBe(a.id);
    expect(discardArtifact(b, a.id)).toEqual([{ kind: "reset", node: N }]);
    expect(artifactOf(b, N)).toBeNull();
    expect(discardArtifact(b, "nope")).toEqual([]);
  });

  test("an unkept artifact goes when the next build starts", () => {
    const b = createBuildBook();
    armSample(b, N, DEMO_GAME);
    buildEvent(b, N, { type: "subagent", assignments: ["a"] } as never, T);
    buildEvent(b, N, { type: "done" } as never, T);
    buildEvent(b, N, { type: "subagent", assignments: ["a"] } as never, T);
    expect(artifactOf(b, N)).toBeNull();
  });

  test("extractHtmlArtifact: the last html block, else a whole document; nothing else", () => {
    expect(extractHtmlArtifact("```html\n<div>one</div>\n```\n```html\n<div>two</div>\n```")).toBe("<div>two</div>");
    expect(extractHtmlArtifact("x <!DOCTYPE html><html><body><canvas></canvas></body></html> y")).toBe("<!DOCTYPE html><html><body><canvas></canvas></body></html>");
    expect(extractHtmlArtifact("```js\nalert(1)\n```")).toBeNull();
    expect(extractHtmlArtifact("```html\njust words\n```")).toBeNull();
    expect(extractHtmlArtifact(`\`\`\`html\n<div>${"x".repeat(ARTIFACT_MAX_CHARS)}</div>\n\`\`\``)).toBeNull();
  });
});

describe("the popup's gate verdict (fail-closed) and sandbox", () => {
  test("only an explicit pass with a well-formed id passes", () => {
    expect(readVerdict({ ok: true, id: "0b9f6c2e-1a2b-4c3d-8e9f-0a1b2c3d4e5f", trust: "untrusted" })).toEqual({ state: "pass", frameId: "0b9f6c2e-1a2b-4c3d-8e9f-0a1b2c3d4e5f" });
    expect(readVerdict({ ok: false, reason: "the security scan blocked it: bidi-control" })).toEqual({ state: "blocked", reason: "the security scan blocked it: bidi-control" });
    for (const bad of [null, undefined, "pass", 1, {}, { ok: true }, { ok: true, id: "../../etc" }, { ok: "true", id: "0b9f6c2e1a2b4c3d" }]) {
      expect(readVerdict(bad).state).toBe("blocked");
    }
  });

  test("the iframe is sandboxed to scripts only, never same-origin, with no referrer or permissions", () => {
    const a = frameAttrs("0b9f6c2e-1a2b-4c3d-8e9f-0a1b2c3d4e5f", "tok en");
    expect(ARTIFACT_SANDBOX).toBe("allow-scripts");
    expect(a.sandbox).toBe("allow-scripts");
    expect(a.sandbox).not.toContain("allow-same-origin");
    expect(a.referrerpolicy).toBe("no-referrer");
    expect(a.allow).toBe("");
    expect(a.src).toBe("/api/viz/artifact/frame?id=0b9f6c2e-1a2b-4c3d-8e9f-0a1b2c3d4e5f&t=tok%20en");
    expect(a).not.toHaveProperty("srcdoc"); // the artifact never sits under this page's CSP
  });
});

describe("build sites, templates and budgets", () => {
  const def = (extra: Record<string, unknown>): WorldDefinition => ({ environment: { edges: { colorA: "#123456" } }, ...extra }) as unknown as WorldDefinition;

  test("no world, or a world without sites: the default ring beside the stage", () => {
    expect(buildSiteFor(null, "agent", "#8fe3ff")).toEqual({ anchor: DEFAULT_SITE_ANCHOR, style: "holo", color: "#8fe3ff", label: "Build ring" });
    expect(buildSiteFor(def({}), "hub", "#123456").label).toBe("Build ring");
  });

  test("the first site for the role; malformed fields fall back", () => {
    const d = def({ buildSites: [
      { roles: ["hub"], anchor: [0, 0, 1], style: "panels", label: "Throne" },
      { anchor: [9, 0, 0], style: "laser", color: "red", label: "  Pad  " },
    ] });
    expect(buildSiteFor(d, "hub", "#fff")).toEqual({ anchor: [0, 0, 1], style: "panels", color: "#fff", label: "Throne" });
    expect(buildSiteFor(d, "agent", "#fff")).toEqual({ anchor: DEFAULT_SITE_ANCHOR, style: "holo", color: "#fff", label: "Pad" });
  });

  test("templates: valid ones only, at most three, else the host's defaults", () => {
    expect(miniGamesFor(null)).toBe(DEFAULT_MINI_GAMES);
    const games = Array.from({ length: 5 }, (_, i) => ({ id: `g${i}`, label: `Game ${i}`, brief: "Build it." }));
    expect(miniGamesFor(def({ miniGames: [...games, { id: "Bad Id", label: "x", brief: "y" }] })).map((g) => g.id)).toEqual(["g0", "g1", "g2"]);
    expect(MINI_GAMES_MAX).toBe(3);
    expect(miniGamesFor(def({ miniGames: [{ id: "a", label: "", brief: "x" }, { id: "a", label: "A", brief: "" }] }))).toBe(DEFAULT_MINI_GAMES);
    for (const g of DEFAULT_MINI_GAMES) expect(g.brief).toContain("```html");
  });

  test("budgets grow with the tier; unknown tiers read as full", () => {
    const order = ["minimal", "reduced", "full", "ultra", "cinematic"].map(scaffoldBudget);
    for (let i = 1; i < order.length; i++) {
      expect(order[i]!.pieces).toBeGreaterThanOrEqual(order[i - 1]!.pieces);
      expect(order[i]!.ringSegments).toBeGreaterThan(order[i - 1]!.ringSegments);
    }
    expect(scaffoldBudget("minimal")).toMatchObject({ beams: 0, panels: 0 });
    expect(scaffoldBudget("ultra").pieces).toBe(BUILD_MAX_PIECES);
    expect(scaffoldBudget("someday")).toEqual(scaffoldBudget("full"));
  });
});

describe("the demo feed's builds", () => {
  test("one build per demo agent a cycle, each ending in the labeled sample", () => {
    const d = createDemo(T);
    const b = createBuildBook();
    const revealed = new Set<string>();
    for (let t = T; t < T + DEMO_CYCLE_MS; t += 100) {
      const st = d.step(t, t + 100);
      for (const e of st.events) for (const s of buildEvent(b, e.source, e.e, t)) if (s.kind === "reveal" && s.artifact) revealed.add(s.node);
      for (const e of st.builds) {
        if (e.e.type === "subagent") armSample(b, e.source, DEMO_GAME);
        for (const s of buildEvent(b, e.source, e.e, t)) if (s.kind === "reveal" && s.artifact) { expect(s.artifact.demo).toBe(true); revealed.add(s.node); }
      }
    }
    expect([...revealed].sort()).toEqual(["demo-1", "demo-2", "demo-3", "demo-4", "demo-5", "demo-6"]);
  });

  test("the sample is a small self-contained game, labeled as a demo sample", () => {
    expect(DEMO_GAME.html.length).toBeLessThan(8 * 1024);
    expect(DEMO_GAME.title).toContain("demo sample");
    expect(DEMO_GAME.html).toContain("DEMO SAMPLE");
    expect(DEMO_GAME.html).not.toMatch(/https?:|src=|fetch\(|XMLHttpRequest|WebSocket|localStorage/);
    expect(extractHtmlArtifact(`\`\`\`html\n${DEMO_GAME.html}\n\`\`\``)).toBe(DEMO_GAME.html);
  });
});
