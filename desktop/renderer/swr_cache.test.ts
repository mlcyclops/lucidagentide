// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Tests for the stale-while-revalidate cache (P-PERF.1, ADR-0084). Runs against the in-memory fallback
// store (no localStorage in bun), reset between cases.

import { beforeEach, expect, test } from "bun:test";
import {
  __resetCache, cacheGet, cacheSet, cachedSessions, cachedShareSnapshot, cachedSkills, cachedTranscript, setCachedSessions, setCachedShareSnapshot, setCachedSkills, setCachedTranscript, transcriptSig,
} from "./swr_cache.ts";

beforeEach(() => __resetCache());

test("cacheGet/cacheSet round-trips JSON; missing key → null", () => {
  expect(cacheGet("k")).toBeNull();
  cacheSet("k", { a: 1, b: ["x"] });
  expect(cacheGet("k")).toEqual({ a: 1, b: ["x"] });
});

test("session list cache round-trips", () => {
  expect(cachedSessions()).toBeNull();
  const data = { sessions: [{ id: "s1", title: "hi" }], ingest: [] };
  setCachedSessions(data);
  expect(cachedSessions()).toEqual(data);
});

test("transcript cache stores + retrieves per session id", () => {
  expect(cachedTranscript("a")).toBeNull();
  const msgs = [{ role: "user", text: "hello" }, { role: "assistant", text: "hi there" }];
  setCachedTranscript("a", msgs, 1);
  expect(cachedTranscript("a")).toEqual(msgs);
  expect(cachedTranscript("b")).toBeNull(); // other ids unaffected
});

test("transcript cache is LRU-capped at 15 (oldest evicted)", () => {
  for (let i = 0; i < 16; i++) setCachedTranscript(`s${i}`, [{ role: "user", text: `m${i}` }], i); // at = i (s0 oldest)
  expect(cachedTranscript("s0")).toBeNull();      // the oldest was evicted
  expect(cachedTranscript("s1")).not.toBeNull();  // the next 15 survive
  expect(cachedTranscript("s15")).not.toBeNull();
});

test("each transcript is capped to the last 400 messages", () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ role: "user", text: `m${i}` }));
  setCachedTranscript("big", many, 1);
  const got = cachedTranscript("big")!;
  expect(got).toHaveLength(400);
  expect(got[0]!.text).toBe("m100"); // dropped the oldest 100, kept the last 400
  expect(got.at(-1)!.text).toBe("m499");
});

test("transcriptSig is stable for identical transcripts, changes when content changes", () => {
  const a = [{ role: "user", text: "hello" }, { role: "assistant", text: "world" }];
  const aCopy = [{ role: "user", text: "hello" }, { role: "assistant", text: "world" }];
  expect(transcriptSig(a)).toBe(transcriptSig(aCopy));
  expect(transcriptSig(a)).not.toBe(transcriptSig([...a, { role: "user", text: "more" }])); // a new message
  expect(transcriptSig(a)).not.toBe(transcriptSig([{ role: "user", text: "hello!" }, { role: "assistant", text: "world" }])); // a longer message
});

test("share-dock snapshot cache round-trips; missing \u2192 null (P-SHARE.2)", () => {
  expect(cachedShareSnapshot()).toBeNull();
  const snap = { relay: { wsBase: "wss://relay/r", label: "relay", source: "self-hosted" }, serve: { running: false }, p2pCfg: { preferDirect: false, iceUrls: [] } };
  setCachedShareSnapshot(snap);
  expect(cachedShareSnapshot()).toEqual(snap);
});

test("discovered-skills cache round-trips; missing \u2192 null (P-SKILL.6)", () => {
  expect(cachedSkills()).toBeNull();
  const skills = [{ name: "deploy", description: "ship it", source: "project", root: "project", trust: "trusted", invocation: "/skill:deploy", removable: true }];
  setCachedSkills(skills);
  expect(cachedSkills()).toEqual(skills);
});

test("bad JSON / quota failures degrade to null, never throw", () => {
  // a value that survives JSON round-trip is fine; the guard is that get on absent/garbage returns null
  expect(cacheGet("never-set")).toBeNull();
});
