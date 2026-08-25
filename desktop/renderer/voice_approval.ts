// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/voice_approval.ts - P-AVATAR.5 (ADR-0251): approving tool calls by voice.
//
// PURE + fail-closed, because a mishearing must never run a command (invariant #3 spirit):
//   - The whole utterance must EXACTLY match a short allowlisted phrase after normalization - a sentence
//     that merely contains "approve" matches nothing.
//   - DANGER-class requests (high-risk exec / egress marked danger) accept ONLY the literal word
//     "approve" (or "approve it" / "i approve") AFTER the prompt read the command aloud (the repeat-back);
//     a bare "yes" on a dangerous request re-prompts, it never fires.
//   - Voice can only ever pick the NARROWEST allow option - anything smelling of "always" / "don't ask" /
//     whole-session is excluded, so a voice approval can never widen standing permissions.
//   - Denying is easy on purpose: any deny phrase, any class.
//   - No match = the words flow to the composer as ordinary dictation; silence approves nothing (the
//     backend's 300s fail-closed timeout stands untouched). The visual card is always rendered and
//     remains the source of truth.

export interface ApprovalOption { optionId: string; name: string; kind?: string }

export type UtteranceMatch = "approve" | "deny" | "vague-yes" | "none";

const APPROVE_EXACT: readonly string[] = ["approve", "approve it", "i approve", "approved"];
const APPROVE_RELAXED: readonly string[] = [
  ...APPROVE_EXACT, "yes", "yes do it", "do it", "go ahead", "allow", "allow it", "yes please", "confirm", "proceed", "okay do it",
];
const DENY: readonly string[] = [
  "deny", "denied", "no", "nope", "no stop", "stop", "cancel", "cancel it", "reject", "block", "block it", "don't", "do not", "don't do it", "do not do it", "never",
];

/** Normalize an STT transcript to a comparable phrase: lowercase, letters/apostrophes/spaces only. */
export function normalizeUtterance(text: string): string {
  return text.toLowerCase().replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Classify one utterance against the approval grammar. `danger` = the request is high-risk. */
export function matchApprovalUtterance(text: string, danger: boolean): UtteranceMatch {
  const t = normalizeUtterance(text);
  if (!t || t.split(" ").length > 4) return "none"; // real approvals are short; sentences are dictation
  if (DENY.includes(t)) return "deny";
  if (danger) {
    if (APPROVE_EXACT.includes(t)) return "approve";
    if (APPROVE_RELAXED.includes(t)) return "vague-yes"; // "yes" is not enough to run a dangerous command
    return "none";
  }
  return APPROVE_RELAXED.includes(t) ? "approve" : "none";
}

/** The option a voice decision maps to. Allow = the NARROWEST allow (once-style preferred, never an
 *  always/session grant); deny = the reject option. Null = no safe mapping (the card stays the path). */
export function pickOption(options: readonly ApprovalOption[], want: "allow" | "deny"): string | null {
  const hay = (o: ApprovalOption): string => `${o.kind ?? ""} ${o.optionId} ${o.name}`.toLowerCase();
  if (want === "deny") {
    const rej = options.find((o) => o.kind === "reject") ?? options.find((o) => /reject|deny|block|\bno\b|refuse/.test(hay(o)));
    return rej?.optionId ?? null;
  }
  const widening = (o: ApprovalOption): boolean => /always|don't ask|dont ask|session|every time|forever/.test(hay(o));
  const allows = options.filter((o) => /allow|approve|grant|accept|yes|once|this turn/.test(hay(o)) && o.kind !== "reject" && !widening(o));
  if (!allows.length) return null;
  // Narrowest first: a "once" grant beats a "this turn" grant beats a plain allow.
  const once = allows.find((o) => /once/.test(hay(o)));
  const turn = allows.find((o) => /this turn|turn/.test(hay(o)));
  return (once ?? turn ?? allows[0]!).optionId;
}

/** Trim a command/url to a speakable fragment: single line, word-safe cut, no trailing crumbs. */
export function speakableTarget(raw: string, max = 70): string {
  const one = raw.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max);
  const safe = cut.slice(0, Math.max(20, cut.lastIndexOf(" ")));
  return `${safe}, and more`;
}

