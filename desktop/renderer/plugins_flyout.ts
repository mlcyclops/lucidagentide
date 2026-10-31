// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/plugins_flyout.ts - P-PLUGINS.1 (ADR-0461): the Plugins drawer.
//
// A drawer that slides out of the Preview panel's left edge over the chat, `min(1180px, 88vw)` wide, with a
// PREMIUM | FREE toggle (default PREMIUM, remembered) and techlead187.com-style cards. It replaces the ADR-0158
// `#scrim` marketplace modal. Every card's state comes from plugin_catalog.ts `decideCardAction`; this module
// only renders it and runs the side effects through injected dependencies (the market provider for sign-in,
// checkout, entitlement and government access; the engine bridge for install / start / license), so app.ts
// keeps the singletons and this file has no hidden globals.
//
// Media is bundled under assets/plugins/ (offline). A loop only gets its `src` while its card is on screen
// (IntersectionObserver), and never under prefers-reduced-motion: then the poster is the picture.

import { esc } from "./format.ts";
import { icon, iconBody } from "./icons.ts";
import {
  BLACK_ARROW, FREE_PLUGINS, PLUGIN_LICENSE_NAME, PLUGIN_LICENSE_URL, PLUGIN_PRICE_LABEL, PREMIUM_PLUGINS,
  cardActionLabel, decideCardAction, fmtDownloads, matchesQuery, parseCageOrUei, parseTierPref, sortFree,
  type CardAction, type FreePlugin, type PluginMedia, type PluginTier, type PosterTone, type PremiumPlugin, type SoldPlugin,
} from "./plugin_catalog.ts";
import { shouldResumeCheckout, type PendingCheckout } from "./pack_cta.ts";
import type { AuthState, Entitlement, GovAccessStatus } from "../../harness/market/entitlement.ts";
import type { EntitlementProvider } from "./market_gate.ts";
import type { InstalledPluginView, PluginGate, PluginInstallView, PluginLicenseView, PluginStartView, PluginsListView } from "./bridge.ts";
import type { ToastOpts } from "./ui.ts";

export const TIER_PREF_KEY = "lucid.plugins-tier";
const MEDIA_DIR = "assets/plugins";

// ── geometry ───────────────────────────────────────────────────────────────────────────────────────

/** Where the drawer sits: its right edge on the Preview panel's left edge, `min(1180, 88vw)` wide. When the
 *  chat column is narrower than that, the drawer keeps its width and overlaps into the Preview panel rather
 *  than crushing the cards, but never slides under the left rail (`minLeft`). Pure. */
export function drawerGeometry(viewportW: number, anchorLeft: number, minLeft: number): { left: number; width: number } {
  const width = Math.max(320, Math.min(1180, Math.round(viewportW * 0.88), viewportW - minLeft));
  return { left: Math.max(minLeft, Math.min(anchorLeft, viewportW) - width), width };
}

// ── markup ─────────────────────────────────────────────────────────────────────────────────────────

/** A per-plugin poster drawn from the plugin's glyph, tinted by a palette token so it follows the theme. */
export function generatedPosterSvg(id: string, name: string, glyph: string, tone: PosterTone): string {
  const g = `plg-g-${esc(id)}`, p = `plg-p-${esc(id)}`;
  return `<svg class="plg-gen plg-tone-${tone}" viewBox="0 0 720 405" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${esc(name)}">`
    + `<defs><radialGradient id="${g}" cx="72%" cy="30%" r="78%"><stop offset="0" class="plg-gen-s0"/><stop offset="1" class="plg-gen-s1"/></radialGradient>`
    + `<pattern id="${p}" width="36" height="36" patternUnits="userSpaceOnUse"><path d="M36 0H0V36" class="plg-gen-grid"/></pattern></defs>`
    + `<rect width="720" height="405" class="plg-gen-bg"/><rect width="720" height="405" fill="url(#${g})"/><rect width="720" height="405" fill="url(#${p})"/>`
    + `<circle cx="520" cy="190" r="150" class="plg-gen-ring"/><circle cx="520" cy="190" r="112" class="plg-gen-ring plg-gen-ring2"/>`
    + `<g class="plg-gen-glyph" transform="translate(424 94) scale(8)" fill="none" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round">${iconBody(glyph)}</g>`
    + `<text x="44" y="318" class="plg-gen-tag">LUCID PLUGIN</text><text x="44" y="356" class="plg-gen-name">${esc(name)}</text></svg>`;
}

