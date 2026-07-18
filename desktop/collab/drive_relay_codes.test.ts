// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/drive_relay_codes.test.ts — P-REMOTE.10 (ADR-0233): the secure reconnect-codes core —
// link selection, append/cap, expiry, and (the load-bearing part) optional PIN encryption at rest with
// fail-closed decryption. Uses REAL WebCrypto (Bun's crypto.subtle).

import { describe, expect, it } from "bun:test";
import {
  chooseReconnectLink, buildCode, appendCode, latestValidCode, parseCodes,
  buildFileContent, readFileContent, fileIsEncrypted, resolveReconnect, type RelayCode,
} from "./drive_relay_codes.ts";

describe("chooseReconnectLink (P-REMOTE.10)", () => {
  it("view link by default", () => {
    expect(chooseReconnectLink({ allowEdit: false, fullLink: "F", viewLink: "V" })).toEqual({ link: "V", edit: false });
  });
  it("edit link when the share is an edit share", () => {
    expect(chooseReconnectLink({ allowEdit: true, fullLink: "F", viewLink: "V" })).toEqual({ link: "F", edit: true });
  });
  it("edit link when the LAST session link was edit", () => {
    expect(chooseReconnectLink({ allowEdit: false, lastWasEdit: true, fullLink: "F", viewLink: "V" })).toEqual({ link: "F", edit: true });
  });
  it("falls back to whatever link exists; null when none", () => {
    expect(chooseReconnectLink({ allowEdit: true, viewLink: "V" })).toEqual({ link: "V", edit: false }); // wanted edit, only view exists
    expect(chooseReconnectLink({})).toBeNull();
  });
});

describe("append / expiry (P-REMOTE.10)", () => {
  it("appends and caps to the newest N", () => {
    let codes: RelayCode[] = [];
    for (let i = 0; i < 25; i++) codes = appendCode(codes, buildCode(`L${i}`, false, "r", i + 1), 20);
    expect(codes.length).toBe(20);
    expect(codes[0]!.link).toBe("L5"); // oldest 5 dropped
    expect(codes[codes.length - 1]!.link).toBe("L24");
  });
  it("latestValidCode skips expired + picks the freshest", () => {
    const now = 1_000_000;
    const codes: RelayCode[] = [
      { ts: now - 5000, roomId: "a", expiryMs: now - 1, link: "expired", edit: false },
      { ts: now - 3000, roomId: "b", expiryMs: now + 10_000, link: "older-valid", edit: false },
      { ts: now - 1000, roomId: "c", expiryMs: now + 10_000, link: "freshest", edit: true },
    ];
    expect(latestValidCode(codes, now)!.link).toBe("freshest");
    expect(latestValidCode([codes[0]!], now)).toBeNull(); // all expired
  });
});

describe("parseCodes validation (P-REMOTE.10)", () => {
  it("keeps only well-formed entries, drops junk", () => {
    const parsed = parseCodes([
      { ts: 1, roomId: "r", expiryMs: 2, link: "L", edit: false },
      { ts: "nope", roomId: "r", expiryMs: 2, link: "L", edit: false }, // bad ts
      null, 5, { link: "L" },
    ]);
    expect(parsed.length).toBe(1);
    expect(parsed[0]!.link).toBe("L");
  });
  it("non-array -> empty", () => { expect(parseCodes("x")).toEqual([]); });
});

describe("file content: plaintext + PIN encryption (P-REMOTE.10)", () => {
  const codes: RelayCode[] = [buildCode("wss://relay/r/room.secret.tok", true, "room", 1_700_000_000_000)];

  it("plaintext round-trips and is NOT encrypted", async () => {
    const text = await buildFileContent(codes, null);
    expect(fileIsEncrypted(text)).toBe(false);
    expect(text).toContain("room.secret"); // link visible (no PIN chosen)
    expect(await readFileContent(text, null)).toEqual(codes);
  });

  it("PIN-encrypted: link is NOT in the file, round-trips with the right PIN", async () => {
    const text = await buildFileContent(codes, "4291");
    expect(fileIsEncrypted(text)).toBe(true);
    expect(text).not.toContain("room.secret"); // the link is ciphertext at rest
    expect(await readFileContent(text, "4291")).toEqual(codes);
  });

  it("fail-closed: wrong PIN, missing PIN, and tamper all return null", async () => {
    const text = await buildFileContent(codes, "4291");
    expect(await readFileContent(text, "0000")).toBeNull(); // wrong PIN
    expect(await readFileContent(text, null)).toBeNull();   // encrypted but no PIN
    // tamper: flip a character in the ciphertext `data` -> GCM auth fails -> null
    const obj = JSON.parse(text) as { v: number; enc: string; data: string };
    const flipped = obj.data.slice(0, 40) + (obj.data[40] === "A" ? "B" : "A") + obj.data.slice(41);
    const tampered = JSON.stringify({ ...obj, data: flipped });
    expect(await readFileContent(tampered, "4291")).toBeNull();
  });

  it("two encryptions of the same data differ (fresh salt+iv), yet both decrypt", async () => {
    const a = await buildFileContent(codes, "pin");
    const b = await buildFileContent(codes, "pin");
    expect(a).not.toBe(b); // random salt + iv
    expect(await readFileContent(a, "pin")).toEqual(codes);
    expect(await readFileContent(b, "pin")).toEqual(codes);
  });

  it("garbage / empty file -> null, never throws", async () => {
    expect(await readFileContent("not json", "x")).toBeNull();
    expect(await readFileContent("{}", null)).toBeNull();
  });
});

describe("resolveReconnect reader state machine (P-REMOTE.10c)", () => {
  const now = 1_000_000;
  const fresh = buildCode("wss://relay/r/room.KEY.TOKEN", true, "room", now);          // expiry = now + 12h
  const stale: RelayCode = { ts: now - 20_000, roomId: "old", expiryMs: now - 1, link: "wss://relay/r/old.K", edit: false };

  it("ok: returns the freshest non-expired link (plaintext file)", async () => {
    const body = await buildFileContent([stale, fresh], null);
    expect(await resolveReconnect(body, null, now)).toEqual({ status: "ok", link: fresh.link, edit: true });
  });

  it("ok: decrypts an encrypted file with the right PIN", async () => {
    const body = await buildFileContent([fresh], "8317");
    expect(await resolveReconnect(body, "8317", now)).toEqual({ status: "ok", link: fresh.link, edit: true });
  });

  it("locked: an encrypted file with NO pin never leaks a link", async () => {
    const body = await buildFileContent([fresh], "8317");
    expect(await resolveReconnect(body, null, now)).toEqual({ status: "locked" });
  });

  it("bad-pin: an encrypted file with the WRONG pin fails closed (no link)", async () => {
    const body = await buildFileContent([fresh], "8317");
    expect(await resolveReconnect(body, "0000", now)).toEqual({ status: "bad-pin" });
  });

  it("expired: decrypts but every code is stale", async () => {
    const body = await buildFileContent([stale], null);
    expect(await resolveReconnect(body, null, now)).toEqual({ status: "expired" });
  });

  it("empty: no codes, or an unreadable body", async () => {
    expect(await resolveReconnect(await buildFileContent([], null), null, now)).toEqual({ status: "empty" });
    expect(await resolveReconnect("not json", null, now)).toEqual({ status: "empty" });
  });
});
