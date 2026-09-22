// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/meetings_hub.test.ts - P-MEET.1: the read-only Meeting Hub client, against a REAL fake Hub
// (Bun.serve on an ephemeral port), not a mocked fetch. What is worth pinning here:
//
//   - the three "no data" states are DISTINCT and each is honest: Hub absent, Hub present but not
//     paired, and Hub paired but vault locked. Collapsing any of them would make the panel lie.
//   - a revoked token reads as "pair again", never as a dead-end error.
//   - the bearer is presented on every content route and NEVER on the pairing claim (which has no
//     credential yet by design).
//   - a row the Hub sends without a filename is dropped: it could never be opened.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import {
  claimPairing, hubOrigin, markTodo, meetingDetail, meetingsView, meetingHubPaired, probeHub,
  normalizeMeetingDetail, normalizeMeetingsPage, normalizeTodos, normalizeUpcoming, setMeetingHubToken,
} from "./meetings_hub.ts";

const ROW = {
  filename: "2026-09-18_14-05_zoom.json.enc", date: "2026-09-18 14:05", app: "zoom",
  title: "Pricing sync", duration: "42m", todos: 2, has_video: true,
};
const TODO = {
  todo: "Nick to draft the pricing page", meeting_date: "2026-09-18 14:05", app: "zoom",
  meeting_file: "2026-09-18_14-05_zoom.json.enc", id: "a".repeat(40), done: false,
};

/** What the fake Hub should do on the next request set. Mutated per test. */
const hub = {
  locked: false,
  revoked: false,
  seenAuth: [] as string[],
  claimAuth: null as string | null,
  marked: null as { id: string; done: boolean } | null,
};

let server: Server;
const priorUrl = process.env.LUCID_MEETING_HUB_URL;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      const auth = req.headers.get("authorization");
      if (req.method === "HEAD" && p === "/") return new Response(null, { status: 501 }); // the real Hub has no do_HEAD
      if (p === "/ext/pair/claim") {
        hub.claimAuth = auth;
        return Response.json({ token: "hub-bearer-token", token_id: "abcd1234" });
      }
      if (auth) hub.seenAuth.push(`${p}:${auth}`);
      if (hub.revoked) return Response.json({ error: "not paired" }, { status: 401 });
      if (p === "/ext/meetings") {
        return Response.json(hub.locked
          ? { locked: true, total: 1, limit: 50, offset: 0, rows: [{ ...ROW, title: "Zoom Meeting", duration: null, todos: 0 }] }
          : { locked: false, total: 1, limit: 50, offset: 0, rows: [ROW] });
      }
      if (p === "/ext/todos") return Response.json(hub.locked ? { locked: true, todos: [] } : { locked: false, todos: [TODO] });
      if (p === "/ext/premeeting") {
        return Response.json({ enabled: true, lead_minutes: 15, vault_unlocked: !hub.locked, brief: null,
          next_event: hub.locked ? null : { subject: "Board review", start: "2026-09-22T09:00:00" } });
      }
      if (p === `/ext/meeting/${ROW.filename}`) {
        // The real Hub's record carries NO filename key - the caller's requested name is the id.
        return Response.json(hub.locked
          ? { locked: true, meeting: null }
          : { locked: false, meeting: { app: "zoom", start_time: "2026-09-18T14:05:00", end_time: "2026-09-18T14:47:00", notes: "## Decisions\n- Ship it\n", todos: ["Nick to draft the pricing page"], metadata: { window_title: "Pricing sync" }, has_video: true } });
      }
      if (p === "/ext/meeting/missing.json.enc") return Response.json({ error: "meeting not found" }, { status: 404 });
      if (p === "/ext/todos/mark" && req.method === "POST") {
        return req.json().then((b: { id: string; done: boolean }) => {
          hub.marked = { id: b.id, done: b.done };
          return Response.json({ ok: true, todo: { ...TODO, done: b.done } });
        });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  process.env.LUCID_MEETING_HUB_URL = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  if (priorUrl === undefined) delete process.env.LUCID_MEETING_HUB_URL;
  else process.env.LUCID_MEETING_HUB_URL = priorUrl;
});

