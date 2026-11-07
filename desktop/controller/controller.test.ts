// Copyright (c) 2026 REDACTED_ORGANIZATION
// SPDX-License-Identifier: BUSL-1.1

// desktop/controller/controller.test.ts - P-CTRL.2 (ADR-0438): the controller token, the hashed pairing store,
// and the /api/controller/* policy (ownership, fixed workspace, fail-closed prompt scan, events, 403s).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanAndDecide, type GateDecision } from "../../harness/security/gate.ts";
import { ScanUnavailableError, type ScannerClient } from "../../harness/security/scanner_client.ts";
import type { TelemetryEvent } from "../../harness/telemetry/events.ts";
import type { LaneView } from "../fleet_lanes.ts";
import { apiAuthorized } from "../origin_guard.ts";
import { ControllerLaneStore } from "./lane_store.ts";
import { CONTROLLER_ROUTES, controllerPreamble, handleController, type ControllerDeps } from "./routes.ts";
import { PairingStore, type Pairing } from "./store.ts";

let dir: string;
let ws: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lucid-ctrl-"));
  ws = mkdtempSync(join(tmpdir(), "lucid-ctrl-ws-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

const CLEAN: GateDecision = { block: false, reason: "clean", trustLabel: "trusted", findings: [], failClosed: false };
/** The fields these tests read from the handler's JSON replies. */
interface Reply { error: string; data: { token: string; lane: { id: string }; lanes: { id: string }[]; turns: unknown; runId: string; maxLanes: number } }

/** `models` (ADR-0511): the engine's available model ids; absent, the rig has no model list. */
function rig(scan: (t: string) => Promise<GateDecision> = async () => CLEAN, models?: string[]) {
  const store = new PairingStore(join(dir, "controller-pairings.json"));
  const lanes = new Map<string, LaneView>();
  const prompts: { laneId: string; text: string }[] = [];
  const spawns: { cwd: string; name?: string; model?: string; supervised: true }[] = [];
  const events: TelemetryEvent[] = [];
  const view = (id: string, name: string, cwd: string): LaneView => ({ id, name, cwd, model: "m", status: "awaiting-input", createdAt: 0, lastActivityAt: 0, turns: 0, canRetry: false, respawns: 0, autoApprove: false, sessionAllow: [], sessionId: `sess-${id}`, hubSessionId: null, queued: [], promoted: false, openCalls: 0 });
  lanes.set("lane-user", view("lane-user", "user's own", "/home/u/secret"));
  const removed: string[] = [];
  const deps: ControllerDeps = {
    store,
    lanes: new ControllerLaneStore(join(dir, "controller-lanes.json")),
    fleet: {
      spawn: async (o) => { spawns.push(o); const l = { ...view(o.id, o.name ?? "x", o.cwd), model: o.model ?? "m" }; lanes.set(l.id, l); return { ok: true, lane: l }; },
      remove: (laneId) => { removed.push(laneId); lanes.delete(laneId); return { ok: true }; },
      prompt: async (laneId, text) => { prompts.push({ laneId, text }); },
      status: async () => ({ lanes: [...lanes.values()] }),
      laneTranscript: () => [{ role: "user", text: "q" }, { role: "assistant", text: "a0" }, { role: "user", text: "q2" }, { role: "assistant", text: "a1" }],
      laneRunning: () => false,
      cancel: () => ({ ok: true }),
      pendingAsk: () => null,
      answerAsk: () => ({ ok: false }),
    },
    ...(models ? { models: () => models } : {}),
    scan,
    sink: (e) => events.push(e),
  };
  const call = async (path: string, pairing: Pairing | null, body?: unknown, query = "") => {
    const req = new Request(`http://127.0.0.1/api/controller/${path}${query}`, body === undefined ? {} : { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
    const res = await handleController(req, `/api/controller/${path}`, pairing, deps);
    const text = await res.text();
    // Test-only: the handler's own JSON replies, asserted field by field below. A 403 is plain text.
    return { status: res.status, text, body: (res.status === 403 ? {} : JSON.parse(text)) as Reply };
  };
  const pair = async (name: string) => {
    const r = await call("pair", null, { name, workspace: ws });
    expect(r.status).toBe(200);
    return { token: r.body.data.token as string, pairing: (await store.verify(r.body.data.token))! };
  };
  return { store, lanes, prompts, spawns, removed, events, call, pair };
}

describe("controller token: hashed, revocable, never stored in the clear", () => {
  test("round-trip, tamper, revoke, reload, 0600", async () => {
    const r = rig();
    const { token, pairing } = await r.pair("hermes");
    expect(pairing.name).toBe("hermes");
    const file = join(dir, "controller-pairings.json");
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(token.split("_").at(-1)!);
    expect(JSON.parse(raw).pairings[0].hash).toStartWith("$argon2id$");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    // a fresh engine (new store over the same file) still accepts it
    expect((await new PairingStore(file).verify(token))?.id).toBe(pairing.id);
    // one changed character, a wrong shape, nothing at all
    const last = token.at(-1) === "A" ? "B" : "A";
    expect(await r.store.verify(token.slice(0, -1) + last)).toBeNull();
    expect(await r.store.verify("lucidctl_nope")).toBeNull();
    expect(await r.store.verify(null)).toBeNull();
    // revoke
    expect((await r.call("unpair", null, { name: "hermes" })).status).toBe(200);
    expect(await r.store.verify(token)).toBeNull();
    expect(await new PairingStore(file).verify(token)).toBeNull();
  });

  test("a malformed store refuses every token and every pairing, and is not overwritten", async () => {
    const file = join(dir, "controller-pairings.json");
    const r = rig();
    const { token } = await r.pair("hermes");
    writeFileSync(file, "{torn", { mode: 0o600 });
    const broken = new PairingStore(file);
    expect(await broken.verify(token)).toBeNull();
    expect((await broken.pair("again", ws)).ok).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("{torn");
  });
});

describe("scope isolation", () => {
  test("two pairings never see or touch each other's lanes, nor the user's", async () => {
    const r = rig();
    const a = await r.pair("alpha");
    const b = await r.pair("beta");
    const la = (await r.call("spawn", a.pairing, { name: "a1" })).body.data.lane.id as string;
    const lb = (await r.call("spawn", b.pairing, {})).body.data.lane.id as string;
    // spawn landed in the pairing's fixed workspace, supervised
    expect(r.spawns.every((s) => s.cwd === a.pairing.workspace && s.supervised === true)).toBe(true);
    const aLanes = (await r.call("lanes", a.pairing)).body.data.lanes.map((l) => l.id);
    expect(aLanes).toEqual([la]);
    expect((await r.call("lanes", a.pairing)).body.data.lanes[0]).not.toHaveProperty("cwd");
    for (const foreign of [lb, "lane-user", "lane-missing"]) {
      expect((await r.call("status", a.pairing, undefined, `?laneId=${foreign}`)).status).toBe(404);
      expect((await r.call("result", a.pairing, undefined, `?laneId=${foreign}`)).status).toBe(404);
      expect((await r.call("cancel", a.pairing, { laneId: foreign })).status).toBe(404);
      expect((await r.call("prompt", a.pairing, { laneId: foreign, text: "hi" })).status).toBe(404);
      // ADR-0500: closing someone else's lane (or the user's, or none) is the same not-found as every route.
      const close = await r.call("close", a.pairing, { laneId: foreign });
      expect([close.status, close.body]).toEqual([404, { ok: false, error: "unknown lane" } as never]);
    }
    expect(r.prompts).toEqual([]);
    expect(r.removed).toEqual([]);
    expect((await r.call("status", b.pairing, undefined, `?laneId=${lb}`)).status).toBe(200);
  });

  test("spawn accepts a name only and stops at two lanes per pairing", async () => {
    const r = rig();
    const { pairing } = await r.pair("hermes");
    for (const extra of [{ cwd: "/" }, { model: "x" }, { repoUrl: "https://x" }, { worktree: true }, { sessionId: "s" }, { name: 5 }]) {
      expect((await r.call("spawn", pairing, extra)).status).toBe(400);
    }
    expect((await r.call("spawn", pairing, "{not json")).status).toBe(400);
    expect((await r.call("spawn", pairing, {})).status).toBe(200);
    expect((await r.call("spawn", pairing, {})).status).toBe(200);
    const third = await r.call("spawn", pairing, {});
    expect([third.status, third.body.error]).toEqual([429, "at most 2 lanes per pairing"]);
  });

  test("ADR-0511: spawn may name a model the engine lists; an unlisted one is 400 and starts nothing; none keeps the default", async () => {
    const r = rig(async () => CLEAN, ["anthropic/claude-sonnet-4-5", "ollama/qwen2.5-coder:32b"]);
    const { pairing } = await r.pair("hermes");
    const unlisted = await r.call("spawn", pairing, { model: "openai/gpt-9" });
    expect([unlisted.status, unlisted.body.error]).toEqual([400, "this engine has no model openai/gpt-9"]);
    // Not `provider/model`: malformed before any list is consulted.
    for (const bad of [{ model: "" }, { model: 5 }, { model: "a".repeat(201) }, { model: "anthropic/claude-sonnet-4-5 " }, { model: "x" }]) expect((await r.call("spawn", pairing, bad)).status).toBe(400);
    expect(r.spawns).toEqual([]);
    const chosen = await r.call("spawn", pairing, { name: "local", model: "ollama/qwen2.5-coder:32b" });
    expect(chosen.status).toBe(200);
    expect(r.spawns[0]!.model).toBe("ollama/qwen2.5-coder:32b");
    // the controller is not shown the model, but the lane's restart record keeps it (ADR-0501 brings it back on it)
    expect(chosen.text).not.toContain("qwen");
    const id = chosen.body.data.lane.id;
    expect(new ControllerLaneStore(join(dir, "controller-lanes.json")).get(id)?.model).toBe("ollama/qwen2.5-coder:32b");
    const plain = await r.call("spawn", pairing, {});
    expect(plain.status).toBe(200);
    expect(r.spawns[1]).not.toHaveProperty("model");
  });

  // Live on a headless spoke engine: no omp session had reported its model config, the list was empty, and every
  // named model was refused, real ones included. With no list the lane's own resolution and the policy clamp decide.
  test("ADR-0511: an engine that has reported no model list passes a named model to the lane", async () => {
    for (const r of [rig(), rig(undefined, [])]) {
      const { pairing } = await r.pair("hermes");
      const res = await r.call("spawn", pairing, { model: "anthropic/claude-sonnet-4-5" });
      expect(res.status).toBe(200);
      expect(r.spawns[0]?.model).toBe("anthropic/claude-sonnet-4-5");
    }
  });

  test("ADR-0509: a pairing granted 4 lanes admits 4 and refuses the 5th; absent means 2; the grant survives a reload", async () => {
    const r = rig();
    const paired = await r.call("pair", null, { name: "big", workspace: ws, maxLanes: "4" });
    expect(paired.status).toBe(200);
    expect(paired.body.data.maxLanes).toBe(4);
    const big = (await r.store.verify(paired.body.data.token))!;
    expect(big.maxLanes).toBe(4);
    for (let i = 0; i < 4; i++) expect((await r.call("spawn", big, {})).status).toBe(200);
    const fifth = await r.call("spawn", big, {});
    expect([fifth.status, fifth.body.error]).toEqual([429, "at most 4 lanes per pairing"]);
    expect((await r.call("lanes", big)).body.data.maxLanes).toBe(4);
    expect(r.events.find((e) => e.event === "controller_paired")).toMatchObject({ pairing: "big", max_lanes: 4 });
    // absent: the ADR-0425 default, stored as nothing (so a pairing written before ADR-0509 reads the same)
    const { pairing: plain } = await r.pair("plain");
    expect(plain.maxLanes).toBeUndefined();
    expect((await r.call("lanes", plain)).body.data.maxLanes).toBe(2);
    const file = join(dir, "controller-pairings.json");
    const reloaded = new PairingStore(file);
    expect([reloaded.byId(big.id)?.maxLanes, reloaded.byId(plain.id)?.maxLanes]).toEqual([4, undefined]);
    expect(reloaded.broken).toBeNull();
  });

  test("ADR-0509: a lane grant outside 1..8, or not decimal digits, is refused at pair time and in the file", async () => {
    const r = rig();
    for (const maxLanes of ["0", "9", "-1", "2.5", " 4", "4x", "", "08x", 4]) {
      expect((await r.call("pair", null, { name: "bad", workspace: ws, maxLanes })).status).toBe(400);
    }
    // nothing was stored: the name is still free
    expect((await r.call("pair", null, { name: "bad", workspace: ws })).status).toBe(200);
    expect((await r.call("pair", null, { name: "one", workspace: ws, maxLanes: "1" })).status).toBe(200);
    expect((await r.call("pair", null, { name: "eight", workspace: ws, maxLanes: "8" })).status).toBe(200);
    expect((await r.store.pair("direct", ws, undefined, 9)).ok).toBe(false);
    // a hand-edited store that grants 9 is malformed, not silently clamped
    const file = join(dir, "controller-pairings.json");
    const stored = JSON.parse(readFileSync(file, "utf8")) as { pairings: { maxLanes?: number }[] };
    stored.pairings[0]!.maxLanes = 9;
    writeFileSync(file, JSON.stringify(stored), { mode: 0o600 });
    expect(new PairingStore(file).broken).toBe("pairing store is malformed");
  });

  test("ADR-0500: close ends the controller's own lane, frees its slot, and leaves no restart record", async () => {
    const r = rig();
    const { pairing } = await r.pair("hermes");
    const one = (await r.call("spawn", pairing, {})).body.data.lane.id;
    const two = (await r.call("spawn", pairing, {})).body.data.lane.id;
    expect((await r.call("spawn", pairing, {})).status).toBe(429);
    for (const bad of [{}, { laneId: one, force: "yes" }, { laneId: 5 }]) expect((await r.call("close", pairing, bad)).status).toBe(400);
    const closed = await r.call("close", pairing, { laneId: one });
    expect(closed.status).toBe(200);
    expect(closed.body.data).toEqual({ closed: one, cancelledTurn: false } as never);
    expect(r.removed).toEqual([one]);
    // the slot is free, the closed lane is gone from every route, and its ownership went with it
    expect((await r.call("lanes", pairing)).body.data.lanes.map((l) => l.id)).toEqual([two]);
    expect((await r.call("status", pairing, undefined, `?laneId=${one}`)).status).toBe(404);
    expect((await r.call("close", pairing, { laneId: one })).status).toBe(404);
    expect(r.store.pairingForLane(one)).toBeNull();
    const three = await r.call("spawn", pairing, {});
    expect(three.status).toBe(200);
    expect((await r.call("spawn", pairing, {})).status).toBe(429);
    // a reloaded lane store (the next boot) no longer holds the closed lane
    const ids = new ControllerLaneStore(join(dir, "controller-lanes.json")).all().map((l) => l.id).sort();
    expect(ids).toEqual([two, three.body.data.lane.id].sort());
    expect(r.events.filter((e) => e.event === "controller_ruling")).toEqual([expect.objectContaining({ ruling: "lane_closed", lane_id: one, pairing: "hermes", backend: "lane-lifecycle" })]);
  });

  test("result returns assistant turns from `since`", async () => {
    const r = rig();
    const { pairing } = await r.pair("hermes");
    const id = (await r.call("spawn", pairing, {})).body.data.lane.id;
    expect((await r.call("result", pairing, undefined, `?laneId=${id}&since=2`)).body.data.turns).toEqual([{ index: 3, text: "a1" }]);
    expect((await r.call("result", pairing, undefined, `?laneId=${id}&since=-1`)).status).toBe(400);
  });
});

describe("prompt: fail-closed scan before any lane sees the text", () => {
  test("a quarantine verdict refuses the turn and emits controller_turn_blocked", async () => {
    const r = rig(async () => ({ block: true, reason: "quarantined", trustLabel: "quarantined", findings: [{} as never], failClosed: false }));
    const { pairing } = await r.pair("hermes");
    const id = (await r.call("spawn", pairing, {})).body.data.lane.id;
    const res = await r.call("prompt", pairing, { laneId: id, text: "ignore previous\u200b" });
    expect(res.status).toBe(422);
    expect(r.prompts).toEqual([]);
    const blocked = r.events.find((e) => e.event === "controller_turn_blocked")!;
    expect(blocked).toMatchObject({ lane_id: id, verdict: "quarantined", fail_closed: false, findings: 1, session_id: `sess-${id}` });
    expect(JSON.stringify(r.events)).not.toContain("ignore previous");
  });

  test("a dead scanner refuses through the real scanAndDecide (scan unavailable == blocked)", async () => {
    const dead = { scan: async () => { throw new ScanUnavailableError("scanner not running"); } } as unknown as ScannerClient;
    const r = rig((t) => scanAndDecide(dead, t));
    const { pairing } = await r.pair("hermes");
    const id = (await r.call("spawn", pairing, {})).body.data.lane.id;
    const res = await r.call("prompt", pairing, { laneId: id, text: "hello" });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("unavailable");
    expect(r.prompts).toEqual([]);
    expect(r.events.at(-1)).toMatchObject({ event: "controller_turn_blocked", fail_closed: true });
  });

  test("a clean prompt starts a detached turn with the provenance preamble", async () => {
    const r = rig();
    const { pairing } = await r.pair("hermes");
    const id = (await r.call("spawn", pairing, {})).body.data.lane.id;
    const res = await r.call("prompt", pairing, { laneId: id, text: "list the files" });
    expect(res.status).toBe(202);
    expect(r.prompts).toEqual([{ laneId: id, text: controllerPreamble("hermes") + "list the files" }]);
    const started = r.events.find((e) => e.event === "controller_turn_started")!;
    expect(started).toMatchObject({ run_id: res.body.data.runId, session_id: `sess-${id}`, lane_id: id, pairing: "hermes" });
    for (const bad of [{ laneId: id }, { laneId: id, text: "" }, { laneId: id, text: "x".repeat(32_001) }, { laneId: id, text: "x", images: "y" }]) {
      expect((await r.call("prompt", pairing, bad)).status).toBe(400);
    }
  });
});

describe("events per route", () => {
  test("pair and unpair emit with run_id and session_id; no token in any event", async () => {
    const r = rig();
    const { token, pairing } = await r.pair("hermes");
    await r.call("unpair", null, { name: "hermes" });
    expect(r.events.map((e) => e.event)).toEqual(["controller_paired", "controller_unpaired"]);
    for (const e of r.events) expect(e).toMatchObject({ pairing: "hermes", pairing_id: pairing.id, session_id: `controller:${pairing.id}` });
    expect(r.events.every((e) => typeof e.run_id === "string" && e.run_id.length > 0)).toBe(true);
    expect(JSON.stringify(r.events)).not.toContain(token);
  });
});

describe("403 paths", () => {
  test("no pairing is 403 with no detail on every controller route", async () => {
    const r = rig();
    for (const route of CONTROLLER_ROUTES) {
      const res = await r.call(route.slice("/api/controller/".length), null, { laneId: "lane-1", text: "x" });
      expect([res.status, res.text]).toEqual([403, "forbidden"]);
    }
    const bogus = await r.call("bogus", (await r.pair("hermes")).pairing);
    expect([bogus.status, bogus.text]).toEqual([403, "forbidden"]);
  });

  test("the controller scope opens controller routes only, header only", () => {
    const base = { queryToken: null, uiToken: "u".repeat(64), agentToken: "a".repeat(64), queryRoutes: new Set<string>(), agentRoutes: new Set(["/api/sandbox/grant"]), controllerRoutes: CONTROLLER_ROUTES };
    const ctrl = { ...base, headerToken: "lucidctl_x", controllerAuthorized: true };
    expect(apiAuthorized({ ...ctrl, path: "/api/controller/spawn" })).toBe(true);
    for (const human of ["/api/security/approve", "/api/fleet/answer", "/api/fleet/auto", "/api/fleet/spawn", "/api/controller/pair", "/api/controller/unpair", "/api/settings", "/api/vault/status", "/api/sandbox/grant"]) {
      expect(apiAuthorized({ ...ctrl, path: human })).toBe(false);
    }
    expect(apiAuthorized({ ...base, headerToken: "lucidctl_x", controllerAuthorized: false, path: "/api/controller/spawn" })).toBe(false);
    // the agent token does not open controller routes
    expect(apiAuthorized({ ...base, headerToken: "a".repeat(64), controllerAuthorized: false, path: "/api/controller/lanes" })).toBe(false);
  });
});
