// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/creator_hyperframes.ts - the I/O seam that renders one HyperFrames composition on this machine.
//
// HyperFrames (Apache-2.0, npm `hyperframes`) renders an HTML composition to video with headless Chrome plus
// FFmpeg. Same shape as creator_blender.ts: a pure planner decides WHAT to run as fixed argument VECTORS,
// and a thin runner is the only place those vectors meet a process, the job ledger, and the artifact store.
//
//   * THE CALLER SUPPLIES THE SPAWN. No shell, no joined command line: argv arrays go to `deps.spawn` as
//     built, so a test proves the exact vector. A `.cmd` / `.bat` / `.ps1` launcher is refused because
//     Windows would hand it to a shell interpreter; declare the native binary, or node plus the package's
//     CLI entry as the endpoint's first arg.
//   * ONLY `lint` AND `render` EVER RUN. The cloud, publish, auth, lambda, and cloudrun subcommands are
//     refused wherever they could ride (the declared args included), so no render leaves this machine.
//   * TELEMETRY OFF, ONE WORKER. The child env is an allowlist plus HYPERFRAMES_NO_TELEMETRY=1 and
//     DO_NOT_TRACK=1; vault-populated secrets in the engine env never reach it. `--workers 1` avoids the
//     multi-worker capture bug (hyperframes issue 4435).
//   * PATHS ARE CONFINED. The project dir must be absolute, carry no `..` climb, contain index.html, and sit
//     under a managed workspace root when the organization set any. The output path is LUCID's own, derived
//     from the job id, never caller-supplied.
//   * UNDER CUI LOCKDOWN a composition that references an external http(s) URL is refused: headless Chrome
//     would fetch it during the render, and the URL itself can carry content.
//
// The runner never throws; every refusal is a value naming its stage.

import type { SpawnResult } from "./creator_blender.ts";
import { finishJob, recordJobArtifact, type JobIo } from "./creator_jobs.ts";
import { storeArtifact, type ArtifactIo, type CreatorArtifact } from "./creator_image.ts";

export type HyperframesFormat = "mp4" | "webm" | "mov";
export type HyperframesQuality = "draft" | "standard" | "high";
export const HYPERFRAMES_FORMATS: readonly HyperframesFormat[] = ["mp4", "webm", "mov"] as const;
export const HYPERFRAMES_QUALITIES: readonly HyperframesQuality[] = ["draft", "standard", "high"] as const;
export const HYPERFRAMES_MIME: Record<HyperframesFormat, string> = { mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime" };

/** Subcommands that reach HeyGen's cloud or third-party infrastructure. Never run, wherever they appear. */
export const HYPERFRAMES_REFUSED_WORDS: readonly string[] = ["cloud", "publish", "auth", "login", "logout", "lambda", "cloudrun", "deploy"] as const;

const ARGV_UNSAFE = /[\u0000-\u001f\u007f]/;
const SHELL_LAUNCHER = /\.(cmd|bat|ps1|vbs|sh)$/i;

/** Env keys the child may inherit: what Chrome, FFmpeg, and node need to start, nothing that holds a secret. */
const ENV_ALLOW: readonly string[] = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "SystemDrive", "COMSPEC", "TEMP", "TMP", "TMPDIR",
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "LANG", "LC_ALL", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR",
  "DISPLAY", "FONTCONFIG_PATH", "PUPPETEER_CACHE_DIR", "PUPPETEER_EXECUTABLE_PATH", "HYPERFRAMES_BROWSER_PATH",
];

/** The child's environment: the allowlist above, then the two opt-outs, which nothing can override. */
export function hyperframesEnv(base: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_ALLOW) { const v = base[k]; if (typeof v === "string" && v) env[k] = v; }
  env.HYPERFRAMES_NO_TELEMETRY = "1";
  env.DO_NOT_TRACK = "1";
  return env;
}

export interface HyperframesDeclared {
  /** The declared executable (endpoint `command`). */
  readonly exe: string;
  /** The declared leading args (endpoint `args`), e.g. the CLI entry script when `exe` is node. */
  readonly prefixArgs?: readonly string[];
}

const normal = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");
const isAbsolute = (p: string): boolean => /^([A-Za-z]:\/|\/)/.test(normal(p) + "/");

