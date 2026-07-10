// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/contracts.ts
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │  FROZEN CONTRACT (CLAUDE.md). Changing any type here is its own           │
// │  increment + ADR — never a side effect of feature work. If you need one   │
// │  of these shapes elsewhere, IMPORT it; never redefine it locally.         │
// └─────────────────────────────────────────────────────────────────────────┘
//
// This file is pure types + tiny closed-set guards. No omp imports (the only
// place omp's shapes meet ours is tools/result_adapter.ts). No I/O.

// ── Invariant #7: trust labels are a closed set. No other values. ───────────
export const TRUST_LABELS = ["trusted", "untrusted", "suspicious", "quarantined"] as const;
export type TrustLabel = (typeof TRUST_LABELS)[number];

// ── Agent modes (PRD "Required modes"). ─────────────────────────────────────
// "built-agent" (ADR-0133, P-AGENT.1) — an agent authored in the Agent Builder and run inside LUCID; given
// its own mode so its turns are distinctly labeled in provenance/audit, separate from the interactive agent.
export const AGENT_MODES = [
  "plan",
  "build",
  "general",
  "subagent",
  "replay",
  "security-review",
  "built-agent",
] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

// ── Execution / sandbox profiles (PRD "Required execution profiles"). ───────
// "built-agent" (ADR-0133, P-AGENT.1) — the profile a Builder-authored agent runs under; its non-destructive
// audit-mode dry-run reuses the existing "read-only-audit" profile.
export const EXECUTION_PROFILES = [
  "trusted-local",
  "container-local",
  "remote-runner",
  "read-only-audit",
  "quarantine",
  "built-agent",
] as const;
export type ExecutionProfile = (typeof EXECUTION_PROFILES)[number];

// ── Invariant #8: events use exact names; unknown name must raise. ──────────
// Superset of the PRD "Required logged events" plus the lifecycle events the
// harness needs. telemetry/events.ts validates every emit against this set.
export const EVENT_NAMES = [
  // content / security pipeline (PRD)
  "content_ingested",
  "content_scanned",
  "finding_detected",
  "artifact_sanitized",
  "artifact_quarantined",
  "approval_requested",
  "approval_granted",
  "approval_denied",
  "memory_promotion_blocked",
  // ADR-0009 Phase A — distilled facts recalled into a later session (carries run_id/session_id + count).
  "memory_recalled",
  // ADR-0009 Phase B (issue #12) — a prompt/response turn was captured for traceability.
  // METADATA ONLY: turn_id/role/seq/raw_sha256/trust_label/blocked-count — never the text.
  "turn_captured",
  "remote_run_blocked",
  "safe_export_created",
  "incident_bundle_created",
  // harness lifecycle
  "run_started",
  "run_finished",
  "tool_call_blocked",
  // personalization knowledge graph (ADR-0010, P9.1) — opt-in, encrypted-at-rest
  "personal_store_unlocked",
  // P9.2 — auto-distilled user facts + scope-aware recall
  "personal_fact_learned",
  "personal_recall_injected",
  // P9.3 — user edits the knowledge graph
  "personal_fact_forgotten",
  // P9.4 — audited decrypt→export of the personalization KG to an Obsidian vault,
  // plus the loud, NARA-aligned CUI-compartment archive (records-management) path.
  "personal_vault_exported",
  "personal_cui_archived",
  // P9.5a — hard CUI isolation: the separate, independently-unlocked CUI store (ADR-0014).
  "personal_cui_store_unlocked",
  // P9.5b — audited migration of legacy cui facts into the isolated store, and the loud,
  // NARA-aligned records-destruction action (zeroize key + delete the cui file).
  "personal_cui_migrated",
  "personal_cui_destroyed",
  // P9.7 — import a third-party chat export (ChatGPT / Claude) through the gated distiller.
  "personal_facts_imported",
  // P-MCP.1 (ADR-0020) — an authenticated MCP server was connected (config handed to omp).
  "mcp_server_connected",
  // P-TASK.3/4 (ADR-0028) — proactive subagent delegation: a `task` dispatch was bound to lineage,
  // and a returned subagent result was run through the keystone-#2 promotion gate.
  "subagent_dispatched",
  "subagent_result_gated",
  // P-LOC.1 (ADR-0031) — an AI-authored file mutation that passed the gate was counted into the
  // AI-LOC attribution ledger (lines written per model/repo/identity).
  "ai_edit_recorded",
  // P-IDE.3 (ADR-0029) — a skill was activated from the picker (bundled / project / task proforma).
  // Metadata only: command, name, source — never user content.
  "skill_activated",
  // P-AGENT (ADR-0133) — the Agent Builder lifecycle. Metadata only (spec_id/name/counts/verdict),
  // never spec bodies or user content. `agent_spec_rejected` fires on fail-closed validation;
  // `agent_run_gated` when the security gate blocks a built agent's tool call; `agent_self_edit_blocked`
  // when the self-edit policy (managed ceiling or "off") denies a runtime spec mutation.
  "agent_spec_saved",
  "agent_spec_rejected",
  "agent_built",
  "agent_run_started",
  "agent_run_gated",
  "agent_run_finished",
  "agent_self_edit_blocked",
  // P-CMD.1 (ADR-0146) — user-authored "/" slash commands. Metadata only (name/mode/verdict), never the
  // command body or user content. `command_created` fires when a drafted command passes the gate + is
  // persisted; `command_rejected` when validation/secret-guard/scan blocks it fail-closed.
  "command_created",
  "command_rejected",
  // P-COLLAB.18 (ADR-0204) — live-session collaboration audit trail (share + join lifecycle), for BOTH the
  // relay path and the direct-P2P (WebRTC) path. Metadata ONLY — transport (relay|direct-p2p), access
  // (view|edit), relay source, the OPAQUE random roomId, and a guest's chosen display name — NEVER the room
  // key, invite links, or any session content. `collab_share_started`/`_stopped` bracket a hosted share;
  // `collab_guest_joined`/`_left` record a guest entering/leaving a share (host-authoritative).
  "collab_share_started",
  "collab_share_stopped",
  "collab_guest_joined",
  "collab_guest_left",
] as const;
export type EventName = (typeof EVENT_NAMES)[number];

