// The control panel's page (ADR-A094), served by src/console.rs at /console/ with its script and style as files of
// their own (the Content-Security-Policy allows scripts and styles from this origin only, nothing inline). The page
// writes every value with textContent, never as HTML.

pub const INDEX_HTML: &str = r###"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LUCID relay control panel</title>
<link rel="stylesheet" href="/console/app.css">
<script src="/console/app.js" defer></script>
</head>
<body>
<header>
  <h1>LUCID relay control panel</h1>
  <span id="who"></span>
  <button id="signout" type="button" hidden>Sign out</button>
</header>
<main>
  <p id="message" role="status"></p>

  <section id="join" hidden>
    <h2>Set up your passkey</h2>
    <p>This invite is for <b id="join-email"></b> and works once, until <span id="join-expires"></span>.</p>
    <p>Your browser asks your device for a passkey (its PIN, fingerprint or face). Later you sign in with it here.</p>
    <label>Name for this passkey <input id="join-label" maxlength="40" value="Passkey"></label>
    <button id="join-go" type="button">Create a passkey</button>
  </section>

  <section id="signin" hidden>
    <h2>Sign in</h2>
    <label>Email (optional) <input id="signin-email" type="email" autocomplete="username webauthn"></label>
    <button id="signin-go" type="button">Sign in with a passkey</button>
    <p class="note">No passkey yet? In the IDE, open the Relay section and choose Control panel: it gives you a one-time link.</p>
  </section>

  <section id="panel" hidden>
    <nav>
      <button type="button" data-tab="health" class="on">Health</button>
      <button type="button" data-tab="license">License</button>
      <button type="button" data-tab="seats">Seats</button>
      <button type="button" data-tab="nodes">Nodes</button>
      <button type="button" data-tab="logs">Logs</button>
      <span id="updated" class="note"></span>
    </nav>
    <div id="health" class="tab"></div>
    <div id="license" class="tab" hidden></div>
    <div id="seats" class="tab" hidden></div>
    <div id="nodes" class="tab" hidden></div>
    <div id="logs" class="tab" hidden>
      <div class="controls">
        <label>Source <select id="log-source"><option value="relay">This relay</option></select></label>
        <label>Category <select id="log-cat">
          <option value="all">All</option><option value="security">Security</option><option value="ops">Ops</option><option value="perf">Perf</option>
        </select></label>
        <label>Level at least <select id="log-level">
          <option value="debug">Debug</option><option value="info">Info</option><option value="warn">Warn</option><option value="error">Error</option>
        </select></label>
        <button id="log-show" type="button">Show</button>
        <button id="log-download" type="button">Download JSONL</button>
      </div>
      <div id="log-lines"></div>
    </div>
    <p class="note">Read-only. The relay carries sealed messages and never shows their contents.</p>
  </section>
</main>
</body>
</html>
"###;

