// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-IMG.1 (ADR-0208): the pure image core — lifting validated images out of a tool result, safe filenames,
// and the self-contained preview wrapper. Over-tested because it is a trust boundary: a tool's output is
// UNTRUSTED, so a malformed / oversized / script-bearing block must be dropped fail-closed, never rendered.

import { describe, expect, test } from "bun:test";
import {
  extractToolImages,
  imageBlockToDataUrl,
  imageFileName,
  previewImageHtml,
  MAX_TOOL_IMAGES,
} from "./chat_images.ts";

// A 1x1 transparent PNG (valid base64, allowed mime).
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;

describe("imageBlockToDataUrl", () => {
  test("bare omp image block (raw base64 + mimeType) → validated data URL", () => {
    expect(imageBlockToDataUrl({ data: PNG_B64, mimeType: "image/png" })).toBe(PNG_DATA_URL);
  });
  test("a pre-formed data URL in `data` is accepted + re-validated", () => {
    expect(imageBlockToDataUrl({ data: PNG_DATA_URL, mimeType: "image/png" })).toBe(PNG_DATA_URL);
  });
  test("a data URL in `uri` is accepted", () => {
    expect(imageBlockToDataUrl({ uri: PNG_DATA_URL })).toBe(PNG_DATA_URL);
  });
  test("image/jpg is normalized to image/jpeg", () => {
    const url = imageBlockToDataUrl({ data: "AAAA", mimeType: "image/jpg" });
    expect(url).toBe("data:image/jpeg;base64,AAAA");
  });
  test("SVG is refused (script risk) — fail-closed", () => {
    expect(imageBlockToDataUrl({ data: "PHN2Zz4=", mimeType: "image/svg+xml" })).toBeNull();
  });
  test("a non-base64 alphabet is refused", () => {
    expect(imageBlockToDataUrl({ data: "not valid !!! base64", mimeType: "image/png" })).toBeNull();
  });
  test("missing data + missing uri → null", () => {
    expect(imageBlockToDataUrl({ mimeType: "image/png" })).toBeNull();
  });
});

describe("extractToolImages", () => {
  test("bare omp content[] with a text + image part → only the image", () => {
    const content = [
      { type: "text", text: "here is your image" },
      { type: "image", data: PNG_B64, mimeType: "image/png" },
    ];
    const out = extractToolImages(content);
    expect(out.length).toBe(1);
    expect(out[0]!.dataUrl).toBe(PNG_DATA_URL);
    expect(out[0]!.mimeType).toBe("image/png");
    expect(out[0]!.bytes).toBeGreaterThan(0);
  });
  test("ACP-wrapped { type:'content', content:{type:'image'} } is unwrapped", () => {
    const content = [{ type: "content", content: { type: "image", data: PNG_B64, mimeType: "image/png" } }];
    expect(extractToolImages(content).length).toBe(1);
  });
  test("mixed valid + invalid blocks: invalid dropped, valid kept (fail-closed)", () => {
    const content = [
      { type: "image", data: PNG_B64, mimeType: "image/png" },
      { type: "image", data: "PHN2Zz4=", mimeType: "image/svg+xml" }, // svg → dropped
      { type: "text", text: "ignored" },
      { type: "diff", path: "x" }, // ACP diff, not an image → dropped
    ];
    expect(extractToolImages(content).length).toBe(1);
  });
  test("non-array / empty input → []", () => {
    expect(extractToolImages(null)).toEqual([]);
    expect(extractToolImages(undefined)).toEqual([]);
    expect(extractToolImages("nope" as unknown)).toEqual([]);
    expect(extractToolImages([])).toEqual([]);
  });
  test(`count is capped at MAX_TOOL_IMAGES (${MAX_TOOL_IMAGES})`, () => {
    const many = Array.from({ length: MAX_TOOL_IMAGES + 5 }, () => ({ type: "image", data: PNG_B64, mimeType: "image/png" }));
    expect(extractToolImages(many).length).toBe(MAX_TOOL_IMAGES);
  });
});

describe("imageFileName", () => {
  test("extension follows the mime; index is 1-based", () => {
    expect(imageFileName("image/png", 0)).toBe("lucid-image-1.png");
    expect(imageFileName("image/jpeg", 2)).toBe("lucid-image-3.jpg");
    expect(imageFileName("image/webp", 0)).toBe("lucid-image-1.webp");
    expect(imageFileName("image/gif", 0)).toBe("lucid-image-1.gif");
  });
  test("unknown mime falls back to .png", () => {
    expect(imageFileName("application/octet-stream", 0)).toBe("lucid-image-1.png");
  });
  test("a path-traversal-ish stem is neutralized (no slashes / dots leak)", () => {
    const name = imageFileName("image/png", 0, "../../etc/passwd");
    expect(name).not.toContain("/");
    expect(name).not.toContain("..");
    expect(name.endsWith(".png")).toBe(true);
  });
});

describe("previewImageHtml", () => {
  test("embeds the validated image as a data: URI (self-contained, CSP-friendly)", () => {
    const html = previewImageHtml(PNG_DATA_URL);
    expect(html).toContain("<img");
    expect(html).toContain(PNG_DATA_URL);
    expect(html.toLowerCase()).toContain("<!doctype html>");
  });
  test("a bad image URL yields empty string (caller then does nothing)", () => {
    expect(previewImageHtml("data:image/svg+xml;base64,PHN2Zz4=")).toBe("");
    expect(previewImageHtml("javascript:alert(1)")).toBe("");
  });
  test("no <script> tag is ever emitted", () => {
    expect(previewImageHtml(PNG_DATA_URL).toLowerCase()).not.toContain("<script");
  });
});
