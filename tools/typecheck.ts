// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/typecheck.ts - `make typecheck`: run the repo's tsc under bun, from a local disk or a network share.
//
//   bun tools/typecheck.ts [tsc args...]   # cwd = the tsconfig's directory; always adds --noEmit
//
// ADR-0178 amendment (UNC checkouts). Two things break when the cwd is a UNC path (\\server\share\...):
//   - `bun x tsc` resolves the bin to `UNC\server\share\...\node_modules\typescript\bin\tsc` and fails
//     (through node via the shebang, and with --bun alike), so tsc's entry file is run by bun directly;
//   - TypeScript 7's native compiler reads files under a UNC root but its tsconfig `include` walk finds
//     nothing there (TS18003 "No inputs were found"), so on Windows the run goes through cmd's `pushd`,
//     which maps the share to a temporary drive letter for the duration and `popd` releases it.
//
// Nothing user-controlled is ever spliced into a cmd command line (CodeQL #75: the first version joined
// argv into `cmd /c` unescaped, so an argument carrying `&` ran a second command, and a `%` in the cwd was
// expanded). The cwd and the tsc arguments reach cmd through ENVIRONMENT VARIABLES read by a generated batch
// file: cmd expands `%VAR%` exactly once per line and never re-scans the result, delayed (`!`) expansion is
// off, and a `"` cannot occur in a Windows path. tsc reads its arguments from a response file (`@file`, one
// argument per line, quoted), so they are never tokenized by the shell either.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TSC = join("node_modules", "typescript", "bin", "tsc");
const cwd = process.cwd();
const args = ["--noEmit", ...process.argv.slice(2)];

/** One argument per line, quoted so an argument with spaces stays one token for tsc's response-file parser
 *  (which reads a quoted run to the next `"` and knows no escape; a `"` inside a tsc argument is refused). */
function responseFile(list: string[]): string {
  const bad = list.find((a) => a.includes('"'));
  if (bad !== undefined) throw new Error(`typecheck: a tsc argument may not contain a double quote: ${bad}`);
  return list.map((a) => `"${a}"`).join("\r\n") + "\r\n";
}

function runViaPushd(): number {
  const dir = mkdtempSync(join(tmpdir(), "lucid-typecheck-"));
  try {
    const rsp = join(dir, "tsc.rsp");
    const bat = join(dir, "typecheck.cmd");
    writeFileSync(rsp, responseFile(args));
    // Each line is expanded once when it runs, so %errorlevel% on its own line is tsc's real exit status.
    writeFileSync(bat, [
      "@echo off",
      'pushd "%LUCID_TC_CWD%" || exit /b 1',
      '"%LUCID_TC_BUN%" "%LUCID_TC_TSC%" @"%LUCID_TC_RSP%"',
      "set LUCID_TC_RC=%errorlevel%",
      "popd",
      "exit /b %LUCID_TC_RC%",
      "",
    ].join("\r\n"));
    // cmd starts from a local dir: given a UNC cwd it warns and falls back to C:\Windows before pushd runs.
    const r = spawnSync("cmd.exe", ["/d", "/c", bat], {
      cwd: tmpdir(),
      stdio: "inherit",
      env: { ...process.env, LUCID_TC_CWD: cwd, LUCID_TC_BUN: process.execPath, LUCID_TC_TSC: TSC, LUCID_TC_RSP: rsp },
    });
    return r.status ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const status = process.platform === "win32" && cwd.startsWith("\\\\")
  ? runViaPushd()
  : spawnSync(process.execPath, [TSC, ...args], { stdio: "inherit" }).status ?? 1;
process.exit(status);
