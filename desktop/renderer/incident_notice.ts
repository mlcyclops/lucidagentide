// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/incident_notice.ts - P-RECOVER.1 (ADR-0385): the recovery notice at the thread tail and
// the incident Submit dialog.
//
// Security first, in three ways:
//   - Every incident string (headline, issue body, report path) reaches the DOM through textContent. The
//     markup below is static; nothing from an incident is ever interpolated into HTML.
//   - Submitting is only ever the user's click. The dialog says plainly what was removed, that GitHub
//     issues are PUBLIC, and that only the summary is prefilled; the full report stays on this machine.
//   - The issue link is re-checked (isIncidentIssueUrl) before it is opened, so a notice can never open
//     anything but a new issue on the upstream repository.

import { bridge, type IncidentView } from "./bridge.ts";
import { $, el } from "./dom.ts";
import { icon } from "./icons.ts";
import { incidentHeadline, isIncidentIssueUrl } from "./recovery_supervisor.ts";
import { showToast } from "./ui.ts";

export interface NoticeAction { label: string; run: () => void; primary?: boolean }

export const REPORT_SAVED = "An incident report was saved.";

/** Show (or replace) the single recovery notice at the tail of the thread. `autoHideMs` removes it later
 *  unless a newer notice replaced it first. */
export function showRecoveryNotice(text: string, opts: { actions?: NoticeAction[]; autoHideMs?: number; id?: string } = {}): HTMLElement | null {
  const thread = $("#thread");
  if (!thread) return null;
  const id = opts.id ?? "recoveryNotice";
  document.getElementById(id)?.remove();
  const note = el(`<div class="thread-tail-note recovery-note" role="status" aria-live="polite"><span class="recovery-note-txt"></span><span class="recovery-note-acts"></span></div>`);
  note.id = id;
  ($(".recovery-note-txt", note) as HTMLElement).textContent = text;
  const acts = $(".recovery-note-acts", note) as HTMLElement;
  for (const a of opts.actions ?? []) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = a.primary ? "btn-mini ok" : "btn-mini";
    b.textContent = a.label;
    b.addEventListener("click", a.run);
    acts.appendChild(b);
  }
  thread.appendChild(note);
  if (opts.autoHideMs) setTimeout(() => { if (note.isConnected) note.remove(); }, opts.autoHideMs);
  return note;
}

export function clearRecoveryNotice(id = "recoveryNotice"): void {
  document.getElementById(id)?.remove();
}

/** The "an incident report was saved" notice for one incident, with Submit and Dismiss. `lead` replaces
 *  the kind's default headline when the caller knows more (e.g. the resume outcome). */
export function showIncidentNotice(inc: IncidentView, lead?: string, noticeId?: string): void {
  const id = noticeId ?? `incidentNotice-${inc.id}`;
  const text = `${lead ?? incidentHeadline(inc.kind, inc.outcome)} ${REPORT_SAVED}`;
  showRecoveryNotice(text, {
    id,
    actions: [
      { label: "Submit report", primary: true, run: () => openIncidentSubmit(inc) },
      { label: "Dismiss", run: () => clearRecoveryNotice(id) },
    ],
  });
}

/** The Submit dialog. Nothing leaves the machine unless the user clicks Open GitHub issue (summary only)
 *  or copies the full report themselves. */
export function openIncidentSubmit(inc: IncidentView): void {
  if (document.getElementById("incidentSubmit")) return;
  const canReveal = bridge.canShowInFolder();
  const ov = el(`<div id="incidentSubmit" class="modal-ov">
    <div class="modal incident-modal" role="dialog" aria-modal="true" aria-labelledby="incidentSubmitTitle">
      <div class="modal-icon">${icon("shield", 24)}</div>
      <h2 class="modal-title" id="incidentSubmitTitle">Submit an incident report</h2>
      <p class="modal-desc">The report was redacted before it was saved. It contains no prompts, no chat transcripts, no API keys or tokens, no e-mail addresses, and no home folder path.</p>
      <p class="modal-desc incident-public"><b>GitHub issues are public.</b> Only the summary below is prefilled in the new issue. The full report stays on this computer; review it before you attach it.</p>
      <div class="incident-preview-h">Issue summary (prefilled)</div>
      <pre class="incident-preview" tabindex="0"></pre>
      <div class="modal-actions incident-actions">
        <button class="btn-mini ok" type="button" data-inc="open">Open GitHub issue</button>
        ${canReveal ? `<button class="btn-mini" type="button" data-inc="show">Show report file</button>` : ""}
        <button class="btn-mini" type="button" data-inc="copy">Copy full report</button>
        <button class="btn-mini" type="button" data-inc="close">Not now</button>
      </div>
    </div></div>`);
  ($(".incident-preview", ov) as HTMLElement).textContent = inc.issueBody;
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  const close = () => { document.removeEventListener("keydown", onKey); ov.remove(); };
  document.addEventListener("keydown", onKey);
  ov.addEventListener("click", async (ev) => {
    const t = ev.target as HTMLElement;
    if (t === ov) { close(); return; }
    const what = (t.closest("[data-inc]") as HTMLElement | null)?.dataset.inc;
    if (what === "close") close();
    else if (what === "open") {
      if (!isIncidentIssueUrl(inc.issueUrl)) {
        showToast({ tone: "danger", title: "Link refused", desc: "This report's issue link does not point at the LUCID repository, so it was not opened.", timeout: 6000 });
        return;
      }
      const opened = await bridge.openExternal(inc.issueUrl);
      if (!opened) window.open(inc.issueUrl, "_blank", "noopener");
      void bridge.incidentSeen(inc.id);
    } else if (what === "show") {
      const shown = await bridge.showInFolder(inc.reportPath);
      if (!shown) showToast({ tone: "warn", title: "Could not show the report", desc: "The report file could not be revealed in its folder.", timeout: 5000 });
    } else if (what === "copy") {
      const md = await bridge.incidentReport(inc.id);
      if (md === null) { showToast({ tone: "warn", title: "Report unavailable", desc: "The full report could not be read.", timeout: 5000 }); return; }
      try {
        await navigator.clipboard.writeText(md);
        showToast({ title: "Report copied", desc: "Review it before you paste it anywhere.", timeout: 3000 });
      } catch { showToast({ tone: "danger", title: "Copy failed", desc: "Clipboard unavailable in this view.", timeout: 3000 }); }
    }
  });
  document.body.appendChild(ov);
  ($("[data-inc='open']", ov) as HTMLButtonElement | null)?.focus();
}
