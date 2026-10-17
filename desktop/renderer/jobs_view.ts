// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/jobs_view.ts - P-SCHED.2 (ADR-0443 decision 5): the Jobs rail tile, its premium hover
// (a 7-day by 24-hour grid plus the next runs) and the Jobs sheet, as PURE builders (the format.ts
// convention: data in, HTML out) so the layout rules are unit-tested. app.ts owns the DOM, the bridge
// calls and the clicks. Invariant 11 everywhere: every row's label is one ellipsised line, prose never
// sits as raw text among flex items.

import { describeCron, firesBetween, parseCron } from "../cron.ts";
import { esc } from "./format.ts";
import { icon } from "./icons.ts";

export type JobOutcome = "ok" | "error" | "timeout" | "waiting" | "suspended" | "cancelled";
export interface JobRunView { startedAt: number; endedAt?: number; outcome: JobOutcome; laneId?: string; note?: string }
export interface JobView {
  id: string; name: string; prompt: string; cron: string; armed: boolean; autoApprove: boolean; maxMinutes: number;
  missed: "run-once" | "skip"; createdAt: number; lastRunAt?: number; lastOutcome?: JobOutcome; suspended?: string;
  nextFireAt: number | null; history: JobRunView[];
  target: { laneId?: string; name: string; cwd: string; model?: string; repo?: string };
}
export interface UpcomingFire { at: number; jobId: string; name: string; lane: string; repo: string }
export interface JobsData { jobs: JobView[]; running: string[]; upcoming: UpcomingFire[] }
export interface JobTargetView { laneId: string; name: string; cwd: string; model?: string; live: boolean; repo?: string }

const DAY = 86_400_000;
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
/** "in 3h", "in 25m", "Fri 02:00", "now". */
export function fmtNext(at: number | null, now: number): string {
  if (at === null) return "none";
  const diff = at - now;
  if (diff <= 60_000) return "now";
  if (diff < 3600_000) return `in ${Math.round(diff / 60_000)}m`;
  if (diff < 24 * 3600_000) return `in ${Math.round(diff / 3600_000)}h`;
  return `${DOW[new Date(at).getDay()]} ${fmtClock(at)}`;
}
export function repoLabel(t: { repo?: string; cwd: string }): string {
  const r = t.repo ?? "";
  if (r) return r.replace(/^https?:\/\//, "").replace(/\.git$/, "").split("/").slice(-2).join("/") || r;
  return t.cwd.split(/[\\/]/).filter(Boolean).pop() ?? t.cwd;
}

/** The tile. `null` means "no tile" (no jobs exist yet: the LUCID points rule, no dead zero tile). */
export function jobsTile(data: JobsData | null, now: number): { n: string; label: string; attn: boolean; tip: string } | null {
  if (!data || !data.jobs.length) return null;
  const armed = data.jobs.filter((j) => j.armed && !j.suspended);
  const next = armed.map((j) => j.nextFireAt).filter((n): n is number => n !== null).sort((a, b) => a - b)[0] ?? null;
  const running = data.running.length;
  const waiting = data.jobs.some((j) => j.lastOutcome === "waiting" || j.suspended);
  const failed = data.jobs.some((j) => j.lastOutcome === "error" || j.lastOutcome === "timeout");
  const n = running ? `${running} live` : armed.length ? fmtNext(next, now) : "off";
  const tip = running
    ? `${running} scheduled job${running === 1 ? "" : "s"} running now. Hover for the week, click to manage.`
    : armed.length
      ? `${armed.length} armed job${armed.length === 1 ? "" : "s"}; the next fires ${fmtNext(next, now)}. LUCID must stay open for a job to run. Hover for the week, click to manage.`
      : `${data.jobs.length} job${data.jobs.length === 1 ? "" : "s"}, none armed. Click to manage.`;
  return { n, label: "jobs", attn: waiting || failed || running > 0, tip };
}

/** The hover card: 7 columns (today first) by 24 rows, a filled cell per fire, then the next five runs. */
export function jobsHoverHtml(data: JobsData, now: number): string {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const dayStart = start.getTime();
  const cells: string[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ""));
  const names: string[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ""));
  for (const f of data.upcoming) {
    const day = Math.floor((f.at - dayStart) / DAY);
    if (day < 0 || day > 6) continue;
    const hour = new Date(f.at).getHours();
    cells[day]![hour] = cells[day]![hour] ? "many" : "one";
    names[day]![hour] = names[day]![hour] ? `${names[day]![hour]}, ${f.name}` : f.name;
  }
  const head = Array.from({ length: 7 }, (_, i) => `<div class="jg-h">${i === 0 ? "today" : DOW[new Date(dayStart + i * DAY).getDay()]}</div>`).join("");
  const rows: string[] = [];
  for (let h = 0; h < 24; h++) {
    rows.push(`<div class="jg-hr">${h % 6 === 0 ? `${String(h).padStart(2, "0")}` : ""}</div>` + Array.from({ length: 7 }, (_, d) => `<div class="jg-c ${cells[d]![h]}"${names[d]![h] ? ` title="${esc(`${DOW[new Date(dayStart + d * DAY).getDay()]} ${String(h).padStart(2, "0")}:00 ${names[d]![h]}`)}"` : ""}></div>`).join(""));
  }
  const next = data.upcoming.filter((f) => f.at >= now - 60_000 && f.at < dayStart + 7 * DAY).slice(0, 5).map((f) => `<div class="jn-row"><span class="jn-when">${esc(`${f.at - dayStart < DAY ? "today" : DOW[new Date(f.at).getDay()]} ${fmtClock(f.at)}`)}</span><span class="jn-repo">${esc(f.repo)}</span><span class="jn-name">${esc(f.name)}</span><span class="jn-lane">${esc(f.lane)}</span></div>`).join("");
  const armed = data.jobs.filter((j) => j.armed && !j.suspended).length;
  return `<div class="rt-h">${icon("calendar", 14)} Scheduled jobs</div>
    <div class="jg"><div class="jg-hr"></div>${head}${rows.join("")}</div>
    ${next ? `<div class="jn">${next}</div>` : `<div class="rt-d">${armed ? "No fires in the next seven days." : "No armed jobs. Click the tile to add or arm one."}</div>`}
    <div class="rt-d">${esc(`${data.jobs.length} job${data.jobs.length === 1 ? "" : "s"}, ${armed} armed. LUCID must stay open for a job to run; click the tile to manage.`)}</div>`;
}