function shotHtml(id: string, name: string, m: PluginMedia): string {
  if (m.poster === "generated") return `<div class="plg-shot">${generatedPosterSvg(id, name, m.glyph, m.tone)}</div>`;
  const poster = `${MEDIA_DIR}/${esc(id)}-poster.webp`;
  if (!m.loop) return `<div class="plg-shot"><img src="${poster}" width="720" height="405" alt="" loading="lazy" decoding="async"></div>`;
  return `<div class="plg-shot"><video class="plg-loop" data-src="${MEDIA_DIR}/${esc(id)}-loop.mp4" poster="${poster}" width="720" height="406" muted loop playsinline preload="none" aria-hidden="true"></video></div>`;
}

export interface CardNote { tone: "info" | "ok" | "danger"; text: string }

/** The footer of a premium card: meta line, the one state button, and the status note. Re-rendered alone on
 *  every state change so the card's loop keeps playing. */
export function premiumFootHtml(p: PremiumPlugin, a: CardAction, installed: boolean, note: CardNote | null): string {
  const meta = p.sale === "link"
    ? (p.partner ? `<span class="plg-meta">Partner: ${esc(p.partner)}</span>` : `<span class="plg-meta">Own subscription</span>`)
    : `<span class="plg-meta">One-time ${PLUGIN_PRICE_LABEL}</span><button type="button" class="plg-lic" data-plg-license="${esc(p.id)}">${installed ? "License" : "License terms"}</button>`;
  const disabled = a.kind === "installing" || a.kind === "access-pending" || a.kind === "coming-soon" ? " disabled" : "";
  const busy = a.kind === "installing" ? ` aria-busy="true"` : "";
  const ext = a.kind === "visit" ? icon("arrowRight", 13) : "";
  return `<div class="plg-foot">${meta}<button type="button" class="plg-act" data-kind="${a.kind}" data-plg-act="${esc(p.id)}"${disabled}${busy}>${esc(cardActionLabel(a))}${ext}</button></div>`
    + (note ? `<p class="plg-note" data-tone="${note.tone}" role="status">${esc(note.text)}</p>` : "");
}

export function premiumCardHtml(p: PremiumPlugin, a: CardAction, installed: boolean, note: CardNote | null): string {
  return `<article class="plg-card" data-plg-card="${esc(p.id)}">${shotHtml(p.id, p.name, p.media)}
    <div class="plg-cbody">
      <b class="plg-name">${esc(p.name)}</b>
      <span class="plg-kind">${esc(p.kicker)}</span>
      <p class="plg-pitch">${esc(p.pitch)}</p>
      <p class="plg-lucid"><span>With LUCID Agent</span>${esc(p.lucid)}</p>
      <div class="plg-foot-slot" data-plg-foot="${esc(p.id)}">${premiumFootHtml(p, a, installed, note)}</div>
    </div>
  </article>`;
}

const STATUS_CHIP: Record<FreePlugin["status"], string> = { featured: "Featured", "built-in": "Built in", planned: "Planned" };

export function freeCardHtml(p: FreePlugin): string {
  const dl = fmtDownloads(p.downloads);
  const action = p.repo
    ? `<button type="button" class="plg-act" data-kind="visit" data-plg-repo="${esc(p.repo)}" title="${esc(p.repo)}">View project${icon("arrowRight", 13)}</button>`
    : `<span class="plg-act plg-act-static" data-kind="built-in">${icon("check", 13)}In LUCID now</span>`;
  return `<article class="plg-card" data-plg-card="${esc(p.id)}">${shotHtml(p.id, p.name, { loop: false, poster: "generated", glyph: p.glyph, tone: p.tone })}
    <div class="plg-cbody">
      <b class="plg-name">${esc(p.name)}</b>
      <span class="plg-kind">${esc(p.category)}<span class="plg-chip" data-status="${p.status}">${STATUS_CHIP[p.status]}</span></span>
      <p class="plg-pitch">${esc(p.desc)}</p>
      <p class="plg-lucid"><span>With LUCID Agent</span>${esc(p.lucid)}</p>
      <div class="plg-foot"><span class="plg-meta">${dl ? `${icon("download", 12)}${esc(dl)} Obsidian downloads` : "Free"}</span>${action}</div>
    </div>
  </article>`;
}

