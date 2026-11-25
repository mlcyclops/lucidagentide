// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-MARKET.AUTH2 (ADR-0684): the engine custody of the LUCID store sign-in and the world receipts, over its routes.
// The UI header token alone opens them (never the agent token, never `?t=`), dev.ts never lists them for agents, the
// refresh token goes in and never comes back out on any reply, renewal keeps the user signed in offline and signs out
// only on Google's definitive refusal, and receipts merge newer-wins. The OS backend is an in-memory fake; every path
// is a temp dir; Google is an injected fetch.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setVaultBackendForTest, type OsKeyStore } from "./engine_vault.ts";
import { MARKET_AUTH_REF, MARKET_RECEIPTS_REF, readMarketAuth, readReceipts } from "./market_auth_store.ts";
import { handleMarketAuthRoutes, MARKET_AUTH_ROUTES, type MarketAuthRouteCtx } from "./market_auth_routes.ts";
import { vaultList } from "./vault_store.ts";

const ENV_KEYS = ["LUCID_GUI_SETTINGS_FILE", "LUCID_ENGINE_VAULT_DIR", "LUCID_OMP_MODELS_YAML"] as const;
const ENV_BEFORE = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const dirs: string[] = [];
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "lucid-market-auth-"));
  dirs.push(root);
  process.env.LUCID_GUI_SETTINGS_FILE = join(root, "lucid-gui.json");
  process.env.LUCID_OMP_MODELS_YAML = join(root, "models.yml");
  delete process.env.LUCID_ENGINE_VAULT_DIR;
  let held: Buffer | null = randomBytes(32);
  const store: OsKeyStore = { kind: "dpapi", read: () => (held ? Buffer.from(held) : { missing: "absent" }), create: (k: Buffer) => { held = Buffer.from(k); return true; } };
  _setVaultBackendForTest(() => store);
});
afterEach(() => { _setVaultBackendForTest(null); });
afterAll(() => {
  for (const k of ENV_KEYS) { const v = ENV_BEFORE[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const UI = "ui-token-0123456789abcdef0123456789abcdef";
const AGENT = "agent-token-0123456789abcdef0123456789ab";
const NOW = 1_800_000_000_000;
const REFRESH = "REFRESH-TOKEN-SECRET-0001";
const ROLLED = "REFRESH-TOKEN-ROLLED-0002";
const EXPIRED_ID = "eyJ-EXPIRED-ID-TOKEN";

function req(path: string, body?: unknown, headers: Record<string, string> = { "x-lucid-token": UI }, method = body === undefined ? "GET" : "POST"): Request {
  return new Request(`http://127.0.0.1:1${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
/** Every reply body, so the suite can assert no refresh token ever left. */
const bodies: string[] = [];
async function call(path: string, body?: unknown, ctx: MarketAuthRouteCtx = { uiToken: UI, now: () => NOW }) {
  const res = await handleMarketAuthRoutes(req(path, body), path, ctx);
  const text = await res!.text();
  bodies.push(text);
  return { status: res!.status, json: JSON.parse(text) };
}
const google = (reply: () => Response): { fetchImpl: typeof fetch; calls: number } => {
  const st = { calls: 0, fetchImpl: undefined as unknown as typeof fetch };
  st.fetchImpl = (async () => { st.calls++; return reply(); }) as unknown as typeof fetch;
  return st;
};
const seedExpired = () => call("/api/market/auth", { record: { idToken: EXPIRED_ID, email: "patron@x.com", expiresAt: NOW - 10 * 60_000, refreshToken: REFRESH } });

describe("market auth routes", () => {
  test("only the UI header token opens them; methods are checked; other paths pass through", async () => {
    for (const p of MARKET_AUTH_ROUTES) {
      expect((await handleMarketAuthRoutes(req(p, undefined, { "x-lucid-token": AGENT }), p, { uiToken: UI }))!.status).toBe(403);
      expect((await handleMarketAuthRoutes(req(p, undefined, {}), p, { uiToken: UI }))!.status).toBe(403);
      expect((await handleMarketAuthRoutes(new Request(`http://127.0.0.1:1${p}?t=${UI}`), p, { uiToken: UI }))!.status).toBe(403);
    }
    expect((await call("/api/market/auth/renew")).status).toBe(405); // GET on a POST-only path
    expect((await handleMarketAuthRoutes(req("/api/market/auth", undefined, { "x-lucid-token": UI }, "DELETE"), "/api/market/auth", { uiToken: UI }))!.status).toBe(405);
    expect((await call("/api/market/auth", { record: { idToken: "", expiresAt: 1 } })).status).toBe(400);
    expect(await handleMarketAuthRoutes(req("/api/market/other"), "/api/market/other", { uiToken: UI })).toBeNull();
    expect(await handleMarketAuthRoutes(req("/api/vault/list"), "/api/vault/list", { uiToken: UI })).toBeNull();
  });

  test("the sign-in is held in the engine vault; the refresh token goes in and never comes back out", async () => {
    const put = await seedExpired();
    expect(put.status).toBe(200);
    expect(put.json.data).toEqual({ signedIn: true, email: "patron@x.com", expiresAt: NOW - 10 * 60_000, renewable: true });
    expect(vaultList().map((m) => m.ref)).toContain(MARKET_AUTH_REF);
    expect(readMarketAuth()?.refreshToken).toBe(REFRESH);
    const got = await call("/api/market/auth");
    expect(got.json.data.view).toEqual({ idToken: EXPIRED_ID, email: "patron@x.com", expiresAt: NOW - 10 * 60_000, renewable: true });
    const all = bodies.join("\n");
    expect(all).not.toContain(REFRESH);
    expect(all).not.toContain("refreshToken");
  });

  test("an expired ID token renews silently; the rolled refresh token is kept in the vault, not returned", async () => {
    await seedExpired();
    const g = google(() => new Response(JSON.stringify({ id_token: "RENEWED-ID", refresh_token: ROLLED, expires_in: "3600" })));
    const r = await call("/api/market/auth/renew", { apiKey: "public-web-key" }, { uiToken: UI, now: () => NOW, fetchImpl: g.fetchImpl });
    expect(r.json.data).toEqual({ status: "ok", view: { idToken: "RENEWED-ID", email: "patron@x.com", expiresAt: NOW + 3600_000, renewable: true } });
    expect(g.calls).toBe(1);
    expect(readMarketAuth()).toMatchObject({ idToken: "RENEWED-ID", refreshToken: ROLLED });
    // a live token is served without asking Google again
    const again = await call("/api/market/auth/renew", { apiKey: "public-web-key" }, { uiToken: UI, now: () => NOW, fetchImpl: g.fetchImpl });
    expect(again.json.data.status).toBe("ok");
    expect(g.calls).toBe(1);
    const all = bodies.join("\n");
    expect(all).not.toContain(REFRESH);
    expect(all).not.toContain(ROLLED);
  });

  test("offline keeps the sign-in (unavailable, view kept); Google's definitive refusal clears it", async () => {
    await seedExpired();
    const off = google(() => { throw new TypeError("fetch failed"); });
    const r = await call("/api/market/auth/renew", { apiKey: "k" }, { uiToken: UI, now: () => NOW, fetchImpl: off.fetchImpl });
    expect(r.json.data.status).toBe("unavailable");
    expect(r.json.data.view.renewable).toBe(true);
    expect(readMarketAuth()?.refreshToken).toBe(REFRESH);

    const revoked = google(() => new Response(JSON.stringify({ error: { code: 400, message: "INVALID_REFRESH_TOKEN" } }), { status: 400 }));
    const gone = await call("/api/market/auth/renew", { apiKey: "k" }, { uiToken: UI, now: () => NOW, fetchImpl: revoked.fetchImpl });
    expect(gone.json.data).toEqual({ status: "signed-out", view: null });
    expect(readMarketAuth()).toBeNull();
    expect((await call("/api/market/auth")).json.data.view).toBeNull();
    expect(bodies.join("\n")).not.toContain(REFRESH);
  });

  test("clear signs out", async () => {
    await seedExpired();
    expect((await call("/api/market/auth/clear", {})).json.data).toEqual({ signedIn: false });
    expect(readMarketAuth()).toBeNull();
  });

  test("receipts merge newer-wins, drop on request, and skip malformed ids and times", async () => {
    expect((await call("/api/market/receipts")).json.data.receipts).toEqual({});
    expect((await call("/api/market/receipts", { set: { "world-christmas": NOW, "world-soccer": NOW - 5, "../x": NOW, "world-farm": "soon" } })).json.data.count).toBe(2);
    await call("/api/market/receipts", { set: { "world-christmas": NOW - 1000 } }); // older: ignored
    expect(readReceipts()).toEqual({ "world-christmas": NOW, "world-soccer": NOW - 5 });
    await call("/api/market/receipts", { drop: ["world-soccer"] });
    expect((await call("/api/market/receipts")).json.data.receipts).toEqual({ "world-christmas": NOW });
    expect(vaultList().map((m) => m.ref)).toContain(MARKET_RECEIPTS_REF);
    expect((await call("/api/market/receipts", {})).status).toBe(400);
  });

  test("dev.ts chains the routes and never lists them among the agent / query-token routes", () => {
    const src = readFileSync(join(import.meta.dir, "dev.ts"), "utf8");
    const aStart = src.indexOf("const AGENT_ROUTES");
    const lists = src.slice(src.indexOf("const QUERY_TOKEN_ROUTES"), src.indexOf("\n", aStart));
    expect(lists.length).toBeGreaterThan(100);
    expect(lists).not.toContain("/api/market");
    expect(src).toContain("handleMarketAuthRoutes(req, p, { uiToken: TOKEN })");
  });
});
