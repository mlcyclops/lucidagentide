// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_remote_13.ts - P-REMOTE.13 (ADR-0251): the invisible hourly reconnect.
//
// The Cloud Run 60-minute WebSocket cap is DELIBERATE (every reconnect re-presents a fresh identity
// token, ADR-0227) and the socket already buffers outbound frames + re-auths across the flap. This
// increment makes the flap invisible: a transient drop younger than the grace window presents as Live;
// a real outage still surfaces; terminal states are never masked.
//
// Run: bun run desktop/scripts/demo_p_remote_13.ts

import { RECONNECT_GRACE_MS, presentedStatus } from "../collab/pwa_view.ts";
import type { GuestView } from "../collab/guest.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} \u2713`);

console.log("== P-REMOTE.13 (ADR-0251) - the invisible hourly reconnect ==");

const base = { header: null, transcript: [], participants: [], model: "m", contextPct: null, options: null, readOnly: false, note: null };
const flap = { ...base, phase: "reconnecting", note: "connection lost - retrying (idle)" } as unknown as GuestView;

if (presentedStatus(flap, 1000, 1000 + RECONNECT_GRACE_MS - 500).tone !== "live") fail("a young hourly flap must present as Live");
if (presentedStatus(flap, 1000, 1000 + RECONNECT_GRACE_MS + 1).tone !== "wait") fail("a real outage must surface after the grace");
if (presentedStatus(flap, 0, 5000).tone !== "wait") fail("an unknown flap start must be shown honestly");
const ended = { ...base, phase: "ended", note: "session ended" } as unknown as GuestView;
if (presentedStatus(ended, Date.now(), Date.now()).tone !== "ended") fail("terminal states must never be masked");
ok(`grace window ${RECONNECT_GRACE_MS}ms: young flap = Live, outage = amber, terminal never masked`);
ok("the 60-minute cap itself STAYS - hourly fresh-token re-verify is the security feature (ADR-0227)");

console.log("\nALL CHECKS PASSED");
