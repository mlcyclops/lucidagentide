// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/creator_drift.ts - CREATOR-DRIFT: CutWire Drift as a Creator provider.
//
// Drift (GPL-3.0 Qt 6 + FFmpeg video editor) serves a localhost MCP endpoint when the user turns on
// Settings -> Agent access. It then writes `mcp-session.json` ({port, url, token, pid}) under the platform's
// runtime location (or $DRIFT_MCP_SESSION_PATH). LUCID discovers that file, reads the token ONLY to put it in
// the Authorization header, and talks JSON-RPC 2.0 over HTTP. Nothing here spawns, links, vendors, or bundles
// Drift; the headless form (`drift --headless --mcp-port N --mcp-token T`) is reached through a declared
// Creator endpoint plus a vault credential NAME exactly like every other local-http provider.
//
// Every function below either is pure or takes injected IO, and the client never throws: a dead editor is a
// refusal with the steps that turn Agent access on, never an exception and never "ok".

import { sniffMime } from "../harness/creator/comfy_stream.ts";
import type { ArtifactKind } from "./creator_image.ts";
import type { CreatorEndpointDef } from "./creator_registry.ts";

// ── session discovery ────────────────────────────────────────────────────────

export interface DriftSession { port: number; url: string; token: string; pid: number }

/** Where Drift writes mcp-session.json on this platform: `$DRIFT_MCP_SESSION_PATH` wins, else
 *  QStandardPaths::RuntimeLocation/drift/mcp-session.json (the user profile dir on Windows, Application
 *  Support on macOS, $XDG_RUNTIME_DIR or /tmp on Linux). */
export function driftSessionPath(env: Readonly<Record<string, string | undefined>>, platform: string, home: string): string {
  const override = (env.DRIFT_MCP_SESSION_PATH ?? "").trim();
  if (override) return override;
  const base = home.replace(/[\\/]+$/, "");
  if (platform === "win32") return `${base}/drift/mcp-session.json`;
  if (platform === "darwin") return `${base}/Library/Application Support/drift/mcp-session.json`;
  const runtime = (env.XDG_RUNTIME_DIR ?? "").trim().replace(/\/+$/, "");
  return `${runtime || "/tmp"}/drift/mcp-session.json`;
}

/** Parse mcp-session.json. Null on anything incomplete: a half-written file must read as "no session". */
export function parseDriftSession(text: string): DriftSession | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const port = "port" in raw && typeof raw.port === "number" && Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536 ? raw.port : 0;
  const token = "token" in raw && typeof raw.token === "string" ? raw.token.trim() : "";
  const pid = "pid" in raw && typeof raw.pid === "number" && Number.isInteger(raw.pid) && raw.pid > 0 ? raw.pid : 0;
  const url = "url" in raw && typeof raw.url === "string" && raw.url.trim() ? raw.url.trim() : (port ? `http://127.0.0.1:${port}/mcp` : "");
  if (!port || !token || !pid || !url) return null;
  // The session is loopback by construction: a file that points anywhere else is not Drift's.
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" || !(u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]")) return null;
  } catch { return null; }
  return { port, url, token, pid };
}

/** Where a stock Drift install puts its executable, so a missing session can still say "installed, Agent
 *  access off" rather than "not installed". */
export function defaultDriftExePaths(platform: string, env: Readonly<Record<string, string | undefined>>): string[] {
  if (platform === "win32") {
    const out = ["C:\\Program Files\\Drift\\drift.exe"];
    const local = (env.LOCALAPPDATA ?? "").trim();
    if (local) out.push(`${local.replace(/[\\/]+$/, "")}\\Programs\\Drift\\drift.exe`);
    return out;
  }
  if (platform === "darwin") return ["/Applications/Drift.app/Contents/MacOS/Drift"];
  const home = (env.HOME ?? "").trim().replace(/\/+$/, "");
  return [
    "/usr/bin/drift", "/usr/local/bin/drift", "/var/lib/flatpak/exports/bin/org.cutwire.Drift",
    ...(home ? [`${home}/.local/share/flatpak/exports/bin/org.cutwire.Drift`] : []),
  ];
}

/** The session as a Creator declaration, so creatorGate and the registry row treat it like any endpoint.
 *  Loopback, hence on-device for the CUI verdict. Never carries the token. */
