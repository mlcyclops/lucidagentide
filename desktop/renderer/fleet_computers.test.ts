// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-FLEET-COMPUTERS.1 (ADR-0578): the words of the Computers drawer, + Agent's "Where should it run?", + Add a
// computer's pasted card, and the spoke side's "This computer is helping". What must hold: a computer's state reads
// the most urgent fact first; nothing offers a computer the hub cannot start work on, or one taken out of service;
// the wrong thing pasted is caught with words that say what to copy; this computer's work list keeps only rows it
// can show and address.

import { describe, expect, test } from "bun:test";
import {
  CARD_MAX, CARD_PREFIX, computerRows, computerState, ENDED_MAX, helpingTitle, localTaskWords, mapLocalWork, mapThisPc, parseCard, placeChoices,
  RENEW_WITHIN_MS, roomLabel, showsHelping, type LocalWorkView, type ThisPcView,
} from "./fleet_computers.ts";
import { hubActions, mapSpokeRow, type RemoteHubView, type RemoteSpokeView } from "./remote_spokes_model.ts";

const NOW = new Date(2026, 10, 13, 15, 0).getTime();
const DAY = 86_400_000;
const NODE_A = `n_${"a".repeat(32)}`;
const NODE_B = `n_${"b".repeat(32)}`;
const TASK = "t_0123456789abcdef";
const TASK2 = "t_fedcba9876543210";

/** A spoke row through the real mapper, so the fixtures are what the IDE really holds. */
function spoke(over: Record<string, unknown> = {}, node = NODE_A): RemoteSpokeView {
  const v = mapSpokeRow({
    node, label: "spoke-01", checkedAt: NOW, reachable: true, tasks: [],
    caps: { maxLanes: 2, liveLanes: 0, freeLanes: 2, host: { os: "linux" } },
    cert: { expires: NOW + 60 * DAY, region: "home" },
    ...over,
  });
  if (!v) throw new Error("fixture did not map");
  return v;
}
const working = [{ id: TASK, name: "triage", state: "working", turns: 1, updatedAt: NOW }];
const hub = (spokes: RemoteSpokeView[], scopes: ("recall" | "drive" | "approve")[] = ["recall", "drive", "approve"]): RemoteHubView => ({
  available: true, hub: { node: NODE_B, label: "workstation", scopes, presence: null, presenceUnlocked: false }, actions: hubActions(scopes), spokes,
});

describe("computerState: the most urgent fact first", () => {
  test("ready, busy, needs your OK, has a problem", () => {
    expect(computerState(spoke(), NOW)).toEqual({ state: "Ready", tone: "ok" });
    expect(computerState(spoke({ tasks: working, caps: { maxLanes: 2, liveLanes: 1, freeLanes: 1 } }), NOW)).toEqual({ state: "Busy", tone: "work" });
    expect(computerState(spoke({ tasks: [{ ...working[0], state: "awaiting_approval" }] }), NOW)).toEqual({ state: "Needs your OK", tone: "warn" });
    expect(computerState(spoke({ tasks: [{ ...working[0], state: "error" }] }), NOW)).toEqual({ state: "Has a problem", tone: "bad" });
  });

  test("asleep says since when; offline and checking say so; out of service wins over all of them", () => {
    const asleep = computerState(spoke({ silentSince: new Date(2026, 10, 13, 10, 41).getTime() }), NOW);
    expect(asleep).toEqual({ state: "Asleep since 10:41", tone: "warn" });
    expect(computerState(spoke({ reachable: false }), NOW)).toEqual({ state: "Offline", tone: "bad" });
    expect(computerState(spoke({ reachable: null }), NOW)).toEqual({ state: "Checking", tone: "off" });
    const out = computerState(spoke({ silentSince: NOW - 1000, deactivated: { since: new Date(2026, 10, 9).getTime(), reason: "moved" } }), NOW);
    expect(out).toEqual({ state: "Deactivated since 2026-11-09: moved", tone: "off" });
  });

  test("an expired certificate beats asleep and busy; renewal soon beats busy but not an agent waiting for your OK", () => {
    expect(computerState(spoke({ cert: { expires: NOW - 1 }, silentSince: NOW - 5000 }), NOW).state).toBe("Needs renewal: its certificate expired");
    const soon = spoke({ cert: { expires: NOW + RENEW_WITHIN_MS }, tasks: working });
    expect(computerState(soon, NOW)).toEqual({ state: expect.stringMatching(/^Needs renewal by /), tone: "warn" });
    expect(computerState(spoke({ cert: { expires: NOW + RENEW_WITHIN_MS + 1 }, tasks: working }), NOW).state).toBe("Busy");
    expect(computerState(spoke({ cert: { expires: NOW + DAY }, tasks: [{ ...working[0], state: "awaiting_approval" }] }), NOW).state).toBe("Needs your OK");
  });

  test("without a known expiry the spoke's own alerts say renewal: a stale revocation list, or a certificate ending", () => {
    const alert = (kind: string) => spoke({ cert: {}, alerts: [{ kind, at: NOW, detail: "", tasks: [] }] });
    expect(computerState(alert("crl-stale"), NOW).state).toBe("Needs renewal: its revocation list is out of date");
    expect(computerState(alert("cert-expiring"), NOW).state).toBe("Needs renewal soon");
    expect(computerState(alert("engine-restarted"), NOW).state).toBe("Ready");
  });
});

