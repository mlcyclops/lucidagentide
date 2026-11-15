// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/ask_lucid_screen.ts - P-ASKLUCID.3 (ADR-0584): what is on the user's screen, as text Lucid can read.
//
// The renderer walks what is DRAWN (desktop/renderer/screen_digest.ts) and hands the result to
// `normalizeScreen`, which is the only way a digest is built: on the renderer before it is sent, and again
// on the engine when it arrives, because the engine never trusts a shape it was posted.
//
// Why text and not a picture: every byte Lucid reads passes the scanner and is fenced as untrusted
// (invariants 3 and 5), and the scanner reads text. The side completion is text-only, and most local models
// have no vision.
//
// WHAT IS NEVER IN A DIGEST: anything the user typed (the collector skips input, textarea and password
// values), and anything shaped like a key or token (`redactSecrets`, applied to every string here).
//
// Pure, and without imports: the renderer bundles this file.

export interface ScreenSurface {
  /** What kind of surface it is: "Dialog", "Fleet grid", "Chat", "Preview panel"... */
  kind: string;
  /** Its own title, when it has one. */
  title: string;
  /** Its visible text, line by line. */
  text: string;
}

/** The page shown in the Preview panel, as its own inspect bridge reports it. */
export interface ScreenPreview {
  tab: string;
  title: string;
  url: string;
  text: string;
  headings: string[];
  errors: string[];
}

export interface ScreenDigest {
  /** Top surface first: a dialog comes before the panel it covers. */
  surfaces: ScreenSurface[];
  /** Short harness-written facts: the role, whether a turn is running, the window size. */
  facts: string[];
  preview: ScreenPreview | null;
}

export const SCREEN_LIMITS = {
  surfaces: 8,
  kind: 40,
  title: 120,
  /** Characters of visible text kept per surface. */
  text: 1800,
  /** Characters of visible text kept across all surfaces. */
  total: 7000,
  facts: 8,
  fact: 160,
  previewText: 1400,
  headings: 12,
  heading: 120,
  errors: 5,
  error: 200,
} as const;

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export const REDACTED = "[redacted]";

/** Shapes that are keys, tokens or credentials wherever they appear. */
const SECRET_SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // a JSON web token
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
];
/** `password: hunter2`, `api_key=abc123`: the label stays, the value goes. */
const LABELLED_SECRET = /\b(pass(?:word|wd|phrase)?|secret|token|api[ _-]?key|access[ _-]?key|auth(?:orization)?)(\s*[:=]\s*)(?!\[redacted\])("[^"\n]{4,}"|'[^'\n]{4,}'|[^\s,;]{6,})/gi;
/** A long unbroken run of key-like characters. No slash in the class, so a file path is never one run. */
const LONG_RUN = /[A-Za-z0-9+_=-]{32,}/g;
const HEX_ONLY = /^[0-9a-fA-F]+$/;

/** PURE: `text` with anything shaped like a key, token or password value replaced by `[redacted]`. It errs
 *  toward removing: a long run goes when it is random-looking (upper case, lower case and digits together)
 *  or a hash of 40 or more hex digits. A file path, a kebab-case name and a UUID stay. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const shape of SECRET_SHAPES) out = out.replace(shape, REDACTED);
  out = out.replace(LABELLED_SECRET, (_m, label: string, sep: string) => `${label}${sep}${REDACTED}`);
  out = out.replace(LONG_RUN, (run) => ((HEX_ONLY.test(run) && run.length >= 40) || (/[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run)) ? REDACTED : run));
  return out;
}

/** C0 controls except tab and newline, DEL, and the Unicode line and paragraph separators. Built from
 *  escapes so no such character sits in this source file. */
const CONTROLS = new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f\\u2028\\u2029]+", "g");

