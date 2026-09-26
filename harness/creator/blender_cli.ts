// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/blender_cli.ts - CREATOR-3 (ADR-0287) item 4: the Blender background-render ARGV builder,
// and the classifier for whatever came back.
//
// ADR-0287 draws a hard line around Blender: authoring stays the USER's Python, running through the normal
// exec-approval path, and LUCID adds no `.py` of its own. This module therefore never writes, generates,
// edits, or inspects script CONTENT. It only ever references a path the caller already had. It does exactly
// two pure things:
//
//   * `blenderRenderArgv` builds a FIXED ARGV for one background render. Nothing is interpolated into a
//     shell string, and a value carrying shell metacharacters is REFUSED rather than escaped, which is the
//     stance `tools/creator-backend/setup-backend.ts` takes for an SSH host and path. Escaping is a guess
//     about which shell will re-parse the value; refusing is a fact.
//   * `classifyBlenderOutput` reads Blender's own report. Its real job is the QUIET failure: exit code 0
//     with nothing saved, which is Blender opening the file, rendering zero frames, and exiting happy.
//
// ARGUMENT ORDER IS SEMANTIC. Blender executes command-line arguments in the order they appear, so `-b`
// must precede the render flags, `--python` must precede the frame flags (or the script runs after the
// render it was meant to set up), and `-f` / `-a` must come LAST. The order below is the documented
// background form and is pinned by a test.
//
// Refusals are VALUES, never exceptions: a caller never has to catch. Pure by construction: no node
// builtins, no fetch, no clock, no randomness, so this runs unchanged in the renderer bundle and in a unit
// test. stdout and stderr arriving here are UNTRUSTED TEXT: patterns to match and capped text to quote
// back, never instructions.
//
// WHAT THE GREEN TEST SUITE DOES NOT PROVE. Nothing here spawns a process, and Blender was not installed on
// the machine where this was written, so no assertion in `blender_cli.test.ts` has ever met a real Blender.
// The suite proves that the argv CONSTRUCTED is the argv intended and that the classifier maps given text to
// the right verdict. It does NOT prove that real Blender accepts this argv, that its real stdout matches the
// samples classified against, or that an exit code treated as success is one. The argument order, the
// `Saved: '<path>'` line, and the `Error:` marker come from Blender's documented command-line behaviour;
// they are NOT fixtures captured from a run. Whoever first points this at an installed Blender should
// re-check all three. The classifier is deliberately conservative for exactly that reason: an unrecognised
// line is never read as success, and exit 0 with nothing saved is a failure rather than a shrug.

// ── the request ─────────────────────────────────────────────────────────────

/** One background render. `frame` XOR `range`: a still or an animation, never both and never neither.
 *  The unions are inline so the exported surface stays exactly what ADR-0287 asked for; a caller that needs
 *  to name one reaches for `BlenderRenderInput["format"]` or `["engine"]`. */
export interface BlenderRenderInput {
  /** The Blender executable. A path, not a shell word. */
  readonly exe: string;
  /** The `.blend` file to open. */
  readonly blend: string;
  /** Blender's `-o` output pattern, e.g. `/out/frame_####`. `#` runs are frame digits. */
  readonly outPattern: string;
  readonly format?: "PNG" | "JPEG" | "OPEN_EXR" | "WEBP";
  /** Render exactly this one frame (`-f`). Mutually exclusive with `range`. */
  readonly frame?: number;
  /** Render start..end inclusive (`-s`/`-e`/`-a`). Mutually exclusive with `frame`. */
  readonly range?: { readonly start: number; readonly end: number };
  /** Scene name inside the blend file (`-S`). */
  readonly scene?: string;
  readonly engine?: "CYCLES" | "BLENDER_EEVEE_NEXT" | "BLENDER_WORKBENCH";
  /** The USER's own `.py`, run with `--python`. LUCID never authors one; this is a path, nothing more. */
  readonly pythonScript?: string;
}

/** The widest animation this builder will ask for, counted INCLUSIVELY (`end - start + 1`). A minute of
 *  film at 60fps. Past this a caller should be splitting the job, not handing Blender an open-ended range. */
export const MAX_BLENDER_FRAMES = 3600;

