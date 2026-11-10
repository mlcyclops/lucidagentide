// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0535): the entry stage.ts bundles into client.js, run by Bun: `lucid herd [args]` runs it
// with the IDE's bundled bun, and a detached server is this same file with `server start`.

import { runHerdCli } from "./cli.ts";

runHerdCli(process.argv.slice(2), process.env, process.argv[1] ?? "")
  .then((code) => process.exit(code))
  .catch((e) => { process.stderr.write(`[herd] fatal: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
