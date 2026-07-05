// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/icons.ts - hand-drawn line-icon set. 24×24, 1.6 stroke,
// round caps/joins, currentColor. Consistent optical weight across the set so
// the activity rail reads as one family. Used in the rail, tooltips, buttons.

const P = (d: string) => `<path d="${d}"/>`;

const RAW: Record<string, string> = {
  // chat / conversation
  chat: P("M4 5.5h16v10a1.5 1.5 0 0 1-1.5 1.5H9l-4 3.2V17H5.5A1.5 1.5 0 0 1 4 15.5z"),
  // shield (security)
  shield: P("M12 3 5 5.6v5c0 4.3 3 7.6 7 9.4 4-1.8 7-5.1 7-9.4v-5z") + P("M9 11.6l2.1 2.1L15 9.8"),
  // memory / context (concentric synapse)
  brain:
    P("M12 4.5a3 3 0 0 0-3 3 2.6 2.6 0 0 0-1.6 4.6A2.7 2.7 0 0 0 9 16.8 2.4 2.4 0 0 0 12 19a2.4 2.4 0 0 0 3-2.2 2.7 2.7 0 0 0 1.6-4.7A2.6 2.6 0 0 0 15 7.5a3 3 0 0 0-3-3z") +
    P("M12 4.5v14.5"),
  // P-CHAT.1: a plain right arrow (→) for "Open in editor" (the old `expand` glyph is double LEFT chevrons).
  arrowRight: P("M5 12h13") + P("M13 6l6 6-6 6"),
  // ROI / cost-savings ($ in a circle) — the "Memory & context" panel is mostly prompt-cache savings + showback.
  savings: P("M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z") + P("M12 6.6v10.8")
    + P("M14.6 9.2a2.5 2.5 0 0 0-2.6-1.6c-1.4 0-2.5.8-2.5 2s1 1.7 2.5 2 2.6.9 2.6 2.1-1.2 2.1-2.6 2.1a2.6 2.6 0 0 1-2.6-1.7"),
  // runs / lineage (branch)
  runs: P("M7 5v9") + P("M7 18.5a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z") + P("M7 8.2a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z") + P("M17 9.5a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z") + P("M17 8.2V11a3 3 0 0 1-3 3H7"),
  // knowledge graph (nodes + edges)
  graph: P("M8 8 17 7.5") + P("M8 8 10.5 17.5") + P("M17 7.5 16 16") + P("M10.5 17.5 16 16")
    + "<circle cx='8' cy='8' r='2.4' fill='currentColor' stroke='none'/><circle cx='17' cy='7.5' r='2' fill='currentColor' stroke='none'/><circle cx='10.5' cy='17.5' r='2.4' fill='currentColor' stroke='none'/><circle cx='16' cy='16' r='2' fill='currentColor' stroke='none'/>",
  // settings (sliders)
  sliders: P("M5 8h7") + P("M16 8h3") + P("M5 16h3") + P("M12 16h7") + P("M14 6v4") + P("M8 14v4"),
  // search
  search: P("M11 4.5a6 6 0 1 0 0 12 6 6 0 0 0 0-12z") + P("M20 20l-4.4-4.4"),
  // send (paper plane)
  send: P("M5 12 20 5l-4.5 14.5-3.8-5.7z") + P("M11.7 13.8 20 5"),
  // plus
  plus: P("M12 5v14") + P("M5 12h14"),
  // chevron right (rotate via CSS)
  chevron: P("M9.5 6 15 12l-5.5 6"),
  // model / spark (cpu)
  spark: P("M7 7h10v10H7z") + P("M10 4v3") + P("M14 4v3") + P("M10 17v3") + P("M14 17v3") + P("M4 10h3") + P("M4 14h3") + P("M17 10h3") + P("M17 14h3"),
  // bolt
  bolt: P("M12 3 6 13h5l-1 8 6-11h-5z"),
  // clock (scheduled automations) - ring + hands
  clock: P("M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14z") + P("M12 8.5V12l2.5 1.6"),
  // close
  close: P("M6 6l12 12") + P("M18 6 6 18"),
  // trash / delete
  trash: P("M5 7h14") + P("M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7") + P("M6.6 7l.8 11.1A1.6 1.6 0 0 0 9 19.6h6a1.6 1.6 0 0 0 1.6-1.5L17.4 7") + P("M10 11v5") + P("M14 11v5"),
  // minimise / maximise (window controls)
  minus: P("M6 12h12"),
  square: P("M6 6.5h12v11H6z"),
  // collapse-right / expand-left (inspector ↔ metrics rail)
  collapse: P("M7 6l5 6-5 6") + P("M13 6l5 6-5 6"),
  expand: P("M17 6l-5 6 5 6") + P("M11 6l-5 6 5 6"),
  // person (user avatar) + sidebar toggle
  user: P("M12 12.5a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8z") + P("M5.5 19a6.5 6.5 0 0 1 13 0"),
  sidebar: P("M4 5.5h16v13H4z") + P("M9.5 5.5v13"),
  // folder + git (workspace)
  folder: P("M4 7.5A1.5 1.5 0 0 1 5.5 6h3.3l1.7 2h8A1.5 1.5 0 0 1 20 9.5v7a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5z"),
  git: P("M7 8.5a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4z") + P("M7 18.9a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4z") + P("M17 9.6a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4z") + P("M7 8.5v7") + P("M17 9.6v.9a4 4 0 0 1-4 4H7"),
  // command (⌘ - looped-square: center square + four corner rings)
  command: P("M9 9h6v6H9z") +
    P("M9 9V7.5A2.5 2.5 0 1 0 6.5 10H9") +
    P("M15 9V7.5A2.5 2.5 0 1 1 17.5 10H15") +
    P("M9 15v1.5A2.5 2.5 0 1 1 6.5 14H9") +
    P("M15 15v1.5a2.5 2.5 0 1 0 2.5-2.5H15"),
  // eye (review)
  eye: P("M3.5 12S6.5 6.5 12 6.5 20.5 12 20.5 12 17.5 17.5 12 17.5 3.5 12 3.5 12z") + P("M12 14.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z"),
  // check
  check: P("M5 12.5 10 17 19 7"),
  // info
  info: P("M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z") + P("M12 11v5") + P("M12 8h.01"),
  // pin / dock
  layout: P("M4 5.5h16v13H4z") + P("M14 5.5v13"),
  // logs / developer console - a terminal frame with a ">" prompt + cursor line
  logs: P("M4 5.5h16v13H4z") + P("M7.5 9.7 10 12l-2.5 2.3") + P("M11.8 14.3h4.7"),
  // refresh
  refresh: P("M5 12a7 7 0 0 1 12-5l2 2") + P("M19 5v4h-4") + P("M19 12a7 7 0 0 1-12 5l-2-2") + P("M5 19v-4h4"),
  // copy (two overlapping cards)
  copy: P("M9.5 9.5h8v8h-8z") + P("M6.5 14.5H6A1.5 1.5 0 0 1 4.5 13V6A1.5 1.5 0 0 1 6 4.5h7A1.5 1.5 0 0 1 14.5 6v.5"),
  // download (save to disk)
  download: P("M12 4v9.5") + P("M8 10.5l4 4 4-4") + P("M5 18.5h14"),
  // P-VOICE.1: microphone (speech-to-text) — capsule + stand + base
  mic: P("M12 4.5a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 12 4.5z") + P("M6.5 11a5.5 5.5 0 0 0 11 0") + P("M12 16.5v3") + P("M9 19.5h6"),
  // P-VOICE.1: speaker / read-aloud (text-to-speech) — cone + two sound waves
  volume: P("M5 9.5h3l4-3v11l-4-3H5z") + P("M15 9a4 4 0 0 1 0 6") + P("M17.5 7a7 7 0 0 1 0 10"),
  // P-REPORT.1: engineering reports — a document (folded corner) with two text lines
  report: P("M6.5 4.5h7l4 4v10.5a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-13.5a1 1 0 0 1 1-1z") + P("M13.5 4.5v4h4") + P("M8.8 12.5h6.4") + P("M8.8 15.3h6.4"),
  // P-REPORT.2: archive (box + lid + handle), restore (counter-clockwise arrow). `trash` already exists.
  archive: P("M4.5 6h15v3.5h-15z") + P("M6 9.5v8.5a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9.5") + P("M9.5 13h5"),
  restore: P("M5 12a7 7 0 1 0 2-4.9") + P("M5 4.5V8h3.5"),
  // lightbulb (thinking) - glass dome + neck, filament tick, two base lines
  bulb: P("M12 4.2a5 5 0 0 0-3 9c.7.5 1.1 1.3 1.2 2.1h3.6c.1-.8.5-1.6 1.2-2.1a5 5 0 0 0-3-9z")
    + P("M10.4 18.6h3.2") + P("M10.9 20.6h2.2") + P("M12 9.2v2.4") + P("M10.7 10.4h2.6"),
  // double chevron down (jump-to-latest) - two stacked downward carets
  chevronsDown: P("M6.5 7.5 12 13l5.5-5.5") + P("M6.5 13 12 18.5 17.5 13"),
  // center / re-fit the graph (crosshair) — P-KG-CODE.1b
  center: P("M12 3.5v3.2") + P("M12 17.3v3.2") + P("M3.5 12h3.2") + P("M17.3 12h3.2")
    + "<circle cx='12' cy='12' r='4.3' fill='none'/>" + "<circle cx='12' cy='12' r='1' fill='currentColor' stroke='none'/>",
  // ── preview markup tools (P-PREVIEW.5) ──
  // pen (freehand draw) — nib + body
  pen: P("M5.4 18.6l-1.4 1.4.9-3.6L15.2 5.6a1.6 1.6 0 0 1 2.3 0l.9.9a1.6 1.6 0 0 1 0 2.3L7.6 19.5z") + P("M13.6 7.2l3.2 3.2"),
  // text tool — a capital T with a small base serif
  textT: P("M6.5 7h11") + P("M12 7v11") + P("M9.5 18h5"),
  // markup (the tools dropdown) — a marker over a baseline
  markup: P("M4.5 19.5h15") + P("M8 16l1.3-3.5 6.3-6.3a1.5 1.5 0 0 1 2.1 0l.6.6a1.5 1.5 0 0 1 0 2.1L11.5 15z"),
  // printer (print / save-as-PDF) — paper feed, body, output tray, ink light
  print: P("M7.5 8.5V5a.5.5 0 0 1 .5-.5h8a.5.5 0 0 1 .5.5v3.5")
    + P("M7.5 16H6a2 2 0 0 1-2-2v-3.4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2V14a2 2 0 0 1-2 2h-1.5")
    + P("M7.5 13.5h9v5.5a.4.4 0 0 1-.4.4H7.9a.4.4 0 0 1-.4-.4z")
    + "<circle cx='16.4' cy='11.2' r='.75' fill='currentColor' stroke='none'/>",

  // ── premium scoreboard glyphs (P-REPORT.4) ──
  // gauge / speedometer (avg per turn) — dial arc, needle, hub
  gauge: P("M5 16.5a7 7 0 0 1 14 0") + P("M12 16.5l3.4-3.9")
    + "<circle cx='12' cy='16.5' r='1.35' fill='currentColor' stroke='none'/>"
    + P("M6.5 16.4h.02") + P("M8 12.3h.02") + P("M12 10.6h.02") + P("M16 12.3h.02") + P("M17.5 16.4h.02"),
  // loop / cycles (turns) — near-full ring with an arrowhead
  loop: P("M18.7 8.6A7 7 0 1 0 19 12") + P("M18.7 5v3.8h-3.8"),
  // scan / finder (findings) — corner brackets + a sweeping scan line + node
  scan: P("M5 8.4V6.6A1.6 1.6 0 0 1 6.6 5H8.4") + P("M15.6 5h1.8A1.6 1.6 0 0 1 19 6.6V8.4")
    + P("M19 15.6v1.8a1.6 1.6 0 0 1-1.6 1.6H15.6") + P("M8.4 19H6.6A1.6 1.6 0 0 1 5 17.4V15.6")
    + P("M6.8 12h10.4") + "<circle cx='12' cy='12' r='1.15' fill='currentColor' stroke='none'/>",
  // headphones (Listen / narrate) — duotone: stroked band + filled ear cups
  headphones: P("M5 14v-2a7 7 0 0 1 14 0v2")
    + "<path d='M4.6 13.4h1.6a1.1 1.1 0 0 1 1.1 1.1v3.4a1.1 1.1 0 0 1-1.1 1.1H6a1.4 1.4 0 0 1-1.4-1.4z' fill='currentColor' fill-opacity='.2'/>"
    + "<path d='M19.4 13.4h-1.6a1.1 1.1 0 0 0-1.1 1.1v3.4a1.1 1.1 0 0 0 1.1 1.1H18a1.4 1.4 0 0 0 1.4-1.4z' fill='currentColor' fill-opacity='.2'/>",
  // ── outcome badges (replace the ✅/⏹/🛑/❗ emoji in report headers with real glyphs) ──
  // duotone rounded-square backing (tinted) + the mark on top
  checkBadge: "<rect x='4' y='4' width='16' height='16' rx='5.2' fill='currentColor' fill-opacity='.17'/>"
    + "<rect x='4' y='4' width='16' height='16' rx='5.2' fill='none' stroke='currentColor' stroke-opacity='.5'/>"
    + P("M8.2 12.2 10.9 15 15.8 9.2"),
  stopBadge: "<rect x='4' y='4' width='16' height='16' rx='5.2' fill='currentColor' fill-opacity='.17'/>"
    + "<rect x='4' y='4' width='16' height='16' rx='5.2' fill='none' stroke='currentColor' stroke-opacity='.5'/>"
    + "<rect x='9' y='9' width='6' height='6' rx='1.6' fill='currentColor' stroke='none'/>",
  // P-MARKET.1: plugin marketplace — a package cube (lid fold + seam)
  market: P("M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z")
    + P("M3.3 7 12 12l8.7-5") + P("M12 12v9.4") + P("M16.5 9.4 7.5 4.2"),
  alertBadge: "<rect x='4' y='4' width='16' height='16' rx='5.2' fill='currentColor' fill-opacity='.17'/>"
    + "<rect x='4' y='4' width='16' height='16' rx='5.2' fill='none' stroke='currentColor' stroke-opacity='.5'/>"
    + P("M12 8.3v4.4") + P("M12 15.9h.01"),
};

// Action glyphs that read as "do something now" - they get the .ic-action hook
// so CSS can give them an extra spark on hover. Purely additive: behavior and
// default visual weight are unchanged.
const ACTION = new Set(["bolt", "spark", "refresh", "send", "plus", "download"]);

export function icon(name: keyof typeof RAW | string, size = 18, extraClass = ""): string {
  const body = RAW[name] ?? RAW.info;
  const hook = ACTION.has(name as string) ? " ic-action" : "";
  return `<svg class="ic${hook}${extraClass ? " " + extraClass : ""}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/** The LUCID wordmark π glyph used in the titlebar. */
export const piMark = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 8h14"/><path d="M9 8v9"/><path d="M16 8v7a2 2 0 0 0 2 2"/></svg>`;