export type CadenceKind = "daily" | "weekly" | "cron";
/** PURE: the builder's pickers to a cron expression. */
export function cadenceToCron(kind: CadenceKind, hhmm: string, days: number[], expr: string): string | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim());
  if (kind === "cron") return parseCron(expr) ? expr.trim() : null;
  if (!m) return null;
  const minute = Number(m[2]), hour = Number(m[1]);
  if (kind === "daily") return `${minute} ${hour} * * *`;
  const d = [...new Set(days.filter((x) => x >= 0 && x <= 6))].sort((a, b) => a - b);
  if (!d.length) return null;
  return `${minute} ${hour} * * ${d.join(",")}`;
}
/** The next three fires, for the live readout under the builder. */
export function nextThree(cron: string, now: number): string[] {
  return firesBetween(cron, new Date(now), new Date(now + 400 * DAY), 3).map((d) => `${DOW[d.getDay()]} ${d.toLocaleDateString()} ${fmtClock(d.getTime())}`);
}

function outcomePill(j: JobView, running: boolean): string {
  if (running) return `<span class="pill">running</span>`;
  if (j.suspended) return `<span class="pill quarantined">suspended</span>`;
  if (!j.armed) return `<span class="pill dismissed">disarmed</span>`;
  if (j.lastOutcome === "waiting") return `<span class="pill dismissed">waiting on the lane</span>`;
  if (j.lastOutcome === "error" || j.lastOutcome === "timeout") return `<span class="pill quarantined">${esc(j.lastOutcome)}</span>`;
  return `<span class="pill">armed</span>`;
}

function runLine(r: JobRunView): string {
  const when = new Date(r.startedAt).toLocaleString();
  const dur = r.endedAt && r.endedAt > r.startedAt ? ` (${Math.max(1, Math.round((r.endedAt - r.startedAt) / 60_000))} min)` : "";
  return `${when}: ${r.outcome}${dur}${r.note ? ` - ${r.note}` : ""}`;
}

