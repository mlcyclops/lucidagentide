// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/agent_builder_extension.ts — P-AGENT.8.2 (ADR-0134): register an agent-callable
// `agent_builder_open` tool so the CHAT agent can hand a drafted workflow off to LUCID's Agent Builder — the
// user describes a goal in chat, the agent confirms the plan, then calls this to OPEN the canvas pre-populated.
//
// HOW IT REACHES THE CANVAS: same as preview_open (ADR-0096). This runs in omp's SUBPROCESS and only VALIDATES
// + acknowledges; the tool_call streams over ACP and acp_backend detects it (agentBuilderOpenSpec) + drives
// the renderer to open the Agent Builder with the drafted spec. Fail-closed: an invalid or secret-carrying
// draft is REJECTED here (agent feedback) AND re-checked by acp_backend before anything opens.
//
// Defensively wrapped: a registration failure NEVER breaks omp launch — worst case the tool is absent and the
// user opens the Agent Builder manually from the rail.

import { parseDraftedSpec } from "../agent/handoff.ts";

export default function agentBuilderExtension(pi: any): void {
  try {
    if (!pi || typeof pi.registerTool !== "function") return;
    const T = pi.typebox?.Type;
    if (!T) return;
    pi.registerTool({
      name: "agent_builder_open",
      label: "Open the Agent Builder",
      description:
        "Open LUCID's Agent Builder canvas PRE-POPULATED with a drafted agent WORKFLOW so the user can review " +
        "and confirm it. Use this AFTER you've described the plan and confirmed the specifics in chat. Pass the " +
        "drafted Agent Spec as a JSON string in `specJson`: nodes (prompt/tool/subagent/approval) + edges (a " +
        "DAG) + tools (the allow-list) + egress (domains/APIs to reach) + secrets (credential NAMES only, e.g. " +
        "SALESFORCE_API_TOKEN with kind apikey). NEVER put a secret VALUE (password, API key, token) in the " +
        "spec — declare the credential NAME; the user adds the value in LUCID's encrypted vault. A draft that " +
        "embeds a secret, or isn't a valid DAG, is rejected so you can fix it.",
      approval: "read", // opening the canvas never trips the exec gate
      parameters: T.Object({
        specJson: T.String({ description: "The drafted Agent Spec as a JSON string. Credential NAMES only, never secret values." }),
      }),
      async execute(_toolCallId: string, params: any) {
        const r = parseDraftedSpec(String(params?.specJson ?? ""));
        if (!r.ok) return { content: [{ type: "text", text: `agent_builder_open: ${r.message}` }], isError: true };
        return { content: [{ type: "text", text: `Opening the Agent Builder with ${r.message} for the user to review + confirm. Add any needed credentials in the Secrets & connections panel (they go in the vault, not here).` }] };
      },
    });
  } catch (e) {
    try { process.stderr.write(`\n[LucidAgentIDE] agent_builder_open tool not registered: ${String((e as { message?: unknown })?.message ?? e)}\n`); } catch { /* ignore */ }
  }
}
