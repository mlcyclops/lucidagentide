// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/tools/artifact_primitives.ts - P-CAP.1a (ADR-0589): find, lookup, count and slice over a stored tool result.
// P-CAP.1b (ADR-0590) adds track: apply the artifact's events, in order, to a state.
//
// omp keeps any tool result over its window as a session artifact and shows the model a head and a tail
// (ADR-0578, ADR-0579). To use the middle, a model had to page through it with `read artifact://N`, which
// spends the context the window was meant to save, and a small model loses the thread long before the
// needle. These four primitives do the mechanical part in code: the model names what it wants, the answer
// comes back as a few lines with their line numbers, and the 500 KB never enters its context.
//
// This is the code side of the paper's finding (arXiv 2611.10463): exact search, keyed lookup, counting and
// slicing are jobs for a program, and a model that delegates them does far better on long inputs than one
// that reads.
//
// RULES EVERY PRIMITIVE KEEPS
//   - No model call, no network, no file access: text in, text out. Same input, same output.
//   - Bounded output, whatever the artifact's size, with a plain note when something was left out and how
//     to get it.
//   - RECORD IDENTITY: every line returned carries its 1-based line number (and a column when the line is
//     long), so a later slice or a citation points at the same record.
//   - "Not found" is always stated. An empty result is never a silent success.
//   - A pattern from a model is hostile input: bounded in length, applied one line at a time to a bounded
//     prefix of the line, under a time budget.
//
// Pure, and without imports. The omp tools are registered in ../omp/artifact_tools_extension.ts.

export const PRIM_LIMITS = {
  /** Characters of a search pattern. */
  pattern: 300,
  /** Keys in one lookup, and characters of a key. */
  keys: 20,
  key: 200,
  /** Matches shown by one find, records shown per key by one lookup. */
  matches: 40,
  perKey: 5,
  /** Lines of context each side of a match. */
  context: 5,
  /** Characters of a line shown; a longer line is shown as an excerpt around the match. */
  excerpt: 240,
  /** Characters of a line a REGEX is applied to (a literal pattern searches the whole line). */
  regexLine: 4000,
  /** Lines returned by one slice. */
  slice: 400,
  /** Characters of any one result. */
  out: 12_000,
  /** Distinct values listed by a count. */
  distinct: 25,
  /** Wall-clock budget for one call, in milliseconds. */
  budgetMs: 2000,
} as const;

export type PrimResult = { ok: true; text: string } | { ok: false; error: string };

/** PURE: the omp artifact id in a handle written as `artifact://<number>`, or null. Only that spelling is
 *  accepted, on purpose: the re-entry gate (ADR-0578) recognizes an external artifact by that string in a
 *  tool's input, so a handle it would not see is refused here instead of slipping past it. */
export function parseHandle(v: unknown): string | null {
  const m = typeof v === "string" ? /^\s*artifact:\/\/(\d{1,9})\s*$/.exec(v) : null;
  return m ? m[1]! : null;
}

/** PURE: the lines of an artifact. A trailing newline does not make an empty last line. */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const fmt = (n: number): string => n.toLocaleString("en-US");
function cap(text: string, max: number = PRIM_LIMITS.out): string {
  return text.length > max ? `${text.slice(0, max)}\n[cut: this result was ${fmt(text.length)} characters; narrow the request]` : text;
}
function intIn(v: unknown, lo: number, hi: number, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.trunc(v))) : dflt;
}

/** One line for output: whole when short, else an excerpt around `col` with the column stated. */
function show(line: string, col = 0): string {
  if (line.length <= PRIM_LIMITS.excerpt) return line;
  const start = Math.max(0, Math.min(col - Math.floor(PRIM_LIMITS.excerpt / 3), line.length - PRIM_LIMITS.excerpt));
  const piece = line.slice(start, start + PRIM_LIMITS.excerpt);
  return `${start > 0 ? "[...]" : ""}${piece}${start + PRIM_LIMITS.excerpt < line.length ? `[... ${fmt(line.length - start - PRIM_LIMITS.excerpt)} more characters]` : ""}`;
}
function tag(n: number, line: string, col: number): string {
  return line.length > PRIM_LIMITS.excerpt ? `L${n}:C${col + 1}` : `L${n}`;
}

