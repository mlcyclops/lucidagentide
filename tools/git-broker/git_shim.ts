// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/git-broker/git_shim.ts - P-SANDBOX.17 (ADR-0399): the contained agent's `git`.
//
// Git for Windows cannot start inside the AppContainer (ADR-0397), so git.cmd (first on the contained
// agent's PATH) runs this with the agent's argv. It hands {args, cwd} to the engine's /api/git/exec
// (LUCID_GIT_URL carries the agent's own token) and replays the host git's stdout, stderr and exit code.
// The engine decides what may run (desktop/git_broker.ts); this side only carries bytes. No stdin.

const url = process.env.LUCID_GIT_URL;
if (!url) {
  process.stderr.write("git: LUCID's git broker is not available in this session (LUCID_GIT_URL is unset)\n");
  process.exit(128);
}
let res: Response;
try {
  res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) });
} catch (e) {
  process.stderr.write(`git: could not reach LUCID's git broker: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(128);
}
const body = (await res.json().catch(() => null)) as { ok?: boolean; data?: { code?: number; stdout?: string; stderr?: string } } | null;
if (!res.ok || !body?.ok || !body.data) {
  process.stderr.write(`git: LUCID's git broker answered ${res.status}\n`);
  process.exit(128);
}
await Bun.write(Bun.stdout, Buffer.from(body.data.stdout ?? "", "base64"));
await Bun.write(Bun.stderr, Buffer.from(body.data.stderr ?? "", "base64"));
process.exit(typeof body.data.code === "number" ? body.data.code : 128);
