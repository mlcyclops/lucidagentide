// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/browser_snapshot.ts - P-JEV.4 (ADR-0379): the page-side scripts of the Jev browser policy.
//
// A port of browser-use/jev-ultrafast `snapshot.js` (MIT) into strings the Electron main evaluates in the
// agent window. Everything here is pure: JS source text plus the TypeScript shape of what that source
// returns, so dev.ts (routes), main.ts (executor) and the omp extension (policy) agree on one contract and
// bun can unit-test the module without a DOM.
//
// WHY AN ISOLATED WORLD. main.ts runs these through executeJavaScriptInIsolatedWorld(BROWSER_POLICY_WORLD)
// rather than the page's main world: the element cache and the DOM wrappers the guards rely on live in a V8
// context the page's own scripts cannot reach or monkey-patch. The DOM is shared, the functions are not.
//
// WHAT THE MODEL NEVER SEES. Node identities are integers minted by the cache below and resolved back to
// live elements only inside this world. Jev picks an offered index; it never emits a selector, a
// coordinate, or code. Geometry is re-read right before input (targetJs), never trusted from the snapshot.

export type BrowserActionKind = "click" | "fill" | "select" | "scroll" | "wait";

/** One executable candidate from a snapshot. `node` is the cache identity (click/fill/select only). */
export interface BrowserAction {
  id: string;
  kind: BrowserActionKind;
  label: string;
  node?: number;
  role?: string;
  /** click/fill: the field's current text; select: the option's value. */
  value?: string;
  /** select only: the currently selected option label(s). */
  current_value?: string;
  checked?: string;
  selected?: string;
  expanded?: string;
  /** scroll only: pixels (negative scrolls up). */
  delta?: number;
}

/** One observation of the agent window. `marker`/`page_key`/`guards` are opaque JSON the freshness checks
 *  compare byte-for-byte; the policy never interprets them. */
export interface BrowserPage {
  url: string;
  title: string;
  w: number;
  h: number;
  text: string;
  scroll: { y: number; height: number };
  actions: BrowserAction[];
  marker: unknown;
  page_key: unknown;
  guards: Record<string, unknown>;
  omitted_actions: number;
  /** sha256 hex over { url, text, actions, scroll }; a decision is only executable against its fingerprint. */
  fingerprint: string;
}

/** What `act` must re-verify before touching the page: scoped (page_key + guard) for click/select, the
 *  full semantic marker for everything else. */
export interface BrowserFreshness {
  marker?: unknown;
  page_key?: unknown;
  guard?: unknown;
}

/** Isolated-world id for the policy scripts. Any non-zero id works; this one is ours alone. */
export const BROWSER_POLICY_WORLD = 1187;

/** Most candidates one snapshot keeps; the rest are counted in `omitted_actions` and cannot be chosen. */
export const MAX_ACTIONS = 250;

const SETTLE_FRAMES = 2;
const SETTLE_MS = 50;
const AUTOCOMPLETE_MS = 200;

/** Atomic read of the visible controls, their names and values, the visible text, and the freshness keys.
 *  An IIFE expression: evaluates to a BrowserPage without `fingerprint`, or null while navigating. */
