// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/attach_ui.ts - P-ATTACH.1 (ADR-0598): files on the three prompt bars (the main composer,
// the fleet lane bars and Ask Lucid).
//
// A file the user adds is read here, handed to the engine (bridge.attachmentStage), which COPIES it into the
// managed folder, extracts its text and scans it fail-closed. Only a file the engine accepted becomes a
// "ready" chip whose id rides the next send; anything refused stays on the bar as a blocked chip the user can
// dismiss. Images are not staged here: they keep each bar's existing image path (ADR-0136).
//
// Layers, top to bottom: the file-type icons and the chip tooltip text (pure), the tray model (pure logic over
// an injected bridge, unit-tested), and the DOM: chips, the tray view, the "+" menu, the drop zone, the file
// picker. Every file name reaches the DOM through textContent or setAttribute, never through innerHTML.

import { ATTACH_EXT, ATTACH_LIMITS, attachExt, attachKindOf, attachRefusal, formatBytes, type AttachKind, type AttachPolicyView, type StagedAttachment, type StageResult } from "../attach_kinds.ts";
import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import { modCombo } from "./platform.ts";
import { tipValue } from "./tip_text.ts"; // P-TIP.1 (ADR-0599): the data-tip format, '|' escaped
import { popover } from "./ui.ts";

// ───────────────────────── the engine seam ─────────────────────────

/** P-ATTACH.1 (ADR-0598): POST /api/attachments/describe. `missing` = ids whose copy is gone. */
export interface AttachDescribeResult { ok: boolean; attachments?: StagedAttachment[]; missing?: string[]; error?: string }

/** The bridge calls this module needs (desktop/renderer/bridge.ts implements them). Injected, so the
 *  tray logic is tested with a fake. */
export interface AttachBridge {
  attachmentStage(f: { name: string; dataBase64: string; mimeType?: string; sourcePath?: string }): Promise<StageResult | null>;
  attachmentRemove(id: string): Promise<boolean>;
  /** Already-staged files by id (a queued prompt brought back). Null = no answer. */
  attachmentDescribe(ids: string[]): Promise<AttachDescribeResult | null>;
  attachmentPolicy(): Promise<AttachPolicyView | null>;
  pathForFile(file: File): string | null;
}

/** The policy as the bars apply it: the managed values, never above ATTACH_LIMITS. */
export type EffectivePolicy = AttachPolicyView;

const OFF: EffectivePolicy = { enabled: false, files: 0, bytes: 0, retentionDays: ATTACH_LIMITS.retentionDays };
const policyCache = new WeakMap<AttachBridge, Promise<EffectivePolicy>>();

/** PURE: clamp a managed policy to the hard limits. A policy can lower a limit, never raise it. */
export function effectivePolicy(p: AttachPolicyView | null): EffectivePolicy {
  if (!p) return OFF;
  const files = Math.max(0, Math.min(Math.floor(p.files), ATTACH_LIMITS.files));
  const bytes = Math.max(0, Math.min(Math.floor(p.bytes), ATTACH_LIMITS.bytes));
  return { enabled: p.enabled === true && files > 0 && bytes > 0, files, bytes, retentionDays: p.retentionDays > 0 ? p.retentionDays : ATTACH_LIMITS.retentionDays };
}

/** The policy, fetched once per bridge. An unreachable engine reads as OFF (fail-closed) and is asked again
 *  next time instead of being cached. */
export function attachPolicy(bridge: AttachBridge): Promise<EffectivePolicy> {
  const hit = policyCache.get(bridge);
  if (hit) return hit;
  const p = bridge.attachmentPolicy().catch(() => null).then((raw) => {
    if (!raw) policyCache.delete(bridge);
    return effectivePolicy(raw);
  });
  policyCache.set(bridge, p);
  return p;
}

// ───────────────────────── file-type icons ─────────────────────────

interface IconSpec { hue: string; glyph: string; lines: boolean }

