// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_kgmarket_4b.ts — P-KGMARKET.4 part 2 (ADR-0206): the SIGN-IN flow, against stubs.
//
// Proves the marketplace sign-in orchestration (market_boot) end to end WITHOUT a deployed Firebase/Stripe:
//   1. STUB mode: signed out ⇒ the decision is `signin`; beginSignIn() mints a local token; then not-owned ⇒
//      `checkout`; the stub checkout grants instantly (dev) ⇒ `pull`; the signed download URL then feeds the
//      SAME P-KGPACK.4 verify + re-scan install gate — a real .lkgpack.zip installs read-only.
//   2. FIREBASE mode: beginSignIn() opens the hosted sign-in URL (with the lucid://auth redirect); the app is
//      signed out until the deep link comes back, and handleAuthCallback("lucid://auth?token=...") signs in.
//   3. OFF mode (a plain public build): the fail-closed nullProvider stays and sign-in is a no-op.
// Fail-closed throughout: no token ⇒ signed out ⇒ never a pull. A purchase grants access; the scanner still
// proves safety.

import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportKgPack, installPackFromUrl } from "../kb_pack.ts";
import { kbStore, createKg, listKgs, stopKb, _resetKbStoreForTest } from "../kb_store.ts";
import {
  initMarket, beginSignIn, handleAuthCallback, marketUser, marketSignOut, __resetMarketBootForTest,
} from "../renderer/market_boot.ts";
import { getMarketProvider } from "../renderer/market_gate.ts";
import { decidePackAction } from "../../harness/market/entitlement.ts";
import type { AuthStorage } from "../renderer/market_auth.ts";

function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(`ASSERT FAILED: ${msg}`); }
const memStorage = (): AuthStorage => { let v: string | null = null; return { get: () => v, set: (x) => { v = x; }, remove: () => { v = null; } }; };
const NOW = () => 1_700_000_000_000;

const dir = mkdtempSync(join(tmpdir(), "kgmarket4b-"));
process.env.LUCID_KB_DB_PATH = join(dir, "kb_graph.duckdb");
process.env.LUCID_KG_REGISTRY_PATH = join(dir, "kg_registry.json");
process.env.LUCID_SKILL_SCAN_PATH = join(dir, "scans.jsonl");

const AT = "2026-07-10T00:00:00.000Z";
const PACK_ID = "kgp-cleared";
const fetchFromFile = (zipPath: string): typeof fetch =>
  (async () => { const b = readFileSync(zipPath); return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }; }) as unknown as typeof fetch;

async function seed(name: string): Promise<string> {
  const kg = createKg({ name });
  const store = await kbStore(kg.kg_id);
  await store.addPage({ kind: "concept", slug: "far", title: "FAR", bodyMd: "FAR Part 15 negotiated procurement.", trustLabel: "untrusted", classification: "U" });
  return kg.kg_id;
}

