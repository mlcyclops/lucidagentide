// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { artifactGridHtml, creatorImagesHtml, fmtBytes, isArtifactList, type ArtifactView, type CreatorImagesView } from "./creator_images.ts";

const art = (over: Partial<ArtifactView> = {}): ArtifactView => ({
  id: "art1", kind: "image", file: "art1.png", mime: "image/png", bytes: 512 * 1024,
  sha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  createdAt: 10, width: 1024, height: 1024, source: "comfyui http://127.0.0.1:8188",
  prompt: "neon alley at night", model: "sdxl_base.safetensors", sidecars: [], ...over,
});

const view = (over: Partial<CreatorImagesView> = {}): CreatorImagesView => ({
  endpoint: "http://127.0.0.1:8188",
  models: [{ id: "sdxl_base.safetensors", kind: "checkpoint", node: "CheckpointLoaderSimple" }, { id: "wan.safetensors", kind: "diffusion", node: "UNETLoader" }],
  note: "", artifacts: [art()], inputs: [], selected: [], model: "sdxl_base.safetensors",
  prompt: "neon alley", negative: "", busy: "", ...over,
});

describe("the model dropdown (CREATOR-IMG, ADR-0291)", () => {
  test("options come from the probe, with the current one selected and the kind shown", () => {
    const html = creatorImagesHtml(view());
    expect(html).toContain('<option value="sdxl_base.safetensors" selected>');
    expect(html).toContain("wan.safetensors (diffusion)");
    expect(html).toContain("Read live from the ComfyUI install you connected");
  });

  test("no models says so instead of offering a fake default", () => {
    const html = creatorImagesHtml(view({ models: [], endpoint: "" }));
    expect(html).toContain("no models discovered");
    expect(html).toContain("No image provider is connected");
    expect(html).toContain("still work"); // the local builders remain available
  });

  test("a provider note wins over the generic status line", () => {
    expect(creatorImagesHtml(view({ note: "Could not reach ComfyUI at http://x: no answer." }))).toContain("Could not reach ComfyUI");
  });
});

describe("the mixer binds images by ROLE", () => {
  test("each staged input carries an editable role and a remove button", () => {
    const html = creatorImagesHtml(view({ inputs: [{ role: "style", name: "ref.png", dataUrl: "data:image/png;base64,AAA" }] }));
    expect(html).toContain('data-mix-role="0"');
    expect(html).toContain('value="style"');
    expect(html).toContain('data-mix-drop="0"');
    expect(html).toContain("{{image:role}}");
  });

  test("a base64 payload is NEVER interpolated into the markup (the src is set as a DOM property)", () => {
    const html = creatorImagesHtml(view({ inputs: [{ role: "style", name: "ref.png", dataUrl: "data:image/png;base64,SECRETPIXELS" }] }));
    expect(html).not.toContain("SECRETPIXELS");
    expect(html).toContain('data-mix-src="0"');
  });

  test("an empty mixer explains what the mixer is for", () => {
    expect(creatorImagesHtml(view())).toContain("Paste an image into this pane");
  });
});

describe("the provider-free builders", () => {
  test("sheet and GIF need two selections; meme needs one", () => {
    const none = creatorImagesHtml(view({ selected: [] }));
    expect(none).toContain("data-cim-sheet disabled");
    expect(none).toContain("data-cim-gif disabled");
    expect(none).toContain("data-cim-meme disabled");
    const one = creatorImagesHtml(view({ selected: ["art1"] }));
    expect(one).toContain("data-cim-sheet disabled");
    expect(one).toContain("data-cim-meme data-tip"); // enabled: no disabled attribute
    const two = creatorImagesHtml(view({ selected: ["art1", "art2"] }));
    expect(two).not.toContain("data-cim-sheet disabled");
    expect(two).not.toContain("data-cim-gif disabled");
    expect(two).toContain("2 selected");
  });

  test("the builders state plainly that they need no provider", () => {
    expect(creatorImagesHtml(view())).toContain("no provider configured and no network at all");
  });
});

describe("the artifact grid", () => {
  test("a card shows provenance, size, model, and the actions", () => {
    const html = artifactGridHtml(view());
    expect(html).toContain("neon alley at night");
    expect(html).toContain("1024x1024");
    expect(html).toContain("sdxl_base.safetensors");
    expect(html).toContain("abcdef01"); // short sha, full sha in the tooltip
    expect(html).toContain('data-art-preview="art1"');
    expect(html).toContain('data-art-input="art1"');
    expect(html).toContain('data-art-pick="art1"');
  });

  test("image bytes are loaded by DOM property, never interpolated into HTML", () => {
    const html = artifactGridHtml(view());
    expect(html).toContain('data-art-src="art1"');
    expect(html).not.toContain("base64");
  });

  test("selection is reflected for the mouse AND for a screen reader", () => {
    const html = artifactGridHtml(view({ selected: ["art1"] }));
    expect(html).toContain('class="cim-card on"');
    expect(html).toContain('aria-pressed="true"');
  });

  test("kind labels are human, and sidecars are surfaced", () => {
    const html = artifactGridHtml(view({ artifacts: [art({ kind: "sheet", sidecars: ["art1.json", "art1.css"] })] }));
    expect(html).toContain("sprite sheet");
    expect(html).toContain("2 sidecars");
  });

  test("an empty grid explains both paths to a first image", () => {
    const html = artifactGridHtml(view({ artifacts: [] }));
    expect(html).toContain("No images yet");
    expect(html).toContain("sprite sheet, GIF, or meme");
  });

  test("prompts, sources, and model names from anywhere are escaped", () => {
    const html = artifactGridHtml(view({ artifacts: [art({ prompt: "<img src=x onerror=alert(1)>", model: "<script>1</script>" })] }));
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img");
  });
});

describe("shape gate and formatting", () => {
  test("the artifact payload gate rejects junk", () => {
    expect(isArtifactList({ artifacts: [] })).toBe(true);
    expect(isArtifactList({})).toBe(false);
    expect(isArtifactList(null)).toBe(false);
  });

  test("sizes read naturally at every scale", () => {
    expect(fmtBytes(0)).toBe("0 KB");
    expect(fmtBytes(2048)).toBe("2 KB");
    expect(fmtBytes(5 * 1024 * 1024)).toBe("5 MB");
    expect(fmtBytes(48 * 1024 * 1024)).toBe("48 MB");
  });

  test("a null view fails honest", () => {
    expect(creatorImagesHtml(null)).toContain("Nothing was generated");
  });
});
