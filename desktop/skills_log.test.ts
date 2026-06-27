// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/skills_log.test.ts — P-IDE.3 (ADR-0029)
//
// The skill-activation telemetry must validate against the frozen EventName enum and carry only
// metadata (command/name/source) — never user content.

import { describe, expect, it } from "bun:test";
import { recordSkillActivated } from "./skills_log.ts";
import { isEventName } from "../harness/contracts.ts";
import type { TelemetryEvent as Ev } from "../harness/telemetry/events.ts";

describe("recordSkillActivated", () => {
  it("emits a valid skill_activated event with metadata only", () => {
    const got: Ev[] = [];
    recordSkillActivated({ command: "code-review", name: "Code Review", source: "bundled" }, (e) => got.push(e));
    expect(got).toHaveLength(1);
    const e = got[0]!;
    expect(e.event).toBe("skill_activated");
    expect(e.command).toBe("code-review");
    expect(e.name).toBe("Code Review");
    expect(e.source).toBe("bundled");
    // envelope basics + stable id/ts present
    expect(typeof e.event_id).toBe("string");
    expect(typeof e.ts).toBe("string");
    // metadata only — no prompt/content field leaked
    expect("prompt" in e).toBe(false);
    expect("content" in e).toBe(false);
    expect("text" in e).toBe(false);
  });

  it("skill_activated is a member of the frozen EventName enum", () => {
    expect(isEventName("skill_activated")).toBe(true);
  });

  it("records each source kind (bundled / project / task)", () => {
    const got: Ev[] = [];
    for (const source of ["bundled", "project", "task"] as const) {
      recordSkillActivated({ command: "x", name: "X", source }, (e) => got.push(e));
    }
    expect(got.map((e) => e.source)).toEqual(["bundled", "project", "task"]);
  });
});