/** One line, bounded and redacted. */
function line(v: unknown, max: number): string {
  const s = redactSecrets(str(v).replace(CONTROLS, " ").replace(/\s+/g, " ").trim());
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Many lines, bounded and redacted: runs of spaces collapse, blank lines and repeated lines are dropped. */
function lines(v: unknown, max: number): string {
  const out: string[] = [];
  let last = "";
  for (const raw of str(v).replace(CONTROLS, " ").split(/\r?\n/)) {
    const l = raw.replace(/[ \t]+/g, " ").trim();
    if (!l || l === last) continue;
    out.push(l);
    last = l;
  }
  const s = redactSecrets(out.join("\n"));
  return s.length > max ? `${s.slice(0, max)}\n[cut: ${s.length - max} more characters]` : s;
}

function list(v: unknown, count: number, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const l = line(item, max);
    if (l && !out.includes(l)) out.push(l);
    if (out.length >= count) break;
  }
  return out;
}

/** PURE: a digest from whatever was collected or posted, or null when it holds nothing. Every string is
 *  bounded and redacted, unknown fields are dropped, and the total text is capped with the TOP surfaces
 *  winning, so a long chat underneath cannot crowd out the dialog the user is looking at. */
export function normalizeScreen(raw: unknown): ScreenDigest | null {
  const r = rec(raw);
  if (!r) return null;
  const surfaces: ScreenSurface[] = [];
  let budget: number = SCREEN_LIMITS.total;
  for (const item of Array.isArray(r.surfaces) ? r.surfaces : []) {
    if (surfaces.length >= SCREEN_LIMITS.surfaces) break;
    const s = rec(item);
    if (!s) continue;
    const kind = line(s.kind, SCREEN_LIMITS.kind) || "Panel";
    const title = line(s.title, SCREEN_LIMITS.title);
    const text = budget > 0 ? lines(s.text, Math.min(SCREEN_LIMITS.text, budget)) : "";
    if (!title && !text) continue;
    budget -= text.length;
    surfaces.push({ kind, title, text });
  }
  const p = rec(r.preview);
  let preview: ScreenPreview | null = null;
  if (p) {
    preview = {
      tab: line(p.tab, 60),
      title: line(p.title, SCREEN_LIMITS.title),
      url: line(p.url, 300),
      text: lines(p.text, SCREEN_LIMITS.previewText),
      headings: list(p.headings, SCREEN_LIMITS.headings, SCREEN_LIMITS.heading),
      errors: list(p.errors, SCREEN_LIMITS.errors, SCREEN_LIMITS.error),
    };
    if (!preview.title && !preview.url && !preview.text && preview.headings.length === 0 && preview.errors.length === 0) preview = null;
  }
  const facts = list(r.facts, SCREEN_LIMITS.facts, SCREEN_LIMITS.fact);
  if (surfaces.length === 0 && !preview && facts.length === 0) return null;
  return { surfaces, facts, preview };
}

/** PURE: the digest as the text Lucid is shown, and how many surfaces it holds. */
export function screenContext(d: ScreenDigest | null): { text: string; surfaces: number } {
  if (!d) return { text: "The screen could not be read just now.", surfaces: 0 };
  const out: string[] = [];
  if (d.facts.length > 0) out.push(d.facts.map((f) => `- ${f}`).join("\n"));
  d.surfaces.forEach((s, i) => {
    const where = i === 0 && d.surfaces.length > 1 ? " (on top)" : "";
    out.push(`### ${s.kind}${s.title && s.title !== s.kind ? `: ${s.title}` : ""}${where}\n${s.text || "(no readable text)"}`);
  });
  if (d.preview) {
    const p = d.preview;
    const rows = [`### Preview panel content${p.tab ? ` (tab: ${p.tab})` : ""}`];
    if (p.title) rows.push(`Page title: ${p.title}`);
    if (p.url) rows.push(`Address: ${p.url}`);
    if (p.headings.length > 0) rows.push(`Headings: ${p.headings.join(" | ")}`);
    if (p.errors.length > 0) rows.push(`Script errors: ${p.errors.join(" | ")}`);
    if (p.text) rows.push(p.text);
    out.push(rows.join("\n"));
  }
  return { text: out.join("\n\n"), surfaces: d.surfaces.length + (d.preview ? 1 : 0) };
}
