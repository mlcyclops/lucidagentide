// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// CREATOR-WHISTLE (ADR-0432, decision 2): the ONE Whistle worker and its main-thread owner. The real
// model is driven through the worker (fixture transcript, silence, two queued calls in order, close), and
// the failure paths are named refusals: a glue that cannot be required rejects the start with the reason,
// a glue that never answers rejects after `readyTimeoutMs` and the worker is terminated.

import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WhistleClient } from "./whistle_client.ts";
import {
  FIXTURE_TEXT, WHISTLE_MODEL_SHA256_PIN, WHISTLE_SKIP_REASON, findWhistleAssetDir, normalizedTokens, readFixturePcm16k,
  readVerifiedWhistleAssets, tokenMatch,
} from "./whistle_test_assets.ts";

const ASSET_DIR = findWhistleAssetDir();
if (ASSET_DIR === null) console.log(`whistle_client.test: ${WHISTLE_SKIP_REASON}`);
const withAssets = test.skipIf(ASSET_DIR === null);

// ---- failure paths (no assets needed: the glue is the thing under test) ----

test("a glue path that cannot be required rejects start with the reason, well inside the timeout", async () => {
  const t0 = performance.now();
  let message = "";
  try {
    await WhistleClient.start({ gluePath: join(tmpdir(), "no-such-needle-glue.js"), wasm: new Uint8Array(4), cact: new Uint8Array(4), modelSha256: "x", readyTimeoutMs: 10000 });
  } catch (e) { message = e instanceof Error ? e.message : String(e); }
  expect(message.length).toBeGreaterThan(0);
  expect(message).not.toMatch(/not ready after/);
  expect(performance.now() - t0).toBeLessThan(10000);
}, 15000);

test("a glue that never answers rejects after readyTimeoutMs and the client is closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "whistle-hang-"));
  const gluePath = join(dir, "needle.js");
  writeFileSync(gluePath, "module.exports = function createNeedle() { return new Promise(function () {}); };\n");
  const t0 = performance.now();
  let message = "";
  try {
    await WhistleClient.start({ gluePath, wasm: new Uint8Array(4), cact: new Uint8Array(4), modelSha256: "x", readyTimeoutMs: 400 });
  } catch (e) { message = e instanceof Error ? e.message : String(e); }
  expect(message).toBe("Whistle worker was not ready after 400 ms");
  expect(performance.now() - t0).toBeGreaterThanOrEqual(350);
  expect(performance.now() - t0).toBeLessThan(5000);
}, 15000);

test("a glue without the needle exports is a named load-error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "whistle-bare-"));
  const gluePath = join(dir, "needle.js");
  writeFileSync(gluePath, "module.exports = async function createNeedle() { return { HEAPU8: new Uint8Array(8) }; };\n");
  let message = "";
  try {
    await WhistleClient.start({ gluePath, wasm: new Uint8Array(4), cact: new Uint8Array(4), modelSha256: "x", readyTimeoutMs: 5000 });
  } catch (e) { message = e instanceof Error ? e.message : String(e); }
  expect(message).toMatch(/without the needle exports/);
}, 15000);

// ---- the real model through the worker ----

withAssets("start, transcribe the fixture through the worker, silence is empty, two concurrent calls resolve in order, close terminates", async () => {
  const a = readVerifiedWhistleAssets(ASSET_DIR!);
  const t0 = performance.now();
  const client = await WhistleClient.start({ gluePath: a.gluePath, wasm: a.wasm, cact: a.cact, modelSha256: WHISTLE_MODEL_SHA256_PIN });
  console.log(`whistle_client.test: worker ready in ${Math.round(performance.now() - t0)} ms`);
  // The client copied the bytes before transferring: the caller's buffers are intact.
  expect(a.wasm.byteLength).toBe(903655);
  expect(a.cact.byteLength).toBe(16919407);
  expect(client.modelSha256).toBe(WHISTLE_MODEL_SHA256_PIN);
  try {
    const pcm = readFixturePcm16k();
    const seconds = pcm.length / 16000;
    const t1 = performance.now();
    const t = await client.transcribe(pcm);
    const wall = Math.round(performance.now() - t1);
    console.log(`whistle_client.test: fixture ${seconds.toFixed(2)} s transcribed through the worker in ${wall} ms`);
    console.log(`whistle_client.test: transcript: ${t.text}`);
    expect(tokenMatch(normalizedTokens(FIXTURE_TEXT), normalizedTokens(t.text))).toBeGreaterThanOrEqual(0.9);
    expect(t.words.length).toBeGreaterThanOrEqual(25);
    expect(t.windows).toBe(1);
    // The PCM was moved to the worker (transferable), so the caller's view is detached.
    expect(pcm.byteLength).toBe(0);

    const silence = await client.transcribe(new Float32Array(16000));
    expect(silence.text).toBe("");
    expect(silence.words).toEqual([]);

    const order: string[] = [];
    const first = client.transcribe(readFixturePcm16k()).then((r) => { order.push("first"); return r; });
    const second = client.transcribe(new Float32Array(16000)).then((r) => { order.push("second"); return r; });
    const [r1, r2] = await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
    expect(normalizedTokens(r1.text).length).toBeGreaterThanOrEqual(25);
    expect(r2.text).toBe("");
  } finally {
    client.close();
  }
  let afterClose = "";
  try { await client.transcribe(new Float32Array(16000)); } catch (e) { afterClose = e instanceof Error ? e.message : String(e); }
  expect(afterClose).toBe("Whistle worker closed");
  client.close(); // idempotent
}, 120000);

withAssets("close() while a call is in flight rejects it with the close reason", async () => {
  const a = readVerifiedWhistleAssets(ASSET_DIR!);
  const client = await WhistleClient.start({ gluePath: a.gluePath, wasm: a.wasm, cact: a.cact, modelSha256: WHISTLE_MODEL_SHA256_PIN });
  const inFlight = client.transcribe(readFixturePcm16k());
  const queued = client.transcribe(new Float32Array(16000));
  client.close();
  await expect(inFlight).rejects.toThrow("Whistle worker closed");
  await expect(queued).rejects.toThrow("Whistle worker closed");
}, 60000);
