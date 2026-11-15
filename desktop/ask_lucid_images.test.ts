// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/ask_lucid_images.test.ts - P-ASKLUCID.9 (ADR-0600): where edited images live, which file "Save image
// as..." may copy (containment before and after links), the egress verdict for an edit, and the model options.

import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { IMAGE_EDIT_MODELS } from "./image_edit.ts";
import { askLucidDataRoot, askLucidImagesDir, imageEgressVerdict, imageModelOptions, insideDir, saveAsSource, type SaveAsIo } from "./ask_lucid_images.ts";
import { ASK_IMAGE_LIMITS, answerAskLucid, editableImageCount, type AskDeps } from "./ask_lucid_service.ts";

const HOME = resolve("/home/u");
const DIR = askLucidImagesDir(HOME);
const inDir = (...parts: string[]): string => join(DIR, ...parts);

/** Real paths are the asked paths unless `links` maps one elsewhere; `missing` throws; `dirs` are not files. */
function io(opts: { links?: Record<string, string>; missing?: string[]; dirs?: string[] } = {}): SaveAsIo {
  return {
    realpath: (p) => {
      if (opts.missing?.includes(p)) throw new Error("ENOENT");
      return opts.links?.[p] ?? p;
    },
    isFile: (p) => !(opts.dirs ?? []).includes(p),
  };
}

describe("folders", () => {
  test("edited images sit under ~/.omp/ask-lucid/images, beside the attachments, not inside them", () => {
    expect(askLucidDataRoot(HOME)).toBe(join(HOME, ".omp"));
    expect(DIR).toBe(join(HOME, ".omp", "ask-lucid", "images"));
    expect(insideDir(join(HOME, ".omp", "attachments"), DIR)).toBe(false);
  });
  test("insideDir is strict: the folder itself and its siblings are outside", () => {
    expect(insideDir(DIR, inDir("2026-11-15", "a.png"))).toBe(true);
    expect(insideDir(DIR, DIR)).toBe(false);
    expect(insideDir(DIR, join(`${DIR}-evil`, "a.png"))).toBe(false);
    expect(insideDir(DIR, join(DIR, "..", "x.png"))).toBe(false);
  });
});

describe("saveAsSource", () => {
  const ok = inDir("2026-11-15", "abc.png");
  test("an edited image inside the folder is allowed, by its real path", () => {
    expect(saveAsSource(DIR, ok, io())).toEqual({ ok: true, path: ok, name: "abc.png" });
    expect(saveAsSource(DIR, inDir("d", "x.JPG"), io()).ok).toBe(true);
    expect(saveAsSource(DIR, inDir("d", "x.webp"), io()).ok).toBe(true);
  });
  test("anything outside the folder is refused, including traversal", () => {
    expect(saveAsSource(DIR, join(HOME, "secrets", "a.png"), io()).ok).toBe(false);
    expect(saveAsSource(DIR, join(DIR, "..", "..", "a.png"), io()).ok).toBe(false);
    expect(saveAsSource(DIR, join(HOME, ".omp", "attachments", "a.png"), io()).ok).toBe(false);
  });
  test("a relative path, an empty value or a non-string is refused", () => {
    expect(saveAsSource(DIR, "2026-11-15/abc.png", io()).ok).toBe(false);
    expect(saveAsSource(DIR, "", io()).ok).toBe(false);
    expect(saveAsSource(DIR, 42, io()).ok).toBe(false);
    expect(saveAsSource("", ok, io()).ok).toBe(false);
  });
  test("only PNG, JPEG and WebP: the JSON record beside the image is not copyable", () => {
    expect(saveAsSource(DIR, inDir("d", "abc.json"), io()).ok).toBe(false);
    expect(saveAsSource(DIR, inDir("d", "abc.exe"), io()).ok).toBe(false);
  });
  test("a link planted in the folder that resolves outside it is refused", () => {
    const target = join(HOME, ".ssh", "id_rsa.png");
    const r = saveAsSource(DIR, ok, io({ links: { [ok]: target } }));
    expect(r.ok).toBe(false);
  });
  test("a link that resolves to a non-image inside the folder is refused", () => {
    expect(saveAsSource(DIR, ok, io({ links: { [ok]: inDir("d", "abc.json") } })).ok).toBe(false);
  });
  test("a missing file or a folder named like an image is refused", () => {
    expect(saveAsSource(DIR, ok, io({ missing: [ok] }))).toEqual({ ok: false, error: "That image is no longer there." });
    expect(saveAsSource(DIR, ok, io({ dirs: [ok] })).ok).toBe(false);
  });
  test("when the folder itself is a link, containment is checked against where it really is", () => {
    const realDir = resolve("/data/lucid-images");
    const realFile = join(realDir, "d", "abc.png");
    const r = saveAsSource(DIR, ok, io({ links: { [DIR]: realDir, [ok]: realFile } }));
    expect(r).toEqual({ ok: true, path: realFile, name: "abc.png" });
  });
});

