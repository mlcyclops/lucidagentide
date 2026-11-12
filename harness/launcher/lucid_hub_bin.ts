#!/usr/bin/env bun
// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/launcher/lucid_hub_bin.ts - the `lucid-hub` bin entry (package.json "bin"), a thin
// forwarder equivalent to running `lucid hub <argv...>`: the `sub === "hub"` branch in
// lucid_acp.ts (which lazy-imports runHubCli so pi-tui and the discovery client stay out of
// the OTHER subcommands' startup paths; this bin runs nothing but the hub, so a static import
// has no path to keep it out of). runHubCli takes env only today, so bare-launch parity is
// the contract: argv is not interpreted here, exactly as `lucid hub` ignores its rest in
// lucid_acp.ts.

import { runHubCli } from "./hub_tui.ts";

if (import.meta.main) {
  runHubCli(process.env)
    .then((code) => process.exit(code))
    .catch((e) => { process.stderr.write(`[lucid hub] fatal: ${String(e)}\n`); process.exit(1); });
}
