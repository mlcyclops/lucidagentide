// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/controller/remote_approval.test.ts - P-CTRL-REMOTE.1 (ADR-0493). The REAL lane manager and the REAL
// controller routes against the faithful fake ACP agent (a real subprocess), which asks permission for exactly
// the tool call a prompt scripts. What must hold:
//   - the tier policy decides a remote lane's asks: T0/T1 inside the workspace run, known destructive and edits
//     outside are refused with no way to approve, the rest park;
//   - only a decision the ENGINE verifies against the paired root releases a parked ask (approve scope, not
//     revoked, this lane, this ask, this digest, in date); the controller can deny but never approve;
//   - a decision cannot be replayed onto a later ask; cancel releases a parked ask; the off-task check only
//     ever tightens;
//   - ADR-0502: a pairing that requires user presence releases an allow only with presence evidence from the key
//     the approver's certificate names, bound to that one decision; a deny needs none.
//   - ADR-0505: a delegate-certified approver decides only with the paired spoke's own certificate inside its
//     delegation (label prefix, regions, classifications) and with its user on the delegation's users list when it
//     has one; a CRL more than three days past its nextUpdate refuses every decision, and once one with nextUpdate
//     is held a list without it is never taken.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateDecision } from "../../harness/security/gate.ts";
import type { TelemetryEvent } from "../../harness/telemetry/events.ts";
import { FleetLaneManager } from "../fleet_lanes.ts";
import type { SystemSnapshot } from "../system_profile.ts";
import { askDigest, canonical, classifyAsk, parseOffTask, presenceChallenge, verifyRemoteDecision, type CrlState, type Expected, type PresenceKind, type RemoteAsk } from "./remote_policy.ts";
import { ControllerLaneStore } from "./lane_store.ts";
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
const decisionPayload = (hub: Node, lane: string, ask: RemoteAsk, allow: boolean, over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ v: 1, typ: "lucid-approval", lane, ask: ask.id, digest: askDigest(ask.kind, ask.title, ask.input), allow, approver: hub.id, crl: 0, iat: now(), exp: now() + 600, ...over });
function decision(hub: Node, lane: string, ask: RemoteAsk, allow: boolean, over: Record<string, unknown> = {}) {
  return compact(decisionPayload(hub, lane, ask, allow, over), hub.priv);
}

// ── ADR-0502: a fake user-presence authenticator (the add-on's presence.ts after the gesture) ─────────────
interface Authenticator { priv: KeyObject; ref: { kind: PresenceKind; spki: string } }
/** Windows Hello's key credential is RSA 2048 (PKCS#1 v1.5 / SHA-256); the Secure Enclave's and the password
 *  kind's are P-256. */
