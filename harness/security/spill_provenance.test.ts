// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/security/spill_provenance.test.ts
//
// P-CTX.2a (ADR-0578): omp spill metadata, the provenance ledger and the artifact references in a tool
// call's input. The ledger's failure paths are the point: a ledger that cannot answer never reads as "local".

import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  LEDGER_FILE,
  PURGED_NOTICE,
  SpillLedger,
  artifactRefs,
  ledgerFor,
  sha256Hex,
  spillAccessFromContext,
  spillArtifactIds,
  worseLabel,
  type SpillRecord,
} from "./spill_provenance.ts";

function tempDir(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "lucid-spill-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function rec(id: string, over: Partial<SpillRecord> = {}): SpillRecord {
  return {
    artifact_id: `sess-1/${id}`,
    session_id: "sess-1",
    omp_artifact_id: id,
    tool_name: "mcp__github_get_pr",
    source: "mcp:github",
    trust_label: "untrusted",
    total_chars: 1234,
    content_sha256: sha256Hex("x"),
    purged: false,
    created_at: "2026-11-14T00:00:00.000Z",
    ...over,
  };
}

// ── spillArtifactIds ─────────────────────────────────────────────────────────────────────────────────
test("spillArtifactIds reads omp's spill artifact id, and the column-limit artifact when present", () => {
  expect(spillArtifactIds({ meta: { truncation: { direction: "middle", artifactId: "0" } } })).toEqual(["0"]);
  expect(
    spillArtifactIds({ meta: { truncation: { artifactId: "3" }, limits: { columnTruncated: { artifactId: "4" } } } }),
  ).toEqual(["3", "4"]);
  expect(spillArtifactIds({ meta: { truncation: { artifactId: "5" }, limits: { columnTruncated: { artifactId: "5" } } } })).toEqual(["5"]);
});

test("spillArtifactIds is empty for an unspilled result and ignores ids that are not omp's numeric form", () => {
  expect(spillArtifactIds(undefined)).toEqual([]);
  expect(spillArtifactIds({ serverName: "github" })).toEqual([]);
  expect(spillArtifactIds({ meta: {} })).toEqual([]);
  expect(spillArtifactIds({ meta: { truncation: { truncatedBy: "lines" } } })).toEqual([]);
  expect(spillArtifactIds({ meta: { truncation: { artifactId: "../../etc/passwd" } } })).toEqual([]);
  expect(spillArtifactIds({ meta: { truncation: { artifactId: 7 } } })).toEqual([]);
});

test("worseLabel orders trusted < untrusted < suspicious < quarantined", () => {
  expect(worseLabel("untrusted", "suspicious")).toBe("suspicious");
  expect(worseLabel("quarantined", "suspicious")).toBe("quarantined");
  expect(worseLabel("trusted", "untrusted")).toBe("untrusted");
  expect(worseLabel("untrusted", "untrusted")).toBe("untrusted");
});

// ── SpillLedger ──────────────────────────────────────────────────────────────────────────────────────
test("an empty ledger knows no external artifact and answers `unknown`", () => {
  const t = tempDir();
  try {
    const ledger = new SpillLedger(t.dir);
    expect(ledger.hasExternal()).toBe(false);
    expect(ledger.unreadable).toBe(false);
    expect(ledger.lookup("0")).toEqual({ state: "unknown" });
    expect(ledger.records()).toEqual([]);
  } finally {
    t.done();
  }
});

test("a record is found again, is on disk as one JSON line, and survives a new process (a fresh ledger)", () => {
  const t = tempDir();
  try {
    const ledger = new SpillLedger(t.dir);
    ledger.record(rec("0"));
    ledger.record(rec("2", { trust_label: "suspicious" }));
    expect(ledger.hasExternal()).toBe(true);
    expect(ledger.lookup("0")).toEqual({ state: "known", record: rec("0") });
    expect(ledger.lookup("1")).toEqual({ state: "unknown" });

    const lines = readFileSync(join(t.dir, LEDGER_FILE), "utf8").trimEnd().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!)).toEqual(rec("0"));

    const reopened = new SpillLedger(t.dir);
    expect(reopened.lookup("2")).toEqual({ state: "known", record: rec("2", { trust_label: "suspicious" }) });
    expect(reopened.records().map((r) => r.omp_artifact_id).sort()).toEqual(["0", "2"]);
  } finally {
    t.done();
  }
});