/** Characters that cannot appear in an argv value LUCID builds for a LOCAL child process: the NUL that
 *  truncates a C string, and the newline, carriage return and other control characters that would smuggle a
 *  second line into Blender's own log (which `classifyBlenderOutput` parses for `Saved:` lines).
 *
 *  THE THREAT MODEL IS ARGV, NOT A SHELL. Blender is spawned with a fixed argument vector, so nothing here
 *  is ever re-parsed by `sh`: refusing a shell metacharacter would be a FALSE REFUSAL, and a false refusal
 *  is as dishonest as a false pass. That is not theoretical. The strict-everywhere version of this guard
 *  rejected `C:\Program Files (x86)\Blender\blender.exe` for its parentheses, which is where Blender
 *  actually installs on a 32-bit-host Windows box, and the same single-regex mistake had already refused a
 *  plain `~/.ssh/id_ed25519` in the remote backend script (fixed there in 1fc47c0 by splitting the two
 *  models apart). A value that WOULD cross a shell belongs behind a strict guard at that boundary, in the
 *  module that owns the boundary; this module has no such boundary. */
export const ARGV_UNSAFE_CHARS = "\0\r\n\t";

/** Readable names, because "contains a forbidden character" does not tell the user which one to remove. */
const CHAR_NAMES: Readonly<Record<string, string>> = {
  "\0": "a NUL byte",
  "\r": "a carriage return",
  "\n": "a newline",
  "\t": "a tab",
};

const FORMATS: readonly string[] = ["PNG", "JPEG", "OPEN_EXR", "WEBP"];
const ENGINES: readonly string[] = ["CYCLES", "BLENDER_EEVEE_NEXT", "BLENDER_WORKBENCH"];

/** How much of a rejected or quoted value we repeat back. An error message is for a human, and the value
 *  in it came from outside. */
const MAX_QUOTED_CHARS = 160;

/** Fold untrusted text into one safe, bounded line: control characters (including the ANSI escape that
 *  could repaint a terminal) become spaces, and the result is clipped. */
function oneLine(value: string, max: number): string {
  let out = "";
  for (const ch of value) {
    // Checked before appending, so a value that exactly fills the cap is not falsely marked as clipped.
    if (out.length >= max) return `${out}...`;
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out;
}

const quoted = (value: string): string => oneLine(value, MAX_QUOTED_CHARS);

/** The first character in a value that cannot ride an argv slot, or "" when the value is clean. The named
 *  set above plus every other control code point, so an ANSI escape or a vertical tab is refused too even
 *  though spelling each one out would not help the user. */
function offendingChar(value: string): string {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ARGV_UNSAFE_CHARS.includes(ch) || code < 0x20 || code === 0x7f) return ch;
  }
  return "";
}

/** A refusal, or null when the value is safe to hand to an argv slot. */
function unsafeArg(label: string, value: string): { ok: false; error: string } | null {
  const bad = offendingChar(value);
  if (!bad) return null;
  const name = CHAR_NAMES[bad] ?? `a control character (code ${bad.codePointAt(0) ?? 0})`;
  return {
    ok: false,
    error: `${label} contains ${name}, which is refused rather than escaped: ${quoted(value)}`,
  };
}

/** A `..` segment lets a path climb out of wherever the caller meant to put it. Refused on sight, on both
 *  path separators, because this argv may be built on Windows and run through a POSIX-ish tool. */
function climbingArg(label: string, value: string): { ok: false; error: string } | null {
  if (!value.split(/[/\\]/).some((seg) => seg === "..")) return null;
  return {
    ok: false,
    error: `${label} contains a ".." segment, which is refused so a path cannot climb out of its directory: ${quoted(value)}`,
  };
}

/** Frame numbers are counts, not measurements: finite, integral, and never negative. */
const isFrameNumber = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

const badFrame = (label: string, n: unknown): { ok: false; error: string } => ({
  ok: false,
  error: `${label} must be a finite non-negative integer, got ${typeof n === "number" ? String(n) : quoted(String(n))}`,
});

// ── the argv ────────────────────────────────────────────────────────────────

/**
 * Build the fixed argv for one background render, or refuse and name the offending value.
 *
 * The order is Blender's documented background form and is load-bearing:
 * `exe -b <blend> -o <out> [-F fmt] [-S scene] [-E engine] [--python script] (-f n | -s a -e b -a)`.
 *
 * `userScript` is true only when the caller supplied a `pythonScript`, and in that case `note` says whose
 * file it is and how it gets to run. LUCID does not write that file and does not read it.
 */
