// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/sandbox_grant_extension.ts — P-SANDBOX.8: register an agent-callable `sandbox_grant_dir`
// tool so the agent can REQUEST standing access to a user-named directory outside the AppContainer's
// granted set (P-SANDBOX.7 fail-closes everything not explicitly ACL-granted).
//
// HOW IT REACHES THE ENGINE: same env-URL bridge as fleet_status (LUCID_FLEET_STATUS_URL). omp is told
// to PROMPT for this tool (acp_config.yml), the desktop shows the approval dialog (acp_backend
// askSandboxGrant) and parks the approved {path,mode} in a one-shot pending slot; only THEN does this
// execute run, POSTing to the token'd LUCID_SANDBOX_GRANT_URL the desktop set before spawn. The endpoint
// re-validates (win32 + helper + existing dir + a matching FRESH approval) before applying the DACL ACE
// via the bundled lucid-appcontainer helper — so this extension never mutates the host itself, and a
// spoofed call without a user approval applies nothing (fail-closed, defense in depth).
//
// Defensively wrapped: a registration failure NEVER breaks omp launch — worst case the tool is absent.

// omp's plugin API is a library boundary whose type isn't exported to us; type the minimal surface we
// use (the fleet_extension convention).
interface TypeBoxType {
  Object: (shape: Record<string, unknown>, opts?: Record<string, unknown>) => unknown;
  String: (opts?: Record<string, unknown>) => unknown;
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

/** Narrow an unknown payload's property without asserting a shape (ts-no-inline-cast-access). */
function prop(v: unknown, key: string): unknown {
  return v && typeof v === "object" && key in v ? (v as Record<string, unknown>)[key] : undefined;
}

export default function sandboxGrantExtension(piRaw: unknown): void {
  try {
    // Assert the minimal omp plugin shape (unexpressible library type; narrowed by the guards below).
    const pi = piRaw as OmpPluginApi;
    if (typeof pi?.registerTool !== "function") return;
    const T = pi.typebox?.Type;
    if (!T) return;
    pi.registerTool({
      name: "sandbox_grant_dir",
      label: "Request directory access",
      description:
        "Request STANDING access to one directory outside your sandbox (the Windows AppContainer denies " +
        "everything not explicitly granted). Use it when the user names a folder they want you to work " +
        "with — a data directory, a second repository — and your reads/writes there fail with access " +
        "denied. The user approves or denies in a dialog; on approval the grant persists until the user " +
        "revokes it in the Security panel. Ask for the NARROWEST directory and mode that unblocks the " +
        "task: mode \"read\" for read-only, \"read-write\" only when you must write there.",
      approval: "exec", // a persistent host DACL mutation; acp_config.yml additionally forces PROMPT
      parameters: T.Object({
        path: T.String({ description: "Absolute path of the existing directory to grant (the narrowest dir that unblocks the task)." }),
        mode: T.String({ description: "\"read\" (read-only) or \"read-write\" (only when writing there is required)." }),
        reason: T.String({ description: "One short sentence for the user: why this directory, and why this mode." }),
      }),
      async execute(_toolCallId: string, params: unknown): Promise<ToolResultShape> {
        const err = (t: string): ToolResultShape => ({ content: [{ type: "text", text: `sandbox_grant_dir: ${t}` }], isError: true });
        const path = String(prop(params, "path") ?? "").trim();
        const mode = String(prop(params, "mode") ?? "").trim();
        const reason = String(prop(params, "reason") ?? "").trim();
        if (!path) return err("`path` is required (the absolute directory to grant).");
        if (mode !== "read" && mode !== "read-write") return err('`mode` must be "read" or "read-write".');
        const url = process.env.LUCID_SANDBOX_GRANT_URL;
        if (!url) return err("the LUCID desktop engine isn't running (no LUCID_SANDBOX_GRANT_URL).");
        let body: unknown;
        try {
          // Generous timeout: the engine may re-run the helper elevated (a UAC prompt the user answers).
          const r = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path, mode, reason }),
            signal: AbortSignal.timeout(120_000),
          });
          if (!r.ok) return err(`the engine responded ${r.status}.`);
          body = await r.json().catch(() => null);
        } catch (e) {
          const msg = e && typeof e === "object" && "message" in e ? String(e.message) : String(e);
          return err(msg || "the engine could not be reached.");
        }
        // The dev server wraps responses as { ok, data: {...} }; tolerate a bare body too (fleet pattern).
        const verdict = prop(body, "data") ?? body;
        const detail = String(prop(verdict, "detail") ?? "no detail");
        if (prop(verdict, "granted") !== true) return err(detail);
        return { content: [{ type: "text", text: `sandbox_grant_dir: ${detail}` }] };
      },
    });
  } catch (e) {
    // Never break omp launch: skip the tool if registration throws.
    try {
      const msg = e && typeof e === "object" && "message" in e ? String(e.message) : String(e);
      process.stderr.write(`\n[LucidAgentIDE] sandbox_grant_dir tool not registered: ${msg}\n`);
    } catch { /* ignore */ }
  }
}
