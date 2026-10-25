// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/creator_openfilm.ts - CREATOR-OPENFILM (ADR-0457): the I/O seam that checks and renders one OpenFilm
// film on this machine.
//
// OpenFilm (MIT, github.com/openfilm/openfilm, npm `openfilm`) is an HTML film format plus a CLI: a folder with
// film.html whose pages draw `window.film.frame(t)`. `openfilm look` draws a contact sheet twice in shuffled
// orders and reports any frame that does not draw the same picture for the same t, plus page errors, failed fonts,
// missing sounds, and cut-off text; `openfilm render` encodes the film with headless Chromium and FFmpeg. Same
// shape as creator_hyperframes.ts: a pure planner decides WHAT to run as fixed argument VECTORS, and thin runners
// are the only place those vectors meet a process, the job ledger, and the artifact store.
//
//   * THE CALLER SUPPLIES THE SPAWN. No shell, no joined command line. A `.cmd` / `.bat` / `.ps1` / `.vbs` / `.sh`
//     launcher is refused because a shell would interpret the argv, and a package runner (npx, pnpm dlx, bunx,
//     yarn) is refused because it fetches code at run time. Declare node plus node_modules/openfilm/bin/openfilm.mjs.
//   * ONLY `--version`, `look`, AND `render` EVER RUN. `get` (cloud media services with the user's keys), `open`
//     (a detached Studio server plus GitHub/GitLab fetches), `update` (npm), `skill`, `skills`, and `doctor` are
//     refused wherever they could ride, the declared args included.
//   * NO STUDIO SERVER. look and render start a detached Studio server (port 4747) for a project whose
//     `.film/opened` marker is missing; the runner writes that empty marker first, so nothing outlives the job.
//   * OPT-OUTS FORCED. The child env is an allowlist (no secrets, no proxies) plus OPENFILM_NO_BROWSER=1,
//     OPENFILM_NO_UPDATE_CHECK=1, DO_NOT_TRACK=1, and OPENFILM_HOME pointed at a LUCID-owned folder. Under CUI
//     lockdown the Playwright download host is pinned to a dead loopback port, so a first-run Chromium download
//     cannot leave the machine (playwright-core reads PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST first, then
//     PLAYWRIGHT_DOWNLOAD_HOST; both are set).
//   * PATHS ARE CONFINED exactly as planHyperframesRender confines them, with film.html as the project marker.
//     The render output path is LUCID's own, derived from the job id by the caller.
//   * UNDER CUI LOCKDOWN a project whose film.html or any page, script, or stylesheet references an external
//     http(s) or protocol-relative URL is refused: Chromium would fetch it while drawing. A file that cannot be
//     scanned (too big, unreadable, a link) refuses too, because "not scanned" is never "clean".
//   * EVERYTHING THE FILM SAYS IS UNTRUSTED. Every verdict string passes through untrustedText.
//
// The runners never throw; every refusal is a value naming its stage.

import type { SpawnResult } from "./creator_blender.ts";
import { untrustedText } from "./creator_dgx_vision.ts";
import { findExternalRefs, type HyperframesSpawn } from "./creator_hyperframes.ts";
import { finishJob, recordJobArtifact, type JobIo } from "./creator_jobs.ts";
import { storeArtifact, type ArtifactIo, type CreatorArtifact } from "./creator_image.ts";

