// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/kb/pack_coverage.test.ts - P-TRAINER.5 (ADR-0253): the ADDITIVE coverage_map manifest
// member. Absent = ordinary content pack (nothing changes); present = validated + signature-bound.

import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  buildManifest,
  sha256Bytes,
  verifyPackManifest,
  canonicalManifestBytes,
  type PackCoverageMap,
  type TrustedPackKey,
} from "./pack.ts";
import { WMO_OBJECTIVES, WMO_PACK_ID } from "../trainer/wmo_pack.ts";

const DB = Buffer.from("fake duckdb bytes");
const SHA = sha256Bytes(DB);

function wmoCoverageMap(): PackCoverageMap {
  return {
    pack_id: WMO_PACK_ID,
    objectives: WMO_OBJECTIVES.map((o) => ({ id: o.objectiveId, domain: o.domain, title: o.title, weight: o.weight })),
  };
}

function manifest(coverageMap?: PackCoverageMap) {
  return buildManifest({
    kg: { name: "WMO extraction", role: "wealth-management-ops" },
    author: "TechLead 187 LLC",
    version: "1.0.0",
    createdAt: "2026-08-02T00:00:00Z",
    dbSha256: SHA,
    pageCount: 0,
    coverageMap,
  });
}

describe("coverage_map manifest member", () => {
  test("absent: an ordinary content pack still verifies (nothing changed for old packs)", () => {
    expect(verifyPackManifest(manifest(), SHA, []).ok).toBe(true);
  });

  test("present + valid: verifies, and the WMO map is a valid instance", () => {
    const v = verifyPackManifest(manifest(wmoCoverageMap()), SHA, []);
    expect(v.ok).toBe(true);
  });

  test("present + invalid: refused at the manifest stage", () => {
    const noId = { ...wmoCoverageMap(), pack_id: " " };
    expect(verifyPackManifest(manifest(noId), SHA, []).reason).toContain("coverage_map");

    const dupe = wmoCoverageMap();
    dupe.objectives.push(dupe.objectives[0]!);
    expect(verifyPackManifest(manifest(dupe), SHA, []).reason).toContain("duplicated");

    const badWeight = wmoCoverageMap();
    badWeight.objectives[0] = { ...badWeight.objectives[0]!, weight: 0 };
    expect(verifyPackManifest(manifest(badWeight), SHA, []).reason).toContain("non-positive weight");

    const empty = { pack_id: WMO_PACK_ID, objectives: [] };
    expect(verifyPackManifest(manifest(empty), SHA, []).reason).toContain("empty");
  });

  test("the coverage_map is signature-bound: tampering it after signing breaks the signature", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const trusted: TrustedPackKey[] = [{ id: "test-key", key: publicKey }];
    const m = buildManifest({
      kg: { name: "WMO extraction" },
      author: "TechLead 187 LLC",
      version: "1.0.0",
      createdAt: "2026-08-02T00:00:00Z",
      dbSha256: SHA,
      pageCount: 0,
      coverageMap: wmoCoverageMap(),
      sign: (canonical) => ({ signature: sign(null, canonical, privateKey).toString("base64"), keyId: "test-key" }),
    });
    expect(verifyPackManifest(m, SHA, trusted)).toMatchObject({ ok: true, signed: true, keyId: "test-key" });

    const tampered = { ...m, coverage_map: { ...m.coverage_map!, pack_id: "someone-elses-pack" } };
    const v = verifyPackManifest(tampered, SHA, trusted);
    expect(v.ok).toBe(false);
    expect(v.stage).toBe("signature");
  });

  test("canonical bytes include the coverage_map (so unsigned tamper is at least visible in the payload)", () => {
    const withMap = canonicalManifestBytes(manifest(wmoCoverageMap())).toString("utf8");
    expect(withMap).toContain("coverage_map");
    expect(withMap).toContain(WMO_PACK_ID);
  });
});
