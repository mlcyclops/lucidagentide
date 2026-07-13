// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/image_data_url.ts — the strict image-data-URL primitives, shared by the composer's pasted
// attachments (P-VISION.1) and chat/tool-result images (P-IMG.1). Split out so BOTH the DOM renderer AND the
// Bun SERVER (dev.ts, acp_backend.ts) can import them without dragging in DOM-touching modules. Pure, no DOM,
// and safe under `noUncheckedIndexedAccess` (the server tsconfig) — regex groups are all guarded.

// Only image/(png|jpeg|jpg|webp|gif), base64, and the base64 alphabet — so an attacker-controlled string can
// never smuggle quotes/markup even if a data URL is ever interpolated. SVG is deliberately excluded (script).
export const DATA_URL_RE = /^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=]+)$/i;

export const ALLOWED_IMAGE_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

export function isAllowedImageMime(mime: string): boolean {
  return (ALLOWED_IMAGE_MIME as readonly string[]).includes((mime || "").toLowerCase());
}

/** Parse + VALIDATE an image data URL. Returns { mimeType, base64 } or null (rejects non-image / malformed). */
export function parseImageDataUrl(dataUrl: string): { mimeType: string; base64: string } | null {
  const m = DATA_URL_RE.exec((dataUrl || "").trim());
  const rawMime = m?.[1];
  const base64 = m?.[2];
  if (!rawMime || !base64) return null;
  const lower = rawMime.toLowerCase();
  const mime = lower === "image/jpg" ? "image/jpeg" : lower;
  return { mimeType: mime, base64 };
}

/** Approx decoded byte size of a base64 payload (4 chars → 3 bytes, minus padding). */
export function base64Bytes(b64: string): number {
  const len = (b64 || "").length;
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((len * 3) / 4) - pad);
}
