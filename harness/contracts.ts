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
export const AGENT_MODES = [
  "plan",
  "build",
  "general",
  "subagent",
  "replay",
  "security-review",
] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

// ── Execution / sandbox profiles (PRD "Required execution profiles"). ───────
export const EXECUTION_PROFILES = [
  "trusted-local",
  "container-local",
  "remote-runner",
  "read-only-audit",
  "quarantine",
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