export const DRIFT_SESSION_ENDPOINT_ID = "drift-session";
export function driftSessionEndpointDef(session: DriftSession): CreatorEndpointDef {
  return { id: DRIFT_SESSION_ENDPOINT_ID, providerId: "drift", label: "Drift (Agent access session)", baseUrl: `http://127.0.0.1:${session.port}`, zone: "local", enabled: true };
}

/** What the engine reads from the session file: parsed or not, with the reason. The token stays inside
 *  `session` and only ever reaches an Authorization header. */
export interface DriftSessionState { path: string; session: DriftSession | null; error: string }

/** The `session` block of the status payload: port, pid, and path only. Built here so no route can ever
 *  spread the parsed session (and its token) into a response by accident. */
export function driftSessionStatus(state: DriftSessionState): { path: string; present: boolean; port: number; pid: number; error: string } {
  return {
    path: state.path,
    present: state.session !== null,
    port: state.session?.port ?? 0,
    pid: state.session?.pid ?? 0,
    error: state.error,
  };
}

// ── the JSON-RPC client ──────────────────────────────────────────────────────

export interface DriftToolResult {
  ok: boolean;
  isError: boolean;
  text: string;
  payload: unknown;
  images: { mimeType: string; data: string }[];
  error?: string;
  status?: number;
}

export type DriftInitResult = { ok: true; version: string; instructions: string } | { ok: false; error: string; status: number };

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;

/** Bound a remote string for an error line. */
function bounded(v: unknown): string {
  return typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200) : "";
}

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The shape both global fetch and the probe's injected FetchLike satisfy. */
export type DriftFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** JSON-RPC 2.0 over `POST /mcp`. Never throws. The token lives only in the Authorization header. */
export class DriftClient {
  readonly #base: string;
  readonly #token: string;
  readonly #fetch: DriftFetch;
  readonly #timeoutMs: number;
  #seq = 0;

  constructor(opts: { baseUrl: string; token: string; fetchImpl?: DriftFetch; timeoutMs?: number }) {
    this.#base = opts.baseUrl.replace(/\/+$/, "");
    this.#token = opts.token;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get baseUrl(): string { return this.#base; }

  /** GET /health: no auth, `{ok:true}` when Drift's agent server is up. */
  async health(): Promise<{ ok: boolean; status: number }> {
    try {
      const res = await this.#fetch(`${this.#base}/health`, { method: "GET", signal: AbortSignal.timeout(Math.min(this.#timeoutMs, 8_000)) });
      let body: unknown = null;
      try { body = await res.json(); } catch { body = null; }
      return { ok: res.ok && record(body).ok === true, status: res.status };
    } catch {
      return { ok: false, status: 0 };
    }
  }

  async #rpc(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<{ ok: true; result: unknown } | { ok: false; error: string; status: number }> {
    const id = ++this.#seq;
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${this.#token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { ok: false, error: "Drift did not answer. In Drift: Settings -> Agent access -> On (the session file may be stale if Drift was closed).", status: 0 };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, error: "unauthorized", status: res.status };
    let body: unknown = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok) {
      const remote = bounded(record(body).error);
      return { ok: false, error: remote ? `Drift answered ${res.status}: ${remote}` : `Drift answered ${res.status}.`, status: res.status };
    }
    const env = record(body);
    if ("error" in env && env.error !== null && env.error !== undefined) {
      const e = record(env.error);
      const msg = bounded(e.message) || bounded(env.error) || "rpc error";
      const code = typeof e.code === "number" ? ` (${e.code})` : "";
      return { ok: false, error: `Drift rejected ${method}${code}: ${msg}`, status: res.status };
    }
    return { ok: true, result: env.result };
  }

  /** `initialize`: proves the token and names the Drift version. */
  async initialize(): Promise<DriftInitResult> {
    const r = await this.#rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "lucid-creator", version: "1" },
    }, Math.min(this.#timeoutMs, 10_000));
    if (!r.ok) return r;
    const result = record(r.result);
    const info = record(result.serverInfo);
    return { ok: true, version: bounded(info.version), instructions: typeof result.instructions === "string" ? result.instructions.slice(0, 20_000) : "" };
  }

