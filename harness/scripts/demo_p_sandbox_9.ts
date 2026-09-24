// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_sandbox_9.ts
//
// P-SANDBOX.9 (ADR-0384): a green AppContainer pill must mean a WORKING chat. On beta.7, with the loopback
// exemption registered, the pill went green and every turn died with "acp: agent process exited (code 1)
// - last stderr: [lucid-appcontainer] acl grant ...node_modules\.bin rx". Four stacked causes, one fix each:
//   1. the helper never handed its std handles to the child, so omp (which speaks ACP over stdio) saw EOF
//      and exited 1, its own stderr lost. Now: STARTF_USESTDHANDLES + a handle list of exactly those three;
//   2. the child could read only the workspace and `node_modules\.bin`. Now: rx on the repo + bun runtime,
//      rw on ~/.omp, TEMP inside it;
//   3. omp 18 proxies inference via PI_PROXY only. Now: PI_PROXY + ALL_PROXY on every mediated wrap;
//   4. `--register-loopback` before the profile existed stored a nameless SID. Now: profile first.
// And the probe that lit the pill is now a stdio round trip, so a helper without fix 1 is never committed to.
//
// Run: bun run harness/scripts/demo_p_sandbox_9.ts

import { tmpdir } from "node:os";
import { buildStartupInfoExW, creationFlags, inheritableHandleList, main } from "../../tools/appcontainer/lucid_appcontainer.ts";
import { AppContainerBackend, appContainerProbeArgv, appContainerProbePassed, appContainerRuntimeGrants, APPCONTAINER_PROBE_MARKER } from "../runs/sandbox_exec.ts";
import { caps } from "../runs/profiles.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`  ok  ${m}`); };

console.log("== #ADR-0384 P-SANDBOX.9: a green AppContainer pill means a working chat ==\n");

console.log("[1] the contained child owns the helper's std handles (ACP rides stdio)");
const si = new DataView(buildStartupInfoExW(0x1000n, { stdin: 0x10n, stdout: 0x20n, stderr: 0x20n }).buffer);
ok(si.getUint32(60, true) === 0x100, "STARTUPINFO carries STARTF_USESTDHANDLES");
ok(si.getBigUint64(80, true) === 0x10n && si.getBigUint64(88, true) === 0x20n && si.getBigUint64(96, true) === 0x20n, "stdin/stdout/stderr land at +80/+88/+96");
ok(JSON.stringify(inheritableHandleList({ stdin: 0x10n, stdout: 0x20n, stderr: 0x20n }).map(String)) === JSON.stringify(["16", "32"]), "only the distinct std handles are inheritable (no other handle leaks into the container)");
ok((creationFlags(false) & 0x08000000) !== 0, "no console window pops when the GUI engine launches the helper");

console.log("\n[2] the contained omp can reach its runtime and its state");
const g = appContainerRuntimeGrants({
  repoRoot: "C:\\Users\\u\\AppData\\Local\\Programs\\LucidAgentIDE\\resources\\repo",
  home: "C:\\Users\\u",
  bunBin: "C:\\Users\\u\\AppData\\Local\\Programs\\LucidAgentIDE\\resources\\runtimes\\bun-win32-x64.exe",
  ompBin: "C:\\Users\\u\\AppData\\Local\\Programs\\LucidAgentIDE\\resources\\repo\\node_modules\\.bin\\omp.exe",
});
ok(g.grantRx.includes("C:\\Users\\u\\AppData\\Local\\Programs\\LucidAgentIDE\\resources\\repo"), "rx: the repo tree (the @oh-my-pi package + our -e extensions)");
ok(g.grantRx.includes("C:\\Users\\u\\AppData\\Local\\Programs\\LucidAgentIDE\\resources\\runtimes"), "rx: the bun runtime the omp shim execs");
ok(g.grantRw.length === 1 && g.grantRw[0] === "C:\\Users\\u\\.omp", "rw: ~/.omp only (sessions, agent.db, audit), never the whole profile");
const plan = new AppContainerBackend(() => true, "lucid-appcontainer.exe", () => true).wrap(["omp.exe", "acp"], caps("trusted-local"), {
  workspace: "C:\\ws",
  proxy: { host: "127.0.0.1", httpPort: 8888, httpProxyUrl: "http://127.0.0.1:8888" },
  ...g,
});
const flat = plan.args.join(" ");
ok(flat.includes("--grant-rx C:\\Users\\u\\AppData\\Local\\Programs\\LucidAgentIDE\\resources\\repo") && flat.includes("--grant-rw C:\\Users\\u\\.omp"), "the grants reach the helper's flag contract");
ok(plan.env.TEMP === g.tmpDir && g.tmpDir.startsWith("C:\\Users\\u\\.omp\\"), "TEMP/TMP point inside the granted ~/.omp");

console.log("\n[3] inference is steered at the mediating proxy the way omp 18 actually reads it");
ok(plan.env.PI_PROXY === "http://127.0.0.1:8888", "PI_PROXY is set (omp's global fetch + provider transports)");
ok(plan.env.HTTPS_PROXY === "http://127.0.0.1:8888" && plan.env.ALL_PROXY === "http://127.0.0.1:8888", "HTTP(S)_PROXY + ALL_PROXY for everything else");
ok(flat.includes("--loopback-only") && !flat.includes("--deny-network"), "still --loopback-only: no direct internet, the proxy is the only way out");

console.log("\n[4] the probe that lights the pill proves stdio, not just exit 0");
ok(appContainerProbeArgv("h", "C:\\t").join(" ").endsWith(`echo ${APPCONTAINER_PROBE_MARKER}`), "the probe echoes a marker from inside the container");
ok(!appContainerProbePassed({ exitCode: 0, stdout: "" }), "a helper that exits 0 but carries no stdout (the beta.7 helper) is NOT committed to");
ok(appContainerProbePassed({ exitCode: 0, stdout: `${APPCONTAINER_PROBE_MARKER}\r\n` }), "a helper that round-trips the marker is");

console.log("\n[5] live");
if (process.platform === "win32") {
  const r = Bun.spawnSync({ cmd: ["bun", "run", "tools/appcontainer/lucid_appcontainer.ts", ...appContainerProbeArgv("", tmpdir()).slice(1)], stdout: "pipe", stderr: "inherit", stdin: "ignore" });
  ok(appContainerProbePassed({ exitCode: r.exitCode, stdout: r.stdout.toString() }), "LIVE: a contained cmd echoed the marker back through our pipe");
} else {
  ok(main(["--workspace", "/tmp", "--loopback-only", "--", "omp", "acp"]) === 3, "off-Windows the helper still fail-closes (exit 3), never a passthrough");
  console.log("  (the live stdio round trip runs on Windows)");
}

console.log("\n✓ P-SANDBOX.9 demo passed - the contained omp owns its stdio, can read its runtime and write its state, proxies inference via PI_PROXY, and the pill only lights when stdio round-trips.");
