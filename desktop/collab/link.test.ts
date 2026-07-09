// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/link.test.ts — P-COLLAB.1 (ADR-0192): the invite link.

import { test, expect } from "bun:test";
import { generateRoomId, formatShareLink, formatBrowserLink, formatRelayLink, parseShareLink } from "./link.ts";
import { generateRoomKey, generateWriteToken } from "./crypto.ts";

// P-COLLAB.10: the invite carries the relay endpoint the guest connects to.
test("formatRelayLink carries the relay endpoint; parse returns it (view + full)", () => {
  const roomId = generateRoomId();
  const key = generateRoomKey();
  const token = generateWriteToken();
  const view = formatRelayLink("wss://relay.corp.internal:8790", roomId, key);
  const full = formatRelayLink("wss://relay.corp.internal:8790", roomId, key, token);
  expect(view).toBe(`wss://relay.corp.internal:8790/r/${formatShareLink(roomId, key)}`);

  const pv = parseShareLink(view);
  expect(pv.relay).toBe("wss://relay.corp.internal:8790");
  expect(pv.roomId).toBe(roomId);
  expect(pv.writeToken).toBeNull(); // view = read-only
  expect([...pv.key]).toEqual([...key]);

  const pf = parseShareLink(full);
  expect(pf.relay).toBe("wss://relay.corp.internal:8790");
  expect(pf.writeToken).not.toBeNull();
});

test("the browser form's relay base is normalized to ws(s):// on parse", () => {
  const roomId = generateRoomId();
  const key = generateRoomKey();
  const browser = formatBrowserLink("https://relay.example.com", formatShareLink(roomId, key));
  expect(parseShareLink(browser).relay).toBe("wss://relay.example.com"); // https -> wss
  expect(parseShareLink(formatBrowserLink("http://127.0.0.1:8790", formatShareLink(roomId, key))).relay).toBe("ws://127.0.0.1:8790");
});

test("a BARE link has no relay endpoint (guest falls back to its configured relay)", () => {
  const roomId = generateRoomId();
  const key = generateRoomKey();
  expect(parseShareLink(formatShareLink(roomId, key)).relay).toBeNull();
});

test("a FULL link round-trips to the same key + write token (edit access)", () => {
  const roomId = generateRoomId();
  const key = generateRoomKey();
  const token = generateWriteToken();
  const link = formatShareLink(roomId, key, token);
  const p = parseShareLink(link);
  expect(p.roomId).toBe(roomId);
  expect([...p.key]).toEqual([...key]);
  expect(p.writeToken).not.toBeNull();
  expect([...(p.writeToken as Uint8Array)]).toEqual([...token]);
});

test("a VIEW link (key only) parses to read-only (writeToken null)", () => {
  const roomId = generateRoomId();
  const key = generateRoomKey();
  const link = formatShareLink(roomId, key); // no token
  const p = parseShareLink(link);
  expect(p.roomId).toBe(roomId);
  expect([...p.key]).toEqual([...key]);
  expect(p.writeToken).toBeNull();
});

test("parses the relay-path form host/r/<roomId>.<secret>", () => {
  const roomId = generateRoomId();
  const key = generateRoomKey();
  const bare = formatShareLink(roomId, key);
  const p = parseShareLink(`relay.example.com/r/${bare}`);
  expect(p.roomId).toBe(roomId);
  expect([...p.key]).toEqual([...key]);
});

test("parses the browser fragment form https://relay/#<roomId>.<secret>", () => {
  const roomId = generateRoomId();
  const key = generateRoomKey();
  const token = generateWriteToken();
  const bare = formatShareLink(roomId, key, token);
  const browser = formatBrowserLink("https://relay.example.com", bare);
  expect(browser).toBe(`https://relay.example.com/#${bare}`);
  const p = parseShareLink(browser);
  expect(p.roomId).toBe(roomId);
  expect(p.writeToken).not.toBeNull();
});

test("the dot-join is used (never a raw # between roomId and secret)", () => {
  const link = formatShareLink(generateRoomId(), generateRoomKey());
  expect(link).toContain(".");
  expect(link.split(".").length).toBe(2);
});

test("malformed links are rejected fail-closed", () => {
  expect(() => parseShareLink("")).toThrow();
  expect(() => parseShareLink("noseparator")).toThrow("roomId.secret");
  expect(() => parseShareLink("room.")).toThrow();
  // a secret that is neither 32 (view) nor 48 (full) bytes
  const badSecret = formatShareLink("room", new Uint8Array(32)).slice(0, -4); // truncate the base64
  expect(() => parseShareLink(badSecret)).toThrow();
});