/** Just the host of a URL - reading a full path/query aloud is noise. Falls back to the trimmed raw. */
export function speakableHost(raw: string): string {
  try { return new URL(raw).hostname || speakableTarget(raw, 50); } catch { return speakableTarget(raw, 50); }
}

/** A plain-language IMPACT summary of a shell command - reading long technical commands aloud is too
 *  much (user call, 2026-08-01), so the spoken prompt names what the command DOES and its realistic
 *  blast radius instead. Deterministic heuristic over the FIRST pipeline segment; honest and short.
 *  The visual card still shows the exact command (plus the TLDR button for a model explanation). */
export function commandImpact(raw: string): string {
  const one = raw.replace(/\s+/g, " ").trim();
  if (!one) return "runs a command";
  const segments = one.split(/\s*(?:&&|\|\||;)\s*/).filter(Boolean);
  const first = segments[0]!;
  const sudo = /^sudo\s/.test(first);
  const body = first.replace(/^sudo\s+/, "");
  const prog = body.split(" ")[0] ?? "a program";
  let what: string;
  if (/^(curl|wget)\b/.test(body) && /\|\s*(sh|bash|zsh)\b/.test(one)) what = "downloads a script from the internet and executes it";
  else if (/^(rm|rmdir|del)\b/.test(body)) what = /-\w*[rf]/.test(body) ? "force-deletes files or folders" : "deletes files or folders";
  else if (/^(curl|wget|fetch)\b/.test(body)) { const m = /https?:\/\/(\S+)/.exec(body); what = `downloads from ${m ? speakableHost(`https://${m[1]}`) : "the internet"}`; }
  else if (/^git\s+push/.test(body)) what = "pushes commits to the remote repository";
  else if (/^git\s+(reset\s+--hard|checkout|clean)/.test(body)) what = "rewrites the working tree";
  else if (/^git\b/.test(body)) what = "runs a git operation";
  else if (/^(npm|pnpm|yarn|bun)\s+(install|add|i)\b/.test(body) || /^(pip3?|uv)\s+install\b/.test(body) || /^cargo\s+(add|install)\b/.test(body)) what = "installs packages";
  else if (/^make\b/.test(body)) what = /\binstall\b/.test(body) ? "installs software onto this machine" : "builds or tests the project";
  else if (/^(make|cargo|go|npm|pnpm|yarn|bun|pytest|vitest|jest)\b.*\b(build|test|check|run)?/.test(body) && /\b(build|test|check|compile|run)\b/.test(body)) what = "builds or tests the project";
  else if (/^(chmod|chown)\b/.test(body)) what = "changes file permissions or ownership";
  else if (/^(kill|pkill|killall)\b/.test(body)) what = "stops running processes";
  else if (/^(mv|cp)\b/.test(body)) what = "moves or copies files";
  else if (/^docker\b/.test(body)) what = "runs a container operation";
  else what = `runs ${prog}`;
  const extra = segments.length > 1 ? `, then ${segments.length - 1} more step${segments.length > 2 ? "s" : ""}` : "";
  return `${sudo ? "with administrator rights, " : ""}${what}${extra}`;
}

export interface ApprovalPromptInput {
  tool: string; detail?: string; url?: string;
  exec?: boolean; egress?: boolean; localFile?: boolean; danger?: boolean; program?: string;
}

/** The spoken prompt: what it DOES and the realistic impact - never a raw command dump (the card
 *  shows the exact text). Danger still demands the literal word "approve" after hearing the impact. */
export function approvalPrompt(e: ApprovalPromptInput): string {
  if (e.exec) {
    const impact = commandImpact(e.detail ?? "");
    return e.danger
      ? `Permission needed for a high risk command. It ${impact}. Say the word approve to run it, or say deny. The exact command is on screen.`
      : `The agent wants to run a command that ${impact}. Say approve or deny.`;
  }
  if (e.egress) {
    return e.localFile
      ? `The agent wants to open a local file in your browser. Say approve or deny.`
      : `The agent wants to visit ${speakableHost(e.url ?? e.detail ?? "a website")}. Say approve or deny.`;
  }
  return `Permission needed for the ${e.tool} tool${e.detail ? `: ${speakableTarget(e.detail, 60)}` : ""}. Say approve or deny.`;
}
