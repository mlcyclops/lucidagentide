// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_premote2b.ts — P-REMOTE.2b (ADR-0226/0227): desktop wiring for the hosted rendezvous.
//
// Two pure pieces, end to end: (A) MarketAuth renews a near-expiry Firebase ID token via the securetoken
// refresh exchange (injected fetch) so the desktop relay reconnect always presents a live token; (B) a
// CollabManager pointed at a relay with a `pwaBase` mints a PHONE-openable browser invite (PWA URL, secret in
// the fragment) that carries the write token when sharing EDIT — so scanning the QR opens the PWA and can
// drive. Without a pwaBase, the browser link stays the legacy relay-host form (unchanged).

import { MarketAuth, type AuthStorage } from "../../desktop/renderer/market_auth.ts";
import { CollabManager, type CollabManagerDeps, type RelayTarget } from "../../desktop/collab/manager.ts";
import type { HostTransport } from "../../desktop/collab/host.ts";
import type { LucidCollabFrame } from "../../desktop/collab/frames.ts";
import { parseShareLink } from "../../desktop/collab/link.ts";

let step = 0;
const pass = (m: string): void => { console.log(`  [${++step}] PASS ${m}`); };
const fail = (m: string): never => { console.error(`  FAIL ${m}`); process.exit(1); };

console.log("== P-REMOTE.2b: token refresh custody + PWA-pointing invite links ==");

// (A) refresh custody: a near-expiry token is renewed via the securetoken exchange (injected fetch)
const NOW = 1_800_000_000_000;
const mem = (): AuthStorage => { let v: string | null = null; return { get: () => v, set: (x) => { v = x; }, remove: () => { v = null; } }; };
const auth = new MarketAuth(mem(), () => NOW);
auth.applyCallback("lucid://auth?token=old&refresh=r0&email=nick%40x.com&exp=1800000030"); // expires in 30s
let exchanged = false;
const fakeSecuretoken = (async (url: string) => {
  if (!String(url).includes("securetoken.googleapis.com")) fail("did not call the securetoken endpoint");
  exchanged = true;
  return new Response(JSON.stringify({ id_token: "renewed", refresh_token: "r1", expires_in: "3600" }), { status: 200 });
}) as unknown as typeof fetch;
const fresh = await auth.freshIdToken({ apiKey: "public-web-key", fetchImpl: fakeSecuretoken });
if (fresh !== "renewed" || !exchanged) fail("near-expiry token was not refreshed");
if (await auth.getIdToken() !== "renewed") fail("refreshed token was not persisted");
pass("MarketAuth renews a near-expiry ID token via the securetoken refresh exchange (persisted)");

const signedOut = new MarketAuth(mem(), () => NOW);
if (await signedOut.freshIdToken({ apiKey: "k" }) !== null) fail("signed-out freshIdToken must be null");
pass("freshIdToken fails closed to null when signed out / no refresh token");

// (B) PWA-pointing invite links via a mock-transport CollabManager
class MockTransport implements HostTransport {
  onOpen?: () => void; onFrame?: (f: LucidCollabFrame, p: number) => void;
  onControl?: (m: unknown) => void; onClose?: (r: string, w: boolean) => void;
  connect(): void { this.onOpen?.(); }
  send(): void { /* no wire in the demo */ }
  close(): void { /* no-op */ }
}
const mkDeps = (relay: RelayTarget): CollabManagerDeps => ({
  resolveRelay: () => relay,
  sessionInfo: () => ({ sessionId: "s1", title: "LUCID session", model: "claude-opus-4-8", hostName: "nick" }),
  makeTransport: () => new MockTransport(),
  now: () => NOW,
});
const hosted: RelayTarget = { wsBase: "wss://relay.run.app", httpBase: "https://relay.run.app", label: "hosted", source: "public", pwaBase: "https://lucid-agent.web.app/remote" };

const editShare = await new CollabManager(mkDeps(hosted)).start({ allowEdit: true });
if (!editShare.browserLink?.startsWith("https://lucid-agent.web.app/remote/#")) fail("edit browser link is not a PWA link");
const parsedEdit = parseShareLink(editShare.browserLink!.slice(editShare.browserLink!.indexOf("#") + 1));
if (parsedEdit.roomId !== editShare.roomId || !parsedEdit.writeToken) fail("PWA edit link lost the roomId / write token");
pass("EDIT share -> a PWA browser link the phone can open, carrying the write token (can drive)");

const viewShare = await new CollabManager(mkDeps(hosted)).start();
if (parseShareLink(viewShare.browserLink!.slice(viewShare.browserLink!.indexOf("#") + 1)).writeToken !== null) fail("view PWA link should have no write token");
pass("VIEW share -> a PWA browser link with NO write token (watch only)");

const legacy: RelayTarget = { wsBase: "wss://relay.local", httpBase: "https://relay.local", label: "self-hosted", source: "self-hosted" };
const legacyShare = await new CollabManager(mkDeps(legacy)).start({ allowEdit: true });
if (!legacyShare.browserLink?.startsWith("https://relay.local/#")) fail("no-pwaBase relay should keep the legacy relay-host browser link");
pass("no pwaBase -> legacy relay-host browser link (unchanged for self-hosted / public relays)");

console.log(`\nP-REMOTE.2b demo: all ${step} checks passed — the desktop renews tokens + mints phone-openable invites.`);
process.exit(0);
