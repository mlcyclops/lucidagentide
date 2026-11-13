// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-HERD.5 (ADR-0494, in the Herd add-on since ADR-0541): attention. A finished turn reads unseen
// until it has been on screen in the focused pane with someone attached, and idle after; an open ask
// is needs-you (awaiting-input, the engine's ready state, is not); prefix+a goes to the oldest ask,
// then the oldest unseen lane, then says there is none; the bell rings once per ask only when the
// user turned it on; a notification carries the lane name and status and never the ask's text;
// terminal escapes carry no control characters; scripts are held to one notification per 10 s.

import { beforeEach, describe, expect, test } from "bun:test";
import { buildAgentRows } from "../../../harness/launcher/hub_agents_panel.ts";
import { HubOpError } from "../../../harness/launcher/hub_spaces.ts";
import {
  cleanNotifyText, desktopEscape, HerdAttention, laneAttention, MAIN_TARGET, nextTarget, NotifyLimiter, notificationText, settleKey,
  terminalNotifyKind, type HerdAlert, type NotifySettings,
} from "../src/attention.ts";

describe("laneAttention", () => {
  test("an open ask needs you; awaiting-input, the ready state, does not", () => {
    expect(laneAttention({ status: "needs-approval" }, undefined)).toBe("needs-you");
    expect(laneAttention({ status: "working", pendingApproval: { summary: "write a file", kind: "edit" } }, undefined)).toBe("needs-you");
    expect(laneAttention({ status: "awaiting-input", turns: 0 }, undefined)).toBe("none");
    expect(laneAttention({ status: "working" }, undefined)).toBe("none");
  });
  test("a settled lane is unseen until its exact settled state was seen", () => {
    const lane = { status: "done", turns: 3 };
    expect(laneAttention(lane, undefined)).toBe("unseen");
    expect(laneAttention(lane, settleKey(lane) ?? "")).toBe("none");
    expect(laneAttention({ status: "done", turns: 4 }, settleKey(lane) ?? "")).toBe("unseen");
  });
  test("error and stopped need you only when a retry is offered", () => {
    expect(laneAttention({ status: "error", canRetry: true }, undefined)).toBe("needs-you");
    expect(laneAttention({ status: "error", canRetry: false }, undefined)).toBe("unseen");
    expect(laneAttention({ status: "stopped" }, undefined)).toBe("unseen");
  });
});

describe("nextTarget", () => {
  const c = (id: string, attention: "needs-you" | "unseen" | "none", since: number) => ({ id, name: id, attention, since });
  test("oldest ask first, then oldest unseen, never the focused one", () => {
    const cands = [c("late-ask", "needs-you", 9), c("old-unseen", "unseen", 1), c("old-ask", "needs-you", 2), c("quiet", "none", 0)];
    expect(nextTarget(cands, null)?.id).toBe("old-ask");
    expect(nextTarget(cands, "old-ask")?.id).toBe("late-ask");
    expect(nextTarget([c("old-unseen", "unseen", 1)], null)?.id).toBe("old-unseen");
    expect(nextTarget([c("only", "needs-you", 1), c("quiet", "none", 0)], "only")).toBeNull();
  });
});

