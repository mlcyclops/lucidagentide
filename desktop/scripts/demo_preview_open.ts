// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_preview_open.ts - P-PREVIEW.11 (ADR-0308): the agent's `preview_open` tool opens the
// Preview panel again.
//
// THE FIELD BUG this proves fixed: preview_open returned its ack, no panel appeared, and every following
// preview_inspect timed out with "no preview is open". The workspace lives in a OneDrive path with spaces,
// which made encoding the obvious suspect - and it was innocent: /api/preview/serve returns the file for
// that exact space-bearing, dot-dir path. The real chain ran through omp:
//
//   sdk.ts            intent tracing injects an `i` field into EVERY tool schema
//   agent-session.ts  that argument rides the tool-start event as `intent`
//   acp-event-mapper  buildToolTitle returns the INTENT when present, shadowing "preview_open: <path>"
//   acp_backend.ts    matched /\bpreview_open\b/ against that title -> no match -> no preview-available
//
// and buildToolCallStartUpdate carries no tool-name field at all, so the tool was unidentifiable from the
// stream. So preview_open now REPORTS ITSELF over its own token'd channel, exactly like
// preview_screenshot / preview_inspect / preview_act already did.
//
// This demo runs the REAL extension against a REAL local server standing in for the desktop, so the whole
// reporting path executes: registration -> execute() -> POST -> {path} received.
//
// Run with: bun run desktop/scripts/demo_preview_open.ts

import previewExtension from "../../harness/omp/preview_extension.ts";
import { previewOpenPath } from "../preview_resolve.ts";

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) { console.log(`  \u2713 ${msg}`); return; }
  console.log(`  \u2717 ${msg}`);
  failures++;
}

interface CapturedTool { name: string; execute: (id: string, params: { path?: string }) => Promise<{ isError?: boolean; content: { text: string }[] }> }

function registerTools(): CapturedTool[] {
  const tools: CapturedTool[] = [];
  previewExtension({ registerTool: (t: CapturedTool) => tools.push(t) });
  return tools;
}

console.log("== #ADR-0308 P-PREVIEW.11: preview_open reports itself ==\n");

const received: { path: string }[] = [];
const desktop = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/preview/open" && req.method === "POST") {
      const body = await req.json().catch(() => null) as { path?: unknown } | null;
      if (typeof body?.path === "string") received.push({ path: body.path });
      return Response.json({ ok: true, data: { opened: received.length > 0 } });
    }
    return new Response("not found", { status: 404 });
  },
});

const prevUrl = process.env.LUCID_PREVIEW_OPEN_URL;
try {
  // A path shaped like the real one that failed in the field: OneDrive, spaces, a dot-dir.
  const target = "C:/Users/n/OneDrive/Desktop/Apps AI Vibe/proj/.omp/tmp/hardening.html";

  console.log("[1] the OLD detection is genuinely dead under intent tracing (why this increment exists)");
  const ri = { path: target, i: "Opening rendered deck in preview" };
  assert(previewOpenPath("Opening rendered deck in preview", ri) === null,
    "an intent-shadowed ACP title does NOT identify the call - the panel never opened, and no amount of path encoding would have helped");
  assert(previewOpenPath(`preview_open: ${target}`, ri) === target,
    "the name-based title still resolves, so the fallback stays useful when intent tracing is off");

  console.log("\n[2] the tool now reports itself to the desktop over its own channel");
  process.env.LUCID_PREVIEW_OPEN_URL = `http://127.0.0.1:${desktop.port}/api/preview/open?t=demo`;
  const tools = registerTools();
  const open = tools.find((t) => t.name === "preview_open");
  assert(!!open, "preview_open registered against a bare pi (no typebox shim): registration never throws");
  const res = await open!.execute("call-1", { path: target });
  assert(res.isError !== true, "execute succeeded");
  assert(res.content[0]!.text.includes("hardening.html"), "the agent still gets a human ack naming the file");
  assert(received.length === 1, "the desktop received exactly ONE open request");
  assert(received[0]!.path === target,
    "the path arrived VERBATIM - spaces, the dot-dir, and the drive letter all intact (no encoding round-trip to get wrong)");

  console.log("\n[3] the channel is best-effort: a desktop that cannot be reached never fails the tool");
  process.env.LUCID_PREVIEW_OPEN_URL = "http://127.0.0.1:1/api/preview/open?t=demo"; // nothing listens on port 1
  const unreachable = await registerTools().find((t) => t.name === "preview_open")!.execute("call-2", { path: target });
  assert(unreachable.isError !== true, "an unreachable desktop degrades to the previous behavior instead of erroring the call");

  console.log("\n[4] an older desktop (no channel published) is still fine");
  delete process.env.LUCID_PREVIEW_OPEN_URL;
  const before = received.length;
  const noChannel = await registerTools().find((t) => t.name === "preview_open")!.execute("call-3", { path: target });
  assert(noChannel.isError !== true, "no LUCID_PREVIEW_OPEN_URL: the tool still answers");
  assert(received.length === before, "and it reports nothing, rather than guessing at an endpoint");

  console.log("\n[5] a target the gate refuses is never reported at all");
  process.env.LUCID_PREVIEW_OPEN_URL = `http://127.0.0.1:${desktop.port}/api/preview/open?t=demo`;
  const mark = received.length;
  const remote = await registerTools().find((t) => t.name === "preview_open")!.execute("call-4", { path: "https://example.com/app.html" });
  assert(remote.isError === true, "a remote URL is rejected by the tool");
  assert(received.length === mark, "and the desktop is never asked to open it (fail-closed before the channel)");
} finally {
  desktop.stop(true);
  if (prevUrl === undefined) delete process.env.LUCID_PREVIEW_OPEN_URL; else process.env.LUCID_PREVIEW_OPEN_URL = prevUrl;
}

if (failures > 0) {
  console.log(`\n\u2717 P-PREVIEW.11 demo FAILED (${failures} check${failures === 1 ? "" : "s"}).`);
  process.exit(1);
}
console.log("\n\u2713 P-PREVIEW.11 demo passed - preview_open drives the panel from its own call, so an intent-shadowed ACP title can no longer silently swallow the preview.");