export interface PatternOptions { pattern?: unknown; regex?: unknown; ignoreCase?: unknown }
type Matcher = (line: string) => { index: number; text: string }[];

/** PURE: a matcher for a model-supplied pattern, or why it is refused. Literal by default. */
export function buildMatcher(o: PatternOptions): { ok: true; match: Matcher; label: string } | { ok: false; error: string } {
  const pattern = typeof o.pattern === "string" ? o.pattern : "";
  if (pattern === "") return { ok: false, error: "a pattern is required" };
  if (pattern.length > PRIM_LIMITS.pattern) return { ok: false, error: `the pattern is ${pattern.length} characters; the limit is ${PRIM_LIMITS.pattern}` };
  if (/[\r\n]/.test(pattern)) return { ok: false, error: "a pattern is matched one line at a time and cannot contain a line break" };
  const ignoreCase = o.ignoreCase === true;
  if (o.regex === true) {
    let re: RegExp;
    try { re = new RegExp(pattern, ignoreCase ? "giu" : "gu"); } catch (e) { return { ok: false, error: `the regular expression is not valid: ${String((e as { message?: unknown })?.message ?? e).slice(0, 160)}` }; }
    return {
      ok: true,
      label: `regex /${pattern}/${ignoreCase ? "i" : ""}`,
      match(line) {
        const hits: { index: number; text: string }[] = [];
        const hay = line.length > PRIM_LIMITS.regexLine ? line.slice(0, PRIM_LIMITS.regexLine) : line;
        re.lastIndex = 0;
        for (let m = re.exec(hay); m; m = re.exec(hay)) {
          hits.push({ index: m.index, text: m[1] ?? m[0] });
          if (m[0] === "") re.lastIndex += 1; // an empty match must still advance
          if (hits.length >= 1000) break;
        }
        return hits;
      },
    };
  }
  const needle = ignoreCase ? pattern.toLowerCase() : pattern;
  return {
    ok: true,
    label: `"${pattern}"${ignoreCase ? " (any case)" : ""}`,
    match(line) {
      const hits: { index: number; text: string }[] = [];
      const hay = ignoreCase ? line.toLowerCase() : line;
      for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
        hits.push({ index: at, text: line.slice(at, at + needle.length) });
        if (hits.length >= 1000) break;
      }
      return hits;
    },
  };
}

/** A clock a caller can replace in tests. */
export type Clock = () => number;
const TOO_SLOW = "the search took too long and was stopped; use a literal pattern, or a narrower one";

export interface FindOptions extends PatternOptions { context?: unknown; limit?: unknown; offset?: unknown }