describe("HerdAttention", () => {
  let focused: string | null;
  let clients: number;
  let now: number;
  let settings: NotifySettings;
  let alerts: HerdAlert[];
  let mainAsk: { kind: string; summary: string } | null;
  let att: HerdAttention;

  beforeEach(() => {
    focused = null;
    clients = 1;
    now = 0;
    settings = { bell: false, desktop: false, sound: false };
    alerts = [];
    mainAsk = null;
    att = new HerdAttention({
      focused: () => focused,
      clients: () => clients,
      show: (id) => { focused = id; return Promise.resolve(); },
      alert: (a) => alerts.push(a),
      settings: () => settings,
      now: () => now,
      main: { ask: () => mainAsk, show: () => { focused = MAIN_TARGET; return Promise.resolve(); } },
    });
  });

  test("two lanes finish: the one on screen reads idle, the other done; focusing it flips it", () => {
    focused = "a";
    att.update([{ id: "a", name: "a", status: "working", turns: 0 }, { id: "b", name: "b", status: "working", turns: 0 }]);
    att.update([{ id: "a", name: "a", status: "done", turns: 1 }, { id: "b", name: "b", status: "done", turns: 1 }]);
    expect([att.attention("a"), att.attention("b")]).toEqual(["none", "unseen"]);
    focused = "b";
    att.touch();
    expect(att.attention("b")).toBe("none");
    expect(att.annotate({ id: "b", status: "done" })).toEqual({ id: "b", status: "done", attention: "none" });
  });

  test("with nobody attached, the focused pane is not seen", () => {
    clients = 0;
    focused = "a";
    att.update([{ id: "a", name: "a", status: "done", turns: 1 }]);
    expect(att.attention("a")).toBe("unseen");
  });

  test("prefix+a lands on the ask, then the unseen lane, then reports none", async () => {
    now = 1;
    att.update([{ id: "u", name: "reviewer", status: "done", turns: 1 }, { id: "x", name: "builder", status: "working", turns: 0 }]);
    now = 2;
    att.update([{ id: "u", name: "reviewer", status: "done", turns: 1 }, { id: "x", name: "builder", status: "needs-approval", turns: 0 }]);
    expect(await att.focusNext()).toBe("builder: needs you");
    expect(focused).toBe("x");
    expect(await att.focusNext()).toBe("reviewer: unseen");
    expect(att.attention("u")).toBe("none"); // on screen now
    att.update([{ id: "u", name: "reviewer", status: "done", turns: 1 }, { id: "x", name: "builder", status: "working", turns: 0 }]); // answered
    expect(await att.focusNext()).toBe("nothing else needs you and nothing is unseen");
  });

  test("Main's parked ask counts as needs-you and prefix+a shows Main", async () => {
    att.update([]);
    mainAsk = { kind: "exec", summary: "run tests" };
    att.touch();
    expect(await att.focusNext()).toBe("Main: needs you");
    expect(focused).toBe(MAIN_TARGET);
  });

  test("the bell rings once per ask with the bell on, never with it off, and not for old asks at start", () => {
    const ask = [{ id: "x", name: "builder", status: "needs-approval", turns: 0 }];
    const idle = [{ id: "x", name: "builder", status: "working", turns: 0 }];
    att.update(ask); // the first snapshot only learns
    expect(alerts).toEqual([]);
    att.update(idle);
    settings = { bell: true, desktop: false, sound: false };
    att.update(ask);
    att.update(ask);
    expect(alerts).toEqual([{ t: "alert", bell: true, desktop: null }]);
    settings = { bell: false, desktop: false, sound: false };
    att.update(idle);
    att.update(ask);
    expect(alerts).toHaveLength(1);
  });

  test("a desktop notification carries the lane name and status, never the ask text", () => {
    att.update([{ id: "x", name: "builder", status: "working" }]);
    settings = { bell: false, desktop: true, sound: false };
    att.update([{ id: "x", name: "builder", status: "needs-approval", pendingApproval: { summary: "cat ~/.ssh/id_rsa", kind: "exec" } }]);
    expect(alerts).toEqual([{ t: "alert", bell: false, desktop: { title: "builder", body: "needs-approval" } }]);
    expect(JSON.stringify(alerts)).not.toContain("ssh");
  });

  test("notify is one per lane per 10 s, and follows the user's settings", () => {
    settings = { bell: true, desktop: true, sound: false };
    expect(att.notify({ title: "built", body: "ok", lane: "x" })).toEqual({ bell: true, desktop: true, clients: 1 });
    expect(() => att.notify({ title: "again", body: "", lane: "x" })).toThrow(HubOpError);
    expect(att.notify({ title: "other", body: "", lane: "y" }).bell).toBe(true);
    now = 10_000;
    expect(att.notify({ title: "later", body: "", lane: "x" }).desktop).toBe(true);
    expect(alerts).toHaveLength(3);
  });
});

describe("notification bytes", () => {
  test("text loses control characters and the OSC 777 separator", () => {
    expect(cleanNotifyText("evil\x1b]0;pwn\x07 lane\x9b")).toBe("evil ]0,pwn lane");
    expect(notificationText("", "done")).toEqual({ title: "agent", body: "done" });
    expect(cleanNotifyText("x".repeat(100)).length).toBe(64);
  });
  test("OSC 9 and OSC 777 in the terminal's own form", () => {
    const n = { title: "builder", body: "needs-approval" };
    expect(desktopEscape("osc9", n)).toBe("\x1b]9;builder: needs-approval\x1b\\");
    expect(desktopEscape("osc777", n)).toBe("\x1b]777;notify;builder;needs-approval\x1b\\");
  });
  test("an escape only for a terminal that shows it; nothing inside tmux or on a bell-only terminal", () => {
    expect(terminalNotifyKind("\x1b]9;", {})).toBe("osc9");
    expect(terminalNotifyKind("\x07", { TERM: "foot" })).toBe("osc777");
    expect(terminalNotifyKind("\x07", { TERM: "xterm-256color" })).toBeNull();
    expect(terminalNotifyKind("\x1b]9;", { TMUX: "/tmp/tmux-1/default,1,0" })).toBeNull();
  });
  test("the limiter holds each key for 10 s", () => {
    const l = new NotifyLimiter();
    expect([l.allow("a", 0), l.allow("a", 9_999), l.allow("b", 9_999), l.allow("a", 10_000)]).toEqual([true, false, true, true]);
  });
});

describe("the rail order with attention (core seam, Herd only)", () => {
  const lanes = [
    { id: "a", name: "a", status: "done" },
    { id: "b", name: "b", status: "working" },
    { id: "c", name: "c", status: "awaiting-input" },
  ];
  test("without attention the classic order holds", () => {
    expect(buildAgentRows(lanes, {}, {}, 0).map((r) => r.id)).toEqual(["c", "b", "a"]);
  });
  test("needs-you first, unseen second, among equal priorities", () => {
    const att: Record<string, "needs-you" | "unseen" | "none"> = { a: "unseen", b: "needs-you", c: "none" };
    const rows = buildAgentRows(lanes, {}, { c: 9 }, 0, (id) => att[id] ?? "none");
    expect(rows.map((r) => [r.id, r.attention])).toEqual([["c", "none"], ["b", "needs-you"], ["a", "unseen"]]);
  });
});
