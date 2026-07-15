// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/license_headers.ts — apply the BUSL-1.1 SPDX header to FIRST-PARTY source files (idempotent).
//
//   bun run tools/license_headers.ts                 # add missing headers across all roots
//   bun run tools/license_headers.ts --check          # exit 1 if any file is missing one (CI guard)
//   bun run tools/license_headers.ts <file> [<file>…] # operate ONLY on the given files (used by the
//                                                       # pre-commit hook to header just-staged source)
//
// Excludes vendored / third-party / generated trees (vendor/, node_modules/, desktop/release/, .venv,
// __pycache__, dist/) — those keep their OWN licenses and must NOT be relicensed. Explicitly-named files
// are still filtered by the same comment-style + exclusion rules, so passing a vendored path is a no-op.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const COPYRIGHT = "Copyright (c) 2026 TechLead 187 LLC";
const SPDX = "SPDX-License-Identifier: BUSL-1.1";
const ROOTS = ["harness", "desktop", "tools", "scanner-sidecar"];
// "runtimes" holds the bundled third-party binaries + relocatable CPython that fetch-runtimes.ts fetches
// (bun/uv/python-build-standalone, ADR-0225) — a vendored tree that keeps its OWN licenses, never relicensed.
const EXCLUDE_SEGMENTS = new Set(["node_modules", "vendor", ".venv", "__pycache__", "dist", ".git", "runtimes"]);
const EXCLUDE_PREFIXES = ["desktop/release/"]; // packaged build (bundles a copy of the repo + node_modules)
const HASH_EXT = new Set([".py"]);             // "#" comment style
const SLASH_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]); // "//" comment style

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (EXCLUDE_SEGMENTS.has(name)) continue;
    const p = join(dir, name).replace(/\\/g, "/");
    if (EXCLUDE_PREFIXES.some((pre) => p.startsWith(pre))) continue;
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else yield p;
  }
}

function commentStyle(path: string): "hash" | "slash" | null {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot);
  if (HASH_EXT.has(ext)) return "hash";
  if (SLASH_EXT.has(ext)) return "slash";
  return null;
}

// True when a path lives under an excluded tree — applies to both the walk and explicit file args,
// so handing the hook a vendored/generated path is a safe no-op.
function excluded(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  if (EXCLUDE_PREFIXES.some((pre) => p.startsWith(pre))) return true;
  return p.split("/").some((seg) => EXCLUDE_SEGMENTS.has(seg));
}

const args = process.argv.slice(2);
const check = args.includes("--check");
const explicit = args.filter((a) => !a.startsWith("--")); // bare paths → operate only on these
const listModified = args.includes("--list-modified"); // print each rewritten path (pre-commit hook reads this)
let added = 0;
const missing: string[] = [];
const modified: string[] = [];

// Either an explicit file list (pre-commit hook) or a full walk of the first-party roots.
function* candidates(): Generator<string> {
  if (explicit.length) {
    for (const f of explicit) yield f.replace(/\\/g, "/");
    return;
  }
  for (const root of ROOTS) {
    try { yield* walk(root); } catch { /* a root may not exist in every checkout */ }
  }
}

{
  for (const path of candidates()) {
    if (excluded(path)) continue;
    const style = commentStyle(path);
    if (!style) continue;
    // Read directly (no existsSync pre-check — that's a TOCTOU race). An explicit arg may be a
    // staged deletion/rename, so a missing file is simply skipped.
    let src: string;
    try { src = readFileSync(path, "utf8"); } catch { continue; }
    if (src.includes(SPDX)) continue; // already headered — idempotent
    if (check) { missing.push(path); continue; }
    const c = style === "hash" ? "#" : "//";
    const header = `${c} ${COPYRIGHT}\n${c} ${SPDX}\n`;
    // Keep a leading shebang on line 1 (e.g. "#!/usr/bin/env ..."); insert the header right after it.
    let out: string;
    if (src.startsWith("#!")) {
      const nl = src.indexOf("\n");
      const shebang = nl === -1 ? src : src.slice(0, nl + 1);
      out = shebang + header + "\n" + (nl === -1 ? "" : src.slice(nl + 1));
    } else {
      out = header + "\n" + src;
    }
    writeFileSync(path, out);
    modified.push(path);
    added++;
  }
}

if (listModified) for (const p of modified) console.log(`MODIFIED\t${p}`);

if (check) {
  if (missing.length) { console.error(`Missing BUSL-1.1 header in ${missing.length} file(s):\n  ${missing.slice(0, 40).join("\n  ")}`); process.exit(1); }
  console.log("license-headers: all first-party source files carry the BUSL-1.1 header ✓");
} else {
  console.log(`license-headers: added the BUSL-1.1 header to ${added} file(s).`);
}