pub const APP_JS: &str = r###""use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const b64u = (buf) => {
    let s = "";
    for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const unb64u = (s) => {
    const t = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    return Uint8Array.from(t, (c) => c.charCodeAt(0));
  };
  let status = null;
  let timer = 0;

  function say(text, bad) {
    const m = $("message");
    m.textContent = text || "";
    m.className = bad ? "bad" : "";
  }

  async function api(method, path, body) {
    const init = { method, credentials: "same-origin", headers: {} };
    if (method === "POST") {
      init.headers = { "Content-Type": "application/json", "X-Lucid-Console": "1" };
      init.body = JSON.stringify(body || {});
    }
    const r = await fetch("/console/api/" + path, init);
    let data = null;
    try { data = await r.json(); } catch { data = null; }
    if (!r.ok) {
      const e = new Error((data && data.error) || ("HTTP " + r.status));
      e.status = r.status;
      throw e;
    }
    return data;
  }

  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "class") n.className = v;
      else n[k] = v;
    }
    for (const k of kids) n.append(k instanceof Node ? k : document.createTextNode(k == null ? "" : String(k)));
    return n;
  }

  function table(heads, rows) {
    const t = el("table");
    t.append(el("thead", null, el("tr", null, ...heads.map((h) => el("th", null, h)))));
    const b = el("tbody");
    for (const r of rows) b.append(el("tr", null, ...r.map((c) => el("td", null, c))));
    if (!rows.length) b.append(el("tr", null, el("td", { colSpan: heads.length, className: "note" }, "Nothing yet.")));
    t.append(b);
    return t;
  }

  function pairs(list) {
    const dl = el("dl");
    for (const [k, v] of list) dl.append(el("dt", null, k), el("dd", null, v));
    return dl;
  }

  const when = (ms) => (ms ? new Date(ms).toLocaleString() : "never");
  const day = (s) => (s ? new Date(s * 1000).toLocaleDateString() : "");
  const size = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MiB" : n >= 1024 ? (n / 1024).toFixed(1) + " KiB" : n + " B");
  const span = (sec) => {
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    return (d ? d + " d " : "") + h + " h " + m + " min";
  };

  function answer(c) {
    const r = c.response;
    const out = { id: c.id, rawId: b64u(c.rawId), type: c.type, response: { clientDataJSON: b64u(r.clientDataJSON) } };
    if (r.attestationObject) out.response.attestationObject = b64u(r.attestationObject);
    if (r.authenticatorData) out.response.authenticatorData = b64u(r.authenticatorData);
    if (r.signature) out.response.signature = b64u(r.signature);
    if (r.userHandle && r.userHandle.byteLength) out.response.userHandle = b64u(r.userHandle);
    return out;
  }

  function show(id) {
    for (const s of ["join", "signin", "panel"]) $(s).hidden = s !== id;
    $("signout").hidden = id !== "panel";
    if (id !== "panel") $("who").textContent = "";
  }

  async function startJoin(token) {
    show("join");
    try {
      const j = await api("POST", "join", { token });
      $("join-email").textContent = j.email;
      $("join-expires").textContent = when(j.expires);
    } catch (e) {
      $("join-go").disabled = true;
      say(e.message, true);
      return;
    }
    $("join-go").onclick = async () => {
      say("Follow your browser's passkey prompt...");
      try {
        const b = await api("POST", "register/begin", { token });
        const pk = b.publicKey;
        const cred = await navigator.credentials.create({ publicKey: {
          ...pk,
          challenge: unb64u(pk.challenge),
          user: { ...pk.user, id: unb64u(pk.user.id) },
          excludeCredentials: (pk.excludeCredentials || []).map((c) => ({ ...c, id: unb64u(c.id) })),
        } });
        const f = await api("POST", "register/finish", { ceremony: b.ceremony, credential: answer(cred), label: $("join-label").value });
        say("Your passkey is set up. Next time, sign in at this address with it.");
        await openPanel(f.user);
      } catch (e) {
        say(e.message || String(e), true);
      }
    };
  }

  async function signIn() {
    say("Follow your browser's passkey prompt...");
    try {
      const b = await api("POST", "login/begin", { email: $("signin-email").value.trim() });
      const pk = b.publicKey;
      const cred = await navigator.credentials.get({ publicKey: {
        ...pk,
        challenge: unb64u(pk.challenge),
        allowCredentials: (pk.allowCredentials || []).map((c) => ({ ...c, id: unb64u(c.id) })),
      } });
      const f = await api("POST", "login/finish", { ceremony: b.ceremony, credential: answer(cred) });
      say("");
      await openPanel(f.user);
    } catch (e) {
      say(e.message || String(e), true);
    }
  }

  async function openPanel(user) {
    show("panel");
    $("who").textContent = user && user.email ? user.email : "";
    await refresh();
    clearInterval(timer);
    timer = setInterval(() => { if (!document.hidden) refresh(); }, 30000);
  }

  async function refresh() {
    try {
      status = await api("GET", "status");
    } catch (e) {
      if (e.status === 401) {
        clearInterval(timer);
        show("signin");
        say("Your session ended; sign in again.", true);
        return;
      }
      say(e.message, true);
      return;
    }
    $("updated").textContent = "Updated " + new Date().toLocaleTimeString();
    renderHealth();
    renderLicense();
    renderSeats();
    renderNodes();
    renderSources();
  }

  function renderHealth() {
    const r = status.relay || {};
    const hits = Object.entries(status.quotaHits || {});
    const c = status.console || {};
    $("health").replaceChildren(
      pairs([
        ["Version", r.version],
        ["Up for", span(r.uptimeSeconds || 0)],
        ["Mailboxes", r.mailboxes],
        ["Queued messages", r.queued],
        ["Queued bytes", size(r.heldBytes || 0) + " of " + size(r.storeBytes || 0)],
        ["Quota per sender", size(r.senderBytes || 0)],
        ["CRL version", status.crl ? status.crl.version : 0],
        ["Relay directory version", status.directory ? status.directory.version : 0],
        ["Control panel admins", (c.admins || []).map((a) => a.email).join(", ")],
        ["Open invites", c.invitesOpen || 0],
      ]),
      el("h3", null, "Quotas hit since the relay started"),
      table(["Refusal", "Count"], hits.map(([k, v]) => [k, v])),
      el("h3", null, "Queues, largest first"),
      table(["Recipient node", "Messages", "Bytes"], (r.queues || []).map((q) => [q.node, q.messages, size(q.bytes)])),
    );
  }

  function renderLicense() {
    const l = status.license;
    if (!l) {
      $("license").replaceChildren(el("p", null, "This relay runs without a license."));
      return;
    }
    const rows = [
      ["Organization", l.org],
      ["Edition", l.edition],
      ["Users", l.used + " of " + l.users],
      ["Relays", l.relays],
      ["State", l.state],
      ["Days left", l.daysLeft],
      ["Ends", day(l.exp)],
      ["License id", l.id],
    ];
    if (l.dev) rows.push(["Development license", "yes: never for production"]);
    $("license").replaceChildren(pairs(rows));
  }

  function renderSeats() {
    const seats = status.seats || [];
    $("seats").replaceChildren(
      el("p", { className: "note" }, "A seat is one person on hub certificates (ADR-A077); it frees itself when every certificate of that person is revoked or has ended."),
      table(["User", "Email", "Since", "Certificates", "Latest certificate ends"], seats.map((s) => [s.user, s.email || "", day(s.since), s.certificates, day(s.exp)])),
    );
  }

  function renderNodes() {
    const nodes = status.nodes || [];
    $("nodes").replaceChildren(table(
      ["Node", "Role", "Label", "User", "Last signed in", "Last poll", "Certificate ends", "Revoked"],
      nodes.map((n) => [n.node, n.role, n.label || "(not seen since the relay started)", n.email || "", when(n.lastSeenAt), n.lastPollAt ? when(n.lastPollAt) : "", day(n.exp), n.revoked ? "yes" : ""]),
    ));
  }

  function renderSources() {
    const s = $("log-source");
    const was = s.value || "relay";
    const labels = Object.fromEntries((status.nodes || []).map((n) => [n.node, n.label]));
    s.replaceChildren(
      el("option", { value: "relay" }, "This relay"),
      ...(status.spokeLogs || []).map((x) => el("option", { value: x.node }, (labels[x.node] || x.node) + " (" + x.lines + " lines)")),
    );
    s.value = [...s.options].some((o) => o.value === was) ? was : "relay";
  }

  function logQuery() {
    return "source=" + encodeURIComponent($("log-source").value) + "&cat=" + encodeURIComponent($("log-cat").value) + "&level=" + encodeURIComponent($("log-level").value);
  }

  async function showLogs() {
    try {
      const d = await api("GET", "logs?" + logQuery() + "&limit=500");
      const skip = new Set(["ts", "level", "cat", "event", "component"]);
      const detail = (l) => Object.entries(l).filter(([k]) => !skip.has(k)).map(([k, v]) => k + "=" + (typeof v === "string" ? v : JSON.stringify(v))).join("  ");
      $("log-lines").replaceChildren(
        el("p", { className: "note" }, d.lines.length + " of " + d.total + " matching lines, newest first."),
        table(["Time", "Level", "Category", "Event", "Details"], d.lines.map((l) => [l.ts ? new Date(l.ts).toLocaleString() : "", l.level, l.cat, l.event, detail(l)])),
      );
    } catch (e) {
      if (e.status === 401) { show("signin"); say("Your session ended; sign in again.", true); return; }
      say(e.message, true);
    }
  }

  for (const b of document.querySelectorAll("nav button")) {
    b.onclick = () => {
      for (const x of document.querySelectorAll("nav button")) x.classList.toggle("on", x === b);
      for (const p of document.querySelectorAll(".tab")) p.hidden = p.id !== b.dataset.tab;
      if (b.dataset.tab === "logs") showLogs();
    };
  }
  $("log-show").onclick = showLogs;
  $("log-download").onclick = () => { location.href = "/console/api/logs?" + logQuery() + "&format=jsonl"; };
  $("signin-go").onclick = signIn;
  $("signout").onclick = async () => {
    try { await api("POST", "logout"); } catch { /* signed out either way */ }
    clearInterval(timer);
    show("signin");
    say("Signed out.");
  };

  async function boot() {
    if (!window.PublicKeyCredential) say("This browser does not support passkeys; use a current browser.", true);
    const token = new URLSearchParams(location.hash.slice(1)).get("join");
    if (token) {
      // The link works once: off the address bar and out of the history at once.
      history.replaceState(null, "", location.pathname);
      await startJoin(token);
      return;
    }
    try {
      const me = await api("GET", "me");
      if (me.user) { await openPanel(me.user); return; }
      show("signin");
    } catch (e) {
      show("signin");
      say(e.message, true);
    }
  }
  boot();
})();
"###;