export type OpenfilmFormat = "mp4" | "webm" | "mov";
export const OPENFILM_FORMATS: readonly OpenfilmFormat[] = ["mp4", "webm", "mov"] as const;
export const OPENFILM_MIME: Record<OpenfilmFormat, string> = { mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime" };

/** Subcommands LUCID never runs, wherever they appear (case-insensitive). */
export const OPENFILM_REFUSED_WORDS: readonly string[] = ["get", "open", "update", "skill", "skills", "doctor"] as const;
/** Launchers that fetch code at run time (basename without extension). */
export const OPENFILM_PACKAGE_RUNNERS: readonly string[] = ["npx", "npm", "pnpm", "pnpx", "bunx", "yarn", "dlx"] as const;
/** Under CUI lockdown Playwright's browser download goes here: a loopback port nothing listens on. */
export const OPENFILM_LOCKED_DOWNLOAD_HOST = "http://127.0.0.1:9";
/** The CLI's own "Studio has shown this project" flag, relative to the project. */
export const OPENFILM_OPENED_MARKER = ".film/opened";
/** Where look writes its PNGs, relative to the project. Nothing else is ever stored from a look. */
export const OPENFILM_LOOK_DIR = ".film/cache/look";
export const OPENFILM_MAX_SHEETS = 4;
export const OPENFILM_LOOK_COUNT_MAX = 200;
export const OPENFILM_FPS_DEFAULT = 30;
/** A time on the command line: the CLI reads only plain decimals, so anything larger is refused before it runs. */
export const OPENFILM_MAX_SECONDS = 1_000_000;
/** The project scan's bounds. Over any of them, a locked run refuses. */
export const OPENFILM_SCAN_LIMITS = { maxFiles: 2000, maxDirs: 2000, maxFileBytes: 4 * 1024 * 1024 } as const;

const ARGV_UNSAFE = /[\u0000-\u001f\u007f]/;
const SHELL_LAUNCHER = /\.(cmd|bat|ps1|vbs|sh)$/i;
const SCANNED = /\.(html?|css|m?js)$/i;
const HTML = /\.html?$/i;
const CSS = /\.css$/i;

/** Env keys the child may inherit: what node, Playwright's Chromium, and FFmpeg need to start on win32, macOS, and
 *  Linux. Nothing that holds a secret, and no proxy (a proxy would route fetches this module does not see). */
const ENV_ALLOW: readonly string[] = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "SystemDrive", "COMSPEC", "OS",
  "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
  "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "DISPLAY", "WAYLAND_DISPLAY",
  "FONTCONFIG_PATH", "FONTCONFIG_FILE", "PLAYWRIGHT_BROWSERS_PATH",
];

/** The child's environment: the allowlist above, then the forced opt-outs, which nothing can override. */
export function openfilmEnv(base: Readonly<Record<string, string | undefined>>, opts: { home: string; locked: boolean }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_ALLOW) { const v = base[k]; if (typeof v === "string" && v) env[k] = v; }
  env.OPENFILM_NO_BROWSER = "1";
  env.OPENFILM_NO_UPDATE_CHECK = "1";
  env.DO_NOT_TRACK = "1";
  env.OPENFILM_HOME = opts.home;
  if (opts.locked) {
    env.PLAYWRIGHT_DOWNLOAD_HOST = OPENFILM_LOCKED_DOWNLOAD_HOST;
    env.PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST = OPENFILM_LOCKED_DOWNLOAD_HOST;
  }
  return env;
}

export interface OpenfilmDeclared {
  /** The declared executable (endpoint `command`): node, or a native binary. */
  readonly exe: string;
  /** The declared leading args (endpoint `args`), e.g. node_modules/openfilm/bin/openfilm.mjs. */
  readonly prefixArgs?: readonly string[];
}

const normal = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");
const isAbsolute = (p: string): boolean => /^([A-Za-z]:\/|\/)/.test(normal(p) + "/");
const baseNoExt = (p: string): string => (normal(p).split("/").pop() ?? "").replace(/\.[^.]*$/, "").toLowerCase();

/** Check the declared launcher. Shared by the probe argv and both plans. */
export function checkOpenfilmLauncher(d: OpenfilmDeclared): { ok: true; head: string[] } | { ok: false; error: string } {
  const exe = (d.exe ?? "").trim();
  if (!exe) return { ok: false, error: "No OpenFilm executable is declared. Add it in Creator Studio first." };
  if (ARGV_UNSAFE.test(exe)) return { ok: false, error: "The OpenFilm executable path carries control characters." };
  if (SHELL_LAUNCHER.test(exe)) return { ok: false, error: `${exe} is a shell launcher. Declare node plus node_modules/openfilm/bin/openfilm.mjs as the first arg, so no shell interprets the argv.` };
  if (OPENFILM_PACKAGE_RUNNERS.includes(baseNoExt(exe))) return { ok: false, error: `${exe} is a package runner that fetches code at run time. Install openfilm once, then declare node plus node_modules/openfilm/bin/openfilm.mjs.` };
  const prefix = [...(d.prefixArgs ?? [])];
  for (const a of prefix) {
    if (typeof a !== "string" || ARGV_UNSAFE.test(a)) return { ok: false, error: "A declared OpenFilm arg carries control characters." };
    if (OPENFILM_REFUSED_WORDS.includes(a.trim().toLowerCase())) return { ok: false, error: `The declared args name the "${a.trim()}" subcommand, which LUCID never runs: only look and render do.` };
  }
  return { ok: true, head: [exe, ...prefix] };
}

