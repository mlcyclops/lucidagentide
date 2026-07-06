// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/skill_publish.ts — P-SKILLREG.2 (ADR-0102): the skill PUBLISH seam (the write counterpart to
// the P-SKILLREG.1 reader). Codified skills (from Skill Studio, ADR-0101) are published as versioned,
// optionally-signed artifacts to a registry. PUBLIC ships ONLY this seam + the default LOCAL publisher;
// the remote publishers (cloud OCI registries + custom git providers) are private add-on IP (ADR-A014/A015)
// that implement the SAME `RegistryPublisher` interface and register via registerPublisher().
//
// Mirrors the SIEM `Sink`/`AuditDispatcher` (ADR-0069): FAIL-SAFE, never fail-open. A dead/missing/throwing
// publisher NEVER throws into a turn — every publish is wrapped (per-publisher + per-dispatch) and yields a
// failed/no-op receipt instead. A remote target with no configured publisher is a clean no-op.
//
// SECURITY (CLAUDE.md #1/#3, keystone #2): the WRITE side stores an artifact; TRUST is still established on
// the READ side (P-SKILLREG.1: verify-signature → scan-gate → install) — publishing something never makes it
// trusted or auto-installed. A local publish is a filesystem write confined by pathWithin; a remote publish
// (private) routes through the egress gate. Local signing is OPTIONAL: an unsigned local artifact is stored
// but is NOT installable through the signature-gated reader until a trusted key signs it (honest by design).

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { managedConfig, type ManagedSkillRegistry } from "./managed_config.ts";
import { pathWithin } from "./path_guard.ts";
import type { RegistrySkillArtifact } from "./skills_registry.ts";

/** A publishable skill: the SKILL.md body + optional resources, versioned + identified by content digest,
 *  optionally signed (Ed25519, base64) so the reader can verify it. The ADR-0098 artifact unit. */
export interface SkillArtifact {
  name: string;
  version: string;
  content: string; // SKILL.md body
  digest: string; // sha256(content) hex — the version-by-digest identity
  signature?: string; // base64 Ed25519 over content (set when a signing key is configured)
  keyId?: string;
  resources?: { path: string; content: string }[];
}

export interface PublishReceipt {
  ok: boolean;
  publisher: string;
  name: string;
  version: string;
  digest: string;
  signed: boolean;
  location?: string; // local path / remote ref the artifact was published to
  reason?: string;
}

export interface PublisherStatus {
  name: string;
  kind: string;
  ready: boolean;
  published: number;
  failed: number;
  lastError?: string;
}

/** A publish target. `publish` MUST be best-effort and MUST NOT throw — the dispatcher also guards, but a
 *  publisher that throws only hurts itself; a turn never fails because a publish did. Mirrors `Sink`. */
export interface RegistryPublisher {
  readonly name: string;
  readonly kind: string;
  publish(artifact: SkillArtifact): Promise<PublishReceipt>;
  status(): PublisherStatus;
}

/** Build a SkillArtifact from a codified skill: computes the content digest and, when a signer is given,
 *  signs the content (so the local registry can produce reader-installable artifacts). PURE given `sign`. */
export function buildSkillArtifact(
  input: { name: string; version: string; content: string; resources?: { path: string; content: string }[] },
  sign?: (content: string) => { signature: string; keyId: string },
): SkillArtifact {
  const digest = createHash("sha256").update(input.content, "utf8").digest("hex");
  const signed = sign ? sign(input.content) : undefined;
  return { name: input.name, version: input.version, content: input.content, digest, signature: signed?.signature, keyId: signed?.keyId, resources: input.resources };
}

const DEFAULT_LOCAL_ROOT = join(homedir(), ".omp", "skill-registry");
const MANIFEST = "artifact.json";

/**
 * The default, public publisher: serves the local skill roots as the Local Skills Registry. `publish`
 * writes `<root>/<name>/<version>/{SKILL.md, artifact.json, res/…}`, confined by pathWithin. Fail-safe:
 * an invalid name/version or a write error returns a failed receipt, never a throw.
 */
export class LocalRegistryPublisher implements RegistryPublisher {
  readonly name = "local";
  readonly kind = "local-folder";
  private published = 0;
  private failed = 0;
  private lastError?: string;
  constructor(private readonly root: string = DEFAULT_LOCAL_ROOT) {}

  async publish(artifact: SkillArtifact): Promise<PublishReceipt> {
    const receipt = (ok: boolean, extra: Partial<PublishReceipt> = {}): PublishReceipt =>
      ({ ok, publisher: this.name, name: artifact.name, version: artifact.version, digest: artifact.digest, signed: !!artifact.signature, ...extra });
    try {
      const slug = artifact.name;
      const ver = artifact.version;
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || !/^[A-Za-z0-9][\w.-]*$/.test(ver)) {
        this.failed++; return receipt(false, { reason: "invalid skill name or version" });
      }
      const dir = pathWithin(this.root, join(this.root, slug, ver));
      if (!dir) { this.failed++; return receipt(false, { reason: "unsafe publish path" }); }
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), artifact.content);
      const resPaths: string[] = [];
      for (const r of artifact.resources ?? []) {
        const rel = String(r?.path ?? "");
        const dest: string | null = rel ? pathWithin(dir, join(dir, "res", rel)) : null;
        if (!dest || dest === dir) continue; // refuse traversal / empty
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, String(r?.content ?? ""));
        resPaths.push(rel);
      }
      const manifest = { name: slug, version: ver, digest: artifact.digest, signature: artifact.signature ?? "", keyId: artifact.keyId ?? "", resources: resPaths, publishedAt: new Date().toISOString() };
      writeFileSync(join(dir, MANIFEST), JSON.stringify(manifest, null, 2));
      this.published++; this.lastError = undefined;
      return receipt(true, { location: dir });
    } catch (e) {
      this.failed++; this.lastError = String((e as Error)?.message ?? e).slice(0, 200);
      return receipt(false, { reason: this.lastError });
    }
  }

  status(): PublisherStatus { return { name: this.name, kind: this.kind, ready: true, published: this.published, failed: this.failed, lastError: this.lastError }; }
}

