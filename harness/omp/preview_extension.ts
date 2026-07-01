// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/preview_extension.ts — P-PREVIEW.3a (ADR-0096): register an agent-callable `preview_open`
// tool so the agent can open a local file it just wrote in LUCID's in-app Preview panel — "the agent
// drives the preview". This replaces the old workaround where the agent tried browser/bash/eval to view
// its own web apps (all security-gated → DENIED), burning turns and confusing the user with denials.
//
// HOW IT REACHES THE PANEL: the tool runs in omp's SUBPROCESS, which has no channel to the Electron
// renderer — so it only VALIDATES + acknowledges. The actual panel-opening is a desktop side effect:
// the tool_call streams over ACP as a `session/update`, and acp_backend detects it (omp renders the call
// title as `"preview_open: <path>"`) and drives the renderer via the already-verified P-PREVIEW.2
// `preview-available` path. The renderer re-gates the path (resolvePreview → readPreviewFile) before
// anything renders, so a bad path can never escape the sandbox.
//
// CONFIRMED against the installed omp's ExtensionAPI (dist/types/.../extensions/types.d.ts):
//   • `pi.registerTool(ToolDefinition)` IS exposed to `-e` extensions (same API as pi.registerProvider).
//   • `parameters` must be a TSchema — authored here via the injected `pi.typebox` shim, NOT a raw
//     JSON-schema object (the previous draft's placeholder would have been rejected).
//   • `approval` defaults to `"exec"`; we set `"read"` so opening a preview never trips the exec gate.
// Everything is still defensively wrapped: a registration failure NEVER breaks omp launch — worst case
// `preview_open` is simply absent and the user keeps auto-on-write preview (P-PREVIEW.2) + the manual panel.

/** Minimal, self-contained checks (no desktop import — this runs in omp's process). The renderer's
 *  resolvePreview/readPreviewFile is the authoritative gate before anything renders; this is belt-and-braces. */
const LOCAL_PATH = /^(file:\/\/|[A-Za-z]:[\\/]|\/|~[\\/]|\\\\)/;
const PREVIEWABLE = /\.(html?|svg)$/i;

export default function previewExtension(pi: any): void {
  try {
    if (!pi || typeof pi.registerTool !== "function") return; // older omp / no custom-tool support → no-op
    // Author the parameter schema with omp's injected TypeBox shim (a real TSchema). Fall back defensively
    // if the shim is missing on some build — a registration that throws is swallowed below.
    const T = pi.typebox?.Type;
    if (!T) return;
    pi.registerTool({
      name: "preview_open",
      label: "Open in Preview",
      description:
        "Open a LOCAL HTML/SVG file you have written in LUCID's in-app Preview panel so the user can see it " +
        "render. Use this (or just write the .html/.svg file) instead of a browser/bash/eval to show your " +
        "work — those are security-gated. Pass the absolute path; the panel re-validates before rendering.",
      // Read-only from omp's view: it only acknowledges; the desktop opens the (sandboxed) panel. Setting
      // "read" keeps preview_open out of the exec-approval flow so showing a preview is never blocked.
      approval: "read",
      parameters: T.Object({
        path: T.String({ description: "Absolute path to the local .html/.svg file to preview" }),
      }),
      async execute(_toolCallId: string, params: any) {
        const path = String(params?.path ?? "").trim();
        if (!path || !LOCAL_PATH.test(path) || !PREVIEWABLE.test(path)) {
          return { content: [{ type: "text", text: `preview_open: "${path}" is not a local .html/.svg file — nothing to preview.` }], isError: true };
        }
        const name = path.split(/[\\/]/).pop() || path;
        // The desktop opens the panel from this tool_call (acp_backend → renderer). The tool just confirms.
        return { content: [{ type: "text", text: `Opening ${name} in the Preview panel for the user.` }] };
      },
    });
  } catch (e) {
    // Never break omp launch: skip the tool if registration throws (e.g. a schema-format mismatch on this
    // omp version). The gate, chat, and auto-on-write preview all keep working.
    try { process.stderr.write(`\n[LucidAgentIDE] preview_open tool not registered: ${String((e as { message?: unknown })?.message ?? e)}\n`); } catch { /* ignore */ }
  }
}
