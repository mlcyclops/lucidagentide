// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_build_model.test.ts - P-WORLDS.BUILD1 (ADR-0653): event-to-step mapping, template artifacts,
// the demo sample, keep and discard, build sites and templates from a world, tier budgets, and the popup's verdict
// handling (fail-closed) and iframe sandbox.

import { describe, expect, test } from "bun:test";
import {
  adoptArtifact, ART_ASPECT, ART_DEFAULT_W, ART_MIN_W, ARTIFACT_MAX_CHARS, fitArtWidth, ARTIFACT_SANDBOX, armSample, armTemplate, artifactOf, BUILD_MAX_PIECES, buildEvent, buildSiteFor, createBuildBook,
  DEFAULT_MINI_GAMES, DEFAULT_SITE_ANCHOR, demoSampleAt, demoSampleGames, discardArtifact, extractHtmlArtifact, frameAttrs, keepArtifact, MINI_GAMES_MAX,
  miniGamesFor, readVerdict, SAMPLE_MAX_BYTES, sampleArtifact, scaffoldBudget, validSample,
} from "./viz_build_model.ts";
import type { WorldDefinition } from "./viz_world_api.ts";
import { createDemo, DEMO_CYCLE_MS } from "./viz_demo.ts";
import { SAMPLE_MEMORY_CARDS, SAMPLE_TARGET_TAP } from "./viz_sample_games.ts";

/** What the demo's first build ends in (the host's first sample). */
const DEMO_GAME = demoSampleAt(null, 0);

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
  test("one build per demo agent a cycle, each ending in a labeled sample, rotating through the samples", () => {
    const d = createDemo(T);
    const b = createBuildBook();
    const revealed = new Set<string>();
    const titles: string[] = [];
    let turn = 0;
    for (let t = T; t < T + DEMO_CYCLE_MS; t += 100) {
      const st = d.step(t, t + 100);
      for (const e of st.events) for (const s of buildEvent(b, e.source, e.e, t)) if (s.kind === "reveal" && s.artifact) revealed.add(s.node);
      for (const e of st.builds) {
        if (e.e.type === "subagent") armSample(b, e.source, demoSampleAt(null, turn++));
        for (const s of buildEvent(b, e.source, e.e, t)) if (s.kind === "reveal" && s.artifact) { expect(s.artifact).toMatchObject({ demo: true, sample: true }); revealed.add(s.node); }
      }
    }
    for (const a of [...b.builds.values()].map((x) => x.artifact)) if (a) titles.push(a.title);
    expect([...revealed].sort()).toEqual(["demo-1", "demo-2", "demo-3", "demo-4", "demo-5", "demo-6"]);
    expect(new Set(titles)).toEqual(new Set(["Target tap game", "Memory cards game"]));
  });

  test("the host's two samples are small self-contained canvas games with a score, restart, keyboard and pointer", () => {
    for (const html of [SAMPLE_TARGET_TAP, SAMPLE_MEMORY_CARDS]) {
      expect(new TextEncoder().encode(html).byteLength).toBeLessThan(12 * 1024);
      expect(validSample(html)).toBe(html);
      expect(html).toMatch(/^<!doctype html>/);
      expect(html).toContain("<canvas");
      expect(html).toContain("data-ready");
      expect(html).toContain('id="start"');
      expect(html).toContain('id="restart"');
      expect(html).toContain("keydown");
      expect(html).toContain("pointerdown");
      expect(html).toContain("data-score");
      expect(html).toContain("devicePixelRatio");
      expect(html).not.toMatch(/https?:|src=|fetch\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage|import\(|eval\(/);
      expect(html).not.toMatch(/[^\x09\x0a\x0d\x20-\x7e]/); // plain ASCII: nothing for the scanner to flag
      expect(extractHtmlArtifact(`\`\`\`html\n${html}\n\`\`\``)).toBe(html);
    }
    expect(DEFAULT_MINI_GAMES.map((g) => g.sample)).toEqual([SAMPLE_TARGET_TAP, SAMPLE_MEMORY_CARDS]);
  });
});

