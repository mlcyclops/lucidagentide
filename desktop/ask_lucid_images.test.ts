// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/ask_lucid_images.test.ts - P-ASKLUCID.8: images the user pastes or drops into Ask Lucid.

import { describe, expect, test } from "bun:test";
import { ASK_IMAGE_LIMITS, answerAskLucid, normalizeUserImages, USER_IMAGES_NOTE, type AskDeps } from "./ask_lucid_service.ts";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const JPG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

interface Call { user: string; images: { data: string; mimeType: string }[] }
function deps(reply: (call: Call) => string, refused: string[] = []): { d: AskDeps; calls: Call[] } {
  const calls: Call[] = [];
  const d: AskDeps = {
    fleetStatus: async () => ({ lanes: [] }),
    orbit: () => ({}),
    knowledge: async () => [],
    scan: async () => ({ block: false, reason: "clean" }),
    pinModel: () => ({ ok: true, model: "p/vision-model" }),
    complete: async (_s, user, _m, images) => { const c = { user, images: images ?? [] }; calls.push(c); return reply(c); },
    visionRefused: (m) => refused.includes(m ?? ""),
    noteVisionRefused: (m) => { refused.push(m ?? ""); },
    now: () => 1_800_000_000_000,
  };
  return { d, calls };
}

describe("normalizeUserImages", () => {
  test("keeps base64 PNG, JPEG, WebP and GIF data URLs as completion images, and drops everything else", () => {
    expect(normalizeUserImages([PNG, JPG])).toEqual([{ data: "iVBORw0KGgo=", mimeType: "image/png" }, { data: "/9j/4AAQSkZJRg==", mimeType: "image/jpeg" }]);
    expect(normalizeUserImages(["data:image/svg+xml;base64,PHN2Zz4=", "https://example.com/a.png", 42, { data: "x" }, PNG])).toHaveLength(1);
    expect(normalizeUserImages("not a list")).toEqual([]);
  });
  test("caps the count and the size at the composer's limits", () => {
    expect(normalizeUserImages(Array(ASK_IMAGE_LIMITS.count + 3).fill(PNG))).toHaveLength(ASK_IMAGE_LIMITS.count);
    const big = `data:image/png;base64,${"A".repeat(Math.ceil((ASK_IMAGE_LIMITS.bytes + 3) * 4 / 3))}`;
    expect(normalizeUserImages([big])).toEqual([]);
  });
});

describe("answerAskLucid with the user's images", () => {
  test("they go to the model first, with a harness note, and the reply says they were sent", async () => {
    const { d, calls } = deps(() => "A red square.");
    const r = await answerAskLucid("what is this?", [], d, { images: [PNG, JPG] });
    expect(r.ok).toBe(true);
    expect(r.attached).toBe("sent");
    expect(calls[0]!.images.map((i) => i.mimeType)).toEqual(["image/png", "image/jpeg"]);
    expect(calls[0]!.user).toContain(USER_IMAGES_NOTE);
  });
  test("a model that cannot read images answers from the text, is remembered, and is not sent them again", async () => {
    const refused: string[] = [];
    const { d, calls } = deps((c) => (c.images.length ? 'Provider HTTP 400: {"message":"image input is not supported"}' : "From the text: a question about a picture."), refused);
    const r = await answerAskLucid("what is this?", [], d, { images: [PNG] });
    expect(calls.map((c) => c.images.length)).toEqual([1, 0]);
    expect(r.ok).toBe(true);
    expect(r.attached).toBe("model-refused");
    expect(r.picture).toBeUndefined(); // no screen picture was posted, so nothing is said about one
    const again = await answerAskLucid("and this?", [], d, { images: [PNG] });
    expect(calls.slice(2).map((c) => c.images.length)).toEqual([0]);
    expect(again.attached).toBe("model-refused");
  });
  test("no images: nothing about them in the prompt or the reply", async () => {
    const { d, calls } = deps(() => "ok");
    const r = await answerAskLucid("hi", [], d, { images: [] });
    expect(r.attached).toBeUndefined();
    expect(calls[0]!.user).not.toContain(USER_IMAGES_NOTE);
  });
});
