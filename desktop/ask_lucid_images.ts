// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/ask_lucid_images.ts - P-ASKLUCID.9 (ADR-0600): the small pure rules around Ask Lucid's edited
// images that the engine route (dev.ts) and the Electron main process (main.ts) share:
//   - where they live: <home>/.omp/ask-lucid/images. ~/.omp is the managed root the attachments use
//     (attachments.ts: the contained agent can read it), but the edited images are the user's results, so they
//     sit beside ~/.omp/attachments and the attachments sweeper never touches them;
//   - which file "Save image as..." may copy out: only a PNG, JPEG or WebP really inside that folder, after
//     links are resolved (the agent can write under ~/.omp, so a planted link must not aim the copy elsewhere);
//   - the egress verdict for one edit request;
//   - the model list the card shows (best first, the first one recommended).
// No disk or network here: the callers pass realpath and stat in.

import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { ImageEditModel } from "./image_edit.ts";

/** The root saveEditedImage writes under (it adds ask-lucid/images/<day>/). */
export function askLucidDataRoot(home: string): string {
  return join(home, ".omp");
}

/** The folder every edited image lands in. */
export function askLucidImagesDir(home: string): string {
  return join(askLucidDataRoot(home), "ask-lucid", "images");
}

export const ASK_LUCID_IMAGE_EXTS: readonly string[] = [".png", ".jpg", ".jpeg", ".webp"];

/** True when `p` is strictly inside `root` (both absolute). */
export function insideDir(root: string, p: string): boolean {
  const rel = relative(resolve(root), resolve(p));
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}

export interface SaveAsIo {
  /** fs.realpathSync: throws when the path does not exist. */
  realpath(p: string): string;
  /** True for a regular file. */
  isFile(p: string): boolean;
}
export type SaveAsSource = { ok: true; path: string; name: string } | { ok: false; error: string };

/** PURE: the file "Save image as..." may copy, or why not. Fail-closed: anything that is not an existing
 *  PNG, JPEG or WebP inside the edited-images folder, both before and after links are resolved, is refused. */
export function saveAsSource(imagesDir: string, requested: unknown, io: SaveAsIo): SaveAsSource {
  const refuse = (error: string): SaveAsSource => ({ ok: false, error });
  const raw = typeof requested === "string" ? requested.trim() : "";
  if (!raw || !isAbsolute(raw) || !imagesDir || !isAbsolute(imagesDir)) return refuse("No edited image was named.");
  const outside = "Only images Ask Lucid edited can be saved this way.";
  if (!insideDir(imagesDir, raw)) return refuse(outside);
  if (!ASK_LUCID_IMAGE_EXTS.includes(extname(raw).toLowerCase())) return refuse("Only PNG, JPEG and WebP images can be saved this way.");
  let real: string;
  let realRoot: string;
  try {
    real = io.realpath(raw);
    realRoot = io.realpath(imagesDir);
  } catch {
    return refuse("That image is no longer there.");
  }
  if (!insideDir(realRoot, real)) return refuse(outside);
  if (!ASK_LUCID_IMAGE_EXTS.includes(extname(real).toLowerCase())) return refuse("Only PNG, JPEG and WebP images can be saved this way.");
  let file = false;
  try { file = io.isFile(real); } catch { file = false; }
  if (!file) return refuse("That image is no longer there.");
  return { ok: true, path: real, name: basename(real) };
}

export interface ImageEgressInput {
  /** The request's host, or null when the URL did not parse. */
  host: string | null;
  /** egressDecisionDetailed(url).verdict. */
  verdict: string;
  /** CUI / AskSage lockdown is on (user or org-managed). */
  locked: boolean;
  /** lockdownEgressExempt(url, ...): loopback or an attested enclave host. */
  exempt: boolean;
  /** The org-managed egress ceiling, when there is one. */
  managed?: { deniedHosts?: readonly string[]; allowedHosts?: readonly string[] } | null;
}

/** PURE: may one edit request leave? The lockdown and the org ceiling block. Otherwise "allow" passes, and
 *  so does "prompt": the user's Confirm on a card that names the model and provider is the approval for this
 *  one request. Any other verdict blocks. */
export function imageEgressVerdict(i: ImageEgressInput): { allow: boolean; reason?: string } {
  const host = (i.host ?? "").trim().toLowerCase();
  if (!host) return { allow: false, reason: "The image service address is not valid." };
  if (i.locked && !i.exempt) return { allow: false, reason: `CUI lockdown is on, so images cannot be sent to ${host}.` };
  const norm = (list: readonly string[] | undefined): string[] => (list ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (norm(i.managed?.deniedHosts).includes(host)) return { allow: false, reason: `Your organization blocks ${host}.` };
  const allowList = norm(i.managed?.allowedHosts);
  if (allowList.length && !allowList.includes(host)) return { allow: false, reason: `Your organization's network allow-list does not include ${host}.` };
  if (i.verdict === "allow" || i.verdict === "prompt") return { allow: true };
  return { allow: false, reason: `Network policy does not allow ${host}.` };
}

/** What the card lists for one model. */
export interface ImageModelOption { id: string; label: string; provider: string; why: string; recommended: boolean }

/** PURE: the card's options, in the order given (availableImageModels: best first); the first is recommended. */
export function imageModelOptions(models: readonly ImageEditModel[]): ImageModelOption[] {
  return models.map((m, i) => ({ id: m.id, label: m.label, provider: m.provider, why: m.why, recommended: i === 0 }));
}