// One silhouette for every kind: a page with a folded corner, two faint text lines, and a colored band that
// overhangs the left edge carrying the kind's glyph. Hues are fallbacks: styles.css re-colors through
// --fi-h per kind and tints the paper from the theme (--fi-paper), so the icons follow light and dark themes.
const PAGE = "M6.5 2.75h7.4l5.35 5.35V19.5a1.75 1.75 0 0 1-1.75 1.75H6.5a1.75 1.75 0 0 1-1.75-1.75v-15A1.75 1.75 0 0 1 6.5 2.75z";
const FOLD = "M13.9 2.75v3.85a1.5 1.5 0 0 0 1.5 1.5h3.85z";
const LINES = "M7.6 5.9h4.2M7.6 8.6h8.3";
const S = (d: string, w = 1.2): string => `<path d="${d}" fill="none" stroke="#fff" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
const F = (d: string): string => `<path d="${d}" fill="#fff"/>`;

const ICONS: Record<Exclude<AttachKind, "other">, IconSpec> = {
  // P, D, F drawn as strokes: letters this small stay crisp where a font would blur.
  pdf: { hue: "#e5484d", lines: true, glyph: S("M4.9 17.5V13h1.5a1.25 1.25 0 0 1 0 2.5H4.9") + S("M8.4 13v4.5h.9a2.1 2.25 0 0 0 0-4.5z") + S("M12.6 17.5V13h2.3M12.6 15.2h1.9") },
  word: { hue: "#2f6fed", lines: true, glyph: S("M6.65 13.1l1.25 4.3 1.6-3.4 1.6 3.4 1.25-4.3", 1.3) },
  sheet: { hue: "#1f9d55", lines: true, glyph: S("M5.6 13.1h7.8v4.4H5.6zM5.6 15.3h7.8M9.5 13.1v4.4", 1.1) },
  slides: { hue: "#e8692e", lines: true, glyph: S("M11.8 15.3a2.3 2.3 0 1 1-2.3-2.3", 1.2) + F("M9.5 15.3V13a2.3 2.3 0 0 1 2.3 2.3z") },
  markdown: { hue: "#5b6b82", lines: true, glyph: S("M5.4 17.4v-4.2l1.8 2.2 1.8-2.2v4.2") + S("M12.4 13.2v4M10.9 15.8l1.5 1.6 1.5-1.6") },
  text: { hue: "#7c8ba1", lines: true, glyph: S("M5.8 13.4h7.4M5.8 15.3h7.4M5.8 17.2h4.6", 1.1) },
  code: { hue: "#8b5cf6", lines: true, glyph: S("M7.4 13.2l-2 2.1 2 2.1M11.6 13.2l2 2.1-2 2.1M10.3 12.9l-1.6 4.8") },
  data: { hue: "#0ea5a0", lines: true, glyph: S("M7.6 12.9c-.9 0-1.2.4-1.2 1.1v.6c0 .5-.3.8-.8.8.5 0 .8.3.8.8v.6c0 .7.3 1.1 1.2 1.1M11.4 12.9c.9 0 1.2.4 1.2 1.1v.6c0 .5.3.8.8.8-.5 0-.8.3-.8.8v.6c0 .7-.3 1.1-1.2 1.1", 1.1) },
  web: { hue: "#f59e0b", lines: true, glyph: S("M8 13.2l-2.2 2.1 2.2 2.1M11 13.2l2.2 2.1-2.2 2.1") },
  image: { hue: "#ec4899", lines: false, glyph: `<circle cx="12.6" cy="13.7" r=".95" fill="#fff"/>` + F("M4.9 18.4l2.9-3.6 2 2.3 1.3-1.4 2.6 2.7z") },
};
const OTHER_HUE = "#6b7280";

/** PURE: the catch-all glyph: up to four characters of the extension, upper case and escaped; three dots
 *  when there is no extension. */
function otherGlyph(ext: string): string {
  const label = ext.replace(/\s+/g, "").slice(0, 4).toUpperCase();
  if (!label) return `<circle cx="6.8" cy="15.25" r=".85" fill="#fff"/><circle cx="9.5" cy="15.25" r=".85" fill="#fff"/><circle cx="12.2" cy="15.25" r=".85" fill="#fff"/>`;
  const size = label.length <= 2 ? 5.4 : label.length === 3 ? 4.6 : 3.7;
  return `<text class="fi-ext" x="9.5" y="${(15.25 + size * 0.36).toFixed(2)}" text-anchor="middle" font-size="${size}" font-weight="800" font-family="system-ui,-apple-system,Segoe UI,sans-serif" letter-spacing=".15" fill="#fff">${esc(label)}</text>`;
}

/** PURE: the file-type icon for a kind, as inline SVG (24x24 grid, drawn at `size` px; tuned for 16 and 20).
 *  `ext` labels the catch-all icon. An unknown kind string is drawn as the catch-all. */
export function fileIconSvg(kind: AttachKind | string, ext: string, size = 16): string {
  const spec = Object.hasOwn(ICONS, kind) ? ICONS[kind as Exclude<AttachKind, "other">] : null;
  const cls = spec ? kind : "other";
  const hue = spec?.hue ?? OTHER_HUE;
  const glyph = spec?.glyph ?? otherGlyph(ext);
  const lines = spec ? spec.lines : true;
  return `<svg class="fi fi-${cls}" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false">`
    + `<path class="fi-page" d="${PAGE}" fill="#fff" stroke="${hue}" stroke-width="1.1" stroke-linejoin="round"/>`
    + `<path class="fi-fold" d="${FOLD}" fill="${hue}" opacity=".4"/>`
    + (lines ? `<path class="fi-lines" d="${LINES}" fill="none" stroke="${hue}" stroke-width="1.1" stroke-linecap="round" opacity=".45"/>` : "")
    + `<rect class="fi-band" x="2.75" y="11.25" width="13.5" height="8" rx="1.75" fill="${hue}"/>`
    + `<g class="fi-glyph">${glyph}</g></svg>`;
}

