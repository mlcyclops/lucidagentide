// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/about.ts - the "About LUCID Agent IDE" panel.
//
// Pure string builders (no DOM), so the demo + test can assert on the markup without a browser.
// app.ts owns open/close + Escape wiring; styles.css owns the animation + dark-mode polish.
//
//  - readmeMark()      the animated rail glyph (book + twinkling sparkle), 24×24 / 1.6 stroke to
//                      match the icon family, with CSS-animated parts (#railAbout in styles.css).
//  - lucidLogo()       the big LUCID · AGENT IDE wordmark for the panel hero.
//  - techLeadLogo()    the TechLead 187 emblem (gradient rounded square + "187" monogram).
//  - aboutHtml(ver)    the full panel inner HTML; `ver` comes from APP_VERSION (single source).

// Small HTML escape for any interpolated value (version string is ours, but stay disciplined).
const e = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The animated rail/README glyph: an open book with a twinkling sparkle. Matches the line-icon family. */
export function readmeMark(): string {
  return `<svg class="ic about-mark" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path class="about-book" d="M12 7.2C10.2 6 7.9 5.7 5.8 6.1V17.6C7.9 17.2 10.2 17.5 12 18.7"/>
    <path class="about-book" d="M12 7.2C13.8 6 16.1 5.7 18.2 6.1V17.6C16.1 17.2 13.8 17.5 12 18.7"/>
    <path class="about-book" d="M12 7.2V18.7"/>
    <path class="about-spark" d="M18.4 3.1l.62 1.46 1.46.62-1.46.62-.62 1.46-.62-1.46-1.46-.62 1.46-.62z"/>
  </svg>`;
}

/** The LUCID · AGENT IDE wordmark for the panel hero (animated glow via styles.css). */
export function lucidLogo(): string {
  // A bigger sibling of the titlebar π mark.
  const pi = `<svg class="about-pi" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M5 8h14"/><path d="M9 8v9"/><path d="M16 8v7a2 2 0 0 0 2 2"/></svg>`;
  return `<div class="about-word"><span class="about-lucid">LUCID</span>${pi}</div>
    <div class="about-subword">AGENT&nbsp;IDE</div>`;
}

/** The TechLead 187 brand avatar - the real logo image inside a premium animated gradient ring. */
export function techLeadLogo(): string {
  return `<span class="about-tl-avatar" aria-hidden="true">
    <span class="about-tl-ring"></span>
    <img class="about-tl-img" src="assets/techlead187-avatar.png" alt="" width="46" height="46" loading="lazy" decoding="async" />
  </span>`;
}

/** Full inner HTML for the About panel. `version` is APP_VERSION (single source of truth). */
export function aboutHtml(version: string): string {
  const v = e(version);
  return `<div class="about-modal" role="dialog" aria-modal="true" aria-labelledby="aboutTitle">
    <button class="about-x" data-about-close aria-label="Close">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg>
    </button>

    <div class="about-hero">
      <div class="about-glow" aria-hidden="true"></div>
      <div class="about-logo" id="aboutTitle">${lucidLogo()}</div>
      <div class="about-tag">Secure agentic IDE · provenance · memory</div>
      <div class="about-ver" data-tip="App version">v${v}</div>
    </div>

    <p class="about-blurb">
      <b>LUCID Agent IDE</b> wraps the open agent runtime in a security, provenance, and memory layer.
      Every tool call is scanned <i>before</i> it runs, untrusted content is delimited and quarantined,
      and your personalization graph stays encrypted on your own machine. Fail-closed by design.
    </p>

    <div class="about-card">
      <div class="about-brand">
        ${techLeadLogo()}
        <div class="about-brand-txt">
          <b>TechLead&nbsp;187&nbsp;LLC</b>
          <span>© 2026 TechLead 187 LLC · All rights reserved</span>
        </div>
      </div>

      <div class="about-lic">
        <div class="about-lic-row"><span>License</span><b>Business Source License 1.1</b></div>
        <div class="about-lic-row"><span>Model</span><b>Source-available · production use OK*</b></div>
        <div class="about-lic-row"><span>Change date</span><b>2030-06-27 → MPL-2.0</b></div>
      </div>
      <p class="about-fine">
        *Except offering a hosted or embedded product competitive with TechLead 187 LLC. BUSL-1.1 is
        <b>source-available, not OSI open-source</b>; each version converts to the Mozilla Public License 2.0
        on its Change Date. See the bundled <span class="about-mono">LICENSE</span> for the full terms.
      </p>
    </div>

    <div class="about-actions">
      <button class="btn-mini" data-about-tour>
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5.5v13l11-6.5z"/></svg>
        Take the tour
      </button>
      <button class="btn-mini ok" data-about-close>Close</button>
    </div>
  </div>`;
}
