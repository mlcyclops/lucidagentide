// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/browser_extension.test.ts - P-BROWSER.1: the agent-browser tool extension's LOGIC against
// a mock `pi` (the real omp registerTool, and the model actually seeing the tools, is verified live).
// Load-bearing properties: registration NEVER throws (it can never break omp launch), it succeeds in BOTH
// schema modes (healthy typebox shim, or plain JSON-Schema literals when the shim is absent or missing a
// constructor), the input tools validate their arguments BEFORE reaching the window, and only browser_open
// carries the gated tier so an iterate loop never re-prompts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import browserExtension, { browserEndpoint, browserShotImage } from "./browser_extension.ts";

const BASE = "http://127.0.0.1:5319/api/browser?t=tok";
const ALL_TOOLS = ["browser_click", "browser_close", "browser_drag", "browser_keys", "browser_open", "browser_screenshot", "browser_scroll", "browser_type"];

// ── typed mock surfaces (no `any`: the shim is untyped at runtime, so it is modelled explicitly) ───────
type SchemaNode = Record<string, unknown>;
interface ToolResult { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean }
interface CapturedTool {
  name: string;
  approval?: string;
  description?: string;
  parameters?: unknown;
  execute?: (toolCallId: string, params: unknown) => Promise<ToolResult>;
}

const OPTIONAL_MARK = "~optional";
const isOptional = (v: unknown): boolean => !!v && typeof v === "object" && OPTIONAL_MARK in v;

/** Mirrors what omp injects as `pi.typebox`: Object/String/Number/Boolean/Optional emitting standard
 *  JSON schema, with Optional-wrapped props left out of `required` (real TypeBox omits an empty one). */
const typebox = {
  Type: {
    Object: (properties: Record<string, SchemaNode>): SchemaNode => {
      const required = Object.keys(properties).filter((k) => !isOptional(properties[k]));
      return { type: "object", properties, ...(required.length ? { required } : {}) };
    },
    String: (opts: SchemaNode = {}): SchemaNode => ({ type: "string", ...opts }),
    Number: (opts: SchemaNode = {}): SchemaNode => ({ type: "number", ...opts }),
    Boolean: (opts: SchemaNode = {}): SchemaNode => ({ type: "boolean", ...opts }),
    Optional: (schema: SchemaNode): SchemaNode => ({ ...schema, [OPTIONAL_MARK]: true }),
  },
};

function capture(shim?: unknown): { pi: unknown; tools: CapturedTool[] } {
  const tools: CapturedTool[] = [];
  const pi = { registerTool: (t: CapturedTool) => tools.push(t), ...(shim === undefined ? { typebox } : shim === null ? {} : { typebox: shim }) };
  return { pi, tools };
}
const byName = (tools: CapturedTool[], name: string): CapturedTool | undefined => tools.find((t) => t.name === name);

/** Read `parameters` as a JSON-schema object without casting away the unknown. */
function schemaOf(tool: CapturedTool | undefined): { properties: string[]; required: string[] } {
  const p = tool?.parameters;
  if (!p || typeof p !== "object") return { properties: [], required: [] };
  const props = "properties" in p && p.properties && typeof p.properties === "object" ? Object.keys(p.properties) : [];
  const req = "required" in p && Array.isArray(p.required) ? p.required.filter((x): x is string => typeof x === "string") : [];
  return { properties: props.sort(), required: req.sort() };
}

const realFetch = globalThis.fetch;
/** Stub fetch with one canned dev-server envelope; records the calls the tools actually made. */
function stubFetch(envelope: unknown): { calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    let body: unknown = null;
    if (init?.body && typeof init.body === "string") { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    calls.push({ url, body });
    return Promise.resolve(new Response(JSON.stringify(envelope), { headers: { "content-type": "application/json" } }));
  }) as typeof globalThis.fetch;
  return { calls };
}

beforeEach(() => { process.env.LUCID_BROWSER_URL = BASE; });
afterEach(() => { globalThis.fetch = realFetch; delete process.env.LUCID_BROWSER_URL; });

