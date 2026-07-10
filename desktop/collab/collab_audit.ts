// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/collab_audit.ts — P-COLLAB.18 (ADR-0204): the live-collaboration audit trail.
//
// Records the SHARE + JOIN lifecycle of the live-session feature (both the relay path and the direct-P2P
// path) through the canonical Telemetry class (harness/telemetry/events.ts), so every name is VALIDATED
// against the EventName enum (invariant #8) and lands in the same append-only NDJSON as the other GUI audit
// events. METADATA ONLY: the transport, the access level, the relay source, the OPAQUE random roomId, and a
// guest's chosen display name — NEVER the room key, the invite links, or any session content. Best-effort:
// a write failure never breaks a share (a share that can't be audited still works; the loss is a gap, not a
// crash).
//
// The renderer hosts a direct-P2P share itself (RTCPeerConnection is renderer-only) and cannot write the log,
// so it reports its lifecycle through a backend route that calls `recordCollabAudit` with a CLOSED action set
// — the renderer can never name an off-enum event (fail-closed: an unknown action is refused, not emitted).

import { Snowflake } from "@oh-my-pi/pi-utils";
import { Telemetry, type EventSink } from "../../harness/telemetry/events.ts";
import type { EventName } from "../../harness/contracts.ts";
import { EVENTS_LOG_PATH } from "../skills_log.ts"; // the shared GUI audit NDJSON

export type CollabTransport = "relay" | "direct-p2p";
export type CollabAccess = "view" | "edit";

export interface ShareMeta { transport: CollabTransport; access: CollabAccess; roomId?: string; relaySource?: string }
export interface GuestMeta { transport: CollabTransport; access?: CollabAccess; roomId?: string; guest?: string }

const MAX_NAME_LEN = 48;

/** Strip control chars, collapse whitespace, cap length — a guest name is user-chosen, so never trust it raw. */
function cleanName(name: string): string {
  let out = "";
  for (const ch of name) { const c = ch.codePointAt(0) ?? 0; out += (c < 0x20 || c === 0x7f) ? " " : ch; }
  return out.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LEN);
}

function emit(event: EventName, fields: Record<string, unknown>, sink: string | EventSink): void {
  try {
    new Telemetry({ runId: Snowflake.next(), sessionId: "gui", sink }).emit(event, fields);
  } catch {
    /* audit is best-effort — never break a share on a telemetry write / off-enum guard */
  }
}

export function recordCollabShareStarted(m: ShareMeta, sink: string | EventSink = EVENTS_LOG_PATH): void {
  emit("collab_share_started", shareFields(m), sink);
}
export function recordCollabShareStopped(m: ShareMeta, sink: string | EventSink = EVENTS_LOG_PATH): void {
  emit("collab_share_stopped", shareFields(m), sink);
}
export function recordCollabGuestJoined(m: GuestMeta, sink: string | EventSink = EVENTS_LOG_PATH): void {
  emit("collab_guest_joined", guestFields(m), sink);
}
export function recordCollabGuestLeft(m: GuestMeta, sink: string | EventSink = EVENTS_LOG_PATH): void {
  emit("collab_guest_left", guestFields(m), sink);
}

function shareFields(m: ShareMeta): Record<string, unknown> {
  return {
    transport: m.transport,
    access: m.access,
    ...(m.roomId ? { roomId: m.roomId.slice(0, 64) } : {}),
    ...(m.relaySource ? { relaySource: m.relaySource.slice(0, 32) } : {}),
  };
}
function guestFields(m: GuestMeta): Record<string, unknown> {
  return {
    transport: m.transport,
    ...(m.access ? { access: m.access } : {}),
    ...(m.roomId ? { roomId: m.roomId.slice(0, 64) } : {}),
    ...(m.guest && cleanName(m.guest) ? { guest: cleanName(m.guest) } : {}),
  };
}

// ── the renderer P2P bridge (closed action set) ──────────────────────────────

export type CollabAuditAction = "share_started" | "share_stopped" | "guest_joined" | "guest_left";
const ACTION_EVENT: Record<CollabAuditAction, EventName> = {
  share_started: "collab_share_started",
  share_stopped: "collab_share_stopped",
  guest_joined: "collab_guest_joined",
  guest_left: "collab_guest_left",
};
export function isCollabAuditAction(v: unknown): v is CollabAuditAction {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(ACTION_EVENT, v);
}

/**
 * Dispatch a renderer-reported P2P audit action to its telemetry event, sanitizing the metadata to the
 * closed whitelist (never trusting the renderer to pass arbitrary fields, an off-enum name, or content).
 * Returns false (fail-closed) on an unknown action — nothing is emitted for a name we don't recognize.
 */
export function recordCollabAudit(action: unknown, meta: unknown, sink: string | EventSink = EVENTS_LOG_PATH): boolean {
  if (!isCollabAuditAction(action)) return false;
  emit(ACTION_EVENT[action], sanitizeMeta(meta), sink);
  return true;
}

/** Whitelist the audit metadata: only these five known, non-secret fields, type-checked + length-capped. */
function sanitizeMeta(meta: unknown): Record<string, unknown> {
  const m = (meta && typeof meta === "object") ? (meta as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { transport: m.transport === "relay" ? "relay" : "direct-p2p" };
  if (m.access === "edit" || m.access === "view") out.access = m.access;
  if (typeof m.roomId === "string" && m.roomId.trim()) out.roomId = m.roomId.slice(0, 64);
  if (typeof m.relaySource === "string" && m.relaySource.trim()) out.relaySource = m.relaySource.slice(0, 32);
  if (typeof m.guest === "string" && cleanName(m.guest)) out.guest = cleanName(m.guest);
  return out;
}