/** `<exe> [prefix] --version`, the probe's fixed argv. */
export function openfilmVersionArgv(d: OpenfilmDeclared): { ok: true; argv: string[] } | { ok: false; error: string } {
  const l = checkOpenfilmLauncher(d);
  return l.ok ? { ok: true, argv: [...l.head, "--version"] } : l;
}

/** The project dir checks planHyperframesRender applies, shared by both plans. */
function checkProjectDir(projectDir: unknown, roots: readonly string[] | undefined): { ok: true; dir: string } | { ok: false; error: string } {
  const dir = typeof projectDir === "string" ? projectDir.trim() : "";
  if (!dir) return { ok: false, error: "Name the OpenFilm project folder (the one holding film.html)." };
  if (ARGV_UNSAFE.test(dir)) return { ok: false, error: "That project path carries control characters." };
  if (!isAbsolute(dir)) return { ok: false, error: "The project folder must be an absolute path." };
  if (normal(dir).split("/").includes("..")) return { ok: false, error: "The project folder must not climb with `..`." };
  if (dir.startsWith("-")) return { ok: false, error: "The project folder must not start with a dash." };
  const rs = (roots ?? []).map(normal).filter(Boolean);
  if (rs.length) {
    const d = normal(dir).toLowerCase();
    if (!rs.some((r) => d === r.toLowerCase() || d.startsWith(`${r.toLowerCase()}/`))) {
      return { ok: false, error: "That project folder is outside the workspace roots your organization allows." };
    }
  }
  return { ok: true, dir };
}

/** A time as the CLI reads it (plain decimals, no exponent), or null when it cannot be one. */
function seconds(v: unknown): string | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > OPENFILM_MAX_SECONDS) return null;
  const s = String(Number(v.toFixed(3)));
  return /^\d+(\.\d+)?$/.test(s) ? s : null;
}

export interface OpenfilmLookPlanInput extends OpenfilmDeclared {
  readonly projectDir: string;
  /** One frame at full size. Exclusive with `range`. */
  readonly at?: number;
  /** A stretch [a, b] in seconds, a < b. */
  readonly range?: readonly [number, number];
  /** Frames in the sheet, 1..200 (the CLI's own bounds). */
  readonly count?: number;
  readonly roots?: readonly string[];
}

export interface OpenfilmLookPlan {
  readonly kind: "look";
  readonly argv: readonly string[];
  readonly projectDir: string;
}

/** Decide what `look` would run, or why nothing will. Pure. */
export function planOpenfilmLook(input: OpenfilmLookPlanInput): { ok: true; plan: OpenfilmLookPlan } | { ok: false; error: string } {
  const l = checkOpenfilmLauncher(input);
  if (!l.ok) return l;
  const d = checkProjectDir(input.projectDir, input.roots);
  if (!d.ok) return d;
  if (input.at !== undefined && input.range !== undefined) return { ok: false, error: "Look at one time or one range, not both." };
  const what: string[] = [];
  if (input.at !== undefined) {
    const t = seconds(input.at);
    if (t === null) return { ok: false, error: `at must be a finite number of seconds from 0 to ${OPENFILM_MAX_SECONDS}.` };
    what.push(t);
  }
  if (input.range !== undefined) {
    const r = input.range;
    const a = Array.isArray(r) && r.length === 2 ? seconds(r[0]) : null;
    const b = Array.isArray(r) && r.length === 2 ? seconds(r[1]) : null;
    if (a === null || b === null) return { ok: false, error: `range must be two finite numbers of seconds from 0 to ${OPENFILM_MAX_SECONDS}.` };
    if (!(Number(a) < Number(b))) return { ok: false, error: "range must end after it starts." };
    what.push(`${a}-${b}`);
  }
  const count: string[] = [];
  if (input.count !== undefined) {
    const n = input.count;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > OPENFILM_LOOK_COUNT_MAX) return { ok: false, error: `count must be a whole number from 1 to ${OPENFILM_LOOK_COUNT_MAX}.` };
    count.push("--count", String(n));
  }
  return { ok: true, plan: { kind: "look", argv: [...l.head, "look", ...what, ...count], projectDir: d.dir } };
}