/** The Government access panel at the top of the Government section (one record per account, ADR-0465). */
export function govPanelHtml(signedIn: boolean, status: GovAccessStatus, formOpen: boolean, error: string): string {
  const lead = `<div class="plg-gov-ic">${icon("shield", 18)}</div>`;
  if (!signedIn) {
    return `<div class="plg-gov">${lead}<p>Government plugins are sold only to verified government accounts. Sign in, then request access; a verified .gov or .mil email is approved right away.</p><button type="button" class="plg-act" data-kind="signin" data-plg-signin>Sign in</button></div>`;
  }
  if (status === "approved") return `<div class="plg-gov" data-status="approved">${lead}<p>Government access is approved for this account. Buy unlocks on every Government plugin.</p></div>`;
  if (status === "pending") return `<div class="plg-gov" data-status="pending">${lead}<p>Your access request is with the TECHLEAD 187 team. Buy unlocks as soon as it is approved.</p></div>`;
  const why = status === "declined"
    ? "Your last request was declined. You can send a new one with more detail about your organization."
    : "Government plugins are sold only to verified government accounts. A verified .gov or .mil email is approved right away; anyone else is reviewed by the TECHLEAD 187 team.";
  if (!formOpen) return `<div class="plg-gov" data-status="${status}">${lead}<p>${why}</p><button type="button" class="plg-act" data-kind="request-access" data-plg-govopen>${status === "declined" ? "Request again" : "Request access"}</button></div>`;
  return `<div class="plg-gov" data-status="${status}">${lead}<div class="plg-gov-main"><p>${why}</p>
    <form class="plg-govform" data-plg-govform novalidate>
      <label>Organization<input name="organization" autocomplete="organization" maxlength="120" required></label>
      <label>Role<input name="role" autocomplete="organization-title" maxlength="120" required></label>
      <label>CAGE or UEI<input name="cageuei" maxlength="12" spellcheck="false" placeholder="Optional with a .gov or .mil email"></label>
      <label class="plg-wide">Note<textarea name="note" rows="2" maxlength="500" placeholder="Program, contract, or unit (optional)"></textarea></label>
      <p class="plg-form-err" role="alert">${esc(error)}</p>
      <div class="plg-form-row"><button type="button" class="btn-mini" data-plg-govcancel>Cancel</button><button type="submit" class="plg-act" data-kind="buy">Send request</button></div>
    </form></div></div>`;
}

/** The license, shown before checkout (ADR-0464). Continue stays disabled until the box is ticked. */
export function buySheetHtml(p: SoldPlugin): string {
  return `<div class="plg-sheet" role="dialog" aria-modal="true" aria-labelledby="plgSheetTitle">
    <div class="plg-sheet-h"><b id="plgSheetTitle">Buy ${esc(p.name)}</b><button type="button" class="set-close" data-plg-sheet-close aria-label="Close">${icon("close", 15)}</button></div>
    <p class="plg-sheet-price">One-time ${PLUGIN_PRICE_LABEL}. Yours for good, with free updates. It runs on this machine and never needs to call home.</p>
    <p class="plg-sheet-sub">${esc(PLUGIN_LICENSE_NAME)}, in short:</p>
    <ul class="plg-sheet-list">
      <li>A perpetual license for one user, not transferable, to run the plugin inside LUCID Agent.</li>
      <li>No redistribution, resale, reverse engineering, or getting around the license check.</li>
      <li>Provided as is, without warranty. Copyright TECHLEAD 187 LLC. Florida law applies.</li>
    </ul>
    <button type="button" class="plg-lic" data-plg-ext="${esc(PLUGIN_LICENSE_URL)}">Read the full license${icon("arrowRight", 12)}</button>
    <label class="plg-accept"><input type="checkbox" data-plg-accept> I accept the ${esc(PLUGIN_LICENSE_NAME)}.</label>
    <div class="plg-form-row"><button type="button" class="btn-mini" data-plg-sheet-close>Cancel</button><button type="button" class="plg-act" data-kind="buy" data-plg-checkout="${esc(p.id)}" disabled>Continue to checkout</button></div>
  </div>`;
}

/** The installed package's own LICENSE file. */
export function licenseTextSheetHtml(name: string, version: string, text: string): string {
  return `<div class="plg-sheet plg-sheet-wide" role="dialog" aria-modal="true" aria-labelledby="plgSheetTitle">
    <div class="plg-sheet-h"><b id="plgSheetTitle">${esc(name)} ${esc(version)} license</b><button type="button" class="set-close" data-plg-sheet-close aria-label="Close">${icon("close", 15)}</button></div>
    <pre class="plg-license">${esc(text)}</pre>
    <div class="plg-form-row"><button type="button" class="plg-lic" data-plg-ext="${esc(PLUGIN_LICENSE_URL)}">Published copy${icon("arrowRight", 12)}</button><button type="button" class="btn-mini" data-plg-sheet-close>Close</button></div>
  </div>`;
}

