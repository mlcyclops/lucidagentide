// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_sandbox_15.ts
//
// P-SANDBOX.15 (ADR-0396): the agent no longer holds the engine's UI token. Three leaks, one fix each:
//   1. every LUCID_*_URL the omp child inherited carried the UI token, which the engine accepts in a header on
//      EVERY route; the child now gets its own AGENT token, accepted only on the routes it calls;
//   2. the child inherited LUCID_MAIN_TOKEN itself (the Electron main's copy); dev.ts now deletes it from
//      process.env before any child is spawned;
//   3. `GET /` needs no token and carried it in a <meta> tag any local process could read; under Electron the
//      renderer now gets it from main over IPC, and the HTML carries none.
//
// Run: bun run harness/scripts/demo_p_sandbox_15.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { apiAuthorized, isEngineDocument } from "../../desktop/origin_guard.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`  ok  ${m}`); };
const ROOT = join(import.meta.dir, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

console.log("== #ADR-0396 P-SANDBOX.15: the agent gets its own, narrower token ==\n");

const UI = "u".repeat(64), AGENT = "a".repeat(64);
const queryRoutes = new Set(["/api/preview/serve", "/api/sandbox/grant", "/api/interject/pending"]);
const agentRoutes = new Set(["/api/sandbox/grant", "/api/interject/pending"]);
const ask = (path: string, header: string | null, query: string | null = null) =>
  apiAuthorized({ path, headerToken: header, queryToken: query, uiToken: UI, agentToken: AGENT, queryRoutes, agentRoutes });

console.log("[1] the agent token opens only what the agent calls");
ok(ask("/api/sandbox/grant", null, AGENT) && ask("/api/interject/pending", AGENT), "agent routes accept it (header or ?t=)");
ok(!ask("/api/security/approve", AGENT) && !ask("/api/security/sandbox/mode", AGENT) && !ask("/api/security/sandbox-grant/add", AGENT), "approve, the sandbox switch and Add folder refuse it");
ok(ask("/api/security/approve", UI), "the UI token keeps its reach");

const dev = read("desktop/dev.ts");
const envUrls = dev.split("\n").filter((l) => /^(if \(HAS_MAIN\) )?process\.env\.LUCID_[A-Z_]+_URL = `http:\/\/127\.0\.0\.1:\$\{server\.port\}\/api\//.test(l));
ok(envUrls.length >= 13 && envUrls.every((l) => l.includes("?t=${AGENT_TOKEN}")), `all ${envUrls.length} child URLs carry AGENT_TOKEN, none the UI token`);
ok(!dev.includes("?t=${TOKEN}`"), "no URL anywhere in dev.ts hands out the UI token");

console.log("\n[2] the child never inherits the Electron main's token");
const del = dev.indexOf("delete process.env.LUCID_MAIN_TOKEN;");
ok(del > 0 && del < dev.indexOf("Bun.serve(") , "LUCID_MAIN_TOKEN is deleted from process.env before the server (and any child) starts");

console.log("\n[3] the HTML carries no token under Electron; the window gets it over IPC");
ok(dev.includes('HAS_MAIN ? "</head>"'), "the <meta> injection is skipped when an Electron main launched the engine");
ok(read("desktop/main.ts").includes('ipcMain.on("lucid:token"') && read("desktop/preload.ts").includes('sendSync("lucid:token")'), "main answers lucid:token; the preload exposes lucid.token()");
ok(isEngineDocument("http://localhost:5319/", 5319) && !isEngineDocument("https://example.com/", 5319), "main hands it only to its own engine document");

console.log("\n✓ P-SANDBOX.15 demo passed - the agent holds a token that opens only its own routes, never the UI token.");
