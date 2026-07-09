// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/relay/serve.ts — P-COLLAB.9 (ADR-0195): the STANDALONE LUCID collab relay broker.
//
// The same dumb-ciphertext-forwarder the desktop embeds (desktop/collab/relay_server.ts), packaged to run
// headless anywhere a coordination point is useful: a local addon on your own box, an office server, or a
// DGX Spark / Ubuntu 24 jumpbox. It is the rendezvous both transports need - the WebSocket relay path AND the
// WebRTC path (which uses the relay only to broker the SDP/ICE handshake, then goes direct P2P).
//
// It stays TypeScript on Bun ON PURPOSE (CLAUDE.md invariant #2: the only Python in this repo is the scanner
// sidecar): the relay logic is already written + tested here, so packaging it is one language and zero new
// surface. A Python/FastAPI relay for a Python-first ops shop is a straightforward reimplementation of the
// same wire protocol and belongs in the private add-on repo (enterprise deployment IP), not here.
//
// SECURITY: forwards only OPAQUE, E2E-sealed envelopes - it never holds a room key, so it cannot read or forge
// a session. Bind + limits are configurable; serve `wss://` directly with TLS_CERT/TLS_KEY, or terminate TLS
// at a reverse proxy (nginx/caddy) and bind loopback. Pair with LUCID's managed `allowedRelays` so clients
// only ever connect to an approved broker.
//
// Run:  bun run tools/relay/serve.ts            (ws://0.0.0.0:8790 by default when run standalone)
//   or: PORT=443 TLS_CERT=/etc/lucid/relay.crt TLS_KEY=/etc/lucid/relay.key bun run tools/relay/serve.ts

import { startRelayServer, type RelayServerOptions } from "../../desktop/collab/relay_server.ts";
import { readFileSync } from "node:fs";

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
// A STANDALONE broker defaults to 0.0.0.0:8790 (it exists to be reached); the DESKTOP embed defaults to
// loopback. `--host`/`--port` or HOST/PORT override.
const host = args.host ?? process.env.HOST ?? "0.0.0.0";
const port = args.port ? Number(args.port) : envInt("PORT", 8790);

const tlsCert = args["tls-cert"] ?? process.env.TLS_CERT;
const tlsKey = args["tls-key"] ?? process.env.TLS_KEY;
let tls: RelayServerOptions["tls"];
if (tlsCert && tlsKey) {
  try { tls = { cert: readFileSync(tlsCert, "utf8"), key: readFileSync(tlsKey, "utf8") }; }
  catch (e) { console.error(`[lucid-relay] cannot read TLS cert/key: ${String((e as Error)?.message ?? e)}`); process.exit(2); }
}

const ts = () => new Date().toISOString();
const log = (m: string, d?: unknown) => console.log(`[lucid-relay] ${ts()} ${m}${d !== undefined ? " " + JSON.stringify(d) : ""}`);

let handle;
try {
  handle = startRelayServer({
    hostname: host,
    port,
    maxRooms: envInt("MAX_ROOMS", 256),
    maxPeersPerRoom: envInt("MAX_PEERS_PER_ROOM", 16),
    maxFrameBytes: envInt("MAX_FRAME_BYTES", 512 * 1024),
    idleTimeoutSec: envInt("IDLE_TIMEOUT_SEC", 120),
    tls,
    onLog: (m, d) => log(m, d),
  });
} catch (e) {
  console.error(`[lucid-relay] failed to start: ${String((e as Error)?.message ?? e)}`);
  process.exit(1);
}

const scheme = tls ? "wss" : "ws";
log(`LUCID collab relay listening on ${scheme}://${host}:${handle.port}  (health: http${tls ? "s" : ""}://${host}:${handle.port}/healthz)`);
log(`forwarding OPAQUE E2E-sealed frames only - the relay never holds a room key`);
if (!tls) log(`serving plain ws:// - terminate TLS at a reverse proxy for wss:// (see tools/relay/README.md)`);

// Periodic liveness line for ops logs (rooms/peers only - never any session content).
const heartbeat = setInterval(() => log("status", { rooms: handle!.roomCount(), peers: handle!.peerCount() }), 60_000);

let shuttingDown = false;
function shutdown(sig: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  log(`${sig} - shutting down (${handle!.roomCount()} rooms open)`);
  try { handle!.stop(); } catch { /* already stopped */ }
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => shutdown(sig));