test("a later record never softens an earlier verdict for the same artifact", () => {
  const t = tempDir();
  try {
    const ledger = new SpillLedger(t.dir);
    ledger.record(rec("0", { trust_label: "quarantined", purged: true }));
    ledger.record(rec("0", { trust_label: "untrusted" }));
    const found = ledger.lookup("0");
    expect(found.state === "known" && found.record.trust_label).toBe("quarantined");
    const reopened = new SpillLedger(t.dir).lookup("0"); // the same holds when read back from disk
    expect(reopened.state === "known" && reopened.record.trust_label).toBe("quarantined");
  } finally {
    t.done();
  }
});

test("FAIL-CLOSED: a damaged line makes ids the ledger cannot vouch for `unreadable`, never `unknown`", () => {
  const t = tempDir();
  try {
    writeFileSync(join(t.dir, LEDGER_FILE), `${JSON.stringify(rec("0"))}\n{ this is not json\n`, "utf8");
    const ledger = new SpillLedger(t.dir);
    expect(ledger.unreadable).toBe(true);
    expect(ledger.hasExternal()).toBe(true);
    expect(ledger.lookup("0").state).toBe("known"); // the good line still counts
    expect(ledger.lookup("9")).toEqual({ state: "unreadable" });
  } finally {
    t.done();
  }
});

test("FAIL-CLOSED: a line that parses but is not a valid record (a `trusted` label, a bad id) is damage", () => {
  const t = tempDir();
  try {
    const lines = [JSON.stringify({ ...rec("0"), trust_label: "trusted" }), JSON.stringify({ ...rec("1"), omp_artifact_id: "../1" })];
    writeFileSync(join(t.dir, LEDGER_FILE), `${lines.join("\n")}\n`, "utf8");
    const ledger = new SpillLedger(t.dir);
    expect(ledger.unreadable).toBe(true);
    expect(ledger.records()).toEqual([]);
    expect(ledger.lookup("0")).toEqual({ state: "unreadable" });
  } finally {
    t.done();
  }
});

test("FAIL-CLOSED: a ledger path that cannot be read as a file is `unreadable`", () => {
  const t = tempDir();
  try {
    mkdirSync(join(t.dir, LEDGER_FILE)); // a directory squatting on the ledger's name
    const ledger = new SpillLedger(t.dir);
    expect(ledger.unreadable).toBe(true);
    expect(ledger.lookup("0")).toEqual({ state: "unreadable" });
  } finally {
    t.done();
  }
});

test("a failed durable write throws, and the record is still held in memory for this process", () => {
  const t = tempDir();
  try {
    const ledger = new SpillLedger(join(t.dir, "missing-subdir")); // the directory does not exist
    expect(() => ledger.record(rec("0", { trust_label: "quarantined" }))).toThrow();
    const found = ledger.lookup("0");
    expect(found.state === "known" && found.record.trust_label).toBe("quarantined");
  } finally {
    t.done();
  }
});

test("a session with no artifacts directory keeps its ledger in memory", () => {
  const ledger = new SpillLedger(null);
  ledger.record(rec("0"));
  expect(ledger.lookup("0").state).toBe("known");
  expect(ledger.unreadable).toBe(false);
});

test("ledgerFor returns one shared ledger per artifacts directory, and per session when there is none", () => {
  const t = tempDir();
  try {
    expect(ledgerFor(t.dir, "s1")).toBe(ledgerFor(t.dir, "s2"));
    expect(ledgerFor(null, "mem-a")).toBe(ledgerFor(null, "mem-a"));
    expect(ledgerFor(null, "mem-a")).not.toBe(ledgerFor(null, "mem-b"));
  } finally {
    t.done();
  }
});

// ── spillAccessFromContext ───────────────────────────────────────────────────────────────────────────
test("spillAccessFromContext is null without a usable session manager", () => {
  expect(spillAccessFromContext(undefined)).toBeNull();
  expect(spillAccessFromContext({})).toBeNull();
  expect(spillAccessFromContext({ sessionManager: {} })).toBeNull();
  expect(spillAccessFromContext({ sessionManager: { getSessionId: () => "", getArtifactsDir: () => null, getArtifactPath: async () => null } })).toBeNull();
  expect(
    spillAccessFromContext({
      sessionManager: { getSessionId: () => { throw new Error("released"); }, getArtifactsDir: () => null, getArtifactPath: async () => null },
    }),
  ).toBeNull();
});

