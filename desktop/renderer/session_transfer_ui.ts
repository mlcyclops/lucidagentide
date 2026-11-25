// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/session_transfer_ui.ts - P-SESSXFER.1 (ADR-0682): the Sessions header's history menu.
//
//   Export history...  a dialog: which sessions (this project, or one agent's), an optional classification marking,
//                      include images (off). The engine builds the .lucidhistory.json text; it is saved through the
//                      native save dialog under Electron, else downloaded as a Blob. Nothing touches a network.
//   Import history...  an offline file pick (input type=file, read as text here), posted to the engine, which runs
//                      every gate and writes the clean sessions into this project; a dialog reports what happened.
//
// Every string from the engine or a file reaches the DOM through esc() or textContent.

import { bridge, type HistoryExportScope, type HistoryExportView, type HistoryImportView } from "./bridge.ts";
import { $, el } from "./dom.ts";
import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import { popover, showToast } from "./ui.ts";

/** The engine's cap (session_transfer.MAX_HISTORY_BYTES); a bigger file is refused before it is read. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MARKING = /^[\x20-\x7e]{0,200}$/;

/** The header button's menu. `onImported` repaints the session list. */
export function openHistoryMenu(anchor: HTMLElement, onImported: () => void): void {
  const p = popover(anchor, `<div class="sx-menu" role="menu" aria-label="Session history">
      <div class="cfg-opt" role="menuitem" tabindex="0" data-sx="export"><span class="tick">${icon("download", 13)}</span><span class="nm">Export history\u2026</span></div>
      <div class="cfg-opt" role="menuitem" tabindex="0" data-sx="import"><span class="tick">${icon("folder", 13)}</span><span class="nm">Import history\u2026</span></div>
    </div>`);
  p.node.classList.add("sx-pop");
  p.reposition();
  const pick = (what: string | undefined): void => {
    if (what === "export") { p.close(); void openExportDialog(); }
    else if (what === "import") { p.close(); pickImportFile(onImported); }
  };
  p.node.addEventListener("click", (ev) => pick(((ev.target as HTMLElement).closest("[data-sx]") as HTMLElement | null)?.dataset.sx));
  p.node.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    pick(((ev.target as HTMLElement).closest("[data-sx]") as HTMLElement | null)?.dataset.sx);
  });
}

/** A modal on the shared .modal chrome; Escape and a press on the scrim close it. */
function modal(id: string, inner: string): { ov: HTMLElement; close: () => void } {
  document.getElementById(id)?.remove();
  const ov = el(`<div id="${id}" class="modal-ov"><div class="modal sx-modal" role="dialog" aria-modal="true" aria-labelledby="${id}Title">${inner}</div></div>`);
  const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  const close = (): void => { document.removeEventListener("keydown", onKey); ov.remove(); };
  document.addEventListener("keydown", onKey);
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(); });
  document.body.appendChild(ov);
  return { ov, close };
}

const rowHtml = (id: string, note: string): string =>
  `<div class="sx-item"><span class="sx-id">${esc(id)}</span><span class="sx-note">${esc(note)}</span></div>`;

async function openExportDialog(): Promise<void> {
  const info = await bridge.historyTransferInfo().catch(() => null);
  if (!info) { showToast({ tone: "warn", title: "Export history", desc: "The engine did not answer.", actions: [{ label: "OK" }], timeout: 5000 }); return; }
  const opts = [`<option value="project">This project: ${esc(info.project)} (${info.sessions} session${info.sessions === 1 ? "" : "s"})</option>`,
    ...info.lanes.map((l) => `<option value="lane:${esc(l.id)}">Agent: ${esc(l.name)} (${l.sessions} session${l.sessions === 1 ? "" : "s"})</option>`)].join("");
  const { ov, close } = modal("sxExport", `
      <div class="modal-icon">${icon("download", 24)}</div>
      <h2 class="modal-title" id="sxExportTitle">Export session history</h2>
      <p class="modal-desc">One plain-text <b>.lucidhistory.json</b> file that imports into any LUCID Agent IDE, the Tahiti edition included, with no network. Each session is scanned first; your home folder path and anything shaped like a key or token are removed.</p>
      <div class="sx-row"><span class="sx-lab">Sessions</span><select class="prov-key" data-sx-scope aria-label="Which sessions to export">${opts}</select></div>
      <div class="sx-row"><span class="sx-lab">Marking</span><input class="prov-key" data-sx-marking type="text" maxlength="200" placeholder="Optional, e.g. UNCLASSIFIED" spellcheck="false" autocomplete="off" aria-label="Classification marking (optional)" /></div>
      <label class="sx-check"><input type="checkbox" data-sx-images /><span>Include images (keep off for a cross domain transfer)</span></label>
      <div class="modal-err" data-sx-err hidden></div>
      <div class="modal-actions">
        <button class="btn-mini" type="button" data-sx-act="cancel">Cancel</button>
        <button class="btn-mini ok" type="button" data-sx-act="export">Export</button>
      </div>`);
  const err = $("[data-sx-err]", ov) as HTMLElement;
  const say = (msg: string): void => { err.textContent = msg; err.hidden = !msg; };
  ov.addEventListener("click", async (ev) => {
    const act = ((ev.target as HTMLElement).closest("[data-sx-act]") as HTMLElement | null)?.dataset.sxAct;
    if (act === "cancel") { close(); return; }
    if (act !== "export") return;
    const marking = ($("[data-sx-marking]", ov) as HTMLInputElement).value.trim();
    if (!MARKING.test(marking)) { say("The marking must be plain ASCII on one line, at most 200 characters."); return; }
    const sel = ($("[data-sx-scope]", ov) as HTMLSelectElement).value;
    const scope: HistoryExportScope = sel.startsWith("lane:") ? { kind: "lane", laneId: sel.slice(5) } : { kind: "project" };
    const btn = $("[data-sx-act='export']", ov) as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Scanning\u2026";
    say("");
    const r = await bridge.exportHistory(scope, marking, ($("[data-sx-images]", ov) as HTMLInputElement).checked).catch(() => null);
    btn.disabled = false;
    btn.textContent = "Export";
    if (!r) { say("The engine did not answer."); return; }
    if (!r.ok || !r.file || !r.filename) { say(r.error ?? "Nothing was exported."); if (r.blocked) showExportReport(r); return; }
    const saved = await saveHistory(r.file, r.filename);
    if ("error" in saved) { say(`Not saved: ${saved.error}`); return; }
    if (!saved.saved) return; // the save dialog was canceled: the user can try again
    close();
    showToast({ tone: "ok", title: `Exported ${r.exported} session${r.exported === 1 ? "" : "s"}`, desc: `Saved to ${saved.where}.${r.blocked ? ` ${r.blocked} blocked by the scanner.` : ""}`, timeout: 6000 });
    if (r.blocked) showExportReport(r);
  });
  ($("[data-sx-scope]", ov) as HTMLElement).focus();
}

