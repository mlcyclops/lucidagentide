// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/slash_command_extension.ts — P-CMD.1 (ADR-0146): register an agent-callable
// `slash_command_create` tool so the CHAT agent can hand a drafted user "/" command off to LUCID — the user
// describes a shortcut in chat, the agent confirms the specifics (asking refining questions when the ask is
// under-specified), then calls this to CREATE and enable the command.
//
// HOW IT REACHES THE APP: same as agent_builder_open / preview_open. This runs in omp's SUBPROCESS and only
// VALIDATES + acknowledges; the tool_call streams over ACP and acp_backend detects it (slashCommandCreateDraft)
// then authoritatively re-validates + secret-scans + persists the command before enabling it. Fail-closed: an
// invalid or secret-carrying draft is REJECTED here (agent feedback) AND re-checked by acp_backend.
//
// Defensively wrapped: a registration failure NEVER breaks omp launch — worst case the tool is absent and the
// user can still author commands manually.

import { parseDraftedCommand } from "../commands/handoff.ts";

// omp's plugin API is a library boundary whose type isn't exported to us; type the minimal surface we use.
interface TypeBoxType {
  Object: (props: Record<string, unknown>) => unknown;
  String: (opts?: { description?: string }) => unknown;
}
interface ToolResultShape {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}
interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  approval: string;
  parameters: unknown;
  execute: (toolCallId: string, params: unknown) => Promise<ToolResultShape>;
}
interface OmpPluginApi {
  registerTool?: (def: ToolDefinition) => void;
  typebox?: { Type?: TypeBoxType };
}

export default function slashCommandExtension(piRaw: unknown): void {
  try {
    // Assert the minimal omp plugin shape (unexpressible library type; narrowed by the guards below).
    const pi = piRaw as OmpPluginApi;
    if (typeof pi?.registerTool !== "function") return;
    const T = pi.typebox?.Type;
    if (!T) return;
    pi.registerTool({
      name: "slash_command_create",
      label: "Create a slash command",
      description:
        "Create a reusable user '/' slash command in LUCID from a drafted spec, so the user can invoke it by " +
        "typing /<name>. Use this AFTER you've confirmed the specifics in chat (ask refining questions first if " +
        "the request is under-specified — you need a clear name, what it does, and whether it runs as a one-shot " +
        "prompt or activates as a skill). Pass the command as a JSON string in `commandJson`: { name (lowercase " +
        "letters/digits/hyphens, no leading '/'), description (one line), body (the prompt the command runs — use " +
        "$ARGS for the user's trailing text or $1..$9 for positional args), mode ('send' = expand+send the body " +
        "as a turn; 'skill' = activate the body as a persistent instruction) }. NEVER put a secret VALUE (API " +
        "key, password, token) in the body — reference a vault credential by name instead. An invalid or " +
        "secret-carrying draft is rejected so you can fix it.",
      approval: "read", // creating a command never trips the exec gate; the gate scans it authoritatively later
      parameters: T.Object({
        commandJson: T.String({ description: "The drafted command as a JSON string. No secret values." }),
      }),
      async execute(_toolCallId: string, params: unknown): Promise<ToolResultShape> {
        let commandJson = "";
        if (params && typeof params === "object" && "commandJson" in params) {
          const v = params.commandJson; // unknown after `in` narrowing — validate before use
          if (typeof v === "string") commandJson = v;
        }
        const r = parseDraftedCommand(commandJson);
        if (!r.ok) return { content: [{ type: "text", text: `slash_command_create: ${r.message}` }], isError: true };
        return {
          content: [{ type: "text", text: `Creating /${r.command!.name} for the user — it will be available in the "/" menu.` }],
        };
      },
    });
  } catch (e) {
    try {
      const msg = e && typeof e === "object" && "message" in e ? String(e.message) : String(e);
      process.stderr.write(`\n[LucidAgentIDE] slash_command_create tool not registered: ${msg}\n`);
    } catch {
      /* ignore */
    }
  }
}
