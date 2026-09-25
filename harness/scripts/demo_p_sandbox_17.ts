// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_sandbox_17.ts
//
// P-SANDBOX.17 (ADR-0399): the contained agent's git runs OUTSIDE the sandbox, through a broker. Git for
// Windows cannot start inside the AppContainer, so `git` there is tools/git-broker/git.cmd, which hands
// {args, cwd} to the engine; desktop/git_broker.ts decides what the host git may do as the user.
//
// Run: bun run harness/scripts/demo_p_sandbox_17.ts

import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { forcedConfig, hold, planGitCall, refusedConfigKey } from "../../desktop/git_broker.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`  ok  ${m}`); };
const REPO = join(import.meta.dir, "..", "..");
const WS = "C:\\Users\\U\\ws";
const refusedBy = (argv: string[]) => { const r = planGitCall(argv, WS, WS); return r.ok ? "" : r.reason; };

console.log("== #ADR-0399 P-SANDBOX.17: the contained agent's git runs on the host, through a broker ==\n");

console.log("[1] nothing the agent sends can make host git run a program");
ok(refusedBy(["st"]).includes("not one of"), "aliases and external git-* commands never run");
ok(refusedBy(["-c", "core.fsmonitor=calc", "status"]).includes("global options"), "no -c / -C / --git-dir from the agent");
ok(!!refusedBy(["rebase", "-ix", "calc", "main"]) && !!refusedBy(["grep", "-Ocalc", "x"]) && !!refusedBy(["clone", "-c", "a=b", "https://h/r"]), "rebase -x, grep -O and clone -c are refused, even inside flag clusters");
ok(!!refusedBy(["fetch", "--upload-pack=calc"]) && !!refusedBy(["push", "--receive-pack=calc", "o"]), "--upload-pack / --receive-pack are refused");
const forced = forcedConfig({ hooksDir: "H", proxyUrl: "http://127.0.0.1:1" }).join(" ");
ok(forced.includes("core.hooksPath=H") && forced.includes("core.fsmonitor=false") && forced.includes("protocol.allow=never") && forced.includes("http.proxy="), "command-line overrides: no hooks, no fsmonitor, https only, through the egress proxy");

console.log("\n[2] host git reads only an allowlisted repo config");
ok(refusedConfigKey(["core.bare", "remote.origin.url", "branch.main.merge"]) === null, "a normal clone's config passes");
for (const k of ["core.fsmonitor", "filter.x.clean", "credential.helper", "include.path", "alias.st"]) ok(refusedConfigKey([k]) === k, `${k} refuses the call`);

console.log("\n[3] every path stays in the workspace");
ok(refusedBy(["diff", "--no-index", "C:\\Users\\U\\.ssh\\id_rsa", "a"]).includes("outside the workspace"), "a file outside the workspace cannot be read through git");
ok(refusedBy(["log", "--output=C:\\Users\\U\\Startup\\x.bat"]).includes("outside the workspace"), "nor written");

if (process.platform === "win32") {
  console.log("\n[4] the config it validated is the config git reads (Windows share modes, real filesystem)");
  const root = join(REPO, ".lucid-demo-sandbox-17");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  const cfg = join(root, ".git", "config");
  writeFileSync(cfg, "[core]\n\tbare = false\n");
  const throws = (fn: () => void) => { try { fn(); return false; } catch { return true; } };
  const d = hold(join(root, ".git"), { dir: true });
  const c = hold(cfg);
  ok(!!d && !!c, "the broker holds .git and .git/config");
  ok(readFileSync(cfg, "utf8").includes("bare"), "git can still read the config");
  ok(throws(() => appendFileSync(cfg, "[core]\n\tfsmonitor = calc\n")), "the agent cannot append to it");
  ok(throws(() => { writeFileSync(`${cfg}.new`, "x"); renameSync(`${cfg}.new`, cfg); }), "nor replace it");
  ok(throws(() => renameSync(join(root, ".git"), join(root, ".git-old"))), "nor swap .git for another directory");
  c?.close(); d?.close();
  ok(!throws(() => appendFileSync(cfg, "#\n")), "released after the call");
  rmSync(root, { recursive: true, force: true });

  console.log("\n[5] git.cmd carries argv, cwd, output and exit code through the shim");
  let seen: { args: string[]; cwd: string } | null = null;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    seen = (await req.json()) as { args: string[]; cwd: string };
    return Response.json({ ok: true, data: { code: 3, stdout: Buffer.from("out bytes\n").toString("base64"), stderr: Buffer.from("err text\n").toString("base64") } });
  } });
  const shim = join(REPO, "tools", "git-broker", "git.cmd");
  // Async: the stand-in broker answers on THIS process's event loop.
  const p = Bun.spawn(["cmd", "/d", "/c", "call", shim, "commit", "-m", "fix: a b & c"], { cwd: REPO, stdout: "pipe", stderr: "pipe", env: { ...process.env, LUCID_GIT_URL: `http://127.0.0.1:${server.port}/api/git/exec`, NO_PROXY: "127.0.0.1", LUCID_BUN_BIN: process.execPath } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  server.stop(true);
  const got = seen as { args: string[]; cwd: string } | null;
  ok(JSON.stringify(got?.args) === JSON.stringify(["commit", "-m", "fix: a b & c"]), `argv arrives intact (${JSON.stringify(got?.args)})`);
  ok(!!got && got.cwd.toLowerCase() === REPO.toLowerCase(), "the agent's cwd arrives");
  ok(out === "out bytes\n" && err === "err text\n" && code === 3, `stdout, stderr and the exit code come back (${JSON.stringify(out)} ${JSON.stringify(err)} ${code})`);
}

console.log("\n[6] the contained agent gets the shim, and the engine serves it on the agent's token");
const dev = readFileSync(join(REPO, "desktop", "dev.ts"), "utf8");
const backend = readFileSync(join(REPO, "desktop", "acp_backend.ts"), "utf8");
ok(/"\/api\/git\/exec",/.test(dev) && dev.includes("process.env.LUCID_GIT_URL = `http://127.0.0.1:${server.port}/api/git/exec?t=${AGENT_TOKEN}`"), "/api/git/exec is an agent route and LUCID_GIT_URL carries the agent token");
ok(backend.includes('join(resolvedRepo().root, "tools", "git-broker")'), "the AppContainer spawn puts tools/git-broker first on PATH");

console.log("\nP-SANDBOX.17 demo passed.");
