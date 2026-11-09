// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-HERD-OSC.1 (ADR-0530): what a Program Status terminal (Herdr, Ghostty, Rex) learns from `lucid
// hub`. The LaneStatus vocabulary maps onto the protocol's states, one record per lane plus a root
// that says whether the fleet needs the human; a poll tick that changes nothing writes nothing, a
// lane that leaves the fleet is cleared, and quitting clears every record.

import { describe, expect, test } from "bun:test";
import {
  diffReports, fleetRecords, fleetReports, laneProgramState, laneRecordId, programStatusEnabled,
  ProgramStatusEmitter, ROOT_RECORD,
} from "./hub_program_status.ts";

const lane = (name: string, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ id: `lane-${name}`, name, status, model: "anthropic/claude-sonnet-4-20250514", createdAt: 0, ...extra });

/** The terminal's view of a batch: one entry per report, pairs parsed, title/msg decoded. */
const reports = (bytes: string): Record<string, string>[] =>
  bytes.split("\x1b\\").filter(Boolean).map((r) => {
    expect(r.startsWith("\x1b]7501;")).toBe(true);
    return Object.fromEntries(r.slice(7).split(":").map((p) => {
      const k = p.slice(0, p.indexOf("="));
      const v = p.slice(p.indexOf("=") + 1);
      return [k, k === "title" || k === "msg" ? Buffer.from(v, "base64").toString("utf8") : v];
    }));
  });

describe("laneProgramState: the LaneStatus vocabulary as protocol states", () => {
  test("approval blocks on permission; ready-for-a-prompt is idle, not a question", () => {
    expect(laneProgramState("needs-approval")).toEqual({ state: "blocked", kind: "permission", msg: "Needs your approval" });
    expect(laneProgramState("awaiting-input")).toEqual({ state: "idle", msg: "Ready for a prompt" });
  });
  test("busy, settled, failed and stopped", () => {
    expect(laneProgramState("working").state).toBe("working");
    expect(laneProgramState("starting").state).toBe("working");
    expect(laneProgramState("done").state).toBe("done");
    expect(laneProgramState("error").state).toBe("error");
    expect(laneProgramState("stopped")).toEqual({ state: "idle", msg: "Stopped" });
  });
  test("an unknown status (a newer engine) is idle and says its own name", () => {
    expect(laneProgramState("hibernating")).toEqual({ state: "idle", msg: "hibernating" });
    expect(laneProgramState("")).toEqual({ state: "idle", msg: "Unknown status" });
  });
});

describe("laneRecordId", () => {
  test("a real lane id passes through; anything else is cut to the segment grammar", () => {
    expect(laneRecordId("lane-1a2b3c4d")).toBe("lane-1a2b3c4d");
    expect(laneRecordId("spoke:host/1 a")).toBe("spoke-host-1-a");
    expect(laneRecordId("x".repeat(40))).toBe("x".repeat(32));
    expect(laneRecordId("")).toBe("lane");
  });
});

describe("fleetRecords: one record per lane, then the root", () => {
  test("lane records carry the lane name as title and app=lucid on every report", () => {
    const recs = fleetRecords([lane("api", "working"), lane("web", "needs-approval")]);
    expect([...recs.keys()]).toEqual(["lane-api", "lane-web", ROOT_RECORD]);
    expect(recs.get("lane-web")).toEqual({ state: "blocked", kind: "permission", id: "lane-web", title: "web", app: "lucid", msg: "Needs your approval" });
    expect(recs.get("lane-api")).toEqual({ state: "working", id: "lane-api", title: "api", app: "lucid", msg: "Working" });
  });
  test("root: blocked (with the blocked lane's kind) beats working beats done beats idle", () => {
    const root = (lanes: Record<string, unknown>[]) => fleetRecords(lanes).get(ROOT_RECORD);
    expect(root([lane("a", "working"), lane("b", "needs-approval"), lane("c", "needs-approval")]))
      .toEqual({ state: "blocked", kind: "permission", app: "lucid", msg: "2 lanes need you" });
    expect(root([lane("a", "done"), lane("b", "starting")])).toEqual({ state: "working", app: "lucid", msg: "1 lane working" });
    expect(root([lane("a", "done"), lane("b", "awaiting-input")])).toEqual({ state: "done", app: "lucid", msg: "1 lane finished" });
    expect(root([lane("a", "awaiting-input"), lane("b", "stopped")])).toEqual({ state: "idle", app: "lucid", msg: "2 lanes idle" });
    expect(root([])).toEqual({ state: "idle", app: "lucid", msg: "No lanes" });
  });
  test("failures ride along in the root msg; a fleet of only failures is idle and says so", () => {
    expect(fleetRecords([lane("a", "needs-approval"), lane("b", "error")]).get(ROOT_RECORD)?.msg).toBe("1 lane needs you, 1 lane failed");
    expect(fleetRecords([lane("a", "error"), lane("b", "error")]).get(ROOT_RECORD)).toEqual({ state: "idle", app: "lucid", msg: "2 lanes failed" });
  });
  test("a lane name with control characters or a huge length still makes a valid title", () => {
    const recs = fleetRecords([lane("x", "working", { name: "evil\x1b]0;pwned\x07\nname" }), lane("y", "working", { name: "n".repeat(500) })]);
    expect(recs.get("lane-x")?.title).toBe("evil ]0;pwned name");
    expect(recs.get("lane-y")?.title).toBe("n".repeat(192));
    expect(fleetReports([lane("x", "working", { name: "evil\x1b]0;pwned\x07\nname" })]).size).toBe(2);
  });
  test("two lane ids that cut to the same segment stay two records", () => {
    const recs = fleetRecords([lane("a", "working", { id: "spoke:a" }), lane("b", "working", { id: "spoke/a" })]);
    expect([...recs.keys()]).toEqual(["spoke-a", "spoke-a+2", ROOT_RECORD]);
  });
});