/** Every kind the icons distinguish, for tests and for anyone listing them. */
export const ICON_KINDS: readonly AttachKind[] = [...new Set(Object.values(ATTACH_EXT).map((i) => i.kind)), "other"];

// ───────────────────────── chip text ─────────────────────────

export type ChipState = "staging" | "ready" | "blocked" | "sending" | "sent";

/** What a chip shows. A staged attachment fills every field; a file still being staged (or refused) has
 *  what its name and size say. */
export interface ChipView {
  name: string;
  ext: string;
  kind: AttachKind;
  label: string;
  bytes: number;
  sourcePath?: string;
  stagedPath?: string;
  chars?: number;
  truncated?: boolean;
  pages?: number;
  state: ChipState;
  reason?: string;
}

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** PURE: the chip's premium tooltip (a data-tip value): the full file name as the title, then one line each
 *  for where it came from, its type, its size, the managed copy, and its text or why it was blocked. */
export function chipTip(v: ChipView, retentionDays: number = ATTACH_LIMITS.retentionDays): string {
  const lines: string[] = [];
  // A sent chip without a source (a lane turn keeps no paths) has nothing to say about where it came from.
  if (v.sourcePath || v.state !== "sent") lines.push(`Source: ${v.sourcePath || "Not available in the browser"}`);
  lines.push(`Type: ${v.ext ? `.${v.ext} (${v.label})` : v.label}`, `Size: ${formatBytes(v.bytes)}`);
  if (v.stagedPath) lines.push(`Copy: ${v.stagedPath} (kept ${plural(retentionDays, "day", "days")})`);
  if (v.state === "blocked") lines.push(`Blocked: ${v.reason || "It could not be attached."}`);
  else if (v.state === "staging") lines.push("Copying and scanning");
  else if (v.chars !== undefined) {
    if (v.pages) lines.push(`Pages: ${v.pages.toLocaleString("en-US")}`);
    lines.push(`Text: ${plural(v.chars, "character", "characters")}${v.truncated ? " (the prompt carries the first part; the agent can read the rest from the copy)" : ""}`);
  }
  return tipValue(v.name, lines.join("\n"));
}

/** PURE: what a file is from its name alone, before the engine has seen it. */
export function viewOfName(name: string, bytes: number, sourcePath?: string): ChipView {
  const info = attachKindOf(name);
  return { name, ext: attachExt(name), kind: info.kind, label: info.label, bytes, ...(sourcePath ? { sourcePath } : {}), state: "staging" };
}

/** PURE: a staged attachment as a chip view. */
export function viewOfStaged(a: StagedAttachment, state: ChipState = "ready"): ChipView {
  return {
    name: a.name, ext: a.ext, kind: a.kind, label: a.label, bytes: a.bytes, stagedPath: a.stagedPath, chars: a.chars, truncated: a.truncated, state,
    ...(a.sourcePath ? { sourcePath: a.sourcePath } : {}), ...(a.pages ? { pages: a.pages } : {}),
  };
}

/** PURE: the image types a bar's image path takes (ADR-0136). Anything else, an SVG or a HEIC included, is
 *  staged as a file so the engine decides (fail-closed) rather than the image path dropping it. */
export function isRoutedImage(name: string, mime: string): boolean {
  if (!/^image\/(png|jpeg|webp|gif)$/i.test(mime)) return false;
  const ext = attachExt(name);
  return ext === "" || ATTACH_EXT[ext]?.kind === "image";
}

/** PURE: a file inside a hidden folder or itself hidden (".git/...", ".env"), skipped by a folder add. */
export function isHiddenPath(relPath: string): boolean {
  return relPath.split(/[\\/]/).some((seg) => seg.startsWith(".") && seg.length > 1);
}

/** PURE: Ctrl+U (Cmd+U on a Mac) opens the file picker on the focused bar. */
export function isAttachShortcut(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "u";
}

// ───────────────────────── the tray model ─────────────────────────

export type TrayState = "staging" | "ready" | "blocked" | "sending";
export interface TrayItem extends ChipView { key: string; state: TrayState; staged?: StagedAttachment }

export interface TrayDeps {
  bridge: AttachBridge;
  /** The bar's existing image path (ADR-0136): image files go there instead of being staged. */
  onImages(files: File[]): void;
  /** Images already on the bar: they count toward the per-message file limit. */
  imageCount?(): number;
  /** A short note for the user (a folder that was cut short). */
  notify?(text: string): void;
  /** The items changed (repaint, re-evaluate Send). */
  onChange?(): void;
  /** File bytes as base64 (FileReader in the app; injected in tests). */
  readBase64?(file: File): Promise<string>;
}

