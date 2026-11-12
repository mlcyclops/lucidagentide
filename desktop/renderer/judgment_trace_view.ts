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
import { answerSummary, backendLabel, effortPick, JEV_IDLE_REASON, judgmentPurpose, type JudgmentReport, type TraceAnswer, type TraceQuestion } from "../../harness/judgment/trace.ts";

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

/** The Jev scale, built with its beam and pans as separate parts so a live judgment can TIP the scale (beam
 *  rocks about the post, each pan rides its end up and down) instead of spinning the whole glyph. The same
 *  outline as icons.ts `scale`; the `ic-scale` class opts it out of the thoughts spinner's rotation. */
function scaleIcon(size: number): string {
  return `<svg class="ic ic-scale" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4.5v15"/><path d="M9 19.5h6"/><path class="jv-beam" d="M5 7.5h14"/><path class="jv-pan-l" d="M7 7.5 4 13.5a3 3 0 0 0 6 0z"/><path class="jv-pan-r" d="M17 7.5 14 13.5a3 3 0 0 0 6 0z"/></svg>`;
}

/** P-JEV.5 (ADR-0416): what a failed judgment means, honestly. omp moves to the next judge in the chain on
 *  an ordinary error, but a TIMEOUT ends the whole judgment (the previous thinking level stands); a local
 *  model that failed more than once is not asked again (Settings > Judgment). Pure, for the test. */
export function failureNote(error: string, timedOut: boolean): string {
  return timedOut
    ? `Timed out: ${error}. A timeout ends this judgment (omp keeps the previous thinking level). A local model that times out more than once is not asked again.`
    : `Failed: ${error}. omp tries the next judge in the chain; the next row is that attempt.`;
}

/** P-JEV.7: the hover text on a window that only holds the chat model's own effort pick. */
const EFFORT_ONLY_TIP = "No judge model|Your Judgment backend is None, so no judge model is asked. With Thinking: Auto, omp still picks a thinking effort for each turn, and your chat model makes that pick itself (a few tokens). Set Thinking to a fixed level to skip it.";

/** `judgeOff`: the Judgment backend is None. Then the window names an effort pick as what it is, the chat
 *  model choosing its own thinking effort, rather than as a judgment (P-JEV.7). */
export function createJudgments(opts: { judgeOff?: boolean } = {}): JudgmentsWin {
  const win = el(`<div class="thoughts judgments open" data-streaming="1">
    <button class="thoughts-head" type="button" aria-expanded="true">
      <span class="thoughts-spin">${scaleIcon(13)}</span>
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
  if (opts.judgeOff) headBtn.setAttribute("data-tip", EFFORT_ONLY_TIP);
  const toggle = (open: boolean) => { win.classList.toggle("open", open); headBtn.setAttribute("aria-expanded", String(open)); };
  headBtn.addEventListener("click", () => toggle(!win.classList.contains("open")));
  return {
    el: win,
    add(report) {
      reports.push(report);
      countEl.hidden = false; countEl.textContent = String(reports.length);
      const who = backendLabel(report);
      const timedOut = !!report.error && /abort|timed? ?out/i.test(report.error);
      const level = opts.judgeOff ? effortPick(report) : null;
      curEl.textContent = report.error ? (timedOut ? `${who} timed out` : `${who} failed, trying the next judge\u2026`)
        : level ? `Thinking effort: ${level} \u00b7 chosen by ${who}` : `${judgmentPurpose(report)} \u00b7 ${who}`;
      const rows = Object.entries(report.questions).map(([id, q]) => rowHtml(id, q, report.answers?.[id])).join("");
      const stateNote = `Judged state \u00b7 ${fmtNum(report.stateChars)} chars${report.stateTruncated ? " (preview truncated)" : ""}`;
      body.appendChild(el(`<div class="jd${report.error ? " failed" : ""}">
        <div class="jd-head"><span class="jd-purpose">${esc(judgmentPurpose(report))}</span><span class="jd-who">${esc(who)}</span><span class="jd-ms">${fmtNum(report.ms)} ms</span>${report.usage ? `<span class="jd-ms">${fmtNum(report.usage.input)} in \u00b7 ${fmtNum(report.usage.output)} out</span>` : ""}</div>
        ${report.error ? `<div class="jd-err">${icon("info", 12)} <span>${esc(failureNote(report.error, timedOut))}</span></div>` : ""}
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
      // P-JEV.7: under None a turn whose only reports are the chat model's effort picks says so, with the why.
      const levels = opts.judgeOff ? reports.map(effortPick) : [];
      if (n && levels.length === n && levels.every((l) => l !== null)) {
        // "No judge model" leads: a narrow column ellipsizes the tail (invariant #11), never the point.
        curEl.textContent = `No judge model \u00b7 thinking effort ${levels[n - 1]}, chosen by ${backendLabel(reports[n - 1]!)}`;
        countEl.hidden = true;
        return;
      }
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
    <div class="thoughts-head jd-idle"><span class="thoughts-spin">${scaleIcon(13)}</span><span class="thoughts-cur">Jev not consulted this turn</span></div>
  </div>`);
}
