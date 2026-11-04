// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/controller/remote_approval.test.ts - P-CTRL-REMOTE.1 (ADR-0476). The REAL lane manager and the REAL
// controller routes against the faithful fake ACP agent (a real subprocess), which asks permission for exactly
// the tool call a prompt scripts. What must hold:
//   - the tier policy decides a remote lane's asks: T0/T1 inside the workspace run, known destructive and edits
//     outside are refused with no way to approve, the rest park;
//   - only a decision the ENGINE verifies against the paired root releases a parked ask (approve scope, not
//     revoked, this lane, this ask, this digest, in date); the controller can deny but never approve;
//   - a decision cannot be replayed onto a later ask; cancel releases a parked ask; the off-task check only
//     ever tightens.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateDecision } from "../../harness/security/gate.ts";
import type { TelemetryEvent } from "../../harness/telemetry/events.ts";
import { FleetLaneManager } from "../fleet_lanes.ts";
import type { SystemSnapshot } from "../system_profile.ts";
import { askDigest, canonical, classifyAsk, parseOffTask, verifyRemoteDecision, type RemoteAsk } from "./remote_policy.ts";
import { handleController, type ControllerDeps } from "./routes.ts";
import { PairingStore, type Pairing } from "./store.ts";

const FAKE = join(import.meta.dir, "..", "..", "harness", "mcp", "testing", "fake_acp_agent.ts");
const TIMEOUT = 30_000;
const healthy: SystemSnapshot = { cpuModel: "t", cores: 8, speedMHz: 4000, cpuBusyPct: 10, memTotalMB: 16_000, memFreeMB: 12_000 };
const CLEAN: GateDecision = { block: false, reason: "clean", trustLabel: "trusted", findings: [], failClosed: false };

// ── The add-on's identity format, reproduced here so the engine is tested against real signatures ─────────
interface Node { priv: KeyObject; spki: string; id: string }
const b64u = (b: Buffer) => b.toString("base64url");
const nodeId = (spki: Buffer) => `n_${new Bun.CryptoHasher("sha256").update(spki).digest("hex").slice(0, 32)}`;
function key(): Node {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const der = publicKey.export({ type: "spki", format: "der" });
  return { priv: privateKey, spki: b64u(der), id: nodeId(der) };
}
const compact = (payload: object, priv: KeyObject) => { const body = Buffer.from(canonical(payload)); return `${b64u(body)}.${b64u(sign("sha256", body, priv))}`; };
const now = () => Math.floor(Date.now() / 1000);
function cert(root: Node, n: Node, scopes: string[], over: Record<string, unknown> = {}) {
  const serial = randomBytes(16).toString("hex");
  return { serial, token: compact({ v: 1, typ: "lucid-node-cert", serial, root: root.id, node: n.id, role: "hub", label: "test hub", spki: n.spki, scopes, iat: now() - 10, exp: now() + 3600, ...over }, root.priv) };
}
const crlOf = (root: Node, version: number, serials: string[]) => compact({ v: 1, typ: "lucid-crl", root: root.id, version, serials, iat: now() }, root.priv);
function decision(hub: Node, lane: string, ask: RemoteAsk, allow: boolean, over: Record<string, unknown> = {}) {
  return compact({ v: 1, typ: "lucid-approval", lane, ask: ask.id, digest: askDigest(ask.kind, ask.title, ask.input), allow, approver: hub.id, crl: 0, iat: now(), exp: now() + 600, ...over }, hub.priv);
}

