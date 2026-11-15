// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/screen_digest.ts - P-ASKLUCID.3 (ADR-0584): read what is drawn on the user's screen.
//
// The collector answers "what is the user looking at": the surfaces that are visible right now, the top one
// first, and the text each one shows inside the window. It is the DOM half; every bound and the redaction
// live in ../ask_lucid_screen.ts, which also runs again on the engine.
//
// Rules it keeps:
//   - only what is VISIBLE: hidden elements, zero-size elements and anything scrolled out of the window
//     are skipped, so the digest is the screen and not the whole document;
//   - never what was TYPED: input, textarea, select and contenteditable content is not read;
//   - never the Ask Lucid panel itself, toasts or tooltips.

import { normalizeScreen, SCREEN_LIMITS, type ScreenDigest, type ScreenPreview } from "../ask_lucid_screen.ts";

/** Surfaces that float over the app, wherever they are mounted. */
const OVERLAYS = ".modal-ov, .goal-scrim, .figma-scrim, .mkt-scrim, .fb, .palette.show, .orbit-view, .share-dock, .plg-drawer, .coach-card, .ctx-menu";
/** Never read: the panel asking the question, and transient chrome. */
const SKIP = ".ald, .ald-pill, .ald-ghost, #toasts, #tip, .richtip, .modeltip, #scrim";
/** Never read: what the user typed, and things with no text of their own. */
const SKIP_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "OPTION", "SCRIPT", "STYLE", "SVG", "CANVAS", "IFRAME", "VIDEO", "AUDIO", "NOSCRIPT", "TEMPLATE"]);

/** What to call a surface, by the first rule that matches. */
const KINDS: readonly (readonly [string, string])[] = [
  ["#orbitView", "Fleet Orbit map"],
  ["#fleetDock", "Fleet grid"],
  [".share-dock", "Docked panel"],
  [".palette", "Command palette"],
  [".coach-card", "Guided tour"],
  [".ctx-menu", "Menu"],
  [".modal-ov, .goal-scrim, .figma-scrim, .mkt-scrim, .fb", "Dialog"],
  [".plg-drawer", "Plugin panel"],
  [".titlebar", "Title bar"],
  [".statusbar", "Status bar"],
  [".rail:not(.inspector)", "Navigation rail"],
  ["#sidebar", "Sidebar"],
  [".center", "Chat"],
  ["#inspector", "Inspector"],
  ["#settings", "Settings"],
  ["#skillsDir", "Skills"],
  ["#creatorStudio", "Creator Studio"],
  ["#knowledge", "Knowledge graph"],
  ["#meetings", "Meetings"],
  ["#remoteSpokes", "Remote spokes"],
  ["#preview", "Preview panel"],
  ["#trainerPanel", "Trainer"],
  ["#agentBuilder", "Agent builder"],
];
const TITLES = ".set-title, .share-dock-title, .orbit-title, .modal-title, .fb-title, h1, h2, h3";

function matches(el: Element, sel: string): boolean {
  try { return el.matches(sel); } catch { return false; }
}

function visible(el: Element, vw: number, vh: number): boolean {
  const h = el as HTMLElement;
  if (h.hidden || el.getAttribute("aria-hidden") === "true") return false;
  const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  if (typeof check === "function" && !check.call(el, { checkOpacity: true, checkVisibilityCSS: true })) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return true; // display: contents and the like: decide on the children
  return r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
}

function zOf(el: Element): number {
  const z = Number.parseInt(getComputedStyle(el).zIndex, 10);
  return Number.isFinite(z) ? z : 0;
}

/** The visible text under `root`, one line per block, up to `max` characters. */
export function visibleText(root: Element, vw: number, vh: number, max: number): string {
  const doc = root.ownerDocument;
  const out: string[] = [];
  let size = 0;
  let lastBlock: Element | null = null;
  const blockOf = (el: Element): Element => {
    let cur: Element | null = el;
    while (cur && cur !== root) {
      const d = getComputedStyle(cur).display;
      if (!d.startsWith("inline") && d !== "contents") return cur;
      cur = cur.parentElement;
    }
    return root;
  };
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      const el = node as Element;
      if (SKIP_TAGS.has(el.tagName.toUpperCase()) || matches(el, SKIP) || (el as HTMLElement).isContentEditable) return NodeFilter.FILTER_REJECT;
      if (el !== root && matches(el, OVERLAYS)) return NodeFilter.FILTER_REJECT; // an overlay is its own surface
      return visible(el, vw, vh) ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_REJECT; // SKIP: not a result, but descend
    },
  });
  for (let n = walker.nextNode(); n && size < max; n = walker.nextNode()) {
    const text = (n.nodeValue ?? "").replace(/\s+/g, " ").trim();
    const parent = n.parentElement;
    if (!text || !parent) continue;
    const block = blockOf(parent);
    if (block === lastBlock && out.length > 0) out[out.length - 1] += ` ${text}`;
    else out.push(text);
    lastBlock = block;
    size += text.length + 1;
  }
  return out.join("\n");
}

