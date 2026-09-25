// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/meetings_hub.test.ts - P-MEET.1: the Meeting Hub client, against a REAL fake Hub
// (Bun.serve on an ephemeral port, so every test also runs on a NON-default port), not a mocked
// fetch. What is worth pinning here:
//
//   - the three "no data" states are DISTINCT and each is honest: Hub absent, Hub present but not
//     paired, and Hub paired but vault locked. Collapsing any of them would make the panel lie.
//   - a revoked token reads as "pair again", never as a dead-end error.
//   - a failed open-action-item read is UNKNOWN, never "everything is done".
//   - the bearer is presented on every content route and NEVER on the pairing claim (which has no
//     credential yet by design), only ever to a loopback origin, and never to a spawned child.
//   - a row the Hub sends without a filename is dropped: it could never be opened.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import {
  claimPairing, hubOrigin, markTodo, meetingDetail, meetingsView, meetingHubPaired, probeHub, HUB_URL_REFUSED,
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
  todosFail: false,
  hits: 0,
  seenAuth: [] as string[],
  claimAuth: null as string | null,
  marked: null as { id: string; done: boolean } | null,
};

let server: Server;
let hubUrl = ""; // the fake Hub's origin: an ephemeral port, never the default 5123
const priorUrl = process.env.LUCID_MEETING_HUB_URL;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      const auth = req.headers.get("authorization");
      hub.hits++;
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
      if (p === "/ext/todos") {
        if (hub.todosFail) return Response.json({ error: "todo ledger unavailable" }, { status: 500 });
        return Response.json(hub.locked ? { locked: true, todos: [] } : { locked: false, todos: [TODO] });
      }
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
  hubUrl = `http://127.0.0.1:${server.port}`;
  process.env.LUCID_MEETING_HUB_URL = hubUrl;
});

afterAll(() => {
  server.stop(true);
  if (priorUrl === undefined) delete process.env.LUCID_MEETING_HUB_URL;
  else process.env.LUCID_MEETING_HUB_URL = priorUrl;
});

afterEach(() => {
  setMeetingHubToken("");
  process.env.LUCID_MEETING_HUB_URL = hubUrl;
  hub.locked = false; hub.revoked = false; hub.todosFail = false; hub.hits = 0;
  hub.seenAuth = []; hub.claimAuth = null; hub.marked = null;
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

describe("origin - the bearer only ever travels to an explicit loopback host", () => {
  test("unset means the default Hub; http on 127.0.0.1, localhost or [::1] is accepted on any port", () => {
    delete process.env.LUCID_MEETING_HUB_URL;
    expect(hubOrigin()).toBe("http://127.0.0.1:5123");
    for (const [raw, origin] of [
      ["http://127.0.0.1:6123", "http://127.0.0.1:6123"],
      ["http://localhost:6123/", "http://localhost:6123"],
      ["http://[::1]:6123", "http://[::1]:6123"],
      ["http://127.0.0.1", "http://127.0.0.1"],
    ] as const) {
      process.env.LUCID_MEETING_HUB_URL = raw;
      expect(hubOrigin()).toBe(origin);
    }
  });
  test("any other scheme, host, credentials or path is refused outright, with no fallback", () => {
    for (const raw of [
      "https://127.0.0.1:5123", "http://meetings.example.com:5123", "http://127.0.0.2:5123",
      "http://127.0.0.1.example.com:5123", "http://user:pw@127.0.0.1:5123", "http://127.0.0.1:5123/hub",
      "file:///C:/hub", "not a url",
    ]) {
      process.env.LUCID_MEETING_HUB_URL = raw;
      expect(hubOrigin()).toBeNull();
    }
  });
  test("a refused origin is contacted by NOTHING: no probe, no read, no write, no pairing claim", async () => {
    setMeetingHubToken("hub-bearer-token");
    // Same live fake Hub, but addressed with a path, which the gate refuses: every call must stop
    // before the network, so the Hub sees zero requests.
    process.env.LUCID_MEETING_HUB_URL = `${hubUrl}/prefix`;
    const v = await meetingsView();
    expect(v).toMatchObject({ installed: false, rows: [], error: HUB_URL_REFUSED, dashboardUrl: null });
    expect(await probeHub()).toBe(false);
    expect(await markTodo(TODO.id, true)).toMatchObject({ ok: false, error: HUB_URL_REFUSED });
    expect(await meetingDetail(ROW.filename)).toMatchObject({ ok: false, error: HUB_URL_REFUSED });
    expect(await claimPairing("123456")).toMatchObject({ ok: false, error: HUB_URL_REFUSED });
    expect(hub.hits).toBe(0);
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
    // The pairing row's "Open the Hub" link follows the CONFIGURED port, not a hard-coded 5123.
    expect(v.dashboardUrl).toBe(`${hubUrl}/`);
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
    expect(v.openTodos![0]!.id).toBe(TODO.id);
    expect(v.upcoming).toEqual({ subject: "Board review", start: "2026-09-22T09:00:00" });
    expect(v.dashboardUrl).toBe(`${hubUrl}/`); // the brief link targets the Hub actually answering
  });
  test("a failed open-item read is UNKNOWN (null), never an empty list that would read as all done", async () => {
    setMeetingHubToken("hub-bearer-token");
    hub.todosFail = true;
    const v = await meetingsView();
    expect(v).toMatchObject({ installed: true, paired: true, locked: false, error: null });
    expect(v.rows).toHaveLength(1); // the listing itself still succeeded
    expect(v.openTodos).toBeNull();
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
  test("the vault-injected bearer authenticates the engine, but no child it spawns can see it", async () => {
    // A FRESH engine-like process (the capture happens at module load, so only a fresh process can
    // show it; hence the dynamic import inside the child script): main.ts injects
    // LUCID_MEETING_HUB_TOKEN, the process loads this module (as dev.ts does), spawns a child the way
    // ACPClient does ({ ...process.env }), then reads the Hub. The engine must still authenticate;
    // the child must find no such variable.
    const mod = new URL("./meetings_hub.ts", import.meta.url).href;
    const script = `(async () => {
      const hub = await import(${JSON.stringify(mod)});
      const child = Bun.spawnSync([process.execPath, "-e", "process.stdout.write(String(process.env.LUCID_MEETING_HUB_TOKEN))"], { env: { ...process.env } });
      const v = await hub.meetingsView();
      process.stdout.write(JSON.stringify({ inEnv: "LUCID_MEETING_HUB_TOKEN" in process.env, child: child.stdout.toString(), paired: v.paired, rows: v.rows.length }));
    })();`;
    const proc = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, LUCID_MEETING_HUB_URL: hubUrl, LUCID_MEETING_HUB_TOKEN: "from-the-os-vault" },
      stdout: "pipe", stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    if (code !== 0) throw new Error(`engine-like child exited ${code}: ${err}`);
    expect(JSON.parse(out)).toEqual({ inEnv: false, child: "undefined", paired: true, rows: 1 });
    expect(hub.seenAuth).toContain("/ext/meetings:Bearer from-the-os-vault");
  }, 30_000);
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
