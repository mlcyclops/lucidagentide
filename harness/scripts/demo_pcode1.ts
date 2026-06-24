// harness/scripts/demo_pcode1.ts
//
// ADR-0030 P-CODE.1: git-based code-activity metric. Build a throwaway git repo,
// land a commit this month (plus excluded dependency churn), and prove
// codeActivity() reports the repo's diffstat — and FAIL-CLOSED-omits a non-git dir.
//
// Honest framing: this is REPO/WORKSPACE activity (every commit), NOT AI authorship
// (that's the separate aiLoc metric, ADR-0031). Run with: bun run harness/scripts/demo_pcode1.ts

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { codeActivity } from "../../tools/memory_data.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };

if (!Bun.spawnSync(["git", "--version"], { stdout: "pipe", stderr: "pipe" }).success) fail("git is required for this demo");

const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });

// Created UNDER home so the home-subtree confinement (pathWithin, ADR-0022) admits it
// on every platform (the system tmpdir is outside home on Linux CI).
const repo = mkdtempSync(join(homedir(), ".lucid-demo-pcode1-"));
const nogit = mkdtempSync(join(homedir(), ".lucid-demo-pcode1-nogit-"));

try {
  console.log("== [1/3] seed a git repo with a real change this month ==");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "demo@demo.test");
  git(repo, "config", "user.name", "Demo");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "feature.ts"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n", "utf8");
  writeFileSync(join(repo, "README.md"), "# demo\nline two\n", "utf8");
  mkdirSync(join(repo, "node_modules"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "dep.js"), "lots\nof\nvendor\nchurn\n", "utf8"); // EXCLUDED from the metric
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");

  console.log("== [2/3] codeActivity() reports the diffstat (vendored churn excluded) ==");
  const ca = codeActivity({ workspaces: [repo, nogit] }); // nogit has no .git → must be omitted
  console.log(`   month        : ${ca.month} (${ca.daysInMonth} days)`);
  console.log(`   workspaces   : ${ca.workspaces.length}`);
  for (const w of ca.workspaces) console.log(`     ${w.name}: +${w.added} / -${w.deleted} · ${w.files} files · spend $${w.spend}`);
  console.log(`   totals       : +${ca.totals.added} / -${ca.totals.deleted} · ${ca.totals.files} files`);

  if (ca.workspaces.length !== 1) fail(`expected exactly 1 workspace (the git repo), got ${ca.workspaces.length}`);
  const ws = ca.workspaces[0]!;
  if (ws.added !== 5) fail(`expected 5 lines added (3 + 2; node_modules excluded), got ${ws.added}`);
  if (ws.files !== 2) fail(`expected 2 files (feature.ts + README.md), got ${ws.files}`);
  if (ws.spend !== 0) fail(`expected spend 0 (attribution is P-CODE.2), got ${ws.spend}`);

  console.log("== [3/3] FAIL-CLOSED: the non-git directory was omitted, never faked ==");
  if (ca.workspaces.some((w) => w.path === nogit)) fail("non-git dir leaked into results");
  console.log(`   omitted non-git dir: ${nogit.split(/[\\/]/).pop()}`);

  console.log("\ndemo_pcode1 OK");
} finally {
  rmSync(repo, { recursive: true, force: true });
  rmSync(nogit, { recursive: true, force: true });
}
process.exit(0);
