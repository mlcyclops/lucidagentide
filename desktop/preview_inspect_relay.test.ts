// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/preview_inspect_relay.test.ts — P-PREVIEW.6b (ADR-0153): the inspect relay queue/waiter core.

import { test, expect, describe } from "bun:test";
import { InspectRelay } from "./preview_inspect_relay.ts";

describe("InspectRelay", () => {
  test("enqueue → next → resolve round-trips the result to the tool's promise", async () => {
    const r = new InspectRelay();
    const { id, promise } = r.enqueue({ selector: "#app", what: "summary" });
    const taken = r.next();
    expect(taken).toEqual({ id, command: { selector: "#app", what: "summary" } });
    expect(r.stats()).toEqual({ queued: 0, waiting: 1 });
    expect(r.resolve(id, { count: 1 })).toBe(true);
    expect(await promise).toEqual({ count: 1 });
    expect(r.stats()).toEqual({ queued: 0, waiting: 0 });
  });
  test("FIFO across multiple commands; unique ids", () => {
    const r = new InspectRelay();
    const a = r.enqueue({ what: "errors" });
    const b = r.enqueue({ selector: "button" });
    expect(a.id).not.toBe(b.id);
    expect(r.next()!.id).toBe(a.id);
    expect(r.next()!.id).toBe(b.id);
    expect(r.next()).toBeNull();
  });
  test("commands are sanitized (string-only, length-capped)", () => {
    const r = new InspectRelay();
    r.enqueue({ selector: "x".repeat(1000), what: 123 as unknown as string });
    const c = r.next()!.command;
    expect(c.selector!.length).toBe(400);
    expect(c.what).toBeUndefined(); // non-string dropped
  });
  test("carries structured action commands (P-PREVIEW.6c): action + value, length-capped", () => {
    const r = new InspectRelay();
    r.enqueue({ action: "type", selector: "#name", value: "y".repeat(5000) });
    const c = r.next()!.command;
    expect(c.action).toBe("type");
    expect(c.selector).toBe("#name");
    expect(c.value!.length).toBe(2000); // capped
    r.enqueue({ action: 42 as unknown as string, selector: "#b" });
    expect(r.next()!.command.action).toBeUndefined(); // non-string action dropped
  });
  test("abandon (timeout) drops a still-queued command and resolves its waiter", async () => {
    const r = new InspectRelay();
    const { id, promise } = r.enqueue({ what: "summary" });
    r.abandon(id, { error: "timed out" });
    expect(await promise).toEqual({ error: "timed out" });
    expect(r.next()).toBeNull(); // removed from the queue
    expect(r.stats()).toEqual({ queued: 0, waiting: 0 });
  });
  test("resolve of an unknown/late id is a no-op (false)", () => {
    const r = new InspectRelay();
    expect(r.resolve("nope", {})).toBe(false);
  });
});