export interface TrayModel {
  items(): readonly TrayItem[];
  /** Add files: images go to the bar's image path, the rest are staged one by one. Resolves when done. */
  add(files: readonly File[], opts?: { folder?: boolean }): Promise<void>;
  /** The user's x: forget the item, and drop the engine's copy when it was staged. */
  remove(key: string): void;
  /** Ids of the staged files that go with the next send. */
  ids(): string[];
  /** Files staging or ready: what counts toward the per-message limit. */
  count(): number;
  /** Files still being copied and scanned. */
  pending(): number;
  /** Mark the ready files as sending and return them. Settle their ids once the send is accepted or not. */
  hold(): StagedAttachment[];
  /** Accepted: the held files leave the bar. Not accepted: they are ready again for the next try. */
  settle(ids: readonly string[], accepted: boolean): void;
  /** Move the ready files off the bar (to a queued prompt, or parked with another composer target). Blocked
   *  chips are dismissed with them. */
  take(): StagedAttachment[];
  /** Put staged files back on the bar as ready. */
  restore(list: readonly StagedAttachment[]): void;
  /** P-ATTACH.1 (ADR-0598): bring files the engine already staged (a queued prompt pulled back with Update)
   *  onto the bar without uploading them again. Unlike `restore`, the policy and the per-message limit
   *  apply: a file past the limit, over the size limit, or with attachments off lands as a blocked chip. */
  adopt(list: readonly StagedAttachment[]): Promise<{ adopted: number; refused: number }>;
  /** Forget everything on the bar. Copies stay until their retention ends: an agent may still be reading. */
  clear(): void;
  policy(): Promise<EffectivePolicy>;
}

const OFF_REASON = "File attachments are turned off by your organization's policy.";

