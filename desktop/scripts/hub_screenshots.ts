// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// docs/tui screenshot source: drives the REAL HubComponent against an in-process fixture engine
// through every view, and writes each frame as a styled HTML page under /tmp/hub-shots. A headless
// browser then screenshots those pages into docs/tui/*.png (see the PR that introduced them).
// Fixtures, not a live model: the frames must be reproducible byte-for-byte for future re-captures.
//
// Run with: bun run desktop/scripts/hub_screenshots.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { HubComponent } from "../../harness/launcher/hub_tui.ts";

const OUT = "/tmp/hub-shots";
const W = 120, ROWS = 34;

// ---- fixture engine ----------------------------------------------------------------------------

const lanes = [
  { id: "lane-1", name: "lucidagentide", model: "spark/glm-5.3-flash", status: "working", turns: 2 },
  { id: "lane-2", name: "docs-refactor", model: "claude-haiku-4-5", status: "awaiting-input", turns: 5 },
];
const askLane = { id: "lane-3", name: "release-prep", model: "claude-opus-4-8", status: "needs-approval", turns: 1, pendingApproval: { summary: "$ make test && git push origin release", kind: "execute" } };

const fixtures: Record<string, unknown> = {
  "/api/build-info": { productName: "LucidAgentIDE", version: "2.3.0", flavor: "agent", port: 5319 },
  "/api/security": { live: { quarantined: [
    { id: "b1", tool: "kb_pack_import", severity: "high", findings: "zero-width×2 · signature", at: "2026-09-29T14:02:11Z" },
    { id: "b2", tool: "write", severity: "high", findings: "bidi-override", at: "2026-09-29T14:05:40Z" },
    { id: "b3", tool: "bash", severity: "medium", findings: "homoglyph", at: "2026-09-29T14:11:02Z" },
  ], dismissed: [] } },
  "/api/fleet/status": { lanes: [...lanes, askLane] },
  "/api/sessions": { sessions: [
    { id: "s1", title: "I want to reimagine this app and all its capabilities for a TUI", turns: 251, updatedAt: Date.now() - 60_000 },
    { id: "s2", title: "add the lucid plugin for neovim to my configuration", turns: 92, updatedAt: Date.now() - 3 * 86_400_000 },
    { id: "s3", title: "implement the ability to connect to an instance of herdr", turns: 592, updatedAt: Date.now() - 6 * 86_400_000 },
  ] },
  "/api/audit": { events: [
    { at: "2026-09-29T14:11:02Z", category: "approval", type: "tool_block", decision: "block" },
    { at: "2026-09-29T14:12:20Z", category: "network", type: "subprocess_connect", decision: "allow" },
    { at: "2026-09-29T14:14:05Z", category: "approval", type: "sandbox_mode", decision: "allow" },
  ] },
  "/api/usage": { models: [
    { model: "claude-fable-5", cost: { total: 1335.99 }, tokens: { total: 763_100_000 }, turns: 3967, cacheHitRate: 0.97 },
    { model: "claude-opus-4-8", cost: { total: 1176.8 }, tokens: { total: 1_520_200_000 }, turns: 4937, cacheHitRate: 0.98 },
    { model: "spark/glm-5.3-flash", cost: { total: 27.34 }, tokens: { total: 186_400_000 }, turns: 1250, cacheHitRate: 0 },
  ], totals: { cost: 2540.13, tokens: 2_469_700_000, turns: 10_154 } },
  "/api/whitelist": [{ id: "wl_1", kind: "domain", pattern: "glm-box.tailnet.ts.net", zone: "internal", scope: "always" }],
  "/api/whitelist/posture": { allowAll: true, allowWebSearch: true, managedLocked: false },
  "/api/config": [{ id: "model", value: "spark/glm-5.3-flash", options: [
    { value: "claude-fable-5", name: "Claude Fable 5" },
    { value: "claude-opus-4-8", name: "Claude Opus 4.8" },
    { value: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    { value: "spark/glm-5.3-flash", name: "GLM 5.3 Flash (Spark · LAN)" },
    { value: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
  ] }],
  "/api/kb/list": { kgs: [
    { kg_id: "kg1", name: "My Knowledge", source_kind: "manual", provenance: "default" },
    { kg_id: "kg2", name: "LUCID Research", source_kind: "chat", provenance: "ChatGPT export 2026-07" },
    { kg_id: "kg3", name: "Sec Playbooks", source_kind: "pack", provenance: "TL-187 pack", read_only: true },
  ], activeId: "kg2" },
  "/api/kb/graph": { kgId: "kg2", totalPages: 4, totalLinks: 4, pages: [
    { page_id: "p1", title: "Fail-closed scanning law", slug: "law", degree: 3, trust_label: "trusted" },
    { page_id: "p2", title: "Prompt prefix freezing", slug: "prefix", degree: 2, trust_label: "trusted" },
    { page_id: "p3", title: "Pasted vendor advice", slug: "vendor", degree: 1, trust_label: "untrusted" },
    { page_id: "p4", title: "Poisoned sample", slug: "poison", degree: 0, trust_label: "quarantined" },
  ], links: [
    { from_page_id: "p1", to_page_id: "p2" }, { from_page_id: "p1", to_page_id: "p3" },
    { from_page_id: "p1", to_page_id: "p4" }, { from_page_id: "p2", to_page_id: "p3" },
  ] },
  "/api/kb/page": { title: "Fail-closed scanning law", kind: "note", trust_label: "trusted", classification: "", updated_at: "2026-09-12T10:00:00Z",
    body_md: "Any failure to obtain a valid scan result - sidecar dead, malformed response, timeout,\nmissing id - MUST be treated as block / quarantine, never safe.\n\nNo code path may treat scan-unavailable as pass. There is a test that kills the sidecar\nmid-run and asserts the gate blocks; it stays green forever." },
  "/api/fleet/transcript": { turns: [
    { role: "user", text: "what does the fail-closed law require when the scanner dies mid-run?" },
    { role: "assistant", text: "[ran: knowledge_search]\nBlock. Scanner unavailable is treated as quarantine, never safe - the mid-run kill test pins it." },
  ] },
};

const srv = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/api/health") return Response.json({ ok: true, nonce: "shot-nonce" });
    if (p === "/api/fleet/watch") {
      const evs = [
        { type: "status", status: "working" },
        { type: "thinking", text: "The operator asks about the fail-closed law. The KG page pins the rule; knowledge_search grounds the answer before any claim. " },
        { type: "tool", name: "knowledge_search" },
        { type: "token", text: "Block. Scanner unavailable is treated as quarantine, never safe" },
      ].map((e) => JSON.stringify(e) + "\n");
      return new Response(new ReadableStream({ start(c) { for (const e of evs) c.enqueue(new TextEncoder().encode(e)); } }));
    }
    if (p in fixtures) return Response.json({ ok: true, data: fixtures[p] });
    return Response.json({ ok: true, data: {} });
  },
});