describe("imageEgressVerdict", () => {
  const base = { host: "api.openai.com", verdict: "prompt", locked: false, exempt: false };
  test("allow and prompt both pass: the Confirm on the card is the approval", () => {
    expect(imageEgressVerdict({ ...base, verdict: "allow" }).allow).toBe(true);
    expect(imageEgressVerdict(base).allow).toBe(true);
  });
  test("any other verdict blocks", () => {
    expect(imageEgressVerdict({ ...base, verdict: "block" }).allow).toBe(false);
    expect(imageEgressVerdict({ ...base, verdict: "" }).allow).toBe(false);
  });
  test("CUI lockdown blocks a cloud host, even one already allowed", () => {
    const r = imageEgressVerdict({ ...base, verdict: "allow", locked: true });
    expect(r.allow).toBe(false);
    expect(r.reason).toContain("CUI lockdown");
    expect(imageEgressVerdict({ ...base, locked: true, exempt: true }).allow).toBe(true);
  });
  test("the org ceiling blocks: a denied host, or a host outside a managed allow-list", () => {
    expect(imageEgressVerdict({ ...base, verdict: "allow", managed: { deniedHosts: ["API.openai.com"] } }).allow).toBe(false);
    expect(imageEgressVerdict({ ...base, managed: { allowedHosts: ["generativelanguage.googleapis.com"] } }).allow).toBe(false);
    expect(imageEgressVerdict({ ...base, managed: { allowedHosts: ["api.openai.com"] } }).allow).toBe(true);
  });
  test("an unparsed host blocks", () => {
    expect(imageEgressVerdict({ ...base, host: null }).allow).toBe(false);
  });
});

const PNG_URL = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64")}`;

describe("editableImageCount", () => {
  test("counts the user's images that normalize, up to the cap", () => {
    expect(editableImageCount([PNG_URL, PNG_URL])).toBe(2);
    expect(editableImageCount(Array.from({ length: ASK_IMAGE_LIMITS.count + 3 }, () => PNG_URL))).toBe(ASK_IMAGE_LIMITS.count);
  });
  test("stops at the first image that would be dropped, so N means the same picture in the panel", () => {
    expect(editableImageCount([PNG_URL, "not a data url", PNG_URL])).toBe(1);
    expect(editableImageCount(["data:text/plain;base64,aGk=", PNG_URL])).toBe(0);
  });
  test("nothing attached, nothing editable", () => {
    expect(editableImageCount(undefined)).toBe(0);
    expect(editableImageCount("x")).toBe(0);
    expect(editableImageCount([])).toBe(0);
  });
});

describe("answerAskLucid passes the image count to the proposals", () => {
  const edit = { kind: "edit_image", label: "Sunset sky", why: "You asked for a sunset.", params: { image: 1, instruction: "Make the sky a sunset." } };
  const reply = `Here is the change.\n\n\`\`\`lucid-actions\n${JSON.stringify([edit])}\n\`\`\``;
  const deps: AskDeps = {
    fleetStatus: async () => ({ lanes: [] }),
    orbit: () => ({ goal: null }),
    knowledge: async () => [],
    scan: async () => ({ block: false, reason: "clean" }),
    pinModel: () => ({ ok: true, model: "anthropic/claude-haiku-5-5" }),
    complete: async () => reply,
    now: () => 1_800_000_000_000,
  };
  test("an image attached to this question can be named", async () => {
    const r = await answerAskLucid("make the sky a sunset", [], deps, { images: [PNG_URL] });
    expect(r.actions.map((a) => a.kind)).toEqual(["edit_image"]);
  });
  test("with no image attached, the proposal is dropped", async () => {
    const r = await answerAskLucid("make the sky a sunset", [], deps);
    expect(r.actions).toEqual([]);
    expect(r.actionsDropped).toBe(1);
  });
});

describe("imageModelOptions", () => {
  test("keeps the order given and recommends only the first", () => {
    const opts = imageModelOptions([IMAGE_EDIT_MODELS[2]!, IMAGE_EDIT_MODELS[3]!]);
    expect(opts.map((o) => o.id)).toEqual([IMAGE_EDIT_MODELS[2]!.id, IMAGE_EDIT_MODELS[3]!.id]);
    expect(opts.map((o) => o.recommended)).toEqual([true, false]);
    expect(opts[0]).toEqual({ id: IMAGE_EDIT_MODELS[2]!.id, label: IMAGE_EDIT_MODELS[2]!.label, provider: "google", why: IMAGE_EDIT_MODELS[2]!.why, recommended: true });
  });
  test("no models, no options", () => {
    expect(imageModelOptions([])).toEqual([]);
  });
});
