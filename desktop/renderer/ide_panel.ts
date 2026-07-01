// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/ide_panel.ts
//
// P-IDE.4 → P-IDE.5 (ADR-0029 / ADR-0036): a Monaco code panel that slides in from the right over the
// inspector. Monaco is vendored locally (dev.ts serves node_modules → /vendor/monaco) and loaded
// LAZILY via its AMD loader, so it never bloats app.js. P-IDE.4 shipped the read-only viewer; P-IDE.5
// adds EDITING: an Edit/View toggle, a modified dot, "Save" (routed through the in-process scanner
// gate via /api/editor/save - never a raw fs write), "Save As" for snippets, a file-conflict banner,
// "Send to chat", and a detached pop-out. Language-service WORKERS are still deferred (read-write
// tokenization is main-thread; semantic IntelliSense under our strict `script-src 'self'` CSP is its
// own hardening task - see ADR-0036). app.ts wires composer + save-path via setIdeHooks.

import { $, el } from "./dom.ts";
import { icon } from "./icons.ts";
import { bridge } from "./bridge.ts";

const MONACO_BASE = "/vendor/monaco";
const LUCID_THEME = { base: "vs-dark", inherit: true, rules: [], colors: { "editor.background": "#0b0e14", "editorGutter.background": "#0b0e14" } };

let monaco: any = null;
let monacoLoading: Promise<any> | null = null;
let editor: any = null;
let panel: HTMLElement | null = null;
let onBeforeOpen: (() => void) | null = null;

// The currently-open document. `path` is set once it's bound to a real file (opened from disk, or
// after Save As); `baseValue`/`baseSha` are the last-saved state used for dirty + conflict detection.
interface Doc { path: string | null; lang: string; title: string; baseValue: string; baseSha?: string; baseMtime?: number; readOnly: boolean; dirty: boolean }
let doc: Doc = { path: null, lang: "plaintext", title: "Code", baseValue: "", readOnly: true, dirty: false };

// app.ts supplies these (avoids an ide_panel → app.ts import cycle): drop text into the chat composer,
// and resolve a Save-As destination (folder pick + filename). Either may be unset (no-op).
let hooks: { sendToChat?: (text: string) => void; pickSavePath?: (suggestedName: string) => Promise<string | null> } = {};
export function setIdeHooks(h: { sendToChat?: (text: string) => void; pickSavePath?: (suggestedName: string) => Promise<string | null> }): void { hooks = h; }

export function setIdeExclusivity(cb: () => void): void { onBeforeOpen = cb; }
export function isIdeOpen(): boolean { return !!panel?.classList.contains("open"); }

/** Lazily load the vendored Monaco (AMD loader → editor.main), WITH semantic IntelliSense.
 *  P-IDE.6 (supersedes the ADR-0036 deferral): the TypeScript/JSON language services run in SAME-ORIGIN
 *  web workers, so completions, hovers, and error squiggles work - even in a locked-down browser. The
 *  trick: editor.main installs its own getWorker that wraps the worker in a `blob:` URL (which strict
 *  `worker-src 'self'` blocks); we override it after load with a worker served same-origin by dev.ts
 *  (`/vendor/monaco-worker.js`), which the CSP allows. See the req() callback below. */
