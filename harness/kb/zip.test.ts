// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/kb/zip.test.ts — P-KGMARKET.4 (ADR-0206): the first-party zip writer round-trips through the
// existing first-party reader (harness/personal/unzip.ts) - the same reader the import path uses - for both
// a compressible entry (DEFLATE) and an incompressible one (STORED fallback), preserving bytes exactly.

import { describe, expect, test } from "bun:test";
import { zipEntries } from "./zip.ts";
import { listZipEntries, readZipEntry, readZipEntriesMatching } from "../personal/unzip.ts";

describe("zipEntries", () => {
  test("round-trips a compressible + an incompressible entry, byte-exact", () => {
    const manifest = Buffer.from(JSON.stringify({ format: "lkgpack/1", db_sha256: "abc" }).repeat(20), "utf8"); // compresses
    const db = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 2654435761) & 0xff)); // high-entropy → STORED
    const zip = zipEntries([{ name: "manifest.json", data: manifest }, { name: "kb_graph.duckdb", data: db }]);

    expect(listZipEntries(zip).map((e) => e.name).sort()).toEqual(["kb_graph.duckdb", "manifest.json"]);
    expect(readZipEntry(zip, "manifest.json")!.equals(manifest)).toBe(true);
    expect(readZipEntry(zip, "kb_graph.duckdb")!.equals(db)).toBe(true);
  });

  test("basename matching finds entries regardless of a folder prefix (robust to how a pack was zipped)", () => {
    const m = Buffer.from("{}", "utf8");
    const d = Buffer.from("duckdb-bytes-here", "utf8");
    const zip = zipEntries([{ name: "senior-proposal-manager.lkgpack/manifest.json", data: m }, { name: "senior-proposal-manager.lkgpack/kb_graph.duckdb", data: d }]);
    const got = readZipEntriesMatching(zip, (base) => base === "manifest.json" || base === "kb_graph.duckdb");
    expect(got.map((e) => e.name).sort()).toEqual(["kb_graph.duckdb", "manifest.json"]);
    expect(got.find((e) => e.name === "kb_graph.duckdb")!.data.equals(d)).toBe(true);
  });

  test("an empty entry round-trips", () => {
    const zip = zipEntries([{ name: "empty", data: new Uint8Array(0) }]);
    expect(readZipEntry(zip, "empty")!.length).toBe(0);
  });
});
