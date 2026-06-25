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
  // clock (scheduled automations) — ring + hands
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
  // logs / developer console — a terminal frame with a ">" prompt + cursor line
  logs: P("M4 5.5h16v13H4z") + P("M7.5 9.7 10 12l-2.5 2.3") + P("M11.8 14.3h4.7"),
  // refresh
  refresh: P("M5 12a7 7 0 0 1 12-5l2 2") + P("M19 5v4h-4") + P("M19 12a7 7 0 0 1-12 5l-2-2") + P("M5 19v-4h4"),
  // copy (two overlapping cards)
  copy: P("M9.5 9.5h8v8h-8z") + P("M6.5 14.5H6A1.5 1.5 0 0 1 4.5 13V6A1.5 1.5 0 0 1 6 4.5h7A1.5 1.5 0 0 1 14.5 6v.5"),
  // download (save to disk)
  download: P("M12 4v9.5") + P("M8 10.5l4 4 4-4") + P("M5 18.5h14"),
  // lightbulb (thinking) — glass dome + neck, filament tick, two base lines
  bulb: P("M12 4.2a5 5 0 0 0-3 9c.7.5 1.1 1.3 1.2 2.1h3.6c.1-.8.5-1.6 1.2-2.1a5 5 0 0 0-3-9z")
    + P("M10.4 18.6h3.2") + P("M10.9 20.6h2.2") + P("M12 9.2v2.4") + P("M10.7 10.4h2.6"),
  // double chevron down (jump-to-latest) — two stacked downward carets
  chevronsDown: P("M6.5 7.5 12 13l5.5-5.5") + P("M6.5 13 12 18.5 17.5 13"),
};

// Action glyphs that read as "do something now" — they get the .ic-action hook
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
