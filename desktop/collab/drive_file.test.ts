// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/drive_file.test.ts — P-REMOTE.10 (ADR-0233): the Drive REST client, over a MOCK fetch — the
// request shapes (drive.file endpoints, Bearer token, multipart create, media update, per-file permission),
// find-or-create, and fail-closed handling of a non-2xx response.

import { describe, expect, it } from "bun:test";
import { findRelayFile, createRelayFile, readRelayFile, updateRelayFile, shareRelayFile, ensureRelayFile, type FetchLike } from "./drive_file.ts";

interface Call { url: string; init?: RequestInit }
function mock(handler: (call: Call) => Response): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => { const c = { url, init }; calls.push(c); return handler(c); };
  return { fetch, calls };
}
const hdr = (init: RequestInit | undefined, k: string): string | undefined => {
  const h = init?.headers; return h && typeof h === "object" && !Array.isArray(h) ? (h as Record<string, string>)[k] : undefined;
};

describe("findRelayFile (P-REMOTE.10)", () => {
  it("queries by name with a Bearer token and returns the first id", async () => {
    const m = mock(() => new Response(JSON.stringify({ files: [{ id: "file123", name: "lucid_relay_codes" }] }), { status: 200 }));
    const id = await findRelayFile("tok", "lucid_relay_codes", m.fetch);
    expect(id).toBe("file123");
    expect(m.calls[0]!.url).toContain("/drive/v3/files?q=");
    expect(m.calls[0]!.url).toContain(encodeURIComponent("name='lucid_relay_codes'"));
    expect(hdr(m.calls[0]!.init, "authorization")).toBe("Bearer tok");
  });
  it("returns null when no file matches", async () => {
    const m = mock(() => new Response(JSON.stringify({ files: [] }), { status: 200 }));
    expect(await findRelayFile("tok", "lucid_relay_codes", m.fetch)).toBeNull();
  });
  it("throws fail-closed on a non-2xx", async () => {
    const m = mock(() => new Response("nope", { status: 403 }));
    expect(findRelayFile("tok", "x", m.fetch)).rejects.toThrow(/403/);
  });
});

describe("createRelayFile (P-REMOTE.10)", () => {
  it("POSTs a multipart upload and returns the new id", async () => {
    const m = mock(() => new Response(JSON.stringify({ id: "new1" }), { status: 200 }));
    const id = await createRelayFile("tok", "lucid_relay_codes", '{"v":1}', m.fetch);
    expect(id).toBe("new1");
    const c = m.calls[0]!;
    expect(c.url).toContain("/upload/drive/v3/files?uploadType=multipart");
    expect(c.init!.method).toBe("POST");
    expect(hdr(c.init, "content-type")).toContain("multipart/related; boundary=");
    expect(String(c.init!.body)).toContain('"name":"lucid_relay_codes"');
    expect(String(c.init!.body)).toContain('{"v":1}');
  });
});

describe("read / update / share (P-REMOTE.10)", () => {
  it("readRelayFile GETs alt=media and returns the body text", async () => {
    const m = mock(() => new Response("FILEBODY", { status: 200 }));
    expect(await readRelayFile("tok", "f1", m.fetch)).toBe("FILEBODY");
    expect(m.calls[0]!.url).toContain("/drive/v3/files/f1?alt=media");
  });
  it("updateRelayFile PATCHes uploadType=media with the content", async () => {
    const m = mock(() => new Response("{}", { status: 200 }));
    await updateRelayFile("tok", "f1", '{"v":1,"enc":"pin"}', m.fetch);
    const c = m.calls[0]!;
    expect(c.init!.method).toBe("PATCH");
    expect(c.url).toContain("/upload/drive/v3/files/f1?uploadType=media");
    expect(String(c.init!.body)).toContain('"enc":"pin"');
  });
  it("shareRelayFile POSTs a per-file user permission (writer by default)", async () => {
    const m = mock(() => new Response(JSON.stringify({ id: "perm1" }), { status: 200 }));
    await shareRelayFile("tok", "f1", "dana@team.io", m.fetch);
    const c = m.calls[0]!;
    expect(c.url).toContain("/drive/v3/files/f1/permissions");
    const body = JSON.parse(String(c.init!.body)) as { type: string; role: string; emailAddress: string };
    expect(body).toEqual({ type: "user", role: "writer", emailAddress: "dana@team.io" });
  });
  it("fails closed when a share is refused", async () => {
    const m = mock(() => new Response("no", { status: 400 }));
    expect(shareRelayFile("tok", "f1", "x@y.com", m.fetch)).rejects.toThrow(/400/);
  });
});

describe("ensureRelayFile (P-REMOTE.10)", () => {
  it("reuses an existing file (no create)", async () => {
    const m = mock((c) => c.url.includes("?q=") ? new Response(JSON.stringify({ files: [{ id: "exists" }] }), { status: 200 }) : new Response("", { status: 500 }));
    expect(await ensureRelayFile("tok", "lucid_relay_codes", "{}", m.fetch)).toBe("exists");
    expect(m.calls.length).toBe(1); // only the list, no create
  });
  it("creates when absent", async () => {
    const m = mock((c) => c.url.includes("?q=") ? new Response(JSON.stringify({ files: [] }), { status: 200 }) : new Response(JSON.stringify({ id: "made" }), { status: 200 }));
    expect(await ensureRelayFile("tok", "lucid_relay_codes", "{}", m.fetch)).toBe("made");
    expect(m.calls.length).toBe(2); // list + create
  });
});