afterEach(() => {
  setMeetingHubToken("");
  delete process.env.LUCID_MEETING_HUB_TOKEN;
  hub.locked = false; hub.revoked = false; hub.seenAuth = []; hub.claimAuth = null; hub.marked = null;
});

describe("normalizers - the Hub ships on its own cadence, so every field is re-typed", () => {
  test("a row with no filename is dropped: it could never be opened", () => {
    const page = normalizeMeetingsPage({ locked: false, total: 2, limit: 50, offset: 0, rows: [ROW, { ...ROW, filename: "" }] });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toEqual({ filename: ROW.filename, date: ROW.date, app: "zoom", title: "Pricing sync", duration: "42m", todos: 2, hasVideo: true });
  });
  test("junk in place of a page yields an empty, non-locked page rather than throwing", () => {
    expect(normalizeMeetingsPage(null)).toEqual({ locked: false, total: 0, limit: 0, offset: 0, rows: [] });
    expect(normalizeMeetingsPage({ rows: "nope" }).rows).toEqual([]);
  });
  test("the detail record has no filename key, so the requested name is the id", () => {
    const d = normalizeMeetingDetail({ locked: false, meeting: { app: "zoom", metadata: { window_title: "Pricing sync" }, todos: ["x"] } }, "asked-for.json.enc");
    expect(d.meeting!.filename).toBe("asked-for.json.enc");
    expect(d.meeting!.title).toBe("Pricing sync");
  });
  test("a record with no window_title falls back to the app, never to an empty heading", () => {
    const d = normalizeMeetingDetail({ locked: false, meeting: { app: "teams" } }, "f.json.enc");
    expect(d.meeting!.title).toBe("teams Meeting");
    expect(d.meeting!.todos).toEqual([]);
  });
  test("a todo with no stable id is dropped: it could never be marked done", () => {
    expect(normalizeTodos({ locked: false, todos: [TODO, { ...TODO, id: "" }] }).todos).toHaveLength(1);
  });
  test("an upcoming event with no subject is not an upcoming event", () => {
    expect(normalizeUpcoming({ next_event: { subject: "", start: "x" } })).toBeNull();
    expect(normalizeUpcoming({ next_event: null })).toBeNull();
    expect(normalizeUpcoming({ next_event: { subject: "Board review", start: "2026-09-22T09:00:00" } }))
      .toEqual({ subject: "Board review", start: "2026-09-22T09:00:00" });
  });
});

describe("probe - dormancy is a normal state, detected fast", () => {
  test("a live Hub answers even though it has no do_HEAD (501 still proves it is there)", async () => {
    expect(await probeHub()).toBe(true);
  });
  test("a closed port reports not-installed inside the probe budget", async () => {
    const prior = process.env.LUCID_MEETING_HUB_URL;
    process.env.LUCID_MEETING_HUB_URL = "http://127.0.0.1:1";
    expect(hubOrigin()).toBe("http://127.0.0.1:1");
    const t0 = Date.now();
    expect(await probeHub()).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1500);
    process.env.LUCID_MEETING_HUB_URL = prior;
  });
});

describe("the three no-data states stay distinct", () => {
  test("no Hub: not installed, and no token is even consulted", async () => {
    const prior = process.env.LUCID_MEETING_HUB_URL;
    process.env.LUCID_MEETING_HUB_URL = "http://127.0.0.1:1";
    const v = await meetingsView();
    process.env.LUCID_MEETING_HUB_URL = prior;
    expect(v.installed).toBe(false);
    expect(v.rows).toEqual([]);
    expect(v.error).toBeNull(); // dormant is not an error
  });
  test("Hub up, never paired: installed but unpaired, and nothing is requested", async () => {
    const v = await meetingsView();
    expect(v).toMatchObject({ installed: true, paired: false, rows: [], error: null });
    expect(hub.seenAuth).toEqual([]);
  });
  test("Hub up and paired but LOCKED: rows survive, locked is reported", async () => {
    setMeetingHubToken("hub-bearer-token");
    hub.locked = true;
    const v = await meetingsView();
    expect(v).toMatchObject({ installed: true, paired: true, locked: true });
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0]!.title).toBe("Zoom Meeting");
    expect(v.openTodos).toEqual([]);
    expect(v.upcoming).toBeNull();
  });
});

