// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/incident_report.ts - P-RECOVER.1 (ADR-0385): the self-recovery incident report.
//
// When LUCID recovers itself (a previous run that did not exit cleanly, leftover processes from that
// run, an agent child that died or wedged, an engine that stopped answering) it writes ONE incident
// report, whether or not the recovery worked, and offers the user a way to submit it. The report is
// the evidence the field reports so far never had: "it said reconnecting and nothing happened" arrived
// with no timeline, no process list, and no log tail.
//
// Secret custody follows tools/collect-support-logs.ps1, which this ports to TypeScript:
//   - Every text that enters a report goes through redact(): bearer tokens, sk-/gh*/xox*/AIza keys,
//     JWTs, key=value secrets, e-mail addresses, long hex tokens, and the user's home path.
//   - Prompts, transcripts, settings files, and credential stores are never inputs. Callers pass only
//     plain-language events, process facts, and log TAILS.
//   - Submission is always the user's choice. The prefilled issue carries the SUMMARY only (no log text),
//     because the upstream repository is public; the full redacted report stays on this machine for the
//     user to review and attach.
//
// Pure: no I/O, no Electron, no DOM. incident_store.ts owns the filesystem side.

export const INCIDENT_REPO = "mlcyclops/lucidagentide";

export type IncidentKind =
  /** The previous run did not record a clean exit (crash, forced kill, power loss). */
  | "unclean-shutdown"
  /** Processes the previous run started were still alive at launch and were stopped. */
  | "leftover-processes"
  /** The previous chat session could not be resumed, so a new one was started. */
  | "session-unrecoverable"
  /** The window lost the engine (no answer to status checks) and the engine was restarted. */
  | "engine-unreachable"
  /** The agent child for the chat session died or wedged and in-place recovery was attempted. */
  | "agent-child-failed"
  /** The harness spent its automatic recovery budget and stopped retrying. */
  | "recovery-exhausted";

export type IncidentOutcome = "recovered" | "not-recovered" | "pending";

export interface IncidentEvent {
  /** Epoch ms. */
  at: number;
  /** Plain language, written by the harness (never model or user text). Redacted anyway. */
  what: string;
}

export interface IncidentProcess {
  pid: number;
  name: string;
  /** What LUCID used it for: "engine", "agent (omp)", "speech (whisper)", ... */
  role: string;
  startedAt?: string;
  action: "stopped" | "left-running" | "stop-failed";
}

export interface IncidentInput {
  kind: IncidentKind;
  outcome: IncidentOutcome;
  product: string;
  version: string;
  platform: string;
  arch: string;
  /** One paragraph for a human: what happened and what LUCID did about it. */
  summary: string;
  events: IncidentEvent[];
  processes?: IncidentProcess[];
  /** Raw log tails. Redacted and clipped here; never included in the prefilled issue. */
  logs?: { name: string; text: string }[];
  /** The user's home directory, replaced with "~" everywhere so paths do not carry the account name. */
  home?: string;
}

export interface Incident {
  id: string;
  createdAt: number;
  kind: IncidentKind;
  outcome: IncidentOutcome;
  /** The full redacted report (summary, timeline, processes, log tails). */
  markdown: string;
  issueTitle: string;
  /** Summary-only body for the public issue tracker: no log text. */
  issueBody: string;
}

/** Log tails are clipped to this many characters each, newest text kept. */
export const LOG_TAIL_CHARS = 12_000;
/** GitHub rejects very long new-issue URLs; the prefilled body is clipped well under the limit. */
export const ISSUE_BODY_MAX = 5_500;