export interface OpenfilmRenderPlanInput extends OpenfilmDeclared {
  readonly projectDir: string;
  /** LUCID's own output path (derived from the job id by the caller). */
  readonly outPath: string;
  readonly format?: OpenfilmFormat;
  /** 1..240, default 30. */
  readonly fps?: number;
  readonly fourK?: boolean;
  readonly blur?: boolean;
  readonly roots?: readonly string[];
}

export interface OpenfilmRenderPlan {
  readonly kind: "render";
  readonly argv: readonly string[];
  readonly projectDir: string;
  readonly outPath: string;
  readonly format: OpenfilmFormat;
  readonly mime: string;
}

export type OpenfilmPlan = OpenfilmLookPlan | OpenfilmRenderPlan;

/** Decide what `render` would run, or why nothing will. Pure. */
export function planOpenfilmRender(input: OpenfilmRenderPlanInput): { ok: true; plan: OpenfilmRenderPlan } | { ok: false; error: string } {
  const l = checkOpenfilmLauncher(input);
  if (!l.ok) return l;
  const format = input.format ?? "mp4";
  if (!OPENFILM_FORMATS.includes(format)) return { ok: false, error: `format must be one of ${OPENFILM_FORMATS.join(", ")}.` };
  const fps = input.fps ?? OPENFILM_FPS_DEFAULT;
  if (typeof fps !== "number" || !Number.isFinite(fps) || fps < 1 || fps > 240) return { ok: false, error: "fps must be a number from 1 to 240." };
  const d = checkProjectDir(input.projectDir, input.roots);
  if (!d.ok) return d;
  const out = typeof input.outPath === "string" ? input.outPath : "";
  if (!out || ARGV_UNSAFE.test(out) || !isAbsolute(out) || normal(out).split("/").includes("..")) return { ok: false, error: "The render output path must be absolute." };
  if (!out.toLowerCase().endsWith(`.${format}`)) return { ok: false, error: `The render output path must end in .${format}.` };
  const fpsArg = String(Number(fps.toFixed(3)));
  return {
    ok: true,
    plan: {
      kind: "render",
      argv: [
        ...l.head, "render", "--out", out, "--fps", fpsArg, "--workers", "1",
        ...(format === "mp4" ? [] : ["--alpha"]),
        ...(input.fourK ? ["--4k"] : []),
        // No --subtitles: the released CLI (0.2.5) rejects it as an unknown option; it exists only on main.
        ...(input.blur ? ["--blur"] : []),
      ],
      projectDir: d.dir,
      outPath: out,
      format,
      mime: OPENFILM_MIME[format],
    },
  };
}

/** Namespace URIs name a vocabulary; nothing fetches them. */
const NAMESPACE = /^https?:\/\/www\.w3\.org\/(2000\/svg|1999\/xhtml|1999\/xlink|1998\/Math\/MathML|XML\/1998\/namespace|2000\/xmlns\/?)$/i;

/** Every quoted absolute (http, https, or protocol-relative) URL literal in script or stylesheet text. */
export function findUrlLiterals(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/["'`]\s*((?:https?:)?\/\/[^"'`\s]+)/gi)) {
    const u = m[1]!;
    if (!NAMESPACE.test(u)) out.add(u.slice(0, 200));
  }
  return [...out];
}