/** PURE: the lines that match a pattern, each with its line number, and context lines when asked. */
export function findIn(lines: readonly string[], o: FindOptions, now: Clock = Date.now): PrimResult {
  const m = buildMatcher(o);
  if (!m.ok) return m;
  const context = intIn(o.context, 0, PRIM_LIMITS.context, 0);
  const limit = intIn(o.limit, 1, PRIM_LIMITS.matches, PRIM_LIMITS.matches);
  const offset = intIn(o.offset, 0, Number.MAX_SAFE_INTEGER, 0);
  const started = now();
  const hits: { line: number; col: number }[] = [];
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    if ((i & 1023) === 0 && now() - started > PRIM_LIMITS.budgetMs) return { ok: false, error: TOO_SLOW };
    const found = m.match(lines[i]!);
    if (found.length === 0) continue;
    if (total >= offset && hits.length < limit) hits.push({ line: i, col: found[0]!.index });
    total += 1;
  }
  if (total === 0) return { ok: true, text: `NOT FOUND: no line of ${fmt(lines.length)} matches ${m.label}.` };
  if (hits.length === 0) return { ok: true, text: `${fmt(total)} lines match ${m.label}, and offset ${fmt(offset)} is past the last one.` };
  const out = [`${fmt(total)} of ${fmt(lines.length)} lines match ${m.label}. Showing matches ${fmt(offset + 1)} to ${fmt(offset + hits.length)}.`];
  let lastShown = -1;
  for (const h of hits) {
    const from = Math.max(0, h.line - context, lastShown + 1);
    const to = Math.min(lines.length - 1, h.line + context);
    if (context > 0 && lastShown >= 0 && from > lastShown + 1) out.push("--");
    for (let i = from; i <= to; i++) {
      if (i === h.line) out.push(`${tag(i + 1, lines[i]!, h.col)}: ${show(lines[i]!, h.col)}`);
      else out.push(`L${i + 1}| ${show(lines[i]!)}`);
    }
    lastShown = Math.max(lastShown, to);
  }
  if (offset + hits.length < total) out.push(`${fmt(total - offset - hits.length)} more matching lines: call again with offset ${offset + hits.length}.`);
  return { ok: true, text: cap(out.join("\n")) };
}

const WORD = /[A-Za-z0-9_-]/;

/** PURE: every position where `key` stands as a whole token in `line` (not inside a longer word, number or
 *  hyphenated name), so a lookup of `alpha-7` does not return `alpha-77` or `x-alpha-7`. */
export function tokenHits(line: string, key: string): number[] {
  const hits: number[] = [];
  for (let at = line.indexOf(key); at >= 0; at = line.indexOf(key, at + 1)) {
    const before = at > 0 ? line[at - 1]! : "";
    const after = at + key.length < line.length ? line[at + key.length]! : "";
    if ((before === "" || !WORD.test(before)) && (after === "" || !WORD.test(after))) hits.push(at);
  }
  return hits;
}

export interface LookupOptions { keys?: unknown }

/** PURE: for each key, the records in which it stands as a whole token. One pass over the artifact for all
 *  keys. A key that is nowhere is reported as NOT FOUND. */
export function lookupIn(lines: readonly string[], o: LookupOptions, now: Clock = Date.now): PrimResult {
  const raw = Array.isArray(o.keys) ? o.keys : typeof o.keys === "string" ? [o.keys] : [];
  const keys: string[] = [];
  for (const k of raw) {
    const key = typeof k === "string" ? k.trim() : typeof k === "number" ? String(k) : "";
    if (key === "" || /[\r\n]/.test(key)) return { ok: false, error: "every key must be a non-empty single line of text" };
    if (key.length > PRIM_LIMITS.key) return { ok: false, error: `a key is ${key.length} characters; the limit is ${PRIM_LIMITS.key}` };
    if (!keys.includes(key)) keys.push(key);
  }
  if (keys.length === 0) return { ok: false, error: "at least one key is required" };
  if (keys.length > PRIM_LIMITS.keys) return { ok: false, error: `${keys.length} keys were given; the limit is ${PRIM_LIMITS.keys} in one call` };
  const started = now();
  const found = new Map<string, { line: number; col: number }[]>(keys.map((k) => [k, []]));
  const counts = new Map<string, number>(keys.map((k) => [k, 0]));
  for (let i = 0; i < lines.length; i++) {
    if ((i & 1023) === 0 && now() - started > PRIM_LIMITS.budgetMs) return { ok: false, error: TOO_SLOW };
    const line = lines[i]!;
    for (const k of keys) {
      if (!line.includes(k)) continue;
      const at = tokenHits(line, k);
      if (at.length === 0) continue;
      counts.set(k, counts.get(k)! + 1);
      const list = found.get(k)!;
      if (list.length < PRIM_LIMITS.perKey) list.push({ line: i, col: at[0]! });
    }
  }
  const out: string[] = [];
  const missing = keys.filter((k) => counts.get(k) === 0);
  for (const k of keys) {
    const n = counts.get(k)!;
    if (n === 0) { out.push(`key "${k}": NOT FOUND in ${fmt(lines.length)} lines.`); continue; }
    out.push(`key "${k}": ${fmt(n)} ${n === 1 ? "record" : "records"}${n > PRIM_LIMITS.perKey ? ` (first ${PRIM_LIMITS.perKey} shown)` : ""}`);
    for (const h of found.get(k)!) out.push(`${tag(h.line + 1, lines[h.line]!, h.col)}: ${show(lines[h.line]!, h.col)}`);
  }
  out.unshift(`${keys.length - missing.length} of ${keys.length} keys found.`);
  return { ok: true, text: cap(out.join("\n")) };
}