describe("room and the Computers list", () => {
  test("room in words, or nothing when the computer has not said", () => {
    expect(roomLabel({ live: 1, max: 2, free: 1 })).toBe("1 of 2 free");
    expect(roomLabel({ live: 2, max: 2, free: 0 })).toBe("All 2 in use");
    expect(roomLabel(null)).toBe("");
  });

  test("This PC first, then the added computers by name; an unavailable hub still lists This PC and says why", () => {
    const { rows, note } = computerRows(hub([spoke({ label: "zeta" }, NODE_B), spoke({ label: "alpha" })]), 1, NOW);
    expect(rows.map((r) => r.name)).toEqual(["This PC", "alpha", "zeta"]);
    expect(rows[0]).toMatchObject({ node: null, room: "1 agent running", state: "Ready" });
    expect(rows[1]).toMatchObject({ node: NODE_A, what: "Linux, home", room: "2 of 2 free", state: "Ready" });
    expect(note).toBeNull();
    const off = computerRows({ available: false, plugin: "stopped", reason: "The Remote Spokes plugin is not running." }, 0, NOW);
    expect(off.rows.map((r) => r.name)).toEqual(["This PC"]);
    expect(off.rows[0]!.room).toBe("no agents running");
    expect(off.note).toBe("The Remote Spokes plugin is not running.");
  });
});

describe("placeChoices: where + Agent may start", () => {
  test("This PC always first; computers that can take an agent now before those that cannot, which say why", () => {
    const full = spoke({ label: "aaa-full", caps: { maxLanes: 2, liveLanes: 2, freeLanes: 0 } }, NODE_B);
    const free = spoke({ label: "zzz-free" });
    const c = placeChoices(hub([full, free]), NOW);
    expect(c.map((p) => [p.key, p.enabled])).toEqual([["local", true], [NODE_A, true], [NODE_B, false]]);
    expect(c[1]!.sub).toBe("2 free \u00b7 Linux, home");
    expect(c[2]!.why).toBe("All 2 agents there are busy: stop one there to make room.");
  });

  test("a hub without drive offers no computer to start on, in the proposal's words; asleep and expired say so", () => {
    expect(placeChoices(hub([spoke()], ["recall"]), NOW)[1]).toMatchObject({ enabled: false, why: "This hub can watch this computer but not start work on it." });
    expect(placeChoices(hub([spoke({ silentSince: new Date(2026, 10, 13, 10, 41).getTime() })]), NOW)[1]!.why).toBe("Asleep since 10:41.");
    expect(placeChoices(hub([spoke({ cert: { expires: NOW - 1 } })]), NOW)[1]!.why).toBe("Its certificate expired: renew it before it can take work.");
  });

  test("a computer taken out of service is not a choice at all, and an unavailable hub offers only This PC", () => {
    const out = spoke({ deactivated: { since: NOW - DAY, reason: "moved" } });
    expect(placeChoices(hub([out]), NOW).map((p) => p.key)).toEqual(["local"]);
    expect(placeChoices({ available: false, plugin: "missing", reason: "x" }, NOW).map((p) => p.key)).toEqual(["local"]);
  });
});

describe("parseCard: the wrong thing pasted is caught before it reaches the hub", () => {
  const card = `${CARD_PREFIX}eyJub2RlIjoibl9hYmMifQ`;
  test("a card, surrounding whitespace trimmed; a certificate", () => {
    expect(parseCard(`  ${card}\n`)).toEqual({ ok: true, cert: card });
    const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
    expect(parseCard(pem)).toEqual({ ok: true, cert: pem });
  });

  test("empty, a card broken across lines, something else, or far too long: each says what to do", () => {
    expect(parseCard(" ")).toEqual({ ok: false, error: "Paste the connection card from the other computer first." });
    expect(parseCard(`${card}\nextra`)).toMatchObject({ ok: false, error: expect.stringContaining("one line") });
    expect(parseCard("X94X4-DTC3C")).toMatchObject({ ok: false, error: expect.stringContaining(CARD_PREFIX) });
    expect(parseCard(`${CARD_PREFIX}${"a".repeat(CARD_MAX)}`)).toMatchObject({ ok: false, error: expect.stringContaining("far longer") });
  });
});