function showExportReport(r: HistoryExportView): void {
  const rows = r.report.filter((x) => x.status === "blocked").map((x) => rowHtml(x.title || x.id, x.reason ?? "blocked")).join("");
  const { ov, close } = modal("sxReport", `
      <div class="modal-icon">${icon("shield", 24)}</div>
      <h2 class="modal-title" id="sxReportTitle">Sessions left out</h2>
      <p class="modal-desc">The scanner found hidden or deceptive characters in these sessions, so they are not in the file. Each is logged in the Security panel.</p>
      <div class="sx-list">${rows}</div>
      <div class="modal-actions"><button class="btn-mini ok" type="button" data-sx-act="ok">OK</button></div>`);
  ov.addEventListener("click", (ev) => { if ((ev.target as HTMLElement).closest("[data-sx-act='ok']")) close(); });
}

/** The native save dialog under Electron (preload), else a Blob download. Same shape as the vault backup's save. */
async function saveHistory(text: string, filename: string): Promise<{ saved: boolean; where: string } | { error: string }> {
  const save = window.lucid?.saveTextFile;
  if (save) {
    const r = await save({ title: "Save the session history", defaultName: filename, filters: [{ name: "LUCID session history", extensions: ["json"] }], text }).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
    if (r === null) return { saved: false, where: "" };
    if (typeof r === "string") return { saved: true, where: r };
    return r;
  }
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { saved: true, where: `your downloads (${filename})` };
}

/** One shared hidden file input, so a pick always lands in a fresh change event. */
function pickImportFile(onImported: () => void): void {
  let input = document.getElementById("sxImportFile") as HTMLInputElement | null;
  if (!input) {
    input = el(`<input type="file" id="sxImportFile" accept=".json,application/json" hidden />`) as HTMLInputElement;
    document.body.appendChild(input);
    input.addEventListener("change", () => {
      const f = input?.files?.[0] ?? null;
      if (input) input.value = "";
      if (f) void importFile(f, onImported);
    });
  }
  input.click();
}

async function importFile(f: File, onImported: () => void): Promise<void> {
  if (f.size > MAX_FILE_BYTES) { showImportResult(null, "That file is larger than any LUCID history file."); return; }
  showToast({ tone: "info", title: "Importing history", desc: `Checking ${f.name}: format, hashes, then the scanner.`, timeout: 3000 });
  const r = await bridge.importHistory(await f.text()).catch(() => null);
  showImportResult(r, r ? "" : "The engine did not answer.");
  if (r?.ok && r.imported.length) onImported();
}

function showImportResult(r: HistoryImportView | null, fallback: string): void {
  const ok = !!r?.ok;
  const counts = r && ok
    ? `${r.imported.length} imported \u00b7 ${r.skipped.length} already here \u00b7 ${r.conflicts.length} id conflict${r.conflicts.length === 1 ? "" : "s"} \u00b7 ${r.blocked.length} quarantined`
    : "";
  const rows = r ? [
    ...r.blocked.map((b) => rowHtml(b.id, `quarantined: ${b.reason}`)),
    ...r.conflicts.map((id) => rowHtml(id, "a different session with this id is here; yours was kept")),
    ...r.failed.map((b) => rowHtml(b.id, `not written: ${b.reason}`)),
  ].join("") : "";
  const from = r?.project ? `From ${esc(r.project)}${r.marking ? ` (${esc(r.marking)})` : ""}, exported ${esc((r.createdAt ?? "").slice(0, 10))}. ` : "";
  const { ov, close } = modal("sxImport", `
      <div class="modal-icon">${icon(ok ? "check" : "shield", 24)}</div>
      <h2 class="modal-title" id="sxImportTitle">${ok ? "History imported" : "Nothing imported"}</h2>
      ${ok ? `<p class="modal-desc">${from}Imported sessions are marked imported and untrusted in the list.</p>` : ""}
      <p class="modal-desc sx-counts" data-sx-counts></p>
      ${rows ? `<div class="sx-list">${rows}</div>` : ""}
      <div class="modal-actions"><button class="btn-mini ok" type="button" data-sx-act="ok">OK</button></div>`);
  ($("[data-sx-counts]", ov) as HTMLElement).textContent = ok ? counts : (r?.error ?? fallback);
  ov.addEventListener("click", (ev) => { if ((ev.target as HTMLElement).closest("[data-sx-act='ok']")) close(); });
  ($("[data-sx-act='ok']", ov) as HTMLButtonElement).focus();
}
