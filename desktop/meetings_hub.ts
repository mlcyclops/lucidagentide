// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/meetings_hub.ts - P-MEET.1: the server-side half of the Meetings panel.
//
// The IDE is a THIN CLIENT of the Lucid Meeting Hub running on this machine (loopback only,
// 127.0.0.1:5123 by default). Every byte the panel shows is fetched live over the Hub's
// bearer-scoped `/ext/*` surface; nothing about a meeting is ever persisted IDE-side (the Hub's
// encrypted vault stays the single source of truth). The ONE write we make is marking an action
// item done, which the Hub itself owns in its todo ledger - so the bearer can read meetings AND
// mark action items done, and the pairing copy says exactly that.
//
// Why the calls live HERE and not in the renderer: the pairing bearer belongs in the OS-encrypted
// credential vault (cred_vault.ts), and a renderer that could read meeting content directly would
// also have to hold that token in page memory for the life of the window. The engine holds it for
// the session, the renderer only ever sees rendered rows.
//
// TOKEN LIFECYCLE (mirrors the Figma PAT seam, ADR-0154): pairing mints the token here and hands it
// back ONCE so the renderer can push it into the OS vault via the credStore IPC (safeStorage is
// main-process-only, so there is no path from this process into the vault). `setMeetingHubToken`
// keeps it usable for the rest of THIS session without a relaunch; main.ts injects it as
// LUCID_MEETING_HUB_TOKEN on subsequent engine spawns, and this module takes it OUT of process.env
// the moment it loads (below), so no omp, fleet, scanner or other child ever inherits it. The token
// is never logged and never written to the settings file.
//
// LOOPBACK ONLY: the bearer opens private meeting notes, so it is presented to an explicit loopback
// origin and nowhere else. LUCID_MEETING_HUB_URL may move the PORT; any other scheme or host is
// refused (fail-closed), and no request, authenticated or not, leaves for it.
//
// DORMANT, NOT BROKEN: when the Hub is not installed/running, `probeHub` fails fast (300ms) and the
// panel renders one honest info row. There is no retry loop here - a probe happens when the user
// opens or refreshes the panel, never on a timer.

/** Non-secret handle for the pairing bearer inside the OS-encrypted credential vault. */
export const MEETING_HUB_CRED_REF = "meeting_hub_token";

/** The dormancy probe budget from the proposal. A Hub on loopback answers in single-digit ms; this
 *  is short enough that opening the panel with no Hub installed feels instant. */
export const HUB_PROBE_TIMEOUT_MS = 300;

/** Content requests get a real budget: a locked-vault answer or a cold meeting listing can take a
 *  beat, but the panel must never hang on a wedged Hub. */
const HUB_REQUEST_TIMEOUT_MS = 4_000;

/** Where the Hub listens when LUCID_MEETING_HUB_URL is unset. */
export const DEFAULT_HUB_ORIGIN = "http://127.0.0.1:5123";

/** The only hosts the bearer may travel to. `URL.hostname` keeps IPv6 brackets and lower-cases names,
 *  and the WHATWG parser folds IPv4 shorthands (127.1, 0x7f000001) to 127.0.0.1 before this check. */
const LOOPBACK_HOSTS: Record<string, true> = { "127.0.0.1": true, localhost: true, "[::1]": true };

/** Shown when LUCID_MEETING_HUB_URL names anything but plain http on a loopback host. */
export const HUB_URL_REFUSED = "LUCID_MEETING_HUB_URL must be http:// on 127.0.0.1, localhost or [::1] (any port); the Meetings panel will not contact any other address.";

/** The Hub's origin, or null when LUCID_MEETING_HUB_URL is set to anything the bearer must not reach.
 *  The variable exists because the Hub's port is user-configurable (and so a test can aim at a fake);
 *  it is read per call, so no module-cache dependency. Fail-closed: unparseable, non-http, a
 *  non-loopback host, credentials, a path, a query or a fragment all yield null, never a fallback. */
export function hubOrigin(): string | null {
  const raw = (process.env.LUCID_MEETING_HUB_URL ?? "").trim();
  if (!raw) return DEFAULT_HUB_ORIGIN;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "http:" || LOOPBACK_HOSTS[u.hostname] !== true) return null;
  if (u.username || u.password || u.pathname !== "/" || u.search || u.hash) return null;
  return u.origin;
}

