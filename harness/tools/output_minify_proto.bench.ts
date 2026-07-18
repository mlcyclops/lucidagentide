// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/tools/output_minify_proto.bench.ts — PROTOTYPE measurement harness.
// Runs `minify` over (a) REAL command output captured live from git (read-only)
// and (b) clearly-labeled REPRESENTATIVE samples for dedup-heavy tool classes
// whose CLIs are not installed on this host. Prints a token-delta table.
//
// Run: bun harness/tools/output_minify_proto.bench.ts

import { spawnSync } from "node:child_process";
import { minify, type MinifyStats } from "./output_minify_proto.ts";

interface Sample {
  name: string;
  kind: "REAL" | "REPRESENTATIVE";
  text: string;
}

function git(args: string[]): string {
  const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return (r.stdout ?? "") + (r.stderr ?? "");
}

const samples: Sample[] = [];

// ---- REAL: live git output with forced ANSI color ---------------------------
samples.push({
  name: "git log --oneline -200 (ANSI)",
  kind: "REAL",
  text: git(["-c", "color.ui=always", "log", "--oneline", "-200"]),
});
samples.push({
  name: "git status (ANSI)",
  kind: "REAL",
  text: git(["-c", "color.ui=always", "-c", "status.color=always", "status"]),
});
samples.push({
  name: "git diff --stat HEAD~30 (ANSI)",
  kind: "REAL",
  text: git(["-c", "color.ui=always", "diff", "--stat", "HEAD~30"]),
});

// ---- REPRESENTATIVE: dedup-heavy classes (CLI not on this host) --------------
// Format mirrors real `docker logs` (repeated request/heartbeat lines) — the
// canonical dedup win rtk targets.
const ESC = "\x1b";
const dockerLog = Array.from({ length: 120 }, (_, i) =>
  i % 5 === 0
    ? `2026-07-08T10:0${i % 10}:00Z INFO  GET /healthz 200 1ms`
    : `2026-07-08T10:00:00Z INFO  GET /healthz 200 1ms`,
).join("\n");
samples.push({ name: "docker logs (heartbeat spam)", kind: "REPRESENTATIVE", text: dockerLog });

// Format mirrors `cargo build` emitting the SAME deprecation warning per crate,
// with ANSI color on the `warning:` label.
const cargoWarn = Array.from({ length: 40 }, () =>
  `${ESC}[33mwarning${ESC}[0m: use of deprecated function \`foo::bar\`: replaced by baz`,
).join("\n") + "\n    Finished dev [unoptimized] target(s) in 3.14s\n";
samples.push({ name: "cargo build (repeated warning + ANSI)", kind: "REPRESENTATIVE", text: cargoWarn });

// A test runner: many green PASS lines (ANSI) + blank runs, few failures.
const testRun =
  Array.from({ length: 80 }, (_, i) => `${ESC}[32mok${ESC}[0m test_case_${i}`).join("\n") +
  "\n\n\n\n" +
  `${ESC}[31mFAIL${ESC}[0m test_edge: assertion failed at foo.rs:18\n`;
samples.push({ name: "test runner (pass spam + ANSI + blanks)", kind: "REPRESENTATIVE", text: testRun });

// ---- Report -----------------------------------------------------------------
function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function padL(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

console.log(
  pad("sample", 42) + pad("kind", 16) + padL("tok in", 8) + padL("tok out", 9) + padL("saved", 8) + padL("%", 8),
);
console.log("-".repeat(89));
let totIn = 0;
let totOut = 0;
for (const s of samples) {
  const { stats } = minify(s.text);
  totIn += stats.tokensBefore;
  totOut += stats.tokensAfter;
  printRow(s.name, s.kind, stats);
}
console.log("-".repeat(89));
const totSaved = totIn - totOut;
const totPct = totIn === 0 ? 0 : Math.round((totSaved / totIn) * 1000) / 10;
console.log(
  pad("TOTAL", 42) + pad("", 16) + padL(String(totIn), 8) + padL(String(totOut), 9) + padL(String(totSaved), 8) + padL(`${totPct}%`, 8),
);

function printRow(name: string, kind: string, st: MinifyStats): void {
  console.log(
    pad(name, 42) +
      pad(kind, 16) +
      padL(String(st.tokensBefore), 8) +
      padL(String(st.tokensAfter), 9) +
      padL(String(st.tokensSaved), 8) +
      padL(`${st.pctSaved}%`, 8),
  );
}
