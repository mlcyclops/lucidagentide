// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/viz_artifact_gate.test.ts - P-WORLDS.BUILD1 (ADR-0653): the artifact gate is fail-closed (a scan that
// throws, answers nothing or answers malformed blocks; a blocked artifact is never stored or served), the store
// expires and caps, and the served frame carries the ADR's CSP with the artifact in a sandboxed srcdoc child.

import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_GONE_DOC, artifactFrameDoc, artifactFrameHeaders, artifactShapeProblem, gateVizArtifact, VIZ_ARTIFACT_CSP, VIZ_ARTIFACT_KEEP, VIZ_ARTIFACT_MAX_CHARS,
  VIZ_ARTIFACT_SANDBOX, VIZ_ARTIFACT_TTL_MS, VizArtifactStore,
} from "./viz_artifact_gate.ts";
import { SAMPLE_AGENT_RUNNER, SAMPLE_MEMORY_CARDS, SAMPLE_TARGET_TAP } from "./renderer/viz_sample_games.ts";
import { DEFAULT_MINI_GAMES, SAMPLE_MAX_BYTES, validSample } from "./renderer/viz_build_model.ts";

const DEMO_GAME = { html: SAMPLE_TARGET_TAP };

const pass = async (): Promise<{ block: boolean; reason: string }> => ({ block: false, reason: "" });

describe("gateVizArtifact (fail-closed)", () => {
  test("a clean HTML game passes (every host sample)", async () => {
    expect(await gateVizArtifact(DEMO_GAME.html, pass)).toEqual({ ok: true });
    for (const g of DEFAULT_MINI_GAMES) expect(await gateVizArtifact(g.sample, pass)).toEqual({ ok: true });
  });

  test("P-WORLDS.GAMES3: every host sample is a whole document under the cap with no network, storage, eval, frame or external URL", () => {
    expect(DEFAULT_MINI_GAMES.map((g) => g.sample)).toEqual([SAMPLE_TARGET_TAP, SAMPLE_MEMORY_CARDS, SAMPLE_AGENT_RUNNER]);
    for (const { sample } of DEFAULT_MINI_GAMES) {
      const html = sample!;
      expect(validSample(html)).toBe(html);
      expect(new TextEncoder().encode(html).byteLength).toBeLessThanOrEqual(SAMPLE_MAX_BYTES);
      expect(html.length).toBeLessThanOrEqual(VIZ_ARTIFACT_MAX_CHARS);
      expect(html).not.toMatch(/\bfetch\b|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB|document\.cookie|<iframe|\beval\s*\(|new Function|import\s*\(/i);
      expect(html).not.toMatch(/\b(src|href|action|srcset)\s*=/i);
      expect(html).not.toMatch(/https?:|\/\/[a-z0-9.-]+\.[a-z]{2,}|url\s*\(/i);
    }
  });

  test("a scanner block blocks, with its reason", async () => {
    const v = await gateVizArtifact(DEMO_GAME.html, async () => ({ block: true, reason: "bidi-control at 120" }));
    expect(v).toEqual({ ok: false, reason: "the security scan blocked it: bidi-control at 120" });
  });

  test("a scan that throws, or answers nothing or malformed, blocks", async () => {
    const throws = await gateVizArtifact(DEMO_GAME.html, async () => { throw new Error("sidecar dead"); });
    expect(throws.ok).toBe(false);
    if (!throws.ok) expect(throws.reason).toContain("fail-closed");
    for (const bad of [null, undefined, {}, { block: "no" }, "pass"]) {
      const v = await gateVizArtifact(DEMO_GAME.html, async () => bad as never);
      expect(v.ok).toBe(false);
    }
  });

  test("shape problems block before any scan", async () => {
    let scanned = 0;
    const count = async (): Promise<{ block: boolean; reason: string }> => { scanned++; return { block: false, reason: "" }; };
    for (const bad of [undefined, 42, "", "   ", "just some words", `<div>${"x".repeat(VIZ_ARTIFACT_MAX_CHARS)}</div>`]) {
      expect((await gateVizArtifact(bad, count)).ok).toBe(false);
      expect(artifactShapeProblem(bad)).not.toBeNull();
    }
    expect(scanned).toBe(0);
  });
});

describe("VizArtifactStore", () => {
  test("ids are minted, expire after the TTL, and can be dropped", () => {
    let now = 0, n = 0;
    const s = new VizArtifactStore(() => now, () => `id-${++n}`);
    const a = s.put("<div>a</div>");
    expect(s.get(a)).toBe("<div>a</div>");
    expect(s.get("nope")).toBeNull();
    now = VIZ_ARTIFACT_TTL_MS + 1;
    expect(s.get(a)).toBeNull();
    const b = s.put("<div>b</div>");
    expect(s.drop(b)).toBe(true);
    expect(s.get(b)).toBeNull();
  });

  test("the oldest goes past the cap", () => {
    let n = 0;
    const s = new VizArtifactStore(() => 0, () => `id-${++n}`);
    const first = s.put("<div>0</div>");
    for (let i = 1; i <= VIZ_ARTIFACT_KEEP; i++) s.put(`<div>${i}</div>`);
    expect(s.get(first)).toBeNull();
    expect(s.get(`id-${VIZ_ARTIFACT_KEEP + 1}`)).toBe(`<div>${VIZ_ARTIFACT_KEEP}</div>`);
  });

  test("the default ids are unguessable UUIDs", () => {
    const s = new VizArtifactStore();
    expect(s.put("<div>x</div>")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("the served frame", () => {
  test("the ADR's CSP: nothing but inline script and style, no network", () => {
    expect(VIZ_ARTIFACT_CSP).toContain("default-src 'none'");
    expect(VIZ_ARTIFACT_CSP).toContain("script-src 'unsafe-inline'");
    expect(VIZ_ARTIFACT_CSP).toContain("style-src 'unsafe-inline'");
    expect(VIZ_ARTIFACT_CSP).not.toMatch(/connect-src|img-src|https?:|\*|'self'|unsafe-eval/);
    const h = artifactFrameHeaders();
    expect(h["content-security-policy"]).toBe(VIZ_ARTIFACT_CSP);
    expect(h["cache-control"]).toBe("no-store");
    expect(h["x-content-type-options"]).toBe("nosniff");
  });

  test("the artifact sits in a srcdoc child sandboxed to scripts only, attribute-escaped", () => {
    expect(VIZ_ARTIFACT_SANDBOX).toBe("allow-scripts");
    const evil = `<div>"></iframe><script>parent.x=1</script>&amp;</div>`;
    const doc = artifactFrameDoc(evil);
    expect(doc).toContain(`sandbox="allow-scripts"`);
    expect(doc).not.toContain("allow-same-origin");
    expect(doc).toContain("srcdoc=\"&lt;div&gt;&quot;&gt;&lt;/iframe&gt;&lt;script&gt;parent.x=1&lt;/script&gt;&amp;amp;&lt;/div&gt;\"");
    expect(doc.match(/<iframe/g)?.length).toBe(1);
    expect(doc.match(/<script/g)).toBeNull(); // the shell runs nothing of its own
    expect(ARTIFACT_GONE_DOC).not.toContain("<script");
  });
});
