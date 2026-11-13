// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0497 as the add-on): the bytes of the read-only mirror page server.js serves on the
// runtime's PORT. The package carries exactly server.js, client.js, the manifest and LICENSE
// (stage.ts), so the page, its script and its stylesheet live here as strings and are served from
// same-origin paths: the CSP allows no inline script or style.
//
// The script draws MirrorState (gui_mirror.ts) with createElement and textContent only, never
// innerHTML, follows /api/mirror/events (Server-Sent Events) for live updates, and has no control
// that changes the hub: picking a tab changes only what this page shows. Approvals and prompts stay
// in the terminal (`lucid herd`) and the IDE's own approval surfaces.

export const MIRROR_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Herd</title>
<link rel="stylesheet" href="/mirror.css">
<script src="/mirror.js" defer></script>
</head>
<body>
<header class="bar">
<b class="title">Herd</b>
<span class="chip inst" id="inst"></span>
<span class="counts" id="counts" role="status" aria-live="polite"></span>
<span class="chip ro" title="This view cannot approve, prompt or change the hub">Read only</span>
</header>
<nav class="tabs" id="tabs" role="tablist" aria-label="Hub tabs"></nav>
<main class="stage" id="stage"></main>
<footer class="foot">To act on an agent, run <code>lucid herd</code> in a terminal.</footer>
</body>
</html>
`;

export const MIRROR_CSS = `:root {
  color-scheme: dark light;
  --bg: #0e1116; --panel: #161b22; --line: #2b3240; --text: #d8dee9; --dim: #8b95a5;
  --focus: #5aa9ff; --amber: #f0b429; --green: #3fb950; --red: #f85149; --cyan: #39c5cf; --blue: #58a6ff; --gray: #6e7681;
}
@media (prefers-color-scheme: light) {
  :root { --bg: #f6f8fa; --panel: #ffffff; --line: #d0d7de; --text: #1f2328; --dim: #59636e; --focus: #0969da; }
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { display: flex; flex-direction: column; background: var(--bg); color: var(--text); font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
.bar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--line); white-space: nowrap; min-width: 0; }
.title { font-size: 14px; }
.chip { display: inline-block; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 1px 8px; border: 1px solid var(--line); border-radius: 999px; color: var(--dim); }
.ro { margin-left: auto; }
.counts { display: flex; gap: 6px; min-width: 0; overflow: hidden; }
.badge { display: inline-block; padding: 0 6px; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; }
.badge.needs { background: var(--amber); color: #1f2328; }
.badge.unseen { background: var(--green); color: #0e1116; }
.badge.off { background: var(--gray); color: #fff; }
.tabs { display: flex; gap: 4px; padding: 6px 12px; border-bottom: 1px solid var(--line); overflow-x: auto; white-space: nowrap; }
.tab { display: inline-flex; align-items: center; gap: 6px; max-width: 240px; padding: 3px 10px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: var(--text); font: inherit; cursor: pointer; }
.tab .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tab[aria-selected="true"] { border-color: var(--focus); background: var(--panel); }
.tab.hub-focus .label { font-weight: 600; }
.tab:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
.stage { flex: 1; display: flex; min-height: 0; padding: 8px; }
.stage > * { flex: 1; }
.split { display: flex; gap: 6px; min-width: 0; min-height: 0; }
.split.row { flex-direction: row; }
.split.col { flex-direction: column; }
.split > * { flex-basis: 0; min-width: 0; min-height: 0; }
.pane { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.pane.focused { border-color: var(--focus); box-shadow: inset 0 0 0 1px var(--focus); }
.pane-h { display: flex; align-items: center; gap: 6px; min-width: 0; white-space: nowrap; }
.pane-h .name { overflow: hidden; text-overflow: ellipsis; }
.pane .meta { margin: 0; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--gray); }
.s-needs-approval { background: var(--red); }
.s-awaiting-input { background: var(--blue); }
.s-likely-stuck { background: var(--amber); }
.s-working, .s-starting { background: var(--cyan); }
.s-done { background: var(--green); }
.s-error { background: var(--red); }
.s-stopped, .s-gone, .s-unknown { background: var(--gray); }
.att-unseen .name { font-weight: 700; }
.empty { margin: auto; color: var(--dim); text-align: center; }
.foot { padding: 6px 12px; border-top: 1px solid var(--line); color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
code { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; }
`;

// Plain ES2017 in a string: no backticks and no template placeholders inside.
export const MIRROR_JS = `"use strict";
(function () {
  var STATUS_WORDS = {
    "needs-approval": "needs approval", "awaiting-input": "waiting for a prompt", "likely-stuck": "likely stuck",
    working: "working", starting: "starting", done: "done", error: "error", stopped: "stopped",
    gone: "no longer running", unknown: "status unknown"
  };
  var DECK_NAMES = { agent: "Agent", main: "Main" };
  var state = null, picked = null, live = false;

  function byId(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function own(map, key) { return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined; }
  function deckName(d) { return own(DECK_NAMES, d) || (d.charAt(0).toUpperCase() + d.slice(1).replace(/-/g, " ")); }
  function statusWord(s) { return own(STATUS_WORDS, s) || "status unknown"; }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

  function paneNode(p) {
    var box = el("section", "pane" + (p.focused ? " focused" : "") + (p.agent ? " att-" + p.agent.attention : ""));
    var head = el("div", "pane-h");
    var label;
    if (p.agent) {
      head.appendChild(el("i", "dot s-" + p.agent.status));
      label = p.agent.name;
      var name = el("b", "name", label);
      name.title = label;
      head.appendChild(name);
      if (p.agent.attention === "needs-you") head.appendChild(el("span", "badge needs", "needs you"));
      else if (p.agent.attention === "unseen") head.appendChild(el("span", "badge unseen", "unseen"));
      box.appendChild(head);
      box.appendChild(el("p", "meta", statusWord(p.agent.status)));
      box.setAttribute("aria-label", label + ", " + statusWord(p.agent.status) + (p.agent.attention === "none" ? "" : ", " + (p.agent.attention === "needs-you" ? "needs you" : "unseen")));
    } else {
      label = deckName(p.deck);
      var deck = el("b", "name", label);
      deck.title = label;
      head.appendChild(deck);
      box.appendChild(head);
      box.appendChild(el("p", "meta", p.deck === "agent" ? "no agent yet" : "panel"));
      box.setAttribute("aria-label", label + " pane");
    }
    if (p.focused) box.setAttribute("aria-current", "true");
    return box;
  }

  function treeNode(n) {
    if (!n.dir) return paneNode(n);
    var box = el("div", "split " + (n.dir === "v" ? "row" : "col"));
    var a = treeNode(n.a), b = treeNode(n.b);
    a.style.flexGrow = String(n.ratio);
    b.style.flexGrow = String(1 - n.ratio);
    box.appendChild(a);
    box.appendChild(b);
    return box;
  }

  function focusedPane(n) {
    if (!n.dir) return n.focused ? n : null;
    return focusedPane(n.a) || focusedPane(n.b);
  }
  function firstPane(n) { return n.dir ? firstPane(n.a) : n; }

  function renderCounts() {
    var counts = byId("counts");
    counts.textContent = "";
    if (!live) { counts.appendChild(el("span", "badge off", "reconnecting")); return; }
    if (!state || !state.up) return;
    if (state.counts.needsYou) counts.appendChild(el("span", "badge needs", plural(state.counts.needsYou, "needs you", "need you")));
    if (state.counts.unseen) counts.appendChild(el("span", "badge unseen", plural(state.counts.unseen, "unseen", "unseen")));
    counts.appendChild(el("span", "chip", plural(state.counts.agents, "agent", "agents")));
  }

  function render() {
    var tabs = byId("tabs"), stage = byId("stage");
    var active = document.activeElement;
    var keepFocus = active && active.parentNode === tabs ? active.getAttribute("data-tab") : null;
    byId("inst").textContent = state ? state.instance : "";
    renderCounts();
    tabs.textContent = "";
    stage.textContent = "";
    if (!state) { stage.appendChild(el("p", "empty", "Connecting to Herd.")); return; }
    if (!state.up) { stage.appendChild(el("p", "empty", "The Herd hub named " + state.instance + " is not running. Start it in a terminal with lucid herd.")); return; }
    var list = [];
    state.spaces.forEach(function (s) { s.tabs.forEach(function (t) { list.push({ space: s, tab: t }); }); });
    if (!list.length) { stage.appendChild(el("p", "empty", "This hub has no saved layout yet.")); return; }
    var multi = state.spaces.length > 1;
    var current = list.find(function (x) { return x.tab.id === picked; }) || list.find(function (x) { return x.tab.id === state.focusedTab; }) || list[0];
    list.forEach(function (x) {
      var text = (multi ? x.space.name + " / " : "") + x.tab.name;
      var b = el("button", "tab" + (x.tab.id === state.focusedTab ? " hub-focus" : ""));
      b.type = "button";
      b.title = text + (x.tab.id === state.focusedTab ? " (on screen in the hub)" : "");
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", x === current ? "true" : "false");
      b.appendChild(el("span", "label", text));
      if (x.tab.needsYou) b.appendChild(el("span", "badge needs", String(x.tab.needsYou)));
      if (x.tab.unseen) b.appendChild(el("span", "badge unseen", String(x.tab.unseen)));
      b.setAttribute("data-tab", x.tab.id);
      b.addEventListener("click", function () { picked = x.tab.id; b.focus(); render(); });
      tabs.appendChild(b);
      if (keepFocus === x.tab.id) b.focus();
    });
    var t = current.tab;
    if (!t.tree) { stage.appendChild(el("p", "empty", plural(t.panes, "pane", "panes") + " in this tab, more than this view draws. Open it with lucid herd.")); return; }
    stage.appendChild(t.zoom ? paneNode(focusedPane(t.tree) || firstPane(t.tree)) : treeNode(t.tree));
  }

  function connect() {
    var source = new EventSource("/api/mirror/events");
    source.onopen = function () { live = true; render(); };
    source.onmessage = function (e) {
      try { state = JSON.parse(e.data); } catch (err) { return; }
      live = true;
      render();
    };
    source.onerror = function () { live = false; renderCounts(); };
  }

  document.addEventListener("DOMContentLoaded", function () { render(); connect(); });
})();
`;