  /** `tools/call`. `isError` is Drift's flag OR a `{ok:false}` payload; `images` collects image blocks. */
  async call(tool: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<DriftToolResult> {
    const name = typeof tool === "string" ? tool.trim() : "";
    if (!name) return { ok: false, isError: true, text: "", payload: null, images: [], error: "A tool name is required." };
    const r = await this.#rpc("tools/call", { name, arguments: args ?? {} }, timeoutMs ?? this.#timeoutMs);
    if (!r.ok) return { ok: false, isError: true, text: "", payload: null, images: [], error: r.error, status: r.status };
    const result = record(r.result);
    const content = Array.isArray(result.content) ? result.content : [];
    const texts: string[] = [];
    const images: { mimeType: string; data: string }[] = [];
    for (const block of content) {
      const b = record(block);
      if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
      else if (b.type === "image" && typeof b.data === "string") images.push({ mimeType: typeof b.mimeType === "string" ? b.mimeType : "image/png", data: b.data });
    }
    let text = texts.join("\n");
    if (text.length > MAX_TEXT_BYTES) text = text.slice(0, MAX_TEXT_BYTES);
    let payload: unknown = null;
    if (text) { try { payload = JSON.parse(text); } catch { payload = null; } }
    const isError = result.isError === true || record(payload).ok === false;
    const code = bounded(record(payload).error);
    const detail = bounded(record(payload).detail);
    return {
      ok: !isError,
      isError,
      text,
      payload,
      images,
      ...(isError ? { error: code ? `${name}: ${code}${detail ? ` (${detail})` : ""}` : `${name} reported an error.` } : {}),
    };
  }
}

// ── the collaboration feed ───────────────────────────────────────────────────

export interface DriftActivityEntry {
  seq: number;
  at: number;
  source: "agent" | "ui";
  tool: string;
  ok: boolean;
  summary: string;
  undoable: boolean;
  revision: number | null;
}

const RING_SIZE = 200;

/** In-memory ring of the last 200 calls (agent and user), so the Studio tab and the agent see the same
 *  history. `latest()` is newest-first; `since(seq)` is ascending for incremental polls. */
export class DriftActivityLog {
  #entries: DriftActivityEntry[] = [];
  #seq = 0;

  push(e: Omit<DriftActivityEntry, "seq">): DriftActivityEntry {
    const entry: DriftActivityEntry = { ...e, seq: ++this.#seq };
    this.#entries.push(entry);
    if (this.#entries.length > RING_SIZE) this.#entries.splice(0, this.#entries.length - RING_SIZE);
    return entry;
  }

  since(seq: number): DriftActivityEntry[] {
    const floor = Number.isFinite(seq) ? seq : 0;
    return this.#entries.filter((e) => e.seq > floor);
  }

  latest(limit = 50): DriftActivityEntry[] {
    const n = Math.max(0, Math.min(RING_SIZE, Math.floor(limit)));
    return this.#entries.slice(-n).reverse();
  }
}

// ── library import ───────────────────────────────────────────────────────────

/** What an export from Drift may land in the Creator library as. The MAGIC BYTES decide, never the extension
 *  Drift was asked for. */
export const DRIFT_LIBRARY_MIME: Record<string, { kind: ArtifactKind; mime: string }> = {
  "video/mp4": { kind: "video", mime: "video/mp4" },
  "video/webm": { kind: "video", mime: "video/webm" },
  "image/gif": { kind: "gif", mime: "image/gif" },
};

export function planDriftLibraryImport(path: string, bytes: Uint8Array): { ok: true; kind: ArtifactKind; mime: string } | { ok: false; error: string } {
  const p = typeof path === "string" ? path.trim() : "";
  if (!p) return { ok: false, error: "A path is required." };
  if (!/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(p)) return { ok: false, error: "The export path must be absolute." };
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return { ok: false, error: `${p} is empty: the export has not finished writing.` };
  const sniffed = sniffMime(bytes);
  const entry = sniffed ? DRIFT_LIBRARY_MIME[sniffed] : undefined;
  if (!entry) return { ok: false, error: `${p} is not an MP4, WebM, or GIF by its bytes${sniffed ? ` (it reads as ${sniffed})` : ""}.` };
  return { ok: true, kind: entry.kind, mime: entry.mime };
}
