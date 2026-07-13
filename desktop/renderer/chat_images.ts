// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/chat_images.ts — P-IMG.1 (ADR-0208): pull image content OUT of a tool result (or an
// agent message) so a generated image renders inline in the chat reply, downloads, and can be pushed to the
// preview panel for markup. Pure (no DOM) so the extraction + limits are unit-testable.
//
// omp surfaces a tool's output over ACP as `tool_call_update.content: ToolCallContent[]`. An image is either
// the ACP-wrapped form `{ type:"content", content:{ type:"image", data:<base64>, mimeType, uri? } }` or the
// bare omp/pi form `{ type:"image", data, mimeType }` (the same block `preview_screenshot` already returns).
// We accept both, VALIDATE every one through the same strict image-data-URL gate the composer uses (so an
// attacker-controlled tool can't smuggle an SVG/script or markup), and cap count + bytes fail-closed.

import { ALLOWED_IMAGE_MIME, base64Bytes, parseImageDataUrl } from "./image_data_url.ts";

/** A validated, renderable image lifted from a tool result. `dataUrl` is safe to set as an `img.src`. */
export interface ChatImage { dataUrl: string; mimeType: string; bytes: number }

// Generated images (a 1024² PNG) run larger than a pasted screenshot, so this cap is more generous than the
// composer's per-attachment limit — but still bounded so one turn can't flood the event stream / DOM.
export const MAX_TOOL_IMAGE_BYTES = 24 * 1024 * 1024; // 24 MB decoded, per image
export const MAX_TOOL_IMAGES = 8; // per tool result

/** Normalize whatever `data`/`uri` an image block carries into a strict, validated image data URL, or null. */
export function imageBlockToDataUrl(block: { data?: unknown; mimeType?: unknown; uri?: unknown }): string | null {
  const mime = typeof block?.mimeType === "string" ? block.mimeType.toLowerCase() : "";
  const data = typeof block?.data === "string" ? block.data.trim() : "";
  const uri = typeof block?.uri === "string" ? block.uri.trim() : "";
  // A data URL may arrive pre-formed in `data` or `uri`; otherwise compose one from raw base64 + mimeType.
  // parseImageDataUrl is the single gate — it accepts only image/(png|jpeg|jpg|webp|gif) + the base64 alphabet
  // and normalizes jpg→jpeg — so we can compose optimistically and let it reject anything malformed.
  const candidate = data.startsWith("data:")
    ? data
    : uri.startsWith("data:")
      ? uri
      : (mime && data)
        ? `data:${mime};base64,${data}`
        : "";
  if (!candidate) return null;
  const parsed = parseImageDataUrl(candidate); // validates mime ∈ {png,jpeg,webp,gif} + base64 alphabet
  return parsed ? `data:${parsed.mimeType};base64,${parsed.base64}` : null;
}

/** Is `item` an image content block (ACP-wrapped or bare)? Returns the inner image block, or null. */
function asImageBlock(item: unknown): { data?: unknown; mimeType?: unknown; uri?: unknown } | null {
  if (!item || typeof item !== "object") return null;
  const it = item as Record<string, unknown>;
  if (it.type === "image") return it;
  // ACP wraps a standard content block as { type:"content", content:{...} }.
  if (it.type === "content" && it.content && typeof it.content === "object") {
    const inner = it.content as Record<string, unknown>;
    if (inner.type === "image") return inner;
  }
  return null;
}

/** Extract every valid image from a tool result content array (ACP ToolCallContent[] or omp content[]).
 *  Non-image parts, malformed blocks and disallowed mimes are dropped (fail-closed); count + size are capped. */
export function extractToolImages(content: unknown): ChatImage[] {
  if (!Array.isArray(content)) return [];
  const out: ChatImage[] = [];
  for (const item of content) {
    if (out.length >= MAX_TOOL_IMAGES) break;
    const block = asImageBlock(item);
    if (!block) continue;
    const dataUrl = imageBlockToDataUrl(block);
    if (!dataUrl) continue;
    const p = parseImageDataUrl(dataUrl);
    if (!p) continue;
    const bytes = base64Bytes(p.base64);
    if (bytes <= 0 || bytes > MAX_TOOL_IMAGE_BYTES) continue;
    out.push({ dataUrl, mimeType: p.mimeType, bytes });
  }
  return out;
}

const EXT_FOR_MIME: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
};

/** A safe download filename for a chat image (no user-controlled path/segments; extension from the mime). */
export function imageFileName(mimeType: string, idx = 0, stem = "lucid-image"): string {
  const ext = EXT_FOR_MIME[(mimeType || "").toLowerCase()] ?? "png";
  const safeStem = (stem || "lucid-image").replace(/[^a-z0-9._-]+/gi, "-").replace(/^[-.]+|[-.]+$/g, "") || "lucid-image";
  const n = Math.max(0, Math.floor(idx)) + 1;
  return `${safeStem}-${n}.${ext}`;
}

/** A self-contained preview-panel wrapper for an image: the image centered on a checkerboard, filling the
 *  frame so the markup canvas overlays it 1:1. Embeds the image as a `data:` URI — which the preview frame's
 *  CSP explicitly allows (`img-src data: blob:`) — so it needs no served side-assets and reaches zero network.
 *  Returns "" for a data URL that fails the strict image gate (fail-closed; the caller then does nothing). */
export function previewImageHtml(dataUrl: string): string {
  const p = parseImageDataUrl(dataUrl);
  if (!p) return "";
  const safe = `data:${p.mimeType};base64,${p.base64}`; // re-serialized from validated parts (no raw passthrough)
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html,body{margin:0;height:100%;background:#111 repeating-conic-gradient(#1b1b1b 0% 25%, #141414 0% 50%) 0/24px 24px}
  .wrap{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box}
  img{max-width:100%;max-height:100%;object-fit:contain;image-rendering:auto;box-shadow:0 2px 24px rgba(0,0,0,.5);border-radius:6px}
</style></head>
<body><div class="wrap"><img src="${safe}" alt="generated image"></div></body></html>`;
}

export { ALLOWED_IMAGE_MIME };