describe("registration", () => {
  test("typebox mode registers all six tools; only browser_open carries the gated tier", () => {
    const { pi, tools } = capture();
    browserExtension(pi);
    expect(tools.map((t) => t.name).sort()).toEqual(ALL_TOOLS);
    expect(byName(tools, "browser_open")?.approval).toBe("exec");
    // The iterate loop must never re-trip a gate: the window was already approved at open.
    for (const name of ["browser_screenshot", "browser_scroll", "browser_click", "browser_type", "browser_close"]) {
      expect(byName(tools, name)?.approval).toBe("read");
    }
  });

  // A shim missing Boolean is the browser-tool analogue of the proven T.Optional bug: it must route to
  // literal mode rather than throwing mid-registration and silently dropping every tool.
  test("a typebox shim missing Boolean falls back to literal mode with all six still registered", () => {
    const partial = { Type: { Object: typebox.Type.Object, String: typebox.Type.String, Number: typebox.Type.Number, Optional: typebox.Type.Optional } };
    const { pi, tools } = capture(partial);
    expect(() => browserExtension(pi)).not.toThrow();
    expect(tools.map((t) => t.name).sort()).toEqual(ALL_TOOLS);
  });

  test("absent shim registers registrable JSON-Schema objects for every tool", () => {
    const { pi, tools } = capture(null);
    expect(() => browserExtension(pi)).not.toThrow();
    expect(tools.map((t) => t.name).sort()).toEqual(ALL_TOOLS);
    for (const t of tools) {
      expect(typeof t.parameters).toBe("object");
      expect(Array.isArray(t.parameters)).toBe(false);
    }
  });

  test("every tool's schema requires exactly what it cannot work without", () => {
    const { pi, tools } = capture(null);
    browserExtension(pi);
    expect(schemaOf(byName(tools, "browser_click"))).toEqual({ properties: ["button", "x", "y"], required: ["x", "y"] });
    expect(schemaOf(byName(tools, "browser_type"))).toEqual({ properties: ["pressEnter", "text"], required: ["text"] });
    expect(schemaOf(byName(tools, "browser_keys"))).toEqual({ properties: ["keys"], required: ["keys"] });
    expect(schemaOf(byName(tools, "browser_scroll"))).toEqual({ properties: ["dy"], required: [] });
  });

  test("no LUCID_BROWSER_URL means no tools at all (a bun-only run has no window executor)", () => {
    delete process.env.LUCID_BROWSER_URL;
    const { pi, tools } = capture();
    browserExtension(pi);
    expect(tools).toEqual([]);
  });

  test("registration never throws even when registerTool itself rejects the tool", () => {
    expect(() => browserExtension({ registerTool: () => { throw new Error("schema rejected"); }, typebox })).not.toThrow();
  });
});