function loadMonaco(): Promise<any> {
  if (monaco) return Promise.resolve(monaco);
  if (monacoLoading) return monacoLoading;
  monacoLoading = new Promise((resolve, reject) => {
    // A failed first load must NOT poison every later attempt: clear the cached in-flight promise on
    // failure so the next openIde() retries (a transient miss - e.g. opening before the /vendor/monaco
    // route is up after a dev-server restart - otherwise sticks until a full reload).
    const fail = (err: Error) => { monacoLoading = null; reject(err); };
    const loader = document.createElement("script");
    loader.src = `${MONACO_BASE}/loader.js`;
    loader.onload = () => {
      const req = (self as any).require;
      req.config({ paths: { vs: MONACO_BASE } });
      req(["vs/editor/editor.main"], () => {
        monaco = (self as any).monaco;
        // P-IDE.6: editor.main installs its OWN MonacoEnvironment.getWorker (which builds a blob: worker
        // the CSP blocks). Override it AFTER load with a SAME-ORIGIN bootstrap worker (served by dev.ts),
        // which the `worker-src 'self'` CSP allows - this is what re-enables the language-service workers
        // (and thus IntelliSense) in a locked-down browser. Monaco reads getWorker lazily per worker.
        try {
          const env = (self as any).MonacoEnvironment ?? ((self as any).MonacoEnvironment = {});
          env.getWorker = (_id: string, label: string) => new Worker(`${MONACO_BASE}-worker.js?label=${encodeURIComponent(label)}`);
        } catch { /* if it fails, monaco falls back to main thread (no IntelliSense) */ }
        try {
          // Workers run now → turn semantic + syntax validation ON for TS/JS and JSON.
          monaco.languages.typescript?.typescriptDefaults?.setDiagnosticsOptions?.({ noSemanticValidation: false, noSyntaxValidation: false });
          monaco.languages.typescript?.javascriptDefaults?.setDiagnosticsOptions?.({ noSemanticValidation: false, noSyntaxValidation: false });
          monaco.languages.json?.jsonDefaults?.setDiagnosticsOptions?.({ validate: true });
          monaco.editor.defineTheme("lucid-dark", LUCID_THEME);
        } catch { /* best-effort: theme/diagnostics tuning is non-essential */ }
        resolve(monaco);
      }, (err: unknown) => fail(err instanceof Error ? err : new Error("Monaco core failed to load")));
    };
    loader.onerror = () => fail(new Error("Monaco loader failed to load (is the /vendor/monaco route up? a dev-server restart may be needed)"));
    document.head.appendChild(loader);
  });
  return monacoLoading;
}

// P-CHAT.1 (ADR-0104): syntax-highlight a code snippet to HTML for the chat's inline preview, WITHOUT an
// editor instance. Reuses the same lazily-loaded, vendored Monaco (no new dep) and its `colorize` tokenizer
// (main-thread; no language-service worker needed). Returns Monaco-generated HTML (its own text is escaped,
// so it's safe to assign), or null on any failure so the caller can fall back to plain escaped text.
let colorizeThemeReady = false;
export async function colorizeCode(code: string, langHint: string): Promise<string | null> {
  try {
    const m = await loadMonaco();
    // colorize paints via `.mtkN` classes whose colors live in the theme stylesheet Monaco injects on
    // setTheme; ensure it's applied once (no editor may have been created yet).
    if (!colorizeThemeReady) { try { m.editor.setTheme("lucid-dark"); } catch { /* default theme */ } colorizeThemeReady = true; }
    const lang = guessLanguage(langHint);
    return await m.editor.colorize(code, lang === "plaintext" ? "" : lang, { tabSize: 2 });
  } catch { return null; }
}

// filename/extension (or fenced-code language) → Monaco language id, and the reverse for Save-As.
const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", html: "html", htm: "html", css: "css", scss: "scss", less: "less", md: "markdown", markdown: "markdown",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp",
  cs: "csharp", php: "php", sh: "shell", bash: "shell", zsh: "shell", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini",
  sql: "sql", xml: "xml", svg: "xml", kt: "kotlin", swift: "swift", lua: "lua", r: "r", dockerfile: "dockerfile",
};
const LANG_EXT: Record<string, string> = { typescript: "ts", javascript: "js", python: "py", rust: "rs", go: "go", java: "java", csharp: "cs", cpp: "cpp", c: "c", ruby: "rb", php: "php", shell: "sh", yaml: "yml", markdown: "md", html: "html", css: "css", json: "json", sql: "sql", xml: "xml", kotlin: "kt", swift: "swift", lua: "lua", r: "r", ini: "ini" };
export function guessLanguage(hint: string): string {
  const h = (hint || "").trim().toLowerCase();
  if (!h) return "plaintext";
  if (h.includes(".")) return EXT_LANG[h.slice(h.lastIndexOf(".") + 1)] ?? "plaintext"; // a filename
  return EXT_LANG[h] ?? h; // a bare token: short alias → full id, else assume it's already a Monaco lang id
}
function suggestedFilename(): string {
  if (doc.path) return doc.path.split(/[\\/]/).pop() || "untitled.txt";
  return `snippet.${LANG_EXT[doc.lang] ?? "txt"}`; // unbound snippet → a clean, language-appropriate name
}

