// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/crypto.test.ts — P-COLLAB.1 (ADR-0192): the E2E seal + envelope.

import { test, expect } from "bun:test";
import { generateRoomKey, generateWriteToken, importRoomKey, seal, open, packEnvelope, unpackEnvelope } from "./crypto.ts";
import type { LucidCollabFrame } from "./frames.ts";

const frame: LucidCollabFrame = { t: "event", event: { type: "token", text: "hello from the host" } };

test("keys/tokens are the wire-spec sizes", () => {
  expect(generateRoomKey().byteLength).toBe(32);
  expect(generateWriteToken().byteLength).toBe(16);
});

test("seal -> open round-trips a frame under the same room key", async () => {
  const raw = generateRoomKey();
  const key = await importRoomKey(raw);
  const sealed = await seal(key, frame);
  expect(sealed.byteLength).toBeGreaterThan(12); // at least the IV
  const back = await open(key, sealed);
  expect(back).toEqual(frame);
});

test("a different room key cannot open the frame (E2E: the relay can't read it)", async () => {
  const a = await importRoomKey(generateRoomKey());
  const b = await importRoomKey(generateRoomKey());
  const sealed = await seal(a, frame);
  await expect(open(b, sealed)).rejects.toThrow();
});

test("a tampered ciphertext fails the auth tag (fail-closed)", async () => {
  const key = await importRoomKey(generateRoomKey());
  const sealed = await seal(key, frame);
  sealed[sealed.byteLength - 1] ^= 0xff; // flip a byte in the tag/ciphertext
  await expect(open(key, sealed)).rejects.toThrow();
});

test("a too-short buffer is rejected, never half-decoded", async () => {
  const key = await importRoomKey(generateRoomKey());
  await expect(open(key, new Uint8Array(8))).rejects.toThrow("too short");
});

test("importRoomKey rejects a wrong-size key", async () => {
  await expect(importRoomKey(new Uint8Array(31))).rejects.toThrow("32 bytes");
});

test("envelope preserves the peer id + the sealed payload", () => {
  const sealed = new Uint8Array([1, 2, 3, 4, 5]);
  const env = packEnvelope(0xdeadbeef, sealed);
  expect(env.byteLength).toBe(4 + 5);
  const { peerId, sealed: back } = unpackEnvelope(env);
  expect(peerId).toBe(0xdeadbeef);
  expect([...back]).toEqual([1, 2, 3, 4, 5]);
});

test("a full seal -> envelope -> unpack -> open path round-trips", async () => {
  const raw = generateRoomKey();
  const key = await importRoomKey(raw);
  const wire = packEnvelope(7, await seal(key, frame));
  const { peerId, sealed } = unpackEnvelope(wire);
  expect(peerId).toBe(7);
  expect(await open(key, sealed)).toEqual(frame);
});
