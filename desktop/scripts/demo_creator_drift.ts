// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// demo-CREATOR-DRIFT (ADR-0430): CutWire Drift as a Creator provider, proven against a FAKE Drift that speaks
// the real wire format (Drift's src/mcp/McpHttp.cpp + McpProtocol.cpp: `GET /health` without auth, bearer-token
// JSON-RPC 2.0 on `POST /mcp`, tool results as `{content:[{type:"text",text:<json>}], isError}`), so the proof
// needs no Drift install, no window, and no GPU.
//
//   [1] discovery: the session file Drift writes is found through DRIFT_MCP_SESSION_PATH, parsed, and turned
//       into an on-device declaration whose status block NEVER carries the token
//   [2] the probe is honest: not-installed, "installed but Agent access is off" with the enable steps,
//       unauthorized on a bad token (token never echoed), ready with the version and the attested set
//   [3] the CUI op policy: cloud voices, the marketplace and ElevenLabs transcription are refused BY NAME,
//       recursively inside apply({ops}) with the failing index, while local ops pass; unlocked, nothing is refused
//   [4] apply is one batch: the client reports done / stopped / failed exactly as Drift does
//   [5] the library gate: an export is admitted by its MAGIC BYTES (MP4, WebM, GIF), never by its extension
//
// Run with: bun run desktop/scripts/demo_creator_drift.ts   (make demo-CREATOR-DRIFT)

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driftOpPolicy, isDriftReadTool, isDriftMutation, summarizeDriftCall } from "../../harness/creator/drift_policy.ts";
import {
  DriftClient, DriftActivityLog, driftSessionEndpointDef, driftSessionPath, driftSessionStatus, parseDriftSession, planDriftLibraryImport,
} from "../creator_drift.ts";
import { probeProvider, type ProbeDeps } from "../creator_probe.ts";
import { cuiProviderVerdict } from "../cui_policy.ts";
import { creatorSpec } from "../creator_registry.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ok " : "  FAIL"} ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

// ── a fake Drift: the real framing, a tiny project ───────────────────────────
const TOKEN = "f4k3t0k3n-never-printed-0123456789abcdef";
let revision = 0;
const applied: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") return Response.json({ ok: true });
    if (url.pathname !== "/mcp") return new Response("not found\n", { status: 404 });
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${TOKEN}`) return Response.json({ error: "unauthorized" }, { status: 401 });
    const body = (await req.json()) as { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result });
    const text = (payload: unknown, isError = false) => reply({ content: [{ type: "text", text: JSON.stringify(payload) }], isError });
    if (body.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "drift", version: "0.7.0-fake" }, instructions: "fake" });
    if (body.method !== "tools/call") return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: `Unknown method: ${body.method}` } });
    const name = body.params?.name ?? "";
    const args = body.params?.arguments ?? {};
    if (name === "market_status") return text({ ok: true, configured: false, consented: false });
    if (name === "inspect") return text({ ok: true, name: "Fake cut", w: 640, h: 360, fps: 30, dur: 5, clips: applied.length, tracks: [{ i: 0, type: "video", clips: applied.length }], revision, selection: null });
    if (name === "apply") {
      const ops = Array.isArray(args.ops) ? (args.ops as { tool: string; args?: Record<string, unknown> }[]) : [];
      const done: unknown[] = [];
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i]!;
        if (op.tool === "set_keyframe" && op.args?.clip === "missing") {
          return text({ ok: false, error: "apply_failed", stopped: i, tool: op.tool, failed: { ok: false, error: "not_found", detail: "clip missing not found" }, done }, true);
        }
        revision++; applied.push(op.tool);
        done.push({ tool: op.tool, result: { ok: true, id: `clip-${revision}` } });
      }
      return text({ ok: true, n: done.length, done, revision });
    }
    if (name === "capture") return reply({ content: [{ type: "text", text: JSON.stringify({ ok: true, at: args.at ?? 0, w: 640, h: 360 }) }, { type: "image", mimeType: "image/jpeg", data: "/9j/4AAQ" }], isError: false });
    return text({ ok: false, error: "unknown_op", detail: `${name} is not an op in this fake` }, true);
  },
});
const base = `http://127.0.0.1:${server.port}`;

