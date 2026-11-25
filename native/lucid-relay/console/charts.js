// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

"use strict";
// Lucid Admin Console charts (contract AC-2a section 9.6). Served from /console/charts.js, loaded with defer before
// app.js, and published as window.LucidCharts. A port of the home lab charts.js builders lineChart, barChart, heatStrip
// and kpi: dependency-free SVG built with createElementNS, each chart an img with a title and a desc, hover values in
// SVG title elements. Differences from the home lab: colors come only from classes (ac-tone-ok, ac-tone-warn,
// ac-tone-danger, ac-tone-link, ac-tone-muted, defined in app.css from the console tokens), never from the CSSOM or a
// style attribute; geometry is set as SVG attributes from numbers checked with Number.isFinite; every label is a text
// node; nothing animates; and under every chart a "Show as a table" disclosure holds the same data in a table with a
// caption, so no value is shown by color or shape alone.
(() => {
  const SVG = "http://www.w3.org/2000/svg";
  const TONE = { ok: "ac-tone-ok", warn: "ac-tone-warn", danger: "ac-tone-danger", bad: "ac-tone-danger", link: "ac-tone-link", muted: "ac-tone-muted", none: "ac-tone-none" };
  // Series tones in order; each series also gets its own dash pattern (ac-series-<n>), so lines differ without color.
  const SERIES = ["link", "ok", "warn", "danger", "muted"];
  // The page sets the words (charts.table, charts.no-data) from the fleet words vector before it draws.
  const WORDS = { table: "Show as a table", noData: "No data for this time.", time: "Time", item: "Item", state: "State" };
  let next = 0;

  const finite = (v) => typeof v === "number" && Number.isFinite(v);
  const narrow = () => typeof matchMedia === "function" && matchMedia("(max-width: 600px)").matches;
  // A narrower drawing on a phone keeps the 12 px labels close to their CSS size.
  const width = () => (narrow() ? 360 : 600);
  const toneClass = (t) => TONE[t] || TONE.link;
  const seriesTone = (s, i) => (s && s.tone && TONE[s.tone] ? s.tone : SERIES[i % SERIES.length]);

  // A geometry value: only a finite number reaches an attribute.
  function geo(v) {
    return finite(v) ? String(Math.round(v * 10) / 10) : "0";
  }
  function svg(tag, attrs, ...kids) {
    const e = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "style" || k.slice(0, 2).toLowerCase() === "on") throw new Error("refused attribute " + k);
      e.setAttribute(k, String(v));
    }
    for (const c of kids) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  }
  function html(tag, cls, ...kids) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    for (const c of kids.flat(2)) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  }
  const tip = (s) => svg("title", null, document.createTextNode(String(s)));

  const fmtNumber = (v) => (!finite(v) ? "" : Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 }));
  function timeFormats(t0, t1) {
    const short = t1 - t0 <= 2 * 86400000;
    return {
      axis: (t) => (short ? new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" })),
      full: (t) => new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
    };
  }
  function niceStep(range, count) {
    const raw = range / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const r = raw / mag;
    return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * mag;
  }
  function valueScale(values, opts, count) {
    const known = values.filter(finite);
    let lo = finite(opts.yMin) ? opts.yMin : Math.min(0, ...known);
    let hi = finite(opts.yMax) ? opts.yMax : known.length ? Math.max(...known) : 1;
    if (!(hi > lo)) hi = lo + 1;
    const step = known.every(Number.isInteger) ? Math.max(1, Math.ceil(niceStep(hi - lo, count || 4))) : niceStep(hi - lo, count || 4);
    if (!finite(opts.yMin)) lo = Math.floor(lo / step) * step;
    if (!finite(opts.yMax)) hi = Math.ceil(hi / step) * step;
    const ticks = [];
    for (let i = 0; lo + i * step <= hi + step * 1e-9 && i < 50; i++) ticks.push(Number((lo + i * step).toPrecision(12)));
    return { lo, hi, ticks };
  }

  // The accessible root: role img, named by its title and described by its desc.
  function frame(title, desc, w, h) {
    const id = "chart-" + ++next;
    return svg("svg", { class: "chart-svg", viewBox: "0 0 " + geo(w) + " " + geo(h), role: "img", "aria-labelledby": id + "-t " + id + "-d", preserveAspectRatio: "xMidYMid meet", focusable: "false" },
      svg("title", { id: id + "-t" }, document.createTextNode(String(title))), svg("desc", { id: id + "-d" }, document.createTextNode(String(desc))));
  }
  function label(x, y, s, anchor, cls) {
    return svg("text", { x: geo(x), y: geo(y), "text-anchor": anchor || "middle", "dominant-baseline": "middle", class: cls || "chart-label" }, document.createTextNode(String(s)));
  }
  // A transparent hover target carrying the values of its column or bar (CSS shows it on hover).
  function hit(x, y, w, h, s) {
    return svg("rect", { x: geo(x), y: geo(y), width: geo(Math.max(0, w)), height: geo(Math.max(0, h)), class: "chart-hit" }, tip(s));
  }
  function swatch(tone, i) {
    return svg("svg", { class: "chart-swatch", viewBox: "0 0 24 10", "aria-hidden": "true", focusable: "false" },
      svg("line", { x1: "1", y1: "5", x2: "23", y2: "5", class: "chart-line " + toneClass(tone) + " ac-series-" + (i % 5) }));
  }
  function legend(entries) {
    const ul = html("ul", "chart-legend");
    ul.setAttribute("aria-hidden", "true");
    entries.forEach((e, i) => ul.append(html("li", null, swatch(e.tone, i), e.text)));
    return ul;
  }
  // "Show as a table": the same data in a table with a caption (9.6), keyboard reachable through its summary.
  function table(caption, headers, rows) {
    const t = html("table", "chart-data", html("caption", null, caption));
    const tr = html("tr");
    for (const h of headers) {
      const th = html("th", null, h);
      th.setAttribute("scope", "col");
      tr.append(th);
    }
    const body = html("tbody");
    for (const r of rows) {
      const row = html("tr");
      r.forEach((cell, i) => {
        const c = html(i === 0 ? "th" : "td", null, cell == null ? "" : cell);
        if (i === 0) c.setAttribute("scope", "row");
        row.append(c);
      });
      body.append(row);
    }
    if (!rows.length) {
      const row = html("tr");
      const c = html("td", null, WORDS.noData);
      c.setAttribute("colspan", String(Math.max(1, headers.length)));
      row.append(c);
      body.append(row);
    }
    t.append(html("thead", null, tr), body);
    return html("details", "chart-table", html("summary", null, WORDS.table), html("div", "chart-table-wrap", t));
  }
  function figure(cls, ...kids) {
    return html("figure", "chart " + cls, ...kids);
  }
  const pointsOf = (s) => (s.points || [])
    .map((p) => (Array.isArray(p) ? { t: p[0], v: p[1] } : { t: p && p.t, v: p && p.v }))
    .filter((p) => finite(p.t))
    .map((p) => ({ t: p.t, v: finite(p.v) ? p.v : null }))
    .sort((a, b) => a.t - b.t);

  /**
   * Line chart over time (9.6). series: [{ name, points: [[t, v]] or [{ t, v }], tone? }]; a null value breaks the
   * line (a gap is a gap, 9.2). opts: { title, desc?, height = 180, yMin?, yMax?, yFormat?(v), area? }.
   */
  function lineChart(series, opts) {
    const o = opts || {};
    const W = width();
    const height = finite(o.height) ? o.height : 180;
    const yFormat = o.yFormat || fmtNumber;
    const m = { l: 52, r: 12, t: 10, b: 26 };
    const pw = W - m.l - m.r, ph = height - m.t - m.b;
    const lines = (series || []).map((s, i) => ({ name: String(s.name), tone: seriesTone(s, i), i, points: pointsOf(s) }));
    const times = [...new Set(lines.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b);
    const values = lines.flatMap((s) => s.points.map((p) => p.v)).filter(finite);
    const t0 = times.length ? times[0] : 0, t1 = times.length ? times[times.length - 1] : 1;
    const fmt = timeFormats(t0, t1);
    const { lo, hi, ticks } = valueScale(values, o);
    const x = (t) => m.l + (t1 === t0 ? pw / 2 : ((t - t0) / (t1 - t0)) * pw);
    const y = (v) => m.t + ph - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * ph;
    const desc = o.desc || (!values.length ? WORDS.noData : lines.map((s) => {
      const vs = s.points.map((p) => p.v).filter(finite);
      return vs.length ? s.name + ": latest " + yFormat(vs[vs.length - 1]) + ", lowest " + yFormat(Math.min(...vs)) + ", highest " + yFormat(Math.max(...vs)) + "." : s.name + ": " + WORDS.noData;
    }).join(" "));
    const root = frame(o.title, desc, W, height);
    const grid = svg("g", { "aria-hidden": "true" });
    for (const v of ticks) {
      grid.append(svg("line", { x1: geo(m.l), x2: geo(W - m.r), y1: geo(y(v)), y2: geo(y(v)), class: "chart-grid" }));
      grid.append(label(m.l - 6, y(v), yFormat(v), "end"));
    }
    const every = Math.max(1, Math.ceil(times.length / (narrow() ? 3 : 6)));
    const marks = times.filter((_, i) => i % every === 0);
    marks.forEach((t, i) => grid.append(label(x(t), height - m.b / 2 + 2, fmt.axis(t), marks.length < 2 ? "middle" : i === 0 ? "start" : "middle")));
    root.append(grid);
    const plot = svg("g", { "aria-hidden": "true" });
    for (const s of lines) {
      const segments = [];
      let cur = [];
      for (const p of s.points) {
        if (p.v === null) {
          if (cur.length) segments.push(cur);
          cur = [];
        } else cur.push(p);
      }
      if (cur.length) segments.push(cur);
      const tone = toneClass(s.tone);
      for (const seg of segments) {
        if (seg.length === 1) {
          plot.append(svg("circle", { cx: geo(x(seg[0].t)), cy: geo(y(seg[0].v)), r: "2.5", class: "chart-dot " + tone }));
          continue;
        }
        const d = seg.map((p, i) => (i === 0 ? "M" : "L") + geo(x(p.t)) + "," + geo(y(p.v))).join(" ");
        if (o.area) {
          const base = geo(y(Math.max(lo, Math.min(hi, 0))));
          plot.append(svg("path", { d: d + " L" + geo(x(seg[seg.length - 1].t)) + "," + base + " L" + geo(x(seg[0].t)) + "," + base + " Z", class: "chart-area " + tone }));
        }
        plot.append(svg("path", { d, class: "chart-line " + tone + " ac-series-" + (s.i % 5) }));
      }
    }
    root.append(plot);
    const hits = svg("g");
    const rows = [];
    times.forEach((t, i) => {
      const left = i === 0 ? m.l : (x(times[i - 1]) + x(t)) / 2;
      const right = i === times.length - 1 ? W - m.r : (x(t) + x(times[i + 1])) / 2;
      const vals = lines.map((s) => {
        const p = s.points.find((q) => q.t === t);
        return p && p.v !== null ? yFormat(p.v) : WORDS.noData;
      });
      hits.append(hit(left, m.t, right - left, ph, [fmt.full(t)].concat(lines.map((s, k) => s.name + ": " + vals[k])).join("\n")));
      rows.push([fmt.full(t)].concat(vals));
    });
    root.append(hits);
    return figure("chart-line-fig", root, lines.length > 1 ? legend(lines.map((s) => ({ text: s.name, tone: s.tone }))) : null,
      !values.length ? html("p", "chart-empty", WORDS.noData) : null,
      table(o.title, [WORDS.time].concat(lines.map((s) => s.name)), rows));
  }

  /**
   * Bar chart, vertical (over time or categories) or horizontal (one bar per item). items: [{ label, values: [n],
   * tone?, word? }] (`word` names the item's state, shown in its title and in the table, so the tone is never the only
   * sign). opts: { title, desc?, keys = [{ name, tone }], stacked = true, horizontal = false, height = 180, yFormat?(v),
   * labelFormat?(label), labelHeader? }.
   */
  function barChart(items, opts) {
    const o = opts || {};
    const W = width();
    const list = (items || []).map((it) => ({ label: it.label, tone: it.tone, word: it.word, values: (it.values || []).map((v) => (finite(v) ? v : null)) }));
    const keys = (o.keys || [{ name: "Value" }]).map((k, i) => ({ name: String(k.name), tone: seriesTone(k, i), i }));
    const stacked = o.stacked !== false;
    const yFormat = o.yFormat || fmtNumber;
    const labelFormat = o.labelFormat || String;
    const totals = list.map((it) => it.values.reduce((a, b) => a + (finite(b) ? b : 0), 0));
    const peaks = stacked ? totals : list.flatMap((it) => it.values.filter(finite));
    const neg = list.some((it) => it.values.some((v) => finite(v) && v < 0));
    const { lo, hi, ticks } = valueScale(peaks, Object.assign({}, o, { yMin: neg ? undefined : 0 }));
    const toneOf = (it, k) => (keys.length === 1 && it.tone ? it.tone : keys[k].tone);
    const valueLine = (it, i) => (keys.length === 1 ? yFormat(it.values[0]) : keys.map((k, j) => k.name + " " + yFormat(it.values[j])).join(", ") + (stacked ? ", " + yFormat(totals[i]) : ""));
    const tipOf = (it, i) => [labelFormat(it.label), it.word || null].concat(keys.map((k, j) => k.name + ": " + (it.values[j] === null ? WORDS.noData : yFormat(it.values[j])))).filter(Boolean).join("\n");
    const desc = o.desc || (!list.length ? WORDS.noData : list.map((it, i) => labelFormat(it.label) + ": " + valueLine(it, i) + (it.word ? " (" + it.word + ")" : "") + ".").join(" "));
    const legendEl = keys.length > 1 ? legend(keys.map((k) => ({ text: k.name, tone: k.tone }))) : null;
    const headers = [o.labelHeader || WORDS.item].concat(list.some((it) => it.word) ? [WORDS.state] : []).concat(keys.map((k) => k.name));
    const rows = list.map((it) => [labelFormat(it.label)].concat(list.some((x) => x.word) ? [it.word || ""] : []).concat(it.values.map((v) => (v === null ? WORDS.noData : yFormat(v)))));
    const tbl = table(o.title, headers, rows);
    const empty = !list.length ? html("p", "chart-empty", WORDS.noData) : null;
    if (o.horizontal) {
      const row = 26;
      const m = { l: narrow() ? 120 : 170, r: 64, t: 6, b: 6 };
      const height = m.t + m.b + Math.max(1, list.length) * row;
      const pw = W - m.l - m.r;
      const zero = m.l + ((Math.max(lo, Math.min(hi, 0)) - lo) / (hi - lo)) * pw;
      const xv = (v) => m.l + ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * pw;
      const root = frame(o.title, desc, W, height);
      list.forEach((it, i) => {
        const top = m.t + i * row;
        const text = labelFormat(it.label);
        const short = text.length > 22 ? text.slice(0, 21) + "..." : text;
        const name = label(m.l - 8, top + row / 2, short, "end", "chart-label chart-label-strong");
        if (short !== text) name.append(tip(text));
        root.append(name);
        root.append(svg("rect", { x: geo(m.l), y: geo(top + 5), width: geo(pw), height: geo(row - 10), rx: "3", class: "chart-track" }));
        const v = finite(it.values[0]) ? it.values[0] : 0;
        const a = Math.min(zero, xv(v)), b = Math.max(zero, xv(v));
        root.append(svg("rect", { x: geo(a), y: geo(top + 5), width: geo(Math.max(1, b - a)), height: geo(row - 10), rx: "3", class: "chart-bar " + toneClass(toneOf(it, 0)) }));
        root.append(label(W - m.r + 6, top + row / 2, yFormat(it.values[0]), "start", "chart-label chart-label-strong"));
        root.append(hit(0, top, W, row, tipOf(it, i)));
      });
      return figure("chart-bar-fig chart-bar-h", root, legendEl, empty, tbl);
    }
    const height = finite(o.height) ? o.height : 180;
    const m = { l: 52, r: 12, t: 10, b: 26 };
    const pw = W - m.l - m.r, ph = height - m.t - m.b;
    const y = (v) => m.t + ph - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * ph;
    const band = pw / Math.max(1, list.length);
    const barW = Math.max(1, band * 0.7);
    const root = frame(o.title, desc, W, height);
    const grid = svg("g", { "aria-hidden": "true" });
    for (const v of ticks) {
      grid.append(svg("line", { x1: geo(m.l), x2: geo(W - m.r), y1: geo(y(v)), y2: geo(y(v)), class: "chart-grid" }));
      grid.append(label(m.l - 6, y(v), yFormat(v), "end"));
    }
    root.append(grid);
    const every = Math.max(1, Math.ceil(list.length / (narrow() ? 4 : 8)));
    list.forEach((it, i) => {
      const x0 = m.l + i * band + (band - barW) / 2;
      if (i % every === 0) root.append(label(m.l + i * band + band / 2, height - m.b / 2 + 2, labelFormat(it.label)));
      let base = 0;
      it.values.forEach((v, k) => {
        const value = finite(v) ? v : 0;
        const sub = stacked ? barW : barW / Math.max(1, it.values.length);
        const bx = stacked ? x0 : x0 + k * sub;
        const top = y((stacked ? base : 0) + value);
        const bottom = y(stacked ? base : 0);
        root.append(svg("rect", { x: geo(bx), y: geo(Math.min(top, bottom)), width: geo(Math.max(0, sub - (stacked ? 0 : 1))), height: geo(Math.abs(bottom - top)), class: "chart-bar " + toneClass(toneOf(it, k)) }));
        if (stacked) base += value;
      });
      root.append(hit(m.l + i * band, m.t, band, ph, tipOf(it, i)));
    });
    return figure("chart-bar-fig", root, legendEl, empty, tbl);
  }

  /**
   * Status strip, one cell per period, oldest first (9.6 "Health over time"). cells: [{ t, tone ("ok", "warn",
   * "danger", "muted" or null for no data), word }]; the word is in each cell's title and in the table.
   * opts: { title, desc?, label? }.
   */
  function heatStrip(cells, opts) {
    const o = opts || {};
    const W = width();
    const list = (cells || []).filter((c) => finite(c.t));
    const height = 34;
    const fmt = list.length ? timeFormats(list[0].t, list[list.length - 1].t) : timeFormats(0, 0);
    const counts = {};
    for (const c of list) counts[c.word || WORDS.noData] = (counts[c.word || WORDS.noData] || 0) + 1;
    const desc = o.desc || (!list.length ? WORDS.noData : Object.entries(counts).map(([w, n]) => w + ": " + n).join(", ") + ".");
    const root = frame(o.title, desc, W, height);
    const slot = W / Math.max(1, list.length);
    const gap = Math.min(2, slot * 0.25);
    list.forEach((c, i) => {
      const tone = c.tone && TONE[c.tone] ? TONE[c.tone] : TONE.none;
      root.append(svg("rect", { x: geo(i * slot + gap / 2), y: "2", width: geo(Math.max(1, slot - gap)), height: geo(height - 4), rx: "2", class: "chart-cell " + tone },
        tip(fmt.full(c.t) + ": " + (c.word || WORDS.noData))));
    });
    return figure("chart-heat", o.label ? html("p", "chart-heat-label", o.label) : null, root, !list.length ? html("p", "chart-empty", WORDS.noData) : null,
      table(o.title, [WORDS.time, WORDS.state], list.map((c) => [fmt.full(c.t), c.word || WORDS.noData])));
  }

  /**
   * KPI tile: label, value, optional sub line and a 24-hour sparkline (decorative: the value and sub line carry the
   * meaning, and the tile is a named group). opts: { tone?, sub?, spark?: [[t, v]] or [{ t, v }] }.
   */
  function kpi(labelText, value, opts) {
    const o = opts || {};
    const shown = finite(value) ? fmtNumber(value) : value == null ? WORDS.noData : String(value);
    const tile = html("div", "kpi" + (o.tone ? " kpi-" + o.tone : ""), html("div", "kpi-label", labelText), html("div", "kpi-value", shown), o.sub ? html("div", "kpi-sub", o.sub) : null);
    tile.setAttribute("role", "group");
    tile.setAttribute("aria-label", labelText + ": " + shown + (o.sub ? ", " + o.sub : ""));
    const pts = pointsOf({ points: o.spark || [] }).filter((p) => p.v !== null);
    if (pts.length >= 2) {
      const vs = pts.map((p) => p.v);
      const lo = Math.min(...vs), hi = Math.max(...vs);
      const t0 = pts[0].t, span = Math.max(1, pts[pts.length - 1].t - t0);
      const line = pts.map((p) => geo(((p.t - t0) / span) * 100) + "," + geo(23 - (hi === lo ? 0.5 : (p.v - lo) / (hi - lo)) * 22)).join(" ");
      tile.append(svg("svg", { viewBox: "0 0 100 24", preserveAspectRatio: "none", "aria-hidden": "true", focusable: "false", class: "kpi-spark" },
        svg("polyline", { points: line, class: "chart-line " + toneClass(o.tone || "link"), "vector-effect": "non-scaling-stroke" })));
    }
    return tile;
  }

  function setWords(w) {
    for (const k of Object.keys(WORDS)) if (w && typeof w[k] === "string") WORDS[k] = w[k];
  }

  window.LucidCharts = Object.freeze({ lineChart, barChart, heatStrip, kpi, setWords });
})();
