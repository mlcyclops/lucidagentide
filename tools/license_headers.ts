// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/license_headers.ts — apply the BUSL-1.1 SPDX header to FIRST-PARTY source files (idempotent).
//
//   bun run tools/license_headers.ts          # add missing headers
//   bun run tools/license_headers.ts --check   # exit 1 if any file is missing one (CI guard)
//
// Excludes vendored / third-party / generated trees (vendor/, node_modules/, desktop/release/, .venv,
// __pycache__, dist/) — those keep their OWN licenses and must NOT be relicensed.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const COPYRIGHT = "Copyright (c) 2026 TechLead 187 LLC";
const SPDX = "SPDX-License-Identifier: BUSL-1.1";
const ROOTS = ["harness", "desktop", "tools", "scanner-sidecar"];
const EXCLUDE_SEGMENTS = new Set(["node_modules", "vendor", ".venv", "__pycache__", "dist", ".git"]);
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

const check = process.argv.includes("--check");
let added = 0;
const missing: string[] = [];

for (const root of ROOTS) {
  let files: string[];
  try { files = [...walk(root)]; } catch { continue; } // a root may not exist in every checkout
  for (const path of files) {
    const style = commentStyle(path);
    if (!style) continue;
    const src = readFileSync(path, "utf8");
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
    added++;
  }
}

if (check) {
  if (missing.length) { console.error(`Missing BUSL-1.1 header in ${missing.length} file(s):\n  ${missing.slice(0, 40).join("\n  ")}`); process.exit(1); }
  console.log("license-headers: all first-party source files carry the BUSL-1.1 header ✓");
} else {
  console.log(`license-headers: added the BUSL-1.1 header to ${added} file(s).`);
}