describe("browser_click", () => {
  test("rejects missing, non-numeric, and negative coordinates before any call goes out", async () => {
    const { pi, tools } = capture();
    browserExtension(pi);
    const click = byName(tools, "browser_click");
    const { calls } = stubFetch({ ok: true, data: {} });
    for (const bad of [{}, { x: 10 }, { x: "left", y: 4 }, { x: -1, y: 4 }, { x: 4, y: -8 }]) {
      const r = await click?.execute?.("c", bad);
      expect(r?.isError).toBe(true);
    }
    expect(calls).toEqual([]); // never bothered the window with a malformed point
  });

  test("posts the point to /click and tells the agent to screenshot next", async () => {
    const { pi, tools } = capture();
    browserExtension(pi);
    const { calls } = stubFetch({ ok: true, data: { title: "Profile" } });
    const r = await byName(tools, "browser_click")?.execute?.("c", { x: 412.4, y: 96.6 });
    expect(r?.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:5319/api/browser/click?t=tok");
    expect(calls[0]!.body).toEqual({ x: 412.4, y: 96.6, button: "left" });
    expect(r?.content[0]?.text).toContain("browser_screenshot");
  });

  test("surfaces the server's refusal verbatim as an error result", async () => {
    const { pi, tools } = capture();
    browserExtension(pi);
    stubFetch({ ok: false, error: "browser closed by user" });
    const r = await byName(tools, "browser_click")?.execute?.("c", { x: 1, y: 1 });
    expect(r?.isError).toBe(true);
    expect(r?.content[0]?.text).toContain("browser closed by user");
  });
});

describe("browser_type", () => {
  test("refuses empty text and text past the 2000-character cap", async () => {
    const { pi, tools } = capture();
    browserExtension(pi);
    const type = byName(tools, "browser_type");
    const { calls } = stubFetch({ ok: true, data: {} });
    expect((await type?.execute?.("t", { text: "" }))?.isError).toBe(true);
    expect((await type?.execute?.("t", {}))?.isError).toBe(true);
    const over = await type?.execute?.("t", { text: "x".repeat(2001) });
    expect(over?.isError).toBe(true);
    expect(over?.content[0]?.text).toContain("2000");
    expect(calls).toEqual([]);
  });

  test("passes text through and reports the Enter press when asked", async () => {
    const { pi, tools } = capture();
    browserExtension(pi);
    const { calls } = stubFetch({ ok: true, data: { typed: 5 } });
    const r = await byName(tools, "browser_type")?.execute?.("t", { text: "hello", pressEnter: true });
    expect(calls[0]!.url).toBe("http://127.0.0.1:5319/api/browser/type?t=tok");
    expect(calls[0]!.body).toEqual({ text: "hello", pressEnter: true });
    expect(r?.content[0]?.text).toContain("pressed Enter");
  });

  test("pressEnter defaults to false when omitted", async () => {
    const { pi, tools } = capture();
    browserExtension(pi);
    const { calls } = stubFetch({ ok: true, data: {} });
    const r = await byName(tools, "browser_type")?.execute?.("t", { text: "hi" });
    expect(calls[0]!.body).toEqual({ text: "hi", pressEnter: false });
    expect(r?.content[0]?.text).not.toContain("pressed Enter");
  });
});

describe("pure helpers", () => {
  test("browserEndpoint keeps the query token and appends the route path", () => {
    expect(browserEndpoint(BASE, "/click")).toBe("http://127.0.0.1:5319/api/browser/click?t=tok");
    expect(browserEndpoint(undefined, "/click")).toBeNull();
    expect(browserEndpoint("not a url", "/click")).toBeNull();
  });

  test("browserShotImage parses a png data URL and rejects anything else", () => {
    expect(browserShotImage("data:image/png;base64,AA==")).toEqual({ type: "image", data: "AA==", mimeType: "image/png" });
    expect(browserShotImage("data:text/html;base64,AA==")).toBeNull();
    expect(browserShotImage(null)).toBeNull();
  });
});

describe("browser_click button", () => {
  test("defaults to left and normalizes a right-click request", async () => {
    const { pi, tools } = capture();
    browserExtension(pi);
    const click = byName(tools, "browser_click");
    const { calls } = stubFetch({ ok: true, data: {} });
    await click?.execute?.("c", { x: 5, y: 5 });
    expect(calls[0]!.body).toEqual({ x: 5, y: 5, button: "left" });
    const r = await click?.execute?.("c", { x: 5, y: 5, button: "RIGHT" });
    expect(calls[1]!.body).toEqual({ x: 5, y: 5, button: "right" });
    expect(r?.content[0]?.text).toContain("Right-clicked");
  });

  test("button is optional in the schema, x and y are not", () => {
    const { pi, tools } = capture(null);
    browserExtension(pi);
    expect(schemaOf(byName(tools, "browser_click"))).toEqual({ properties: ["button", "x", "y"], required: ["x", "y"] });
  });
});

describe("browser_drag", () => {
  test("requires all four coordinates and never calls out when one is missing", async () => {
    const { pi, tools } = capture();
    browserExtension(pi);
    const drag = byName(tools, "browser_drag");
    const { calls } = stubFetch({ ok: true, data: {} });
    for (const bad of [{}, { x: 1, y: 2 }, { x: 1, y: 2, toX: 3 }, { x: 1, y: 2, toX: 3, toY: -1 }, { x: "a", y: 2, toX: 3, toY: 4 }]) {
      expect((await drag?.execute?.("d", bad))?.isError).toBe(true);
    }
    expect(calls).toEqual([]);
    expect(schemaOf(drag)).toEqual({ properties: ["toX", "toY", "x", "y"], required: ["toX", "toY", "x", "y"] });
  });

  test("posts both endpoints and reports them back", async () => {
    const { pi, tools } = capture();
    browserExtension(pi);
    const { calls } = stubFetch({ ok: true, data: {} });
    const r = await byName(tools, "browser_drag")?.execute?.("d", { x: 10, y: 20, toX: 300, toY: 25 });
    expect(calls[0]!.url).toBe("http://127.0.0.1:5319/api/browser/drag?t=tok");
    expect(calls[0]!.body).toEqual({ x: 10, y: 20, toX: 300, toY: 25 });
    expect(r?.content[0]?.text).toContain("(300, 25)");
  });
});

describe("browser_keys", () => {
  test("refuses an empty combo before calling out", async () => {
    const { pi, tools } = capture();
    browserExtension(pi);
    const { calls } = stubFetch({ ok: true, data: {} });
    expect((await byName(tools, "browser_keys")?.execute?.("k", {}))?.isError).toBe(true);
    expect((await byName(tools, "browser_keys")?.execute?.("k", { keys: "   " }))?.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  test("passes the trimmed combo through and echoes it back", async () => {
    const { pi, tools } = capture();
    browserExtension(pi);
    const { calls } = stubFetch({ ok: true, data: {} });
    const r = await byName(tools, "browser_keys")?.execute?.("k", { keys: "  Control+a  " });
    expect(calls[0]!.url).toBe("http://127.0.0.1:5319/api/browser/keys?t=tok");
    expect(calls[0]!.body).toEqual({ keys: "Control+a" });
    expect(r?.content[0]?.text).toContain("Control+a");
  });

  test("the server's parse error reaches the agent verbatim", async () => {
    const { pi, tools } = capture();
    browserExtension(pi);
    stubFetch({ ok: false, error: 'browser_keys: unknown key "pgdown" (supported: Backspace, ...)' });
    const r = await byName(tools, "browser_keys")?.execute?.("k", { keys: "pgdown" });
    expect(r?.isError).toBe(true);
    expect(r?.content[0]?.text).toContain('unknown key "pgdown"');
  });
});
