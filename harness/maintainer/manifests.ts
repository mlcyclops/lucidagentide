// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/maintainer/manifests.ts
//
// P-MAINT.1: dependency manifest DISCOVERY + PARSING for a Maintainer Agent. PURE - parseManifest
// takes the path (for the format decision and for provenance) plus the already-read text, and
// discoverManifests takes an INJECTED directory lister, so the whole module is unit-testable with
// fixtures and never touches the filesystem itself.
//
// HONESTY RULES that shape the code:
//   [1] Unparseable content NEVER throws. It becomes an error string, so one broken manifest can
//       never take the sweep down and can never be mistaken for "this repo has no dependencies".
//   [2] A declared version is recorded as DECLARED (range prefixes stripped, `v` kept on go.mod)
//       rather than resolved. Resolution needs a lockfile or a registry; inventing a resolved
//       version would put a wrong number in front of an advisory query.
//   [3] A requirement that is not a registry version (a `-r` include, an editable install, a VCS or
//       path dependency) is reported as an ERROR entry, not dropped. An audit that silently skips
//       what it cannot read is worse than one that says so.

import type { DepEntry, Ecosystem } from "./contracts.ts";

type Format = "package.json" | "requirements.txt" | "pyproject.toml" | "Cargo.toml" | "go.mod";

/**
 * CANONICAL manifest filename -> parser. Every one of these ecosystems requires its exact spelling
 * (npm demands lowercase `package.json`, cargo demands `Cargo.toml`), so DISCOVERY matches these
 * keys exactly: a case variant is a different, unrelated file, and matching it loosely would both
 * pick up junk and produce duplicate paths on a case-insensitive filesystem.
 *
 * Small, static, string-keyed: a Record, not a Map.
 */
const SUPPORTED: Record<string, Format> = {
  "package.json": "package.json",
  "requirements.txt": "requirements.txt",
  "pyproject.toml": "pyproject.toml",
  "Cargo.toml": "Cargo.toml",
  "go.mod": "go.mod",
};

/**
 * The same table folded to lowercase. parseManifest is deliberately more forgiving than discovery:
 * it may be handed a path a human typed, and refusing `repo/cargo.toml` there would be pedantry.
 */
const SUPPORTED_LOWER: Record<string, Format> = Object.fromEntries(
  Object.entries(SUPPORTED).map(([name, format]) => [name.toLowerCase(), format]),
);

/** Subdirectories one level down that commonly hold a second manifest in this repo's shape. */
const SOURCE_DIRS: readonly string[] = [
  "src", "lib", "app", "apps", "packages", "server", "client", "backend", "frontend",
  "cmd", "tools", "scripts", "services", "scanner-sidecar", "harness", "desktop",
];

export interface ParseResult { deps: DepEntry[]; errors: string[] }

function basename(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const cut = norm.lastIndexOf("/");
  return cut < 0 ? norm : norm.slice(cut + 1);
}

/** Join with forward slashes on every platform: deterministic output, and Windows accepts them. */
function joinPath(a: string, b: string): string {
  const left = a.replace(/[\\/]+$/, "");
  return left.length === 0 ? b : `${left}/${b}`;
}

/** Strip an npm/cargo/poetry range prefix down to the version it anchors on. */
function stripRange(spec: string): string {
  const s = spec.trim();
  if (s.length === 0) return "*";
  // Not a version at all: a workspace/file/link/git/npm-alias spec. Recorded verbatim so a consumer
  // can see exactly what the manifest said instead of a fabricated number.
  if (/^(workspace|file|link|git|git\+|npm|portal|catalog|patch):/.test(s)) return s;
  if (/^(https?|ssh):\/\//.test(s)) return s;
  const m = /^[\^~>=<]*\s*v?(\d[^\s,|]*)/.exec(s);
  return m?.[1] ?? s;
}

// --- package.json ------------------------------------------------------------------------------

function parsePackageJson(path: string, text: string, out: ParseResult): void {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    out.errors.push(`${path}: not valid JSON (${e instanceof Error ? e.message : String(e)})`);
    return;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    out.errors.push(`${path}: top level must be a JSON object`);
    return;
  }
  const rec = doc as Record<string, unknown>;
  let sawAny = false;
  for (const field of ["dependencies", "devDependencies"] as const) {
    const block = rec[field];
    if (block === undefined) continue;
    if (block === null || typeof block !== "object" || Array.isArray(block)) {
      out.errors.push(`${path}: "${field}" must be an object of name -> version`);
      continue;
    }
    sawAny = true;
    // Checked immediately above: non-null, object, not an array. Named so the assertion is visible.
    const table: Record<string, unknown> = block as Record<string, unknown>;
    for (const [name, spec] of Object.entries(table)) {
      if (typeof spec !== "string") {
        out.errors.push(`${path}: "${field}.${name}" must be a string, got ${typeof spec}`);
        continue;
      }
      out.deps.push({ ecosystem: "npm", name, version: stripRange(spec), manifest: path });
    }
  }
  if (!sawAny) out.errors.push(`${path}: no dependencies or devDependencies block`);
}