// ---- ANSI (chalk truecolor subset) -> HTML -----------------------------------------------------

function ansiToHtml(frame: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let fg = "", bold = false, inverse = false;
  const spanFor = (text: string) => {
    if (!text) return "";
    const color = fg || "#edeff6";
    const style = inverse
      ? `background:${color};color:#0a0b0f;${bold ? "font-weight:700;" : ""}`
      : `color:${color};${bold ? "font-weight:700;" : ""}`;
    return `<span style="${style}">${esc(text)}</span>`;
  };
  let out = "", buf = "", i = 0;
  while (i < frame.length) {
    const m = /^\x1b\[([0-9;]*)m/.exec(frame.slice(i));
    if (m) {
      out += spanFor(buf); buf = "";
      const parts = m[1]!.split(";").map(Number);
      for (let j = 0; j < parts.length; j++) {
        const c = parts[j]!;
        if (c === 0) { fg = ""; bold = false; inverse = false; }
        else if (c === 1) bold = true;
        else if (c === 22) bold = false;
        else if (c === 7) inverse = true;
        else if (c === 27) inverse = false;
        else if (c === 39) fg = "";
        else if (c === 38 && parts[j + 1] === 2) { fg = `rgb(${parts[j + 2]},${parts[j + 3]},${parts[j + 4]})`; j += 4; }
      }
      i += m[0].length;
    } else { buf += frame[i]; i++; }
  }
  out += spanFor(buf);
  return out;
}

function page(title: string, rows: readonly string[]): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="margin:0;background:#0a0b0f;padding:18px;">
<pre id="term" style="margin:0;font:13px/1.35 'SF Mono','JetBrains Mono',Menlo,monospace;background:#0a0b0f;">${rows.map(ansiToHtml).join("\n")}</pre>`;
}

// ---- drive the hub through every view ----------------------------------------------------------

mkdirSync(OUT, { recursive: true });
const ui = { requestRender() { /* frames are pulled explicitly */ }, terminal: { rows: ROWS } };
const engine = { v: 1 as const, pid: 1, port: srv.port!, nonce: "shot-nonce", token: "shot-token", version: "2.3.0", flavor: "agent", startedAt: new Date().toISOString() };
const hub = new HubComponent(ui, engine, { spawned: true });
await hub.refresh();

const sleep = (ms: number) => { const { promise, resolve } = Promise.withResolvers<void>(); setTimeout(resolve, ms); return promise; };
const keys = (s: string[]) => { for (const k of s) hub.handleInput(k); };
const shot = (name: string, title: string) => writeFileSync(`${OUT}/${name}.html`, page(title, hub.render(W)));

shot("01-overview", "Overview");
keys(["2"]); shot("02-security", "Security");
keys(["3"]); shot("03-fleet", "Fleet");
keys(["|", "\t", "2"]); shot("04-split", "Split panes");   // fleet | security, right focused
keys(["x"]);                                                // back to one pane (fleet remains)
keys(["3", "\r"]);                                          // open lane-1 as the agent pane
await hub.refresh(); await sleep(500);                      // the watch stream delivers thinking/tool/tokens
shot("05-agent-live", "Agent pane, streaming");
keys(["3", "j", "j", "\r"]);                                // fleet again, select lane-3 (parked ask), open it
await hub.refresh();
shot("06-agent-ask", "Agent pane, parked approval");
keys(["m"]);                                                // model picker over the agent pane
shot("07-model-picker", "Model picker");
keys(["\u001b", "4"]); shot("08-sessions", "Sessions");
keys(["5"]); shot("09-audit", "Audit");
keys(["6"]); shot("10-usage", "Usage");
keys(["7"]); shot("11-network", "Network");
keys(["8"]); await hub.refresh(); shot("12-knowledge", "Knowledge graph");
keys(["/"]); keys([..."prefix"]); shot("13-kg-filter", "Knowledge filter");
keys(["\u001b"]);                                           // close the filter composer (filter cleared)
keys(["\r"]); await sleep(300); shot("14-kg-reader", "Knowledge page reader");
keys(["\u001b", "?"]); shot("15-help", "Help overlay");
keys(["\u001b"]);
hub.dispose(); srv.stop(true);
console.log(`frames written to ${OUT}`);
