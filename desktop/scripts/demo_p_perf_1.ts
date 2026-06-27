// desktop/scripts/demo_p_perf_1.ts
//
// Increment P-PERF.1 — instant session list + transcripts via a persisted stale-while-revalidate cache
// (ADR-0084). A returning user shouldn't see a skeleton or a blank thread: we paint the cached value
// immediately, then refresh in the background and only re-render if it actually changed. Proof of the cache
// core (swr_cache.ts) the renderer wires to.

import { __resetCache, cachedSessions, cachedTranscript, setCachedSessions, setCachedTranscript, transcriptSig } from "../renderer/swr_cache.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);
__resetCache();

console.log("== #ADR-0084 instant-from-cache, refresh-in-background ==");

// 1) session list: cache once, get it back instantly next launch
if (cachedSessions() !== null) fail("cold cache should be empty");
const list = { sessions: [{ id: "s1", title: "Auth bug" }, { id: "s2", title: "RAG spike" }], ingest: [] };
setCachedSessions(list);
if (JSON.stringify(cachedSessions()) !== JSON.stringify(list)) fail("session list should round-trip");
ok("returning user: the session list paints instantly from cache (no skeleton)");

// 2) transcript: cache-hit means no blank thread; sig-compare avoids a flicker when nothing changed
const msgs = [{ role: "user", text: "how do I center a div?" }, { role: "assistant", text: "flexbox: justify+align center" }];
setCachedTranscript("s1", msgs, 1);
const cached = cachedTranscript("s1");
if (!cached || cached.length !== 2) fail("transcript should be cached");
const fresh = [{ role: "user", text: "how do I center a div?" }, { role: "assistant", text: "flexbox: justify+align center" }];
if (transcriptSig(cached!) !== transcriptSig(fresh)) fail("identical fresh load should match cache → skip re-render");
ok("clicking a session: transcript shows instantly; identical refresh skips a re-render (no flicker)");

const grew = [...fresh, { role: "user", text: "thanks!" }];
if (transcriptSig(cached!) === transcriptSig(grew)) fail("a new message must change the signature → re-render");
ok("a changed transcript re-renders (sig differs); stale cache is reconciled");

// 3) bounded: the cache can't grow forever (LRU cap), so localStorage stays small + fast
for (let i = 0; i < 20; i++) setCachedTranscript(`x${i}`, [{ role: "user", text: `m${i}` }], 100 + i);
if (cachedTranscript("x0") !== null) fail("oldest transcripts beyond the cap must be evicted");
if (cachedTranscript("x19") === null) fail("the most-recent transcripts must survive");
ok("LRU-capped: only the most-recently-opened sessions are kept (localStorage stays bounded)");

console.log("demo-P-PERF.1 OK");
process.exit(0);