pub const APP_CSS: &str = r###":root { color-scheme: light dark; --line: #8884; --accent: #2b6cb0; --bad: #c53030; }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { display: flex; align-items: center; gap: 1em; padding: 0.8em 1.2em; border-bottom: 1px solid var(--line); }
header h1 { font-size: 1.15em; margin: 0; flex: 1; }
main { padding: 1em 1.2em; max-width: 1200px; }
section { margin-bottom: 1.5em; }
label { display: inline-flex; gap: 0.4em; align-items: center; margin: 0.3em 0.8em 0.3em 0; }
input, select, button { font: inherit; padding: 0.3em 0.6em; }
button { cursor: pointer; border: 1px solid var(--line); border-radius: 4px; background: transparent; }
button:disabled { opacity: 0.5; cursor: default; }
#join-go, #signin-go { background: var(--accent); color: #fff; border-color: var(--accent); }
nav { display: flex; flex-wrap: wrap; gap: 0.3em; align-items: center; margin-bottom: 1em; }
nav button.on { background: var(--accent); color: #fff; border-color: var(--accent); }
nav .note { margin-left: auto; }
.note { opacity: 0.75; }
.bad { color: var(--bad); }
.controls { margin-bottom: 0.8em; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.3em 1.2em; }
dt { font-weight: 600; }
dd { margin: 0; overflow-wrap: anywhere; }
table { border-collapse: collapse; width: 100%; margin-bottom: 1em; }
th, td { text-align: left; padding: 0.3em 0.5em; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
th { font-weight: 600; }
td:last-child { font-family: ui-monospace, Consolas, monospace; font-size: 0.92em; }
"###;