const dir = mkdtempSync(join(tmpdir(), "lucid-drift-demo-"));
try {
  console.log("\n[1] discovery through the session file Drift writes");
  const sessionFile = join(dir, "mcp-session.json");
  writeFileSync(sessionFile, JSON.stringify({ pid: 4242, port: server.port, token: TOKEN, url: `${base}/mcp` }) + "\n");
  const env = { DRIFT_MCP_SESSION_PATH: sessionFile };
  check("DRIFT_MCP_SESSION_PATH overrides the platform default", driftSessionPath(env, "win32", "C:/Users/me") === sessionFile);
  check("the Windows default is <profile>/drift/mcp-session.json (Qt RuntimeLocation)", driftSessionPath({}, "win32", "C:/Users/me") === "C:/Users/me/drift/mcp-session.json");
  const session = parseDriftSession(await Bun.file(sessionFile).text());
  check("the session parses", !!session && session.port === server.port);
  check("a torn or incomplete file reads as no session", parseDriftSession('{"port":4731}') === null && parseDriftSession("{not json") === null);
  const ep = driftSessionEndpointDef(session!);
  const statusBlock = driftSessionStatus({ path: sessionFile, session, error: "" });
  check("the status block carries port/pid/path and never the token", statusBlock.present && statusBlock.port === server.port && !JSON.stringify({ ep, statusBlock }).includes(TOKEN));
  check("a loopback session endpoint is on-device and allowed under the lockdown", cuiProviderVerdict(true, creatorSpec("drift"), ep).allowed);

  console.log("\n[2] the probe says what it proved, and nothing more");
  const deps = (over: Partial<ProbeDeps>): ProbeDeps => ({
    fetchImpl: fetch, exec: () => "", exists: () => false, now: () => Date.now(), secret: () => "", timeoutMs: 4000, platform: "win32", env: {},
    driftSession: () => ({ path: sessionFile, session, error: "" }), ...over,
  });
  const absent = await probeProvider(deps({ driftSession: () => ({ path: sessionFile, session: null, error: "ENOENT" }) }), "drift", []);
  check("no exe, no session: not-installed", absent.state === "not-installed", absent.detail.slice(0, 80));
  const off = await probeProvider(deps({ exists: (p) => p === "C:\\Program Files\\Drift\\drift.exe", driftSession: () => ({ path: sessionFile, session: null, error: "ENOENT" }) }), "drift", []);
  check("exe on disk, no session: unreachable WITH the enable steps", off.state === "unreachable" && off.detail.includes("Agent access"), off.detail.slice(0, 90));
  const bad = await probeProvider(deps({ driftSession: () => ({ path: sessionFile, session: { ...session!, token: "wrong" }, error: "" }) }), "drift", []);
  check("a refused token is unauthorized and the token is not echoed", bad.state === "unauthorized" && !JSON.stringify(bad).includes("wrong"), bad.detail.slice(0, 90));
  const ready = await probeProvider(deps({}), "drift", [ep]);
  check("initialize ok: ready, versioned, attesting video-edit/motion/transcript-edit (no stock-media: market not configured)",
    ready.state === "ready" && ready.version === "0.7.0-fake" && ready.attested.join(",") === "video-edit,motion,transcript-edit", ready.detail.slice(0, 100));
  check("the probe never printed the token", !JSON.stringify(ready).includes(TOKEN));

  console.log("\n[3] the CUI op policy refuses egress by name, recursively");
  const locked = true;
  check("tts_generate refused (cloud voice)", !driftOpPolicy("tts_generate", { text: "hi" }, locked).allowed);
  check("market_search refused (marketplace)", !driftOpPolicy("market_search", { q: "sunset" }, locked).allowed);
  check("transcribe engine:elevenlabs refused", !driftOpPolicy("transcribe", { clip: "a", engine: "elevenlabs" }, locked).allowed);
  check("transcribe local allowed", driftOpPolicy("transcribe", { clip: "a", engine: "local" }, locked).allowed);
  const nested = driftOpPolicy("apply", { ops: [{ tool: "seek", args: { at: 0 } }, { tool: "sfx_generate", args: { prompt: "boom" } }] }, locked);
  check("apply with a nested cloud op is refused naming op 1", !nested.allowed && nested.index === 1 && nested.tool === "sfx_generate", nested.allowed ? "" : nested.reason.slice(0, 80));
  check("unlocked, the same batch is allowed", driftOpPolicy("apply", { ops: [{ tool: "sfx_generate", args: {} }] }, false).allowed);
  check("read classification: inspect/list_*/get_* read, apply/undo/export_video/import_media not",
    isDriftReadTool("inspect") && isDriftReadTool("list_effects") && isDriftReadTool("get_transcript") && !isDriftReadTool("apply") && !isDriftReadTool("undo") && !isDriftReadTool("export_video") && !isDriftReadTool("import_media"));
  check("mutation classification: set_volume is a clip edit, select_clip is not", isDriftMutation("set_volume") && !isDriftMutation("select_clip"));

  console.log("\n[4] apply is one batch, reported exactly as Drift reports it");
  const client = new DriftClient({ baseUrl: base, token: TOKEN });
  const init = await client.initialize();
  check("initialize names the server version", init.ok && init.version === "0.7.0-fake");
  const okBatch = await client.call("apply", { ops: [{ tool: "add_text", args: { text: "hi" } }, { tool: "set_duration", args: { clip: "clip-1", duration: 3 } }] });
  const okPayload = okBatch.payload as { n?: number; revision?: number };
  check("a clean batch applies every op and bumps the revision", okBatch.ok && okPayload.n === 2 && okPayload.revision === 2);
  const badBatch = await client.call("apply", { ops: [{ tool: "add_text", args: { text: "x" } }, { tool: "set_keyframe", args: { clip: "missing", prop: "opacity" } }] });
  const badPayload = badBatch.payload as { error?: string; stopped?: number; done?: unknown[] };
  check("a failing op stops the batch: isError, apply_failed, stopped index, done lists only what ran",
    !badBatch.ok && badBatch.isError && badPayload.error === "apply_failed" && badPayload.stopped === 1 && badPayload.done?.length === 1, badBatch.error);
  const shot = await client.call("capture", { at: 1.5 });
  check("capture returns the text block plus the image block", shot.ok && shot.images.length === 1 && shot.images[0]!.mimeType === "image/jpeg");
  const unauthorized = await new DriftClient({ baseUrl: base, token: "nope" }).call("inspect");
  check("a wrong token is a refusal, not a payload", !unauthorized.ok && unauthorized.status === 401 && unauthorized.payload === null);
  const log = new DriftActivityLog();
  log.push({ at: 1, source: "agent", tool: "apply", ok: true, summary: summarizeDriftCall("apply", { ops: [{ tool: "add_text" }] }, okBatch.payload, false), undoable: isDriftMutation("apply"), revision: 2 });
  log.push({ at: 2, source: "ui", tool: "inspect", ok: true, summary: summarizeDriftCall("inspect", {}, { revision: 2 }, false), undoable: false, revision: 2 });
  check("the feed is newest-first and incremental since(seq) is ascending", log.latest()[0]!.tool === "inspect" && log.since(1).map((e) => e.seq).join(",") === "2");

  console.log("\n[5] the library admits an export by its bytes, never its extension");
  const mp4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2, 3, 4]);
  const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2]);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  check("ftyp bytes -> video/mp4", (() => { const r = planDriftLibraryImport("C:\\out\\cut.mp4", mp4); return r.ok && r.kind === "video" && r.mime === "video/mp4"; })());
  check("EBML bytes named .mp4 -> video/webm (the bytes win)", (() => { const r = planDriftLibraryImport("C:\\out\\cut.mp4", webm); return r.ok && r.mime === "video/webm"; })());
  check("GIF89a -> gif", (() => { const r = planDriftLibraryImport("/out/loop.gif", gif); return r.ok && r.kind === "gif"; })());
  check("a PNG named .mp4 is refused by name", (() => { const r = planDriftLibraryImport("C:\\out\\cut.mp4", png); return !r.ok && r.error.includes("image/png"); })());
  check("an empty file is refused (export not finished)", !planDriftLibraryImport("C:\\out\\cut.mp4", new Uint8Array()).ok);
  check("a relative path is refused", !planDriftLibraryImport("out/cut.mp4", mp4).ok);
} finally {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
