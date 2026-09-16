// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { LiveTurn, type TurnRecoveryEvent, type TurnSnapshot } from "./turn_recovery.ts";

type Event =
  | { type: "token"; text: string }
  | { type: "permission"; id: string; detail: string };
type ObservedEvent = Event | TurnRecoveryEvent;

describe("LiveTurn execution-owned recovery", () => {
  test("pre-ack request identity cannot attach to the previous or next execution", () => {
    const previous = new LiveTurn<Event>("same prompt", "same session", () => [], "previous-request");
    const current = new LiveTurn<Event>("same prompt", "same session", () => [], "current-request");
    const next = new LiveTurn<Event>("same prompt", "same session", () => [], "next-request");
    expect(previous.matches(undefined, "current-request")).toBe(false);
    expect(current.matches(undefined, "current-request")).toBe(true);
    expect(next.matches(undefined, "current-request")).toBe(false);
    const uncorrelated = new LiveTurn<Event>("same prompt", "same session", () => []);
    expect(uncorrelated.matches(undefined, "current-request")).toBe(false);
    previous.finish();
    current.finish();
    next.finish();
    uncorrelated.finish();
  });

  test("canonical turn identity takes precedence over request correlation", () => {
    const turn = new LiveTurn<Event>("prompt", "session", () => [], "request");
    const other = new LiveTurn<Event>("prompt", "session", () => [], "other-request");
    expect(turn.matches(turn.turnId, "other-request")).toBe(true);
    expect(turn.matches(other.turnId, "request")).toBe(false);
    expect(turn.matches("", "request")).toBe(false);
    turn.finish();
    other.finish();
  });

  test("completed turns retain their identity while new executions reject the old expected id", () => {
    const completed = new LiveTurn<Event>("prompt", "session", () => [], "request");
    const expectedId = completed.turnId;
    completed.finish();
    expect(completed.matches(expectedId)).toBe(true);
    expect(completed.matches(undefined, "request")).toBe(true);
    const replacement = new LiveTurn<Event>("prompt", "session", () => [], "request");
    expect(replacement.matches(expectedId, "request")).toBe(false);
    expect(completed.matches(replacement.turnId, "request")).toBe(false);
    expect(replacement.matches(replacement.turnId)).toBe(true);
    replacement.finish();
    expect(replacement.matches(expectedId, "request")).toBe(false);
  });

  test("reattachment replaces partial delivery with the current full-text snapshot", () => {
    const turn = new LiveTurn<Event>("original prompt", "session", () => []);
    const firstEvents: ObservedEvent[] = [];
    const first = turn.attach(event => firstEvents.push(event));
    turn.text = "first part";
    turn.emit({ type: "token", text: "first part" });
    first.detach();
    turn.text = "first part and the part missed while disconnected";
    turn.emit({ type: "token", text: " and the part missed while disconnected" });
    const recovered: ObservedEvent[] = [];
    const second = turn.attach(event => recovered.push(event));
    expect(recovered).toEqual([{ type: "turn-snapshot", snapshot: turn.snapshot() }]);
    expect(recovered[0]).toMatchObject({
      type: "turn-snapshot",
      snapshot: { prompt: "original prompt", text: "first part and the part missed while disconnected" },
    });
    expect(firstEvents).toHaveLength(2);
    expect(firstEvents[0]).toMatchObject({ type: "turn-snapshot", snapshot: { text: "" } });
    turn.text = "authoritative replacement rather than appended deltas";
    expect(turn.snapshot().text).toBe("authoritative replacement rather than appended deltas");
    turn.finish();
    expect(recovered[1]).toEqual({ type: "done", text: turn.text });
    second.detach();
  });

  test("the Snowflake turn identity remains stable across snapshots and differs for new executions", () => {
    const first = new LiveTurn<Event>("same prompt", "same session", () => []);
    const second = new LiveTurn<Event>("same prompt", "same session", () => []);
    const identity = first.turnId;
    const startedAt = first.startedAt;
    expect(typeof identity).toBe("string");
    expect(identity.length).toBeGreaterThan(0);
    expect(second.turnId).not.toBe(identity);
    first.text = "progress";
    first.sessionId = "resolved session";
    expect(first.status()).toEqual({ turnId: identity, sessionId: "resolved session", startedAt, running: true });
    expect(first.snapshot()).toMatchObject({ turnId: identity, startedAt, text: "progress" });
    first.finish();
    expect(first.status()).toEqual({ turnId: identity, sessionId: "resolved session", startedAt, running: false });
    second.finish();
  });

  test("reattachment replays only unresolved permissions and keeps the latest update per id", () => {
    const turn = new LiveTurn<Event>("prompt", null, () => []);
    turn.emit({ type: "permission", id: "resolved", detail: "already answered" });
    turn.emit({ type: "permission", id: "pending", detail: "old details" });
    turn.resolvePermission("resolved");
    turn.resolvePermission("unknown");
    turn.emit({ type: "permission", id: "pending", detail: "current details" });
    turn.emit({ type: "token", text: "not replayed as history" });
    const recovered: ObservedEvent[] = [];
    const first = turn.attach(event => recovered.push(event));
    expect(recovered.map(event => event.type)).toEqual(["turn-snapshot", "permission"]);
    expect(recovered[1]).toEqual({ type: "permission", id: "pending", detail: "current details" });
    first.detach();
    turn.resolvePermission("pending");
    const afterResolution: ObservedEvent[] = [];
    const second = turn.attach(event => afterResolution.push(event));
    expect(afterResolution.map(event => event.type)).toEqual(["turn-snapshot"]);
    second.detach();
    turn.emit({ type: "permission", id: "unfinished", detail: "must not survive completion" });
    turn.finish();
    const afterFinish: ObservedEvent[] = [];
    turn.attach(event => afterFinish.push(event));
    expect(afterFinish.map(event => event.type)).toEqual(["turn-snapshot", "done"]);
  });

  test("pending tool snapshots consult the live provider only until finish", () => {
    let pending: TurnSnapshot["pending"] = [{ label: "read files", elapsedMs: 1 }];
    let reads = 0;
    const turn = new LiveTurn<Event>("prompt", null, () => { reads++; return pending; });
    expect(turn.snapshot().pending).toEqual([{ label: "read files", elapsedMs: 1 }]);
    pending = [{ label: "write files", elapsedMs: 42 }];
    expect(turn.snapshot().pending).toEqual([{ label: "write files", elapsedMs: 42 }]);
    expect(reads).toBe(2);
    turn.finish();
    pending = [{ label: "unrelated next execution", elapsedMs: 99 }];
    expect(turn.snapshot().pending).toEqual([]);
    const events: ObservedEvent[] = [];
    turn.attach(event => events.push(event));
    expect(events[0]).toMatchObject({ type: "turn-snapshot", snapshot: { pending: [], running: false } });
    expect(reads).toBe(2);
  });

  test("late attachment receives a terminal snapshot and full answer with no surviving subscription", async () => {
    const turn = new LiveTurn<Event>("prompt", "session", () => []);
    turn.text = "the full completed answer";
    turn.finish();
    const request = new AbortController();
    const events: ObservedEvent[] = [];
    const attachment = turn.attach(event => events.push(event), request.signal);
    expect(attachment.attached).toBe(true);
    expect(attachment.running).toBe(false);
    expect(events).toEqual([
      { type: "turn-snapshot", snapshot: turn.snapshot() },
      { type: "done", text: "the full completed answer" },
    ]);
    await attachment.ended;
    expect(turn.subscriberCount).toBe(0);
    expect(getEventListeners(request.signal, "abort")).toHaveLength(0);
    request.abort();
    attachment.detach();
    turn.emit({ type: "token", text: "must not arrive after completion" });
    expect(events).toHaveLength(2);
  });

  test.each(["turn-snapshot", "token", "done"])("an observer throwing during %s is removed without disrupting another viewer", async failingType => {
    const turn = new LiveTurn<Event>("prompt", "session", () => []);
    const failedRequest = new AbortController();
    let failedDeliveries = 0;
    turn.attach(event => {
      failedDeliveries++;
      if (event.type === failingType) throw new Error("consumer is no longer writable");
    }, failedRequest.signal);
    const healthyEvents: ObservedEvent[] = [];
    turn.attach(event => healthyEvents.push(event));
    turn.emit({ type: "token", text: "first" });
    if (failingType !== "done") {
      expect(turn.subscriberCount).toBe(1);
      expect(getEventListeners(failedRequest.signal, "abort")).toHaveLength(0);
      const deliveriesAtFailure = failedDeliveries;
      turn.emit({ type: "token", text: "second" });
      expect(failedDeliveries).toBe(deliveriesAtFailure);
    }
    turn.text = "complete despite failed observer";
    turn.finish();
    await turn.ended;
    expect(healthyEvents.at(-1)).toEqual({ type: "done", text: turn.text });
    expect(turn.subscriberCount).toBe(0);
    expect(getEventListeners(failedRequest.signal, "abort")).toHaveLength(0);
  });

  test("finish settles every attachment once and removes every request abort listener", async () => {
    const turn = new LiveTurn<Event>("prompt", "session", () => []);
    const requests = [new AbortController(), new AbortController(), new AbortController()];
    const deliveries: ObservedEvent[][] = requests.map(() => []);
    const attachments = requests.map((request, index) => turn.attach(event => deliveries[index]!.push(event), request.signal));
    expect(turn.subscriberCount).toBe(3);
    turn.text = "final answer";
    turn.finish();
    await Promise.all(attachments.map(attachment => attachment.ended));
    expect(turn.running).toBe(false);
    expect(turn.subscriberCount).toBe(0);
    for (const request of requests) {
      expect(getEventListeners(request.signal, "abort")).toHaveLength(0);
      request.abort();
    }
    turn.finish();
    turn.emit({ type: "token", text: "ignored after finish" });
    for (const events of deliveries) {
      expect(events.map(event => event.type)).toEqual(["turn-snapshot", "done"]);
      expect(events[1]).toEqual({ type: "done", text: "final answer" });
    }
    for (const attachment of attachments) attachment.detach();
  });
});