describe("paired reads", () => {
  test("the full view carries rows, open action items and the upcoming event", async () => {
    setMeetingHubToken("hub-bearer-token");
    const v = await meetingsView({ q: "pricing", limit: 10, offset: 0 });
    expect(v).toMatchObject({ installed: true, paired: true, locked: false, total: 1 });
    expect(v.rows[0]!.filename).toBe(ROW.filename);
    expect(v.openTodos[0]!.id).toBe(TODO.id);
    expect(v.upcoming).toEqual({ subject: "Board review", start: "2026-09-22T09:00:00" });
  });
  test("every content route presents the bearer", async () => {
    setMeetingHubToken("hub-bearer-token");
    await meetingsView();
    expect(hub.seenAuth.sort()).toEqual([
      "/ext/meetings:Bearer hub-bearer-token",
      "/ext/premeeting:Bearer hub-bearer-token",
      "/ext/todos:Bearer hub-bearer-token",
    ]);
  });
  test("a REVOKED token reads as 'pair again', not as an error to stare at", async () => {
    setMeetingHubToken("stale-token");
    hub.revoked = true;
    const v = await meetingsView();
    expect(v).toMatchObject({ installed: true, paired: false, error: null });
  });
  test("the env token is used when no pairing happened this session", async () => {
    process.env.LUCID_MEETING_HUB_TOKEN = "from-the-os-vault";
    expect(meetingHubPaired()).toBe(true);
    await meetingsView();
    expect(hub.seenAuth).toContain("/ext/meetings:Bearer from-the-os-vault");
  });
  test("a detail fetch resolves notes and action items; the requested name becomes the id", async () => {
    setMeetingHubToken("hub-bearer-token");
    const r = await meetingDetail(ROW.filename);
    expect(r.ok).toBe(true);
    expect(r.meeting!.filename).toBe(ROW.filename);
    expect(r.meeting!.notes).toContain("Ship it");
    expect(r.meeting!.todos).toEqual(["Nick to draft the pricing page"]);
  });
  test("a locked detail is reported as locked, with no meeting - never an exception", async () => {
    setMeetingHubToken("hub-bearer-token");
    hub.locked = true;
    const r = await meetingDetail(ROW.filename);
    expect(r).toMatchObject({ ok: true, locked: true, meeting: null });
  });
  test("an unknown meeting surfaces the Hub's own reason", async () => {
    setMeetingHubToken("hub-bearer-token");
    const r = await meetingDetail("missing.json.enc");
    expect(r).toMatchObject({ ok: false, error: "meeting not found" });
  });
  test("a path-traversal id is refused here, before it ever reaches the Hub", async () => {
    setMeetingHubToken("hub-bearer-token");
    const r = await meetingDetail("../../etc/passwd");
    expect(r).toMatchObject({ ok: false, error: "invalid meeting id" });
    expect(hub.seenAuth).toEqual([]);
  });
});

describe("the one write", () => {
  test("marking an action item done sends its content-addressed id and reports the new state", async () => {
    setMeetingHubToken("hub-bearer-token");
    const r = await markTodo(TODO.id, true);
    expect(hub.marked).toEqual({ id: TODO.id, done: true });
    expect(r).toMatchObject({ ok: true });
    expect(r.todo!.done).toBe(true);
  });
  test("an empty id never reaches the Hub", async () => {
    setMeetingHubToken("hub-bearer-token");
    expect(await markTodo("  ", true)).toMatchObject({ ok: false, error: "id required" });
    expect(hub.seenAuth).toEqual([]);
  });
});

describe("pairing", () => {
  test("a claimed code mints a token, adopts it for this session, and sends NO bearer", async () => {
    const r = await claimPairing("123 456");
    expect(r).toEqual({ ok: true, token: "hub-bearer-token", error: null });
    expect(hub.claimAuth).toBeNull(); // the extension/IDE has no credential yet - by design
    expect(meetingHubPaired()).toBe(true); // usable immediately, no relaunch
  });
  test("a code that is not six digits is refused locally", async () => {
    const r = await claimPairing("12345");
    expect(r.ok).toBe(false);
    expect(hub.claimAuth).toBeNull();
    expect(meetingHubPaired()).toBe(false);
  });
});