// ── Rig: real store, real routes, real lane manager over the fake agent ───────────────────────────────────
// One workspace for the file: on Windows a lane's agent process holds its cwd open until it exits, so a
// per-test workspace cannot be removed in afterEach. It is removed once at the end, best effort.
const ws = mkdtempSync(join(tmpdir(), "lucid-remote-ws-"));
mkdirSync(join(ws, "src"));
let dir: string;
let fleet: FleetLaneManager | null = null;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lucid-remote-")); });
afterEach(() => { fleet?.stopAll(); fleet = null; rmSync(dir, { recursive: true, force: true }); });
afterAll(() => { try { rmSync(ws, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* agent still exiting; the OS temp cleaner takes it */ } });

function rig(opts: { offTask?: "on" | "off" | "unknown"; offTaskOn?: boolean } = {}) {
  const root = key();
  const events: TelemetryEvent[] = [];
  const rulings: string[] = [];
  const store = new PairingStore(join(mkdtempSync(join(dir, "rig-")), "controller-pairings.json"));
  fleet?.stopAll();
  fleet = new FleetLaneManager({
    argv: () => ({ cmd: "bun", args: [FAKE] }), masterModel: () => "m", sample: async () => healthy,
    ...(opts.offTask ? { offTask: async () => opts.offTask! } : {}),
    remoteAudit: (_laneId, v) => { rulings.push(v.ruling); },
  });
  const deps: ControllerDeps = { store, fleet, scan: async () => CLEAN, sink: (e) => events.push(e) };
  const call = async (path: string, pairing: Pairing | null, body?: unknown, query = "") => {
    const req = new Request(`http://127.0.0.1/api/controller/${path}${query}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
    const res = await handleController(req, `/api/controller/${path}`, pairing, deps);
    const text = await res.text();
    return { status: res.status, json: (res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : {}) as { ok?: boolean; error?: string; data?: Record<string, unknown> } };
  };
  const setup = async () => {
    const p = await call("pair", null, { name: "spoke", workspace: ws, approverRoot: root.spki, approvalHours: "1", offTask: opts.offTaskOn ? "on" : "off" });
    expect(p.status).toBe(200);
    const pairing = (await store.verify(String(p.json.data!.token)))!;
    const s = await call("spawn", pairing, { name: "remote" });
    expect(s.status).toBe(200);
    return { pairing, laneId: String((s.json.data!.lane as { id: string }).id) };
  };
  /** Prompt the lane to ask for `toolCall`, then wait until the ask parks or the turn ends. */
  const askFor = async (pairing: Pairing, laneId: string, toolCall: object) => {
    const r = await call("prompt", pairing, { laneId, text: `go [ask ${JSON.stringify(toolCall)}]` });
    expect(r.status).toBe(202);
    for (let i = 0; i < 200; i++) {
      const a = fleet!.pendingAsk(laneId);
      if (a) return { parked: a, reply: null };
      if (!fleet!.laneRunning(laneId)) break;
      await Bun.sleep(25);
    }
    return { parked: null, reply: lastReply(laneId) };
  };
  const lastReply = (laneId: string) => fleet!.laneTranscript(laneId).filter((t) => t.role === "assistant").at(-1)?.text ?? "";
  const settled = async (laneId: string) => { for (let i = 0; i < 200 && fleet!.laneRunning(laneId); i++) await Bun.sleep(25); return lastReply(laneId); };
  return { root, events, rulings, store, call, setup, askFor, settled };
}

const ALLOWED = `"optionId":"allow"`;
const CANCELLED = `"outcome":"cancelled"`;

describe("the tier policy decides a remote lane's asks in the engine", () => {
  test("T0 read and T1 edit inside the workspace run; a T2 fetch parks; rm and an edit outside are refused", async () => {
    const r = rig();
    const { pairing, laneId } = await r.setup();
    expect((await r.askFor(pairing, laneId, { kind: "read", title: "read src/a.ts", locations: [{ path: join(ws, "src", "a.ts") }] })).reply).toContain(ALLOWED);
    expect((await r.askFor(pairing, laneId, { kind: "edit", title: "edit", rawInput: { path: "src/a.ts" } })).reply).toContain(ALLOWED);
    expect((await r.askFor(pairing, laneId, { kind: "execute", title: "rm", rawInput: { command: "rm -r src" } })).reply).toContain(CANCELLED);
    expect((await r.askFor(pairing, laneId, { kind: "edit", title: "edit", rawInput: { path: "/etc/hosts" } })).reply).toContain(CANCELLED);
    const fetch = await r.askFor(pairing, laneId, { kind: "fetch", title: "fetch https://example.com", rawInput: { url: "https://example.com" } });
    expect(fetch.parked?.tier).toBe("T2");
    expect(r.rulings).toEqual(["tier_auto", "tier_auto", "tier_blocked", "tier_blocked", "parked"]);
  }, TIMEOUT);

  test("classification table", () => {
    const w = "/w";
    expect(classifyAsk({ kind: "execute", rawInput: { command: "git status" } }, w).action).toBe("auto");
    expect(classifyAsk({ kind: "execute", rawInput: { command: "bun test" } }, w)).toMatchObject({ tier: "T3", action: "remote" });
    expect(classifyAsk({ kind: "execute", rawInput: { command: "ls | grep a" } }, w).action).toBe("remote");
    expect(classifyAsk({ kind: "execute", rawInput: { command: "chmod 777 x" } }, w).action).toBe("block");
    expect(classifyAsk({ kind: "execute", rawInput: { command: "sudo ls" } }, w)).toMatchObject({ tier: "T4", action: "block" });
    expect(classifyAsk({ kind: "execute", rawInput: { command: "git push" } }, w).action).toBe("remote");
    expect(classifyAsk({ kind: "execute", title: "no command" }, w).action).toBe("block");
    expect(classifyAsk({ kind: "delete", rawInput: { path: "/w/a" } }, w).action).toBe("block");
    expect(classifyAsk({ kind: "read", rawInput: { path: "/home/u/.ssh/id_rsa" } }, w)).toMatchObject({ tier: "T2", action: "remote" });
    expect(classifyAsk({ kind: "edit", rawInput: { path: "../outside.txt" } }, w).action).toBe("block");
    expect(classifyAsk({ kind: "switch_mode" }, w).action).toBe("remote");
    expect(classifyAsk(null, w).action).toBe("remote");
  });
});

describe("only an engine-verified decision releases a parked ask", () => {
  test("an approve-scoped hub's signed allow releases it; the same decision cannot land on the next ask", async () => {
    const r = rig();
    const { pairing, laneId } = await r.setup();
    const hub = key(), c = cert(r.root, hub, ["recall", "approve"]);
    const { parked } = await r.askFor(pairing, laneId, { kind: "execute", title: "bun test", rawInput: { command: "bun test" } });
    expect(parked).not.toBeNull();
    // what the controller exposes is enough for a hub to recompute the digest it signs
    const shown = (await r.call("ask", pairing, undefined, `?laneId=${laneId}`)).json.data!.ask as RemoteAsk;
    expect(askDigest(shown.kind, shown.title, shown.input)).toBe(shown.digest);
    const d = decision(hub, laneId, parked!, true);
    const ok = await r.call("decide", pairing, { laneId, askId: parked!.id, decision: d, cert: c.token });
    expect(ok.status).toBe(200);
    expect(await r.settled(laneId)).toContain(ALLOWED);
    const next = await r.askFor(pairing, laneId, { kind: "execute", title: "bun test", rawInput: { command: "bun test" } });
    const replay = await r.call("decide", pairing, { laneId, askId: next.parked!.id, decision: d, cert: c.token });
    expect(replay.status).toBe(403);
    expect(replay.json.error).toBe("the decision is for a different action");
    expect(fleet!.pendingAsk(laneId)?.id).toBe(next.parked!.id);
  }, TIMEOUT);

  test("refused: no approve scope, another root, a revoked hub, a misreported action, an expired decision", async () => {
    const r = rig();
    const { pairing, laneId } = await r.setup();
    const { parked } = await r.askFor(pairing, laneId, { kind: "fetch", title: "fetch x", rawInput: { url: "https://x" } });
    const hub = key();
    const recallOnly = cert(r.root, hub, ["recall", "drive"]);
    const good = cert(r.root, hub, ["approve"]);
    const foreign = cert(key(), hub, ["approve"]);
    const tries: [object, string][] = [
      [{ decision: decision(hub, laneId, parked!, true), cert: recallOnly.token }, "does not carry the approve scope"],
      [{ decision: decision(hub, laneId, parked!, true), cert: foreign.token }, "not signed by the approver root"],
      [{ decision: decision(hub, laneId, { ...parked!, input: canonical({ url: "https://harmless" }) }, true), cert: good.token }, "different action"],
      [{ decision: decision(hub, laneId, parked!, true, { iat: now() - 7200, exp: now() - 60 }), cert: good.token }, "not in date"],
      [{ decision: decision(key(), laneId, parked!, true), cert: good.token }, "not signed by the approver"],
      [{ decision: decision(hub, laneId, parked!, true, { crl: 1 }), cert: good.token, crl: crlOf(r.root, 1, [good.serial]) }, "revoked"],
    ];
    for (const [body, why] of tries) {
      const res = await r.call("decide", pairing, { laneId, askId: parked!.id, ...body });
      expect(res.status).toBe(403);
      expect(res.json.error).toContain(why);
    }
    expect(fleet!.pendingAsk(laneId)?.id).toBe(parked!.id); // still parked, nothing released
    // the CRL shown above was newer, so the engine now holds it: the revoked hub stays refused without it
    expect(r.store.pairingForLane(laneId)?.remote?.crl.version).toBe(1);
    const again = await r.call("decide", pairing, { laneId, askId: parked!.id, decision: decision(hub, laneId, parked!, true, { crl: 1 }), cert: good.token });
    expect(again.json.error).toContain("revoked");
  }, TIMEOUT);

  test("the controller can deny without a signature; cancel releases a parked ask", async () => {
    const r = rig();
    const { pairing, laneId } = await r.setup();
    const one = await r.askFor(pairing, laneId, { kind: "fetch", title: "fetch a", rawInput: { url: "https://a" } });
    expect((await r.call("deny", pairing, { laneId, askId: one.parked!.id })).status).toBe(200);
    expect(await r.settled(laneId)).toContain(CANCELLED);
    const two = await r.askFor(pairing, laneId, { kind: "fetch", title: "fetch b", rawInput: { url: "https://b" } });
    expect(two.parked).not.toBeNull();
    expect((await r.call("cancel", pairing, { laneId })).status).toBe(200);
    expect(fleet!.pendingAsk(laneId)).toBeNull();
  }, TIMEOUT);

  test("a pairing without an approver root has no remote policy and accepts no decision", async () => {
    const r = rig();
    const p = await r.call("pair", null, { name: "plain", workspace: ws });
    const pairing = (await r.store.verify(String(p.json.data!.token)))!;
    expect(pairing.remote).toBeUndefined();
    expect((await r.call("pair", null, { name: "bad", workspace: ws, approverRoot: "not-a-key" })).status).toBe(400);
  }, TIMEOUT);
});

describe("the off-task check only tightens", () => {
  test("a T1 edit the checker calls off-task parks instead of running; on-task runs", async () => {
    const off = rig({ offTask: "off", offTaskOn: true });
    const a = await off.setup();
    const parked = await off.askFor(a.pairing, a.laneId, { kind: "edit", title: "edit", rawInput: { path: "src/a.ts" } });
    expect(parked.parked?.reason).toContain(`off-task check answered "off"`);
    fleet!.stopAll();
    const on = rig({ offTask: "on", offTaskOn: true });
    const b = await on.setup();
    expect((await on.askFor(b.pairing, b.laneId, { kind: "edit", title: "edit", rawInput: { path: "src/a.ts" } })).reply).toContain(ALLOWED);
  }, TIMEOUT);

  test("a missing checker parks too (fail-closed), and only an unambiguous ON_TASK counts", async () => {
    const r = rig({ offTaskOn: true });
    const { pairing, laneId } = await r.setup();
    expect((await r.askFor(pairing, laneId, { kind: "edit", title: "edit", rawInput: { path: "src/a.ts" } })).parked).not.toBeNull();
    expect(parseOffTask("ON_TASK")).toBe("on");
    expect(parseOffTask(" on_task\n")).toBe("on");
    expect(parseOffTask("ON_TASK or OFF_TASK")).toBe("unknown");
    expect(parseOffTask("")).toBe("unknown");
    expect(parseOffTask("Sure! OFF_TASK")).toBe("off");
  }, TIMEOUT);
});

test("verifyRemoteDecision accepts a newer CRL and never an older one", () => {
  const root = key(), hub = key(), c = cert(root, hub, ["approve"]);
  const ask: RemoteAsk = { id: "a1", digest: askDigest("fetch", "t", "null"), kind: "fetch", title: "t", input: "null", tier: "T2", reason: "", openedAt: 0, expiresAt: 0 };
  const exp = { lane: "L", ask: "a1", digest: ask.digest };
  const v = verifyRemoteDecision({ decision: decision(hub, "L", ask, true, { crl: 2 }), cert: c.token, crl: crlOf(root, 2, []) }, root.spki, { version: 1, serials: [] }, exp);
  expect(v.ok && v.crl.version).toBe(2);
  const older = verifyRemoteDecision({ decision: decision(hub, "L", ask, true), cert: c.token, crl: crlOf(root, 1, []) }, root.spki, { version: 3, serials: [c.serial] }, exp);
  expect(older).toEqual({ ok: false, reason: "the approver certificate is revoked" });
  const unseen = verifyRemoteDecision({ decision: decision(hub, "L", ask, true, { crl: 5 }), cert: c.token }, root.spki, { version: 3, serials: [] }, exp);
  expect(unseen.ok).toBe(false);
});

// ── ADR-0477: a hub certified by a delegate (the add-on's phase F2), chain depth one ──────────────────────
describe("a delegate-certified hub is accepted exactly when the add-on's TrustStore would", () => {
  const DAY = 86_400;
  /** A delegation (the add-on's `issueDelegation` payload) for `del`, signed by `signer` (the root unless a test
   *  forges depth two). */
  function delegation(root: Node, del: Node, may: string[], limits: Record<string, unknown> = { maxDays: 30 }, over: Record<string, unknown> = {}, signer: KeyObject = root.priv) {
    const serial = randomBytes(16).toString("hex");
    return { serial, token: compact({ v: 1, typ: "lucid-delegation", root: root.id, serial, id: del.id, label: "team", spki: del.spki, may, limits, iat: now() - 60, exp: now() + 30 * DAY, ...over }, signer) };
  }
  /** A hub certificate the delegate signed (the add-on's `issueCert` with `delegation`): it names its user, its
   *  issuer and carries the delegation token. */
  function delegatedCert(root: Node, del: Node, delegationToken: string, hub: Node, scopes: string[], over: Record<string, unknown> = {}) {
    const email = "ana@example.com";
    const user = { id: `u_${new Bun.CryptoHasher("sha256").update(email).digest("hex").slice(0, 32)}`, email };
    return compact({ v: 1, typ: "lucid-node-cert", serial: randomBytes(16).toString("hex"), root: root.id, node: hub.id, role: "hub", label: "test hub", spki: hub.spki, scopes, iat: now() - 10, exp: now() + 3600, user, issuer: del.id, delegation: delegationToken, ...over }, del.priv);
  }
  const ask: RemoteAsk = { id: "a1", digest: askDigest("fetch", "t", "null"), kind: "fetch", title: "t", input: "null", tier: "T2", reason: "", openedAt: 0, expiresAt: 0 };
  const exp = { lane: "L", ask: "a1", digest: ask.digest };
  const fresh = { version: 0, serials: [] };

  test("a delegate-certified approve is accepted; the root-signed path still is", () => {
    const root = key(), team = key(), hub = key();
    const d = delegation(root, team, ["custody", "users"], { maxDays: 30, roles: ["hub"], scopes: ["approve", "recall"], emailDomains: ["example.com"], labelPrefix: "test" });
    const v = verifyRemoteDecision({ decision: decision(hub, "L", ask, true), cert: delegatedCert(root, team, d.token, hub, ["approve", "recall"]) }, root.spki, fresh, exp);
    expect(v).toMatchObject({ ok: true, allow: true, approver: hub.id, label: "test hub" });
    const direct = verifyRemoteDecision({ decision: decision(hub, "L", ask, true), cert: cert(root, hub, ["approve"]).token }, root.spki, fresh, exp);
    expect(direct.ok).toBe(true);
  });

  test("a delegation without the users power cannot certify an approver", () => {
    const root = key(), team = key(), hub = key();
    const d = delegation(root, team, ["custody", "spokes"]);
    const v = verifyRemoteDecision({ decision: decision(hub, "L", ask, true), cert: delegatedCert(root, team, d.token, hub, ["approve"]) }, root.spki, fresh, exp);
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reason).toContain("no users power");
  });

  test("certificate scopes, lifetime or user beyond the delegation's limits are refused", () => {
    const root = key(), team = key(), hub = key();
    const d = delegation(root, team, ["users"], { maxDays: 1, scopes: ["drive", "recall"], emailDomains: ["corp.example"] });
    const outside = verifyRemoteDecision({ decision: decision(hub, "L", ask, true), cert: delegatedCert(root, team, d.token, hub, ["approve"]) }, root.spki, fresh, exp);
    expect(!outside.ok && outside.reason).toContain("scope approve is outside");
    const wide = delegation(root, team, ["users"], { maxDays: 1 });
    const tooLong = verifyRemoteDecision({ decision: decision(hub, "L", ask, true), cert: delegatedCert(root, team, wide.token, hub, ["approve"], { exp: now() + 2 * DAY }) }, root.spki, fresh, exp);
    expect(!tooLong.ok && tooLong.reason).toContain("at most 1 days");
    const domains = delegation(root, team, ["users"], { maxDays: 30, emailDomains: ["corp.example"] });
    const foreign = verifyRemoteDecision({ decision: decision(hub, "L", ask, true), cert: delegatedCert(root, team, domains.token, hub, ["approve"]) }, root.spki, fresh, exp);
    expect(!foreign.ok && foreign.reason).toContain("email domains");
    const noUser = verifyRemoteDecision({ decision: decision(hub, "L", ask, true), cert: delegatedCert(root, team, wide.token, hub, ["approve"], { user: undefined }) }, root.spki, fresh, exp);
    expect(!noUser.ok && noUser.reason).toContain("must name its user");
  });

  test("a revoked delegation takes down every certificate it signed, from the held CRL or a newer one sent", () => {
    const root = key(), team = key(), hub = key();
    const d = delegation(root, team, ["users"]);
    const c = delegatedCert(root, team, d.token, hub, ["approve"]);
    const held = verifyRemoteDecision({ decision: decision(hub, "L", ask, true), cert: c }, root.spki, { version: 1, serials: [d.serial] }, exp);
    expect(held).toEqual({ ok: false, reason: "the approver certificate's delegation is revoked" });
    const sent = verifyRemoteDecision({ decision: decision(hub, "L", ask, true, { crl: 2 }), cert: c, crl: crlOf(root, 2, [d.serial]) }, root.spki, { version: 1, serials: [] }, exp);
    expect(sent).toEqual({ ok: false, reason: "the approver certificate's delegation is revoked", crl: { version: 2, serials: [d.serial] } });
  });

  test("depth two is refused: a delegate cannot delegate further", () => {
    const root = key(), team = key(), sub = key(), hub = key();
    const first = delegation(root, team, ["users"]);
    expect(verifyRemoteDecision({ decision: decision(hub, "L", ask, true), cert: delegatedCert(root, team, first.token, hub, ["approve"]) }, root.spki, fresh, exp).ok).toBe(true);
    // The team key signs a delegation for a sub-delegate, which then certifies the hub.
    const second = delegation(root, sub, ["users"], { maxDays: 30 }, {}, team.priv);
    const v = verifyRemoteDecision({ decision: decision(hub, "L", ask, true), cert: delegatedCert(root, sub, second.token, hub, ["approve"]) }, root.spki, fresh, exp);
    expect(v).toEqual({ ok: false, reason: "the approver certificate's delegation is not signed by the approver root" });
  });

  test("an expired delegation is refused even when the certificate is still in date", () => {
    const root = key(), team = key(), hub = key();
    const d = delegation(root, team, ["users"], { maxDays: 30 }, { iat: now() - 10 * DAY, exp: now() - 60 });
    const v = verifyRemoteDecision({ decision: decision(hub, "L", ask, true), cert: delegatedCert(root, team, d.token, hub, ["approve"]) }, root.spki, fresh, exp);
    expect(v).toEqual({ ok: false, reason: "the approver certificate's delegation is not in date" });
  });
});
