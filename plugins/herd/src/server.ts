// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0535): the entry stage.ts bundles into server.js, the package's `entry.main`. The IDE's
// plugin runtime runs it under Electron's Node; runtime_host.ts serves /healthz and runs instance
// main (the P-HERD.1 hub server, hub_server.ts) under the IDE's bun.

import { runRuntimeHost } from "./runtime_host.ts";

runRuntimeHost(process.env)
  .then((code) => process.exit(code))
  .catch((e) => { process.stderr.write(`[herd] fatal: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