// ── Severity (shared with the Python scanner sidecar via the IPC contract). ─
export const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

// ── Finding types the scanner can emit (PRD "Required detections"). ─────────
export const FINDING_TYPES = [
  "zero-width",
  "unicode-tag-block",
  "bidi-control",
  "private-use-area",
  "mixed-script-homoglyph",
  "unicode-category-cf",
] as const;
export type FindingType = (typeof FINDING_TYPES)[number];

// ── Scanner finding (ADR-0002 IPC contract; the ONLY shape that crosses the
//    TS↔Python boundary). `codepoint` is "U+XXXX"; `index` is char offset. ───
export interface Finding {
  type: FindingType;
  codepoint: string;
  index: number;
  severity: Severity;
  name?: string;
}

// ── PRD ToolResult (the dataclass from custom_agentic_ide_prd_v3.md, in TS).
//    This is OUR shape. tools/result_adapter.ts converts to/from omp's
//    AgentToolResult. snake_case is kept to match the PRD contract verbatim. ─
export interface ToolResult {
  tool_name: string;
  success: boolean;
  summary: string;
  payload: unknown;
  duration_ms: number;
}

// ── Closed-set guards. Cheap, exact, importable. ────────────────────────────
export function isTrustLabel(v: unknown): v is TrustLabel {
  return typeof v === "string" && (TRUST_LABELS as readonly string[]).includes(v);
}
export function isAgentMode(v: unknown): v is AgentMode {
  return typeof v === "string" && (AGENT_MODES as readonly string[]).includes(v);
}
export function isExecutionProfile(v: unknown): v is ExecutionProfile {
  return typeof v === "string" && (EXECUTION_PROFILES as readonly string[]).includes(v);
}
export function isEventName(v: unknown): v is EventName {
  return typeof v === "string" && (EVENT_NAMES as readonly string[]).includes(v);
}
