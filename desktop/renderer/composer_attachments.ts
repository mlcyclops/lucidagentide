// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/composer_attachments.ts — P-VISION.1 (ADR-0136): pasted / dropped image attachments for
// the composer. Pure (no DOM) so the model + limits are unit-testable. A user can paste a snipping-tool /
// desktop screenshot into the prompt bar; it becomes an Attachment (a validated image data URL), shown as a
// thumbnail above the composer, and — only when the user hits Enter/Send — travels to omp as an image content
// block ({ type:"image", data:<base64>, mimeType }) alongside the text. omp's ACP session/prompt already
// accepts `(text|image)[]` content (the preview_screenshot tool proves the round-trip).

import { esc } from "./format.ts";
// P-IMG.1 (ADR-0208): the strict image-data-URL primitives moved to a shared, server-importable module so
// dev.ts/acp_backend.ts can reuse them without pulling this DOM-touching file into the server typecheck.
// Re-exported here so every existing `import { parseImageDataUrl, ... } from "./composer_attachments.ts"`
// (demos, tests) keeps working unchanged.
import { ALLOWED_IMAGE_MIME, base64Bytes, isAllowedImageMime, parseImageDataUrl } from "./image_data_url.ts";
export { ALLOWED_IMAGE_MIME, base64Bytes, isAllowedImageMime, parseImageDataUrl };

export interface Attachment { id: string; dataUrl: string; mimeType: string; name?: string; bytes: number }
/** The omp/ACP image content block. `data` is base64 WITHOUT the `data:...;base64,` prefix. */
export interface ImageBlock { type: "image"; data: string; mimeType: string }

export const MAX_ATTACHMENTS = 6;
export const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024; // 12 MB decoded, per image

/** The omp image content block for a data URL; null for a bad/non-image URL. */
export function dataUrlToImageBlock(dataUrl: string): ImageBlock | null {
  const p = parseImageDataUrl(dataUrl);
  return p ? { type: "image", data: p.base64, mimeType: p.mimeType } : null;
}

/** Validate a candidate against the type/size/count limits and build an Attachment (fail-closed). */
export function acceptAttachment(existing: Attachment[], dataUrl: string, id: string, name?: string): { ok: boolean; reason?: string; attachment?: Attachment } {
  const p = parseImageDataUrl(dataUrl);
  if (!p) return { ok: false, reason: "only PNG, JPEG, WebP or GIF images can be attached" };
  if ((existing?.length ?? 0) >= MAX_ATTACHMENTS) return { ok: false, reason: `up to ${MAX_ATTACHMENTS} images per message` };
  const bytes = base64Bytes(p.base64);
  if (bytes > MAX_ATTACHMENT_BYTES) return { ok: false, reason: `each image must be under ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB` };
  return { ok: true, attachment: { id, dataUrl, mimeType: p.mimeType, name: name?.trim() || undefined, bytes } };
}

/** The image blocks for the prompt payload (dropping any that fail to parse — fail-closed). */
export function promptImageBlocks(attachments: Attachment[]): ImageBlock[] {
  return (attachments ?? []).map((a) => dataUrlToImageBlock(a.dataUrl)).filter((b): b is ImageBlock => !!b);
}

/** The thumbnail strip: one thumb per attachment with a remove button. The `<img>` has NO src here — the
 *  caller sets `img.src` as a DOM PROPERTY, never interpolating a data URL into an HTML string. */
export function thumbStripHtml(attachments: Attachment[]): string {
  if (!attachments?.length) return "";
  return attachments.map((a) => `<div class="cx-thumb" data-att="${esc(a.id)}" title="${esc(a.name || "pasted image")}">
      <img class="cx-thumb-img" alt="attached image" />
      <button class="cx-thumb-x" data-att-remove="${esc(a.id)}" title="Remove image" aria-label="Remove image">${esc("×")}</button>
    </div>`).join("");
}