describe("template samples (P-WORLDS.BUILD2)", () => {
  const def = (miniGames: unknown[]): WorldDefinition => ({ miniGames }) as unknown as WorldDefinition;
  const DOC = "<!doctype html><html><head><title>x</title></head><body><canvas></canvas><script>1</script></body></html>";

  test("validSample: a whole HTML document of at most 64 KB, trimmed; anything else is null", () => {
    expect(SAMPLE_MAX_BYTES).toBe(65536);
    expect(validSample(DOC)).toBe(DOC);
    expect(validSample(`  \n${DOC}\n `)).toBe(DOC);
    expect(validSample("<html><body>hi</body></html>")).toBe("<html><body>hi</body></html>");
    const big = `<!doctype html><html><body>${"x".repeat(SAMPLE_MAX_BYTES)}</body></html>`;
    const wide = `<!doctype html><html><body>${"\u00e9".repeat(SAMPLE_MAX_BYTES / 2)}</body></html>`; // under 64 K chars, over 64 KB
    for (const bad of [undefined, null, 42, {}, "", "   ", "<div>a fragment</div>", "<script>1</script>", "```html\n<html><body></body></html>\n```",
      "<!doctype html><html><body>no end", "<html></html>", "text before <html><body></body></html>", big, wide]) {
      expect(validSample(bad)).toBeNull();
    }
  });

  test("a malformed sample is dropped and its template stays; a valid one is kept", () => {
    const games = miniGamesFor(def([
      { id: "a", label: "A", brief: "Build A.", sample: DOC },
      { id: "b", label: "B", brief: "Build B.", sample: "<div>not a document</div>" },
      { id: "c", label: "C", brief: "Build C.", sample: 7 },
    ]));
    expect(games.map((g) => g.id)).toEqual(["a", "b", "c"]);
    expect(games[0]!.sample).toBe(DOC);
    expect(games[1]).not.toHaveProperty("sample");
    expect(games[2]).not.toHaveProperty("sample");
  });

  test("demo rotation: the world's samples in order, wrapping; none valid falls back to the host's", () => {
    const d = def([
      { id: "a", label: "A", brief: "x", sample: DOC },
      { id: "b", label: "B", brief: "x" },
      { id: "c", label: "C", brief: "x", sample: DOC.replace("x", "y") },
    ]);
    expect(demoSampleGames(d).map((g) => g.id)).toEqual(["a", "c"]);
    expect([0, 1, 2, 3, -1].map((i) => demoSampleAt(d, i).id)).toEqual(["a", "c", "a", "c", "c"]);
    expect(demoSampleAt(d, 1)).toEqual({ id: "c", title: "C", html: DOC.replace("x", "y") });
    const none = def([{ id: "a", label: "A", brief: "x", sample: "<b>bad</b>" }]);
    expect(demoSampleGames(none)).toBe(DEFAULT_MINI_GAMES);
    expect(demoSampleGames(null)).toBe(DEFAULT_MINI_GAMES);
    expect([0, 1, 2].map((i) => demoSampleAt(null, i).id)).toEqual(["target-tap", "memory-cards", "target-tap"]);
  });

  test("Play sample: a labeled sample artifact off the node until Keep adopts it", () => {
    const b = createBuildBook();
    expect(sampleArtifact(b, N, { id: "a", label: "A", brief: "x" }, T)).toBeNull();
    expect(sampleArtifact(b, N, { id: "a", label: "A", brief: "x", sample: "<div>bad</div>" }, T)).toBeNull();
    const a = sampleArtifact(b, N, DEFAULT_MINI_GAMES[1]!, T)!;
    expect(a).toMatchObject({ node: N, title: "Memory cards game", html: SAMPLE_MEMORY_CARDS, demo: false, sample: true, kept: false });
    expect(artifactOf(b, N)).toBeNull();
    expect(adoptArtifact(b, a)).toBe(a);
    expect(artifactOf(b, N)).toMatchObject({ id: a.id, kept: true });
    buildEvent(b, N, { type: "subagent", assignments: ["x"] } as never, T); // a new build keeps a kept artifact
    expect(artifactOf(b, N)?.id).toBe(a.id);
  });

  test("the popup's game area: 16:10, within the room, at least the minimum when it fits", () => {
    expect(ART_ASPECT).toBe(1.6);
    expect(fitArtWidth(ART_DEFAULT_W, 2000, 2000)).toBe(640);
    expect(fitArtWidth(900, 2000, 400)).toBe(640); // 400 tall at 16:10
    expect(fitArtWidth(900, 500, 2000)).toBe(500);
    expect(fitArtWidth(100, 2000, 2000)).toBe(ART_MIN_W);
    expect(fitArtWidth(100, 250, 2000)).toBe(250); // a tiny window: the room wins over the minimum
    expect(fitArtWidth(Number.NaN, 2000, 2000)).toBe(ART_DEFAULT_W);
    expect(fitArtWidth(500, -10, 300)).toBe(0);
  });

  test("an agent-built artifact is not a sample", () => {
    const b = createBuildBook();
    armTemplate(b, N, { id: "tap", label: "Tap" }, false, T);
    buildEvent(b, N, { type: "token", text: GAME } as never, T);
    buildEvent(b, N, { type: "done" } as never, T);
    expect(artifactOf(b, N)).toMatchObject({ demo: false, sample: false });
  });
});
