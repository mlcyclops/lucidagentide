// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/session_transfer.test.ts - P-SESSXFER.1 (ADR-0682): the offline history file and its gates. Pins: the same
// sessions and created_at give the same bytes; every byte is printable ASCII or LF; the home folder never leaves;
// a changed byte, CR line endings, an unknown key or a path-like id are refused; a scanner finding blocks a session
// on export and quarantines it on import; a dead scanner exports and imports nothing (fail-closed); an id already
// used by a different session is a conflict and is never overwritten; an identical session is skipped; and an
// imported session lists (marked imported) and reads back through listSessions and sessionMessages. The scanner
// is injected, as in kb_pack.test.ts.

import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTRACT_SYSTEM } from "../harness/personal/distiller.ts";
import type { GateDecision } from "../harness/security/gate.ts";
import { asciiJson, exportHistory, importHistory, ompSessionDirName, sha256, type ExportOptions, type HistoryFile } from "./session_transfer.ts";
import { handleSessionTransferRoutes } from "./session_transfer_routes.ts";
import { __resetSessionIndex, listSessions, sessionFilePath, sessionMessages } from "./sessions.ts";

const CLEAN: GateDecision = { block: false, reason: "clean", trustLabel: "trusted", findings: [], failClosed: false };
const cleanDecide = async (): Promise<GateDecision> => CLEAN;
const poisonDecide = async (t: string): Promise<GateDecision> => (/POISON/.test(t)
  ? { block: true, reason: "zero-width", trustLabel: "quarantined", findings: [{}], failClosed: false } as unknown as GateDecision
  : CLEAN);
const deadDecide = async (): Promise<GateDecision> => { throw new Error("sidecar dead"); };
const deadGateDecide = async (): Promise<GateDecision> => ({ block: true, reason: "fail-closed: scan unavailable (scanner not running)", trustLabel: "quarantined", findings: [], failClosed: true });

