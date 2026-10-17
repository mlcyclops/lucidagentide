// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-CTRL-RO.1a (ADR-0451; design ADR-0449, issue #449) - the read-only controller contract
// sub-step, exactly the ADR-0449 sentence:
//   [1] controller_read is in the frozen EventName contract and emits through the real Telemetry
//       envelope with the stable run/session ids
//   [2] a typo'd controller_* name still raises UnknownEventError and writes nothing (invariant #8)
//   [3] a pairing minted read-only round-trips the 0600 argon2id store: write, reload, flag intact
//   [4] a legacy pairing without the flag loads as not read-only; a hand-edited non-boolean flag makes
//       the store malformed, so every token is refused (fail-closed, the ADR-0438 rule)
//
// Run with: bun run desktop/scripts/demo_p_ctrl_ro_1a.ts

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isEventName } from "../../harness/contracts.ts";
import { Telemetry, UnknownEventError, type TelemetryEvent } from "../../harness/telemetry/events.ts";
import { PairingStore, type Pairing } from "../controller/store.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  \u2717 " + msg); process.exit(1); }
  console.log("  \u2713 " + msg);
}

console.log("== ADR-0451 P-CTRL-RO.1a: controller_read in the frozen contract; the readOnly pairing capability ==\n");

console.log("[1] controller_read emits through the real Telemetry envelope");
const events: TelemetryEvent[] = [];
const tel = new Telemetry({ runId: "run-ro1a", sessionId: "sess-ro1a", sink: (e) => events.push(e) });
assert(isEventName("controller_read"), "controller_read is in the EventName contract");
const rec = tel.emit("controller_read", { pairing: "demo-pairing", tool: "fleet.list_agents", lane_id: "lane-1", bytes: 112, redactions: 0 });
assert(rec.run_id === "run-ro1a" && rec.session_id === "sess-ro1a", "the record carries the stable run/session ids");
assert(events.length === 1 && events[0]!.event === "controller_read", "the sink saw exactly the one record, metadata only");

console.log("\n[2] an unknown name still raises");
let raised = false;
try {
  tel.emit("controller_reed" as never);
} catch (err) {
  if (!(err instanceof UnknownEventError)) { console.error(`  \u2717 wrong error type: ${err}`); process.exit(1); }
  raised = true;
}
assert(raised && events.length === 1, "controller_reed raises UnknownEventError and writes nothing");
assert(!isEventName("controller_readd"), "isEventName refuses a near-miss name");

console.log("\n[3] a read-only pairing round-trips the 0600 store");
const dir = mkdtempSync(join(tmpdir(), "lucid-ro1a-"));
const ws = mkdtempSync(join(tmpdir(), "lucid-ro1a-ws-"));
try {
  const file = join(dir, "controller-pairings.json");
  const store = new PairingStore(file);
  const minted = await store.pair("observer", ws, true);
  if (!minted.ok) { console.error(`  \u2717 pair failed: ${minted.error}`); process.exit(1); }
  assert(minted.pairing.readOnly === true, "minted read-only; the plaintext token exists only in the reply");
  const raw = readFileSync(file, "utf8");
  // The whole secret (base64url may itself contain "_", so never split on it): neither it nor the
  // full token may appear in the store.
  const secret = minted.token.split("_").slice(2).join("_");
  assert(!raw.includes(secret) && !raw.includes(minted.token), "the store never holds the secret");
  assert(JSON.parse(raw).pairings[0].hash.startsWith("$argon2id$") && JSON.parse(raw).pairings[0].readOnly === true, "the store holds the argon2id hash and readOnly: true");
  if (process.platform !== "win32") assert((statSync(file).mode & 0o777) === 0o600, "the store file is 0600");
  const reloaded = await new PairingStore(file).verify(minted.token);
  assert(reloaded?.readOnly === true, "a fresh store over the same file keeps the capability");

  console.log("\n[4] a legacy pairing loads as not read-only; a tampered flag refuses everything");
  const writer = await store.pair("writer", ws);
  if (!writer.ok) { console.error(`  \u2717 pair failed: ${writer.error}`); process.exit(1); }
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { pairings: Pairing[] };
  assert(!("readOnly" in parsed.pairings[1]!), "a pairing minted without the flag persists no field at all");
  assert((await new PairingStore(file).verify(writer.token))?.readOnly === undefined, "it loads as not read-only");
  parsed.pairings[0]!.readOnly = "yes" as never;
  writeFileSync(file, JSON.stringify(parsed), { mode: 0o600 });
  const broken = new PairingStore(file);
  assert((await broken.verify(minted.token)) === null && (await broken.verify(writer.token)) === null, "a non-boolean flag makes the store malformed: every token refused (fail-closed)");
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
}

console.log("\nP-CTRL-RO.1a demo: PASS");