function titleOf(el: Element): string {
  const label = el.getAttribute("aria-label");
  if (label) return label;
  const t = el.querySelector(TITLES);
  if (!t) return "";
  // Joined with spaces: a title built from sibling elements ("LUCID Fleet" + "hub & spoke") has none between them.
  const parts: string[] = [];
  const walker = el.ownerDocument.createTreeWalker(t, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) { const v = (n.nodeValue ?? "").trim(); if (v) parts.push(v); }
  return parts.join(" ");
}

function kindOf(el: Element): string {
  for (const [sel, kind] of KINDS) if (matches(el, sel)) return kind;
  return "Panel";
}

export interface CollectOptions {
  /** Harness-written facts to put at the top (role, whether a turn runs). */
  facts?: readonly string[];
  /** The Preview panel's page, when one is showing. */
  preview?: Partial<ScreenPreview> | null;
}

/** Read the screen: overlays first (highest first), then the app's own regions left to right. */
export function collectScreen(doc: Document, opts: CollectOptions = {}): ScreenDigest | null {
  const win = doc.defaultView;
  if (!win) return null;
  const vw = win.innerWidth;
  const vh = win.innerHeight;
  const overlays = [...doc.querySelectorAll(OVERLAYS)]
    .filter((el) => !el.closest(SKIP) && visible(el, vw, vh) && el.getBoundingClientRect().width > 0)
    .filter((el, _i, all) => !all.some((other) => other !== el && other.contains(el))) // the outermost only
    .map((el, order) => ({ el, z: zOf(el), order }))
    .sort((a, b) => b.z - a.z || b.order - a.order)
    .map((o) => o.el);
  const regions: Element[] = [];
  const body = doc.querySelector(".body");
  for (const sel of [".titlebar"]) { const el = doc.querySelector(sel); if (el) regions.push(el); }
  if (body) regions.push(...body.children);
  for (const sel of [".statusbar"]) { const el = doc.querySelector(sel); if (el) regions.push(el); }
  const base = regions.filter((el) => visible(el, vw, vh) && el.getBoundingClientRect().width > 0 && !matches(el, SKIP));
  const surfaces = [...overlays, ...base].map((el) => ({
    kind: kindOf(el),
    title: titleOf(el),
    text: visibleText(el, vw, vh, SCREEN_LIMITS.text + 200),
  }));
  return normalizeScreen({
    surfaces,
    facts: [...(opts.facts ?? []), `The window is ${vw} by ${vh} pixels.`],
    preview: opts.preview ?? null,
  });
}

/** The surfaces that are open, top first, WITHOUT their text: cheap enough to call on a timer. Used for the
 *  suggestions (P-ASKLUCID.5), which need to know where the user is, not what it says. */
export function surfaceKinds(doc: Document): { kind: string; title: string }[] {
  const win = doc.defaultView;
  if (!win) return [];
  const vw = win.innerWidth;
  const vh = win.innerHeight;
  const overlays = [...doc.querySelectorAll(OVERLAYS)]
    .filter((el) => !el.closest(SKIP) && visible(el, vw, vh) && el.getBoundingClientRect().width > 0)
    .filter((el, _i, all) => !all.some((other) => other !== el && other.contains(el)))
    .map((el, order) => ({ el, z: zOf(el), order }))
    .sort((a, b) => b.z - a.z || b.order - a.order)
    .map((o) => o.el);
  const body = doc.querySelector(".body");
  const base = (body ? [...body.children] : []).filter((el) => visible(el, vw, vh) && el.getBoundingClientRect().width > 0 && !matches(el, SKIP));
  // Side panels before the chat: a panel the user opened is where they are, the chat is always there.
  const panels = base.filter((el) => !matches(el, ".rail, #sidebar, .center, #inspector"));
  const rest = base.filter((el) => !panels.includes(el));
  return [...overlays, ...panels, ...rest].map((el) => ({ kind: kindOf(el), title: titleOf(el).slice(0, 120) }));
}
