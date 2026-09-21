// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/judgment_trace_view.ts - P-JEV.2 (ADR-0377): the per-turn judgment trace (Jev / TypeSafe).
//
// omp answers typed judgments (auto-thinking effort, the unexpected-stop check, the agent's own judge()
// calls) out of band, and never showed them. The judgment extension reports each one; this window sits
// with the tool activity, fills in live, and settles to "Jev consulted · N" (or names the chat model that
// answered when Jev did not). Expanded: one table per judgment - the question, the typed answer with its
// probability bars and confidence, which backend answered, latency, and the judged state - so the user can
// see HOW the answer was reached, not just that one exists. Own module (like toolfail_group.ts) so it can be
// mounted on its own for visual QA against the real stylesheet.

import { $, el, fmtNum } from "./dom.ts";
import { icon } from "./icons.ts";
import { esc } from "./format.ts";
import { answerSummary, backendLabel, JEV_IDLE_REASON, judgmentPurpose, type JudgmentReport, type TraceAnswer, type TraceQuestion } from "../../harness/judgment/trace.ts";

export interface JudgmentsWin { el: HTMLElement; add(report: JudgmentReport): void; finish(): void }

function rowHtml(id: string, q: TraceQuestion, a: TraceAnswer | undefined): string {
  const s = answerSummary(q, a);
  const bars = s.bars.map((b) => `<div class="jd-bar"><span class="jd-bar-l">${esc(b.label)}</span><span class="jd-bar-t"><span class="jd-bar-f" style="width:${Math.round(b.p * 100)}%"></span></span><span class="jd-bar-p">${Math.round(b.p * 100)}%</span></div>`).join("");
  return `<tr>
    <td><div class="jd-id">${esc(id)} <span class="jd-type">${esc(q.type === "noul" ? "yes/no" : q.type)}</span></div><div class="jd-instr">${esc(q.instructions)}</div></td>
    <td><div class="jd-ans${a ? "" : " none"}">${esc(s.headline)}</div>${bars ? `<div class="jd-bars">${bars}</div>` : ""}</td>
    <td class="jd-conf">${s.confidence === undefined ? "" : `${Math.round(s.confidence * 100)}%`}</td>
  </tr>`;
}

export function createJudgments(): JudgmentsWin {
  const win = el(`<div class="thoughts judgments open" data-streaming="1">
    <button class="thoughts-head" type="button" aria-expanded="true">
      <span class="thoughts-spin">${icon("scale", 13)}</span>
      <span class="thoughts-cur">Judging\u2026</span>
      <span class="thoughts-count" hidden>0</span>
      <span class="thoughts-chev">${icon("chevron", 14)}</span>
    </button>
    <div class="thoughts-body"></div>
  </div>`);
  const headBtn = $(".thoughts-head", win) as HTMLButtonElement;
  const curEl = $(".thoughts-cur", win) as HTMLElement;
  const countEl = $(".thoughts-count", win) as HTMLElement;
  const body = $(".thoughts-body", win) as HTMLElement;
  const reports: JudgmentReport[] = [];
  const toggle = (open: boolean) => { win.classList.toggle("open", open); headBtn.setAttribute("aria-expanded", String(open)); };
  headBtn.addEventListener("click", () => toggle(!win.classList.contains("open")));
  return {
    el: win,
    add(report) {
      reports.push(report);
      countEl.hidden = false; countEl.textContent = String(reports.length);
      const who = backendLabel(report);
      curEl.textContent = report.error ? `${who} failed, falling back\u2026` : `${judgmentPurpose(report)} \u00b7 ${who}`;
      const rows = Object.entries(report.questions).map(([id, q]) => rowHtml(id, q, report.answers?.[id])).join("");
      const stateNote = `Judged state \u00b7 ${fmtNum(report.stateChars)} chars${report.stateTruncated ? " (preview truncated)" : ""}`;
      body.appendChild(el(`<div class="jd${report.error ? " failed" : ""}">
        <div class="jd-head"><span class="jd-purpose">${esc(judgmentPurpose(report))}</span><span class="jd-who">${esc(who)}</span><span class="jd-ms">${fmtNum(report.ms)} ms</span>${report.usage ? `<span class="jd-ms">${fmtNum(report.usage.input)} in \u00b7 ${fmtNum(report.usage.output)} out</span>` : ""}</div>
        ${report.error ? `<div class="jd-err">${icon("info", 12)} <span>Failed: ${esc(report.error)}. omp falls back to the chat-model chain; the next row is that fallback.</span></div>` : ""}
        ${rows ? `<div class="jd-wrap"><table class="jd-table"><thead><tr><th>Question</th><th>Answer</th><th>Confidence</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="jd-err">${icon("info", 12)} <span>No displayable questions in this request.</span></div>`}
        <details class="jd-state"><summary>${esc(stateNote)}</summary><pre>${esc(report.state)}</pre></details>
      </div>`));
      if (win.classList.contains("open")) body.scrollTop = body.scrollHeight;
    },
    finish() {
      win.removeAttribute("data-streaming");
      win.classList.add("done");
      toggle(false); // auto-collapse to the one-line summary; the tables stay one click away
      const n = reports.length;
      const jev = reports.filter((r) => r.backend === "typesafe" && !r.error).length;
      const failed = reports.filter((r) => r.backend === "typesafe" && r.error).length;
      const fallback = reports.filter((r) => r.backend === "text");
      const other = fallback.length ? backendLabel(fallback[fallback.length - 1]!) : "";
      curEl.textContent = jev
        ? `Jev consulted \u00b7 ${jev} judgment${jev === 1 ? "" : "s"}${failed ? ` \u00b7 ${failed} failed` : ""}${fallback.length ? ` \u00b7 ${fallback.length} by ${other}` : ""}`
        : `${n} judgment${n === 1 ? "" : "s"} by ${other || "the chat model"}${failed ? ` \u00b7 Jev failed ${failed}\u00d7` : ""}`;
      win.classList.toggle("jev", jev > 0);
      countEl.hidden = true;
    },
  };
}

/** The quiet note for a turn where Jev was set up but nothing asked for a judgment. Only rendered when the
 *  server says Jev is configured (effective mode + saved key), so a user who never set it up is never told
 *  about it. */
export function judgmentIdleNote(): HTMLElement {
  return el(`<div class="thoughts judgments done idle" data-tip="Jev not consulted|${esc(JEV_IDLE_REASON)}" data-tip-icon="scale">
    <div class="thoughts-head jd-idle"><span class="thoughts-spin">${icon("scale", 13)}</span><span class="thoughts-cur">Jev not consulted this turn</span></div>
  </div>`);
}
