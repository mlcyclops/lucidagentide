// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/preview_extension.ts — P-PREVIEW.3a (ADR-0096) — DRAFT (needs live omp+Electron verification).
//
// Registers an agent-callable `preview_open` tool so the agent can open a local file it just wrote in
// LUCID's in-app Preview panel — "the agent drives the preview". The tool runs in the omp SUBPROCESS, so it
// only validates + ACKNOWLEDGES; the actual panel-opening is a desktop side effect: the tool_call streams to
// acp_backend over ACP, which detects `preview_open` and drives the renderer (reusing the P-PREVIEW.2
// `preview-available` path — already verified). No cross-process screenshot round-trip here; the agent
// SEEING its own UI (`preview_screenshot` as a multimodal ToolResult image) is P-PREVIEW.3a-shot.
//
// WHY DRAFT — three things can only be confirmed against a live omp + Electron:
//   1. omp actually launches with this `-e` extension (a faulty extension would break startup);
//   2. the EXACT pi.registerTool parameter-schema format the installed omp expects (typebox/arktype/zod —
//      CustomToolAPI injects pi.typebox/pi.arktype/pi.zod; the JSON-schema-ish object below is a placeholder);
//   3. the model actually invokes the tool.
// Everything is defensively wrapped so a registration failure NEVER breaks omp: worst case `preview_open`
// is simply absent and the user still gets auto-on-write preview (P-PREVIEW.2) + the manual panel.

/** Minimal, self-contained checks (no desktop import — this runs in omp's process). The renderer's
 *  resolvePreview is the authoritative gate before anything actually renders; this is belt-and-suspenders. */
const LOCAL_PATH = /^(file:\/\/|[A-Za-z]:[\\/]|\/|~[\\/]|\\\\)/;
const PREVIEWABLE = /\.(html?|svg)$/i;

export default function previewExtension(pi: any): void {
  try {
    if (!pi || typeof pi.registerTool !== "function") return; // older omp / no custom-tool support → no-op
    pi.registerTool({
      name: "preview_open",
      label: "Open in Preview",
      description:
        "Open a LOCAL HTML/SVG file you have written in LUCID's in-app Preview panel so the user can see it " +
        "render. Pass the absolute path to the file. Local files only; the panel re-validates before rendering.",
      // DRAFT: confirm the installed omp's expected schema type here (pi.typebox/pi.arktype/pi.zod). This
      // JSON-schema-ish object is a placeholder; if registerTool rejects it, the catch below keeps omp alive.
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute path to the local .html/.svg file to preview" } },
        required: ["path"],
      },
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