export function drawerShellHtml(tier: PluginTier, query: string): string {
  const tab = (t: PluginTier, label: string) =>
    `<button type="button" role="tab" id="plgTab-${t}" aria-controls="plgBody" aria-selected="${tier === t}" tabindex="${tier === t ? 0 : -1}" data-plg-tier="${t}">${label}</button>`;
  return `<div class="plg-drawer" id="plgDrawer" role="dialog" aria-modal="true" aria-labelledby="plgTitle">
    <div class="plg-head">
      <div class="plg-title" id="plgTitle">${icon("plugins", 17)}<span>Plugins</span></div>
      <div class="plg-seg" role="tablist" aria-label="Plugin tier">${tab("premium", "Premium")}${tab("free", "Free")}</div>
      <input class="plg-search" id="plgSearch" type="search" value="${esc(query)}" placeholder="Search plugins" aria-label="Search plugins" autocomplete="off" spellcheck="false">
      <button type="button" class="set-close" data-plg-close aria-label="Close plugins">${icon("close", 16)}</button>
    </div>
    <div class="plg-body" id="plgBody" role="tabpanel" aria-labelledby="plgTab-${tier}" tabindex="-1"></div>
  </div>`;
}

// ── controller ─────────────────────────────────────────────────────────────────────────────────────

export interface PluginsFlyoutDeps {
  provider: () => EntitlementProvider;
  user: () => AuthState;
  beginSignIn: () => { opened: boolean; signedIn: boolean; reason?: string };
  pluginsList: () => Promise<PluginsListView | null>;
  installFromUrl: (url: string, expectId: string) => Promise<PluginInstallView | null>;
  start: (id: string) => Promise<PluginStartView | null>;
  license: (id: string) => Promise<PluginLicenseView | null>;
  openExternal: (url: string) => void;
  /** Show a running plugin in its own Preview tab. */
  openPluginTab: (id: string, name: string, url: string) => void;
  toast: (t: ToastOpts) => void;
  /** The Preview panel: the drawer's right edge sits on its left edge. */
  anchor: () => HTMLElement | null;
  /** The left rail's right edge, which the drawer never slides under. */
  minLeft: () => number;
  storage: Pick<Storage, "getItem" | "setItem">;
  now: () => number;
}

export interface PluginsFlyout {
  /** Open (or switch tier when already open). Focus returns to `from` on close (default: the focused element). */
  open(tier?: PluginTier, from?: HTMLElement | null): void;
  close(): void;
  /** The toolbar button: open when closed, close when open. Focus returns to `opener` on close. */
  toggle(opener?: HTMLElement | null): void;
  isOpen(): boolean;
  /** A `lucid://auth` sign-in landed. True when it resumed a plugin purchase the user started. */
  onSignedIn(): boolean;
  /** The window regained focus: finish a checkout the user completed in the browser. */
  onWindowFocus(): void;
}