// --- PEP 508 requirement (shared by requirements.txt and pyproject) -----------------------------

function parseRequirement(spec: string): { name: string; version: string } | null {
  // Drop an environment marker, then extras, then read the first comparator.
  const body = spec.split(";")[0]?.trim() ?? "";
  if (body.length === 0) return null;
  if (/^(-|\.|\/)/.test(body)) return null;
  if (/^[a-z+]+(\+[a-z]+)?:\/\//i.test(body) || /@\s*(git|https?|file)/i.test(body)) return null;
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/.exec(body);
  const name = m?.[1];
  if (!name) return null;
  const rest = (m?.[3] ?? "").trim();
  if (rest.length === 0) return { name, version: "*" };
  const v = /(===|==|~=|>=|<=|!=|>|<)\s*v?([^,\s]+)/.exec(rest);
  const raw = v?.[2];
  if (!raw) return null;
  return { name, version: raw.replace(/\.\*$/, "").replace(/\*$/, "") || "*" };
}

function parseRequirementsTxt(path: string, text: string, out: ParseResult): void {
  const lines = text.split(/\r?\n/);
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (/^(-r|--requirement|-c|--constraint)\b/.test(line)) {
      out.errors.push(`${path}:${i + 1}: include not followed (${line}); the referenced file must be discovered and parsed on its own`);
      continue;
    }
    if (/^(-e|--editable)\b/.test(line)) {
      out.errors.push(`${path}:${i + 1}: editable install not auditable (${line})`);
      continue;
    }
    if (line.startsWith("-")) {
      out.errors.push(`${path}:${i + 1}: pip option not a dependency (${line})`);
      continue;
    }
    const req = parseRequirement(line);
    if (!req) {
      out.errors.push(`${path}:${i + 1}: not a registry requirement (${line})`);
      continue;
    }
    seen++;
    out.deps.push({ ecosystem: "pypi", name: req.name, version: req.version, manifest: path });
  }
  if (seen === 0 && out.errors.length === 0) out.errors.push(`${path}: no requirements found`);
}

// --- TOML (pyproject.toml, Cargo.toml) ---------------------------------------------------------

/** Every double- or single-quoted string in a fragment, in order. */
function tomlStrings(fragment: string): string[] {
  const found: string[] = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'/g;
  let m = re.exec(fragment);
  while (m !== null) {
    found.push(m[1] ?? m[2] ?? "");
    m = re.exec(fragment);
  }
  return found;
}

/** The `version = "x"` inside an inline table, or null when the table declares no version. */
function inlineTableVersion(fragment: string): string | null {
  const m = /\bversion\s*=\s*("([^"]*)"|'([^']*)')/.exec(fragment);
  return m?.[2] ?? m?.[3] ?? null;
}

interface TomlLine { section: string; text: string; line: number }

/** Flatten TOML into (section, line) pairs. Enough for dependency tables; not a full TOML parser. */
function tomlLines(text: string): TomlLine[] {
  const rows: TomlLine[] = [];
  let section = "";
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] ?? "").trim();
    if (raw.length === 0 || raw.startsWith("#")) continue;
    const head = /^\[\[?([^\]]+)\]\]?$/.exec(raw);
    if (head?.[1]) {
      section = head[1].trim();
      continue;
    }
    rows.push({ section, text: raw, line: i + 1 });
  }
  return rows;
}