function authenticator(kind: PresenceKind): Authenticator {
  const { privateKey, publicKey } = kind === "windows-hello" ? generateKeyPairSync("rsa", { modulusLength: 2048 }) : generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { priv: privateKey, ref: { kind, spki: b64u(publicKey.export({ type: "spki", format: "der" })) } };
}
/** A decision carrying `auth`'s presence signature over its own challenge, signed by the hub key. */
function presentDecision(hub: Node, lane: string, ask: RemoteAsk, allow: boolean, auth: Authenticator, over: Record<string, unknown> = {}) {
  const payload = decisionPayload(hub, lane, ask, allow, over);
  return compact({ ...payload, presence: b64u(sign("sha256", presenceChallenge(payload), auth.priv)) }, hub.priv);
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

function rig(opts: { offTask?: "on" | "off" | "unknown"; offTaskOn?: boolean; presence?: "required" | "none" } = {}) {
  const root = key();
  const events: TelemetryEvent[] = [];
  const rulings: string[] = [];
  const rigDir = mkdtempSync(join(dir, "rig-"));
  const store = new PairingStore(join(rigDir, "controller-pairings.json"));
  fleet?.stopAll();
  fleet = new FleetLaneManager({
    argv: () => ({ cmd: "bun", args: [FAKE] }), masterModel: () => "m", sample: async () => healthy,
    ...(opts.offTask ? { offTask: async () => opts.offTask! } : {}),
    remoteAudit: (_laneId, v) => { rulings.push(v.ruling); },
  });
  const deps: ControllerDeps = { store, lanes: new ControllerLaneStore(join(rigDir, "controller-lanes.json")), fleet, scan: async () => CLEAN, sink: (e) => events.push(e) };
  const call = async (path: string, pairing: Pairing | null, body?: unknown, query = "") => {
    const req = new Request(`http://127.0.0.1/api/controller/${path}${query}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
    const res = await handleController(req, `/api/controller/${path}`, pairing, deps);
    const text = await res.text();
    return { status: res.status, json: (res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : {}) as { ok?: boolean; error?: string; data?: Record<string, unknown> } };
  };
  /** `extra`: more pair body fields (ADR-0505: spokeNode). */
  const setup = async (extra: Record<string, string> = {}) => {
    const p = await call("pair", null, { name: "spoke", workspace: ws, approverRoot: root.spki, approvalHours: "1", offTask: opts.offTaskOn ? "on" : "off", ...(opts.presence ? { presence: opts.presence } : {}), ...extra });
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
    expect(pairing.spokeNode).toBeUndefined();
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
  const exp = { lane: "L", ask: "a1", digest: ask.digest, presence: false };
  const v = verifyRemoteDecision({ decision: decision(hub, "L", ask, true, { crl: 2 }), cert: c.token, crl: crlOf(root, 2, []) }, root.spki, { version: 1, serials: [] }, exp);
  expect(v.ok && v.crl.version).toBe(2);
  const older = verifyRemoteDecision({ decision: decision(hub, "L", ask, true), cert: c.token, crl: crlOf(root, 1, []) }, root.spki, { version: 3, serials: [c.serial] }, exp);
  expect(older).toEqual({ ok: false, reason: "the approver certificate is revoked" });
  const unseen = verifyRemoteDecision({ decision: decision(hub, "L", ask, true, { crl: 5 }), cert: c.token }, root.spki, { version: 3, serials: [] }, exp);
  expect(unseen.ok).toBe(false);
});

// ── ADR-0494: a hub certified by a delegate (the add-on's phase F2), chain depth one ──────────────────────
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
  /** ADR-0505: the spoke the pairing names. A delegate-certified approver needs its certificate with the decision. */
  const spoke = key();
  const exp = { lane: "L", ask: "a1", digest: ask.digest, presence: false, spokeNode: spoke.id };
  const fresh = { version: 0, serials: [] };
  /** A spoke certificate (the add-on's `issueCert` for a spoke): root-signed unless `signer` is a delegate, whose
   *  `issuer` and `delegation` then ride in `over`. */
  function spokeCert(root: Node, over: Record<string, unknown> = {}, signer: KeyObject = root.priv, n: Node = spoke) {
    return compact({ v: 1, typ: "lucid-node-cert", serial: randomBytes(16).toString("hex"), root: root.id, node: n.id, role: "spoke", label: "test spoke", spki: n.spki, scopes: [], iat: now() - 10, exp: now() + 3600, region: "eu-west", classification: "private", ...over }, signer);
  }

  test("a delegate-certified approve is accepted; the root-signed path still is", () => {
    const root = key(), team = key(), hub = key();
    const d = delegation(root, team, ["custody", "users"], { maxDays: 30, roles: ["hub"], scopes: ["approve", "recall"], emailDomains: ["example.com"], labelPrefix: "test" });
    const v = verifyRemoteDecision({ decision: decision(hub, "L", ask, true), cert: delegatedCert(root, team, d.token, hub, ["approve", "recall"]), spokeCert: spokeCert(root) }, root.spki, fresh, exp);
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
    expect(verifyRemoteDecision({ decision: decision(hub, "L", ask, true), cert: delegatedCert(root, team, first.token, hub, ["approve"]), spokeCert: spokeCert(root) }, root.spki, fresh, exp).ok).toBe(true);
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

  test("ADR-0502: a delegate-certified hub's presence key satisfies a pairing that requires presence", () => {
    const root = key(), team = key(), hub = key(), mac = authenticator("macos-secure-enclave");
    const c = delegatedCert(root, team, delegation(root, team, ["users"]).token, hub, ["approve"], { presence: mac.ref });
    const required = { ...exp, presence: true };
    expect(verifyRemoteDecision({ decision: presentDecision(hub, "L", ask, true, mac), cert: c, spokeCert: spokeCert(root) }, root.spki, fresh, required)).toMatchObject({ ok: true, allow: true, presence: "macos-secure-enclave" });
    const bare = verifyRemoteDecision({ decision: decision(hub, "L", ask, true), cert: c, spokeCert: spokeCert(root) }, root.spki, fresh, required);
    expect(!bare.ok && bare.reason).toBe("this pairing requires user presence and the approval carries no presence evidence");
  });

  // ── ADR-0505 (the add-on's RS-ID-01): a delegated approver decides only for a spoke its delegation covers ──
  describe("ADR-0505: delegation coverage of the paired spoke", () => {
    const NOT_COVERED = { ok: false, reason: "the approver's delegation does not cover this spoke" };
    /** A pairing made before ADR-0505, or by a controller that sent no spokeNode. */
    const unpaired: Expected = { lane: "L", ask: "a1", digest: ask.digest, presence: false };
    /** A team delegation limited to `test` labels in eu-west, private spokes, and a delegate-certified approver. */
    function team(limits: Record<string, unknown> = { maxDays: 30, labelPrefix: "test", regions: ["eu-west"], classifications: ["private"] }) {
      const root = key(), del = key(), hub = key();
      const d = delegation(root, del, ["users"], limits);
      return { root, del, hub, cert: delegatedCert(root, del, d.token, hub, ["approve"]) };
    }

    test("a spoke certificate for the paired node inside the label prefix, region and classification is accepted", () => {
      const t = team();
      expect(verifyRemoteDecision({ decision: decision(t.hub, "L", ask, true), cert: t.cert, spokeCert: spokeCert(t.root) }, t.root.spki, fresh, exp)).toMatchObject({ ok: true, allow: true, approver: t.hub.id });
      // a delegation with no coverage limits reaches every spoke of its root
      const wide = team({ maxDays: 30 });
      expect(verifyRemoteDecision({ decision: decision(wide.hub, "L", ask, true), cert: wide.cert, spokeCert: spokeCert(wide.root, { region: undefined, classification: undefined, label: "any" }) }, wide.root.spki, fresh, exp).ok).toBe(true);
    });

    test("a spoke outside the label prefix, the regions or the classifications is refused", () => {
      const t = team();
      const outside = (over: Record<string, unknown>) => verifyRemoteDecision({ decision: decision(t.hub, "L", ask, true), cert: t.cert, spokeCert: spokeCert(t.root, over) }, t.root.spki, fresh, exp);
      expect(outside({ label: "ops spoke" })).toEqual(NOT_COVERED);
      expect(outside({ region: "us-east" })).toEqual(NOT_COVERED);
      expect(outside({ region: undefined })).toEqual(NOT_COVERED);
      expect(outside({ classification: "cui" })).toEqual(NOT_COVERED);
      expect(outside({ classification: undefined })).toEqual(NOT_COVERED);
    });

    test("no paired spokeNode, or a missing, foreign, unverifiable, revoked or non-spoke certificate is refused", () => {
      const t = team();
      const d = (spokeCertToken: string | undefined, expected: Expected = exp, held: CrlState = fresh) =>
        verifyRemoteDecision({ decision: decision(t.hub, "L", ask, true), cert: t.cert, ...(spokeCertToken !== undefined ? { spokeCert: spokeCertToken } : {}) }, t.root.spki, held, expected);
      expect(d(spokeCert(t.root), unpaired)).toEqual(NOT_COVERED);
      expect(d(undefined)).toEqual(NOT_COVERED);
      // another spoke's genuine certificate: covered, but not the spoke this pairing names
      expect(d(spokeCert(t.root, {}, t.root.priv, key()))).toEqual(NOT_COVERED);
      // signed by another root, signed by nobody, and a tampered body
      expect(d(spokeCert(key()))).toEqual(NOT_COVERED);
      expect(d("garbage.token")).toEqual(NOT_COVERED);
      const [body, sig] = spokeCert(t.root).split(".");
      const forged = Buffer.from(Buffer.from(body!, "base64url").toString("utf8").replace("eu-west", "eu-wesu")).toString("base64url");
      expect(d(`${forged}.${sig}`)).toEqual(NOT_COVERED);
      // the spoke's own certificate revoked on the held CRL, expired, or a hub's certificate for the spoke's key
      const serial = randomBytes(16).toString("hex");
      expect(d(spokeCert(t.root, { serial }), exp, { version: 1, serials: [serial] })).toEqual(NOT_COVERED);
      expect(d(spokeCert(t.root, { iat: now() - 7200, exp: now() - 60 }))).toEqual(NOT_COVERED);
      expect(d(spokeCert(t.root, { role: "hub", region: undefined, classification: undefined, scopes: ["recall"] }))).toEqual(NOT_COVERED);
    });

    test("a delegate-certified spoke counts only inside its own delegation; the approver's limits still apply", () => {
      const t = team();
      const fleet = key();
      const spokes = delegation(t.root, fleet, ["spokes"], { maxDays: 30, regions: ["eu-west"] });
      const viaFleet = (over: Record<string, unknown> = {}) => spokeCert(t.root, { issuer: fleet.id, delegation: spokes.token, ...over }, fleet.priv);
      const run = (token: string) => verifyRemoteDecision({ decision: decision(t.hub, "L", ask, true), cert: t.cert, spokeCert: token }, t.root.spki, fresh, exp);
      expect(run(viaFleet()).ok).toBe(true);
      // outside the spoke's own delegation (its region list), even though the approver's would cover it
      const narrow = delegation(t.root, fleet, ["spokes"], { maxDays: 30, regions: ["us-east"] });
      expect(run(spokeCert(t.root, { issuer: fleet.id, delegation: narrow.token }, fleet.priv))).toEqual(NOT_COVERED);
      // a delegation without the spokes or enroll power certifies no spoke
      const usersOnly = delegation(t.root, fleet, ["users"]);
      expect(run(spokeCert(t.root, { issuer: fleet.id, delegation: usersOnly.token }, fleet.priv))).toEqual(NOT_COVERED);
      // its delegation revoked
      expect(verifyRemoteDecision({ decision: decision(t.hub, "L", ask, true), cert: t.cert, spokeCert: viaFleet() }, t.root.spki, { version: 1, serials: [spokes.serial] }, exp)).toEqual(NOT_COVERED);
    });

    test("a root-signed approver needs neither the paired spokeNode nor a spoke certificate", () => {
      const root = key(), hub = key();
      expect(verifyRemoteDecision({ decision: decision(hub, "L", ask, true), cert: cert(root, hub, ["approve"]).token }, root.spki, fresh, unpaired).ok).toBe(true);
      expect(verifyRemoteDecision({ decision: decision(hub, "L", ask, true), cert: cert(root, hub, ["approve"]).token, spokeCert: "garbage" }, root.spki, fresh, exp).ok).toBe(true);
    });

    test("the pair route keeps a valid spokeNode and refuses a malformed one; decide hands the spoke certificate to the check", async () => {
      const r = rig();
      for (const bad of ["n_0123", `n_${"A".repeat(32)}`, `x_${"0".repeat(32)}`, `n_${"0".repeat(33)}`]) {
        expect((await r.call("pair", null, { name: "bad", workspace: ws, approverRoot: r.root.spki, spokeNode: bad })).status).toBe(400);
      }
      const { pairing, laneId } = await r.setup({ spokeNode: spoke.id });
      expect(pairing.spokeNode).toBe(spoke.id);
      expect(r.store.byId(pairing.id)?.spokeNode).toBe(spoke.id);
      const del = key(), hub = key();
      const approver = delegatedCert(r.root, del, delegation(r.root, del, ["users"], { maxDays: 30, labelPrefix: "test", regions: ["eu-west"] }).token, hub, ["approve"]);
      const { parked } = await r.askFor(pairing, laneId, { kind: "fetch", title: "fetch x", rawInput: { url: "https://x" } });
      expect(parked).not.toBeNull();
      const body = { laneId, askId: parked!.id, decision: decision(hub, laneId, parked!, true), cert: approver };
      for (const extra of [{}, { spokeCert: spokeCert(r.root, { region: "us-east" }) }, { spokeCert: spokeCert(r.root, {}, r.root.priv, key()) }]) {
        const refused = await r.call("decide", pairing, { ...body, ...extra });
        expect([refused.status, refused.json.error]).toEqual([403, "the approver's delegation does not cover this spoke"]);
      }
      expect(fleet!.pendingAsk(laneId)?.id).toBe(parked!.id);
      expect((await r.call("decide", pairing, { ...body, spokeCert: spokeCert(r.root) })).status).toBe(200);
      expect(await r.settled(laneId)).toContain(ALLOWED);
    }, TIMEOUT);

    test("a delegation's users limit admits only the approvers it lists", () => {
      const listed = team({ maxDays: 30, users: ["ana@example.com"] });
      expect(verifyRemoteDecision({ decision: decision(listed.hub, "L", ask, true), cert: listed.cert, spokeCert: spokeCert(listed.root) }, listed.root.spki, fresh, exp).ok).toBe(true);
      const other = team({ maxDays: 30, users: ["bob@example.com"] });
      expect(verifyRemoteDecision({ decision: decision(other.hub, "L", ask, true), cert: other.cert, spokeCert: spokeCert(other.root) }, other.root.spki, fresh, exp))
        .toEqual({ ok: false, reason: "user ana@example.com is outside this delegation's users" });
      const bad = team({ maxDays: 30, users: ["Not An Email"] });
      const v = verifyRemoteDecision({ decision: decision(bad.hub, "L", ask, true), cert: bad.cert, spokeCert: spokeCert(bad.root) }, bad.root.spki, fresh, exp);
      expect(!v.ok && v.reason).toContain("limits.users");
    });
  });
});

// ── ADR-0505 (the add-on's RS-CRL-01): a CRL that expires ─────────────────────────────────────────────
describe("a CRL with nextUpdate goes stale three days after it", () => {
  const DAY = 86_400;
  const STALE = "the approver root's revocation list is out of date; publish a fresh one";
  const ask: RemoteAsk = { id: "a1", digest: askDigest("fetch", "t", "null"), kind: "fetch", title: "t", input: "null", tier: "T2", reason: "", openedAt: 0, expiresAt: 0 };
  const exp = { lane: "L", ask: "a1", digest: ask.digest, presence: false };
  const crlAt = (root: Node, version: number, iat: number, nextUpdate?: number) =>
    compact({ v: 1, typ: "lucid-crl", root: root.id, version, serials: [], iat, ...(nextUpdate !== undefined ? { nextUpdate } : {}) }, root.priv);

  test("a held list past nextUpdate plus three days refuses every decision; inside the grace it does not", () => {
    const root = key(), hub = key(), c = cert(root, hub, ["approve"]).token;
    const run = (nextUpdate: number) => verifyRemoteDecision({ decision: decision(hub, "L", ask, true, { crl: 2 }), cert: c }, root.spki, { version: 2, serials: [], nextUpdate }, exp);
    expect(run(now() - 3 * DAY - 60)).toEqual({ ok: false, reason: STALE });
    expect(run(now() - 3 * DAY + 60).ok).toBe(true);
    expect(run(now() + 7 * DAY).ok).toBe(true);
    // a deny is a decision too: a stale list refuses it as well (the controller can still deny on its own)
    expect(verifyRemoteDecision({ decision: decision(hub, "L", ask, false, { crl: 2 }), cert: c }, root.spki, { version: 2, serials: [], nextUpdate: now() - 4 * DAY }, exp)).toEqual({ ok: false, reason: STALE });
  });

  test("a fresh list sent with the decision clears a stale held one and is returned to be kept", () => {
    const root = key(), hub = key(), c = cert(root, hub, ["approve"]).token;
    const nextUpdate = now() + 7 * DAY;
    const v = verifyRemoteDecision({ decision: decision(hub, "L", ask, true, { crl: 3 }), cert: c, crl: crlAt(root, 3, now(), nextUpdate) }, root.spki, { version: 2, serials: [], nextUpdate: now() - 4 * DAY }, exp);
    expect(v).toMatchObject({ ok: true, crl: { version: 3, serials: [], nextUpdate } });
    // a stale list sent along is kept as revocation news, and still refuses
    const lapsed = now() - 4 * DAY;
    const old = verifyRemoteDecision({ decision: decision(hub, "L", ask, true, { crl: 3 }), cert: c, crl: crlAt(root, 3, lapsed - 7 * DAY, lapsed) }, root.spki, { version: 2, serials: [] }, exp);
    expect(old).toEqual({ ok: false, reason: STALE, crl: { version: 3, serials: [], nextUpdate: lapsed } });
  });

  test("a legacy list (no nextUpdate) never goes stale", () => {
    const root = key(), hub = key(), c = cert(root, hub, ["approve"]).token;
    const v = verifyRemoteDecision({ decision: decision(hub, "L", ask, true, { crl: 2 }), cert: c, crl: crlAt(root, 2, now() - 365 * DAY) }, root.spki, { version: 1, serials: [] }, exp);
    expect(v).toMatchObject({ ok: true, crl: { version: 2, serials: [] } });
    expect(v.ok && "nextUpdate" in v.crl).toBe(false);
  });

  test("once a list with nextUpdate is held, a newer one without it is never adopted", () => {
    const root = key(), hub = key(), c = cert(root, hub, ["approve"]).token;
    const held = { version: 2, serials: [], nextUpdate: now() + 7 * DAY };
    // the newer legacy list is ignored: the decision made against it names a version the engine does not hold
    const v = verifyRemoteDecision({ decision: decision(hub, "L", ask, true, { crl: 3 }), cert: c, crl: crlAt(root, 3, now()) }, root.spki, held, exp);
    expect(v).toEqual({ ok: false, reason: "the approver saw CRL v3; send that CRL with the decision" });
    // the held list stays the one in force
    const same = verifyRemoteDecision({ decision: decision(hub, "L", ask, true, { crl: 2 }), cert: c, crl: crlAt(root, 3, now()) }, root.spki, held, exp);
    expect(same).toMatchObject({ ok: true, crl: held });
    // a malformed nextUpdate (not after iat) is not a list from the root
    expect(verifyRemoteDecision({ decision: decision(hub, "L", ask, true), cert: c, crl: crlAt(root, 3, now(), now() - 1) }, root.spki, held, exp))
      .toEqual({ ok: false, reason: "the CRL is not signed by the approver root" });
  });

  test("the pairing store keeps nextUpdate and never trades it for a list without one", async () => {
    const file = join(dir, "pairings.json");
    const store = new PairingStore(file);
    const root = key();
    const r = await store.pair("p", ws, { root: root.spki, approvalHours: 1, offTask: false, crl: { version: 0, serials: [] } });
    if (!r.ok) throw new Error(r.error);
    store.advanceCrl(r.pairing.id, { version: 1, serials: [] });
    expect(store.byId(r.pairing.id)?.remote?.crl).toEqual({ version: 1, serials: [] });
    store.advanceCrl(r.pairing.id, { version: 2, serials: [], nextUpdate: 1_000 });
    store.advanceCrl(r.pairing.id, { version: 3, serials: ["x"] });
    expect(store.byId(r.pairing.id)?.remote?.crl).toEqual({ version: 2, serials: [], nextUpdate: 1_000 });
    // it survives a reload
    expect(new PairingStore(file).byId(r.pairing.id)?.remote?.crl).toEqual({ version: 2, serials: [], nextUpdate: 1_000 });
  });
});

// ── ADR-0502: user presence on approve ─────────────────────────────────────────────────────────────────
describe("a pairing that requires user presence", () => {
  test("refuses an allow without presence evidence, accepts one with a Windows Hello key's evidence", async () => {
    const r = rig({ presence: "required" });
    const { pairing, laneId } = await r.setup();
    expect(r.store.pairingForLane(laneId)?.remote?.presence).toBe("required");
    const hub = key(), hello = authenticator("windows-hello");
    const withKey = cert(r.root, hub, ["approve"], { presence: hello.ref });
    const without = cert(r.root, hub, ["approve"]);
    const { parked } = await r.askFor(pairing, laneId, { kind: "execute", title: "bun test", rawInput: { command: "bun test" } });
    expect(parked).not.toBeNull();
    const tries: [object, string][] = [
      [{ decision: decision(hub, laneId, parked!, true), cert: withKey.token }, "this pairing requires user presence and the approval carries no presence evidence"],
      [{ decision: decision(hub, laneId, parked!, true), cert: without.token }, "this pairing requires user presence and the approver certificate names no presence key"],
      [{ decision: presentDecision(hub, laneId, parked!, true, hello), cert: without.token }, "the decision carries presence evidence but the approver certificate names no presence key"],
      [{ decision: presentDecision(hub, laneId, parked!, true, authenticator("windows-hello")), cert: withKey.token }, "the presence evidence does not verify for this decision"],
    ];
    for (const [body, why] of tries) {
      const res = await r.call("decide", pairing, { laneId, askId: parked!.id, ...body });
      expect(res.status).toBe(403);
      expect(res.json.error).toBe(why);
    }
    expect(fleet!.pendingAsk(laneId)?.id).toBe(parked!.id); // nothing released
    const ok = await r.call("decide", pairing, { laneId, askId: parked!.id, decision: presentDecision(hub, laneId, parked!, true, hello), cert: withKey.token });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toEqual({ allow: true, approver: hub.id, presence: "windows-hello" });
    expect(await r.settled(laneId)).toContain(ALLOWED);
  }, TIMEOUT);

  test("accepts an allow with the evidence of a password-unwrapped presence key (kind password)", async () => {
    const r = rig({ presence: "required" });
    const { pairing, laneId } = await r.setup();
    const hub = key(), pw = authenticator("password"), c = cert(r.root, hub, ["approve"], { presence: pw.ref });
    const { parked } = await r.askFor(pairing, laneId, { kind: "execute", title: "bun test", rawInput: { command: "bun test" } });
    expect(parked).not.toBeNull();
    const bare = await r.call("decide", pairing, { laneId, askId: parked!.id, decision: decision(hub, laneId, parked!, true), cert: c.token });
    expect(bare.status).toBe(403);
    expect(bare.json.error).toBe("this pairing requires user presence and the approval carries no presence evidence");
    const ok = await r.call("decide", pairing, { laneId, askId: parked!.id, decision: presentDecision(hub, laneId, parked!, true, pw), cert: c.token });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toEqual({ allow: true, approver: hub.id, presence: "password" });
    expect(await r.settled(laneId)).toContain(ALLOWED);
  }, TIMEOUT);

  test("presence evidence is bound to one decision: moved onto the next ask it is refused; a signed deny needs none", async () => {
    const r = rig({ presence: "required" });
    const { pairing, laneId } = await r.setup();
    const hub = key(), hello = authenticator("windows-hello"), c = cert(r.root, hub, ["approve"], { presence: hello.ref });
    const first = await r.askFor(pairing, laneId, { kind: "fetch", title: "fetch a", rawInput: { url: "https://a" } });
    const firstPayload = decisionPayload(hub, laneId, first.parked!, true);
    const evidence = b64u(sign("sha256", presenceChallenge(firstPayload), hello.priv));
    expect((await r.call("decide", pairing, { laneId, askId: first.parked!.id, decision: compact({ ...firstPayload, presence: evidence }, hub.priv), cert: c.token })).status).toBe(200);
    await r.settled(laneId);
    const next = await r.askFor(pairing, laneId, { kind: "fetch", title: "fetch b", rawInput: { url: "https://b" } });
    // The hub key signs a fresh decision for the next ask, but the gesture's evidence is the first one's.
    const moved = compact({ ...decisionPayload(hub, laneId, next.parked!, true), presence: evidence }, hub.priv);
    const replay = await r.call("decide", pairing, { laneId, askId: next.parked!.id, decision: moved, cert: c.token });
    expect(replay.status).toBe(403);
    expect(replay.json.error).toBe("the presence evidence does not verify for this decision");
    // Evidence made for a deny of this ask does not become an allow either.
    const denyPayload = decisionPayload(hub, laneId, next.parked!, false);
    const flipped = compact({ ...denyPayload, allow: true, presence: b64u(sign("sha256", presenceChallenge(denyPayload), hello.priv)) }, hub.priv);
    expect((await r.call("decide", pairing, { laneId, askId: next.parked!.id, decision: flipped, cert: c.token })).json.error).toBe("the presence evidence does not verify for this decision");
    expect(fleet!.pendingAsk(laneId)?.id).toBe(next.parked!.id);
    const deny = await r.call("decide", pairing, { laneId, askId: next.parked!.id, decision: decision(hub, laneId, next.parked!, false), cert: c.token });
    expect(deny.status).toBe(200);
    expect(deny.json.data).toEqual({ allow: false, approver: hub.id, presence: null });
    expect(await r.settled(laneId)).toContain(CANCELLED);
  }, TIMEOUT);

  test("pairing input: presence is required or none, and only on a remote pairing", async () => {
    const r = rig();
    expect((await r.call("pair", null, { name: "odd", workspace: ws, approverRoot: r.root.spki, presence: "maybe" })).status).toBe(400);
    expect((await r.call("pair", null, { name: "plain", workspace: ws, presence: "required" })).status).toBe(400);
    const none = await r.call("pair", null, { name: "none", workspace: ws, approverRoot: r.root.spki, presence: "none" });
    expect((await r.store.verify(String(none.json.data!.token)))?.remote?.presence).toBeUndefined();
  }, TIMEOUT);
});

describe("verifyRemoteDecision and presence keys", () => {
  const ask: RemoteAsk = { id: "a1", digest: askDigest("fetch", "t", "null"), kind: "fetch", title: "t", input: "null", tier: "T2", reason: "", openedAt: 0, expiresAt: 0 };
  const fresh = { version: 0, serials: [] };
  const required = { lane: "L", ask: "a1", digest: ask.digest, presence: true };

  test("a Secure Enclave P-256 key counts; a key of the wrong type for its kind is a malformed certificate", () => {
    const root = key(), hub = key(), mac = authenticator("macos-secure-enclave"), hello = authenticator("windows-hello");
    expect(verifyRemoteDecision({ decision: presentDecision(hub, "L", ask, true, mac), cert: cert(root, hub, ["approve"], { presence: mac.ref }).token }, root.spki, fresh, required))
      .toMatchObject({ ok: true, presence: "macos-secure-enclave" });
    for (const bad of [{ kind: "windows-hello", spki: mac.ref.spki }, { kind: "macos-secure-enclave", spki: hello.ref.spki }, { kind: "webauthn", spki: mac.ref.spki }, { ...mac.ref, extra: 1 }]) {
      const v = verifyRemoteDecision({ decision: presentDecision(hub, "L", ask, true, mac), cert: cert(root, hub, ["approve"], { presence: bad }).token }, root.spki, fresh, required);
      expect(v).toEqual({ ok: false, reason: "the approver certificate names a malformed presence key" });
    }
  });

  test("a password kind's P-256 key counts; under kind password an RSA or another curve's key is a malformed certificate", () => {
    const root = key(), hub = key(), pw = authenticator("password"), hello = authenticator("windows-hello");
    expect(verifyRemoteDecision({ decision: presentDecision(hub, "L", ask, true, pw), cert: cert(root, hub, ["approve"], { presence: pw.ref }).token }, root.spki, fresh, required))
      .toMatchObject({ ok: true, allow: true, presence: "password" });
    const otherCurves = ["secp384r1", "secp521r1"].map((namedCurve) => b64u(generateKeyPairSync("ec", { namedCurve }).publicKey.export({ type: "spki", format: "der" })));
    for (const spki of [hello.ref.spki, ...otherCurves]) {
      const v = verifyRemoteDecision({ decision: presentDecision(hub, "L", ask, true, pw), cert: cert(root, hub, ["approve"], { presence: { kind: "password", spki } }).token }, root.spki, fresh, required);
      expect(v).toEqual({ ok: false, reason: "the approver certificate names a malformed presence key" });
    }
  });

  test("without the requirement an allow needs no evidence, but evidence it carries is still checked", () => {
    const root = key(), hub = key(), hello = authenticator("windows-hello"), c = cert(root, hub, ["approve"], { presence: hello.ref });
    const optional = { ...required, presence: false };
    expect(verifyRemoteDecision({ decision: decision(hub, "L", ask, true), cert: c.token }, root.spki, fresh, optional)).toMatchObject({ ok: true, presence: null });
    const wrong = verifyRemoteDecision({ decision: presentDecision(hub, "L", ask, true, authenticator("windows-hello")), cert: c.token }, root.spki, fresh, optional);
    expect(wrong).toEqual({ ok: false, reason: "the presence evidence does not verify for this decision" });
  });
});
