// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/skills_log.ts — P-IDE.3 (ADR-0029): record skill activations as telemetry.
//
// When a skill is activated from the picker, the GUI emits a `skill_activated` event through the
// canonical Telemetry class (same path desktop/personal.ts uses for its audit events) so the name is
// VALIDATED against the EventName enum (contracts.ts) and lands in the telemetry stream. METADATA ONLY:
// command, name, and source — never the user's prompt or any content. Best-effort: a write failure
// never affects the chat. The GUI can't co-write agent_obs.duckdb (the omp child holds it), so this
// goes to an append-only JSONL like the block log (security_log.ts).

import { join } from "node:path";
import { homedir } from "node:os";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { Telemetry, type EventSink } from "../harness/telemetry/events.ts";

/** Where GUI-emitted telemetry events append (NDJSON; multi-writer-safe append, unlike the DuckDB). */
export const EVENTS_LOG_PATH = join(homedir(), ".omp", "lucid-events.ndjson");

export type SkillSource = "bundled" | "project" | "task";

/** Emit a `skill_activated` telemetry event (metadata only). `sink` is injectable for tests. */
export function recordSkillActivated(
  meta: { command: string; name: string; source: SkillSource },
  sink: string | EventSink = EVENTS_LOG_PATH,
): void {
  try {
    new Telemetry({ runId: Snowflake.next(), sessionId: "gui", sink }).emit("skill_activated", {
      command: meta.command,
      name: meta.name,
      source: meta.source,
    });
  } catch {
    /* telemetry is best-effort; never break skill activation on a write error */
  }
}
