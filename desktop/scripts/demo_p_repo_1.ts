// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_repo_1.ts
//
// Increment P-REPO.1 (ADR-0404): every session names the repo it works on and where its commits go, and a
// spoke is started by picking a repo instead of typing a URL. Against REAL git in throwaway repos (no
// network), this proves:
//   (1) a folder's push target follows git's own rules (upstream remote, remote.pushDefault) and the
//       token inside a remote URL never reaches the view;
//   (2) a repo with no remote reads "Local only";
//   (3) a session whose folder is NOT a repo takes its repo from the files it edits, reads only steer
//       until the first edit, and a later edit in another repo moves it and lists the first as "also";
//   (4) the spoke picker lists git checkouts inside the workspace with branch and push target, and
//       drops a subfolder that is not a checkout.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localRepoChoices, observeToolCall, repoContext, repoView } from "../repo_probe.ts";
import { pushLabel } from "../repo_identity.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} \u2713`);
const git = (cwd: string, ...args: string[]): void => {
  const r = Bun.spawnSync(["git", "-c", "safe.directory=*", "-C", cwd, ...args], { stdout: "ignore", stderr: "pipe" });
  if (r.exitCode !== 0) fail(`git ${args.join(" ")}: ${r.stderr.toString()}`);
};

console.log("== P-REPO.1: which repo, and where do commits go ==");
const home = mkdtempSync(join(tmpdir(), "lucid-repo-1-"));
try {
  const app = join(home, "app");
  const notes = join(home, "notes");
  mkdirSync(app); mkdirSync(notes); mkdirSync(join(home, "plain"));
  for (const r of [app, notes]) {
    git(r, "init", "-q", "-b", "main");
    writeFileSync(join(r, "README.md"), "x\n");
    git(r, "add", "."); git(r, "-c", "user.email=d@x", "-c", "user.name=d", "commit", "-qm", "init");
  }
  git(app, "remote", "add", "origin", "https://x-access-token:ghp_demoSECRET@github.com/acme/app.git");
  git(app, "remote", "add", "upstream", "git@github.com:bigco/app.git");
  git(app, "checkout", "-qb", "feat/login");
  git(app, "config", "branch.feat/login.remote", "upstream");
  git(app, "config", "branch.feat/login.merge", "refs/heads/main");

  // (1) upstream remote wins over origin; pushDefault wins over the upstream; no token anywhere.
  let v = await repoView(app, 0);
  if (!v?.push || v.push.remote !== "upstream" || v.push.owner !== "bigco") fail(`expected upstream bigco/app, got ${JSON.stringify(v?.push)}`);
  ok(`feat/login pushes to ${pushLabel(v!)}`);
  git(app, "config", "remote.pushDefault", "origin");
  v = await repoView(app, 0);
  if (v?.push?.remote !== "origin" || v.push.webUrl !== "https://github.com/acme/app") fail(`pushDefault ignored: ${JSON.stringify(v?.push)}`);
  if (JSON.stringify(v).includes("ghp_demoSECRET")) fail("the remote's token leaked into the view");
  ok(`remote.pushDefault=origin: ${pushLabel(v!)}, token not in the view`);

  // (2) no remote at all.
  const n = await repoView(notes, 0);
  if (n?.push !== null || pushLabel(n!) !== "Local only: no remote") fail(`notes should be local only: ${JSON.stringify(n)}`);
  ok(`notes: ${pushLabel(n!)}`);

  // (3) the session's folder is `home` (not a repo); its tool calls decide.
  const sid = "demo-session";
  const before = await repoContext(sid, home);
  if (before.repo !== null) fail("a non-repo folder with no activity must show no repo");
  observeToolCall(sid, { kind: "read", rawInput: { path: "notes/README.md:1-5" } }, home);
  await Bun.sleep(800);
  let ctx = await repoContext(sid, home);
  if (ctx.repo?.name !== "notes" || ctx.source !== "activity") fail(`a read should steer before any edit: ${ctx.repo?.name}`);
  observeToolCall(sid, { kind: "edit", locations: [{ path: join(app, "README.md") }] }, home);
  await Bun.sleep(800);
  observeToolCall(sid, { kind: "read", rawInput: { path: join(notes, "README.md") } }, home);
  await Bun.sleep(800);
  ctx = await repoContext(sid, home);
  if (ctx.repo?.name !== "app") fail(`after an edit in app a read must not move it: ${ctx.repo?.name}`);
  observeToolCall(sid, { kind: "execute", rawInput: { command: `cd "${notes}" && git commit -am wip` } }, home);
  await Bun.sleep(800);
  ctx = await repoContext(sid, home);
  if (ctx.repo?.name !== "notes" || ctx.others.map((o) => o.name).join() !== "app") fail(`a command in notes should move it, app listed: ${ctx.repo?.name} / ${ctx.others.map((o) => o.name)}`);
  ok("home folder: read -> notes, edit -> app (reads no longer steer), command in notes -> notes (also: app)");

  // (4) the picker's local list.
  const choices = await localRepoChoices([{ path: home, source: "workspace" }], [{ dir: home, source: "nearby" }]);
  const names = choices.map((c) => `${c.name}:${c.isGit ? c.branch : "-"}:${c.slug}`);
  if (names.join() !== `${home.split(/[\\/]/).pop()}:-:,app:feat/login:acme/app,notes:main:`) fail(`picker list: ${names.join(" | ")}`);
  ok(`picker: ${names.join(" | ")} (plain/ is not a checkout, so it is not offered)`);
  console.log("PASS: P-REPO.1");
} finally {
  rmSync(home, { recursive: true, force: true });
}
