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

/** P-PREVIEW.3a-shot (ADR-0096): parse a `data:image/…;base64,…` URL into omp `ImageContent`
 *  (`{ type, data, mimeType }` — the shape the model actually sees), or null if it isn't a valid image
 *  data URL. Pure + exported so it's unit-tested without a live desktop. */
export function previewShotImage(dataUrl: string | null | undefined): { type: "image"; data: string; mimeType: string } | null {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec((dataUrl ?? "").trim());
  const mimeType = m?.[1], data = m?.[2];
  return mimeType && data ? { type: "image", data, mimeType } : null;
}

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

    // P-PREVIEW.3a-shot (ADR-0096): let the agent SEE its own rendered UI. capturePage lives in the Electron
    // process, unreachable from omp's subprocess — so the renderer proactively caches a PNG of the current
    // preview to the desktop after each render, and this tool just FETCHES that cached shot (the desktop
    // hands us a ready URL incl. the transport token via the LUCID_PREVIEW_SHOT_URL env var it inherits).
    // The PNG is returned as ImageContent so the model actually sees it and can self-correct. Read-tier;
    // fetch failures degrade to helpful text (never an exec-gate hit, never a throw).
    pi.registerTool({
      name: "preview_screenshot",
      label: "Screenshot the preview",
      description:
        "Capture a screenshot of the CURRENT in-app preview so you can SEE how your app renders and self-correct. " +
        "Returns an image of what the user sees. Open a preview first (write an .html/.svg, or call preview_open). " +
        "Use this to verify graphics/layout instead of a browser or bash/eval, which are security-gated.",
      approval: "read",
      parameters: T.Object({}),
      async execute() {
        const text = (t: string) => ({ content: [{ type: "text", text: t }] });
        const url = process.env.LUCID_PREVIEW_SHOT_URL;
        if (!url) return text("Preview screenshots aren't available in this environment (the desktop preview isn't running).");
        try {
          const r = await fetch(url);
          if (!r.ok) return text("No preview is open to screenshot yet — write an .html/.svg or call preview_open first, then retry.");
          const body: any = await r.json().catch(() => null);
          // The dev server wraps responses as { ok, data: { png } }; tolerate a top-level { png } too.
          const img = previewShotImage(body?.data?.png ?? body?.png);
          if (!img) return text("No preview screenshot is available yet — open a preview first, then retry.");
          return { content: [img, { type: "text", text: "Screenshot of the current preview (what the user sees)." }] };
        } catch {
          return text("Couldn't capture the preview screenshot.");
        }
      },
    });

    // P-PREVIEW.6b (ADR-0153): let the agent READ the live preview DOM to review its work — text, headings,
    // controls, element details by CSS selector, or captured console errors. The DOM lives in the renderer's
    // opaque-origin sandboxed iframe (unreachable from omp), so this tool GETs LUCID_PREVIEW_INSPECT_URL; the
    // dev server HOLDS the request until the renderer runs the query on the frame (via a postMessage bridge)
    // and posts the result back. READ-ONLY — no clicking/typing/eval (those are a later increment). Read-tier;
    // failures degrade to helpful text.
    pi.registerTool({
      name: "preview_inspect",
      label: "Inspect the preview DOM",
      description:
        "Read the LIVE DOM of the current in-app preview to review your work: the page's text, headings, and " +
        "controls (buttons/links/inputs), OR specific elements by CSS `selector`, OR captured console `errors`. " +
        "Read-only — you cannot click/type/run JS here (yet). Open a preview first (write an .html/.svg or call " +
        "preview_open). This is the way to check your rendered UI instead of a browser or bash/eval (gated).",
      approval: "read",
      parameters: T.Object({
        selector: T.Optional(T.String({ description: "Optional CSS selector — return details of matching elements (tag/text/id/role/rect)" })),
        what: T.Optional(T.String({ description: "'summary' (default: text + headings + controls + errors), 'errors', or 'title'" })),
      }),
      async execute(_toolCallId: string, params: any) {
        const text = (t: string) => ({ content: [{ type: "text", text: t }] });
        const base = process.env.LUCID_PREVIEW_INSPECT_URL;
        if (!base) return text("Preview inspection isn't available in this environment (the desktop preview isn't running).");
        let u: URL;
        try { u = new URL(base); } catch { return text("Preview inspection is misconfigured."); }
        if (params?.selector) u.searchParams.set("selector", String(params.selector).slice(0, 400));
        if (params?.what) u.searchParams.set("what", String(params.what).slice(0, 40));
        try {
          const r = await fetch(u.toString());
          if (!r.ok) return text("No preview is open to inspect yet — write an .html/.svg or call preview_open first, then retry.");
          const body: any = await r.json().catch(() => null);
          const result = body?.data?.result ?? body?.result;
          if (!result) return text("No preview inspection result — open a preview first, then retry.");
          if (result.error) return text(`Preview inspect: ${result.error}`);
          return text("Live preview DOM:\n" + JSON.stringify(result, null, 2).slice(0, 6000));
        } catch {
          return text("Couldn't inspect the preview DOM.");
        }
      },
    });

    // P-PREVIEW.6c (ADR-0153): structured ACTIONS on the live preview — click or type by CSS selector, so the
    // agent can TEST its UI (fill a field, press a button) and then inspect/screenshot the result. Bounded:
    // only these named operations reach the preview (the bridge performs el.click() / sets .value + dispatches
    // input/change) — never arbitrary JS. The preview is sandboxed + egress-blocked, so acting on it is safe.
    const text6c = (t: string) => ({ content: [{ type: "text", text: t }] });
    const act = async (action: string, selector: string, value?: string) => {
      const base = process.env.LUCID_PREVIEW_ACT_URL;
      if (!base) return text6c("Preview actions aren't available in this environment (the desktop preview isn't running).");
      if (!selector.trim()) return text6c(`preview_${action}: a CSS selector is required.`);
      let u: URL;
      try { u = new URL(base); } catch { return text6c("Preview actions are misconfigured."); }
      u.searchParams.set("action", action);
      u.searchParams.set("selector", selector.slice(0, 400));
      if (value != null) u.searchParams.set("value", String(value).slice(0, 2000));
      try {
        const r = await fetch(u.toString());
        if (!r.ok) return text6c("No preview is open — write an .html/.svg or call preview_open first, then retry.");
        const body: any = await r.json().catch(() => null);
        const res = body?.data?.result ?? body?.result;
        if (!res) return text6c("No result — open a preview first, then retry.");
        if (res.error) return text6c(`preview_${action}: ${res.error}`);
        const on = res.on?.tag ? `<${res.on.tag}${res.on.id ? " #" + res.on.id : ""}>` : selector;
        return text6c(`Did ${action} on ${on}${res.value ? ` (typed "${res.value}")` : ""}. The preview updated — screenshot or preview_inspect it to see the effect.`);
      } catch { return text6c(`Couldn't ${action} on the preview.`); }
    };
    pi.registerTool({
      name: "preview_click",
      label: "Click in the preview",
      description:
        "Click an element in the LIVE preview by CSS `selector` (e.g. a button or link) to test your UI, then " +
        "screenshot or preview_inspect to see what happened. Open a preview first. Structured action — no JS.",
      approval: "read",
      parameters: T.Object({ selector: T.String({ description: "CSS selector of the element to click" }) }),
      async execute(_toolCallId: string, params: any) { return act("click", String(params?.selector ?? "")); },
    });
    pi.registerTool({
      name: "preview_type",
      label: "Type in the preview",
      description:
        "Type `text` into an input/textarea/contenteditable in the LIVE preview by CSS `selector` (fires input+change), " +
        "so you can fill a form and test behavior, then screenshot or preview_inspect. Open a preview first. No JS.",
      approval: "read",
      parameters: T.Object({
        selector: T.String({ description: "CSS selector of the input/textarea to type into" }),
        text: T.String({ description: "The text to set as the field's value" }),
      }),
      async execute(_toolCallId: string, params: any) { return act("type", String(params?.selector ?? ""), String(params?.text ?? "")); },
    });
  } catch (e) {
    // Never break omp launch: skip the tool if registration throws (e.g. a schema-format mismatch on this
    // omp version). The gate, chat, and auto-on-write preview all keep working.
    try { process.stderr.write(`\n[LucidAgentIDE] preview_open tool not registered: ${String((e as { message?: unknown })?.message ?? e)}\n`); } catch { /* ignore */ }
  }
}