export function blenderRenderArgv(
  input: BlenderRenderInput,
): { ok: true; argv: readonly string[]; userScript: boolean; note: string } | { ok: false; error: string } {
  const { exe, blend, outPattern, format, frame, range, scene, engine, pythonScript } = input;

  // Presence first, then safety. Nothing is trimmed: trimming would quietly swallow a trailing newline,
  // and a trailing newline is exactly the kind of value this builder exists to refuse.
  if (typeof exe !== "string" || exe.trim() === "") {
    return { ok: false, error: "exe is required: name the Blender executable to run." };
  }
  if (typeof blend !== "string" || blend.trim() === "") {
    return { ok: false, error: "blend is required: name the .blend file to render." };
  }
  if (typeof outPattern !== "string" || outPattern.trim() === "") {
    return { ok: false, error: "outPattern is required: Blender needs an -o path to write frames to." };
  }

  for (const [label, value] of [
    ["exe", exe],
    ["blend", blend],
    ["outPattern", outPattern],
    ["scene", scene],
    ["pythonScript", pythonScript],
  ] as const) {
    if (value === undefined) continue;
    if (typeof value !== "string") return { ok: false, error: `${label} must be a string when supplied.` };
    const bad = unsafeArg(label, value);
    if (bad) return bad;
  }

  if (!/\.blend$/i.test(blend)) {
    return { ok: false, error: `blend must be a .blend file: ${quoted(blend)}` };
  }
  if (pythonScript !== undefined && !/\.py$/i.test(pythonScript)) {
    return { ok: false, error: `pythonScript must be a .py file the user already has: ${quoted(pythonScript)}` };
  }

  // `scene` is a name inside the file, not a path, so it is not checked for ".." here.
  for (const [label, value] of [
    ["exe", exe],
    ["blend", blend],
    ["outPattern", outPattern],
    ["pythonScript", pythonScript],
  ] as const) {
    if (value === undefined) continue;
    const bad = climbingArg(label, value);
    if (bad) return bad;
  }

  if (format !== undefined && !FORMATS.includes(format)) {
    return { ok: false, error: `format must be one of ${FORMATS.join(", ")}, got ${quoted(String(format))}` };
  }
  if (engine !== undefined && !ENGINES.includes(engine)) {
    return { ok: false, error: `engine must be one of ${ENGINES.join(", ")}, got ${quoted(String(engine))}` };
  }

  if (frame !== undefined && range !== undefined) {
    return {
      ok: false,
      error: "frame and range cannot both be supplied: a run renders one still or one animation, not both.",
    };
  }
  if (frame === undefined && range === undefined) {
    return {
      ok: false,
      error: "either frame or range must be supplied: with no -f and no -a Blender opens the blend file and renders nothing.",
    };
  }
  if (frame !== undefined && !isFrameNumber(frame)) return badFrame("frame", frame);
  if (range !== undefined) {
    if (typeof range !== "object" || range === null) {
      return { ok: false, error: "range must be an object with a start and an end." };
    }
    if (!isFrameNumber(range.start)) return badFrame("range.start", range.start);
    if (!isFrameNumber(range.end)) return badFrame("range.end", range.end);
    if (range.end < range.start) {
      return { ok: false, error: `range end ${range.end} precedes range start ${range.start}.` };
    }
    const width = range.end - range.start + 1;
    if (width > MAX_BLENDER_FRAMES) {
      return {
        ok: false,
        error: `range ${range.start}..${range.end} covers ${width} frames, over the MAX_BLENDER_FRAMES limit of ${MAX_BLENDER_FRAMES}.`,
      };
    }
  }

  const argv: string[] = [exe, "-b", blend, "-o", outPattern];
  if (format !== undefined) argv.push("-F", format);
  if (scene !== undefined) argv.push("-S", scene);
  if (engine !== undefined) argv.push("-E", engine);
  // Before the frame flags on purpose: Blender runs arguments in order, so a script placed after `-f` would
  // execute after the render it was supposed to configure.
  if (pythonScript !== undefined) argv.push("--python", pythonScript);
  if (frame !== undefined) argv.push("-f", String(frame));
  else if (range !== undefined) argv.push("-s", String(range.start), "-e", String(range.end), "-a");

  const userScript = pythonScript !== undefined;
  const note = userScript
    ? `${pythonScript} is the user's own file and runs through exec approval; LUCID never writes or edits Blender script content.`
    : `Plain background render of ${blend}, no Python involved.`;

  return { ok: true, argv, userScript, note };
}