/** The tray's logic, with no DOM: what is on a bar, what the limits allow, what goes with a send. */
export function createTrayModel(deps: TrayDeps): TrayModel {
  let list: TrayItem[] = [];
  let seq = 0;
  const dropped = new Set<string>(); // keys removed while still staging: their late result is thrown away
  const changed = (): void => deps.onChange?.();
  const read = deps.readBase64 ?? readFileBase64;
  const used = (): number => (deps.imageCount?.() ?? 0) + list.filter((i) => i.state === "staging" || i.state === "ready").length;

  const sourceOf = (f: File): string | undefined => {
    try { return deps.bridge.pathForFile(f) || undefined; } catch { return undefined; }
  };
  const blocked = (f: File, reason: string): TrayItem => ({ ...viewOfName(f.name || "Pasted file", f.size, sourceOf(f)), key: `f${++seq}`, state: "blocked", reason });

  async function stage(item: TrayItem, f: File): Promise<void> {
    let b64: string | null = null;
    try { b64 = await read(f); } catch { /* unreadable: blocked below */ }
    if (dropped.has(item.key)) { dropped.delete(item.key); return; }
    if (b64 === null) { item.state = "blocked"; item.reason = "The file could not be read."; changed(); return; }
    let r: StageResult | null;
    try {
      r = await deps.bridge.attachmentStage({ name: item.name, dataBase64: b64, ...(f.type ? { mimeType: f.type } : {}), ...(item.sourcePath ? { sourcePath: item.sourcePath } : {}) });
    } catch { r = null; }
    if (dropped.has(item.key)) {
      dropped.delete(item.key);
      if (r?.ok) void deps.bridge.attachmentRemove(r.attachment.id).catch(() => false);
      return;
    }
    if (!r) { item.state = "blocked"; item.reason = "LUCID's engine did not answer. Remove the file and add it again."; }
    else if (!r.ok) { item.state = "blocked"; item.reason = r.error || "It could not be attached."; }
    else Object.assign(item, viewOfStaged(r.attachment), { staged: r.attachment, state: "ready" as const, sourcePath: r.attachment.sourcePath ?? item.sourcePath });
    changed();
  }

  return {
    items: () => list,
    policy: () => attachPolicy(deps.bridge),
    async add(files, opts = {}) {
      if (!files.length) return;
      const pol = await attachPolicy(deps.bridge);
      let incoming = [...files];
      if (opts.folder) {
        // A folder is cut to what fits: the folder cap, and the room left in this message.
        const usable = incoming.filter((f) => !isHiddenPath(f.webkitRelativePath || f.name) && !attachRefusal(f.name));
        const room = Math.max(0, pol.files - used());
        const cap = Math.min(ATTACH_LIMITS.folderFiles, room);
        const skipped = incoming.length - usable.length;
        if (usable.length > cap || skipped > 0) {
          const why = usable.length > cap ? ` The limit is ${cap === room ? `${pol.files} files per message, images included` : `${ATTACH_LIMITS.folderFiles} files per folder`}.` : "";
          const hid = skipped > 0 ? ` ${plural(skipped, "hidden file, program or archive was", "hidden files, programs or archives were")} left out.` : "";
          deps.notify?.(`Added ${plural(Math.min(cap, usable.length), "file", "files")} of ${incoming.length.toLocaleString("en-US")} from the folder.${why}${hid}`);
        }
        incoming = usable.slice(0, cap);
      }
      const images: File[] = [];
      const work: [TrayItem, File][] = [];
      for (const f of incoming) {
        const name = f.name || "Pasted file";
        if (isRoutedImage(name, f.type)) {
          // Images keep the bar's own path; with attachments on they still count toward the message limit.
          if (pol.enabled && used() + images.length >= pol.files) list.push(blocked(f, `Up to ${pol.files} files per message, images included.`));
          else images.push(f);
          continue;
        }
        const refusal = attachRefusal(name);
        if (refusal) { list.push(blocked(f, refusal)); continue; }
        if (!pol.enabled) { list.push(blocked(f, OFF_REASON)); continue; }
        if (f.size > pol.bytes) { list.push(blocked(f, `It is larger than the ${formatBytes(pol.bytes)} limit per file.`)); continue; }
        if (used() + images.length >= pol.files) { list.push(blocked(f, `Up to ${pol.files} files per message, images included.`)); continue; }
        const item: TrayItem = { ...viewOfName(name, f.size, sourceOf(f)), key: `f${++seq}`, state: "staging" };
        list.push(item);
        work.push([item, f]);
      }
      if (images.length) deps.onImages(images);
      changed();
      for (const [item, f] of work) await stage(item, f); // one at a time: a 25 MB file is read whole
    },
    remove(key) {
      const it = list.find((i) => i.key === key);
      if (!it || it.state === "sending") return;
      list = list.filter((i) => i !== it);
      if (it.state === "staging") dropped.add(it.key);
      if (it.state === "ready" && it.staged) void deps.bridge.attachmentRemove(it.staged.id).catch(() => false);
      changed();
    },
    ids: () => list.filter((i) => i.state === "ready" && i.staged).map((i) => i.staged!.id),
    count: () => list.filter((i) => i.state === "staging" || i.state === "ready").length,
    pending: () => list.filter((i) => i.state === "staging").length,
    hold() {
      const held = list.filter((i) => i.state === "ready" && i.staged);
      for (const i of held) i.state = "sending";
      if (held.length) changed();
      return held.map((i) => i.staged!);
    },
    settle(ids, accepted) {
      if (!ids.length) return;
      const set = new Set(ids);
      const hit = (i: TrayItem): boolean => i.state === "sending" && !!i.staged && set.has(i.staged.id);
      if (accepted) list = list.filter((i) => !hit(i));
      else for (const i of list) if (hit(i)) i.state = "ready";
      changed();
    },
    take() {
      const out = list.filter((i) => i.state === "ready" && i.staged).map((i) => i.staged!);
      const had = list.length;
      list = list.filter((i) => i.state === "staging" || i.state === "sending");
      if (list.length !== had) changed();
      return out;
    },
    restore(staged) {
      const have = new Set(list.map((i) => i.staged?.id).filter(Boolean));
      const back = staged.filter((a) => !have.has(a.id));
      if (!back.length) return;
      for (const a of back) list.push({ ...viewOfStaged(a), key: `f${++seq}`, state: "ready", staged: a });
      changed();
    },
    async adopt(staged) {
      const pol = await attachPolicy(deps.bridge);
      const have = new Set(list.map((i) => i.staged?.id).filter(Boolean));
      let adopted = 0;
      let refused = 0;
      for (const a of staged) {
        if (have.has(a.id)) continue;
        have.add(a.id);
        // Fail-closed: an unreachable engine reads as off, so nothing is adopted that the policy may forbid.
        const why = !pol.enabled ? OFF_REASON
          : a.bytes > pol.bytes ? `It is larger than the ${formatBytes(pol.bytes)} limit per file.`
          : used() >= pol.files ? `Up to ${pol.files} files per message, images included.`
          : null;
        if (why) { list.push({ ...viewOfStaged(a, "blocked"), key: `f${++seq}`, state: "blocked", reason: why }); refused++; continue; }
        list.push({ ...viewOfStaged(a), key: `f${++seq}`, state: "ready", staged: a });
        adopted++;
      }
      if (adopted || refused) changed();
      return { adopted, refused };
    },
    clear() {
      for (const i of list) if (i.state === "staging") dropped.add(i.key);
      if (!list.length) return;
      list = [];
      changed();
    },
  };
}

/** A file's bytes as base64, through FileReader (the browser encodes natively). */
export function readFileBase64(file: File): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const r = new FileReader();
  r.onload = () => {
    const url = String(r.result ?? "");
    const comma = url.indexOf(",");
    if (comma < 0) reject(new Error("unreadable")); else resolve(url.slice(comma + 1));
  };
  r.onerror = () => reject(r.error ?? new Error("unreadable"));
  r.readAsDataURL(file);
  return promise;
}

// ───────────────────────── chips (DOM) ─────────────────────────

const STATE_WORD: Partial<Record<ChipState, string>> = { staging: "Scanning", blocked: "Blocked", sending: "Sending" };

/** One compact chip: icon, name (ellipsized), size or state, and a remove x when `onRemove` is given.
 *  Built with DOM APIs; the only innerHTML is our own icon markup (the extension in it is escaped). */