/**
 * Read a published artifact back out of the local registry as a reader-installable RegistrySkillArtifact
 * (P-SKILLREG.1's install unit). `version` omitted ⇒ the lexically-latest. Returns null when not found or
 * on any read error (fail-soft). Confined to the registry root.
 */
export function loadFromLocalRegistry(name: string, version?: string, root: string = DEFAULT_LOCAL_ROOT): RegistrySkillArtifact | null {
  try {
    const skillDir = pathWithin(root, join(root, name));
    if (!skillDir) return null;
    const ver = version ?? readdirSync(skillDir).filter((v) => pathWithin(skillDir, join(skillDir, v))).sort().pop();
    if (!ver) return null;
    const dir = pathWithin(skillDir, join(skillDir, ver));
    if (!dir) return null;
    const content = readFileSync(join(dir, "SKILL.md"), "utf8");
    const m: unknown = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8"));
    const sig = m && typeof m === "object" && "signature" in m && typeof m.signature === "string" ? m.signature : "";
    const keyId = m && typeof m === "object" && "keyId" in m && typeof m.keyId === "string" ? m.keyId : "";
    const resPaths = m && typeof m === "object" && "resources" in m && Array.isArray(m.resources) ? m.resources : [];
    const resources: { path: string; content: string }[] = [];
    for (const rel of resPaths) {
      if (typeof rel !== "string") continue;
      const src = pathWithin(dir, join(dir, "res", rel));
      if (!src) continue;
      try { resources.push({ path: rel, content: readFileSync(src, "utf8") }); } catch { /* skip unreadable resource */ }
    }
    return { name, version: ver, content, signature: sig, keyId, registryRef: `local:${name}:${ver}`, resources };
  } catch { return null; }
}

/**
 * Fans one artifact out to publishers, FAIL-SAFE. `targets` names a subset (default: all registered); a
 * named target with no registered publisher yields a clean no-op receipt (never a throw). Mirrors
 * AuditDispatcher: a throwing publisher only produces a failed receipt; others still run.
 */
export class PublishDispatcher {
  private publishers: RegistryPublisher[] = [];
  setPublishers(publishers: RegistryPublisher[]): void { this.publishers = publishers; }
  statuses(): PublisherStatus[] {
    return this.publishers.map((p) => { try { return p.status(); } catch { return { name: p.name, kind: p.kind, ready: false, published: 0, failed: 0, lastError: "status() threw" }; } });
  }
  async publish(artifact: SkillArtifact, targets?: string[]): Promise<PublishReceipt[]> {
    const noop = (name: string, reason: string): PublishReceipt => ({ ok: false, publisher: name, name: artifact.name, version: artifact.version, digest: artifact.digest, signed: !!artifact.signature, reason });
    const chosen: (RegistryPublisher | string)[] = targets
      ? targets.map((t) => this.publishers.find((p) => p.name === t) ?? t)
      : this.publishers;
    const receipts: PublishReceipt[] = [];
    for (const c of chosen) {
      if (typeof c === "string") { receipts.push(noop(c, "no publisher configured for target")); continue; }
      try { receipts.push(await c.publish(artifact)); }
      catch (e) { receipts.push(noop(c.name, `publisher threw: ${String((e as Error)?.message ?? e)}`)); }
    }
    return receipts;
  }
}

// Remote publishers (cloud OCI / custom git) are private add-on IP; they register here at init so
// publishersFor() picks them up. Empty in the public repo ⇒ local-only (remotes no-op).
const remotePublishers = new Map<string, RegistryPublisher>();
/** Register a remote publisher (the private add-on's connectors call this at startup). */
export function registerPublisher(publisher: RegistryPublisher): void { remotePublishers.set(publisher.name, publisher); }
/** Test-only: drop registered remote publishers. */
export function __resetPublishersForTest(): void { remotePublishers.clear(); }

/**
 * Choose the active publishers from managed config (sinksFor-style). The LOCAL publisher is always present
 * (unless publishing is disabled); each declared remote is included ONLY if a matching publisher has been
 * registered (public repo: none ⇒ that target no-ops). Pure given `cfg`.
 */
export function publishersFor(cfg: ManagedSkillRegistry | undefined = managedConfig().config?.skillRegistry): RegistryPublisher[] {
  if (cfg?.enabled === false) return [];
  const out: RegistryPublisher[] = [new LocalRegistryPublisher(cfg?.localRoot || DEFAULT_LOCAL_ROOT)];
  for (const remote of cfg?.remotes ?? []) {
    const impl = remotePublishers.get(remote.name);
    if (impl) out.push(impl); // a declared-but-unimplemented remote is simply absent (no-op on publish)
  }
  return out;
}
