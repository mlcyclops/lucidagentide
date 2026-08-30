// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/preview_extension.test.ts — P-PREVIEW.3a + .3a-shot (ADR-0096). Verifies the extension's LOGIC
// against a mock `pi` (the real omp registerTool + the model invoking/seeing tools is verified live). The
// load-bearing properties: registration NEVER throws (so it can never break omp launch) and it succeeds in
// BOTH schema modes - a healthy typebox shim, or plain JSON-Schema literals when the shim is absent/broken.

import { afterEach, describe, expect, test } from "bun:test";
import previewExtension, { normalizeToolPath, previewShotImage } from "./preview_extension.ts";

// Minimal TypeBox shim mirroring what omp injects as `pi.typebox`: Type.Object/String/Optional produce a
// standard JSON-schema object, with Optional-wrapped props left OUT of `required` (like real TypeBox, which
// omits an empty `required` entirely). The extension authors its parameters through this in typebox mode;
// the tests assert the shape that reaches registerTool.
const typebox = {
  Type: {
    Object: (properties: Record<string, any>) => {
      const required = Object.keys(properties).filter((k) => !properties[k]["~optional"]);
      return { type: "object", properties, ...(required.length ? { required } : {}) };
    },
    String: (opts: any = {}) => ({ type: "string", ...opts }),
    Optional: (schema: any) => ({ ...schema, "~optional": true }),
  },
};

function capture() {
  const tools: any[] = [];
  return { pi: { registerTool: (t: any) => tools.push(t), typebox }, tools };
}

const byName = (tools: any[], name: string) => tools.find((t) => t.name === name);
const ALL_TOOLS = ["preview_click", "preview_inspect", "preview_open", "preview_screenshot", "preview_type"];