export function attachChipEl(v: ChipView, opts: { onRemove?: () => void; retentionDays?: number } = {}): HTMLElement {
  const chip = document.createElement("div");
  chip.className = "att-chip";
  chip.dataset.state = v.state;
  chip.dataset.kind = v.kind;
  chip.setAttribute("data-tip", chipTip(v, opts.retentionDays));
  chip.setAttribute("data-tip-side", "top");
  chip.setAttribute("role", "group");
  chip.setAttribute("aria-label", `${v.name}, ${STATE_WORD[v.state] ?? formatBytes(v.bytes)}`);
  const ico = document.createElement("span");
  ico.className = "att-ico";
  ico.innerHTML = fileIconSvg(v.kind, v.ext, 16);
  const name = document.createElement("span");
  name.className = "att-name";
  name.textContent = v.name;
  const meta = document.createElement("span");
  meta.className = "att-meta";
  meta.textContent = STATE_WORD[v.state] ?? formatBytes(v.bytes);
  chip.append(ico, name, meta);
  if (opts.onRemove) {
    const x = document.createElement("button");
    x.type = "button";
    x.className = "att-x";
    x.setAttribute("aria-label", `Remove ${v.name}`);
    x.setAttribute("data-tip", v.state === "blocked" ? "Dismiss" : tipValue("Remove", "Takes the file off this message"));
    x.innerHTML = icon("close", 10);
    const run = opts.onRemove;
    x.addEventListener("click", (e) => { e.stopPropagation(); run(); });
    chip.appendChild(x);
  }
  if (v.state === "staging") {
    const prog = document.createElement("span");
    prog.className = "att-prog";
    prog.setAttribute("aria-hidden", "true");
    chip.appendChild(prog);
  }
  return chip;
}

export interface AttachTray extends TrayModel {
  /** Paint into a (new) host, for a bar whose markup is rebuilt (a lane card). */
  mount(host: HTMLElement | null): void;
}

/** The staging controller for one prompt bar: the tray model painted as chips into `host`. */
export function createAttachTray(host: HTMLElement | null, deps: TrayDeps): AttachTray {
  let el = host;
  let days: number = ATTACH_LIMITS.retentionDays;
  const paint = (): void => {
    if (!el) return;
    const items = model.items();
    el.replaceChildren(...items.map((i) => attachChipEl(i, { retentionDays: days, ...(i.state === "sending" ? {} : { onRemove: () => model.remove(i.key) }) })));
    el.hidden = items.length === 0;
  };
  const model = createTrayModel({ ...deps, onChange: () => { paint(); deps.onChange?.(); } });
  void model.policy().then((p) => { days = p.retentionDays; });
  paint();
  return { ...model, mount(next) { el = next; paint(); } };
}

/** The sent files under a user's message: chips with no remove. */
export function sentFilesEl(list: readonly StagedAttachment[]): HTMLElement {
  const row = document.createElement("div");
  row.className = "att-sent";
  for (const a of list) row.appendChild(attachChipEl(viewOfStaged(a, "sent")));
  return row;
}

/** P-ATTACH.1 (ADR-0598): what a lane remembers about a file that went with a user turn: display data only,
 *  never a path or the file's text. */
export interface SentFileMeta { name: string; ext: string; kind: AttachKind; bytes: number }

/** PURE: the display data of sent files, for a lane's own turn record. */
export function sentFileMeta(list: readonly StagedAttachment[]): SentFileMeta[] {
  return list.map((a) => ({ name: a.name, ext: a.ext, kind: a.kind, bytes: a.bytes }));
}

/** PURE: a remembered sent file as a chip view. The label comes from the name, like the engine's. */
export function viewOfSentMeta(m: SentFileMeta): ChipView {
  return { name: m.name, ext: m.ext, kind: m.kind, label: attachKindOf(m.name).label, bytes: m.bytes, state: "sent" };
}

/** Read-only chips for files remembered on a lane turn (the same look as sentFilesEl). */
export function sentMetaEl(list: readonly SentFileMeta[]): HTMLElement {
  const row = document.createElement("div");
  row.className = "att-sent";
  for (const m of list) row.appendChild(attachChipEl(viewOfSentMeta(m)));
  return row;
}

/** PURE: the note for files of a queued prompt whose copies are gone (expired or removed). */
export function missingFilesNote(n: number): string | null {
  if (n <= 0) return null;
  return n === 1
    ? "1 attached file is no longer available; add it again."
    : `${n.toLocaleString("en-US")} attached files are no longer available; add them again.`;
}

/** What adoptStagedIds did: `ready` chips added, `refused` added as blocked (limits or policy), `missing`
 *  ids with no copy left, and the note to show for the missing ones (null when none). */
export interface AdoptIdsResult { ready: number; refused: number; missing: number; note: string | null }

/** P-ATTACH.1 (ADR-0598): put the files of a queued prompt (staged ids) back on a bar without uploading them
 *  again. The engine says which still exist; the tray applies the limits. An engine that does not answer
 *  brings nothing back (fail-closed) and every id counts as unavailable. */
