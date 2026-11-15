// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/ask_image_card.ts - P-ASKLUCID.9 (ADR-0600): the pure rules behind the "Edit image" card in
// Ask Lucid. Which model Confirm uses (or why it cannot run), the user's remembered choice, the image a card
// names, and how a long file path may break on a narrow card. No DOM, no requests: the panel renders, the app
// calls the engine.
//
// The remembered choice lives in localStorage (IMAGE_MODEL_KEY), not in the engine: it is a preference of this
// window's user, it carries no secret, and the engine re-checks the model against the keys it holds anyway.

import { parseImageDataUrl } from "./image_data_url.ts";

/** One model the engine can edit with (GET /api/image/models, best first). */
export interface ImageModelOptionView { id: string; label: string; provider: string; why: string; recommended: boolean }
/** The engine's answer: the usable models, or why none may be used (CUI lockdown). */
export interface ImageModelsView { options: ImageModelOptionView[]; blocked?: string }

export const IMAGE_MODEL_KEY = "lucid.asklucid.imageModel.v1";
export const NO_IMAGE_MODEL_LINE = "No image model is connected. Add an OpenAI, Google Gemini or xAI API key in Settings, Providers.";
export const IMAGE_MODELS_UNREAD_LINE = "LUCID could not check which image models are connected. Try again in a moment.";

export type ImageCardState =
  /** Confirm cannot run. `settings`: the fix is a key in Settings, Providers. */
  | { kind: "none"; line: string; settings: boolean }
  /** Confirm runs with `option`. `others`: how many other models could be picked instead. */
  | { kind: "choice"; option: ImageModelOptionView; others: number }
  /** Several models and nothing remembered: the card asks, the recommendation first. */
  | { kind: "ask"; options: ImageModelOptionView[] };

/** PURE: what the card offers. A remembered choice wins while it is still usable; one usable model needs no
 *  question; several and nothing remembered means the card asks. A failed read or a lockdown is "none". */
export function imageCardState(view: ImageModelsView | null, saved: string | null): ImageCardState {
  if (!view || !Array.isArray(view.options)) return { kind: "none", line: IMAGE_MODELS_UNREAD_LINE, settings: false };
  if (view.blocked) return { kind: "none", line: view.blocked, settings: false };
  const options = view.options;
  if (options.length === 0) return { kind: "none", line: NO_IMAGE_MODEL_LINE, settings: true };
  const kept = saved ? options.find((o) => o.id === saved) : undefined;
  if (kept) return { kind: "choice", option: kept, others: options.length - 1 };
  if (options.length === 1) return { kind: "choice", option: options[0]!, others: 0 };
  return { kind: "ask", options: [...options] };
}

/** The remembered model id, or null. Storage that throws counts as nothing remembered. */
export function readSavedImageModel(store: Pick<Storage, "getItem"> | null): string | null {
  try {
    const v = store?.getItem(IMAGE_MODEL_KEY) ?? null;
    return v && /^[A-Za-z0-9._:-]{1,80}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function saveImageModel(store: Pick<Storage, "setItem"> | null, id: string): void {
  try { store?.setItem(IMAGE_MODEL_KEY, id); } catch { /* storage blocked: asked again next time */ }
}

export type ActionImage = { ok: true; data: string; mimeType: string } | { ok: false; error: string };

/** PURE: the image a card names (1-based among the data URLs attached to its question), as the engine takes
 *  it: base64 without the data: prefix, and the type the URL declared (the engine decides by the bytes). */
export function imageForAction(urls: readonly string[] | undefined, n: number): ActionImage {
  const url = Number.isInteger(n) && n >= 1 ? urls?.[n - 1] : undefined;
  if (!url) return { ok: false, error: "The image this card names is no longer in the conversation. Attach it again and ask once more." };
  const p = parseImageDataUrl(url);
  if (!p) return { ok: false, error: "That image could not be read." };
  return { ok: true, data: p.base64, mimeType: p.mimeType };
}

/** PURE: a path cut after each separator, so a narrow card breaks it only between folders, never inside a
 *  name (invariant 11). Joining the parts gives the path back. */
export function pathBreakParts(path: string): string[] {
  return path.match(/[^\\/]*[\\/]+|[^\\/]+$/g) ?? [];
}

/** PURE: the file name at the end of a path. */
export function pathFileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}