test("spillAccessFromContext reads a file-backed artifact whole and purges it to the notice", async () => {
  const t = tempDir();
  try {
    const file = join(t.dir, "0.mcp__x.log");
    writeFileSync(file, "the whole artifact", "utf8");
    const access = spillAccessFromContext({
      sessionManager: {
        getSessionId: () => "sess-9",
        getArtifactsDir: () => t.dir,
        getArtifactPath: async (id: string) => (id === "0" ? file : null),
      },
    });
    expect(access).not.toBeNull();
    expect(access!.sessionId).toBe("sess-9");
    expect(access!.artifactsDir).toBe(t.dir);
    expect(await access!.readFull("0")).toBe("the whole artifact");
    await expect(access!.readFull("1")).rejects.toThrow();
    expect(await access!.purge("0", PURGED_NOTICE)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(PURGED_NOTICE);
    expect(await access!.purge("1", PURGED_NOTICE)).toBe(false); // no file to replace
  } finally {
    t.done();
  }
});

test("spillAccessFromContext reads an in-memory artifact, and reports that it cannot be purged", async () => {
  const access = spillAccessFromContext({
    sessionManager: {
      getSessionId: () => "sess-mem",
      getArtifactsDir: () => null,
      getArtifactPath: async () => null,
      getArtifactContent: (id: string) => (id === "0" ? "held in memory" : null),
    },
  });
  expect(access!.artifactsDir).toBeNull();
  expect(await access!.readFull("0")).toBe("held in memory");
  await expect(access!.readFull("1")).rejects.toThrow();
  expect(await access!.purge("0", PURGED_NOTICE)).toBe(false);
});

// ── artifactRefs ─────────────────────────────────────────────────────────────────────────────────────
const DIR = join(tmpdir(), "omp-sessions", "2026-11-14_abc");

test("artifactRefs finds artifact:// ids anywhere in the input, with or without a line range", () => {
  expect(artifactRefs({ path: "artifact://0:2998-3003" }, DIR)).toEqual({ ids: ["0"], wholeDir: false });
  expect(artifactRefs({ command: "cat artifact://12 && echo artifact://3:raw:1-5" }, DIR)).toEqual({ ids: ["12", "3"], wholeDir: false });
  expect(artifactRefs({ paths: ["a.txt", "artifact://7"] }, null)).toEqual({ ids: ["7"], wholeDir: false });
});

test("artifactRefs finds an artifact named by its file path inside the artifacts directory", () => {
  const file = `${DIR}${sep}4.mcp__github_get_pr.log`;
  expect(artifactRefs({ path: file }, DIR)).toEqual({ ids: ["4"], wholeDir: false });
  expect(artifactRefs({ command: `grep -n secret "${file}" | head` }, DIR)).toEqual({ ids: ["4"], wholeDir: false });
});

test("artifactRefs marks the whole directory when the input names it, a non-artifact path in it, or an ancestor", () => {
  expect(artifactRefs({ path: DIR }, DIR)).toEqual({ ids: [], wholeDir: true });
  expect(artifactRefs({ command: `grep -rn token ${DIR}${sep}` }, DIR)).toEqual({ ids: [], wholeDir: true });
  expect(artifactRefs({ command: `cat ${DIR}${sep}*.log` }, DIR)).toEqual({ ids: [], wholeDir: true });
  expect(artifactRefs({ path: join(tmpdir(), "omp-sessions") }, DIR)).toEqual({ ids: [], wholeDir: true });
});

test("artifactRefs is empty for input that names no artifact, and for a look-alike sibling directory", () => {
  expect(artifactRefs({ path: "src/main.ts" }, DIR)).toEqual({ ids: [], wholeDir: false });
  expect(artifactRefs({ command: "ls -la" }, DIR)).toEqual({ ids: [], wholeDir: false });
  expect(artifactRefs(undefined, DIR)).toEqual({ ids: [], wholeDir: false });
  expect(artifactRefs({ n: 1, flag: true }, DIR)).toEqual({ ids: [], wholeDir: false });
  expect(artifactRefs({ path: join(tmpdir(), "omp") }, DIR)).toEqual({ ids: [], wholeDir: false }); // a prefix of the name, not a parent
});

test("artifactRefs matches the directory written with the other path separator", () => {
  const other = sep === "/" ? DIR.replaceAll("/", "\\") : DIR.replaceAll("\\", "/");
  const otherSep = sep === "/" ? "\\" : "/";
  expect(artifactRefs({ path: `${other}${otherSep}2.bash.log` }, DIR)).toEqual({ ids: ["2"], wholeDir: false });
});