export async function adoptStagedIds(
  tray: Pick<TrayModel, "adopt">,
  bridge: Pick<AttachBridge, "attachmentDescribe">,
  ids: readonly string[],
): Promise<AdoptIdsResult> {
  if (!ids.length) return { ready: 0, refused: 0, missing: 0, note: null };
  let r: AttachDescribeResult | null;
  try { r = await bridge.attachmentDescribe([...ids]); } catch { r = null; }
  if (!r?.ok) {
    const files = plural(ids.length, "attached file was", "attached files were");
    const why = r?.error || "LUCID's engine did not answer.";
    return { ready: 0, refused: 0, missing: ids.length, note: `${why} ${files} not brought back; add ${ids.length === 1 ? "it" : "them"} again.` };
  }
  // Only ids this prompt carried: an answer naming anything else is ignored.
  const want = new Set(ids);
  const found = (r.attachments ?? []).filter((a) => want.has(a.id));
  const missing = ids.length - found.length;
  const { adopted, refused } = await tray.adopt(found);
  return { ready: adopted, refused, missing, note: missingFilesNote(missing) };
}

// ───────────────────────── the "+" menu ─────────────────────────

export interface PlusItem {
  id: string;
  label: string;
  /** Inline SVG (ours, never user text). */
  icon: string;
  /** The data-tip value. */
  tip: string;
  /** A shortcut shown at the row's right edge. */
  kbd?: string;
  run(anchor: HTMLElement): void;
}

const SVG = (body: string): string => `<svg class="ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const CLIP = SVG(`<path d="M15.5 7.5 9.4 13.6a1.9 1.9 0 0 0 2.7 2.7l6.4-6.4a3.6 3.6 0 0 0-5.1-5.1L7 11.2a5.3 5.3 0 0 0 7.5 7.5l5-5"/>`);
const PLUG = SVG(`<path d="M9 3v4.5M15 3v4.5M6.5 7.5h11V11a5.5 5.5 0 0 1-11 0zM12 16.5V21"/>`);

/** What the "+" menu offers on a bar. Ask Lucid passes only `pick` and `knowledge`. */
export interface PlusMenuConfig {
  pick(folder: boolean): void;
  folder?: boolean;
  knowledge?(anchor: HTMLElement): void;
  skills?(anchor: HTMLElement): void;
  connectors?(): void;
}

/** The "+" button's tooltip, shared by the three bars. */
export function plusButtonTip(full: boolean): string {
  return tipValue(`Add \u00b7 ${modCombo("U")}`, full ? "Files, photos or a folder, and quick access to Knowledge, Skills and Connectors." : "Files or photos, and quick access to Knowledge.");
}

/** The menu rows, in the order every bar shows them. */
export function plusMenuItems(cfg: PlusMenuConfig): PlusItem[] {
  const out: PlusItem[] = [
    { id: "files", label: "Add files or photos", icon: CLIP, kbd: modCombo("U"), tip: tipValue("Add files or photos", `Documents, code, data or images. Each file is copied into LUCID's own folder (kept ${ATTACH_LIMITS.retentionDays} days) and scanned before it can go with your prompt.`), run: () => cfg.pick(false) },
  ];
  if (cfg.folder) out.push({ id: "folder", label: "Add folder", icon: icon("folder", 15), tip: tipValue("Add folder", `Adds up to ${ATTACH_LIMITS.folderFiles} files from a folder. Hidden files, programs and archives are left out.`), run: () => cfg.pick(true) });
  if (cfg.knowledge) { const k = cfg.knowledge; out.push({ id: "knowledge", label: "Knowledge", icon: icon("graph", 15), tip: tipValue("Knowledge", "Ground answers on your own notes and documents."), run: (a) => k(a) }); }
  if (cfg.skills) { const s = cfg.skills; out.push({ id: "skills", label: "Skills", icon: icon("bolt", 15), tip: tipValue("Skills", "Built-in skills, /task delegation, and project skills."), run: (a) => s(a) }); }
  if (cfg.connectors) { const c = cfg.connectors; out.push({ id: "connectors", label: "Connectors (MCP)", icon: PLUG, tip: tipValue("Connectors (MCP)", "MCP servers that give the agent more tools."), run: () => c() }); }
  return out;
}

/** A small menu under a "+" button: arrows move, Enter or Space picks, Esc closes, and focus returns to the
 *  button. Built on the shared anchored popover (ui.ts), so it places, flips and closes like the others. */
