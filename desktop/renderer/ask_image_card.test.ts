// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/ask_image_card.test.ts - P-ASKLUCID.9 (ADR-0600): the "Edit image" card's rules. Which model
// Confirm uses for none, one, a remembered one and several; the remembered choice; the image a card names;
// and where a long path may break.

import { describe, expect, test } from "bun:test";
import {
  IMAGE_MODEL_KEY,
  IMAGE_MODELS_UNREAD_LINE,
  NO_IMAGE_MODEL_LINE,
  imageCardState,
  imageForAction,
  pathBreakParts,
  pathFileName,
  readSavedImageModel,
  saveImageModel,
  type ImageModelOptionView,
} from "./ask_image_card.ts";

const opt = (id: string, recommended = false): ImageModelOptionView => ({ id, label: `${id} label`, provider: "openai", why: `${id} why`, recommended });
const A = opt("gpt-image-2.6-sunburst", true);
const B = opt("gemini-nano-banana-2.1");
const C = opt("grok-imagine-image-2.0");

function store(initial: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
    key: () => null,
    get length() { return m.size; },
  } as Storage;
}

describe("imageCardState", () => {
  test("none: no key connected, Confirm cannot run and the fix is Settings, Providers", () => {
    expect(imageCardState({ options: [] }, null)).toEqual({ kind: "none", line: NO_IMAGE_MODEL_LINE, settings: true });
    expect(NO_IMAGE_MODEL_LINE).toBe("No image model is connected. Add an OpenAI, Google Gemini or xAI API key in Settings, Providers.");
  });
  test("none: the engine could not be read, or lockdown forbids it, without a Settings button", () => {
    expect(imageCardState(null, null)).toEqual({ kind: "none", line: IMAGE_MODELS_UNREAD_LINE, settings: false });
    expect(imageCardState({ options: [A], blocked: "CUI lockdown is on." }, A.id)).toEqual({ kind: "none", line: "CUI lockdown is on.", settings: false });
  });
  test("one: Confirm runs with it, nothing to ask", () => {
    expect(imageCardState({ options: [B] }, null)).toEqual({ kind: "choice", option: B, others: 0 });
  });
  test("a remembered model that is still usable wins, even when it is not the best", () => {
    expect(imageCardState({ options: [A, B, C] }, C.id)).toEqual({ kind: "choice", option: C, others: 2 });
  });
  test("a remembered model whose key is gone is ignored", () => {
    expect(imageCardState({ options: [B] }, A.id)).toEqual({ kind: "choice", option: B, others: 0 });
    expect(imageCardState({ options: [A, B] }, "gone")).toEqual({ kind: "ask", options: [A, B] });
  });
  test("several and nothing remembered: the card asks, best first", () => {
    const s = imageCardState({ options: [A, B, C] }, null);
    expect(s).toEqual({ kind: "ask", options: [A, B, C] });
    if (s.kind === "ask") expect(s.options[0]!.recommended).toBe(true);
  });
});

describe("the remembered choice", () => {
  test("round-trips through storage under its key", () => {
    const s = store();
    expect(readSavedImageModel(s)).toBeNull();
    saveImageModel(s, B.id);
    expect(s.getItem(IMAGE_MODEL_KEY)).toBe(B.id);
    expect(readSavedImageModel(s)).toBe(B.id);
  });
  test("a malformed value or blocked storage counts as nothing remembered", () => {
    expect(readSavedImageModel(store({ [IMAGE_MODEL_KEY]: "<script>" }))).toBeNull();
    expect(readSavedImageModel({ getItem: () => { throw new Error("blocked"); } })).toBeNull();
    expect(readSavedImageModel(null)).toBeNull();
    expect(() => saveImageModel({ setItem: () => { throw new Error("blocked"); } }, "x")).not.toThrow();
  });
});

describe("imageForAction", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";
  const jpg = "data:image/jpg;base64,/9j/4AA=";
  test("names an image by its 1-based position, without the data: prefix", () => {
    expect(imageForAction([png, jpg], 1)).toEqual({ ok: true, data: "iVBORw0KGgo=", mimeType: "image/png" });
    expect(imageForAction([png, jpg], 2)).toEqual({ ok: true, data: "/9j/4AA=", mimeType: "image/jpeg" });
  });
  test("a position with no image, or no images at all, is an error the user can act on", () => {
    for (const n of [0, 3, -1, 1.5]) expect(imageForAction([png, jpg], n).ok).toBe(false);
    expect(imageForAction(undefined, 1).ok).toBe(false);
  });
  test("something that is not an image data URL is refused", () => {
    expect(imageForAction(["data:text/html;base64,PGI+"], 1)).toEqual({ ok: false, error: "That image could not be read." });
  });
});

describe("paths on a narrow card", () => {
  test("break only after a separator, and join back to the path", () => {
    const win = "C:\\Users\\operator\\.omp\\ask-lucid\\images\\2026-11-15\\m3x-1a2b.png";
    expect(pathBreakParts(win)).toEqual(["C:\\", "Users\\", "operator\\", ".omp\\", "ask-lucid\\", "images\\", "2026-11-15\\", "m3x-1a2b.png"]);
    expect(pathBreakParts(win).join("")).toBe(win);
    const posix = "/home/u/.omp/ask-lucid/images/x.webp";
    expect(pathBreakParts(posix)).toEqual(["/", "home/", "u/", ".omp/", "ask-lucid/", "images/", "x.webp"]);
    expect(pathBreakParts("")).toEqual([]);
  });
  test("the file name is the last part", () => {
    expect(pathFileName("C:\\a\\b\\edit.png")).toBe("edit.png");
    expect(pathFileName("/a/b/edit.jpg")).toBe("edit.jpg");
  });
});
