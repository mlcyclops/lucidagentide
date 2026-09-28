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

import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const cwd = process.cwd();
const args = ["node_modules/typescript/bin/tsc", "--noEmit", ...process.argv.slice(2)];
const r = process.platform === "win32" && cwd.startsWith("\\\\")
  // cmd starts from a local dir: given a UNC cwd it warns and falls back to C:\Windows before pushd runs.
  ? spawnSync("cmd.exe", ["/d", "/v:on", "/s", "/c", `"pushd "${cwd}" && ("${process.execPath}" ${args.join(" ")} & set "rc=!errorlevel!" & popd & exit /b !rc!)"`], { cwd: tmpdir(), stdio: "inherit", windowsVerbatimArguments: true })
  : spawnSync(process.execPath, args, { stdio: "inherit" });
process.exit(r.status ?? 1);
