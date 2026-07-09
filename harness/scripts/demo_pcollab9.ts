// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pcollab9.ts
//
// P-COLLAB.9 (ADR-0195): the STANDALONE relay broker, proven end-to-end. Spawns the deployable exactly as a
// jumpbox would (`bun run tools/relay/serve.ts`), waits for /healthz, then connects a REAL host + REAL guest
// through the separate process and confirms a full session flows: hello -> welcome -> live event -> bye. This
// validates the thing you actually DEPLOY, not just the in-process library.
//
// Run with: bun run harness/scripts/demo_pcollab9.ts

import { CollabSocket } from "../../desktop/collab/relay_client.ts";
import { CollabHost } from "../../desktop/collab/host.ts";
import { CollabGuest } from "../../desktop/collab/guest.ts";
import { generateRoomKey, importRoomKey } from "../../desktop/collab/crypto.ts";
import { generateRoomId, formatShareLink, parseShareLink } from "../../desktop/collab/link.ts";

function fail(m: string): never { console.error(`FAIL: ${m}`); process.exit(1); }
function ok(m: string): void { console.log(`  PASS  ${m}`); }
async function waitFor(cond: () => boolean | Promise<boolean>, label: string, tries = 400): Promise<void> {
  for (let i = 0; i < tries; i++) { if (await cond()) return; await new Promise((r) => setTimeout(r, 15)); }
  fail(`timed out waiting for ${label}`);
}

console.log("P-COLLAB.9 demo - the STANDALONE relay broker, spawned as a separate process\n");

const PORT = 8899;
const base = `127.0.0.1:${PORT}`;

// [1] spawn the deployable exactly like a jumpbox/systemd would
const proc = Bun.spawn(["bun", "run", "tools/relay/serve.ts"], {
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(PORT) },
  stdout: "pipe", stderr: "pipe",
});
async function cleanup() { try { proc.kill(); } catch { /* gone */ } }

try {
  await waitFor(async () => {
    try { const r = await fetch(`http://${base}/healthz`); return r.ok; } catch { return false; }
  }, "the relay process to be healthy");
  const health = await (await fetch(`http://${base}/healthz`)).json() as { service?: string; rooms?: number; peers?: number };
  if (health?.service !== "lucid-collab-relay") fail(`unexpected /healthz: ${JSON.stringify(health)}`);
  ok(`spawned \`bun run tools/relay/serve.ts\` on ${base}; /healthz = ${JSON.stringify(health)}`);

  // [2] a real host + real guest connect THROUGH the separate relay process
  const roomId = generateRoomId();
  const rawKey = generateRoomKey();
  const viewLink = formatShareLink(roomId, rawKey);
  const wsUrl = `ws://${base}/r/${roomId}`;

  const host = new CollabHost(new CollabSocket({ wsUrl, role: "host", key: await importRoomKey(rawKey) }), {
    header: { sessionId: "s1", title: "Session over the standalone broker", model: "claude-opus-4-8", hostName: "alice", startedAt: 1000 },
  });
  host.start();
  host.pushUserTurn("does the deployed relay carry us?");

  const link = parseShareLink(viewLink);
  const events: string[] = [];
  const guest = new CollabGuest(new CollabSocket({ wsUrl, role: "guest", key: await importRoomKey(link.key) }), { name: "bob" }, { onEvent: (e) => events.push(e.type) });
  guest.start();

  await waitFor(() => guest.view().phase === "live", "the guest to go live over the broker");
  if (guest.view().header?.title !== "Session over the standalone broker") fail("welcome did not round-trip through the broker");
  await waitFor(() => host.participantCount === 1, "the host to see the guest via the broker");
  ok("a real host + real guest connected THROUGH the separate relay process; the guest got its E2E welcome");

  host.pushEvent({ type: "done", text: "yes - end to end over the deployed broker" });
  await waitFor(() => events.includes("done"), "the live event at the guest");
  ok("a live ChatEvent streamed host -> standalone broker -> guest");

  // [3] the broker now reports a live room + peers on /healthz
  const busy = await (await fetch(`http://${base}/healthz`)).json() as { rooms?: number; peers?: number };
  if (busy.rooms !== 1 || (busy.peers ?? 0) < 2) fail(`broker should show 1 room + >=2 peers, saw ${JSON.stringify(busy)}`);
  ok(`the broker's /healthz reflects the live session (rooms=${busy.rooms}, peers=${busy.peers}) - counts only, never content`);

  host.stop("host ended the session");
  await waitFor(() => guest.view().phase === "ended", "the guest to end on stop");
  ok("host stopped; the guest ended cleanly - the deployed broker relayed the whole session");

  await cleanup();
  console.log("\nP-COLLAB.9 demo complete - the standalone relay broker carries a real host<->guest session end-to-end. Deploy it on a box both peers can reach (office server / Ubuntu 24 jumpbox / DGX Spark).");
  process.exit(0);
} catch (e) {
  await cleanup();
  fail(String((e as Error)?.message ?? e));
}