function ensurePanel(): HTMLElement {
  if (panel) return panel;
  panel = el(`<aside id="idePanel" class="ide-panel" aria-hidden="true">
    <div class="ide-head">
      <span class="ide-ic">${icon("folder", 14)}</span>
      <span class="ide-title" id="ideTitle">Code</span>
      <span class="ide-dot" id="ideDot" title="Unsaved changes" hidden>●</span>
      <span class="ide-lang" id="ideLang"></span>
      <span class="ide-tools">
        <button class="ide-tb" id="ideEdit" type="button" data-tip="Edit this file">${icon("sliders", 13)} Edit</button>
        <button class="ide-tb" id="ideSave" type="button" data-tip="Save - scanned by the security gate before it writes" hidden>${icon("download", 13)} Save</button>
        <button class="ide-tb" id="ideSend" type="button" data-tip="Send this code to the chat composer">${icon("send", 13)}</button>
        <button class="ide-tb" id="idePop" type="button" data-tip="Pop out a detached copy">${icon("expand", 13)}</button>
      </span>
      <button class="ide-x" id="ideClose" type="button" data-tip="Close (Esc)">${icon("close", 16)}</button>
    </div>
    <div class="ide-banner" id="ideBanner" hidden></div>
    <div class="ide-body" id="ideBody"></div>
    <div class="ide-foot"><span id="idePos">Ln 1, Col 1</span><span class="ide-stat" id="ideStat">Read-only</span></div>
    <div class="ide-resize" id="ideResize" data-tip="Drag to resize"></div>
  </aside>`);
  document.body.appendChild(panel);
  $("#ideClose", panel)!.addEventListener("click", () => requestClose());
  $("#ideEdit", panel)!.addEventListener("click", () => setReadOnly(!doc.readOnly));
  $("#ideSave", panel)!.addEventListener("click", () => void save(false));
  $("#ideSend", panel)!.addEventListener("click", () => sendToChat());
  $("#idePop", panel)!.addEventListener("click", () => popOut());
  initResize($("#ideResize", panel)!);
  document.addEventListener("keydown", (e) => {
    if (!isIdeOpen()) return;
    if (e.key === "Escape") requestClose();
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && !doc.readOnly) { e.preventDefault(); void save(false); }
  });
  return panel;
}

// Drag the left edge to resize the panel width (clamped, persisted).
function initResize(handle: HTMLElement): void {
  const root = document.documentElement;
  try { const w = Number(localStorage.getItem("lucid.ide-w")); if (w) root.style.setProperty("--ide-w", `${w}px`); } catch { /* ignore */ }
  let startX = 0, startW = 0, dragging = false;
  const onMove = (e: MouseEvent) => {
    if (!dragging) return;
    const w = Math.max(360, Math.min(window.innerWidth - 120, startW + (startX - e.clientX)));
    root.style.setProperty("--ide-w", `${Math.round(w)}px`);
    editor?.layout();
  };
  const onUp = () => { if (!dragging) return; dragging = false; document.body.style.userSelect = ""; try { localStorage.setItem("lucid.ide-w", String(parseInt(getComputedStyle(root).getPropertyValue("--ide-w")) || 560)); } catch { /* ignore */ } window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  handle.addEventListener("mousedown", (e) => { dragging = true; startX = e.clientX; startW = panel!.getBoundingClientRect().width; document.body.style.userSelect = "none"; window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp); e.preventDefault(); });
}

// ── status / dirty / banner ─────────────────────────────────────────────────────────
function setStatus(text: string, cls = ""): void { const s = $("#ideStat"); if (s) { s.textContent = text; s.className = `ide-stat ${cls}`; } }
function refreshDirty(): void {
  const dirty = !doc.readOnly && editor && editor.getValue() !== doc.baseValue;
  doc.dirty = !!dirty;
  const dot = $("#ideDot"); if (dot) dot.toggleAttribute("hidden", !dirty);
  const save = $("#ideSave") as HTMLButtonElement | null; if (save) save.disabled = !dirty;
  setStatus(dirty ? "Modified" : doc.readOnly ? "Read-only" : "Editing", dirty ? "mod" : doc.readOnly ? "" : "edit");
}
function setReadOnly(ro: boolean): void {
  doc.readOnly = ro;
  editor?.updateOptions({ readOnly: ro });
  const edit = $("#ideEdit"); if (edit) edit.innerHTML = ro ? `${icon("sliders", 13)} Edit` : `${icon("eye", 13)} View`;
  const save = $("#ideSave"); if (save) save.toggleAttribute("hidden", ro);
  if (!ro) editor?.focus();
  refreshDirty();
}
interface BannerAct { label: string; kind?: string; run: () => void }
function showBanner(message: string, acts: BannerAct[], tone = "warn"): void {
  const b = $("#ideBanner"); if (!b) return;
  b.className = `ide-banner ${tone}`;
  b.innerHTML = `<span class="ide-bmsg">${message}</span><span class="ide-bacts"></span>`;
  const host = $(".ide-bacts", b)!;
  for (const a of acts) { const btn = el(`<button class="ide-tb ${a.kind ?? ""}">${a.label}</button>`); btn.addEventListener("click", () => { hideBanner(); a.run(); }); host.appendChild(btn); }
  b.removeAttribute("hidden");
}
function hideBanner(): void { const b = $("#ideBanner"); if (b) { b.setAttribute("hidden", ""); b.innerHTML = ""; } }