// Ordered most-specific first. Each rule keeps the label and burns the value, so a line stays
// diagnosable ("auth header present, 401") without carrying the credential. Mirrors
// tools/collect-support-logs.ps1 $RedactRules, plus e-mail and long-hex rules.
const RULES: Array<[RegExp, string]> = [
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1<redacted>"],
  [/(x-api-key\s*[:=]\s*)["']?[A-Za-z0-9._~+/=-]{8,}/gi, "$1<redacted>"],
  [/sk-[A-Za-z0-9._-]{8,}/g, "sk-<redacted>"],
  [/gh[pousr]_[A-Za-z0-9]{12,}/g, "gh_<redacted>"],
  [/xox[abps]-[A-Za-z0-9-]{10,}/g, "xox-<redacted>"],
  [/AIza[A-Za-z0-9_-]{20,}/g, "AIza<redacted>"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, "<redacted-jwt>"],
  [/("?(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|client[_-]?secret|authorization)"?\s*[:=]\s*)["']?[^"'\s,;}\]]{8,}/gi, "$1<redacted>"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<redacted-email>"],
  [/\b[0-9a-f]{40,}\b/gi, "<hex>"],
  // Any profile path the home replacement did not cover (another account, a service profile, a path
  // quoted from a different machine): keep the shape, drop the account name.
  [/([A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/))[^\\/\s"'`]+/gi, "$1<user>"],
  [/(\/(?:home|Users)\/)[^/\s"'`]+/g, "$1<user>"],
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Burn secrets and the home path out of `text`. Idempotent. */
export function redact(text: string, home?: string): string {
  let out = String(text ?? "");
  if (home && home.length > 3) {
    // Both separators: logs quote Windows paths raw, JSON-escaped (\\), and forward-slashed.
    const variants = new Set([home, home.replace(/\\/g, "/"), home.replace(/\\/g, "\\\\")]);
    for (const v of variants) out = out.replace(new RegExp(escapeRegExp(v), "gi"), "~");
  }
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out;
}

function iso(ms: number): string {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : "unknown time";
}

const KIND_TITLE: Record<IncidentKind, string> = {
  "unclean-shutdown": "LUCID did not shut down cleanly last time",
  "leftover-processes": "Processes from a previous LUCID run were still running",
  "session-unrecoverable": "The previous chat session could not be recovered",
  "engine-unreachable": "The LUCID engine stopped answering and was restarted",
  "agent-child-failed": "The agent process for the chat session failed",
  "recovery-exhausted": "LUCID stopped retrying automatic recovery",
};

const OUTCOME_TEXT: Record<IncidentOutcome, string> = {
  recovered: "Recovered automatically",
  "not-recovered": "Could not recover automatically",
  pending: "Recovery in progress",
};

/** A short, sortable, collision-resistant id: time plus 4 random base36 chars. */
export function incidentId(now: number, rand: () => number = Math.random): string {
  const stamp = iso(now).replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const suffix = Math.floor(rand() * 36 ** 4).toString(36).padStart(4, "0");
  return `${stamp}-${suffix}`;
}

function summarySection(i: IncidentInput, id: string, now: number, redactFn: (s: string) => string): string[] {
  const lines: string[] = [
    `- Incident: ${id}`,
    `- Kind: ${i.kind}`,
    `- Outcome: ${OUTCOME_TEXT[i.outcome]}`,
    `- Recorded: ${iso(now)}`,
    `- Product: ${redactFn(i.product)} ${redactFn(i.version)}`,
    `- Platform: ${i.platform} ${i.arch}`,
    "",
    redactFn(i.summary.trim()),
    "",
    "### Timeline",
    "",
  ];
  const events = [...i.events].sort((a, b) => a.at - b.at);
  if (!events.length) lines.push("- (no events recorded)");
  for (const e of events) lines.push(`- ${iso(e.at)}: ${redactFn(e.what)}`);
  if (i.processes?.length) {
    lines.push("", "### Processes", "", "| PID | Name | Role | Started | Action |", "| --- | --- | --- | --- | --- |");
    for (const p of i.processes) {
      const cell = (s: string) => redactFn(s).replace(/\|/g, "/");
      lines.push(`| ${p.pid} | ${cell(p.name)} | ${cell(p.role)} | ${cell(p.startedAt ?? "unknown")} | ${p.action} |`);
    }
  }
  return lines;
}

/** Build the report. Everything user-visible passes through redact(); log tails are clipped.
 *  `fixedId` rebuilds an existing incident (an outcome update) under its original id. */
export function buildIncident(i: IncidentInput, now: number = Date.now(), rand: () => number = Math.random, fixedId?: string): Incident {
  const id = fixedId ?? incidentId(now, rand);
  const r = (s: string) => redact(s, i.home);
  const title = KIND_TITLE[i.kind];
  const summary = summarySection(i, id, now, r);

  const md: string[] = [`# ${title}`, "", ...summary];
  for (const log of i.logs ?? []) {
    const full = r(log.text ?? "");
    const tail = full.length > LOG_TAIL_CHARS
      ? `[... ${full.length - LOG_TAIL_CHARS} earlier characters omitted ...]\n${full.slice(-LOG_TAIL_CHARS)}`
      : full;
    const body = tail.replace(/```/g, "'''");
    md.push("", `### ${r(log.name)} (tail, redacted)`, "", "```text", body, "```");
  }
  md.push(
    "",
    "---",
    "Secrets, e-mail addresses, long tokens and your home folder were removed before this file was written.",
    "Prompts, chat transcripts, settings and credential stores are never included. Review it before sharing.",
  );

  const issue: string[] = [
    `**What happened:** ${title}.`,
    "",
    ...summary,
    "",
    "_Filed from LUCID's recovery notice. The full redacted report (with log tails) was saved on the reporter's machine and is not included here. Maintainers can ask for it._",
  ];
  let issueBody = issue.join("\n");
  if (issueBody.length > ISSUE_BODY_MAX) issueBody = `${issueBody.slice(0, ISSUE_BODY_MAX)}\n\n_[summary clipped]_`;

  return {
    id,
    createdAt: now,
    kind: i.kind,
    outcome: i.outcome,
    markdown: md.join("\n") + "\n",
    issueTitle: `[incident] ${title} (${OUTCOME_TEXT[i.outcome].toLowerCase()}, ${r(i.version)})`,
    issueBody,
  };
}

/** The prefilled new-issue URL. https only, fixed host, so it can go through openExternalHttp. */
export function issueUrl(inc: Pick<Incident, "issueTitle" | "issueBody">, repo: string = INCIDENT_REPO): string {
  const q = new URLSearchParams({ title: inc.issueTitle, body: inc.issueBody, labels: "incident" });
  return `https://github.com/${repo}/issues/new?${q.toString()}`;
}
