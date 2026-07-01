// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/preview_extension.test.ts — P-PREVIEW.3a (ADR-0096, draft). Verifies the extension's LOGIC
// against a mock `pi` (the real omp registerTool/model-invocation is verified live). The load-bearing
// property: registration NEVER throws, so it can never break omp launch.

import { describe, expect, test } from "bun:test";
import previewExtension from "./preview_extension.ts";

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

describe("preview_extension (mock pi)", () => {
  test("registers a single `preview_open` tool with a path parameter", () => {
    const { pi, tools } = capture();
    previewExtension(pi);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("preview_open");
    expect(tools[0].parameters.required).toContain("path");
    expect(typeof tools[0].execute).toBe("function");
  });

  test("registers as a `read`-tier tool so opening a preview never trips the exec gate", () => {
    const { pi, tools } = capture();
    previewExtension(pi);
    expect(tools[0].approval).toBe("read");
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
