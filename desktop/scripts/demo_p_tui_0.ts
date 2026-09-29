// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-TUI.0 - the engine discovery seam (ADR-0419).
//
// A terminal client (`lucid hub`, docs/TUI.md) must find a running engine without guessing ports,
// and must never trust a file alone: the ADR-0305 health handshake (nonce echo) decides. This demo
// drives the REAL engine, not a stand-in - it boots desktop/dev.ts headless with a scratch data
// root, then proves end to end:
//   [1] the engine publishes engine-discovery-<port>.json (0600) into LUCID_DATA_ROOT
//   [2] a client verifies it via /api/health + the file's nonce (healthVerdict "ours")
//   [3] TWO clients share the one engine: the file's token opens a token-gated route for both
//   [4] a squatter on the recorded port fails verification (stale file is inert, fail-closed)
//   [5] a clean exit removes the file: SIGTERM on POSIX; on Windows, where kill() is TerminateProcess and
//       no handler runs, the parent watch (LUCID_MAIN_PID, the path the Electron launch really uses),
//       which exits through process.exit(0) and so runs the "exit" handler
//
// Run with: bun run desktop/scripts/demo_p_tui_0.ts

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDiscoveries, verifyDiscovery } from "../engine_discovery.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  \u2717 " + msg); process.exit(1); }
  console.log("  \u2713 " + msg);
}

console.log("== #ADR-0419 P-TUI.0: the engine discovery seam ==\n");

const dataRoot = mkdtempSync(join(tmpdir(), "lucid-tui0-"));
const home = mkdtempSync(join(tmpdir(), "lucid-tui0-home-"));
const repo = join(import.meta.dir, "..", "..");

// A concrete free port: the engine's H2 Origin/Host gate (ADR-0022) checks the Host header against
// its CONFIGURED port, so PORT=0 would 403 every request. Probe-bind, read, release, reuse.
const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
const enginePort = probe.port!;
probe.stop(true);

// Windows: a process the engine watches as its "main" (parent_watch.ts); killing it is the clean exit.
const parent = process.platform === "win32" ? Bun.spawn(["bun", "-e", "setInterval(() => {}, 1_000_000)"], { stdout: "ignore", stderr: "ignore" }) : null;
const engine = Bun.spawn(["bun", join(repo, "desktop", "dev.ts")], {
  cwd: repo,
  env: {
    ...process.env,
    PORT: String(enginePort), // the discovery file, not this script's knowledge, is what a client reads
    LUCID_DATA_ROOT: dataRoot,
    HOME: home, // scratch settings/ledgers; nothing of the operator's ~/.omp is touched
    ...(parent ? { LUCID_MAIN_PID: String(parent.pid), LUCID_PARENT_WATCH_MS: "250" } : {}),
  },
  stdout: "pipe",
  stderr: "pipe",
});

try {
  console.log("[1] the engine publishes its coordinates on boot");
  const deadline = Date.now() + 30_000;
  let found = listDiscoveries(dataRoot);
  while (found.length === 0 && Date.now() < deadline) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 200);
    await promise;
    found = listDiscoveries(dataRoot);
  }
  assert(found.length === 1, `exactly one engine-discovery-<port>.json appeared under LUCID_DATA_ROOT`);
  const { path, discovery } = found[0]!;
  assert(discovery.pid === engine.pid, `the file names the engine's own pid (${discovery.pid})`);
  assert(discovery.port === enginePort, `the file carries the real bound port (${discovery.port})`);
  if (process.platform !== "win32")
    assert((statSync(path).mode & 0o777) === 0o600, "the file is owner-only (0600) - it carries the UI token");

  console.log("\n[2] a client proves the engine is ours via the ADR-0305 handshake");
  assert(await verifyDiscovery(discovery), "GET /api/health echoed the file's nonce -> healthVerdict \"ours\"");

  console.log("\n[3] two clients, one engine: the published token opens a token-gated route for both");
  const info = (n: string) =>
    fetch(`http://127.0.0.1:${discovery.port}/api/build-info`, { headers: { "x-lucid-token": discovery.token } })
      .then(async (r) => ({ n, ok: r.ok, body: (await r.json()) as { ok: boolean } }));
  const [a, b] = await Promise.all([info("client A"), info("client B")]);
  assert(a.ok && a.body.ok, "client A (the would-be GUI) reads /api/build-info with the file's token");
  assert(b.ok && b.body.ok, "client B (the would-be lucid hub) reads it concurrently - same engine, shared state");
  const noToken = await fetch(`http://127.0.0.1:${discovery.port}/api/build-info`);
  assert(noToken.status === 403, "without the token the same route stays forbidden (the file is the handshake, not a bypass)");

  console.log("\n[4] a stale file pointing at a squatted port fails verification");
  if (parent) parent.kill(); else engine.kill("SIGTERM");
  await engine.exited;
  const squatter = Bun.serve({
    port: discovery.port,
    hostname: "127.0.0.1",
    fetch: () => Response.json({ ok: true }), // pre-ADR-0305 shape: no nonce
  });
  try {
    assert(!(await verifyDiscovery(discovery)), "the recycled port answers health but cannot echo the nonce -> not ours, fail-closed");
  } finally {
    squatter.stop(true);
  }

  console.log("\n[5] a clean exit removed the file");
  assert(listDiscoveries(dataRoot).length === 0, `${parent ? "the parent watch" : "SIGTERM"} ran the exit handler; no discovery file is left behind`);

  console.log("\nP-TUI.0 demo: PASS");
} finally {
  try { engine.kill(); } catch { /* already gone */ }
  try { parent?.kill(); } catch { /* already gone */ }
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