export interface CountOptions extends PatternOptions { distinct?: unknown }

/** PURE: how many times a pattern occurs and on how many lines. With `distinct`, the values that matched
 *  (the first capture group of a regex, else the whole match), most frequent first. */
export function countIn(lines: readonly string[], o: CountOptions, now: Clock = Date.now): PrimResult {
  const m = buildMatcher(o);
  if (!m.ok) return m;
  const started = now();
  let occurrences = 0;
  let matchedLines = 0;
  let first = -1;
  let last = -1;
  const values = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    if ((i & 1023) === 0 && now() - started > PRIM_LIMITS.budgetMs) return { ok: false, error: TOO_SLOW };
    const found = m.match(lines[i]!);
    if (found.length === 0) continue;
    matchedLines += 1;
    occurrences += found.length;
    if (first < 0) first = i;
    last = i;
    if (o.distinct === true) for (const f of found) { if (values.size < 5000 || values.has(f.text)) values.set(f.text, (values.get(f.text) ?? 0) + 1); }
  }
  if (occurrences === 0) return { ok: true, text: `0: nothing in ${fmt(lines.length)} lines matches ${m.label}.` };
  const out = [`${fmt(occurrences)} ${occurrences === 1 ? "occurrence" : "occurrences"} of ${m.label} on ${fmt(matchedLines)} of ${fmt(lines.length)} lines (first on L${first + 1}, last on L${last + 1}).`];
  if (o.distinct === true) {
    const sorted = [...values.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    out.push(`${fmt(sorted.length)} distinct ${sorted.length === 1 ? "value" : "values"}${sorted.length > PRIM_LIMITS.distinct ? ` (top ${PRIM_LIMITS.distinct} shown)` : ""}:`);
    for (const [v, n] of sorted.slice(0, PRIM_LIMITS.distinct)) out.push(`${fmt(n)}x ${show(v)}`);
  }
  return { ok: true, text: cap(out.join("\n")) };
}

export interface SliceOptions { from?: unknown; to?: unknown }

/** PURE: lines `from` to `to` (1-based, both included), each with its number. */
export function sliceOf(lines: readonly string[], o: SliceOptions): PrimResult {
  const total = lines.length;
  if (typeof o.from !== "number" || !Number.isFinite(o.from)) return { ok: false, error: "from is required: the first line to return, counting from 1" };
  const from = Math.trunc(o.from);
  const to = typeof o.to === "number" && Number.isFinite(o.to) ? Math.trunc(o.to) : from + 39;
  if (from < 1 || from > total) return { ok: false, error: `from is ${from}, and the artifact has lines 1 to ${fmt(total)}` };
  if (to < from) return { ok: false, error: `to (${to}) is before from (${from})` };
  const end = Math.min(total, to, from + PRIM_LIMITS.slice - 1);
  const out = [`Lines ${fmt(from)} to ${fmt(end)} of ${fmt(total)}.`];
  for (let i = from; i <= end; i++) out.push(`L${i}: ${show(lines[i - 1]!)}`);
  if (end < Math.min(total, to)) out.push(`${fmt(Math.min(total, to) - end)} more lines were asked for: call again with from ${end + 1} (at most ${PRIM_LIMITS.slice} lines a call).`);
  return { ok: true, text: cap(out.join("\n")) };
}