try {
  _resetKbStoreForTest();

  console.log("== [1/3] STUB mode: signin → checkout(grant) → pull → gated install, fully offline ==");
  const srcKg = await seed("GovCon Contracts Officer");
  const exp = await exportKgPack(srcKg, join(dir, "out"), { author: "TechLead 187 LLC", version: "1.0.0", createdAt: AT });
  assert(exp.ok && exp.zipPath, `exported a .lkgpack.zip (${JSON.stringify(exp)})`);

  const mode = initMarket({ mode: "stub" }, { storage: memStorage(), now: NOW, stubDownloadUrlFor: () => `file://${exp.zipPath}` });
  assert(mode === "stub" && getMarketProvider().configured(), "stub provider registered");
  const prov = getMarketProvider();

  // signed out ⇒ signin
  let ent = await prov.entitlement(PACK_ID);
  assert(decidePackAction(marketUser(), ent, AT) === "signin", "signed out → signin");

  // beginSignIn (stub mints a local token) ⇒ signed in, but not owned ⇒ checkout
  const r = beginSignIn("buyer@agency.gov");
  assert(r.signedIn && marketUser().signedIn && marketUser().email === "buyer@agency.gov", "stub sign-in minted a local token");
  ent = await prov.entitlement(PACK_ID);
  assert(decidePackAction(marketUser(), ent, AT) === "checkout", "signed in, not owned → checkout");

  // stub checkout grants instantly (dev) ⇒ owned ⇒ pull
  await prov.checkoutUrl(PACK_ID, "one-time");
  ent = await prov.entitlement(PACK_ID);
  assert(decidePackAction(marketUser(), ent, AT) === "pull", "after purchase → pull");

  // pull: the signed download URL → the SAME gated install as a local import
  const dl = await prov.downloadUrl(PACK_ID);
  assert(dl === `file://${exp.zipPath}`, `owned pack yields a signed download URL (${dl})`);
  const inst = await installPackFromUrl(dl!, { fetchImpl: fetchFromFile(exp.zipPath!) });
  assert(inst.ok && inst.stage === "ok" && inst.pages === 1, `installed via the entitled download (${JSON.stringify(inst)})`);
  const installed = listKgs().find((k) => k.kg_id === inst.kgId)!;
  assert(installed.read_only && installed.source_kind === "pack", "installed read-only as a pack");
  console.log(`   signed in "${marketUser().email}" → bought → installed "${inst.kgName}" (${inst.pages} pages, read-only)`);

  // sign out is fail-closed: back to signin, no download
  marketSignOut();
  assert(!marketUser().signedIn && (await prov.downloadUrl(PACK_ID)) === null, "sign-out fail-closes (no download)");
  console.log("   signed out → no download URL (fail-closed)");

  console.log("== [2/3] FIREBASE mode: beginSignIn opens the hosted page; the lucid://auth deep link finishes it ==");
  __resetMarketBootForTest();
  const opened: string[] = [];
  initMarket(
    { mode: "firebase", functionsBaseUrl: "https://us-central1-lucid-agent.cloudfunctions.net", signInUrl: "https://lucid-agent.web.app/signin" },
    { storage: memStorage(), now: NOW, openExternal: (u) => opened.push(u) },
  );
  const fb = beginSignIn("buyer@agency.gov");
  assert(fb.opened && !fb.signedIn && opened.length === 1, "opened the hosted sign-in page, still signed out");
  assert(opened[0]!.includes("redirect_uri=lucid%3A%2F%2Fauth") && opened[0]!.includes("login_hint=buyer%40agency.gov"), `sign-in URL carries the deep-link redirect + hint (${opened[0]})`);
  assert(!marketUser().signedIn, "not signed in until the callback");
  const ok = handleAuthCallback("lucid://auth?token=real-firebase-id-token&email=buyer%40agency.gov&exp=1700000900");
  assert(ok && marketUser().signedIn && marketUser().email === "buyer@agency.gov", "the deep link signed the user in");
  console.log(`   opened ${new URL(opened[0]!).host} → deep link lucid://auth signed in "${marketUser().email}"`);

  console.log("== [3/3] OFF mode (plain public build): nullProvider stays; sign-in is a no-op ==");
  __resetMarketBootForTest();
  assert(initMarket({}, { storage: memStorage() }) === "off", "no config → off");
  assert(!getMarketProvider().configured(), "fail-closed nullProvider stays");
  const off = beginSignIn();
  assert(!off.opened && !off.signedIn && !!off.reason, "sign-in is a no-op when unconfigured");
  console.log(`   off: ${off.reason}`);

  console.log("== demo-P-KGMARKET.4b OK ==");
} finally {
  __resetMarketBootForTest();
  await stopKb();
  delete process.env.LUCID_KB_DB_PATH;
  delete process.env.LUCID_KG_REGISTRY_PATH;
  delete process.env.LUCID_SKILL_SCAN_PATH;
  rmSync(dir, { recursive: true, force: true });
}
