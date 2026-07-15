// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/chat_events.ts — the LUCID session event union, in a DOM-free module.
//
// `ChatEvent` used to live in bridge.ts, but bridge.ts is a DOM file (it touches window/document/fetch).
// Node-side code that only needs the event SHAPE (the collab frames in desktop/collab, reached by the
// harness demos) was dragging bridge.ts — and thus the DOM — into the root, non-DOM typecheck. Splitting
// the pure type out keeps that program DOM-free while bridge.ts re-exports `ChatEvent` unchanged, so every
// existing importer is untouched. Its only non-primitive members come from DOM-free harness modules.

import type { AgentSpec } from "../../harness/agent/spec.ts"; // P-AGENT.2b: Agent Builder spec type
import type { UserCommand } from "../../harness/commands/spec.ts"; // P-CMD.1: user-authored slash commands

export type ChatEvent =
  | { type: "token"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; name: string; detail: string; code?: { path: string; content?: string; oldText?: string; newText?: string; patch?: string } } // P-CHAT.1: inline code/diff preview
  | { type: "tool-image"; images: { dataUrl: string; mimeType: string }[]; tool?: string; title?: string } // P-IMG.1 (ADR-0208): a tool result produced image(s) → render inline + download + push-to-preview
  | { type: "subagent"; id: string; agent: string; title: string; assignments: string[] }
  | { type: "block"; tool: string; reason: string; severity: string; findings: string; id?: string; quarantined?: boolean; command?: string; detail?: string }
  | { type: "permission"; id: string; tool: string; detail: string; options: { optionId: string; name: string; kind?: string }[]; url?: string; egress?: boolean; localFile?: boolean; exec?: boolean; program?: string; reason?: string; danger?: boolean }
  | { type: "preview-available"; path: string } // P-PREVIEW.2 (ADR-0096): the agent wrote a previewable file
  | { type: "preview-activity"; label: string } // P-PREVIEW.6a (ADR-0153): the agent is reviewing/testing the live preview
  | { type: "design-available"; path: string } // P-FIGMA.2 (ADR-0154): the agent wrote/updated DESIGN.md
  | { type: "agent-builder-open"; spec: AgentSpec } // P-AGENT.8.2 (ADR-0134): open the Agent Builder pre-populated
  | { type: "slash-command-created"; command: UserCommand } // P-CMD.1 (ADR-0146): the agent created a user "/" command
  | { type: "usage"; used: number; size: number; cost: number }
  | { type: "slow"; waitedMs: number } // P-STALL.1 (ADR-0186): the provider is silent - the UI shows "still waiting"
  // P-GOAL.1/3 (ADR-0046): /goal loop events (kept in parity with desktop/acp_backend.ts).
  | { type: "goal-memory"; path: string }
  | { type: "goal-iter"; n: number; max: number }
  | { type: "goal-check"; n: number; done: boolean; reason: string }
  | { type: "goal-done"; iters: number; reason: string }
  | { type: "goal-stop"; reason: string }
  // P-GOAL.9 (ADR-0054): the loop's last task - an After-Action Report (metrics + portable graphs).
  | { type: "goal-report"; path: string; summary: string; markdown: string }
  // P-NORESP.1: the model returned NOTHING (no token, thinking, or tool) without erroring — a silent
  // failure, typically an overloaded/oversubscribed gov model. `model` is the id that produced nothing.
  | { type: "no-response"; model: string; stopReason?: string; reason?: string }
  | { type: "done"; text?: string }; // text = the authoritative full assistant reply (reconciles lossy streaming)
