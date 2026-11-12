// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_sandbox_16.ts
//
// P-SANDBOX.16 (ADR-0397): the agent finds git wherever the vendors put it. The host PATH is searched
// first, then Git for Windows (Program Files, per-user), MinGit, scoop, Chocolatey, winget's MinGit and
// GitHub Desktop's embedded copy (newest version). The found install root is granted read+execute to the
// AppContainer and its cmd\ dir goes first on the agent's PATH (master session and fleet lanes).
//
// Run: bun run harness/scripts/demo_p_sandbox_16.ts

import { appContainerRuntimeGrants, discoverGitRoot, gitRootCandidates, prependPathOverlay } from "../runs/sandbox_exec.ts";
import { runtimeFolderView } from "../../desktop/sandbox_control.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`  ok  ${m}`); };
const fakeFs = (files: string[], dirs: Record<string, string[]> = {}) => ({
  exists: (p: string) => files.some((f) => f.toLowerCase() === p.toLowerCase()),
  list: (d: string) => { const k = Object.keys(dirs).find((x) => x.toLowerCase() === d.toLowerCase()); if (!k) throw new Error("ENOENT"); return dirs[k]!; },
});
const env = { LOCALAPPDATA: "C:\\Users\\U\\AppData\\Local", USERPROFILE: "C:\\Users\\U", ProgramFiles: "C:\\Program Files", ProgramData: "C:\\ProgramData", PATH: "C:\\Windows\\system32" };

console.log("== #ADR-0397 P-SANDBOX.16: the agent finds git wherever it was installed ==\n");

console.log("[1] the vendor locations are all searched");
const c = gitRootCandidates(env).join("|").toLowerCase();
for (const where of ["program files\\git", "programs\\git", "programs\\mingit", "scoop\\apps\\git\\current", "chocolatey\\lib\\git.portable", "winget\\packages\\git.mingit_*", "githubdesktop\\app-*"]) ok(c.includes(where), `candidates include ${where}`);

console.log("\n[2] a git the host never put on PATH is found");
const mingit = "C:\\Users\\U\\AppData\\Local\\Programs\\MinGit";
ok(discoverGitRoot(env, fakeFs([`${mingit}\\cmd\\git.exe`])) === mingit, "MinGit under %LOCALAPPDATA%\\Programs");
const gd = "C:\\Users\\U\\AppData\\Local\\GitHubDesktop";
ok(discoverGitRoot(env, fakeFs([`${gd}\\app-3.10.0\\resources\\app\\git\\cmd\\git.exe`, `${gd}\\app-3.9.9\\resources\\app\\git\\cmd\\git.exe`], { [gd]: ["app-3.9.9", "app-3.10.0"] })) === `${gd}\\app-3.10.0\\resources\\app\\git`, "GitHub Desktop's embedded git, newest version first");
ok(discoverGitRoot({ ...env, PATH: "D:\\git\\cmd" }, fakeFs(["D:\\git\\cmd\\git.exe", `${mingit}\\cmd\\git.exe`])) === "D:\\git", "the user's own PATH choice wins over a vendor default");
ok(discoverGitRoot(env, fakeFs([])) === null, "no git anywhere: null, nothing granted");

console.log("\n[3] it reaches the agent: PATH first, AppContainer grant, and the Security panel lists it");
const overlay = prependPathOverlay({ Path: "C:\\Windows" }, `${mingit}\\cmd`);
ok(overlay.Path === `${mingit}\\cmd;C:\\Windows`, "cmd\\ is prepended under the env's own PATH spelling");
ok(Object.keys(prependPathOverlay({ PATH: `${mingit}\\cmd;C:\\Windows` }, `${mingit}\\cmd`)).length === 0, "already on PATH: no change");
const g = appContainerRuntimeGrants({ repoRoot: "C:\\r", home: "C:\\Users\\U", gitRoot: mingit });
ok(g.grantRx.includes(mingit), "the install root is granted read+execute to the container");
ok(!appContainerRuntimeGrants({ repoRoot: "C:\\r", home: "C:\\Users\\U", gitRoot: "C:\\Program Files\\Git" }).grantRx.includes("C:\\Program Files\\Git"), "Program Files is already readable, never re-ACL'd");
ok(runtimeFolderView({ workspace: "C:\\ws", grantRx: g.grantRx, grantRw: g.grantRw, tmpDir: g.tmpDir }).some((f) => f.path === mingit && f.why.includes("git")), "the Security panel lists the git folder, labelled");

console.log("\nP-SANDBOX.16 demo passed.");
