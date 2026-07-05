// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_report_10.ts
//
// Increment P-REPORT.10 (ADR-0164) — a formal SecurityEvent per fetch / PR reach-out.
// The multi-repo report collector's git fetch / gh PR list are FIRST-PARTY reach-outs that bypass the
// agent tool gate by design (see repo_collect.ts). This proves each ACTUAL reach-out is now audited:
//   (1) the PURE builder maps a git fetch to an egress/report_fetch/allow SecurityEvent, host in reason;
//   (2) a SKIPPED PR list performed no reach-out → emits NOTHING; a real gh pr list → report_pr_list;
//   (3) a token-bearing remote leaks NO credential into the reason (metadata-only, host-only);
//   (4) LIVE + OFFLINE: a real `git fetch` from a LOCAL bare origin flows through collectRepoActivity →
//       the REAL SecurityEvent dispatcher → ring buffer → an OCSF Detection Finding a SOC can ingest.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { reachoutAuditEvents, collectRepoActivity } from "../repo_collect.ts";
import { parseRemoteUrl } from "../../harness/brief/repo_activity.ts";
import { audit, toOcsf } from "../audit_export.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} \u2713`);

console.log("== P-REPORT.10 — a SecurityEvent per fetch/PR reach-out ==");

// (1) pure builder: a fetch reach-out → one egress report_fetch(allow/info/git); host in the reason.
const gh = parseRemoteUrl("git@github.com:acme/widgets.git");
const f = reachoutAuditEvents(gh, { fetched: true, fetchOk: true, prStatus: "skipped-off" });
if (f.length !== 1 || f[0]!.category !== "egress" || f[0]!.type !== "report_fetch" || f[0]!.decision !== "allow" || f[0]!.severity !== "info" || f[0]!.tool !== "git") fail("fetch event shape wrong");
// Exact-match on the whole reason line (not a URL substring test - CodeQL js/incomplete-url-substring-sanitization):
// proves the reason is the host-only metadata line, nothing more, nothing less.
if (f[0]!.reason !== `report: git fetch ${gh.host} (ok)`) fail(`fetch reason must be the exact host-only line, got: ${f[0]!.reason}`);
ok("pure: git fetch → egress/report_fetch/allow/info, host github.com in reason");

// (2) a SKIPPED PR list performed no reach-out → no event; a real gh pr list (ok) → one report_pr_list.
if (reachoutAuditEvents(gh, { fetched: false, fetchOk: true, prStatus: "skipped-nonhub" }).length !== 0) fail("a skipped PR list must not emit");
const pr = reachoutAuditEvents(gh, { fetched: false, fetchOk: true, prStatus: "ok" });
if (pr.length !== 1 || pr[0]!.type !== "report_pr_list" || pr[0]!.tool !== "gh" || pr[0]!.category !== "egress") fail("PR event shape wrong");
ok("pure: a skipped PR list emits nothing; a real gh pr list → egress/report_pr_list/gh");

// (3) no credential leak: a token-bearing URL → host-only reason, never the token or userinfo.
const tok = parseRemoteUrl("https://user:ghp_secrettoken@github.com/acme/widgets.git");
const tokEvs = reachoutAuditEvents(tok, { fetched: true, fetchOk: true, prStatus: "ok" });
for (const e of tokEvs) if ((e.reason ?? "").includes("ghp_secrettoken") || (e.reason ?? "").includes("@") || (e.reason ?? "").includes("user:")) fail("credential leaked into an audit reason");
ok("pure: token-bearing remote → host-only reason, no credential leak (metadata-only)");

// (4) LIVE end-to-end (offline): a real git fetch from a LOCAL bare origin flows through collectRepoActivity
//     → the REAL SecurityEvent dispatcher → ring buffer → OCSF. Zero network.
const gitOk = Bun.spawnSync(["git", "--version"], { stdout: "pipe", stderr: "pipe" }).success;
if (gitOk) {
  const g = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  const bare = mkdtempSync(join(homedir(), ".lucid-r10demo-bare-"));
  const work = mkdtempSync(join(homedir(), ".lucid-r10demo-work-"));
  try {
    g(bare, "init", "-q", "--bare", "-b", "main");
    g(work, "init", "-q", "-b", "main"); g(work, "config", "user.email", "t@t.test"); g(work, "config", "user.name", "T");
    writeFileSync(join(work, "a.txt"), "hi\n"); g(work, "add", "-A"); g(work, "commit", "-q", "-m", "init");
    g(work, "remote", "add", "origin", bare); g(work, "push", "-q", "origin", "main");
    // default (real) emitSecurityEvent — flows to the dispatcher + ring + file sink.
    await collectRepoActivity([{ path: work, fetch: true, prs: false }], { fetch: true, prs: false, window: 5 });
    const ev = audit.recent(20).find((e) => e.type === "report_fetch");
    if (!ev) fail("live: report_fetch never reached the audit dispatcher");
    if (ev!.category !== "egress" || ev!.decision !== "allow" || ev!.severity !== "info") fail("live: audited event shape wrong");
    const ocsf = toOcsf(ev!);
    if (ocsf.category_uid !== 2 || ocsf.class_uid !== 2004) fail("live: OCSF mapping is not a Detection Finding");
    ok(`live: real git fetch → SecurityEvent ${ev!.id} (egress/allow) → OCSF Detection Finding a SOC can ingest`);
    console.log("     OCSF: " + JSON.stringify({ class_uid: ocsf.class_uid, disposition_id: ocsf.disposition_id, message: ocsf.message }));
  } finally {
    rmSync(bare, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true });
  }
} else {
  ok("live reach-out audit skipped (git not available)");
}

console.log("\n== P-REPORT.10 demo OK ==");
