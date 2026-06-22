// media/chat.js — the Lucid chat webview. No deps; talks to the extension host over postMessage.
// The extension owns the gated ACP session; this view only renders + sends intents. Fail-closed
// permission handling lives in the extension (timeout/close ⇒ deny).
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const log = $("log"), banner = $("banner"), input = $("input");
  let streamEl = null;       // current assistant message element
  let thoughtEl = null;      // current thinking block
  let mode = "agent";

  const modeToId = (m) => (m === "plan" ? "plan" : "default"); // omp modes; "ask" = default + per-tool prompts

  function add(cls, text) {
    const el = document.createElement("div");
    el.className = "msg " + cls;
    el.textContent = text || "";
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  // ── send / controls ─────────────────────────────────────────────────────────
  function send() {
    const text = input.value.trim();
    if (!text) return;
    add("user", text);
    input.value = "";
    streamEl = null; thoughtEl = null;
    vscode.postMessage({ type: "prompt", text });
  }
  $("send").addEventListener("click", send);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
  $("stop").addEventListener("click", () => vscode.postMessage({ type: "stop" }));
  $("new").addEventListener("click", () => vscode.postMessage({ type: "newSession" }));
  document.querySelectorAll(".modes button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".modes button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    mode = b.dataset.mode;
    vscode.postMessage({ type: "setMode", modeId: modeToId(mode) });
  }));

  // ── extension → webview ───────────────────────────────────────────────────────
  window.addEventListener("message", (e) => {
    const m = e.data;
    switch (m.type) {
      case "ready": banner.hidden = true; break;
      case "cleared": log.innerHTML = ""; banner.hidden = true; break;
      case "turnStart": streamEl = null; thoughtEl = null; break;
      case "turnEnd": streamEl = null; thoughtEl = null; break;
      case "update": onUpdate(m.event); break;
      case "block": showBlock(m); break;
      case "permission": showPermission(m); break;
      case "unavailable": banner.hidden = false; banner.className = "banner err"; banner.textContent = "⛔ " + m.reason; break;
      case "error": add("error", m.text); break;
    }
  });

  function onUpdate(ev) {
    if (ev.kind === "message") {
      if (!streamEl) streamEl = add("assistant", "");
      streamEl.textContent += ev.text;
      log.scrollTop = log.scrollHeight;
    } else if (ev.kind === "thought") {
      if (!thoughtEl) thoughtEl = add("thought", "");
      thoughtEl.textContent += ev.text;
    } else if (ev.kind === "tool") {
      add("tool", "🔧 " + ev.title + (ev.status ? " · " + ev.status : ""));
    }
  }

  function showBlock(m) {
    banner.hidden = false;
    banner.className = "banner block";
    banner.textContent = `🛡️ Security gate BLOCKED a ${m.tool} call (severity ${m.severity}, ${m.findings}). The tool never ran.`;
  }

  function showPermission(m) {
    const wrap = add("perm", "");
    wrap.textContent = `Allow ${m.tool}? `;
    (m.options.length ? m.options : [{ optionId: "allow", name: "Allow" }]).forEach((o) => {
      const btn = document.createElement("button");
      btn.textContent = o.name;
      btn.addEventListener("click", () => { vscode.postMessage({ type: "permission", id: m.id, optionId: o.optionId }); wrap.remove(); });
      wrap.appendChild(btn);
    });
    const deny = document.createElement("button");
    deny.textContent = "Deny";
    deny.className = "deny";
    deny.addEventListener("click", () => { vscode.postMessage({ type: "permission", id: m.id, optionId: null }); wrap.remove(); });
    wrap.appendChild(deny);
  }
})();
