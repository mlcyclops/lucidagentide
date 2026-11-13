// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-HERD-OSC.1 (ADR-0536) - the Program Status Protocol, OSC 7501, as a pure report builder.
//
// Spec: https://www.superlogical.com/rex/docs/build/program-status (revision 0.4). A report is
// `ESC ] 7501 ; key=value(:key=value)* ESC \`; a terminal that supports it (Herdr, Ghostty, Rex)
// keeps one record per id and shows what the program is doing. A terminal DISCARDS a whole report
// that breaks any rule, so this builder refuses instead of emitting something a terminal would drop
// silently: every field is checked against the spec's grammar and limits before a byte is built.
// Free text (title, msg) is base64 of single-line UTF-8; `cleanStatusText` is the caller's way to
// turn arbitrary text into text the builder accepts (controls become spaces, bytes cut to the cap).

/** The record states. `clear` is not a state: it removes the addressed record and every record
 *  beneath it, or with no id every record on the terminal. */
export type ProgramState = "idle" | "working" | "done" | "blocked" | "error";
export type ProgramKind = "permission" | "question" | "auth";

export interface ProgramStatusReport {
  state: ProgramState | "clear";
  /** Record path, segments `[A-Za-z0-9_.+-]{1,32}` joined by `/`. Absent = the root record. */
  id?: string;
  /** What a blocked record waits for. Only with `state: "blocked"`. */
  kind?: ProgramKind;
  /** Integer 0..100. Only with `working` or `blocked`; absent = indeterminate. */
  progress?: number;
  /** Stable program identifier, `[A-Za-z0-9_.+-]{1,32}`. */
  app?: string;
  /** Short label, single-line UTF-8, at most 192 bytes. */
  title?: string;
  /** One human-readable line, single-line UTF-8, at most 2048 bytes. */
  msg?: string;
}

export type ProgramStatusResult = { ok: true; seq: string } | { ok: false; error: string };

export const OSC_7501_PREFIX = "\x1b]7501;";
/** String terminator `ESC \` (the spec also allows BEL; ST is the unambiguous one). */
export const OSC_ST = "\x1b\\";
/** `state=clear` with no id: removes every record on the terminal. */
export const CLEAR_ALL_PROGRAM_STATUS = `${OSC_7501_PREFIX}state=clear${OSC_ST}`;

export const LIMITS = {
  sequence: 4096,
  title: 192,
  msg: 2048,
  app: 32,
  id: 128,
  segment: 32,
  depth: 8,
} as const;

const STATES: readonly string[] = ["idle", "working", "done", "blocked", "error", "clear"];
const KINDS: readonly string[] = ["permission", "question", "auth"];
const SEGMENT = /^[A-Za-z0-9_.+-]{1,32}$/;
// The spec's control set: C0, DEL and C1.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]+/g;

const utf8Bytes = (s: string): number => Buffer.byteLength(s, "utf8");

/** Does `id` match the spec's record path grammar and size limits? */
export function validStatusId(id: string): boolean {
  if (utf8Bytes(id) > LIMITS.id) return false;
  const segments = id.split("/");
  return segments.length <= LIMITS.depth && segments.every((s) => SEGMENT.test(s));
}

/** Arbitrary text to text the builder accepts: every run of control characters (newline, tab, ESC,
 *  C1 ...) becomes one space, a lone surrogate becomes U+FFFD, the ends are trimmed, and the UTF-8 is
 *  cut at a code point boundary so it fits `maxBytes`. */
export function cleanStatusText(text: string, maxBytes: number): string {
  const flat = text.toWellFormed().replace(CONTROLS, " ").trim();
  if (utf8Bytes(flat) <= maxBytes) return flat;
  let out = "";
  let used = 0;
  for (const ch of flat) {
    const n = utf8Bytes(ch);
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return out.trimEnd();
}

function textField(name: "title" | "msg", text: string, max: number): string | null {
  if (CONTROL.test(text)) return `${name} contains a control character`;
  if (!text.isWellFormed()) return `${name} is not well-formed UTF-16 (lone surrogate)`;
  if (utf8Bytes(text) > max) return `${name} is ${utf8Bytes(text)} bytes; the limit is ${max}`;
  return null;
}

/** Build one OSC 7501 report, or refuse with the reason. The sequence is all ASCII, so its string
 *  length is its byte length. Key order: state, kind, id, title, progress, app, msg. */
export function buildProgramStatus(r: ProgramStatusReport): ProgramStatusResult {
  const fail = (error: string): ProgramStatusResult => ({ ok: false, error });
  if (!STATES.includes(r.state)) return fail(`unknown state "${String(r.state)}"`);
  const pairs = [`state=${r.state}`];
  if (r.state === "clear") {
    for (const key of ["kind", "progress", "app", "title", "msg"] as const)
      if (r[key] !== undefined) return fail(`clear takes only an id, not ${key}`);
  }
  if (r.kind !== undefined) {
    if (r.state !== "blocked") return fail("kind is only for state blocked");
    if (!KINDS.includes(r.kind)) return fail(`unknown kind "${String(r.kind)}"`);
    pairs.push(`kind=${r.kind}`);
  }
  if (r.id !== undefined) {
    if (!validStatusId(r.id)) return fail(`id "${r.id}" breaks the grammar (segments [A-Za-z0-9_.+-]{1,32}, 8 levels, 128 bytes)`);
    pairs.push(`id=${r.id}`);
  }
  if (r.title !== undefined) {
    const bad = textField("title", r.title, LIMITS.title);
    if (bad) return fail(bad);
    pairs.push(`title=${Buffer.from(r.title, "utf8").toString("base64")}`);
  }
  if (r.progress !== undefined) {
    if (r.state !== "working" && r.state !== "blocked") return fail("progress is only for state working or blocked");
    if (!Number.isInteger(r.progress) || r.progress < 0 || r.progress > 100) return fail(`progress ${r.progress} is not an integer 0..100`);
    pairs.push(`progress=${r.progress}`);
  }
  if (r.app !== undefined) {
    if (!SEGMENT.test(r.app)) return fail(`app "${r.app}" is not [A-Za-z0-9_.+-]{1,32}`);
    pairs.push(`app=${r.app}`);
  }
  if (r.msg !== undefined) {
    const bad = textField("msg", r.msg, LIMITS.msg);
    if (bad) return fail(bad);
    pairs.push(`msg=${Buffer.from(r.msg, "utf8").toString("base64")}`);
  }
  const seq = `${OSC_7501_PREFIX}${pairs.join(":")}${OSC_ST}`;
  if (seq.length > LIMITS.sequence) return fail(`report is ${seq.length} bytes; the limit is ${LIMITS.sequence}`);
  return { ok: true, seq };
}