export function mountPlusMenu(button: HTMLElement, items: PlusItem[] | (() => PlusItem[])): { open(): void; close(): void } {
  let cur: { node: HTMLElement; close: () => void } | null = null;
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  const close = (): void => { cur?.close(); };
  const open = (): void => {
    if (cur) return;
    const rows = typeof items === "function" ? items() : items;
    const html = `<div class="att-menu" role="menu" aria-label="Add to this prompt">${rows.map((it, i) =>
      `<div class="cfg-opt att-menu-opt" role="menuitem" tabindex="-1" data-att-menu="${i}" data-tip="${esc(it.tip)}" data-tip-side="right"><span class="att-menu-ic">${it.icon}</span><span class="nm">${esc(it.label)}</span>${it.kbd ? `<kbd class="att-menu-kbd">${esc(it.kbd)}</kbd>` : ""}</div>`).join("")}</div>`;
    const p = popover(button, html, () => { cur = null; button.setAttribute("aria-expanded", "false"); button.classList.remove("on"); button.focus(); });
    p.node.classList.add("att-menu-pop");
    p.reposition(); // the narrow menu measures differently from the default card width
    cur = p;
    button.setAttribute("aria-expanded", "true");
    button.classList.add("on");
    const opts = [...p.node.querySelectorAll<HTMLElement>("[data-att-menu]")];
    const focusAt = (i: number): void => { opts[(i + opts.length) % opts.length]?.focus(); };
    const pick = (row: HTMLElement | null): void => {
      const it = row ? rows[Number(row.dataset.attMenu)] : undefined;
      if (!it) return;
      p.close();
      it.run(button);
    };
    p.node.addEventListener("click", (e) => pick((e.target as HTMLElement).closest<HTMLElement>("[data-att-menu]")));
    p.node.addEventListener("mousemove", (e) => { const row = (e.target as HTMLElement).closest<HTMLElement>("[data-att-menu]"); if (row && document.activeElement !== row) row.focus(); });
    p.node.addEventListener("keydown", (e) => {
      const at = opts.indexOf(document.activeElement as HTMLElement);
      if (e.key === "ArrowDown") { e.preventDefault(); focusAt(at + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); focusAt(at < 0 ? -1 : at - 1); }
      else if (e.key === "Home") { e.preventDefault(); focusAt(0); }
      else if (e.key === "End") { e.preventDefault(); focusAt(-1); }
      else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(opts[at] ?? null); }
      else if (e.key === "Tab") { e.preventDefault(); p.close(); }
    });
    requestAnimationFrame(() => focusAt(0));
  };
  button.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); if (cur) close(); else open(); });
  button.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); open(); }
  });
  return { open, close };
}

/** Show the "+" button only when the managed policy allows attachments. Asked now and again whenever `input`
 *  takes focus: an engine still starting reads as off until it answers (the policy is cached once it does). */
export function syncPlusButton(button: HTMLElement | null, bridge: AttachBridge, input?: HTMLElement | null): void {
  if (!button) return;
  const sync = (): void => { void attachPolicy(bridge).then((p) => { button.hidden = !p.enabled; }); };
  sync();
  input?.addEventListener("focus", sync);
}

// ───────────────────────── picking, dropping, pasting ─────────────────────────

/** Open the OS file picker (a folder picker with `folder`). Resolves with the chosen files; [] on cancel. */
export function pickFiles(opts: { folder?: boolean } = {}): Promise<File[]> {
  const { promise, resolve } = Promise.withResolvers<File[]>();
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.hidden = true;
  if (opts.folder) input.webkitdirectory = true;
  const done = (files: File[]): void => { input.remove(); resolve(files); };
  input.addEventListener("change", () => done([...(input.files ?? [])]), { once: true });
  input.addEventListener("cancel", () => done([]), { once: true });
  document.body.appendChild(input);
  input.click();
  return promise;
}

/** The files on a clipboard paste (text pastes give none). */
export function clipboardFiles(e: ClipboardEvent): File[] {
  return [...(e.clipboardData?.items ?? [])].filter((i) => i.kind === "file").map((i) => i.getAsFile()).filter((f): f is File => !!f);
}

/** Make `zone` take dropped files, with the premium drop highlight while files hover over it. A dropped
 *  folder is not read (its entry has no bytes); `onFiles` is told how many were left out so the bar can point
 *  at Add folder. */
export function bindFileDrop(zone: HTMLElement, onFiles: (files: File[], folders: number) => void, label = "Drop files to attach"): void {
  const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer?.types?.includes("Files");
  zone.dataset.dropLabel = label;
  const on = (e: DragEvent): void => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    zone.classList.add("att-drop");
  };
  zone.addEventListener("dragenter", on);
  zone.addEventListener("dragover", on);
  zone.addEventListener("dragleave", (e) => { if (!zone.contains(e.relatedTarget as Node | null)) zone.classList.remove("att-drop"); });
  zone.addEventListener("drop", (e) => {
    zone.classList.remove("att-drop");
    if (!hasFiles(e) || !e.dataTransfer) return;
    e.preventDefault();
    const items = [...e.dataTransfer.items];
    const files: File[] = [];
    let folders = 0;
    if (items.length) {
      for (const it of items) {
        if (it.kind !== "file") continue;
        if (it.webkitGetAsEntry?.()?.isDirectory) { folders++; continue; }
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    } else files.push(...e.dataTransfer.files);
    onFiles(files, folders);
  });
}

/** PURE: the note for a drop that held folders. `canPickFolder`: the bar's "+" menu has Add folder. */
export function folderDropNote(folders: number, canPickFolder = true): string {
  if (folders <= 0) return "";
  const what = folders === 1 ? "A folder was" : `${folders} folders were`;
  return `${what} not added: ${canPickFolder ? "use + then Add folder to add the files inside" : "drop the files themselves"}.`;
}