describe("diffReports: only what changed", () => {
  test("an identical snapshot writes nothing", () => {
    const a = fleetReports([lane("api", "working"), lane("web", "done")]);
    expect(diffReports(a, fleetReports([lane("api", "working"), lane("web", "done")]))).toEqual([]);
  });
  test("one lane flips: that lane and the root, nothing else", () => {
    const a = fleetReports([lane("api", "working"), lane("web", "working")]);
    const out = diffReports(a, fleetReports([lane("api", "working"), lane("web", "needs-approval")])).flatMap(reports);
    expect(out.map((r) => r.id ?? "root")).toEqual(["lane-web", "root"]);
    expect(out[1]).toEqual({ state: "blocked", kind: "permission", app: "lucid", msg: "1 lane needs you" });
  });
  test("a lane that leaves the fleet is cleared by id, first; the root follows only if it changed", () => {
    const a = fleetReports([lane("api", "working"), lane("web", "needs-approval")]);
    const out = diffReports(a, fleetReports([lane("api", "working")])).flatMap(reports);
    expect(out).toEqual([{ state: "clear", id: "lane-web" }, { state: "working", app: "lucid", msg: "1 lane working" }]);
    // Leaving a done lane behind a working one: the root still reads "1 lane working", so only the clear.
    const b = fleetReports([lane("api", "working"), lane("web", "done")]);
    expect(diffReports(b, fleetReports([lane("api", "working")])).flatMap(reports)).toEqual([{ state: "clear", id: "lane-web" }]);
  });
  test("the first snapshot reports every record", () => {
    expect(diffReports(new Map(), fleetReports([lane("api", "working")])).flatMap(reports).map((r) => r.id ?? "root")).toEqual(["lane-api", "root"]);
  });
});

describe("ProgramStatusEmitter", () => {
  test("one write per changed batch, none for a repeat, one clear-everything on exit", () => {
    const writes: string[] = [];
    const em = new ProgramStatusEmitter((b) => writes.push(b));
    em.update([lane("api", "working"), lane("web", "awaiting-input")]);
    em.update([lane("api", "working"), lane("web", "awaiting-input")]);
    expect(writes.length).toBe(1);
    expect(reports(writes[0]!).map((r) => `${r.id ?? "root"}=${r.state}`)).toEqual(["lane-api=working", "lane-web=idle", "root=working"]);
    em.update([lane("api", "done")]);
    expect(reports(writes[1]!).map((r) => `${r.id ?? "root"}=${r.state}`)).toEqual(["lane-web=clear", "lane-api=done", "root=done"]);
    em.clear();
    em.clear();
    expect(writes.slice(2)).toEqual(["\x1b]7501;state=clear\x1b\\"]);
  });
  test("a hub that never reported clears nothing on exit", () => {
    const writes: string[] = [];
    new ProgramStatusEmitter((b) => writes.push(b)).clear();
    expect(writes).toEqual([]);
  });
});

describe("programStatusEnabled", () => {
  test("on by default on a TTY; never without one; LUCID_PROGRAM_STATUS=0 turns it off", () => {
    expect(programStatusEnabled({}, true)).toBe(true);
    expect(programStatusEnabled({ LUCID_PROGRAM_STATUS: "1" }, true)).toBe(true);
    expect(programStatusEnabled({}, false)).toBe(false);
    for (const off of ["0", "false", "OFF", "no"]) expect(programStatusEnabled({ LUCID_PROGRAM_STATUS: off }, true)).toBe(false);
  });
});
