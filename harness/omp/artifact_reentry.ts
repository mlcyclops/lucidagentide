// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/artifact_reentry.ts
//
// P-CTX.2a (ADR-0578): gate a LOCAL tool result that reads back an artifact an external source wrote.
//
// omp saves a large MCP result whole as a session artifact and tells the model to read the rest with
// `read artifact://<n>:<from>-<to>`. That read is a local built-in tool, which the MCP result gate leaves
// untouched by design (ADR-0152). Without this module the page comes back with no envelope at all, which
// breaks invariant 5: external text enters the prompt only inside UNTRUSTED_CONTENT_START / _END.
//
// WHAT IT DOES. For a non-MCP tool result whose INPUT names an artifact (see `artifactRefs`), it asks the
// provenance ledger who wrote that artifact:
//   - no external artifact is named          -> unchanged (a local spill reads back as local output does today)
//   - a named artifact is quarantined        -> withheld
//   - a named artifact is untrusted/suspicious, or the ledger cannot answer
//                                            -> the page is scanned (strict policy) and, if it passes,
//                                               wrapped in the untrusted envelope with the artifact's label
//
// The whole artifact was already scanned when it was spilled (mcp_result_gate.ts), so this second scan of
// the page is defence in depth; the envelope is the part that is new.
//
// FAIL-CLOSED (invariant 3). A dead scanner or a page over the scan limit withholds the page.

import type { TrustLabel } from "../contracts.ts";
import { UNTRUSTED_END, UNTRUSTED_START } from "../prompt/assembler.ts";
import { neutralizeDelimiters } from "../prompt/untrusted.ts";
import { DEFAULT_POLICY } from "../security/gate.ts";
import { scanAndDecideLarge } from "../security/large_scan.ts";
import type { ScannerClient } from "../security/scanner_client.ts";
import { artifactRefs, worseLabel, type SpillAccess, type SpillRecord } from "../security/spill_provenance.ts";
import type { GatedResult, McpContent } from "./mcp_result_gate.ts";

/** The slice of a tool_result event this gate reads. */
export interface ReentryInput {
  toolName?: string;
  input?: unknown;
  content: McpContent[];
}

/** The replacement text when a read of an external artifact is withheld. */
export function reentryBlockNotice(ids: readonly string[], reason: string): string {
  const which = ids.length > 0 ? `artifact ${ids.join(", ")}` : "the session artifacts";
  return `[BLOCKED by Lucid: this read of ${which} is withheld - ${reason}. The content came from an external source.]`;
}

/** Wrap a page of an external artifact as delimited, trust-labeled untrusted data (never `trusted`). */
export function wrapArtifactPage(ids: readonly string[], sources: readonly string[], trust: TrustLabel, text: string): string {
  const label: TrustLabel = trust === "suspicious" ? "suspicious" : "untrusted";
  const header = `[artifact ids="${ids.join(",")}" source="${neutralizeDelimiters(sources.join(","))}" trust="${label}"]`;
  return `${UNTRUSTED_START}\n${header}\n${neutralizeDelimiters(text)}\n${UNTRUSTED_END}`;
}

/** Gate one non-MCP tool result. `undefined` leaves it unchanged. */
export async function gateArtifactReentry(
  scanner: ScannerClient,
  ev: ReentryInput,
  access: SpillAccess | null,
): Promise<GatedResult | undefined> {
  if (access === null || !access.ledger.hasExternal()) return undefined; // nothing external was ever spilled
  const refs = artifactRefs(ev.input, access.artifactsDir);
  if (refs.ids.length === 0 && !refs.wholeDir) return undefined;

  // Which named artifacts are external? An id the ledger cannot vouch for counts as external (fail-closed).
  const records: SpillRecord[] = [];
  const ids: string[] = [];
  let unvouched = false;
  for (const id of refs.ids) {
    const found = access.ledger.lookup(id);
    if (found.state === "known") {
      records.push(found.record);
      ids.push(id);
    } else if (found.state === "unreadable") {
      unvouched = true;
      ids.push(id);
    }
  }
  if (refs.wholeDir) {
    for (const rec of access.ledger.records()) {
      if (!ids.includes(rec.omp_artifact_id)) {
        records.push(rec);
        ids.push(rec.omp_artifact_id);
      }
    }
    if (access.ledger.unreadable) unvouched = true;
  }
  if (records.length === 0 && !unvouched) return undefined; // only local artifacts were named

  if (records.some((r) => r.trust_label === "quarantined")) {
    return { content: [{ type: "text", text: reentryBlockNotice(ids, "it holds a quarantined tool result") }], isError: true };
  }

  const text = ev.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
  const images = ev.content.flatMap((c) => (c.type === "image" ? [c] : []));
  const decision = await scanAndDecideLarge(scanner, text, DEFAULT_POLICY);
  if (decision.block) {
    return { content: [{ type: "text", text: reentryBlockNotice(ids, decision.reason) }], isError: true };
  }

  let trust: TrustLabel = decision.trustLabel === "suspicious" ? "suspicious" : "untrusted";
  for (const r of records) trust = worseLabel(trust, r.trust_label);
  const sources = [...new Set(records.map((r) => r.source))];
  if (unvouched) sources.push("unknown");
  return { content: [{ type: "text", text: wrapArtifactPage(ids, sources, trust, text) }, ...images] };
}