/** Check the declared launcher. Shared by the probe argv and the render plan. */
export function checkHyperframesLauncher(d: HyperframesDeclared): { ok: true; head: string[] } | { ok: false; error: string } {
  const exe = (d.exe ?? "").trim();
  if (!exe) return { ok: false, error: "No HyperFrames executable is declared. Add it in Creator Studio first." };
  if (ARGV_UNSAFE.test(exe)) return { ok: false, error: "The HyperFrames executable path carries control characters." };
  if (SHELL_LAUNCHER.test(exe)) return { ok: false, error: `${exe} is a shell launcher. Declare the native hyperframes binary, or node plus the package's CLI entry (node_modules/hyperframes/...) as the first arg, so no shell interprets the argv.` };
  const prefix = [...(d.prefixArgs ?? [])];
  for (const a of prefix) {
    if (typeof a !== "string" || ARGV_UNSAFE.test(a)) return { ok: false, error: "A declared HyperFrames arg carries control characters." };
    if (HYPERFRAMES_REFUSED_WORDS.includes(a.trim().toLowerCase())) return { ok: false, error: `The declared args name the "${a.trim()}" subcommand, which LUCID never runs: nothing renders off this machine.` };
  }
  return { ok: true, head: [exe, ...prefix] };
}

/** `<exe> [prefix] --version`, the probe's fixed argv. */
export function hyperframesVersionArgv(d: HyperframesDeclared): { ok: true; argv: string[] } | { ok: false; error: string } {
  const l = checkHyperframesLauncher(d);
  return l.ok ? { ok: true, argv: [...l.head, "--version"] } : l;
}

export interface HyperframesPlanInput extends HyperframesDeclared {
  readonly projectDir: string;
  /** LUCID's own output path (derived from the job id by the caller). */
  readonly outPath: string;
  readonly format?: HyperframesFormat;
  readonly quality?: HyperframesQuality;
  /** Managed workspace roots; empty means unconfined by policy (the dir checks still apply). */
  readonly roots?: readonly string[];
}

export interface HyperframesPlan {
  readonly lintArgv: readonly string[];
  readonly renderArgv: readonly string[];
  readonly projectDir: string;
  readonly outPath: string;
  readonly format: HyperframesFormat;
  readonly mime: string;
}

/** Decide what would run, or why nothing will. Pure. */
export function planHyperframesRender(input: HyperframesPlanInput): { ok: true; plan: HyperframesPlan } | { ok: false; error: string } {
  const l = checkHyperframesLauncher(input);
  if (!l.ok) return l;
  const format = input.format ?? "mp4";
  const quality = input.quality ?? "standard";
  if (!HYPERFRAMES_FORMATS.includes(format)) return { ok: false, error: `format must be one of ${HYPERFRAMES_FORMATS.join(", ")}.` };
  if (!HYPERFRAMES_QUALITIES.includes(quality)) return { ok: false, error: `quality must be one of ${HYPERFRAMES_QUALITIES.join(", ")}.` };
  const dir = typeof input.projectDir === "string" ? input.projectDir.trim() : "";
  if (!dir) return { ok: false, error: "Name the HyperFrames project folder (the one holding index.html)." };
  if (ARGV_UNSAFE.test(dir)) return { ok: false, error: "That project path carries control characters." };
  if (!isAbsolute(dir)) return { ok: false, error: "The project folder must be an absolute path." };
  if (normal(dir).split("/").includes("..")) return { ok: false, error: "The project folder must not climb with `..`." };
  if (dir.startsWith("-")) return { ok: false, error: "The project folder must not start with a dash." };
  const roots = (input.roots ?? []).map(normal).filter(Boolean);
  if (roots.length) {
    const d = normal(dir).toLowerCase();
    if (!roots.some((r) => d === r.toLowerCase() || d.startsWith(`${r.toLowerCase()}/`))) {
      return { ok: false, error: "That project folder is outside the workspace roots your organization allows." };
    }
  }
  if (!input.outPath || !isAbsolute(input.outPath)) return { ok: false, error: "The render output path must be absolute." };
  return {
    ok: true,
    plan: {
      lintArgv: [...l.head, "lint", dir],
      renderArgv: [...l.head, "render", dir, "--format", format, "--quality", quality, "--workers", "1", "--output", input.outPath],
      projectDir: dir,
      outPath: input.outPath,
      format,
      mime: HYPERFRAMES_MIME[format],
    },
  };
}

/** Every external http(s) URL an HTML composition references in an attribute, CSS url(), or @import. A
 *  data: or relative URL is local by construction and not reported. */
