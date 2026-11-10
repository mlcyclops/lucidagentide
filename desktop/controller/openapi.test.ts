// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/controller/openapi.test.ts - ADR-0537: the published controller API schema. A client built from the
// document must get what it promises: every route the handler serves is in it with the method the handler takes,
// it names no route the handler does not serve, every request it describes is served, every reply matches it, and
// the limits it states are the ones the handler enforces. The handler is the REAL handleController.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateDecision } from "../../harness/security/gate.ts";
import type { LaneView } from "../fleet_lanes.ts";
import { apiAuthorized } from "../origin_guard.ts";
import { ControllerLaneStore } from "./lane_store.ts";
import { askDigest, type RemoteAsk } from "./remote_policy.ts";
import { CONTROLLER_ROUTES, handleController, type ControllerDeps } from "./routes.ts";
import { PairingStore, type Pairing } from "./store.ts";

type Schema = Record<string, unknown>;
interface Parameter { name: string; in: string; required?: boolean; schema: Schema }
interface Operation {
  operationId: string;
  security: Record<string, string[]>[];
  parameters?: Parameter[];
  requestBody?: { required?: boolean; content: Record<string, { schema: Schema }> };
  responses: Record<string, Schema>;
}
/** The document's shape as this test reads it. The structural test checks it holds. */
interface Doc {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema>; responses: Record<string, Schema>; securitySchemes: Record<string, { type: string; in: string; name: string }> };
}
interface Op { path: string; method: string; op: Operation }
type Input = { query?: Record<string, string>; body?: Schema };

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const SCHEMA_PATH = "/api/controller/schema";