/** Plain-language reasons for each install gate (ADR-0462), so a refusal says what failed. */
const GATE_TEXT: Record<PluginGate, string> = {
  manifest: "The package manifest is not valid",
  hash: "A file in the package does not match its recorded checksum",
  signature: "The package is not signed by a trusted publisher",
  authenticode: "A program in the package is not signed by TECHLEAD 187 LLC",
  scan: "The security scan stopped the package",
  download: "The package could not be downloaded",
};

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function createPluginsFlyout(deps: PluginsFlyoutDeps): PluginsFlyout {
  let root: HTMLElement | null = null;
  let opener: HTMLElement | null = null;
  let tier: PluginTier = parseTierPref(deps.storage.getItem(TIER_PREF_KEY));
  let query = "";
  let videos: IntersectionObserver | null = null;
  const ents = new Map<string, Entitlement | null>();
  const installed = new Map<string, InstalledPluginView>();
  const busy = new Set<string>();
  const notes = new Map<string, CardNote>();
  let gov: GovAccessStatus = "none";
  let govFormOpen = false;
  let govError = "";
  /** A purchase the user started and that a browser detour interrupted (sign-in or Stripe Checkout). */
  let pending: (PendingCheckout & { stage: "signin" | "checkout" }) | null = null;

  const premium = (id: string) => PREMIUM_PLUGINS.find((p) => p.id === id);
  const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  function actionFor(p: PremiumPlugin): CardAction {
    return decideCardAction(p, {
      signedIn: deps.user().signedIn,
      entitlement: ents.get(p.id) ?? null,
      gov,
      installedVersion: installed.get(p.id)?.version ?? null,
      busy: busy.has(p.id),
      nowIso: new Date(deps.now()).toISOString(),
    });
  }

  function setNote(id: string, note: CardNote | null): void {
    if (note) notes.set(id, note); else notes.delete(id);
    paintFoot(id);
  }

  function paintFoot(id: string): void {
    const p = premium(id);
    const slot = root?.querySelector(`[data-plg-foot="${CSS.escape(id)}"]`);
    if (p && slot) slot.innerHTML = premiumFootHtml(p, actionFor(p), installed.has(id), notes.get(id) ?? null);
  }

  function paintGov(): void {
    const slot = root?.querySelector("[data-plg-gov]");
    if (slot) slot.innerHTML = govPanelHtml(deps.user().signedIn, gov, govFormOpen, govError);
  }

  function paintAllFeet(): void { for (const p of PREMIUM_PLUGINS) paintFoot(p.id); paintGov(); }

  function bodyHtml(): string {
    const empty = `<p class="plg-empty">No plugins match "${esc(query.trim())}".</p>`;
    if (tier === "free") {
      const cards = sortFree(FREE_PLUGINS).filter((p) => matchesQuery([p.name, p.desc, p.category, p.lucid], query)).map(freeCardHtml);
      return `<p class="plg-lede">Integrations that are free with LUCID Agent: the ones already built in, and the ones on the way.</p>`
        + (cards.length ? `<div class="plg-grid">${cards.join("")}</div>` : empty);
    }
    const section = (s: "civilian" | "government") => PREMIUM_PLUGINS
      .filter((p) => p.section === s && matchesQuery([p.name, p.kicker, p.pitch, p.lucid, p.sale === "link" ? (p.partner ?? "") : ""], query))
      .map((p) => premiumCardHtml(p, actionFor(p), installed.has(p.id), notes.get(p.id) ?? null));
    const civ = section("civilian"), govCards = section("government");
    if (!civ.length && !govCards.length) return empty;
    return `<p class="plg-lede">Full LUCID apps that install in one click and open in a Preview tab. ${PLUGIN_PRICE_LABEL} each, one time, under the <button type="button" class="plg-inline" data-plg-ext="${esc(PLUGIN_LICENSE_URL)}">${esc(PLUGIN_LICENSE_NAME)}</button>.</p>`
      + (civ.length ? `<section class="plg-sec" aria-labelledby="plgSecCiv"><h3 class="plg-h" id="plgSecCiv">Civilian</h3><div class="plg-grid">${civ.join("")}</div></section>` : "")
      + (govCards.length ? `<section class="plg-sec" aria-labelledby="plgSecGov"><h3 class="plg-h" id="plgSecGov">Government</h3><p class="plg-sec-sub">Sold only after government access is verified. ${esc(BLACK_ARROW)} partner apps open on the partner's site.</p><div data-plg-gov>${govPanelHtml(deps.user().signedIn, gov, govFormOpen, govError)}</div><div class="plg-grid">${govCards.join("")}</div></section>` : "");
  }

  function render(): void {
    const body = root?.querySelector("#plgBody") as HTMLElement | null;
    if (!root || !body) return;
    for (const b of root.querySelectorAll<HTMLElement>("[data-plg-tier]")) {
      const on = b.dataset.plgTier === tier;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    body.setAttribute("aria-labelledby", `plgTab-${tier}`);
    body.innerHTML = bodyHtml();
    body.scrollTop = 0;
    watchVideos(body);
  }

  /** Loops get their source only on screen and pause off screen; reduced motion keeps every poster still. */
  function watchVideos(body: HTMLElement): void {
    videos?.disconnect();
    videos = null;
    if (reducedMotion() || typeof IntersectionObserver === "undefined") return;
    videos = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const v = e.target as HTMLVideoElement;
        if (e.isIntersecting) {
          if (!v.getAttribute("src") && v.dataset.src) v.src = v.dataset.src;
          void v.play().catch(() => { /* a decode failure leaves the poster */ });
        } else if (!v.paused) v.pause();
      }
    }, { root: body, threshold: 0.35 });
    for (const v of body.querySelectorAll("video.plg-loop")) videos.observe(v);
  }

  async function refresh(): Promise<void> {
    const prov = deps.provider();
    const signedIn = deps.user().signedIn;
    const sold = PREMIUM_PLUGINS.filter((p) => p.sale === "buy");
    const [list, entList, govStatus] = await Promise.all([
      deps.pluginsList().catch(() => null),
      signedIn ? Promise.all(sold.map((p) => prov.entitlement(p.id).catch(() => null))) : Promise.resolve(sold.map(() => null)),
      signedIn ? prov.govAccess().catch((): GovAccessStatus => "none") : Promise.resolve<GovAccessStatus>("none"),
    ]);
    installed.clear();
    for (const p of list?.plugins ?? []) installed.set(p.id, p);
    sold.forEach((p, i) => ents.set(p.id, entList[i] ?? null));
    gov = govStatus;
    paintAllFeet();
  }

  function setTier(t: PluginTier): void {
    if (t === tier) return;
    tier = t;
    try { deps.storage.setItem(TIER_PREF_KEY, t); } catch { /* private mode: the choice lasts this session */ }
    render();
  }

  function place(): void {
    const drawer = root?.querySelector(".plg-drawer") as HTMLElement | null;
    const anchor = deps.anchor();
    if (!drawer) return;
    const r = anchor && !anchor.hidden ? anchor.getBoundingClientRect() : null;
    const g = drawerGeometry(window.innerWidth, r ? r.left : window.innerWidth, deps.minLeft());
    drawer.style.left = `${g.left}px`;
    drawer.style.width = `${g.width}px`;
    drawer.style.top = `${r ? r.top : 0}px`;
    drawer.style.height = `${r ? r.height : window.innerHeight}px`;
  }

  function focusables(scope: HTMLElement): HTMLElement[] {
    return [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
  }

  function onKey(e: KeyboardEvent): void {
    if (!root) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (root.querySelector(".plg-sheet")) closeSheet(); else close();
      return;
    }
    if (e.key === "Tab") {
      const scope = (root.querySelector(".plg-sheet") as HTMLElement | null) ?? (root.querySelector(".plg-drawer") as HTMLElement);
      const list = focusables(scope);
      if (!list.length) { e.preventDefault(); return; }
      const first = list[0]!, last = list[list.length - 1]!;
      const inside = scope.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
      return;
    }
    // Arrow keys move between the two tier tabs (the WAI-ARIA tabs pattern).
    const tab = (e.target as HTMLElement).closest?.("[data-plg-tier]");
    if (tab && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      setTier(tier === "premium" ? "free" : "premium");
      (root.querySelector(`[data-plg-tier="${tier}"]`) as HTMLElement | null)?.focus();
    }
  }

  function onPointerDown(e: PointerEvent): void {
    const t = e.target as Node;
    if (!root || root.contains(t)) return;
    // The buttons that open the drawer run their own toggle; a toast action about a plugin is not a click away.
    if ((t as HTMLElement).closest?.("[data-plg-toggle], #toasts")) return;
    close();
  }

  const onResize = () => place();

  function closeSheet(): void {
    root?.querySelector(".plg-sheet-scrim")?.remove();
    (root?.querySelector("#plgSearch") as HTMLElement | null)?.focus();
  }

  function showSheet(html: string): void {
    if (!root) return;
    root.querySelector(".plg-sheet-scrim")?.remove();
    const scrim = document.createElement("div");
    scrim.className = "plg-sheet-scrim";
    scrim.innerHTML = html;
    root.querySelector(".plg-drawer")?.append(scrim);
    (focusables(scrim.querySelector(".plg-sheet") as HTMLElement)[0] ?? scrim).focus();
  }

  function open(t?: PluginTier, from?: HTMLElement | null): void {
    if (t) setTier(t);
    if (root) return;
    opener = from ?? opener ?? (document.activeElement as HTMLElement | null);
    root = document.createElement("div");
    root.className = "plg-layer";
    root.innerHTML = drawerShellHtml(tier, query);
    document.body.append(root);
    place();
    render();
    requestAnimationFrame(() => root?.classList.add("plg-in"));
    (root.querySelector(`[data-plg-tier="${tier}"]`) as HTMLElement | null)?.focus();
    root.addEventListener("click", onClick);
    root.addEventListener("input", onInput);
    root.addEventListener("submit", onSubmit);
    root.addEventListener("change", onChange);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", onResize);
    for (const b of document.querySelectorAll("[data-plg-toggle]")) b.setAttribute("aria-expanded", "true");
    void refresh();
  }

  function close(): void {
    if (!root) return;
    const el = root;
    root = null;
    videos?.disconnect();
    videos = null;
    for (const v of el.querySelectorAll("video")) v.pause();
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("resize", onResize);
    for (const b of document.querySelectorAll("[data-plg-toggle]")) b.setAttribute("aria-expanded", "false");
    el.classList.remove("plg-in");
    el.classList.add("plg-out");
    window.setTimeout(() => el.remove(), reducedMotion() ? 0 : 200);
    const back = opener;
    opener = null;
    if (back?.isConnected) back.focus();
  }

  function onInput(e: Event): void {
    const t = e.target as HTMLInputElement;
    if (t.id !== "plgSearch") return;
    query = t.value;
    render();
  }

  function onChange(e: Event): void {
    const t = e.target as HTMLInputElement;
    if (t.matches("[data-plg-accept]")) {
      const go = root?.querySelector("[data-plg-checkout]") as HTMLButtonElement | null;
      if (go) go.disabled = !t.checked;
    }
  }

  function onClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    const hit = (sel: string) => t.closest(sel) as HTMLElement | null;
    let el: HTMLElement | null;
    if ((el = hit("[data-plg-close]"))) { close(); return; }
    if ((el = hit("[data-plg-sheet-close]"))) { closeSheet(); return; }
    if (t.classList.contains("plg-sheet-scrim")) { closeSheet(); return; }
    if ((el = hit("[data-plg-tier]"))) { setTier(parseTierPref(el.dataset.plgTier)); return; }
    if ((el = hit("[data-plg-repo]"))) { deps.openExternal(el.dataset.plgRepo!); return; }
    if ((el = hit("[data-plg-ext]"))) { deps.openExternal(el.dataset.plgExt!); return; }
    if ((el = hit("[data-plg-checkout]"))) { void checkout(el.dataset.plgCheckout!); return; }
    if ((el = hit("[data-plg-license]"))) { void showLicense(el.dataset.plgLicense!); return; }
    if (hit("[data-plg-signin]")) { signIn(null); return; }
    if (hit("[data-plg-govopen]")) { openGovForm(); return; }
    if (hit("[data-plg-govcancel]")) { govFormOpen = false; govError = ""; paintGov(); return; }
    if ((el = hit("[data-plg-act]"))) void act(el.dataset.plgAct!);
  }

  function openGovForm(): void {
    govFormOpen = true;
    govError = "";
    paintGov();
    const panel = root?.querySelector("[data-plg-gov]");
    panel?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
    (panel?.querySelector("input") as HTMLInputElement | null)?.focus();
  }

  async function act(id: string): Promise<void> {
    const p = premium(id);
    if (!p) return;
    const a = actionFor(p);
    switch (a.kind) {
      case "visit": deps.openExternal(a.url); return;
      case "signin": signIn(p); return;
      case "request-access": openGovForm(); return;
      case "buy": if (p.sale === "buy") showSheet(buySheetHtml(p)); return;
      case "install": case "update": await install(p); return;
      case "open": await openPlugin(p); return;
      case "access-pending": case "installing": case "coming-soon": return;
    }
  }

  function signIn(p: PremiumPlugin | null): void {
    const r = deps.beginSignIn();
    if (r.signedIn) { void refresh().then(() => { if (p) void act(p.id); }); return; }
    if (r.opened) {
      if (p) pending = { packId: p.id, packName: p.name, startedAt: deps.now(), stage: "signin" };
      deps.toast({
        title: p ? `Finish signing in for ${p.name}` : "Finish signing in",
        desc: "Your account holds your plugin licenses, so they install on every machine you sign in to. Come back when you are done and this picks up on its own.",
        timeout: 6000,
      });
      return;
    }
    deps.toast({ tone: "warn", title: "Sign-in is not available", desc: r.reason ? `Sign-in is unavailable in this build: ${r.reason}.` : "Sign-in is unavailable in this build.", timeout: 6000 });
  }

  async function checkout(id: string): Promise<void> {
    const p = premium(id);
    if (!p || p.sale !== "buy") return;
    closeSheet();
    setNote(id, { tone: "info", text: "Opening checkout in your browser." });
    const prov = deps.provider();
    const url = await prov.checkoutUrl(id, "one-time").catch(() => null);
    if (url) {
      pending = { packId: id, packName: p.name, startedAt: deps.now(), stage: "checkout" };
      deps.openExternal(url);
      setNote(id, { tone: "info", text: "Finish checkout in your browser. The install starts when you come back to LUCID." });
      return;
    }
    // No checkout page: either a dev build that grants instantly (stub) or a refusal. The entitlement decides.
    ents.set(id, await prov.entitlement(id).catch(() => null));
    if (actionFor(p).kind === "install") { await install(p); return; }
    if (p.section === "government") gov = await prov.govAccess().catch((): GovAccessStatus => "none");
    setNote(id, { tone: "danger", text: p.section === "government" && gov !== "approved"
      ? "Checkout needs approved government access for this account."
      : "Checkout is not available right now. Try again in a minute." });
    paintGov();
  }

  async function install(p: PremiumPlugin): Promise<void> {
    busy.add(p.id);
    setNote(p.id, { tone: "info", text: "Downloading the signed package." });
    try {
      const url = await deps.provider().downloadUrl(p.id).catch(() => null);
      if (!url) { setNote(p.id, { tone: "danger", text: "No download link came back. The purchase may still be processing, or the package is not published yet." }); return; }
      setNote(p.id, { tone: "info", text: "Checking the signature, checksums, and security scan." });
      const r = await deps.installFromUrl(url, p.id);
      if (!r) { setNote(p.id, { tone: "danger", text: "The install service did not answer. Is the LUCID engine running?" }); return; }
      if (!r.ok) {
        const why = `${GATE_TEXT[r.gate]}: ${r.reason}`;
        setNote(p.id, { tone: "danger", text: `Not installed. ${why}` });
        deps.toast({ tone: "danger", title: `${p.name} was not installed`, desc: why, timeout: 0, actions: [{ label: "OK" }] });
        return;
      }
      const list = await deps.pluginsList().catch(() => null);
      for (const x of list?.plugins ?? []) installed.set(x.id, x);
      setNote(p.id, { tone: "ok", text: `Installed version ${r.version}.` });
      deps.toast({ tone: "ok", title: `${p.name} is installed`, desc: "It runs on this machine. Open it in a Preview tab.", timeout: 6000, actions: [{ label: "Open", kind: "ok", run: () => void openPlugin(p) }] });
    } finally {
      busy.delete(p.id);
      paintFoot(p.id);
    }
  }

  async function openPlugin(p: PremiumPlugin): Promise<void> {
    setNote(p.id, { tone: "info", text: `Starting ${p.name}.` });
    const r = await deps.start(p.id).catch(() => null);
    if (r?.ok) {
      setNote(p.id, null);
      deps.openPluginTab(p.id, p.name, r.url);
      close();
      return;
    }
    setNote(p.id, { tone: "danger", text: `${p.name} did not start${r && !r.ok && r.error ? `: ${r.error}` : "."}` });
  }

  async function showLicense(id: string): Promise<void> {
    const p = premium(id);
    if (!p) return;
    if (!installed.has(id)) { deps.openExternal(PLUGIN_LICENSE_URL); return; }
    const v = await deps.license(id).catch(() => null);
    if (!v?.ok || !v.text) { deps.openExternal(PLUGIN_LICENSE_URL); return; }
    showSheet(licenseTextSheetHtml(p.name, v.version ?? installed.get(id)?.version ?? "", v.text));
  }

  async function onSubmit(e: SubmitEvent): Promise<void> {
    const form = (e.target as HTMLElement).closest("[data-plg-govform]") as HTMLFormElement | null;
    if (!form) return;
    e.preventDefault();
    const field = (n: string) => String(new FormData(form).get(n) ?? "").trim();
    const organization = field("organization"), role = field("role"), note = field("note");
    const ids = parseCageOrUei(field("cageuei"));
    govError = !organization || !role ? "Organization and role are required." : "error" in ids ? ids.error : "";
    if (govError) { const err = form.querySelector(".plg-form-err"); if (err) err.textContent = govError; return; }
    const sent = await deps.provider().requestGovAccess({ organization, role, ...ids, ...(note ? { note } : {}) }).catch(() => null);
    if (!sent) { govError = "The request did not go through. Check your connection and try again."; paintGov(); return; }
    gov = sent;
    govFormOpen = false;
    paintAllFeet();
    deps.toast(sent === "approved"
      ? { tone: "ok", title: "Government access approved", desc: "Buy is now available on the Government plugins.", timeout: 6000 }
      : { title: "Request sent", desc: "The TECHLEAD 187 team reviews requests and approves or declines them. Buy unlocks when access is approved.", timeout: 7000 });
  }

  return {
    open,
    close,
    toggle(btn) { if (root) close(); else { opener = btn ?? null; open(); } },
    isOpen: () => root !== null,
    onSignedIn() {
      const pend = pending;
      if (pend?.stage === "signin" && shouldResumeCheckout(pend, deps.now())) {
        pending = null;
        open("premium");
        deps.toast({ title: `Signed in, picking up ${pend.packName}`, desc: "Resuming right where you left off.", timeout: 4000 });
        void refresh().then(() => act(pend.packId));
        return true;
      }
      if (pend?.stage === "signin") pending = null; // stale: a later, unrelated sign-in must never start a purchase
      if (root) void refresh();
      return false;
    },
    onWindowFocus() {
      const pend = pending;
      if (pend?.stage !== "checkout") return;
      if (!shouldResumeCheckout(pend, deps.now())) { pending = null; return; }
      const p = premium(pend.packId);
      if (!p) { pending = null; return; }
      void deps.provider().entitlement(p.id).catch(() => null).then((ent) => {
        ents.set(p.id, ent);
        if (actionFor(p).kind !== "install" || pending !== pend) { paintFoot(p.id); return; }
        pending = null;
        void install(p);
      });
    },
  };
}