/** The external URLs one project file references, by its kind. */
export function findOpenfilmExternalRefs(name: string, text: string): string[] {
  const out = new Set<string>();
  if (HTML.test(name)) {
    for (const u of findExternalRefs(text)) out.add(u);
    for (const m of text.matchAll(/<(script|style)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) for (const u of findUrlLiterals(m[2]!)) out.add(u);
  } else if (CSS.test(name)) {
    for (const u of findExternalRefs(text)) out.add(u);
    for (const u of findUrlLiterals(text)) out.add(u);
  } else {
    for (const u of findUrlLiterals(text)) out.add(u);
  }
  return [...out];
}

export interface OpenfilmDirEntry {
  readonly name: string;
  /** `other` is anything that is not a plain file or folder (a link, a junction, a device). */
  readonly kind: "file" | "dir" | "other";
}

/** What the runner is handed. `spawn` gets the env explicitly: nothing inherits the engine's env. */
export type OpenfilmSpawn = HyperframesSpawn;

export interface OpenfilmDeps {
  readonly spawn: OpenfilmSpawn;
  readonly exists: (path: string) => boolean;
  readonly readText: (path: string) => string;
  readonly readBytes: (path: string) => Uint8Array;
  /** Byte size of a file; throws when it cannot be read. */
  readonly fileSize: (path: string) => number;
  readonly listDir: (dir: string) => readonly OpenfilmDirEntry[];
  readonly writeText: (path: string, text: string) => void;
  readonly ensureDir: (dir: string) => void;
  readonly jobIo: JobIo;
  readonly artifactIo: ArtifactIo;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => number;
}

export type OpenfilmStage = "missing-exe" | "missing-project" | "external-refs" | "env" | "marker" | "look" | "render" | "store" | "done";

/** A look's parsed stdout. Every string is film-derived and untrusted. */
export interface OpenfilmLookParse {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly head: string;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly passed: readonly string[];
  readonly notes: readonly string[];
  /** Absolute paths of the `→` lines (resolved against the project dir, not yet confined). */
  readonly files: readonly string[];
}

/** The contract's verdict: the parse with `files` replaced by the stored PNGs' artifact ids. */
export interface OpenfilmLookVerdict {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly head: string;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly passed: readonly string[];
  readonly notes: readonly string[];
  readonly sheets: readonly string[];
}

const LINE_MAX = 600;
const HEAD_MAX = 200;
const LIST_MAX = 200;
const PATH_MAX = 1024;

/** Parse look's stdout. `cwd` is the project dir the CLI ran in (its `→` paths are relative to it). Pure. */
export function parseOpenfilmLook(stdout: string, code: number | null, cwd = ""): OpenfilmLookParse {
  let head = "";
  const errors: string[] = [], warnings: string[] = [], passed: string[] = [], notes: string[] = [], files: string[] = [];
  let last: string[] | null = null;
  const push = (list: string[], text: string): void => {
    last = null;
    if (list.length >= LIST_MAX) return;
    list.push(text);
    last = list;
  };
  for (const raw of (stdout ?? "").replace(/\r/g, "").split("\n")) {
    if (!head) {
      if (/^film\s/.test(raw)) head = untrustedText(raw, HEAD_MAX);
      continue;
    }
    if (/^ {8}/.test(raw)) {
      const list = last as string[] | null;
      if (list && list.length && list !== files) list[list.length - 1] = untrustedText(`${list[list.length - 1]} ${raw.trim()}`, LINE_MAX);
      continue;
    }
    const mark = raw.charAt(0);
    const rest = raw.slice(1).trim();
    if (mark === "✗") push(errors, untrustedText(rest, LINE_MAX));
    else if (mark === "!") push(warnings, untrustedText(rest, LINE_MAX));
    else if (mark === "✓") push(passed, untrustedText(rest, LINE_MAX));
    else if (mark === "♪" || mark === "✎") push(notes, untrustedText(raw.trim(), LINE_MAX));
    else if (mark === "→") {
      const p = untrustedText(rest, PATH_MAX);
      last = null;
      if (!p || files.length >= LIST_MAX) continue;
      files.push(isAbsolute(p) || !cwd ? p : `${normal(cwd)}/${normal(p)}`);
    } else last = null;
  }
  return { ok: code === 0 && errors.length === 0 && !!head, exitCode: code, head, errors, warnings, passed, notes, files };
}

const DEFAULT_LOOK_TIMEOUT_MS = 900_000;
const DEFAULT_RENDER_TIMEOUT_MS = 1_800_000;
const tail = (s: string): string => untrustedText(s.trim().split("\n").slice(-6).join("\n").slice(-800), 800);
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

type Preflight = { ok: true; note: string } | { ok: false; stage: OpenfilmStage; error: string };

/** Check the files the plan names and scan the project for external URLs. Run BEFORE a job is recorded so a typo
 *  never leaves a failed row. Under lockdown anything that could not be scanned refuses. */
export function preflightOpenfilm(deps: Pick<OpenfilmDeps, "exists" | "readText" | "listDir" | "fileSize">, plan: OpenfilmPlan, exe: string, locked: boolean): Preflight {
  if (!deps.exists(exe)) return { ok: false, stage: "missing-exe", error: `The OpenFilm executable is not there: ${exe}.` };
  const root = normal(plan.projectDir);
  if (!deps.exists(`${root}/film.html`)) return { ok: false, stage: "missing-project", error: `There is no film.html in ${plan.projectDir}. Nothing was started.` };
  const refs = new Set<string>();
  const unscanned: string[] = [];
  let files = 0, dirs = 0, truncated = false;
  const queue: string[] = [root];
  while (queue.length) {
    const dir = queue.shift()!;
    if (++dirs > OPENFILM_SCAN_LIMITS.maxDirs) { truncated = true; break; }
    let entries: readonly OpenfilmDirEntry[];
    try { entries = deps.listDir(dir); } catch { unscanned.push(dir); continue; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const path = `${dir}/${e.name}`;
      if (e.kind === "dir") { queue.push(path); continue; }
      if (e.kind === "other") { unscanned.push(path); continue; }
      if (!SCANNED.test(e.name)) continue;
      if (++files > OPENFILM_SCAN_LIMITS.maxFiles) { truncated = true; break; }
      let text: string;
      try {
        if (deps.fileSize(path) > OPENFILM_SCAN_LIMITS.maxFileBytes) { unscanned.push(path); continue; }
        text = deps.readText(path);
      } catch { unscanned.push(path); continue; }
      for (const u of findOpenfilmExternalRefs(e.name, text)) refs.add(untrustedText(u, 200));
    }
    if (truncated) break;
  }
  if (unscanned.length && locked) {
    return { ok: false, stage: "external-refs", error: `CUI lockdown: ${plural(unscanned.length, "project item")} could not be scanned for external URLs (${path0(root, unscanned).slice(0, 3).join(", ")}): a link, an unreadable file, or a file over ${OPENFILM_SCAN_LIMITS.maxFileBytes / 1024 / 1024} MB. Nothing was started.` };
  }
  if (truncated && locked) {
    return { ok: false, stage: "external-refs", error: `CUI lockdown: the project holds more than ${OPENFILM_SCAN_LIMITS.maxFiles} pages, scripts, and stylesheets (or ${OPENFILM_SCAN_LIMITS.maxDirs} folders), so it could not be fully scanned for external URLs. Nothing was started.` };
  }
  const list = [...refs];
  if (list.length && locked) {
    return { ok: false, stage: "external-refs", error: `CUI lockdown: the film references ${plural(list.length, "external URL")} (${list.slice(0, 3).join(", ")}). Chromium would fetch them while drawing; vendor the assets into the project first.` };
  }
  const notes: string[] = [];
  if (list.length) notes.push(`The film references external URLs (${list.slice(0, 3).join(", ")}); it is not offline and not deterministic until they are vendored.`);
  if (unscanned.length || truncated) notes.push("Part of the project could not be scanned for external URLs.");
  return { ok: true, note: notes.join(" ") };
}

/** Project-relative display of scanned paths. */
function path0(root: string, paths: readonly string[]): string[] {
  return paths.map((p) => untrustedText(p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p, 120));
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isPng = (b: Uint8Array): boolean => b.length > 24 && PNG_MAGIC.every((v, i) => b[i] === v);
const pngSize = (b: Uint8Array): { width: number; height: number } => {
  const u32 = (o: number): number => ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
  return { width: u32(16), height: u32(20) };
};

/** True when `path` is a .png directly or deeper inside `<project>/.film/cache/look/`. */
export function isLookSheetPath(projectDir: string, path: string): boolean {
  const p = normal(path);
  if (!isAbsolute(p) || p.split("/").includes("..") || p.split("/").includes(".") || !/\.png$/i.test(p)) return false;
  const dir = `${normal(projectDir)}/${OPENFILM_LOOK_DIR}/`.toLowerCase();
  return p.toLowerCase().startsWith(dir) && p.length > dir.length;
}

export interface OpenfilmRunOptions {
  readonly label: string;
  /** OPENFILM_HOME: a LUCID-owned folder, absolute. */
  readonly home: string;
  readonly locked: boolean;
  readonly timeoutMs?: number;
  readonly note?: string;
}

export interface OpenfilmLookRunResult {
  /** The job settled done (the film may still have errors: see verdict.ok). */
  readonly ok: boolean;
  readonly stage: OpenfilmStage;
  readonly error: string;
  readonly verdict: OpenfilmLookVerdict | null;
  readonly note: string;
}

export interface OpenfilmRenderRunResult {
  readonly ok: boolean;
  readonly stage: OpenfilmStage;
  readonly error: string;
  readonly artifact: CreatorArtifact | null;
  readonly note: string;
}

/** The env plus the `.film/opened` marker, or why the run cannot start safely. */
function prepare(deps: OpenfilmDeps, plan: OpenfilmPlan, opts: OpenfilmRunOptions): { ok: true; env: Record<string, string> } | { ok: false; stage: OpenfilmStage; error: string } {
  const home = typeof opts.home === "string" ? opts.home.trim() : "";
  if (!home || ARGV_UNSAFE.test(home) || !isAbsolute(home)) return { ok: false, stage: "env", error: "OPENFILM_HOME must be an absolute LUCID-owned folder." };
  try { deps.ensureDir(home); } catch { return { ok: false, stage: "env", error: "The OpenFilm home folder could not be created." }; }
  const marker = `${normal(plan.projectDir)}/${OPENFILM_OPENED_MARKER}`;
  if (!deps.exists(marker)) {
    try {
      deps.ensureDir(`${normal(plan.projectDir)}/.film`);
      deps.writeText(marker, "");
    } catch { return { ok: false, stage: "marker", error: "Could not write .film/opened in the project; without it openfilm would start a detached Studio server, so nothing was started." }; }
  }
  return { ok: true, env: openfilmEnv(deps.env, { home, locked: opts.locked }) };
}

const timeout = (v: number | undefined, d: number): number => (typeof v === "number" && v > 0 ? Math.min(v, 86_400_000) : d);

/** Run `openfilm look`, store its PNGs, settle the job. The job is already created and started by the caller. */
export async function runOpenfilmLook(deps: OpenfilmDeps, base: string, jobId: string, plan: OpenfilmLookPlan, opts: OpenfilmRunOptions): Promise<OpenfilmLookRunResult> {
  const fail = (stage: OpenfilmStage, error: string): OpenfilmLookRunResult => {
    finishJob(deps.jobIo, base, jobId, "failed", error);
    return { ok: false, stage, error, verdict: null, note: opts.note ?? "" };
  };
  const prep = prepare(deps, plan, opts);
  if (!prep.ok) return fail(prep.stage, prep.error);
  let out: SpawnResult;
  try { out = await deps.spawn(plan.argv, { cwd: plan.projectDir, timeoutMs: timeout(opts.timeoutMs, DEFAULT_LOOK_TIMEOUT_MS), env: prep.env }); }
  catch (e) { return fail("look", `openfilm look did not run: ${untrustedText(String(e), 300)}`); }
  const parsed = parseOpenfilmLook(out.stdout, out.code, plan.projectDir);
  if ((out.code !== 0 && out.code !== 1) || !parsed.head) {
    return fail("look", `openfilm look failed (exit ${out.code ?? "killed"}). ${tail(out.stderr || out.stdout)}`.trim());
  }
  const sheets: string[] = [];
  let skipped = 0;
  for (const f of parsed.files) {
    if (sheets.length >= OPENFILM_MAX_SHEETS) { skipped++; continue; }
    if (!isLookSheetPath(plan.projectDir, f) || !deps.exists(f)) { skipped++; continue; }
    let bytes: Uint8Array;
    try { bytes = deps.readBytes(f); } catch { skipped++; continue; }
    if (!isPng(bytes)) { skipped++; continue; }
    const { width, height } = pngSize(bytes);
    const stored = storeArtifact(deps.artifactIo, base, { kind: "image", bytes, mime: "image/png", width, height, source: "openfilm", prompt: opts.label });
    if (!stored.ok || !stored.artifact) { skipped++; continue; }
    recordJobArtifact(deps.jobIo, base, jobId, stored.artifact.id);
    sheets.push(stored.artifact.id);
  }
  const verdict: OpenfilmLookVerdict = {
    ok: parsed.ok, exitCode: parsed.exitCode, head: parsed.head,
    errors: parsed.errors, warnings: parsed.warnings, passed: parsed.passed, notes: parsed.notes, sheets,
  };
  finishJob(deps.jobIo, base, jobId, "done", "");
  const extra = skipped ? `${plural(skipped, "listed picture")} not stored (outside .film/cache/look, not a PNG, or over ${OPENFILM_MAX_SHEETS}).` : "";
  return { ok: true, stage: "done", error: "", verdict, note: [opts.note ?? "", extra].filter(Boolean).join(" ") };
}

/** Run `openfilm render`, store the video, settle the job. The job is already created and started by the caller. */
export async function runOpenfilmRender(deps: OpenfilmDeps, base: string, jobId: string, plan: OpenfilmRenderPlan, opts: OpenfilmRunOptions): Promise<OpenfilmRenderRunResult> {
  const fail = (stage: OpenfilmStage, error: string): OpenfilmRenderRunResult => {
    finishJob(deps.jobIo, base, jobId, "failed", error);
    return { ok: false, stage, error, artifact: null, note: opts.note ?? "" };
  };
  const prep = prepare(deps, plan, opts);
  if (!prep.ok) return fail(prep.stage, prep.error);
  const startedAt = deps.now();
  let out: SpawnResult;
  try { out = await deps.spawn(plan.argv, { cwd: plan.projectDir, timeoutMs: timeout(opts.timeoutMs, DEFAULT_RENDER_TIMEOUT_MS), env: prep.env }); }
  catch (e) { return fail("render", `openfilm render did not run: ${untrustedText(String(e), 300)}`); }
  if (out.code !== 0) return fail("render", `openfilm render failed (exit ${out.code ?? "killed"}). ${tail(out.stderr || out.stdout)}`.trim());
  if (!deps.exists(plan.outPath)) return fail("render", "openfilm render exited 0 but wrote no output file.");
  let bytes: Uint8Array;
  try { bytes = deps.readBytes(plan.outPath); } catch { return fail("store", "The rendered file could not be read back."); }
  const stored = storeArtifact(deps.artifactIo, base, { kind: "video", bytes, mime: plan.mime, width: 0, height: 0, source: "openfilm", prompt: opts.label });
  if (!stored.ok || !stored.artifact) return fail("store", stored.error ?? "The rendered video could not be stored.");
  recordJobArtifact(deps.jobIo, base, jobId, stored.artifact.id);
  finishJob(deps.jobIo, base, jobId, "done", "");
  const elapsed = Math.max(0, deps.now() - startedAt);
  return { ok: true, stage: "done", error: "", artifact: stored.artifact, note: `${opts.note ? `${opts.note} ` : ""}Rendered in ${elapsed}ms.`.trim() };
}
