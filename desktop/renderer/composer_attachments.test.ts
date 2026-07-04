// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/composer_attachments.test.ts — P-VISION.1 (ADR-0136): pasted-image attachments.

import { test, expect, describe } from "bun:test";
import {
  parseImageDataUrl,
  dataUrlToImageBlock,
  base64Bytes,
  acceptAttachment,
  promptImageBlocks,
  thumbStripHtml,
  isAllowedImageMime,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  type Attachment,
} from "./composer_attachments.ts";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="; // tiny, valid shape
const att = (over: Partial<Attachment> = {}): Attachment => ({ id: "att_1", dataUrl: PNG, mimeType: "image/png", bytes: 12, ...over });

describe("parse + validate image data URLs", () => {
  test("accepts png/jpeg/webp/gif; normalizes image/jpg → image/jpeg", () => {
    expect(parseImageDataUrl(PNG)).toEqual({ mimeType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUg==" });
    expect(parseImageDataUrl("data:image/jpg;base64,QUJD")?.mimeType).toBe("image/jpeg");
    expect(parseImageDataUrl("data:image/webp;base64,QUJD")?.mimeType).toBe("image/webp");
  });
  test("rejects non-image, malformed, or non-base64 data URLs (fail-closed)", () => {
    expect(parseImageDataUrl("data:text/html;base64,QUJD")).toBeNull();
    expect(parseImageDataUrl("data:image/svg+xml;base64,QUJD")).toBeNull(); // SVG excluded (script risk)
    expect(parseImageDataUrl("https://x/y.png")).toBeNull();
    expect(parseImageDataUrl('data:image/png;base64,"><script>')).toBeNull(); // no markup can smuggle in
  });
  test("isAllowedImageMime is case-insensitive over the allowlist", () => {
    expect(isAllowedImageMime("IMAGE/PNG")).toBe(true);
    expect(isAllowedImageMime("image/svg+xml")).toBe(false);
  });
});

describe("image content block for omp", () => {
  test("dataUrlToImageBlock strips the prefix → {type:image,data,mimeType}", () => {
    expect(dataUrlToImageBlock(PNG)).toEqual({ type: "image", data: "iVBORw0KGgoAAAANSUhEUg==", mimeType: "image/png" });
    expect(dataUrlToImageBlock("nope")).toBeNull();
  });
  test("promptImageBlocks maps a list, dropping any that fail to parse", () => {
    const blocks = promptImageBlocks([att(), att({ id: "att_2", dataUrl: "bad" })]);
    expect(blocks).toEqual([{ type: "image", data: "iVBORw0KGgoAAAANSUhEUg==", mimeType: "image/png" }]);
  });
});

describe("acceptAttachment limits (fail-closed)", () => {
  test("accepts a valid image and reports its bytes", () => {
    const r = acceptAttachment([], PNG, "att_1", "shot.png");
    expect(r.ok).toBe(true);
    expect(r.attachment).toMatchObject({ id: "att_1", mimeType: "image/png", name: "shot.png" });
  });
  test("rejects a non-image, an over-count set, and an over-size image", () => {
    expect(acceptAttachment([], "data:text/plain;base64,QUJD", "x").ok).toBe(false);
    const full = Array.from({ length: MAX_ATTACHMENTS }, (_, i) => att({ id: `att_${i}` }));
    expect(acceptAttachment(full, PNG, "att_extra").reason).toContain(`${MAX_ATTACHMENTS} images`);
    const big = "data:image/png;base64," + "A".repeat(Math.ceil((MAX_ATTACHMENT_BYTES + 1_000_000) * 4 / 3));
    expect(acceptAttachment([], big, "att_big").reason).toContain("MB");
  });
  test("base64Bytes approximates the decoded size", () => {
    expect(base64Bytes("QUJD")).toBe(3); // "ABC"
    expect(base64Bytes("QQ==")).toBe(1);
  });
});

describe("thumbnail strip (no data URL interpolated)", () => {
  test("renders one thumb + remove button per attachment; the img carries NO src", () => {
    const h = thumbStripHtml([att({ id: "att_1" }), att({ id: "att_2" })]);
    expect(h).toContain('data-att="att_1"');
    expect(h).toContain('data-att-remove="att_2"');
    expect(h).toContain("cx-thumb-img");
    expect(h).not.toContain("src="); // the caller sets img.src as a property; never in the HTML string
    expect(h).not.toContain("data:image"); // the data URL never lands in the markup
  });
  test("empty for no attachments", () => {
    expect(thumbStripHtml([])).toBe("");
  });
  test("escapes a hostile filename in the title (no raw markup)", () => {
    const h = thumbStripHtml([att({ name: '"><img src=x onerror=1>' })]);
    expect(h).not.toContain("<img src=x");
    expect(h).toContain("&lt;img");
  });
});
