// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/preview_extension.test.ts — P-PREVIEW.3a + .3a-shot (ADR-0096). Verifies the extension's LOGIC
// against a mock `pi` (the real omp registerTool + the model invoking/seeing tools is verified live). The
// load-bearing property: registration NEVER throws, so it can never break omp launch.

import { afterEach, describe, expect, test } from "bun:test";
import previewExtension, { previewShotImage } from "./preview_extension.ts";

// Minimal TypeBox shim mirroring what omp injects as `pi.typebox` (Type.Object/Type.String produce a
// standard JSON-schema-ish object). The extension authors its parameters through this; the test asserts
// the shape that reaches registerTool.
const typebox = {
  Type: {
    Object: (properties: Record<string, any>) => ({ type: "object", properties, required: Object.keys(properties) }),
    String: (opts: any = {}) => ({ type: "string", ...opts }),
  },
};

function capture() {
  const tools: any[] = [];
  return { pi: { registerTool: (t: any) => tools.push(t), typebox }, tools };
}

const byName = (tools: any[], name: string) => tools.find((t) => t.name === name);

describe("preview_extension (mock pi)", () => {
  test("registers preview_open (path param) and preview_screenshot, both read-tier", () => {
    const { pi, tools } = capture();
    previewExtension(pi);
    expect(tools.map((t) => t.name).sort()).toEqual(["preview_open", "preview_screenshot"]);
    const open = byName(tools, "preview_open");
    expect(open.parameters.required).toContain("path");
    expect(typeof open.execute).toBe("function");
    expect(open.approval).toBe("read");            // opening a preview never trips the exec gate
    expect(byName(tools, "preview_screenshot").approval).toBe("read");
  });

  test("never throws — and registers nothing — when the typebox shim is absent", () => {
    const tools: any[] = [];
    expect(() => previewExtension({ registerTool: (t: any) => tools.push(t) })).not.toThrow();
    expect(tools).toHaveLength(0); // no TSchema authoring → silent no-op, omp launch unaffected
  });

  test("execute accepts a local .html/.svg path (no error)", async () => {
    const { pi, tools } = capture();
    previewExtension(pi);
    const r = await tools[0].execute("id", { path: "C:/Users/n/game.html" });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain("game.html");
  });

  test("execute rejects a non-local or non-previewable path (isError)", async () => {
    const { pi, tools } = capture();
    previewExtension(pi);
    expect((await tools[0].execute("id", { path: "src/index.ts" })).isError).toBe(true);   // not previewable
    expect((await tools[0].execute("id", { path: "game.html" })).isError).toBe(true);       // not absolute/local
    expect((await tools[0].execute("id", { path: "" })).isError).toBe(true);                // empty
  });

  // The load-bearing safety property: registration can NEVER break omp launch.
  test("never throws — older omp without registerTool is a silent no-op", () => {
    expect(() => previewExtension({})).not.toThrow();
    expect(() => previewExtension(null)).not.toThrow();
  });
  test("never throws — a registerTool that rejects the schema is swallowed", () => {
    expect(() => previewExtension({ registerTool: () => { throw new Error("schema rejected"); } })).not.toThrow();
  });
});

describe("previewShotImage (P-PREVIEW.3a-shot): data-URL → ImageContent", () => {
  test("a valid PNG data URL → { type:'image', data, mimeType } (the shape the model sees)", () => {
    expect(previewShotImage("data:image/png;base64,AAAB")).toEqual({ type: "image", data: "AAAB", mimeType: "image/png" });
    expect(previewShotImage("data:image/jpeg;base64,QUJD")).toEqual({ type: "image", data: "QUJD", mimeType: "image/jpeg" });
  });
  test("non-image / malformed / empty → null (never a bogus image block)", () => {
    for (const bad of ["", null, undefined, "not a data url", "data:text/html;base64,AAAB", "data:image/png,AAAB", "data:image/png;base64,"]) {
      expect(previewShotImage(bad)).toBeNull();
    }
  });
});

describe("preview_screenshot execute (P-PREVIEW.3a-shot): fetch the cached shot → ImageContent", () => {
  const realFetch = globalThis.fetch;
  const realUrl = process.env.LUCID_PREVIEW_SHOT_URL;
  afterEach(() => { globalThis.fetch = realFetch; if (realUrl === undefined) delete process.env.LUCID_PREVIEW_SHOT_URL; else process.env.LUCID_PREVIEW_SHOT_URL = realUrl; });
  const shotTool = () => { const { pi, tools } = capture(); previewExtension(pi); return byName(tools, "preview_screenshot"); };

  test("returns an image block when a shot is cached", async () => {
    process.env.LUCID_PREVIEW_SHOT_URL = "http://127.0.0.1:9/api/preview/shot?t=x";
    globalThis.fetch = (async () => new Response(JSON.stringify({ png: "data:image/png;base64,ZZZZ" }), { headers: { "content-type": "application/json" } })) as any;
    const r = await shotTool().execute();
    expect(r.content[0]).toEqual({ type: "image", data: "ZZZZ", mimeType: "image/png" });
    expect(r.content[1].type).toBe("text");
    expect(r.isError).toBeFalsy();
  });
  test("no shot cached yet → helpful text, not an image", async () => {
    process.env.LUCID_PREVIEW_SHOT_URL = "http://127.0.0.1:9/api/preview/shot?t=x";
    globalThis.fetch = (async () => new Response(JSON.stringify({ png: null }), { headers: { "content-type": "application/json" } })) as any;
    const r = await shotTool().execute();
    expect(r.content[0].type).toBe("text");
    expect(r.content.some((c: any) => c.type === "image")).toBe(false);
  });
  test("no env URL (not in the desktop) → graceful text", async () => {
    delete process.env.LUCID_PREVIEW_SHOT_URL;
    const r = await shotTool().execute();
    expect(r.content[0].type).toBe("text");
  });
  test("a fetch that throws → graceful text (never throws out of execute)", async () => {
    process.env.LUCID_PREVIEW_SHOT_URL = "http://127.0.0.1:9/api/preview/shot?t=x";
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as any;
    const r = await shotTool().execute();
    expect(r.content[0].type).toBe("text");
  });
});