export const SNAPSHOT_JS = `(() => {
  if (!document.body) return null;
  const cache = globalThis.__lucidJev ||= { ids: new WeakMap(), nodes: new Map(), next: 1 };
  const identity = (e) => {
    if (!cache.ids.has(e)) cache.ids.set(e, cache.next++);
    const id = cache.ids.get(e); cache.nodes.set(id, e); return id;
  };
  for (const [id, e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
  const safe = (e) => !['password', 'file', 'hidden'].includes(e.type);
  const visible = (e) => !e.closest('[aria-hidden="true"],[inert]') &&
    e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const name = (e, seen = new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced = (e.getAttribute('aria-labelledby') || '').split(/\\s+/)
      .map((id) => name(document.getElementById(id), seen)).filter(Boolean).join(' ');
    return referenced || e.getAttribute('aria-label') ||
      [...(e.labels || [])].map((l) => name(l, seen)).filter(Boolean).join(' ') ||
      (['button', 'submit', 'reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (e.tagName === 'INPUT' ? '' : [...e.childNodes].map((n) => n.nodeType === 3 ? n.textContent :
        n.nodeType === 1 && n.getAttribute('aria-hidden') !== 'true' ? name(n, seen) : '').join(' ').trim()) ||
      e.getAttribute('title') || e.getAttribute('placeholder') || '';
  };
  const roles = ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemradio',
    'option', 'gridcell', 'combobox', 'textbox', 'searchbox', 'spinbutton'];
  const selector = 'a[href],button,input,textarea,select,summary,[contenteditable="true"],' +
    roles.map((role) => '[role="' + role + '"]').join(',');
  const role = (e) => {
    const explicit = e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName === 'BUTTON' || e.tagName === 'SUMMARY') return 'button';
    if (e.tagName === 'A') return 'link';
    if (e.tagName === 'SELECT') return 'combobox';
    if (e.tagName === 'TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName === 'INPUT') {
      if (['checkbox', 'radio'].includes(e.type)) return e.type;
      if (['button', 'submit', 'reset', 'image'].includes(e.type)) return 'button';
      if (e.type === 'search') return 'searchbox';
      if (e.type === 'number') return 'spinbutton';
      if (['text', 'email', 'url', 'tel'].includes(e.type)) return 'textbox';
    }
    return null;
  };
  cache.pageKey = () => [performance.timeOrigin, location.href, scrollX, scrollY, innerWidth, innerHeight,
    [...document.querySelectorAll('input,textarea,select')].filter(safe)
      .map((e) => [identity(e), e.value, e.checked, e.selectedIndex, e.disabled, e.readOnly])];
  cache.guard = (e) => {
    if (!e?.isConnected || !visible(e)) return null;
    const scope = e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return [identity(e), role(e), name(e), e.value ?? null, e.checked ?? null, e.selectedIndex ?? null,
      e.readOnly ?? null, e.matches(':disabled'), e.getAttribute('aria-disabled'),
      e.getAttribute('aria-expanded'), e.getAttribute('aria-checked'), e.getAttribute('aria-selected'),
      e.getAttribute('href'), scope?.innerText?.slice(0, 6000) || ''];
  };
  const actions = [];
  for (const e of document.querySelectorAll(selector)) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2, rname = role(e);
    if (!rname || r.width <= 0 || r.height <= 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
    if (rname === 'gridcell' && e.querySelector('button,[role="button"]')) continue;
    const base = { node: identity(e), role: rname, label: name(e) || rname };
    for (const key of ['checked', 'selected', 'expanded']) {
      const value = e.getAttribute('aria-' + key);
      if (value !== null) base[key] = value;
    }
    if (['checkbox', 'radio'].includes(e.type)) base.checked = String(e.checked);
    if (e.tagName === 'SELECT') {
      for (const o of e.options) if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]'))
        actions.push({ ...base, kind: 'select', value: o.value,
          current_value: [...e.selectedOptions].map((s) => s.label).join(', '), label: base.label + ' -> ' + o.label });
    } else {
      const editable = !e.readOnly && e.getAttribute('aria-readonly') !== 'true' &&
        (['textbox', 'searchbox', 'spinbutton'].includes(rname) ||
          (rname === 'combobox' && ['INPUT', 'TEXTAREA'].includes(e.tagName)));
      const value = 'value' in e ? String(e.value) :
        e.isContentEditable || rname === 'combobox' ? e.innerText.trim() : '';
      actions.push({ ...base, kind: editable ? 'fill' : 'click', value });
      if (editable) actions.push({ ...base, kind: 'click', value, label: 'Open ' + base.label });
    }
  }
  const words = [], walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange(); let node, length = 0;
  while ((node = walker.nextNode()) && length < 6000) {
    const value = node.textContent.trim(), parent = node.parentElement;
    if (!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
    range.selectNodeContents(node); const r = range.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) {
      words.push(value); length += value.length;
    }
  }
  const text = words.join('\\n').slice(0, 6000), height = document.documentElement.scrollHeight;
  const page_key = cache.pageKey(), guards = {};
  for (const a of actions) if (!(a.node in guards)) guards[a.node] = cache.guard(cache.nodes.get(a.node));
  const marker = [performance.timeOrigin, location.href, scrollX, scrollY, innerWidth, innerHeight,
    document.title, text, actions, page_key[6]];
  const omitted_actions = Math.max(0, actions.length - ${MAX_ACTIONS});
  actions.splice(${MAX_ACTIONS});
  actions.forEach((a, i) => { a.id = 'e' + (i + 1); });
  if (scrollY + innerHeight < height - 2) actions.push({ id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: 560 });
  if (scrollY > 0) actions.push({ id: 'scroll_up', kind: 'scroll', label: 'Scroll up', delta: -560 });
  actions.push({ id: 'wait', kind: 'wait', label: 'Wait for the page to update' });
  return { url: location.href, title: document.title, w: innerWidth, h: innerHeight, text,
    scroll: { y: scrollY, height }, actions, marker, page_key, guards, omitted_actions };
})()`;

/** Embed a value into page JS as a literal. JSON is a JS subset except for U+2028/2029, which are escaped
 *  so a label containing them can never break out of the literal. */
