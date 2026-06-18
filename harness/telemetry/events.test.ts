// harness/telemetry/events.test.ts
//
// Telemetry contract (invariant #8): exact event names, unknown names raise,
// every event carries the stable envelope.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Telemetry, UnknownEventError, type TelemetryEvent } from "./events.ts";

function collector() {
  const events: TelemetryEvent[] = [];
  const tel = new Telemetry({
    runId: "run-1",
    sessionId: "sess-1",
    sink: (e) => events.push(e),
    now: () => "2026-06-18T00:00:00.000Z",
  });
  return { tel, events };
}

test("emit stamps the stable envelope on every event", () => {
  const { tel, events } = collector();
  tel.emit("run_started", { mode: "build" });
  expect(events).toHaveLength(1);
  const e = events[0]!;
  expect(e.event).toBe("run_started");
  expect(e.run_id).toBe("run-1");
  expect(e.session_id).toBe("sess-1");
  expect(e.ts).toBe("2026-06-18T00:00:00.000Z");
  expect(e.mode).toBe("build");
});

test("artifact_id is carried when an artifact is in scope", () => {
  const { tel, events } = collector();
  tel.emit("content_scanned", { artifact_id: "art-9", verdict: "clean" });
  expect(events[0]!.artifact_id).toBe("art-9");
});

test("unknown event name raises and writes nothing", () => {
  const { tel, events } = collector();
  expect(() => tel.emit("nope_not_real" as never)).toThrow(UnknownEventError);
  expect(events).toHaveLength(0);
});

test("the file sink writes parseable NDJSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "events-test-"));
  try {
    const path = join(dir, "sub", "events.jsonl");
    const tel = new Telemetry({ runId: "r", sessionId: "s", sink: path });
    tel.emit("finding_detected", { artifact_id: "a", finding_type: "zero-width" });
    tel.emit("artifact_quarantined", { artifact_id: "a" });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].event).toBe("finding_detected");
    expect(parsed[1].event).toBe("artifact_quarantined");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("emit returns the written record", () => {
  const { tel } = collector();
  const rec = tel.emit("approval_granted", { user: "nick", scope: "promotion" });
  expect(rec.event).toBe("approval_granted");
  expect(rec.user).toBe("nick");
});