function parsePyproject(path: string, text: string, out: ParseResult): void {
  const rows = tomlLines(text);
  let seen = 0;
  // A [project] dependencies key that IS present but empty is a legitimate zero-dependency project
  // (this repository's own scanner-sidecar is one, deliberately), so it must not read as an error.
  let sawProjectArray = false;

  // [project] dependencies = [ "a>=1", "b==2" ] - possibly spread over several lines.
  const flat = text.split(/\r?\n/);
  let inProject = false;
  let collecting = false;
  let depth = 0;
  let buf = "";
  let startLine = 0;
  for (let i = 0; i < flat.length; i++) {
    const raw = (flat[i] ?? "").trim();
    if (/^\[\[?[^\]]+\]\]?$/.test(raw)) {
      inProject = raw === "[project]";
      continue;
    }
    if (!collecting && inProject && /^dependencies\s*=\s*\[/.test(raw)) {
      collecting = true;
      depth = 0;
      buf = "";
      startLine = i + 1;
    }
    if (!collecting) continue;
    buf += `${raw}\n`;
    for (const ch of raw) {
      if (ch === "[") depth++;
      else if (ch === "]") depth--;
    }
    if (depth <= 0) {
      collecting = false;
      const specs = tomlStrings(buf.slice(buf.indexOf("[")));
      sawProjectArray = true;
      for (const spec of specs) {
        const req = parseRequirement(spec);
        if (!req) {
          out.errors.push(`${path}:${startLine}: not a registry requirement in [project] dependencies (${spec})`);
          continue;
        }
        seen++;
        out.deps.push({ ecosystem: "pypi", name: req.name, version: req.version, manifest: path });
      }
    }
  }

  // [tool.poetry.dependencies] and [tool.poetry.group.<g>.dependencies] tables.
  for (const row of rows) {
    if (!/^tool\.poetry\.(group\.[^.]+\.)?(dev-)?dependencies$/.test(row.section)) continue;
    const kv = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=\s*(.+)$/.exec(row.text);
    const name = kv?.[1];
    const value = kv?.[2]?.trim();
    if (!name || !value) {
      out.errors.push(`${path}:${row.line}: unreadable poetry dependency line (${row.text})`);
      continue;
    }
    if (name.toLowerCase() === "python") continue; // interpreter constraint, not a package
    if (value.startsWith("{")) {
      const ver = inlineTableVersion(value);
      if (ver === null) {
        out.errors.push(`${path}:${row.line}: poetry dependency "${name}" declares no version (${value}); a git/path dependency is not auditable against a registry`);
        continue;
      }
      seen++;
      out.deps.push({ ecosystem: "pypi", name, version: stripRange(ver), manifest: path });
      continue;
    }
    const lits = tomlStrings(value);
    const lit = lits[0];
    if (lit === undefined) {
      out.errors.push(`${path}:${row.line}: poetry dependency "${name}" has a non-string version (${value})`);
      continue;
    }
    seen++;
    out.deps.push({ ecosystem: "pypi", name, version: stripRange(lit), manifest: path });
  }

  if (seen === 0 && !sawProjectArray && out.errors.length === 0) out.errors.push(`${path}: no [project] dependencies and no [tool.poetry.dependencies]`);
}

