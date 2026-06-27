// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_kg_ingest_4.ts
//
// Increment P-KG-INGEST.4 — TRUE ingest concurrency (issue/ADR-0085). P-KG-INGEST.3 made chat preempt
// extraction on the ONE shared omp connection (≤1 extraction of latency). This gives extraction its OWN
// dedicated omp connection (separate process + event sink), so a long AI import runs flat-out and NEVER
// touches the chat connection. Fail-safe: if the second omp can't spawn, complete() degrades to the proven
// shared-connection path (with the ChatGate). The spawn/ACP plumbing is integration code; here we prove the
// ROUTING CONTRACT (which path, and whether it yields to chat) that acp_backend wires to.

import { completionPath, needsChatYield } from "../util_conn.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);

console.log("== #ADR-0085 dedicated util connection: routing + fail-safe ==");

if (completionPath(true) !== "dedicated") fail("a ready util connection should use the dedicated path");
ok("util omp spawned → extraction runs on its OWN connection (true concurrency with chat)");

if (completionPath(false) !== "shared-fallback") fail("no util connection should fall back to the shared one");
ok("util omp spawn FAILED → fail-safe fallback to the shared connection (today's proven behavior)");

if (needsChatYield(completionPath(true)) !== false) fail("the dedicated path must NOT yield to chat");
ok("dedicated path: NO yield — import runs flat-out, zero impact on the chat connection");

if (needsChatYield(completionPath(false)) !== true) fail("the shared fallback must yield to chat (ChatGate)");
ok("shared fallback: yields to a live chat turn via the ChatGate (P-KG-INGEST.3) so chat still preempts");

console.log("demo-P-KG-INGEST.4 OK");
process.exit(0);
