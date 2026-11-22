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
import { DEMO_GAME } from "./renderer/viz_demo.ts";

const pass = async (): Promise<{ block: boolean; reason: string }> => ({ block: false, reason: "" });

describe("gateVizArtifact (fail-closed)", () => {
  test("a clean HTML game passes", async () => {
    expect(await gateVizArtifact(DEMO_GAME.html, pass)).toEqual({ ok: true });
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