/** One job row in the sheet. */
export function jobRowHtml(j: JobView, now: number, running: boolean): string {
  const next = j.armed && !j.suspended ? `next ${fmtNext(j.nextFireAt, now)}` : j.suspended ? j.suspended : "not scheduled";
  const hist = j.history.slice(0, 5).map((r) => `<div class="job-run">${esc(runLine(r))}</div>`).join("");
  return `<div class="job-row" data-job="${esc(j.id)}">
    <div class="job-head">
      <b class="job-name">${esc(j.name)}</b>${outcomePill(j, running)}
      <span class="job-meta">${esc(describeCron(j.cron))} · ${esc(next)}</span>
    </div>
    <div class="job-target">${icon("folder", 11)}<span>${esc(j.target.name)} · ${esc(repoLabel(j.target))}${j.target.model ? ` · ${esc(j.target.model)}` : ""}${j.autoApprove ? " · auto-mode" : " · asks park"} · ${j.maxMinutes} min cap · missed: ${j.missed}</span></div>
    <div class="job-prompt">${esc(j.prompt.length > 180 ? `${j.prompt.slice(0, 180)}\u2026` : j.prompt)}</div>
    <div class="job-acts">
      <button class="btn-mini ${j.armed && !j.suspended ? "" : "ok"}" data-job-arm="${esc(j.id)}" data-arm-to="${j.armed && !j.suspended ? "0" : "1"}">${j.armed && !j.suspended ? `${icon("close", 11)} Disarm` : `${icon("check", 11)} Arm`}</button>
      <button class="btn-mini" data-job-run="${esc(j.id)}"${running ? " disabled" : ""}>${icon("bolt", 11)} Run now</button>
      <button class="btn-mini" data-job-hist="${esc(j.id)}" aria-expanded="false">${icon("clock", 11)} History</button>
      <button class="btn-mini danger" data-job-del="${esc(j.id)}">${icon("trash", 11)} Delete</button>
    </div>
    <div class="job-hist" hidden>${hist || `<div class="job-run">No runs yet.</div>`}</div>
  </div>`;
}

/** The whole sheet body: the list, then the add form. */
export function jobsSheetHtml(data: JobsData, targets: JobTargetView[], now: number): string {
  const rows = data.jobs.map((j) => jobRowHtml(j, now, data.running.includes(j.id))).join("");
  const opts = targets.map((t) => `<option value="${esc(t.laneId)}">${esc(`${t.name} · ${repoLabel(t)}${t.live ? "" : " (remembered)"}`)}</option>`).join("");
  return `<div class="jobs-head"><span class="jobs-title">${icon("calendar", 16)} Scheduled jobs</span><span class="jobs-sub">Wake a Fleet lane while you are away. LUCID must stay open; a job runs with the lane's model and folder.</span><button class="set-close" data-jobs-close aria-label="Close">${icon("close", 16)}</button></div>
  <div class="jobs-body">
    <div class="jobs-list">${rows || `<div class="cfg-empty">No jobs yet. Add one below; it starts disarmed.</div>`}</div>
    <form class="job-form" data-job-form>
      <div class="job-form-h">${icon("plus", 13)} New job</div>
      <label class="job-f"><span>Name</span><input class="prov-key" name="name" required maxlength="80" placeholder="Nightly ticket triage" /></label>
      <label class="job-f"><span>Lane</span><select class="prov-key" name="target" required>${opts || `<option value="">no lanes yet (spawn one in Fleet)</option>`}</select></label>
      <label class="job-f"><span>Prompt</span><textarea class="prov-key" name="prompt" rows="3" required placeholder="What the lane should do when the job fires"></textarea></label>
      <div class="job-f"><span>When</span>
        <div class="job-when">
          <select class="prov-key" name="kind"><option value="daily">Every day at</option><option value="weekly">Weekly at</option><option value="cron">Cron expression</option></select>
          <input class="prov-key job-time" name="hhmm" type="time" value="02:00" />
          <span class="job-days" data-job-days hidden>${DOW.map((d, i) => `<label><input type="checkbox" name="day" value="${i}"${i >= 1 && i <= 5 ? " checked" : ""} /> ${d}</label>`).join("")}</span>
          <input class="prov-key job-cron" name="cron" placeholder="0 2 * * 1-5" hidden />
        </div>
        <div class="job-next" data-job-next></div>
      </div>
      <div class="job-f"><span>Options</span><div class="job-opts">
        <label><input type="checkbox" name="autoApprove" /> Full auto-mode for the run (the gate still scans every call; without it, an ask parks the run until you answer)</label>
        <label>Cap <input class="prov-key job-num" name="maxMinutes" type="number" min="1" max="720" value="60" /> min</label>
        <label>If missed <select class="prov-key" name="missed"><option value="run-once">run once within 2 h</option><option value="skip">skip</option></select></label>
        <label><input type="checkbox" name="armed" /> Arm now</label>
      </div></div>
      <div class="job-form-acts"><button class="btn-mini ok" type="submit">${icon("check", 12)} Save job</button><span class="job-form-err" data-job-err></span></div>
    </form>
  </div>`;
}