function parseCargoToml(path: string, text: string, out: ParseResult): void {
  const rows = tomlLines(text);
  let seen = 0;
  const tables: Record<string, true> = { dependencies: true, "dev-dependencies": true, "build-dependencies": true };
  for (const row of rows) {
    // Plain table: [dependencies] name = "1.2" | name = { version = "1.2" }
    if (tables[row.section] === true) {
      const kv = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=\s*(.+)$/.exec(row.text);
      const name = kv?.[1];
      const value = kv?.[2]?.trim();
      if (!name || !value) {
        out.errors.push(`${path}:${row.line}: unreadable cargo dependency line (${row.text})`);
        continue;
      }
      if (value.startsWith("{")) {
        const ver = inlineTableVersion(value);
        if (ver === null) {
          out.errors.push(`${path}:${row.line}: cargo dependency "${name}" declares no version (${value}); a git/path dependency is not auditable against crates.io`);
          continue;
        }
        seen++;
        out.deps.push({ ecosystem: "cargo", name, version: stripRange(ver), manifest: path });
        continue;
      }
      const lit = tomlStrings(value)[0];
      if (lit === undefined) {
        out.errors.push(`${path}:${row.line}: cargo dependency "${name}" has a non-string version (${value})`);
        continue;
      }
      seen++;
      out.deps.push({ ecosystem: "cargo", name, version: stripRange(lit), manifest: path });
      continue;
    }
    // Dotted sub-table: [dependencies.serde] followed by version = "1.0"
    const dotted = /^(dependencies|dev-dependencies|build-dependencies)\.([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(row.section);
    const dottedName = dotted?.[2];
    if (dottedName) {
      const lit = /^version\s*=\s*(.+)$/.exec(row.text);
      if (!lit?.[1]) continue;
      const ver = tomlStrings(lit[1])[0];
      if (ver === undefined) continue;
      seen++;
      out.deps.push({ ecosystem: "cargo", name: dottedName, version: stripRange(ver), manifest: path });
    }
  }
  if (seen === 0 && out.errors.length === 0) out.errors.push(`${path}: no [dependencies] table`);
}

// --- go.mod ------------------------------------------------------------------------------------

function parseGoMod(path: string, text: string, out: ParseResult): void {
  const lines = text.split(/\r?\n/);
  let block: "require" | "other" | null = null;
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").replace(/\/\/.*$/, "").trim();
    if (line.length === 0) continue;
    if (block !== null) {
      if (line === ")") {
        block = null;
        continue;
      }
      if (block === "other") continue;
      const parts = line.split(/\s+/);
      const name = parts[0];
      const version = parts[1];
      if (!name || !version) {
        out.errors.push(`${path}:${i + 1}: require line missing a version (${line})`);
        continue;
      }
      seen++;
      out.deps.push({ ecosystem: "go", name, version, manifest: path });
      continue;
    }
    const open = /^(require|replace|exclude|retract)\s*\($/.exec(line);
    if (open?.[1]) {
      block = open[1] === "require" ? "require" : "other";
      continue;
    }
    const single = /^require\s+(\S+)\s+(\S+)$/.exec(line);
    if (single?.[1] && single[2]) {
      seen++;
      out.deps.push({ ecosystem: "go", name: single[1], version: single[2], manifest: path });
      continue;
    }
    if (/^require\b/.test(line)) out.errors.push(`${path}:${i + 1}: unreadable require directive (${line})`);
  }
  if (block !== null) out.errors.push(`${path}: unterminated ${block} block`);
  if (seen === 0 && out.errors.length === 0) out.errors.push(`${path}: no require directives`);
}

// --- entry points ------------------------------------------------------------------------------

/**
 * Parse one manifest. The format comes from the basename; unsupported names and unreadable content
 * both come back as error strings so a caller can surface them as manifest-error findings.
 */
export function parseManifest(path: string, text: string): ParseResult {
  const out: ParseResult = { deps: [], errors: [] };
  const format = SUPPORTED_LOWER[basename(path).toLowerCase()];
  if (format === undefined) {
    out.errors.push(`${path}: unsupported manifest (known: ${Object.keys(SUPPORTED).join(", ")})`);
    return out;
  }
  if (text.trim().length === 0) {
    out.errors.push(`${path}: empty file`);
    return out;
  }
  try {
    if (format === "package.json") parsePackageJson(path, text, out);
    else if (format === "requirements.txt") parseRequirementsTxt(path, text, out);
    else if (format === "pyproject.toml") parsePyproject(path, text, out);
    else if (format === "Cargo.toml") parseCargoToml(path, text, out);
    else parseGoMod(path, text, out);
  } catch (e) {
    // Belt and braces: a parser bug degrades to an error entry, never a thrown sweep.
    out.errors.push(`${path}: parser failed (${e instanceof Error ? e.message : String(e)})`);
  }
  return out;
}

/**
 * Find the supported manifests at `root` and one level into the common source directories. The
 * directory lister is injected (it returns entry NAMES for a directory, and may throw for a missing
 * one), so discovery is testable without a filesystem.
 */
export function discoverManifests(root: string, list: (dir: string) => string[]): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const scan = (dir: string): void => {
    let entries: string[];
    try {
      entries = list(dir);
    } catch {
      return; // an unreadable directory is not a finding, it is simply not there
    }
    for (const entry of entries) {
      if (SUPPORTED[entry] === undefined) continue;
      const full = joinPath(dir, entry);
      if (seen.has(full)) continue;
      seen.add(full);
      found.push(full);
    }
  };
  // Normalize a trailing separator once, so the injected lister and every emitted path agree.
  const trimmed = root.replace(/[\\/]+$/, "");
  const base = trimmed.length > 0 ? trimmed : root;
  scan(base);
  for (const sub of SOURCE_DIRS) scan(joinPath(base, sub));
  return found;
}

/** Exported for the sweep's ecosystem-aware messaging and for tests. */
export const MANIFEST_ECOSYSTEMS: Record<Format, Ecosystem> = {
  "package.json": "npm",
  "requirements.txt": "pypi",
  "pyproject.toml": "pypi",
  "Cargo.toml": "cargo",
  "go.mod": "go",
};