// P-SANDBOX.15 discipline (dev.ts does the same for LUCID_MAIN_TOKEN): the vault-injected bearer is
// captured into module state and REMOVED from process.env at module load. dev.ts imports this module
// statically, so this runs before any statement of the engine, and therefore before any omp child,
// fleet lane or scanner is spawned - all of which inherit process.env.
let sessionToken = process.env.LUCID_MEETING_HUB_TOKEN ?? "";
delete process.env.LUCID_MEETING_HUB_TOKEN;
/** Remember a freshly-claimed token for THIS engine session (pairing must not need a relaunch). */
export function setMeetingHubToken(token: string): void { sessionToken = String(token || ""); }
/** The bearer to present, or "" when the IDE has never been paired. */
export function meetingHubToken(): string { return sessionToken; }
export function meetingHubPaired(): boolean { return meetingHubToken().length > 0; }

/** Is a Lucid Meeting Hub listening? ANY HTTP answer counts, including an error status: the Hub's
 *  BaseHTTPRequestHandler has no do_HEAD and replies 501, which still proves it is there. Only a
 *  connection failure or the timeout means "not installed". */
export async function probeHub(timeoutMs = HUB_PROBE_TIMEOUT_MS): Promise<boolean> {
  const origin = hubOrigin();
  if (!origin) return false;
  try {
    await fetch(`${origin}/`, { method: "HEAD", signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch { return false; }
}

interface HubResult<T> { ok: boolean; status: number; data: T | null; error: string | null }

/** One authenticated `/ext/*` call. Never throws: a dead Hub, a timeout, and a refusal all come back
 *  as a structured result so the panel can say WHICH it was. */
async function hubJson<T>(path: string, init?: { method?: string; body?: unknown }): Promise<HubResult<T>> {
  const origin = hubOrigin();
  if (!origin) return { ok: false, status: 0, data: null, error: HUB_URL_REFUSED };
  const token = meetingHubToken();
  if (!token) return { ok: false, status: 401, data: null, error: "not paired" };
  try {
    const res = await fetch(origin + path, {
      method: init?.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "error", // the /ext surface never redirects; following one could carry the bearer off loopback
      signal: AbortSignal.timeout(HUB_REQUEST_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null) as { error?: unknown } | null;
    if (!res.ok) return { ok: false, status: res.status, data: null, error: String(body?.error ?? `hub error ${res.status}`) };
    return { ok: true, status: res.status, data: body as T, error: null };
  } catch { return { ok: false, status: 0, data: null, error: "unreachable" }; }
}

// ── Shapes. Normalized at the boundary: the Hub is a separate product on its own release cadence,
//    so every field is re-typed here and a row that is missing its identity is dropped entirely. ──

/** One listing row. Under a LOCKED Hub vault this is all that exists: `title` folds to
 *  "<App> Meeting", `duration` is null and `todos` is 0 - metadata derived from the filename. */
export interface MeetingRow {
  filename: string;
  date: string;
  app: string;
  title: string;
  duration: string | null;
  todos: number;
  hasVideo: boolean;
}

export interface MeetingsPage { locked: boolean; total: number; limit: number; offset: number; rows: MeetingRow[] }

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function normalizeRow(raw: unknown): MeetingRow | null {
  const r = raw as Record<string, unknown> | null;
  const filename = str(r?.filename).trim();
  if (!filename) return null; // no id means no detail fetch is possible - an unusable row
  const app = str(r?.app) || "unknown";
  return {
    filename,
    date: str(r?.date),
    app,
    title: str(r?.title) || `${app} Meeting`,
    duration: typeof r?.duration === "string" && r.duration ? r.duration : null,
    todos: num(r?.todos),
    hasVideo: r?.has_video === true,
  };
}

export function normalizeMeetingsPage(raw: unknown): MeetingsPage {
  const p = raw as Record<string, unknown> | null;
  const rows = Array.isArray(p?.rows) ? p.rows.map(normalizeRow).filter((r): r is MeetingRow => r !== null) : [];
  return {
    locked: p?.locked === true,
    total: num(p?.total) || rows.length,
    limit: num(p?.limit) || rows.length,
    offset: num(p?.offset),
    rows,
  };
}

/** A decrypted meeting. `notes` is the Hub's markdown (## Summary / ## Action Items / ## Decisions);
 *  `todos` is its extracted action-item list. Transcript text is deliberately NOT carried: the panel
 *  is recall, not a transcript reader, and the vault stays the place to read one. */
export interface MeetingDetail {
  filename: string;
  app: string;
  title: string;
  start: string;
  end: string;
  notes: string;
  todos: string[];
  hasVideo: boolean;
}

export function normalizeMeetingDetail(raw: unknown, filename: string): { locked: boolean; meeting: MeetingDetail | null } {
  const p = raw as Record<string, unknown> | null;
  if (p?.locked === true || !p?.meeting) return { locked: p?.locked === true, meeting: null };
  const m = p.meeting as Record<string, unknown>;
  const app = str(m.app) || "unknown";
  const meta = (m.metadata ?? null) as Record<string, unknown> | null;
  return {
    locked: false,
    meeting: {
      filename: str(m.filename) || filename,
      app,
      title: str(meta?.window_title) || `${app} Meeting`,
      start: str(m.start_time),
      end: str(m.end_time),
      notes: str(m.notes),
      todos: Array.isArray(m.todos) ? m.todos.map((t) => str(t)).filter((t) => t.trim().length > 0) : [],
      hasVideo: m.has_video === true,
    },
  };
}

/** One action item, carrying the Hub's content-addressed id so marking it done is idempotent. */
export interface TodoRow { id: string; todo: string; meetingDate: string; app: string; meetingFile: string; done: boolean }

function normalizeTodo(raw: unknown): TodoRow | null {
  const t = raw as Record<string, unknown> | null;
  const id = str(t?.id).trim();
  const todo = str(t?.todo).trim();
  if (!id || !todo) return null; // an item with no stable id can never be marked done
  return { id, todo, meetingDate: str(t?.meeting_date), app: str(t?.app), meetingFile: str(t?.meeting_file), done: t?.done === true };
}

export function normalizeTodos(raw: unknown): { locked: boolean; todos: TodoRow[] } {
  const p = raw as Record<string, unknown> | null;
  const todos = Array.isArray(p?.todos) ? p.todos.map(normalizeTodo).filter((t): t is TodoRow => t !== null) : [];
  return { locked: p?.locked === true, todos };
}

/** The next calendar event, when the Hub has one inside its lead window. */
export interface UpcomingEvent { subject: string; start: string }

export function normalizeUpcoming(raw: unknown): UpcomingEvent | null {
  const p = raw as Record<string, unknown> | null;
  const ev = (p?.next_event ?? null) as Record<string, unknown> | null;
  if (!ev) return null;
  const subject = str(ev.subject).trim();
  if (!subject) return null;
  return { subject, start: str(ev.start) };
}

/** Everything one panel paint needs. `installed` false means the Hub is not running (dormant row);
 *  `paired` false means it is running but this IDE holds no bearer yet (pairing row); `locked` true
 *  means the rows are honest metadata, NOT "you have no meetings". `openTodos` null means the Hub's
 *  open list could NOT be read, so whether any action item is done is unknown - never "all done".
 *  `dashboardUrl` is the validated Hub origin the panel links to (null when the configured URL was
 *  refused, so there is nothing safe to link). */
export interface MeetingsView {
  installed: boolean;
  paired: boolean;
  locked: boolean;
  total: number;
  limit: number;
  offset: number;
  rows: MeetingRow[];
  openTodos: TodoRow[] | null;
  upcoming: UpcomingEvent | null;
  error: string | null;
  dashboardUrl: string | null;
}

const DORMANT: Omit<MeetingsView, "installed" | "paired" | "dashboardUrl"> = {
  locked: false, total: 0, limit: 0, offset: 0, rows: [], openTodos: null, upcoming: null, error: null,
};

export interface MeetingsQuery { limit?: number; offset?: number; q?: string }

/** Build the panel's whole view in one round trip set. Probe first so an absent Hub costs 300ms and
 *  no 401 noise; then the listing, the open action items, and the upcoming event together. */
export async function meetingsView(query: MeetingsQuery = {}): Promise<MeetingsView> {
  const origin = hubOrigin();
  // A refused LUCID_MEETING_HUB_URL is not "no Hub": nothing is contacted, and the panel says why.
  if (!origin) return { ...DORMANT, installed: false, paired: meetingHubPaired(), error: HUB_URL_REFUSED, dashboardUrl: null };
  const dashboardUrl = `${origin}/`;
  if (!(await probeHub())) return { ...DORMANT, installed: false, paired: meetingHubPaired(), dashboardUrl };
  if (!meetingHubPaired()) return { ...DORMANT, installed: true, paired: false, dashboardUrl };

  const params = new URLSearchParams();
  params.set("limit", String(Math.max(1, Math.min(200, Math.floor(query.limit ?? 50)))));
  params.set("offset", String(Math.max(0, Math.floor(query.offset ?? 0))));
  const q = (query.q ?? "").trim();
  if (q) params.set("q", q.slice(0, 200));

  const [listRes, todoRes, nextRes] = await Promise.all([
    hubJson<unknown>(`/ext/meetings?${params}`),
    hubJson<unknown>("/ext/todos?open=1"),
    hubJson<unknown>("/ext/premeeting"),
  ]);

  if (!listRes.ok) {
    // A 401 here means the stored bearer was revoked on the Hub side: report it as unpaired so the
    // panel offers a fresh code rather than showing a dead-end error.
    const revoked = listRes.status === 401;
    return { ...DORMANT, installed: true, paired: !revoked, error: revoked ? null : listRes.error, dashboardUrl };
  }

  const page = normalizeMeetingsPage(listRes.data);
  return {
    installed: true,
    paired: true,
    locked: page.locked,
    total: page.total,
    limit: page.limit,
    offset: page.offset,
    rows: page.rows,
    // A failed open-list read is UNKNOWN (null), not an empty list: the panel reads absence from this
    // list as "done", so [] here would paint every action item checked during a partial Hub failure.
    openTodos: todoRes.ok ? normalizeTodos(todoRes.data).todos : null,
    upcoming: nextRes.ok ? normalizeUpcoming(nextRes.data) : null,
    error: null,
    dashboardUrl,
  };
}

/** One meeting's decrypted detail. A locked Hub answers `{ locked: true, meeting: null }` rather
 *  than an error, and the panel says so. */
export async function meetingDetail(filename: string): Promise<{ ok: boolean; locked: boolean; meeting: MeetingDetail | null; error: string | null }> {
  const name = filename.trim();
  if (!name || name !== name.replace(/[\\/]/g, "")) return { ok: false, locked: false, meeting: null, error: "invalid meeting id" };
  const res = await hubJson<unknown>(`/ext/meeting/${encodeURIComponent(name)}`);
  if (!res.ok) return { ok: false, locked: res.status === 403, meeting: null, error: res.error };
  const d = normalizeMeetingDetail(res.data, name);
  return { ok: true, locked: d.locked, meeting: d.meeting, error: null };
}

/** The panel's only write. The Hub owns the ledger; we just report the new state back. */
export async function markTodo(id: string, done: boolean): Promise<{ ok: boolean; todo: TodoRow | null; error: string | null }> {
  if (!id.trim()) return { ok: false, todo: null, error: "id required" };
  const res = await hubJson<unknown>("/ext/todos/mark", { method: "POST", body: { id: id.trim(), done: !!done } });
  if (!res.ok) return { ok: false, todo: null, error: res.error };
  const todo = normalizeTodo((res.data as Record<string, unknown> | null)?.todo);
  return { ok: true, todo, error: null };
}

/** Exchange a 6-digit code minted by the Hub dashboard for a bearer. Unauthenticated by design (we
 *  have no credential yet) and single-use on the Hub side. The token is returned to the caller so it
 *  can reach the OS vault; it is never logged. */
export async function claimPairing(code: string): Promise<{ ok: boolean; token: string; error: string | null }> {
  const digits = code.replace(/\D/g, "");
  if (digits.length !== 6) return { ok: false, token: "", error: "Enter the 6-digit code from the Hub dashboard." };
  const origin = hubOrigin();
  if (!origin) return { ok: false, token: "", error: HUB_URL_REFUSED };
  try {
    const res = await fetch(`${origin}/ext/pair/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: digits }),
      redirect: "error",
      signal: AbortSignal.timeout(HUB_REQUEST_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null) as { token?: unknown; error?: unknown } | null;
    if (!res.ok) return { ok: false, token: "", error: String(body?.error ?? `pairing failed (${res.status})`) };
    const token = str(body?.token);
    if (!token) return { ok: false, token: "", error: "the Hub returned no token" };
    setMeetingHubToken(token);
    return { ok: true, token, error: null };
  } catch { return { ok: false, token: "", error: "The Meeting Hub did not answer." }; }
}
