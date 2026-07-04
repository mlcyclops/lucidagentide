// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/agent/export.ts — P-AGENT.6 (ADR-0129): enterprise EXPORT. The public core emits a portable,
// tamper-evident AgentBundle plus a per-target manifest (electron / web / cloud); the DEPLOY adapters live in
// the private add-on (lucidagentIDEaddon), matching the public-vs-add-on split (ADR-0068/0069/A012).
//
// "Signed" here = a deterministic SHA-256 content DIGEST over the bundle files (tamper-evidence: `verifyExport`
// recomputes it and rejects a modified package). Cryptographic signing with a managed KEY is an add-on / KMS
// concern (ADR-A012), deliberately not in the public core. The export never widens security posture: the
// agent's egress requests are carried as data for the deploy target to enforce, not auto-granted.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { AgentBundle, BundleFile } from "./compiler.ts";

export const EXPORT_TARGETS = ["electron", "web", "cloud"] as const;
export type ExportTarget = (typeof EXPORT_TARGETS)[number];

/** Deterministic content digest over the bundle files (path + content, path-sorted). Stable for a given
 *  bundle, so the same agent always produces the same digest. */
export function bundleDigest(files: BundleFile[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const h = createHash("sha256");
  for (const f of sorted) {
    h.update(f.path);
    h.update("\0");
    h.update(f.content);
    h.update("\0");
  }
  return `sha256:${h.digest("hex")}`;
}

interface EntryDescriptor {
  runtime: ExportTarget;
  ompExtension: string; // the generated allow-list extension the deploy target loads via `-e`
  systemPrompt: string; // the appended (TAIL) prompt file
  note: string; // where the deploy adapter lives
}

export interface ExportManifest {
  spec_id: string;
  name: string;
  target: ExportTarget;
  bundleVersion: number;
  digest: string;
  files: string[]; // paths of the bundle files covered by `digest` (export.json itself excluded)
  entry: EntryDescriptor;
  egress: string[]; // carried as data for the target to enforce under its own ceiling — never auto-granted
}

export interface ExportPackage {
  target: ExportTarget;
  files: BundleFile[]; // the bundle files + export.json
  manifest: ExportManifest;
}

const ENTRY_NOTE: Record<ExportTarget, string> = {
  electron: "Electron packaging adapter lives in the private add-on (lucidagentIDEaddon).",
  web: "Web-hosting adapter lives in the private add-on (lucidagentIDEaddon).",
  cloud: "Cloud-hosting adapter lives in the private add-on (lucidagentIDEaddon).",
};

/** Package a compiled bundle for an enterprise deploy target. Adds `export.json` (the manifest with the
 *  content digest); the deploy adapter in the add-on consumes it. Pure — writes nothing to disk. */
export function exportBundle(bundle: AgentBundle, target: ExportTarget): ExportPackage {
  const digest = bundleDigest(bundle.files);
  const manifest: ExportManifest = {
    spec_id: bundle.spec_id,
    name: bundle.name,
    target,
    bundleVersion: bundle.manifest.bundleVersion,
    digest,
    files: bundle.files.map((f) => f.path).sort(),
    entry: {
      runtime: target,
      ompExtension: bundle.manifest.extension,
      systemPrompt: "SYSTEM_PROMPT.md",
      note: ENTRY_NOTE[target],
    },
    egress: bundle.manifest.egress,
  };
  const files: BundleFile[] = [...bundle.files, { path: "export.json", content: JSON.stringify(manifest, null, 2) + "\n" }];
  return { target, files, manifest };
}

/** Write an export package's files under `dir` (nested paths honored) and return the written paths. */
export function writeExportPackage(pkg: ExportPackage, dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const f of pkg.files) {
    const p = join(dir, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content);
    written.push(p);
  }
  return written;
}

/** Recompute the digest over the packaged bundle files (excluding export.json) and compare to the manifest.
 *  Fails if any file was added, removed, or modified after export (tamper-evidence). */
export function verifyExport(pkg: ExportPackage): { ok: boolean; reason: string } {
  const bundleFiles = pkg.files.filter((f) => f.path !== "export.json");
  const recomputed = bundleDigest(bundleFiles);
  if (recomputed !== pkg.manifest.digest) {
    return { ok: false, reason: `digest mismatch (tampered?): manifest ${pkg.manifest.digest}, actual ${recomputed}` };
  }
  return { ok: true, reason: "digest verified" };
}