describe("preview_extension (mock pi)", () => {
  test("typebox mode: registers ALL FIVE preview tools, every one read-tier, preview_open requires path", () => {
    const { pi, tools } = capture();
    previewExtension(pi);
    expect(tools.map((t) => t.name).sort()).toEqual(ALL_TOOLS);
    const open = byName(tools, "preview_open");
    expect(open.parameters.required).toContain("path");
    expect(typeof open.execute).toBe("function");
    for (const t of tools) expect(t.approval).toBe("read"); // never trips the exec gate
  });

  // THE proven bug: a shim whose Type lacks Optional threw "T.Optional is not a function" while registering
  // preview_inspect - swallowed by the outer catch, silently dropping tools. Now a malformed shim routes to
  // literal mode and all five still register.
  test("literal mode: a typebox shim MISSING Optional no longer drops the tools - all five register", () => {
    const tools: any[] = [];
    const broken = { Type: { Object: typebox.Type.Object, String: typebox.Type.String } }; // no Optional
    expect(() => previewExtension({ registerTool: (t: any) => tools.push(t), typebox: broken })).not.toThrow();
    expect(tools.map((t) => t.name).sort()).toEqual(ALL_TOOLS);
  });

  test("literal mode: absent typebox shim registers all five with a registrable JSON-Schema shape", () => {
    const tools: any[] = [];
    expect(() => previewExtension({ registerTool: (t: any) => tools.push(t) })).not.toThrow();
    expect(tools.map((t) => t.name).sort()).toEqual(ALL_TOOLS);
    for (const t of tools) {
      // What omp's rpc-mode requires of a tool schema: a non-array "JSON Schema object".
      expect(typeof t.parameters).toBe("object");
      expect(Array.isArray(t.parameters)).toBe(false);
      expect(t.parameters.type).toBe("object");
      expect(typeof t.parameters.properties).toBe("object");
    }
    // Structurally identical to what TypeBox emits: required props listed, optional props simply omitted.
    const open = byName(tools, "preview_open");
    expect(open.parameters).toEqual({
      type: "object",
      properties: { path: { type: "string", description: expect.stringContaining(".html/.svg") } },
      required: ["path"],
    });
    const inspect = byName(tools, "preview_inspect");
    expect(Object.keys(inspect.parameters.properties).sort()).toEqual(["selector", "what"]);
    expect(inspect.parameters.required).toBeUndefined(); // both optional -> empty required dropped entirely
    expect(byName(tools, "preview_type").parameters.required).toEqual(["selector", "text"]);
    expect(byName(tools, "preview_screenshot").parameters).toEqual({ type: "object", properties: {} });
  });

  test("execute accepts a local .html/.svg path (no error)", async () => {
    const { pi, tools } = capture();
    previewExtension(pi);
    const r = await tools[0].execute("id", { path: "C:/Users/n/game.html" });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain("game.html");
  });

  test("execute accepts a QUOTED or padded path (agents sometimes wrap paths in quotes)", async () => {
    const { pi, tools } = capture();
    previewExtension(pi);
    const open = byName(tools, "preview_open");
    const dq = await open.execute("id", { path: '"C:/Users/x/OneDrive/Apps AI Vibe/app.html"' });
    expect(dq.isError).toBeFalsy();
    expect(dq.content[0].text).toContain("app.html");
    const sq = await open.execute("id", { path: " 'C:\\Users\\n\\game.svg' " });
    expect(sq.isError).toBeFalsy();
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

describe("normalizeToolPath (quoted/padded agent paths)", () => {
  test("trims and strips matching surrounding quotes, even nested pairs", () => {
    expect(normalizeToolPath('  "C:/x/app.html"  ')).toBe("C:/x/app.html");
    expect(normalizeToolPath("'/home/n/app.html'")).toBe("/home/n/app.html");
    expect(normalizeToolPath("\"'C:/x/a.html'\"")).toBe("C:/x/a.html");
  });
  test("leaves unquoted / mismatched-quote paths alone; null-safe", () => {
    expect(normalizeToolPath("C:/x/app.html")).toBe("C:/x/app.html");
    expect(normalizeToolPath('"C:/x/app.html')).toBe('"C:/x/app.html');
    expect(normalizeToolPath(null)).toBe("");
    expect(normalizeToolPath(undefined)).toBe("");
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

// P-PREVIEW.11 (ADR-0308): preview_open must REPORT ITSELF to the desktop. The panel used to open only as a
// side effect of acp_backend matching "preview_open: <path>" in omp's ACP call title, which intent tracing
// shadows with the model's intent prose (and the ACP tool_call update carries no tool-name field at all, so
// no title/kind inspection can recover it). These tests pin the reporting channel and - just as important -
// that a missing or failing channel NEVER fails the tool: the panel simply does not surface, as before.
describe("preview_open execute (P-PREVIEW.11): the tool reports itself to the desktop", () => {
  const realFetch = globalThis.fetch;
  const realUrl = process.env.LUCID_PREVIEW_OPEN_URL;
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realUrl === undefined) delete process.env.LUCID_PREVIEW_OPEN_URL;
    else process.env.LUCID_PREVIEW_OPEN_URL = realUrl;
  });
  const openTool = () => { const { pi, tools } = capture(); previewExtension(pi); return byName(tools, "preview_open"); };
  const HTML = "C:/Users/n/OneDrive/Apps AI Vibe/proj/.omp/tmp/deck.html";

  test("POSTs the path to LUCID_PREVIEW_OPEN_URL and still returns the ack", async () => {
    process.env.LUCID_PREVIEW_OPEN_URL = "http://127.0.0.1:9/api/preview/open?t=x";
    const calls: { url: string; method: string; body: unknown }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), method: String(init?.method), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true, data: { opened: true } }), { headers: { "content-type": "application/json" } });
    }) as any;
    const r = await openTool().execute("id", { path: HTML });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toContain("/api/preview/open");
    // The PATH is what drives the panel, so it must survive verbatim - spaces and dot-dirs included.
    expect(calls[0]!.body).toEqual({ path: HTML });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain("deck.html");
  });

  test("a quoted path is normalized BEFORE it is reported (the desktop gets a usable path)", async () => {
    process.env.LUCID_PREVIEW_OPEN_URL = "http://127.0.0.1:9/api/preview/open?t=x";
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }) as any;
    await openTool().execute("id", { path: `"${HTML}"` });
    expect(bodies).toEqual([{ path: HTML }]);
  });

  test("no LUCID_PREVIEW_OPEN_URL (older desktop) - no fetch, no throw, ack unchanged", async () => {
    delete process.env.LUCID_PREVIEW_OPEN_URL;
    let fetched = false;
    globalThis.fetch = (async () => { fetched = true; return new Response("{}"); }) as any;
    const r = await openTool().execute("id", { path: HTML });
    expect(fetched).toBe(false);
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain("Preview panel");
  });

  test("a channel that REJECTS never fails the tool (the panel just does not surface)", async () => {
    process.env.LUCID_PREVIEW_OPEN_URL = "http://127.0.0.1:9/api/preview/open?t=x";
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as any;
    const r = await openTool().execute("id", { path: HTML });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain("deck.html");
  });

  test("an INVALID target is rejected without ever reporting it", async () => {
    process.env.LUCID_PREVIEW_OPEN_URL = "http://127.0.0.1:9/api/preview/open?t=x";
    let fetched = false;
    globalThis.fetch = (async () => { fetched = true; return new Response("{}"); }) as any;
    const r = await openTool().execute("id", { path: "https://example.com/app.html" });
    expect(r.isError).toBe(true);
    expect(fetched).toBe(false); // never ask the desktop to open something the gate already refused
  });
});
