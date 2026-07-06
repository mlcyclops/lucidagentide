// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/skill_publish.test.ts — P-SKILLREG.2 (ADR-0102): the publish seam. Over-tests the FAIL-SAFE
// contract (a throwing/missing publisher never throws, only yields a failed/no-op receipt), the confined
// local write + round-trip back to a reader-installable artifact, and publishersFor's local-only default.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetPublishersForTest,
  buildSkillArtifact,
  LocalRegistryPublisher,
  loadFromLocalRegistry,
  PublishDispatcher,
  publishersFor,
  registerPublisher,
  type PublishReceipt,
  type RegistryPublisher,
  type SkillArtifact,
} from "./skill_publish.ts";

const SKILL = "# incident-triage\n\n1. Pull signals. 2. One hypothesis. 3. Mitigate. 4. Write it up.";
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "lucid-pub-")); });
afterEach(() => { __resetPublishersForTest(); rmSync(root, { recursive: true, force: true }); });

describe("buildSkillArtifact — digest + optional signing", () => {
  test("computes a stable sha256 digest and stays unsigned without a signer", () => {
    const a = buildSkillArtifact({ name: "incident-triage", version: "1.0.0", content: SKILL });
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(a.signature).toBeUndefined();
    expect(buildSkillArtifact({ name: "x", version: "1", content: SKILL }).digest).toBe(a.digest); // content-addressed
  });
  test("a signer sets the signature + keyId", () => {
    const a = buildSkillArtifact({ name: "x", version: "1.0.0", content: SKILL }, (c) => ({ signature: `sig-${c.length}`, keyId: "local-key" }));
    expect(a.signature).toBe(`sig-${SKILL.length}`);
    expect(a.keyId).toBe("local-key");
  });
});

describe("LocalRegistryPublisher — confined write + fail-safe", () => {
  test("publishes SKILL.md + manifest + confined resources", async () => {
    const pub = new LocalRegistryPublisher(root);
    const a = buildSkillArtifact({ name: "incident-triage", version: "1.2.0", content: SKILL, resources: [{ path: "scripts/run.sh", content: "echo hi" }, { path: "../escape.txt", content: "x" }] });
    const r = await pub.publish(a);
    expect(r.ok).toBe(true);
    expect(existsSync(join(root, "incident-triage", "1.2.0", "SKILL.md"))).toBe(true);
    expect(existsSync(join(root, "incident-triage", "1.2.0", "artifact.json"))).toBe(true);
    expect(existsSync(join(root, "incident-triage", "1.2.0", "res", "scripts", "run.sh"))).toBe(true);
    expect(existsSync(join(root, "incident-triage", "escape.txt"))).toBe(false); // traversal refused
    expect(pub.status().published).toBe(1);
  });
  test("an invalid name/version yields a failed receipt, never a throw", async () => {
    const pub = new LocalRegistryPublisher(root);
    const bad = await pub.publish(buildSkillArtifact({ name: "Not A Slug", version: "1.0.0", content: SKILL }));
    expect(bad.ok).toBe(false);
    expect(pub.status().failed).toBe(1);
    expect(existsSync(join(root, "Not A Slug"))).toBe(false);
  });
});

describe("loadFromLocalRegistry — round-trip to a reader-installable artifact", () => {
  test("publish then load returns the same content + signature + resources", async () => {
    const pub = new LocalRegistryPublisher(root);
    const a = buildSkillArtifact({ name: "triage", version: "2.0.0", content: SKILL, resources: [{ path: "refs/notes.md", content: "notes" }] }, () => ({ signature: "AAAA", keyId: "k1" }));
    await pub.publish(a);
    const loaded = loadFromLocalRegistry("triage", "2.0.0", root);
    expect(loaded).toBeTruthy();
    expect(loaded!.content).toBe(SKILL);
    expect(loaded!.signature).toBe("AAAA");
    expect(loaded!.keyId).toBe("k1");
    expect(loaded!.registryRef).toBe("local:triage:2.0.0");
    expect(loaded!.resources).toEqual([{ path: "refs/notes.md", content: "notes" }]);
  });
  test("omitting the version loads the lexically-latest; a missing skill is null", async () => {
    const pub = new LocalRegistryPublisher(root);
    await pub.publish(buildSkillArtifact({ name: "triage", version: "1.0.0", content: "v1" }));
    await pub.publish(buildSkillArtifact({ name: "triage", version: "1.2.0", content: "v2" }));
    expect(loadFromLocalRegistry("triage", undefined, root)!.version).toBe("1.2.0");
    expect(loadFromLocalRegistry("nope", undefined, root)).toBeNull();
  });
});

describe("PublishDispatcher — fail-safe fan-out", () => {
  const artifact: SkillArtifact = { name: "x", version: "1.0.0", content: "c", digest: "d", signature: undefined };
  const okPub = (name: string): RegistryPublisher => ({ name, kind: "test", status: () => ({ name, kind: "test", ready: true, published: 0, failed: 0 }), publish: async (): Promise<PublishReceipt> => ({ ok: true, publisher: name, name: "x", version: "1.0.0", digest: "d", signed: false }) });
  const throwingPub: RegistryPublisher = { name: "boom", kind: "test", status: () => ({ name: "boom", kind: "test", ready: true, published: 0, failed: 0 }), publish: async () => { throw new Error("kaboom"); } };

  test("a throwing publisher yields a failed receipt while others still succeed (never throws)", async () => {
    const d = new PublishDispatcher();
    d.setPublishers([okPub("local"), throwingPub]);
    const receipts = await d.publish(artifact);
    expect(receipts).toHaveLength(2);
    expect(receipts.find((r) => r.publisher === "local")!.ok).toBe(true);
    const boom = receipts.find((r) => r.publisher === "boom")!;
    expect(boom.ok).toBe(false);
    expect(boom.reason).toContain("threw");
  });
  test("a named target with no publisher is a clean no-op receipt", async () => {
    const d = new PublishDispatcher();
    d.setPublishers([okPub("local")]);
    const receipts = await d.publish(artifact, ["local", "acme-ecr"]);
    expect(receipts.find((r) => r.publisher === "local")!.ok).toBe(true);
    const missing = receipts.find((r) => r.publisher === "acme-ecr")!;
    expect(missing.ok).toBe(false);
    expect(missing.reason).toContain("no publisher configured");
  });
});

describe("publishersFor — local-only in the public repo", () => {
  test("defaults to just the local publisher", () => {
    const ps = publishersFor({});
    expect(ps.map((p) => p.name)).toEqual(["local"]);
  });
  test("enabled:false disables publishing entirely", () => {
    expect(publishersFor({ enabled: false })).toEqual([]);
  });
  test("a declared remote with no registered publisher is absent (no-op); a registered one is included", () => {
    const cfg = { remotes: [{ name: "acme-ecr", kind: "oci" }] };
    expect(publishersFor(cfg).map((p) => p.name)).toEqual(["local"]); // unimplemented remote → absent
    registerPublisher({ name: "acme-ecr", kind: "oci", status: () => ({ name: "acme-ecr", kind: "oci", ready: true, published: 0, failed: 0 }), publish: async () => ({ ok: true, publisher: "acme-ecr", name: "x", version: "1", digest: "d", signed: false }) });
    expect(publishersFor(cfg).map((p) => p.name)).toEqual(["local", "acme-ecr"]);
  });
});
