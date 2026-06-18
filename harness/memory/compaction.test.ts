// harness/memory/compaction.test.ts
//
// Security-aware compaction: summaries come from sanitized derivatives (never
// raw), raw is preserved, and suspicious/quarantined sources are not eligible
// for promotion.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "./db.ts";
import { compactSpan } from "./compaction.ts";

const ZWSP = String.fromCodePoint(0x200b);

let dir: string;
let db: Db;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "compact-test-"));
  db = await Db.open(join(dir, "t.duckdb"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Insert an artifact + its scan + sanitized derivative directly, for control. */
async function addArtifact(id: string, trust: string, raw: string, sanitized: string, findings = 0) {
  await db.run(
    `INSERT INTO content_artifacts (artifact_id, run_id, source_type, trust_label, raw_content, raw_sha256, created_at)
     VALUES ($1,'run-1','import',$2,$3,'h', now())`,
    [id, trust, raw],
  );
  await db.run(
    `INSERT INTO content_scans (scan_id, artifact_id, scanner_name, scanner_version, verdict, finding_count, created_at)
     VALUES ($1,$2,'unicode-scanner','0.2.0',$3,$4, now())`,
    [`sc-${id}`, id, trust === "untrusted" ? "clean" : trust, findings],
  );
  for (let i = 0; i < findings; i++) {
    await db.run(
      `INSERT INTO security_findings (finding_id, scan_id, finding_type, severity, created_at)
       VALUES ($1,$2,'zero-width','high', now())`,
      [`f-${id}-${i}`, `sc-${id}`],
    );
  }
  await db.run(
    `INSERT INTO sanitized_artifacts (sanitized_id, artifact_id, policy, sanitized_content, sanitized_sha256, created_at)
     VALUES ($1,$2,'NFKC+strip',$3,'h', now())`,
    [`san-${id}`, id, sanitized],
  );
}

test("KEYSTONE: summary is built from sanitized content, never raw invisibles", async () => {
  await addArtifact("a1", "quarantined", `edit${ZWSP}file`, "editfile", 1);
  const r = await compactSpan(db, { runId: "run-1", artifactIds: ["a1"], trigger: "manual" });
  expect(r.summary.includes(ZWSP)).toBe(false);
  expect(r.summary).toContain("editfile");
});

test("the summary is recorded as generated_from=sanitized", async () => {
  await addArtifact("a2", "untrusted", "raw", "raw");
  const r = await compactSpan(db, { runId: "run-1", artifactIds: ["a2"], trigger: "manual" });
  const row = await db.get("SELECT generated_from FROM compaction_summaries WHERE summary_id=$1", [r.summaryId]);
  expect(row?.generated_from).toBe("sanitized");
});

test("raw original is preserved untouched after compaction", async () => {
  await addArtifact("a3", "quarantined", `x${ZWSP}y`, "xy", 1);
  await compactSpan(db, { runId: "run-1", artifactIds: ["a3"], trigger: "manual" });
  const raw = await db.get("SELECT raw_content FROM content_artifacts WHERE artifact_id='a3'");
  expect(String(raw?.raw_content).includes(ZWSP)).toBe(true);
});

test("promotion eligibility: trusted/untrusted eligible; suspicious/quarantined blocked", async () => {
  await addArtifact("t", "trusted", "r", "r");
  await addArtifact("u", "untrusted", "r", "r");
  await addArtifact("s", "suspicious", "r", "r", 1);
  await addArtifact("q", "quarantined", "r", "r", 2);
  const r = await compactSpan(db, { runId: "run-1", artifactIds: ["t", "u", "s", "q"], trigger: "session_boundary" });
  const map = Object.fromEntries(r.promotions.map((p) => [p.artifactId, p.promoted]));
  expect(map).toEqual({ t: true, u: true, s: false, q: false });
});

test("span records artifact ids + aggregate finding count", async () => {
  await addArtifact("a4", "quarantined", "r", "r", 3);
  await addArtifact("a5", "untrusted", "r", "r", 0);
  const r = await compactSpan(db, { runId: "run-1", artifactIds: ["a4", "a5"], trigger: "token_threshold" });
  expect(r.findingCount).toBe(3);
  const span = await db.get("SELECT finding_count, trigger FROM compaction_spans WHERE span_id=$1", [r.spanId]);
  expect(span?.finding_count).toBe(3);
  expect(span?.trigger).toBe("token_threshold");
});

test("a custom summarizer is used and preserved-state fields appear", async () => {
  await addArtifact("a6", "untrusted", "r", "sanitized-body");
  const r = await compactSpan(db, {
    runId: "run-1",
    artifactIds: ["a6"],
    trigger: "manual",
    state: { goals: "G", blockers: "B" },
    summarizer: (parts, state) => `goals=${state.goals};blockers=${state.blockers};parts=${parts.length}`,
  });
  expect(r.summary).toBe("goals=G;blockers=B;parts=1");
});