// ── open ─────────────────────────────────────────────────────────────────────────────
/** Open a snippet or file. Snippets (no `path`) open read-only with Edit/Save-As; passing `path`
 *  + `sha256` (from bridge.editorRead) binds it to disk so Save writes back with conflict detection. */
export async function openIde(opts: { title?: string; code: string; language?: string; path?: string; sha256?: string; mtime?: number }): Promise<void> {
  onBeforeOpen?.();                 // exclusivity: close Settings / KG first
  const p = ensurePanel();
  hideBanner();
  const title = opts.title || (opts.path ? opts.path.split(/[\\/]/).pop()! : "Code");
  const lang = opts.language ? guessLanguage(opts.language) : guessLanguage(title);
  doc = { path: opts.path ?? null, lang, title, baseValue: opts.code, baseSha: opts.sha256, baseMtime: opts.mtime, readOnly: true, dirty: false };
  $("#ideTitle", p)!.textContent = title;
  $("#ideLang", p)!.textContent = lang === "plaintext" ? "" : lang;
  p.classList.add("open");
  p.setAttribute("aria-hidden", "false");
  let m: any;
  try { m = await loadMonaco(); }
  catch { $("#ideBody", p)!.innerHTML = `<div class="ide-err">Couldn't load the editor. Close this and click "View in IDE" again to retry; if it persists, reload the app.</div>`; return; }
  const body = $("#ideBody", p)!;
  if (!editor) {
    editor = m.editor.create(body, {
      value: opts.code, language: lang, readOnly: true, theme: "lucid-dark",
      automaticLayout: true, minimap: { enabled: false }, fontSize: 13, lineHeight: 19,
      scrollBeyondLastLine: false, wordWrap: "off", renderWhitespace: "none", smoothScrolling: true,
      fontFamily: "var(--mono, ui-monospace, monospace)",
    });
    editor.onDidChangeCursorPosition((e: any) => { const pos = $("#idePos", p); if (pos) pos.textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`; });
    editor.onDidChangeModelContent(() => refreshDirty());
  } else {
    editor.setModel(m.editor.createModel(opts.code, lang));
    editor.onDidChangeModelContent(() => refreshDirty()); // re-bind: a fresh model has no listeners
  }
  setReadOnly(true);
  editor.layout();
}

// ── save (through the gate) ───────────────────────────────────────────────────────────
let saving = false; // guards against overlapping saves stalling the shared scanner pipe (P-IDE.6)
const SAVE_TIMEOUT_MS = 20_000;
const SAVE_TIMEOUT = "__lucid_save_timeout__";

async function save(overwrite: boolean): Promise<void> {
  if (!editor || doc.readOnly || saving) return;
  // Set the guard BEFORE the (async) Save-As picker so a second click can't open a second browser
  // or a second save. The whole flow - picker + write - is covered by the finally below.
  saving = true;
  const saveBtn = $("#ideSave") as HTMLButtonElement | null; if (saveBtn) saveBtn.disabled = true;
  try {
  const content = editor.getValue();
  // Snippet with no bound path → Save As: resolve a destination, then bind it.
  let path = doc.path;
  if (!path) {
    if (!hooks.pickSavePath) { setStatus("Save unavailable", "err"); return; }
    const picked = await hooks.pickSavePath(suggestedFilename());
    if (!picked) { refreshDirty(); return; } // cancelled - restore the prior status
    path = picked;
  }
  setStatus("Saving…");
  // A hung/slow scanner must never leave the UI stuck on "Saving…": race the request against a
  // timeout so the user always gets a definite outcome (the gate itself also fails closed server-side).
  const r = await Promise.race([
    bridge.editorSave({ path, content, baseSha: doc.baseSha, overwrite }),
    new Promise<typeof SAVE_TIMEOUT>((res) => setTimeout(() => res(SAVE_TIMEOUT), SAVE_TIMEOUT_MS)),
  ]);
  if (r === SAVE_TIMEOUT) { setStatus("Save timed out", "err"); showBanner("Saving took too long - the scanner may be busy. Try again.", [{ label: "Retry", run: () => void save(overwrite) }, { label: "OK", run: () => refreshDirty() }], "danger"); return; }
  if (!r) { setStatus("Save failed", "err"); return; }
  if (r.conflict) {
    setStatus("Conflict", "err");
    showBanner(r.error ?? "This file changed on disk.", [
      { label: "Overwrite", kind: "danger", run: () => void save(true) },
      { label: "Reload from disk", run: () => void reloadFromDisk(path!) },
      { label: "Cancel", run: () => refreshDirty() },
    ]);
    return;
  }
  if (r.blocked) { setStatus("Blocked by gate", "err"); showBanner(`🛡 ${r.reason ?? "The security gate blocked this save."}`, [{ label: "OK", run: () => refreshDirty() }], "danger"); return; }
  if (!r.ok) { setStatus("Save failed", "err"); showBanner(r.error ?? "Couldn't save that file.", [{ label: "OK", run: () => refreshDirty() }], "danger"); return; }
  // success: rebind the saved state, retitle if this was a Save As, clear dirty.
  doc.path = r.path ?? path;
  doc.baseValue = content; doc.baseSha = r.sha256; doc.baseMtime = r.mtime;
  const name = doc.path.split(/[\\/]/).pop()!;
  doc.title = name; const t = $("#ideTitle"); if (t) t.textContent = name;
  const newLang = guessLanguage(name); if (newLang !== "plaintext" && newLang !== doc.lang) { doc.lang = newLang; editor.getModel() && monaco.editor.setModelLanguage(editor.getModel(), newLang); const l = $("#ideLang"); if (l) l.textContent = newLang; }
  refreshDirty();
  setStatus("Saved ✓", "ok");
  } finally {
    // Always release the guard + restore the button (don't touch the status - the branches set it).
    saving = false;
    const b = $("#ideSave") as HTMLButtonElement | null; if (b) b.disabled = doc.readOnly || !doc.dirty;
  }
}

async function reloadFromDisk(path: string): Promise<void> {
  const r = await bridge.editorRead(path);
  if (!r?.ok || r.content === undefined) { setStatus("Reload failed", "err"); return; }
  editor.setValue(r.content);
  doc.baseValue = r.content; doc.baseSha = r.sha256; doc.baseMtime = r.mtime;
  refreshDirty();
  setStatus("Reloaded", "");
}

// ── send to chat / pop-out / close ────────────────────────────────────────────────────
function sendToChat(): void {
  if (!editor) return;
  const code = editor.getValue();
  const fence = doc.lang === "plaintext" ? "" : doc.lang;
  hooks.sendToChat?.(`\n\`\`\`${fence}\n${code}\n\`\`\`\n`);
  setStatus("Sent to chat", "ok");
}

// Detached COPY in a new window (read-only textarea - no scripts, so it's CSP-safe). Edits there are
// not synced back; it's for side-by-side reference / external copy.
function popOut(): void {
  if (!editor) return;
  const w = window.open("", "_blank", "width=720,height=640");
  if (!w) { setStatus("Pop-out blocked", "err"); return; }
  const d = w.document;
  d.title = `${doc.title} - detached copy`;
  d.body.style.cssText = "margin:0;background:#0b0e14;color:#d6deeb;font:13px/1.5 ui-monospace,monospace";
  const bar = d.createElement("div");
  bar.style.cssText = "padding:8px 12px;border-bottom:1px solid #1c2333;color:#8aa;font-weight:600";
  bar.textContent = `${doc.title}  ·  ${doc.lang}  ·  detached copy (edits here don't save)`;
  const ta = d.createElement("textarea");
  ta.value = editor.getValue();
  ta.spellcheck = false;
  ta.style.cssText = "width:100%;height:calc(100vh - 38px);box-sizing:border-box;border:0;outline:none;resize:none;padding:12px;background:#0b0e14;color:#d6deeb;font:13px/1.6 ui-monospace,monospace";
  d.body.append(bar, ta);
}

/** Close, but guard unsaved edits behind a confirm banner. */
function requestClose(): void {
  if (doc.dirty) { showBanner("You have unsaved changes.", [{ label: "Discard & close", kind: "danger", run: () => { doc.dirty = false; closeIde(); } }, { label: "Keep editing", run: () => {} }]); return; }
  closeIde();
}
export function closeIde(): void {
  if (!panel) return;
  hideBanner();
  panel.classList.remove("open");
  panel.setAttribute("aria-hidden", "true");
}