// ── the outcome ─────────────────────────────────────────────────────────────

/** What a finished Blender process actually produced. `frames` is how many saves Blender REPORTED, which is
 *  the only number here that is evidence rather than intent. */
export interface BlenderOutcome {
  readonly ok: boolean;
  readonly savedFiles: readonly string[];
  readonly frames: number;
  readonly reason: string;
  readonly failingLine: string;
}

/** Caps on untrusted output. The saved-file cap deliberately exceeds MAX_BLENDER_FRAMES, so a render this
 *  module was willing to ASK for can never have its frames silently dropped on the way back. */
const MAX_SAVED_FILES = 4096;
const MAX_SCAN_CHARS = 4_000_000;
const MAX_LINE_CHARS = 400;

/** One saved path per line: Blender prints `Saved: '<path>'`. The unquoted form is accepted as a fallback
 *  for older builds. Duplicates are kept, because a repeated save is something the caller should see. */
function savedFrom(line: string): string {
  const q = /Saved:\s*'([^']*)'/.exec(line);
  if (q) return q[1] ?? "";
  const bare = /Saved:\s*(\S.*)$/.exec(line);
  return bare ? (bare[1] ?? "").trim() : "";
}

/**
 * Read what Blender said and decide whether anything was actually produced.
 *
 * Three failures are named rather than implied:
 *   * a null `code` means the process was killed, so no claim about the run survives;
 *   * a non-zero `code` is a failure that still reports the frames it managed to save;
 *   * `code === 0` with zero saved files is the quiet one: Blender ran and rendered nothing.
 *
 * `failingLine` quotes the first `Error:` line, else the last non-empty stderr line, because "it failed"
 * without the line is useless to whoever has to fix the blend file.
 */
export function classifyBlenderOutput(code: number | null, stdout: string, stderr: string): BlenderOutcome {
  // Scanned under a cap: untrusted output does not get to decide how much work we do.
  const outLines = typeof stdout === "string" ? stdout.slice(0, MAX_SCAN_CHARS).split("\n") : [];
  const errLines = typeof stderr === "string" ? stderr.slice(0, MAX_SCAN_CHARS).split("\n") : [];
  const scanTruncated =
    (typeof stdout === "string" && stdout.length > MAX_SCAN_CHARS) ||
    (typeof stderr === "string" && stderr.length > MAX_SCAN_CHARS);

  const savedFiles: string[] = [];
  let savedTruncated = false;
  for (const line of [...outLines, ...errLines]) {
    if (!line.includes("Saved:")) continue;
    const path = savedFrom(line);
    if (!path) continue;
    if (savedFiles.length >= MAX_SAVED_FILES) {
      savedTruncated = true;
      break;
    }
    savedFiles.push(oneLine(path, MAX_LINE_CHARS));
  }

  const errorLine = [...outLines, ...errLines].find((l) => l.includes("Error:")) ?? "";
  const lastStderr = [...errLines].reverse().find((l) => l.trim() !== "") ?? "";
  const marker = errorLine || lastStderr;

  const frames = savedFiles.length;
  const capNote = savedTruncated
    ? ` Saved-path list was capped at ${MAX_SAVED_FILES} entries.`
    : scanTruncated
      ? ` Output was longer than ${MAX_SCAN_CHARS} characters and was truncated before scanning.`
      : "";

  const fail = (reason: string): BlenderOutcome => ({
    ok: false,
    savedFiles,
    frames,
    reason: `${reason}${capNote}`,
    failingLine: oneLine(marker, MAX_LINE_CHARS),
  });

  if (code === null) {
    return fail(`Blender was killed before it reported an exit code, so this run proves nothing (${frames} frame(s) had been saved).`);
  }
  if (!Number.isInteger(code)) {
    return fail(`Blender returned an exit code that is not an integer (${quoted(String(code))}), which cannot be trusted as success.`);
  }
  if (code !== 0) {
    return fail(`Blender exited ${code} after saving ${frames} frame(s).`);
  }
  if (frames === 0) {
    return fail("Blender exited 0 but saved no files: it ran and rendered nothing, so there is no output to show.");
  }
  return {
    ok: true,
    savedFiles,
    frames,
    reason: `Blender exited 0 and saved ${frames} frame(s).${capNote}`,
    failingLine: "",
  };
}
