// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/telemetry/events.ts
//
// Structured event telemetry -> JSONL. The envelope is the stable contract that
// the P3.2 DuckDB ingestion will read, so it is intentionally small and typed.
//
// Invariant #8 (CLAUDE.md): every event uses a name from the EventName enum;
// emitting an unknown name MUST raise; every event carries run_id, session_id,
// and artifact_id when an artifact is in scope.
// Invariant #9: stable IDs everywhere — run_id/session_id are supplied by the
// caller (reuse omp's Snowflake IDs) and never regenerated here.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { type EventName, isEventName } from "../contracts.ts";

/** The stable JSONL envelope. Extra caller fields are spread in alongside. */
export interface TelemetryEvent {
  /** Stable per-event id (invariant #9); the idempotent key for DuckDB ingestion. */
  event_id: string;
  /** ISO-8601 UTC timestamp. */
  ts: string;
  event: EventName;
  run_id: string;
  session_id: string;
  /** Present whenever an artifact is in scope (invariant #8). */
  artifact_id?: string;
  [field: string]: unknown;
}

/** Fields accepted by emit(); artifact_id is surfaced explicitly. */
export type EmitFields = Record<string, unknown> & { artifact_id?: string };

/** Where events go. Default sink appends NDJSON to a file. */
export type EventSink = (event: TelemetryEvent) => void;

export function fileSink(filePath: string): EventSink {
  let dirReady = false;
  return (event: TelemetryEvent) => {
    if (!dirReady) {
      mkdirSync(dirname(filePath), { recursive: true });
      dirReady = true;
    }
    appendFileSync(filePath, JSON.stringify(event) + "\n", "utf8");
  };
}

export class UnknownEventError extends Error {
  constructor(name: string) {
    super(`unknown event name: ${JSON.stringify(name)} (not in EventName)`);
    this.name = "UnknownEventError";
  }
}

/**
 * Telemetry bound to a run/session context. Construct once per run; `emit`
 * stamps every record with the stable ids and the validated event name.
 */
export class Telemetry {
  readonly #runId: string;
  readonly #sessionId: string;
  readonly #sink: EventSink;
  readonly #now: () => string;

  constructor(opts: {
    runId: string;
    sessionId: string;
    /** A file path (NDJSON) or a custom sink. */
    sink: string | EventSink;
    /** Clock injection for deterministic tests. Defaults to Date.now ISO. */
    now?: () => string;
  }) {
    this.#runId = opts.runId;
    this.#sessionId = opts.sessionId;
    this.#sink = typeof opts.sink === "string" ? fileSink(opts.sink) : opts.sink;
    this.#now = opts.now ?? (() => new Date().toISOString());
  }

  /** Emit one event. Throws UnknownEventError on an off-enum name. Returns the
   *  record actually written (handy for tests/assertions). */
  emit(event: EventName, fields: EmitFields = {}): TelemetryEvent {
    if (!isEventName(event)) {
      // Fail loud: a typo'd event name must never silently vanish.
      throw new UnknownEventError(event);
    }
    const record: TelemetryEvent = {
      event_id: Snowflake.next(),
      ts: this.#now(),
      event,
      run_id: this.#runId,
      session_id: this.#sessionId,
      ...fields,
    };
    this.#sink(record);
    return record;
  }
}