function literal(value: unknown): string {
  return JSON.stringify(value ?? null).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** Marker-only re-read: evaluates to the current semantic marker (or null while navigating). */
export const MARKER_JS = `(() => { const state = ${SNAPSHOT_JS}; return state ? state.marker : null; })()`;

/** The freshness probe `act` compares against the decision's BrowserFreshness. Click/select compare the
 *  scoped [page_key, guard] pair for the target node; everything else compares the full marker. */
export function freshnessJs(action: BrowserAction | null): string {
  if (action && (action.kind === "click" || action.kind === "select") && typeof action.node === "number") {
    return `(() => { const c = globalThis.__lucidJev; return c ? [c.pageKey(), c.guard(c.nodes.get(${literal(action.node)}))] : null; })()`;
  }
  return MARKER_JS;
}

/** The freshness reference for a decision, taken from the page it was made against. */
export function freshnessOf(page: BrowserPage, action: BrowserAction): BrowserFreshness {
  if ((action.kind === "click" || action.kind === "select") && typeof action.node === "number") {
    return { page_key: page.page_key, guard: page.guards[String(action.node)] ?? null };
  }
  return { marker: page.marker };
}

/** Resolve the live target for click/fill/select right before input: evaluates to { x, y } in CSS px when
 *  the node is still connected, visible, enabled, in-viewport and not covered, else null. A select is
 *  mutated here (value + input/change events); a click/fill only resolves geometry. */
export function targetJs(action: BrowserAction): string {
  return `((action) => {
    const e = globalThis.__lucidJev?.nodes.get(action.node);
    if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
        !e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return null;
    if (action.kind === 'fill' && (e.readOnly || e.getAttribute('aria-readonly') === 'true')) return null;
    const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
    if (!r.width || !r.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
    if (!e.contains(document.elementFromPoint(x, y))) return null;
    if (action.kind === 'select') {
      if (e.tagName !== 'SELECT' || ![...e.options].some((o) => o.value === action.value &&
          !o.disabled && !o.closest('optgroup[disabled]'))) return null;
      e.value = action.value;
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { x, y };
  })(${literal({ node: action.node ?? null, kind: action.kind, value: action.value ?? null })})`;
}

/** Wait for useful state after an input: two animation frames or 50 ms, or visible autocomplete options
 *  (capped at 200 ms) after typing into an editable combobox. Evaluates to a Promise the executor awaits. */
export function settleJs(action: BrowserAction): string {
  return `((action) => new Promise((resolve) => {
    const field = globalThis.__lucidJev?.nodes.get(action.node);
    const autocomplete = action.kind === 'fill' && field?.getAttribute('role') === 'combobox';
    let frames = 0, stopped = false;
    const finish = () => { stopped = true; resolve(); };
    setTimeout(finish, autocomplete ? ${AUTOCOMPLETE_MS} : ${SETTLE_MS});
    const ready = () => {
      if (stopped) return;
      const ids = (field?.getAttribute('aria-controls') || field?.getAttribute('aria-owns') || '')
        .split(/\\s+/).filter(Boolean);
      const roots = ids.length ? ids.map((id) => document.getElementById(id)).filter(Boolean) : [document];
      const options = roots.flatMap((root) => [...root.querySelectorAll('[role="option"]')]);
      if (++frames >= ${SETTLE_FRAMES} && (!autocomplete || options.some((e) => {
        const r = e.getBoundingClientRect();
        return r.width && r.height && r.bottom > 0 && r.top < innerHeight &&
          e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      }))) finish();
      else requestAnimationFrame(ready);
    };
    requestAnimationFrame(ready);
  }))(${literal({ node: action.node ?? null, kind: action.kind })})`;
}

/** Runtime narrowing of what the page returned; anything off-shape is treated as "no snapshot". */
export function isBrowserPageShape(v: unknown): v is Omit<BrowserPage, "fingerprint"> {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.url === "string" && typeof o.title === "string" && typeof o.text === "string" &&
    Array.isArray(o.actions) && !!o.scroll && typeof o.scroll === "object" &&
    "marker" in o && "page_key" in o && !!o.guards && typeof o.guards === "object" &&
    typeof o.omitted_actions === "number";
}

/** Runtime narrowing of a queued action (the route and the executor both refuse anything else). */
export function isBrowserAction(v: unknown): v is BrowserAction {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.label !== "string") return false;
  if (!["click", "fill", "select", "scroll", "wait"].includes(String(o.kind))) return false;
  if (["click", "fill", "select"].includes(String(o.kind)) && !Number.isInteger(o.node)) return false;
  if (o.kind === "scroll" && typeof o.delta !== "number") return false;
  return true;
}
