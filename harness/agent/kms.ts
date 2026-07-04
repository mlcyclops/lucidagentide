// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/agent/kms.ts — P-AGENT.16 (ADR-0144): the PURE half of provider-sourced secrets. Collects an
// agent spec's machine-resolvable credential refs into the request artifact the enterprise kms connector
// consumes (`connectors/kms/src/cli.ts fetch --file <request>`, add-on ADR-A014):
//
//   { "out": "<env-file path>", "requests": [{ "name": "<SecretRef name>", "ref": "vault:…#field" }] }
//
// The connector resolves ALL-OR-NOTHING into `out` (mode 0600, values never on stdout); the desktop glue
// (agent_run.ts) injects the env file into that run's child processes and DELETES it immediately. This
// module never touches secrets — it only names them.

import type { AgentSpec } from "./spec.ts";

export interface KmsFetchRequest {
  out: string;
  requests: Array<{ name: string; ref: string }>;
}

/** Build the connector request for a spec's provider-sourced secrets, or null when it declares none.
 *  Only secrets carrying `provisioning.provider` participate — vault-pasted credentials stay on the
 *  existing OS-vault path (ADR-0144: the connector is an enhancement, never a new requirement). */
export function buildKmsFetchRequest(spec: AgentSpec, outPath: string): KmsFetchRequest | null {
  const requests = (spec.secrets ?? [])
    .filter((s) => s.provisioning?.provider?.ref)
    .map((s) => ({ name: s.name, ref: s.provisioning!.provider!.ref }));
  return requests.length ? { out: outPath, requests } : null;
}
