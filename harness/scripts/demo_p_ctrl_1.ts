// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_ctrl_1.ts - P-CTRL.1 (ADR-0426; design ADR-0425, issue #449): the seven
// controller_* event names are in the frozen EventName contract, each one emits through the real
// Telemetry envelope with the stable ids, and an unknown name still raises (invariant #8).

import { isEventName } from "../contracts.ts";
import { Telemetry, UnknownEventError, type TelemetryEvent } from "../telemetry/events.ts";

const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

const CONTROLLER_EVENTS = [
  "controller_paired",
  "controller_unpaired",
  "controller_turn_started",
  "controller_turn_blocked",
  "controller_auto_consented",
  "controller_auto_revoked",
  "controller_ruling",
] as const;

const events: TelemetryEvent[] = [];
const tel = new Telemetry({
  runId: "run-pctrl1",
  sessionId: "sess-pctrl1",
  sink: (e) => events.push(e),
});

for (const name of CONTROLLER_EVENTS) {
  if (!isEventName(name)) fail(`${name} is not in the EventName contract`);
  const rec = tel.emit(name, { pairing: "demo-pairing", lane_id: "lane-1" });
  if (rec.run_id !== "run-pctrl1" || rec.session_id !== "sess-pctrl1") {
    fail(`${name} did not carry the stable run/session ids`);
  }
  console.log(`emitted: ${name}`);
}
if (events.length !== CONTROLLER_EVENTS.length) {
  fail(`expected ${CONTROLLER_EVENTS.length} events, sink saw ${events.length}`);
}

// Fail-closed half: a typo'd controller name must raise and write nothing.
let raised = false;
try {
  tel.emit("controller_turn_startd" as never);
} catch (err) {
  if (!(err instanceof UnknownEventError)) fail(`wrong error type: ${err}`);
  raised = true;
}
if (!raised) fail("unknown event name did not raise");
if (events.length !== CONTROLLER_EVENTS.length) fail("a raising emit must write nothing");
if (isEventName("controller_bogus")) fail("isEventName accepted an unknown controller_* name");
console.log("unknown name raises: UnknownEventError, nothing written");

console.log(`PASS: all ${CONTROLLER_EVENTS.length} controller_* names are contract-valid; unknown raises`);