let dir: string;
let ws: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lucid-ctrl-oas-"));
  ws = mkdtempSync(join(tmpdir(), "lucid-ctrl-oas-ws-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

const CLEAN: GateDecision = { block: false, reason: "clean", trustLabel: "trusted", findings: [], failClosed: false };

/** The controller test rig (controller.test.ts), plus parked asks a test can open. */
function rig(models?: string[]) {
  const store = new PairingStore(join(dir, "controller-pairings.json"));
  const lanes = new Map<string, LaneView>();
  const asks = new Map<string, RemoteAsk>();
  const view = (id: string, name: string, cwd: string): LaneView => ({ id, name, cwd, model: "m", status: "awaiting-input", createdAt: 0, lastActivityAt: 0, turns: 0, canRetry: false, respawns: 0, autoApprove: false, sessionAllow: [], sessionId: `sess-${id}`, hubSessionId: null, queued: [], promoted: false, openCalls: 0 });
  const deps: ControllerDeps = {
    store,
    lanes: new ControllerLaneStore(join(dir, "controller-lanes.json")),
    fleet: {
      spawn: async (o) => { const l = view(o.id, o.name ?? "x", o.cwd); lanes.set(l.id, l); return { ok: true, lane: l }; },
      remove: (laneId) => { lanes.delete(laneId); return { ok: true }; },
      pendingAsk: (laneId) => asks.get(laneId) ?? null,
      answerAsk: (laneId, askId) => {
        if (asks.get(laneId)?.id !== askId) return { ok: false };
        asks.delete(laneId);
        return { ok: true };
      },
      prompt: async () => {},
      status: async () => ({ lanes: [...lanes.values()] }),
      laneTranscript: () => [{ role: "user", text: "q" }, { role: "assistant", text: "a0" }],
      laneRunning: () => false,
      lanePolicy: () => ({ supervised: true, remote: null }),
      cancel: () => ({ ok: true }),
      resumedTurn: () => null,
    },
    ...(models ? { models: () => models } : {}),
    scan: async () => CLEAN,
    sink: () => {},
  };
  const openAsk = (laneId: string): RemoteAsk => {
    const input = JSON.stringify({ command: "bun test" });
    const ask: RemoteAsk = { id: "0123456789abcdef0123456789abcdef", digest: askDigest("execute", "bun test", input), kind: "execute", title: "bun test", input, tier: "T3", reason: "unknown program; a human decides", openedAt: 1_000, expiresAt: 3_601_000 };
    asks.set(laneId, ask);
    return ask;
  };
  return { store, deps, openAsk };
}

/** `v[key]` when `v` is an object that has it; undefined otherwise. */
function field(v: unknown, key: string): unknown {
  return v && typeof v === "object" && Object.hasOwn(v, key) ? Reflect.get(v, key) : undefined;
}

/** `v` when it is a JSON object (a schema, a response, a reply body); a throw otherwise. */
function object(v: unknown, what: string): Schema {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${what} is not an object`);
  return v as Schema;
}

// ── A JSON Schema 2020-12 checker for the subset the document uses ────────────────────────────────────────
// A keyword it does not know throws, so the document can never pass on a rule nobody checked.

const KEYWORDS: Record<string, true> = {
  $ref: true, type: true, const: true, enum: true, anyOf: true, properties: true, required: true, additionalProperties: true, dependentRequired: true,
  items: true, pattern: true, minLength: true, maxLength: true, minimum: true, maximum: true, default: true, description: true, format: true,
};

/** Every keyword in `s` and the schemas nested in it that the checker does not know. */
function unknownKeywords(s: Schema, at: string): string[] {
  const nested = [
    ...Object.entries(s.properties === undefined ? {} : object(s.properties, at)).map(([k, p]): [unknown, string] => [p, `${at}.${k}`]),
    ...(s.items === undefined ? [] : [[s.items, `${at}[]`] as [unknown, string]]),
    ...[s.anyOf ?? []].flat().map((b, i): [unknown, string] => [b, `${at}|${i}`]),
  ];
  return [...Object.keys(s).filter((k) => !KEYWORDS[k]).map((k) => `${at}: ${k}`), ...nested.flatMap(([n, where]) => unknownKeywords(object(n, where), where))];
}

/** A local JSON pointer (`#/a/b`) resolved in the document, or undefined. */
function pointer(doc: Doc, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let cur: unknown = doc;
  for (const raw of ref.slice(2).split("/")) cur = field(cur, raw.replaceAll("~1", "/").replaceAll("~0", "~"));
  return cur;
}

/** A schema or response with its $ref followed. */
function deref(doc: Doc, node: Schema): Schema {
  return typeof node.$ref === "string" ? object(pointer(doc, node.$ref), node.$ref) : node;
}

function hasType(type: unknown, v: unknown): boolean {
  switch (type) {
    case "object": return !!v && typeof v === "object" && !Array.isArray(v);
    case "array": return Array.isArray(v);
    case "string": return typeof v === "string";
    case "integer": return Number.isInteger(v);
    case "number": return typeof v === "number";
    case "boolean": return typeof v === "boolean";
    case "null": return v === null;
    default: throw new Error(`unknown type ${String(type)}`);
  }
}

/** Every way `v` breaks `schema`; empty when it conforms. */
function check(doc: Doc, schema: Schema, v: unknown, at = "$"): string[] {
  const unknown = Object.keys(schema).filter((k) => !KEYWORDS[k]);
  if (unknown.length) throw new Error(`${at}: the checker does not know ${unknown.join(", ")}`);
  if (typeof schema.$ref === "string") return check(doc, deref(doc, schema), v, at);
  const errs: string[] = [];
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((s) => check(doc, object(s, `${at} anyOf`), v, at).length === 0)) errs.push(`${at}: matches no anyOf branch`);
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(v)) errs.push(`${at}: is not ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(v)) errs.push(`${at}: ${JSON.stringify(v)} is not one of ${schema.enum.join(", ")}`);
  if (schema.type !== undefined && ![schema.type].flat().some((t) => hasType(t, v))) return [...errs, `${at}: is not ${[schema.type].flat().join(" or ")}`];
  if (typeof v === "string") {
    const len = [...v].length;
    if (typeof schema.minLength === "number" && len < schema.minLength) errs.push(`${at}: shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === "number" && len > schema.maxLength) errs.push(`${at}: longer than ${schema.maxLength}`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(v)) errs.push(`${at}: does not match ${schema.pattern}`);
  }
  if (typeof v === "number") {
    if (typeof schema.minimum === "number" && v < schema.minimum) errs.push(`${at}: below ${schema.minimum}`);
    if (typeof schema.maximum === "number" && v > schema.maximum) errs.push(`${at}: above ${schema.maximum}`);
  }
  if (Array.isArray(v) && schema.items !== undefined) {
    const items = object(schema.items, `${at} items`);
    v.forEach((item, i) => errs.push(...check(doc, items, item, `${at}[${i}]`)));
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const props = schema.properties === undefined ? {} : object(schema.properties, `${at} properties`);
    for (const k of [schema.required ?? []].flat()) if (!Object.hasOwn(v, String(k))) errs.push(`${at}: missing ${String(k)}`);
    const dependent = schema.dependentRequired === undefined ? {} : object(schema.dependentRequired, `${at} dependentRequired`);
    for (const [k, needs] of Object.entries(dependent)) {
      if (Object.hasOwn(v, k)) for (const d of [needs].flat()) if (!Object.hasOwn(v, String(d))) errs.push(`${at}: ${k} needs ${String(d)}`);
    }
    for (const [k, val] of Object.entries(v)) {
      if (props[k] !== undefined) errs.push(...check(doc, object(props[k], `${at}.${k} schema`), val, `${at}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${at}: unexpected key ${k}`);
    }
  }
  return errs;
}

// ── Driving the handler from the document ─────────────────────────────────────────────────────────────────

/** The served document, read the way a client reads it: GET /api/controller/schema with the UI token. */
async function fetchDoc(deps: ControllerDeps): Promise<Doc> {
  const res = await handleController(new Request(`http://127.0.0.1${SCHEMA_PATH}`), SCHEMA_PATH, null, deps);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toStartWith("application/json");
  // Test-only: the reply is the document; the structural test below checks it has this shape.
  const doc = (await res.json()) as Doc;
  return doc;
}

function operations(doc: Doc): Op[] {
  return Object.entries(doc.paths).flatMap(([path, item]) => HTTP_METHODS.filter((m) => m in item).map((method) => ({ path, method, op: item[method]! })));
}

function byId(doc: Doc, id: string): Op {
  const o = operations(doc).find((x) => x.op.operationId === id);
  if (!o) throw new Error(`the document has no operation ${id}`);
  return o;
}

/** The JSON body schema an operation takes, or undefined for none. */
function bodySchemaOf(o: Op): Schema | undefined {
  return o.op.requestBody?.content["application/json"]?.schema;
}

function request(o: Op, input: Input, method = o.method.toUpperCase()): Request {
  const url = `http://127.0.0.1${o.path}${input.query ? `?${new URLSearchParams(input.query)}` : ""}`;
  return input.body === undefined ? new Request(url, { method }) : new Request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(input.body) });
}

