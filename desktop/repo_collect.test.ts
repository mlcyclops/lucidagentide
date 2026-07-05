// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/repo_collect.test.ts — P-REPORT.10 (ADR-0164): a formal SecurityEvent per fetch / PR reach-out.
//
// The report collector's git fetch / gh PR list are FIRST-PARTY reach-outs that bypass the agent tool
// gate by design; each ACTUAL reach-out must now leave an audit record. Two layers:
//   (pure)   reachoutAuditEvents — over-tested: it decides WHAT fires (category/type/decision/severity/
//            tool/reason), the skip cases fire NOTHING, and the reason never leaks a credential.
//   (wiring) collectRepoActivity threads an injectable emit; proven OFFLINE against a temp repo with a
//            LOCAL bare origin (a real git fetch, zero network) — fetch:true fires one event, fetch:false
//            fires none.

import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { reachoutAuditEvents, collectRepoActivity } from "./repo_collect.ts";
import { parseRemoteUrl, type PrStatus } from "../harness/brief/repo_activity.ts";
import type { SecurityEventInput } from "./audit_export.ts";

const GH = parseRemoteUrl("https://github.com/acme/widgets.git"); // host github.com
const BLANK = parseRemoteUrl(""); // host "" (local / unparsed remote)

describe("reachoutAuditEvents (pure)", () => {
  test("fetch attempted + ok → one egress report_fetch(allow/info/git) with host in reason", () => {
    const evs = reachoutAuditEvents(GH, { fetched: true, fetchOk: true, prStatus: "skipped-off" });
    expect(evs.length).toBe(1);
    const e = evs[0]!;
    expect(e.category).toBe("egress");
    expect(e.type).toBe("report_fetch");
    expect(e.decision).toBe("allow");
    expect(e.severity).toBe("info");
    expect(e.tool).toBe("git");
    expect(e.reason).toContain("github.com");
    expect(e.reason).toContain("ok");
  });

  test("fetch attempted + failed → report_fetch whose reason says failed (still decision allow)", () => {
    const e = reachoutAuditEvents(GH, { fetched: true, fetchOk: false, prStatus: "skipped-off" })[0]!;
    expect(e.type).toBe("report_fetch");
    expect(e.decision).toBe("allow");
    expect(e.reason).toContain("failed");
  });

  test("not fetched → no fetch event", () => {
    const evs = reachoutAuditEvents(GH, { fetched: false, fetchOk: true, prStatus: "skipped-off" });
    expect(evs.find((e) => e.type === "report_fetch")).toBeUndefined();
  });

  test("blank / local host → recorded as (local/unparsed remote), no raw path", () => {
    const e = reachoutAuditEvents(BLANK, { fetched: true, fetchOk: true, prStatus: "skipped-off" })[0]!;
    expect(e.reason).toContain("local/unparsed remote");
  });

  test("PR ok → one egress report_pr_list(allow/info/gh)", () => {
    const evs = reachoutAuditEvents(GH, { fetched: false, fetchOk: true, prStatus: "ok" });
    expect(evs.length).toBe(1);
    const e = evs[0]!;
    expect(e.type).toBe("report_pr_list");
    expect(e.category).toBe("egress");
    expect(e.decision).toBe("allow");
    expect(e.tool).toBe("gh");
    expect(e.reason).toContain("github.com");
    expect(e.reason).toContain("ok");
  });

  test("PR error (gh ran but failed) → report_pr_list whose reason says failed", () => {
    const e = reachoutAuditEvents(GH, { fetched: false, fetchOk: true, prStatus: "error" }).find((x) => x.type === "report_pr_list")!;
    expect(e).toBeDefined();
    expect(e.reason).toContain("failed");
  });

  // The skip statuses never spawned gh → no reach-out → no event.
  for (const s of ["skipped-off", "skipped-nonhub", "skipped-unauthed"] as PrStatus[]) {
    test(`PR ${s} → no report_pr_list event`, () => {
      const evs = reachoutAuditEvents(GH, { fetched: false, fetchOk: true, prStatus: s });
      expect(evs.find((e) => e.type === "report_pr_list")).toBeUndefined();
    });
  }

  test("fetch + PR both reached → exactly the two events", () => {
    const evs = reachoutAuditEvents(GH, { fetched: true, fetchOk: true, prStatus: "ok" });
    expect(evs.map((e) => e.type).sort()).toEqual(["report_fetch", "report_pr_list"]);
  });

  test("no reach-out (not fetched + skipped) → zero events", () => {
    expect(reachoutAuditEvents(GH, { fetched: false, fetchOk: true, prStatus: "skipped-off" }).length).toBe(0);
  });

  test("reason never carries userinfo / credentials even from a token-bearing URL", () => {
    const withTok = parseRemoteUrl("https://user:ghp_secrettoken@github.com/acme/widgets.git");
    const evs = reachoutAuditEvents(withTok, { fetched: true, fetchOk: true, prStatus: "ok" });
    expect(evs.length).toBe(2);
    for (const e of evs) {
      expect(e.reason).toContain("github.com");
      expect(e.reason).not.toContain("ghp_secrettoken");
      expect(e.reason).not.toContain("user:");
      expect(e.reason).not.toContain("@");
    }
  });
});

// ── offline wiring: collectRepoActivity fires the audit through its injected emit ─────────────────────
const cleanup: string[] = [];
afterAll(() => { for (const d of cleanup) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } });

const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
const gitAvailable = Bun.spawnSync(["git", "--version"], { stdout: "pipe", stderr: "pipe" }).success;

describe("collectRepoActivity reach-out audit (offline wiring)", () => {
  test.skipIf(!gitAvailable)("a fetch from a LOCAL bare origin emits one report_fetch; fetch:false emits none", async () => {
    // A bare repo stands in for the "remote" — git fetch against it does real work with ZERO network.
    const bare = mkdtempSync(join(homedir(), ".lucid-repo10-bare-")); cleanup.push(bare);
    git(bare, "init", "-q", "--bare", "-b", "main");
    const work = mkdtempSync(join(homedir(), ".lucid-repo10-work-")); cleanup.push(work);
    git(work, "init", "-q", "-b", "main");
    git(work, "config", "user.email", "t@t.test");
    git(work, "config", "user.name", "Test");
    writeFileSync(join(work, "a.txt"), "hello\n");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "init");
    git(work, "remote", "add", "origin", bare);
    git(work, "push", "-q", "origin", "main");

    const rec: SecurityEventInput[] = [];
    const emit = (e: SecurityEventInput) => { rec.push(e); };

    // fetch ON, prs OFF → exactly one report_fetch (allow, ok), no PR event (gh never ran).
    await collectRepoActivity([{ path: work, fetch: true, prs: false }], { fetch: true, prs: false, window: 5 }, emit);
    const fetches = rec.filter((e) => e.type === "report_fetch");
    expect(fetches.length).toBe(1);
    expect(fetches[0]!.category).toBe("egress");
    expect(fetches[0]!.decision).toBe("allow");
    expect(fetches[0]!.reason).toContain("ok");
    expect(rec.find((e) => e.type === "report_pr_list")).toBeUndefined();

    // fetch OFF, prs OFF → no reach-out happened → no events.
    rec.length = 0;
    await collectRepoActivity([{ path: work, fetch: false, prs: false }], { fetch: false, prs: false, window: 5 }, emit);
    expect(rec.length).toBe(0);
  });
});
