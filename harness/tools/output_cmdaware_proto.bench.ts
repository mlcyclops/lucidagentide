// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/tools/output_cmdaware_proto.bench.ts — PROTOTYPE measurement harness for
// the command-aware filters. Reads REAL captures written to $TMP/rtk_cmdaware by the
// capture step, plus one clearly-labeled REPRESENTATIVE cargo sample (cargo not on
// this host). Prints token deltas vs rtk's headline claims.
//
// Run: bun harness/tools/output_cmdaware_proto.bench.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { estimateTokens } from "./output_minify_proto.ts";
import { filterGitStatus, filterTestFailuresOnly } from "./output_cmdaware_proto.ts";

const dir = join(tmpdir(), "rtk_cmdaware");

function readOr(name: string): string | null {
  try {
    return readFileSync(join(dir, name), "utf8");
  } catch {
    return null;
  }
}

interface Row {
  name: string;
  kind: "REAL" | "REPRESENTATIVE";
  before: number;
  after: number;
}
const rows: Row[] = [];

function record(name: string, kind: Row["kind"], raw: string, filtered: string): void {
  rows.push({ name, kind, before: estimateTokens(raw), after: estimateTokens(filtered) });
}

// 1) git status — REAL capture from the throwaway medium-project repo.
const gitRaw = readOr("gitstatus_real.txt");
if (gitRaw) record("git status (44-file change set)", "REAL", gitRaw, filterGitStatus(gitRaw));
else console.log("(!) gitstatus_real.txt missing — run the capture step first");

// 2) bun test — REAL capture. Piped bun is already summary-only, so this shows the
//    failures-only filter is a NO-OP on already-compact runner output.
const bunRaw = readOr("buntest_real.txt");
if (bunRaw) record("bun test (piped, summary-only)", "REAL", bunRaw, filterTestFailuresOnly(bunRaw).text);

// 3) cargo test — REPRESENTATIVE (cargo not installed). Real libtest format: it
//    prints `test … ok` PER TEST even when piped, which is the runner class where
//    failures-only earns rtk's ~90%.
const cargo =
  "running 200 tests\n" +
  Array.from({ length: 200 }, (_, i) =>
    i === 42 || i === 137 || i === 190
      ? `test module::test_${i} ... FAILED`
      : `test module::test_${i} ... ok`,
  ).join("\n") +
  "\n\nfailures:\n\n---- module::test_42 stdout ----\nthread 'module::test_42' panicked at src/x.rs:18:\nassertion `left == right` failed\n" +
  "\nfailures:\n    module::test_42\n    module::test_137\n    module::test_190\n\n" +
  "test result: FAILED. 197 passed; 3 failed; 0 ignored; 0 measured; 0 filtered out\n";
record("cargo test (200 tests, 3 fail)", "REPRESENTATIVE", cargo, filterTestFailuresOnly(cargo).text);

// ---- Report -----------------------------------------------------------------
function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function padL(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

console.log(
  pad("sample", 40) + pad("kind", 16) + padL("tok in", 8) + padL("tok out", 9) + padL("saved", 8) + padL("%", 8),
);
console.log("-".repeat(87));
for (const r of rows) {
  const saved = r.before - r.after;
  const pct = r.before === 0 ? 0 : Math.round((saved / r.before) * 1000) / 10;
  console.log(
    pad(r.name, 40) + pad(r.kind, 16) + padL(String(r.before), 8) + padL(String(r.after), 9) + padL(String(saved), 8) + padL(`${pct}%`, 8),
  );
}