/** The reply's status, content type and body must be ones the document lists for `o`. */
async function reply(doc: Doc, o: Op, res: Response): Promise<{ status: number; body: unknown }> {
  const id = o.op.operationId;
  const listed = o.op.responses[String(res.status)];
  expect([id, res.status, listed !== undefined]).toEqual([id, res.status, true]);
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
  const media = field(field(deref(doc, listed!), "content"), type);
  expect([id, res.status, type, media !== undefined]).toEqual([id, res.status, type, true]);
  const text = await res.text();
  const body: unknown = type === "application/json" ? JSON.parse(text) : text;
  expect([id, res.status, check(doc, object(field(media, "schema"), `${id} ${res.status} schema`), body)]).toEqual([id, res.status, []]);
  return { status: res.status, body };
}

/** Send what the document describes for `o` (the input checked against it first), and check the reply. */
async function call(doc: Doc, deps: ControllerDeps, o: Op, pairing: Pairing | null, input: Input) {
  const id = o.op.operationId;
  const params = o.op.parameters ?? [];
  for (const p of params) if (p.required) expect([id, p.name, input.query?.[p.name] !== undefined]).toEqual([id, p.name, true]);
  for (const [k, v] of Object.entries(input.query ?? {})) {
    const p = params.find((x) => x.name === k && x.in === "query");
    expect([id, k, p ? check(doc, p.schema, v) : ["not a documented query parameter"]]).toEqual([id, k, []]);
  }
  const bodySchema = bodySchemaOf(o);
  expect([id, "takes a body", input.body !== undefined]).toEqual([id, "takes a body", bodySchema !== undefined]);
  if (bodySchema && input.body) expect([id, check(doc, bodySchema, input.body)]).toEqual([id, []]);
  return reply(doc, o, await handleController(request(o, input), o.path, pairing, deps));
}