const AT = "2026-11-25T12:00:00.000Z";
const HOME = "C:\\Users\\alice";
const SRC = "/test/src-project";
const DST = "/test/dst-project";
const ln = (o: unknown): string => JSON.stringify(o);
const header = (id: string, cwd = SRC): string => ln({ type: "session", version: 3, id, timestamp: "2026-11-01T10:00:00.000Z", cwd });
const user = (text: string, ts = 1_793_000_000_000): string => ln({ type: "message", id: "u", parentId: null, timestamp: "2026-11-01T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text }], timestamp: ts } });
const reply = (text: string, extra: unknown[] = []): string => ln({ type: "message", message: { role: "assistant", provider: "anthropic", model: "claude-x", usage: { input: 1, output: 1 }, content: [{ type: "thinking", thinking: "plan it" }, { type: "text", text }, ...extra], timestamp: 1_793_000_001_000 } });
const toolResult = (text: string): string => ln({ type: "message", message: { role: "toolResult", toolCallId: "toolu_1", toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 1_793_000_002_000 } });
const readCall = { type: "toolCall", id: "toolu_1", name: "read", arguments: { path: `${HOME}\\proj\\a.ts` } };

let dirs: string[] = [];
function root(files: Record<string, string> = {}): string {
  const r = mkdtempSync(join(tmpdir(), "lucid-sessxfer-"));
  dirs.push(r);
  mkdirSync(join(r, "enc"), { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(r, "enc", name), content);
  return r;
}
const sources = (r: string, ids: string[]) => ids.map((id) => ({ id, content: readFileSync(sessionFilePath(id, r)!, "utf8") }));
const opts = (over: Partial<ExportOptions> = {}): ExportOptions => ({ createdAt: AT, appVersion: "9.9.9", project: "src-project", scope: { kind: "project" }, decide: cleanDecide, record: () => {}, home: HOME, platform: "win32", ...over });
const importOpts = (r: string, over: Partial<Parameters<typeof importHistory>[1]> = {}) => ({ cwd: DST, root: r, decide: cleanDecide, record: () => {}, now: () => AT, home: HOME, platform: "win32", ...over });

const SESSIONS = {
  "a.jsonl": [header("s-alpha"), user(`Read ${HOME}\\proj\\a.ts caf\u00e9 \u2713 bell\u0007 csi\u009b`), reply("Done reading.", [readCall]), toolResult(`contents of ${HOME}\\proj\\a.ts`)].join("\n"),
  "b.jsonl": [header("s-beta"), user("Second session"), reply("Second answer")].join("\n"),
};

beforeEach(() => {
  __resetSessionIndex();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

test("the same sessions and created_at give byte-identical, ASCII-only files", async () => {
  const r = root(SESSIONS);
  const one = await exportHistory(sources(r, ["s-beta", "s-alpha"]), opts());
  __resetSessionIndex();
  const two = await exportHistory(sources(r, ["s-alpha", "s-beta"]), opts());
  expect(one.ok).toBe(true);
  expect(one.file).toBe(two.file!);
  expect(sha256(one.file!)).toBe(sha256(two.file!));
  expect(/^[\x20-\x7e\n]*$/.test(one.file!)).toBe(true);
  expect(one.file!.endsWith("}\n")).toBe(true);
  expect(one.file).toContain("caf\\u00e9 \\u2713");
  expect(one.filename).toBe("src-project-2026-11-25.lucidhistory.json");
  const f = JSON.parse(one.file!) as HistoryFile;
  expect(f.format).toBe("lucid-history/1");
  expect(f.sessions.map((s) => s.id)).toEqual(["s-alpha", "s-beta"]);
  expect(f.manifest.content).toEqual(["text", "thinking", "tool_call", "tool_result", "timestamp", "model"]);
  expect(f.manifest.payload_sha256).toBe(sha256(asciiJson(f.sessions)));
});

test("the home folder, control characters and the absolute path never leave; tool calls and results are text", async () => {
  const r = root(SESSIONS);
  const { file } = await exportHistory(sources(r, ["s-alpha"]), opts({ marking: "UNCLASSIFIED" }));
  expect(file).not.toContain("alice");
  expect(file).not.toContain("Users");
  expect(file).not.toContain("\\u0007");
  expect(file).not.toContain("\\u009b");
  const s = (JSON.parse(file!) as HistoryFile).sessions[0]!;
  expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool_result"]);
  const call = s.messages[1]!.parts.find((p) => p.type === "tool_call");
  expect(call).toEqual({ type: "tool_call", id: "toolu_1", name: "read", arguments: JSON.stringify({ path: "~\\proj\\a.ts" }) });
  expect(s.messages[1]!.parts[0]).toEqual({ type: "thinking", text: "plan it" });
  expect(s.messages[2]!.parts[0]).toEqual({ type: "text", text: "contents of ~\\proj\\a.ts" });
  expect((JSON.parse(file!) as HistoryFile).manifest.marking).toBe("UNCLASSIFIED");
});

test("a marking outside one line of ASCII is refused", async () => {
  const r = root(SESSIONS);
  expect((await exportHistory(sources(r, ["s-beta"]), opts({ marking: "SECRET\nX" }))).stage).toBe("marking");
});

test("a project export leaves throwaway extraction sessions out", async () => {
  const r = root({ ...SESSIONS, "c.jsonl": [header("s-ingest"), user(`${EXTRACT_SYSTEM}\n\nlearn this`), reply("facts")].join("\n") });
  const res = await exportHistory(sources(r, ["s-alpha", "s-ingest"]), opts({ skipThrowaways: true }));
  expect(res.exported).toBe(1);
  expect(res.report.find((x) => x.id === "s-ingest")?.status).toBe("skipped");
});

test("a scanner finding blocks that session's export and is logged; a sub-threshold finding blocks too", async () => {
  const r = root({ ...SESSIONS, "p.jsonl": [header("s-poison"), user("POISON here"), reply("ok")].join("\n") });
  const blocks: string[] = [];
  const res = await exportHistory(sources(r, ["s-alpha", "s-poison"]), opts({ decide: poisonDecide, record: (b) => blocks.push(b.reason) }));
  expect(res.ok).toBe(true);
  expect(res.exported).toBe(1);
  expect(res.blocked).toBe(1);
  expect(res.file).not.toContain("POISON");
  expect(res.report.find((x) => x.id === "s-poison")?.status).toBe("blocked");
  expect(blocks.some((b) => b.includes("s-poison"))).toBe(true);
  const suspicious = async (): Promise<GateDecision> => ({ block: false, reason: "suspicious: 1 sub-threshold finding(s)", trustLabel: "suspicious", findings: [{}], failClosed: false } as unknown as GateDecision);
  const all = await exportHistory(sources(r, ["s-beta"]), opts({ decide: suspicious }));
  expect(all.ok).toBe(false);
  expect(all.stage).toBe("empty");
});

test("an unreachable scanner exports nothing (fail-closed), thrown or decided", async () => {
  const r = root(SESSIONS);
  for (const decide of [deadDecide, deadGateDecide]) {
    const res = await exportHistory(sources(r, ["s-beta"]), opts({ decide }));
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("scanner");
    expect(res.file).toBeUndefined();
  }
});

test("round trip: an import writes omp transcripts that list (marked imported) and read back", async () => {
  const a = root(SESSIONS);
  const { file } = await exportHistory(sources(a, ["s-alpha", "s-beta"]), opts());
  const b = root();
  const res = await importHistory(file!, importOpts(b));
  expect(res).toMatchObject({ ok: true, stage: "ok", imported: ["s-alpha", "s-beta"], skipped: [], conflicts: [], blocked: [], project: "src-project" });
  const p = sessionFilePath("s-beta", b)!;
  expect(p.startsWith(join(b, ompSessionDirName(DST, HOME)))).toBe(true);
  expect(p.endsWith("_s-beta.jsonl")).toBe(true);
  const list = await listSessions(DST, b);
  expect(list.sessions.map((s) => s.id).sort()).toEqual(["s-alpha", "s-beta"]);
  const beta = list.sessions.find((s) => s.id === "s-beta")!;
  expect(beta).toMatchObject({ title: "Second session", model: "anthropic/claude-x", turns: 1, imported: true });
  expect(sessionMessages("s-beta", 0, b).messages).toEqual([{ role: "user", text: "Second session", turn: 1 }, { role: "assistant", text: "Second answer" }]);
  expect(sessionMessages("s-alpha", 0, b).messages[0]!.text).toBe("Read ~\\proj\\a.ts caf\u00e9 \u2713 bell csi");
  const lines = readFileSync(sessionFilePath("s-alpha", b)!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines[0]).toMatchObject({ type: "session", id: "s-alpha", cwd: DST });
  expect(lines[1]).toMatchObject({ type: "custom", customType: "lucid-history-import", data: { trust: "untrusted", format: "lucid-history/1" } });
  expect(lines.find((l) => l.message?.role === "toolResult")?.message).toMatchObject({ toolCallId: "toolu_1", toolName: "read", isError: false });
});

test("re-importing is idempotent: an identical session is skipped, here or on the machine it came from", async () => {
  const a = root(SESSIONS);
  const { file } = await exportHistory(sources(a, ["s-alpha", "s-beta"]), opts());
  const b = root();
  await importHistory(file!, importOpts(b));
  const again = await importHistory(file!, importOpts(b));
  expect(again).toMatchObject({ ok: true, imported: [], skipped: ["s-alpha", "s-beta"], conflicts: [] });
  const home = await importHistory(file!, importOpts(a, { cwd: SRC }));
  expect(home).toMatchObject({ ok: true, imported: [], skipped: ["s-alpha", "s-beta"], conflicts: [] });
});

test("a different session with the same id is a conflict and is never overwritten", async () => {
  const a = root(SESSIONS);
  const { file } = await exportHistory(sources(a, ["s-beta"]), opts());
  const mine = [header("s-beta", DST), user("My own work"), reply("mine")].join("\n");
  const b = root({ "mine.jsonl": mine });
  const res = await importHistory(file!, importOpts(b));
  expect(res).toMatchObject({ ok: true, imported: [], conflicts: ["s-beta"] });
  expect(readFileSync(join(b, "enc", "mine.jsonl"), "utf8")).toBe(mine);
});

test("a changed byte, CR line endings, an unknown key or a path-like id are refused before anything is written", async () => {
  const a = root(SESSIONS);
  const { file } = await exportHistory(sources(a, ["s-alpha", "s-beta"]), opts());
  const b = root();
  const blocks: string[] = [];
  const tampered = await importHistory(file!.replace("Second answer", "Second answex"), importOpts(b, { record: (x) => blocks.push(x.findings ?? "") }));
  expect(tampered.stage).toBe("integrity");
  expect(blocks).toContain("integrity");
  expect((await importHistory(file!.replace(/\n/g, "\r\n"), importOpts(b))).stage).toBe("ascii");
  expect((await importHistory(file!.replace("Second answer", "Second \u00e4nswer"), importOpts(b))).stage).toBe("ascii");
  const extra = JSON.parse(file!) as HistoryFile & { manifest: { extra?: number } };
  extra.manifest.extra = 1;
  expect((await importHistory(`${asciiJson(extra, 2)}\n`, importOpts(b))).stage).toBe("format");
  const evil = JSON.parse(file!) as HistoryFile;
  evil.sessions[0]!.id = "..\\..\\evil";
  evil.manifest.sessions[0]!.id = "..\\..\\evil";
  expect((await importHistory(`${asciiJson(evil, 2)}\n`, importOpts(b))).stage).toBe("format");
  expect((await importHistory("{ not json", importOpts(b))).stage).toBe("parse");
  expect((await listSessions(DST, b)).sessions).toEqual([]);
});

test("a scanner finding quarantines that session on import and logs it; the rest import", async () => {
  const a = root({ ...SESSIONS, "p.jsonl": [header("s-poison"), user("POISON here"), reply("ok")].join("\n") });
  const { file } = await exportHistory(sources(a, ["s-beta", "s-poison"]), opts());
  const b = root();
  const blocks: { reason: string; sessionId?: string }[] = [];
  const res = await importHistory(file!, importOpts(b, { decide: poisonDecide, record: (x) => blocks.push(x) }));
  expect(res).toMatchObject({ ok: true, imported: ["s-beta"] });
  expect(res.blocked.map((x) => x.id)).toEqual(["s-poison"]);
  expect(blocks.find((x) => x.sessionId === "s-poison")?.reason).toContain("quarantined");
  expect(sessionFilePath("s-poison", b)).toBeNull();
});

test("an unreachable scanner imports nothing (fail-closed)", async () => {
  const a = root(SESSIONS);
  const { file } = await exportHistory(sources(a, ["s-alpha", "s-beta"]), opts());
  const b = root();
  for (const decide of [deadDecide, deadGateDecide]) {
    const res = await importHistory(file!, importOpts(b, { decide }));
    expect(res).toMatchObject({ ok: false, stage: "scanner", imported: [] });
  }
  expect((await listSessions(DST, b)).sessions).toEqual([]);
});

test("images: off by default (an omitted part), allowlisted and carried when included", async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]).toString("base64");
  const withImage = [header("s-img"), ln({ type: "message", message: { role: "user", content: [{ type: "text", text: "see this" }, { type: "image", mimeType: "image/png", data: png }, { type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" }], timestamp: 1_793_000_000_000 } }), reply("seen")].join("\n");
  const a = root({ "i.jsonl": withImage });
  const off = JSON.parse((await exportHistory(sources(a, ["s-img"]), opts())).file!) as HistoryFile;
  expect(off.sessions[0]!.messages[0]!.parts.slice(1)).toEqual([{ type: "omitted", what: "image" }, { type: "omitted", what: "image" }]);
  const onRes = await exportHistory(sources(a, ["s-img"]), opts({ includeImages: true }));
  const on = JSON.parse(onRes.file!) as HistoryFile;
  expect(on.manifest.content).toContain("image");
  expect(on.sessions[0]!.messages[0]!.parts.slice(1)).toEqual([{ type: "image", mime: "image/png", data: png }, { type: "omitted", what: "image" }]);
  const b = root();
  expect((await importHistory(onRes.file!, importOpts(b))).imported).toEqual(["s-img"]);
});

test("routes: only the UI header token opens them; export and import work end to end; other paths pass through", async () => {
  const a = root(SESSIONS);
  const b = root();
  const UI = "ui-token-for-the-test";
  const ctx = (r: string, cwd: string) => ({ uiToken: UI, lanes: () => [], laneSessionIds: () => [], root: r, cwd: () => cwd, decide: cleanDecide, now: () => AT });
  const req = (path: string, body?: unknown, headers: Record<string, string> = { "x-lucid-token": UI }, method = "POST") =>
    new Request(`http://127.0.0.1:1${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const EXPORT = "/api/sessions/export";
  expect((await handleSessionTransferRoutes(req(EXPORT, { scope: { kind: "project" } }, {}), EXPORT, ctx(a, SRC)))!.status).toBe(403);
  expect((await handleSessionTransferRoutes(req(EXPORT, { scope: { kind: "project" } }, { "x-lucid-token": "agent-token" }), EXPORT, ctx(a, SRC)))!.status).toBe(403);
  expect((await handleSessionTransferRoutes(new Request(`http://127.0.0.1:1${EXPORT}?t=${UI}`, { method: "POST", body: "{}" }), EXPORT, ctx(a, SRC)))!.status).toBe(403);
  expect((await handleSessionTransferRoutes(req(EXPORT, undefined, { "x-lucid-token": UI }, "GET"), EXPORT, ctx(a, SRC)))!.status).toBe(405);
  expect((await handleSessionTransferRoutes(req(EXPORT, { scope: { kind: "nope" } }), EXPORT, ctx(a, SRC)))!.status).toBe(400);
  expect(await handleSessionTransferRoutes(req("/api/sessions", {}), "/api/sessions", ctx(a, SRC))).toBeNull();
  const info = await (await handleSessionTransferRoutes(req("/api/sessions/transfer", undefined, { "x-lucid-token": UI }, "GET"), "/api/sessions/transfer", ctx(a, SRC)))!.json();
  expect(info.data).toEqual({ project: "src-project", sessions: 2, lanes: [] });
  const ex = await (await handleSessionTransferRoutes(req(EXPORT, { scope: { kind: "project" }, marking: "UNCLASSIFIED" }), EXPORT, ctx(a, SRC)))!.json();
  expect(ex.data).toMatchObject({ ok: true, exported: 2, filename: "src-project-2026-11-25.lucidhistory.json" });
  const im = await (await handleSessionTransferRoutes(req("/api/sessions/import", { file: ex.data.file }), "/api/sessions/import", ctx(b, DST)))!.json();
  expect(im.data).toMatchObject({ ok: true, imported: ["s-alpha", "s-beta"], marking: "UNCLASSIFIED" });
});

test("dev.ts chains the routes and never lists them among the agent or query-token routes", () => {
  const src = readFileSync(join(import.meta.dir, "dev.ts"), "utf8");
  const aStart = src.indexOf("const AGENT_ROUTES");
  const lists = src.slice(src.indexOf("const QUERY_TOKEN_ROUTES"), src.indexOf("\n", aStart));
  expect(lists.length).toBeGreaterThan(100);
  for (const r of ["/api/sessions/transfer", "/api/sessions/export", "/api/sessions/import"]) expect(lists).not.toContain(r);
  expect(src).toContain("handleSessionTransferRoutes(req, p, {");
});

test("omp's session folder naming: home-relative, temp-relative, else the absolute path", () => {
  expect(ompSessionDirName(join(HOME, "code", "app"), HOME, "/nowhere-tmp")).toBe("-code-app");
  expect(ompSessionDirName(HOME, HOME, "/nowhere-tmp")).toBe("-");
  expect(ompSessionDirName(join(tmpdir(), "x", "y"), "/nowhere-home", tmpdir())).toBe("-tmp-x-y");
});
