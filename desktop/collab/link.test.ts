// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/link.test.ts — P-COLLAB.1 (ADR-0192): the invite link.

import { test, expect } from "bun:test";
import { generateRoomId, formatShareLink, formatBrowserLink, formatRelayLink, formatPwaLink, mintRoomLinks, parseShareLink } from "./link.ts";
import { generateRoomKey, generateWriteToken } from "./crypto.ts";

// P-COLLAB.19 (ADR-0241): one room, two capabilities - hand an EDIT link and a VIEW-ONLY link to different guests.
test("mintRoomLinks: an edit share mints BOTH capabilities from one room (full drives, view watches)", () => {
  const roomId = generateRoomId();
  const key = generateRoomKey();
  const token = generateWriteToken();
  const relay = { wsBase: "wss://relay.run.app", httpBase: "https://relay.run.app", pwaBase: "https://lucid-agent.web.app/remote" };
  const links = mintRoomLinks(relay, roomId, key, token, true);
  // all four link forms open the SAME room with the SAME key
  for (const l of [links.fullLink, links.viewLink, links.browserLink, links.browserViewLink]) {
    expect(parseShareLink(l).roomId).toBe(roomId);
  }
  // capability split: full/browser carry the write token; view forms never do
  expect(parseShareLink(links.fullLink).writeToken).not.toBeNull();
  expect(parseShareLink(links.browserLink).writeToken).not.toBeNull();
  expect(parseShareLink(links.viewLink).writeToken).toBeNull();
  expect(parseShareLink(links.browserViewLink).writeToken).toBeNull();
});

test("mintRoomLinks: a view-only share never mints an edit-capable browser link", () => {
  const relay = { wsBase: "wss://r", httpBase: "https://r", pwaBase: "https://p/remote" };
  const links = mintRoomLinks(relay, generateRoomId(), generateRoomKey(), generateWriteToken(), false);
  expect(links.browserLink).toBe(links.browserViewLink);
  expect(parseShareLink(links.browserLink).writeToken).toBeNull();
});

test("mintRoomLinks: the legacy (no pwaBase) browser form is always token-free (unchanged behavior)", () => {
  const relay = { wsBase: "wss://relay.local", httpBase: "https://relay.local" };
  const links = mintRoomLinks(relay, generateRoomId(), generateRoomKey(), generateWriteToken(), true);
  expect(links.browserLink).toBe(links.browserViewLink);
  expect(links.browserLink).toContain("https://relay.local/#");
  expect(parseShareLink(links.browserLink).writeToken).toBeNull();
});

// P-REMOTE.2b: the phone PWA link wraps the bare secret in the fragment; the PWA reads it + uses its OWN relay.
test("formatPwaLink points at the PWA page with the secret in the fragment (view + full parse round-trips)", () => {
  const roomId = generateRoomId();
  const key = generateRoomKey();
  const token = generateWriteToken();
  const view = formatPwaLink("https://lucid-agent.web.app/remote/", roomId, key); // trailing slash trimmed
  expect(view).toBe(`https://lucid-agent.web.app/remote/#${formatShareLink(roomId, key)}`);
  // the phone parses only the fragment (bare form) -> roomId + key, no relay baked in (it uses its config)
  const pv = parseShareLink(view.slice(view.indexOf("#") + 1));
  expect(pv.roomId).toBe(roomId);
  expect(pv.writeToken).toBeNull();
  const full = formatPwaLink("https://lucid-agent.web.app/remote", roomId, key, token);
  expect(full).toBe(`https://lucid-agent.web.app/remote/#${formatShareLink(roomId, key, token)}`);
  expect(parseShareLink(full.slice(full.indexOf("#") + 1)).writeToken).not.toBeNull();
});

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