/** The `data` of a `{ ok: true, data }` reply. */
function dataOf(r: { body: unknown }): Schema {
  return object(field(r.body, "data"), "the reply's data");
}

describe("the published controller API schema (ADR-0537)", () => {
  test("the UI token and a paired controller read the same document, by GET only", async () => {
    const r = rig();
    const doc = await fetchDoc(r.deps);
    const paired = await r.store.pair("hermes", ws);
    if (!paired.ok) throw new Error(paired.error);
    const asController = await handleController(new Request(`http://127.0.0.1${SCHEMA_PATH}`), SCHEMA_PATH, paired.pairing, r.deps);
    expect(asController.status).toBe(200);
    expect(await asController.json()).toEqual(doc);
    const post = await handleController(new Request(`http://127.0.0.1${SCHEMA_PATH}`, { method: "POST", body: "{}" }), SCHEMA_PATH, null, r.deps);
    expect([post.status, await post.json()]).toEqual([400, { ok: false, error: "malformed request" }]);
    const query = await handleController(new Request(`http://127.0.0.1${SCHEMA_PATH}?x=1`), SCHEMA_PATH, null, r.deps);
    expect(query.status).toBe(400);
  });

  test("the engine gate opens it to the UI token and a verified controller token, and to nobody else", () => {
    const base = { path: SCHEMA_PATH, queryToken: null, uiToken: "u".repeat(64), agentToken: "a".repeat(64), queryRoutes: new Set<string>(), agentRoutes: new Set(["/api/sandbox/grant"]), controllerRoutes: CONTROLLER_ROUTES };
    expect(apiAuthorized({ ...base, headerToken: "u".repeat(64), controllerAuthorized: false })).toBe(true);
    expect(apiAuthorized({ ...base, headerToken: "lucidctl_x", controllerAuthorized: true })).toBe(true);
    expect(apiAuthorized({ ...base, headerToken: "lucidctl_x", controllerAuthorized: false })).toBe(false);
    expect(apiAuthorized({ ...base, headerToken: null, controllerAuthorized: false })).toBe(false);
    expect(apiAuthorized({ ...base, headerToken: "a".repeat(64), controllerAuthorized: false })).toBe(false);
    expect(apiAuthorized({ ...base, headerToken: null, queryToken: "u".repeat(64), controllerAuthorized: false })).toBe(false);
  });

  test("it is a structurally valid OpenAPI 3.1 document whose references all resolve", async () => {
    const doc = await fetchDoc(rig().deps);
    expect(doc.openapi).toMatch(/^3\.1\.\d+$/);
    expect(typeof doc.info.title === "string" && doc.info.title.length > 0).toBe(true);
    expect(typeof doc.info.version === "string" && doc.info.version.length > 0).toBe(true);
    const refs: string[] = [];
    const patterns: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== "object") return;
      for (const [k, v] of Object.entries(node)) {
        if (k === "$ref" && typeof v === "string") refs.push(v);
        else if (k === "pattern" && typeof v === "string") patterns.push(v);
        walk(v);
      }
    };
    walk(doc);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter((ref) => pointer(doc, ref) === undefined)).toEqual([]);
    // JSON Schema patterns are ECMA-262 with unicode semantics: each must compile that way.
    for (const p of patterns) expect(() => new RegExp(p, "u")).not.toThrow();
    const schemes = Object.keys(doc.components.securitySchemes);
    for (const [name, s] of Object.entries(doc.components.securitySchemes)) expect([name, s.type, s.in, s.name]).toEqual([name, "apiKey", "header", "x-lucid-token"]);
    const ids = new Set<string>();
    // Every schema in it uses only keywords the checker understands, so no rule in it goes unchecked below.
    const schemas: [Schema, string][] = Object.entries(doc.components.schemas).map(([k, s]): [Schema, string] => [s, k]);
    for (const o of operations(doc)) {
      const id = o.op.operationId;
      for (const p of o.op.parameters ?? []) schemas.push([p.schema, `${id}?${p.name}`]);
      const body = bodySchemaOf(o);
      if (body) schemas.push([body, `${id} body`]);
      for (const [code, res] of Object.entries(o.op.responses)) {
        for (const [type, media] of Object.entries(object(field(deref(doc, res), "content") ?? {}, `${id} ${code}`))) schemas.push([object(field(media, "schema"), `${id} ${code} ${type}`), `${id} ${code} ${type}`]);
      }
    }
    expect(schemas.flatMap(([s, at]) => unknownKeywords(s, at))).toEqual([]);
    for (const o of operations(doc)) {
      expect(o.path).toStartWith("/api/controller/");
      expect([o.op.operationId, ids.has(o.op.operationId)]).toEqual([o.op.operationId, false]);
      ids.add(o.op.operationId);
      expect(o.op.security.length).toBeGreaterThan(0);
      for (const req of o.op.security) for (const name of Object.keys(req)) expect(schemes).toContain(name);
      expect(Object.keys(o.op.responses).length).toBeGreaterThan(0);
      for (const [code, res] of Object.entries(o.op.responses)) {
        expect(code).toMatch(/^[1-5]\d\d$/);
        expect(typeof deref(doc, res).description).toBe("string");
      }
    }
  });

  test("every route the handler serves is in it with the handler's method, and it names nothing else", async () => {
    const r = rig();
    const doc = await fetchDoc(r.deps);
    // The set of paths: every controller route plus the two human routes, and no other.
    expect(Object.keys(doc.paths).sort()).toEqual([...CONTROLLER_ROUTES, "/api/controller/pair", "/api/controller/unpair"].sort());
    for (const [path, item] of Object.entries(doc.paths)) expect([path, HTTP_METHODS.filter((m) => m in item).length]).toEqual([path, 1]);

    // A client that follows the document is served on every operation, and every reply is one it describes.
    const seen = new Set<string>();
    const run = async (id: string, pairing: Pairing | null, input: Input, status: number) => {
      seen.add(id);
      const res = await call(doc, r.deps, byId(doc, id), pairing, input);
      expect([id, res.status]).toEqual([id, status]);
      return res;
    };
    await run("schema", null, {}, 200);
    const paired = await run("pair", null, { body: { name: "hermes", workspace: ws } }, 200);
    const pairing = (await r.store.verify(String(dataOf(paired).token)))!;
    expect(pairing.name).toBe("hermes");
    await run("schema", pairing, {}, 200);
    const laneId = String(field(dataOf(await run("spawnLane", pairing, { body: { name: "worker" } }, 200)).lane, "id"));
    expect(dataOf(await run("listLanes", pairing, {}, 200)).lanes).toMatchObject([{ id: laneId, name: "worker" }]);
    await run("laneStatus", pairing, { query: { laneId } }, 200);
    expect(dataOf(await run("laneResult", pairing, { query: { laneId, since: "0" } }, 200)).turns).toEqual([{ index: 1, text: "a0" }]);
    const ask = r.openAsk(laneId);
    expect(dataOf(await run("pendingAsk", pairing, { query: { laneId } }, 200)).ask).toEqual(ask);
    // A pairing with no approver root cannot carry a decision: a documented 409, not an unserved route.
    await run("decideAsk", pairing, { body: { laneId, askId: ask.id, decision: "e30.AA", cert: "e30.AA" } }, 409);
    await run("denyAsk", pairing, { body: { laneId, askId: ask.id } }, 200);
    await run("denyAsk", pairing, { body: { laneId, askId: ask.id } }, 409);
    await run("promptLane", pairing, { body: { laneId, text: "hello" } }, 202);
    await run("cancelTurn", pairing, { body: { laneId } }, 200);
    await run("laneStatus", pairing, { query: { laneId: "lane-00000000" } }, 404);
    await run("closeLane", pairing, { body: { laneId } }, 200);
    await run("unpair", null, { body: { name: "hermes" } }, 200);
    await run("unpair", null, { body: { name: "hermes" } }, 404);
    expect([...seen].sort()).toEqual(operations(doc).map((o) => o.op.operationId).sort());
  });

  test("each route refuses the method the document does not give it, with a 400 the document lists", async () => {
    const r = rig();
    const doc = await fetchDoc(r.deps);
    const paired = await r.store.pair("hermes", ws);
    if (!paired.ok) throw new Error(paired.error);
    const laneId = String(field(dataOf(await call(doc, r.deps, byId(doc, "spawnLane"), paired.pairing, { body: {} })).lane, "id"));
    for (const o of operations(doc)) {
      const pairing = o.op.security.some((s) => "controllerToken" in s) ? paired.pairing : null;
      const laneScoped = (o.op.parameters ?? []).some((p) => p.name === "laneId") || field(field(bodySchemaOf(o), "properties"), "laneId") !== undefined;
      const lane: Record<string, string> = laneScoped ? { laneId } : {};
      const req = o.method === "get" ? request(o, { body: lane }, "POST") : request(o, { query: lane }, "GET");
      const res = await reply(doc, o, await handleController(req, o.path, pairing, r.deps));
      expect([o.op.operationId, res.status]).toEqual([o.op.operationId, 400]);
    }
    // No wrong-method call closed the lane.
    expect((await r.deps.fleet.status()).lanes.map((l) => l.id)).toContain(laneId);
  });

  test("the limits it states are the ones the handler enforces", async () => {
    const r = rig(["openai/gpt-5"]);
    const doc = await fetchDoc(r.deps);
    const status = async (id: string, pairing: Pairing | null, input: Input) => {
      const o = byId(doc, id);
      return (await reply(doc, o, await handleController(request(o, input), o.path, pairing, r.deps))).status;
    };
    /** The document accepts a body exactly when the handler does not refuse it as malformed. */
    const agree = async (id: string, pairing: Pairing | null, bodies: Schema[]) => {
      const schema = bodySchemaOf(byId(doc, id))!;
      for (const body of bodies) expect([id, body, (await status(id, pairing, { body })) !== 400]).toEqual([id, body, check(doc, schema, body).length === 0]);
    };

    const root = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "der" }).toString("base64url");
    let n = 0;
    const pairBody = (extra: Schema) => ({ name: `p${n++}`, workspace: ws, ...extra });
    await agree("pair", null, [
      { name: "ok name", workspace: ws }, { name: "x".repeat(48), workspace: ws }, { name: "x".repeat(49), workspace: ws }, { name: "-dash", workspace: ws },
      pairBody({ maxLanes: "1" }), pairBody({ maxLanes: "08" }), pairBody({ maxLanes: "0" }), pairBody({ maxLanes: "9" }), pairBody({ maxLanes: "100" }),
      pairBody({ spokeNode: `n_${"0".repeat(32)}` }), pairBody({ spokeNode: `n_${"0".repeat(31)}` }), pairBody({ spokeNode: `n_${"A".repeat(32)}` }),
      pairBody({ approverRoot: root, approvalHours: "1" }), pairBody({ approverRoot: root, approvalHours: "24" }), pairBody({ approverRoot: root, approvalHours: "25" }), pairBody({ approverRoot: root, approvalHours: "0" }),
      pairBody({ approverRoot: root, offTask: "off", presence: "required" }), pairBody({ approverRoot: root, offTask: "maybe" }), pairBody({ approverRoot: root, presence: "sometimes" }),
      pairBody({ offTask: "on" }), pairBody({ approvalHours: "8" }), pairBody({ presence: "none" }), pairBody({ approverRoot: root, cwd: "/" }),
    ]);

    const paired = await r.store.pair("limits", ws, undefined, 8);
    if (!paired.ok) throw new Error(paired.error);
    const pairing = paired.pairing;
    await agree("spawnLane", pairing, [{}, { model: "openai/gpt-5" }, { model: "Bad Model" }, { model: "openai/" }, { model: "/gpt-5" }, { name: "-dash" }, { cwd: "/" }]);

    const laneId = (await r.deps.fleet.status()).lanes[0]!.id;
    const maxPrompt = Number(field(field(field(bodySchemaOf(byId(doc, "promptLane")), "properties"), "text"), "maxLength"));
    expect(maxPrompt).toBeGreaterThan(0);
    await agree("promptLane", pairing, [{ laneId, text: "a".repeat(maxPrompt) }, { laneId, text: "a".repeat(maxPrompt + 1) }, { laneId, text: "" }, { laneId }]);

    const since = byId(doc, "laneResult").op.parameters!.find((p) => p.name === "since")!.schema;
    for (const v of ["0", "999999", "1234567", "-1", "x"]) {
      expect(["since", v, (await status("laneResult", pairing, { query: { laneId, since: v } })) !== 400]).toEqual(["since", v, check(doc, since, v).length === 0]);
    }
  }, 30_000); // a dozen pairings, each an argon2id hash
});