export interface TrackOptions { pattern?: unknown; ignoreCase?: unknown; mode?: unknown; keys?: unknown; follow?: unknown }
export const TRACK_MODES = ["last", "sum", "count"] as const;
export type TrackMode = (typeof TRACK_MODES)[number];
/** Distinct keys one call will hold state for, and keys it lists. */
export const TRACK_LIMITS = { state: 20_000, shown: 40 } as const;

/** PURE: apply the artifact's events, in order, to a state, and report where each key ended up.
 *
 *  An event is a match of `pattern`, a regular expression with a named group `key` and, except in `count`
 *  mode, a named group `value`. Events are applied top to bottom, and left to right on a line.
 *    last   the value each key was last set to (the default)
 *    sum    the running total of each key's numeric values
 *    count  how many events each key had
 *  With `follow` (mode last), a value that is the name of another key takes that key's value at that
 *  moment, so `b = a` after `a = 5` leaves b at 5.
 *
 *  This is the job a model does worst by reading: holding state across thousands of lines. */
export function trackIn(lines: readonly string[], o: TrackOptions, now: Clock = Date.now): PrimResult {
  const pattern = typeof o.pattern === "string" ? o.pattern : "";
  if (pattern === "") return { ok: false, error: "a pattern is required: a regular expression with a named group (?<key>...) and, unless mode is count, (?<value>...)" };
  if (pattern.length > PRIM_LIMITS.pattern) return { ok: false, error: `the pattern is ${pattern.length} characters; the limit is ${PRIM_LIMITS.pattern}` };
  if (/[\r\n]/.test(pattern)) return { ok: false, error: "a pattern is matched one line at a time and cannot contain a line break" };
  const mode = TRACK_MODES.find((m) => m === (o.mode ?? "last"));
  if (!mode) return { ok: false, error: `mode must be one of ${TRACK_MODES.join(", ")}` };
  if (!pattern.includes("(?<key>")) return { ok: false, error: "the pattern needs a named group (?<key>...) that captures what the event is about" };
  if (mode !== "count" && !pattern.includes("(?<value>")) return { ok: false, error: `mode ${mode} needs a named group (?<value>...) that captures the new value` };
  let re: RegExp;
  try { re = new RegExp(pattern, o.ignoreCase === true ? "giu" : "gu"); } catch (e) { return { ok: false, error: `the regular expression is not valid: ${String((e as { message?: unknown })?.message ?? e).slice(0, 160)}` }; }
  const rawKeys = Array.isArray(o.keys) ? o.keys : typeof o.keys === "string" ? [o.keys] : [];
  const wanted: string[] = [];
  for (const k of rawKeys) {
    const key = typeof k === "string" ? k.trim() : typeof k === "number" ? String(k) : "";
    if (key === "" || key.length > PRIM_LIMITS.key) return { ok: false, error: `every key must be non-empty and at most ${PRIM_LIMITS.key} characters` };
    if (!wanted.includes(key)) wanted.push(key);
  }
  if (wanted.length > PRIM_LIMITS.keys) return { ok: false, error: `${wanted.length} keys were given; the limit is ${PRIM_LIMITS.keys} in one call` };
  const follow = o.follow === true && mode === "last";

  interface State { value: string; total: number; events: number; skipped: number; first: number; last: number }
  const state = new Map<string, State>();
  const started = now();
  let events = 0;
  for (let i = 0; i < lines.length; i++) {
    if ((i & 1023) === 0 && now() - started > PRIM_LIMITS.budgetMs) return { ok: false, error: TOO_SLOW };
    const line = lines[i]!;
    const hay = line.length > PRIM_LIMITS.regexLine ? line.slice(0, PRIM_LIMITS.regexLine) : line;
    re.lastIndex = 0;
    for (let m = re.exec(hay), guard = 0; m && guard < 1000; m = re.exec(hay), guard++) {
      if (m[0] === "") re.lastIndex += 1;
      const key = (m.groups?.key ?? "").trim();
      if (key === "") continue;
      let s = state.get(key);
      if (!s) {
        if (state.size >= TRACK_LIMITS.state) return { ok: false, error: `the pattern produced more than ${fmt(TRACK_LIMITS.state)} distinct keys; narrow the pattern` };
        s = { value: "", total: 0, events: 0, skipped: 0, first: i, last: i };
        state.set(key, s);
      }
      events += 1;
      s.events += 1;
      s.last = i;
      const raw = (m.groups?.value ?? "").trim();
      if (mode === "last") s.value = follow && state.has(raw) && raw !== key ? state.get(raw)!.value : raw;
      else if (mode === "sum") {
        const n = Number(raw.replace(/,/g, ""));
        if (raw !== "" && Number.isFinite(n)) s.total += n; else s.skipped += 1;
      }
    }
  }
  if (events === 0) return { ok: true, text: `NO EVENTS: nothing in ${fmt(lines.length)} lines matches regex /${pattern}/.` };
  const out = [`${fmt(events)} events over ${fmt(state.size)} ${state.size === 1 ? "key" : "keys"} in ${fmt(lines.length)} lines, applied in order (mode ${mode}${follow ? ", following names" : ""}).`];
  const report = (key: string): void => {
    const s = state.get(key);
    if (!s) { out.push(`key "${show(key)}": NO EVENTS.`); return; }
    const where = s.events === 1 ? `on L${s.first + 1}` : `first on L${s.first + 1}, last on L${s.last + 1}`;
    if (mode === "last") out.push(`key "${show(key)}": ${show(s.value)} after ${fmt(s.events)} ${s.events === 1 ? "update" : "updates"} (${where})`);
    else if (mode === "sum") out.push(`key "${show(key)}": ${fmt(Number(s.total.toFixed(6)))} from ${fmt(s.events - s.skipped)} ${s.events - s.skipped === 1 ? "event" : "events"} (${where})${s.skipped ? `; ${fmt(s.skipped)} skipped as not a number` : ""}`);
    else out.push(`key "${show(key)}": ${fmt(s.events)} ${s.events === 1 ? "event" : "events"} (${where})`);
  };
  if (wanted.length > 0) for (const k of wanted) report(k);
  else {
    const all = [...state.keys()];
    for (const k of all.slice(0, TRACK_LIMITS.shown)) report(k);
    if (all.length > TRACK_LIMITS.shown) out.push(`${fmt(all.length - TRACK_LIMITS.shown)} more keys: name the ones you want in keys.`);
  }
  return { ok: true, text: cap(out.join("\n")) };
}

export type PrimName = "artifact_find" | "artifact_lookup" | "artifact_count" | "artifact_slice" | "artifact_track";
export const PRIM_NAMES: readonly PrimName[] = ["artifact_find", "artifact_lookup", "artifact_count", "artifact_slice", "artifact_track"];

/** PURE: run one primitive over an artifact's text. */
export function runPrim(name: PrimName, text: string, params: Record<string, unknown>, now: Clock = Date.now): PrimResult {
  const lines = splitLines(text);
  if (name === "artifact_find") return findIn(lines, params, now);
  if (name === "artifact_lookup") return lookupIn(lines, params, now);
  if (name === "artifact_count") return countIn(lines, params, now);
  if (name === "artifact_track") return trackIn(lines, params, now);
  return sliceOf(lines, params);
}

/** PURE: the first line of every result: which artifact, how big, where it came from and how far to trust it. */
export function primHeader(id: string, text: string, source: string, trust: string): string {
  return `artifact://${id}: ${fmt(splitLines(text).length)} lines, ${fmt(text.length)} characters. Source: ${source}. Trust: ${trust}.`;
}
