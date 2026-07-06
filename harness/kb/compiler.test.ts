// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/kb/compiler.test.ts — P-KB.1 (ADR-0099): the compile step's DEFENSIVE parse of untrusted model
// output. parseCompiled must never throw, must validate page kind/slug/title/body, dedupe slugs, keep
// only real non-self links, and cap counts; compileDocument must delimit the document as untrusted DATA.

import { describe, expect, test } from "bun:test";
import { compileDocument, COMPILE_SYSTEM, parseCompiled } from "./compiler.ts";

describe("parseCompiled — defensive parse", () => {
  test("parses valid pages + links and validates kinds/slugs", () => {
    const raw = JSON.stringify({
      pages: [
        { kind: "summary", slug: "doc-summary", title: "Doc — summary", body_md: "the gist" },
        { kind: "concept", slug: "Retrieval Augmentation", title: "RAG", body_md: "a concept" },
        { kind: "bogus", slug: "nope", title: "x", body_md: "y" }, // bad kind → dropped
      ],
      links: [{ from: "doc-summary", to: "retrieval-augmentation", relation: "mentions" }],
    });
    const out = parseCompiled(raw);
    expect(out.pages.map((p) => p.slug)).toEqual(["doc-summary", "retrieval-augmentation"]); // slugified + bad-kind dropped
    expect(out.links).toEqual([{ from: "doc-summary", to: "retrieval-augmentation", relation: "mentions" }]);
  });
  test("drops thin pages, dedupes slugs, and keeps only real non-self links", () => {
    const raw = JSON.stringify({
      pages: [
        { kind: "summary", slug: "a", title: "A", body_md: "body" },
        { kind: "concept", slug: "a", title: "dup", body_md: "dup body" }, // dup slug → dropped
        { kind: "concept", slug: "b", title: "", body_md: "x" }, // empty title → dropped
      ],
      links: [
        { from: "a", to: "ghost" }, // ghost endpoint → dropped
        { from: "a", to: "a" }, // self-link → dropped
      ],
    });
    const out = parseCompiled(raw);
    expect(out.pages.map((p) => p.slug)).toEqual(["a"]);
    expect(out.links).toEqual([]);
  });
  test("tolerates a ```json fence + surrounding prose", () => {
    const out = parseCompiled('sure:\n```json\n{"pages":[{"kind":"entity","slug":"acme","title":"Acme","body_md":"an org"}],"links":[]}\n```');
    expect(out.pages).toHaveLength(1);
    expect(out.pages[0]!.kind).toBe("entity");
  });
  test("garbage / empty / non-object never throws → empty output", () => {
    expect(parseCompiled("not json")).toEqual({ pages: [], links: [] });
    expect(parseCompiled("")).toEqual({ pages: [], links: [] });
    expect(parseCompiled('{"pages":"nope"}')).toEqual({ pages: [], links: [] });
    expect(parseCompiled("[1,2,3]")).toEqual({ pages: [], links: [] });
  });
});

describe("compileDocument — delimits the document as untrusted DATA", () => {
  test("wraps the source in trust-boundary markers and parses the model output", async () => {
    let sawSystem = "";
    let sawUser = "";
    const complete = async (system: string, user: string): Promise<string> => {
      sawSystem = system; sawUser = user;
      return JSON.stringify({ pages: [{ kind: "summary", slug: "s", title: "S", body_md: "gist" }], links: [] });
    };
    const out = await compileDocument("the document body text", complete);
    expect(sawSystem).toBe(COMPILE_SYSTEM);
    expect(sawUser).toContain("UNTRUSTED_CONTENT_START");
    expect(sawUser).toContain("the document body text");
    expect(sawUser.trimEnd().endsWith("UNTRUSTED_CONTENT_END")).toBe(true);
    expect(out.pages).toHaveLength(1);
  });
});