describe("the spoke side: this computer's helper and its work", () => {
  const pc = (state: string): ThisPcView => mapThisPc({ supported: true, state, label: "macbook-m4", running: true })!;
  const row = (over: Record<string, unknown> = {}) => ({ id: TASK, name: "photos", hub: "FASTPC workstation", hubNode: NODE_B, state: "working", stateText: "Working", updatedAt: NOW, ...over });

  test("mapThisPc keeps only a known state, and the Helping view shows only once this computer helps a hub", () => {
    expect(mapThisPc({ state: "on", supported: true, running: true, card: "x", request: "y" })).toEqual({ supported: true, state: "on", label: null, running: true });
    expect(mapThisPc({ state: "sideways" })).toBeNull();
    expect(mapThisPc(null)).toBeNull();
    expect(showsHelping(pc("on"))).toBe(true);
    expect(showsHelping(pc("off"))).toBe(true);
    expect(showsHelping(pc("waiting-for-certificate"))).toBe(false);
    expect(showsHelping(mapThisPc({ supported: false, state: "on" }))).toBe(false);
  });

  test("mapLocalWork drops rows it cannot address, sorts newest first, caps the finished list, and reads an older plugin", () => {
    const w = mapLocalWork({
      paused: true, since: NOW,
      tasks: [row({ updatedAt: NOW - 10 }), row({ id: TASK2, updatedAt: NOW, queuedNotes: 2 }), row({ id: "t_bad" }), row({ id: "t_1111111111111111", state: "sleeping" })],
      ended: [
        ...Array.from({ length: ENDED_MAX + 5 }, (_, i) => ({ id: `t_${String(i).padStart(16, "0")}`, name: `e${i}`, hub: "h", state: "closed", updatedAt: i })),
        { id: "t_2222222222222222", name: "x", hub: "h", state: "working", updatedAt: 999 },
      ],
    });
    expect(w.paused).toBe(true);
    expect(w.tasks.map((t) => t.id)).toEqual([TASK2, TASK]);
    expect(w.tasks[0]!.queuedNotes).toBe(2);
    expect(w.ended).toHaveLength(ENDED_MAX);
    expect(w.ended[0]!.name).toBe(`e${ENDED_MAX + 4}`);
    expect(mapLocalWork({ paused: false, since: 0, tasks: [] })).toEqual({ paused: false, since: 0, tasks: [], ended: [] });
  });

  test("the heading names the hubs from open tasks, then finished ones; off and not-a-helper say so", () => {
    const w = (tasks: Record<string, unknown>[], ended: Record<string, unknown>[] = []): LocalWorkView => mapLocalWork({ paused: false, since: 0, tasks, ended });
    expect(helpingTitle(pc("on"), w([]))).toBe("This computer is ready to help");
    expect(helpingTitle(pc("on"), w([row()]))).toBe("This computer is helping FASTPC workstation");
    expect(helpingTitle(pc("on"), w([row()], [{ id: TASK2, name: "n", hub: "laptop hub", state: "stopped", updatedAt: 1 }]))).toBe("This computer is helping FASTPC workstation and laptop hub");
    expect(helpingTitle(pc("on"), w([row(), row({ id: TASK2, hub: "b" }), row({ id: "t_3333333333333333", hub: "c" }), row({ id: "t_4444444444444444", hub: "d" })]))).toBe("This computer is helping FASTPC workstation, b and 2 more");
    expect(helpingTitle(pc("off"), w([row()]))).toBe("Helping is off on this computer");
    expect(helpingTitle(pc("waiting-for-certificate"), w([]))).toBe("This computer is not helping a hub");
  });

  test("a task in words for the person here: stopping first, then its state; asks belong to the person at the hub", () => {
    const one = (over: Record<string, unknown>) => mapLocalWork({ paused: false, since: 0, tasks: [row(over)] }).tasks[0]!;
    expect(localTaskWords(one({ stopping: true }))).toBe("Stopping");
    expect(localTaskWords(one({}))).toBe("Working");
    expect(localTaskWords(one({ queuedNotes: 1 }))).toBe("Working, 1 note waiting");
    expect(localTaskWords(one({ state: "awaiting_approval" }))).toBe("Waiting for an OK from the person at the hub");
    expect(localTaskWords(one({ state: "idle" }))).toBe("Waiting for the hub");
    expect(localTaskWords(one({ state: "error" }))).toBe("Stopped with an error");
  });
});