export function findExternalRefs(html: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /\b(?:src|href|poster|data-src|srcset|action|xlink:href)\s*=\s*["']?\s*((?:https?:)?\/\/[^"'\s>]+)/gi,
    /url\(\s*["']?\s*((?:https?:)?\/\/[^"')\s]+)/gi,
    /@import\s+["']((?:https?:)?\/\/[^"']+)/gi,
    /\bimport\s*\(?\s*["']((?:https?:)?\/\/[^"']+)/gi,
  ];
  for (const re of patterns) for (const m of html.matchAll(re)) out.add(m[1]!.slice(0, 200));
  return [...out];
}

/** What the runner is handed. `spawn` gets the env explicitly: nothing inherits the engine's env. */
export type HyperframesSpawn = (argv: readonly string[], opts: { cwd: string; timeoutMs: number; env: Record<string, string> }) => Promise<SpawnResult>;

export interface HyperframesDeps {
  readonly spawn: HyperframesSpawn;
  readonly exists: (path: string) => boolean;
  readonly readText: (path: string) => string;
  readonly readBytes: (path: string) => Uint8Array;
  readonly ensureDir: (dir: string) => void;
  readonly jobIo: JobIo;
  readonly artifactIo: ArtifactIo;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => number;
}

export type HyperframesStage = "missing-exe" | "missing-project" | "external-refs" | "lint" | "render" | "store" | "done";

export interface HyperframesRunResult {
  readonly ok: boolean;
  readonly stage: HyperframesStage;
  readonly error: string;
  readonly artifact: CreatorArtifact | null;
  readonly note: string;
}

const DEFAULT_TIMEOUT_MS = 1_800_000;
const tail = (s: string): string => s.trim().split("\n").slice(-6).join("\n").slice(-800);

/** Check the files the plan names. Run BEFORE a job is recorded so a typo never leaves a failed row. */
export function preflightHyperframes(deps: Pick<HyperframesDeps, "exists" | "readText">, plan: HyperframesPlan, exe: string, locked: boolean): { ok: true; note: string } | { ok: false; stage: HyperframesStage; error: string } {
  if (!deps.exists(exe)) return { ok: false, stage: "missing-exe", error: `The HyperFrames executable is not there: ${exe}.` };
  const index = `${normal(plan.projectDir)}/index.html`;
  if (!deps.exists(index)) return { ok: false, stage: "missing-project", error: `There is no index.html in ${plan.projectDir}. Nothing was started.` };
  let html = "";
  try { html = deps.readText(index); } catch { return { ok: false, stage: "missing-project", error: `index.html in ${plan.projectDir} could not be read.` }; }
  const refs = findExternalRefs(html);
  if (refs.length && locked) {
    return { ok: false, stage: "external-refs", error: `CUI lockdown: index.html references ${refs.length} external URL${refs.length === 1 ? "" : "s"} (${refs.slice(0, 3).join(", ")}). Headless Chrome would fetch them during the render; vendor the assets into the project first.` };
  }
  return { ok: true, note: refs.length ? `index.html references external URLs (${refs.slice(0, 3).join(", ")}); the render is not offline and not deterministic until they are vendored.` : "" };
}

/** Lint, render, store, settle the job. The job is already created and started by the caller. */
export async function runHyperframesRender(deps: HyperframesDeps, base: string, jobId: string, plan: HyperframesPlan, opts: { label: string; timeoutMs?: number; note?: string }): Promise<HyperframesRunResult> {
  const env = hyperframesEnv(deps.env);
  const timeoutMs = typeof opts.timeoutMs === "number" && opts.timeoutMs > 0 ? Math.min(opts.timeoutMs, 86_400_000) : DEFAULT_TIMEOUT_MS;
  const fail = (stage: HyperframesStage, error: string): HyperframesRunResult => {
    finishJob(deps.jobIo, base, jobId, "failed", error);
    return { ok: false, stage, error, artifact: null, note: opts.note ?? "" };
  };

  let lint: SpawnResult;
  try { lint = await deps.spawn(plan.lintArgv, { cwd: plan.projectDir, timeoutMs: 120_000, env }); }
  catch (e) { return fail("lint", `hyperframes lint did not run: ${String(e).slice(0, 300)}`); }
  if (lint.code !== 0) return fail("lint", `hyperframes lint failed (exit ${lint.code ?? "killed"}). ${tail(lint.stderr || lint.stdout)}`);

  const startedAt = deps.now();
  let out: SpawnResult;
  try { out = await deps.spawn(plan.renderArgv, { cwd: plan.projectDir, timeoutMs, env }); }
  catch (e) { return fail("render", `hyperframes render did not run: ${String(e).slice(0, 300)}`); }
  if (out.code !== 0) return fail("render", `hyperframes render failed (exit ${out.code ?? "killed"}). ${tail(out.stderr || out.stdout)}`);
  if (!deps.exists(plan.outPath)) return fail("render", "hyperframes render exited 0 but wrote no output file.");

  let bytes: Uint8Array;
  try { bytes = deps.readBytes(plan.outPath); } catch { return fail("store", "The rendered file could not be read back."); }
  const stored = storeArtifact(deps.artifactIo, base, { kind: "video", bytes, mime: plan.mime, width: 0, height: 0, source: "hyperframes", prompt: opts.label });
  if (!stored.ok || !stored.artifact) return fail("store", stored.error ?? "The rendered video could not be stored.");
  recordJobArtifact(deps.jobIo, base, jobId, stored.artifact.id);
  finishJob(deps.jobIo, base, jobId, "done", "");
  const elapsed = Math.max(0, deps.now() - startedAt);
  return { ok: true, stage: "done", error: "", artifact: stored.artifact, note: `${opts.note ? `${opts.note} ` : ""}Rendered in ${elapsed}ms.`.trim() };
}
