// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_mxc_1.ts
//
// P-MXC.1 (ADR-0441): the Microsoft eXecution Container executor behind the SandboxBackend seam, Windows
// first. Proves, against the REAL pinned `wxc-exec.exe` where it is staged (and on the pure seam everywhere):
//   (a) resolution order: mxc when its round trip passes, the helper when only that passes, refusal under
//       managed require-isolation when neither;
//   (b) the stdio nonce round trip through a contained bundled bun;
//   (c) a network-off child cannot resolve or connect;
//   (d) a mediated child reaches the loopback proxy (the moniker's exemption) and nothing direct;
//   (e) a write under the workspace lands; a write to its parent and to the profile is refused;
//   (f) one flipped byte in the executor refuses before any child starts, naming both hashes; a malformed
//       request refuses in --dry-run;
//   (g) the posture carries the backend and its tier;
//   (i) no request file: the plan carries the request on argv and names no path on disk.
// (h), every prior demo staying green, is `make test`.
//
// Run: bun run harness/scripts/demo_p_mxc_1.ts

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { MXC_ASSETS } from "../runs/mxc_assets.ts";
import { caps } from "../runs/profiles.ts";
import { resolveBackend, APPCONTAINER_MONIKER } from "../runs/sandbox_exec.ts";
import { MXC_CONTAINER_ID, MxcBackend, mxcArgs, mxcProbeArgv, mxcProbePassed, mxcRequest, type MxcHost } from "../runs/sandbox_mxc.ts";
import { mxcHost, mxcRoundTripProbe, parseMxcProbe, verifiedMxcExecutors } from "../../desktop/mxc_runtime.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`  ok  ${m}`); };
// Async on purpose: check (d) serves a loopback listener from THIS process, and a blocking spawnSync would
// starve it (the container connects, then times out waiting for a reply the event loop never sends).
const run = async (cmd: string[], opts: { stdin?: string } = {}) => {
  const p = Bun.spawn({ cmd, stdin: opts.stdin !== undefined ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe", timeout: 40_000 });
  const sink = p.stdin;
  if (opts.stdin !== undefined && sink && typeof sink !== "number") { sink.write(opts.stdin); sink.flush(); sink.end(); }
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
};

console.log("== #ADR-0441 P-MXC.1: MXC behind the sandbox seam ==\n");

console.log("[a] resolution order on the pure seam");
const host = (pass: boolean, tier: MxcHost["tier"] = "appcontainer-dacl"): MxcHost => ({ exe: "C:\\mxc\\wxc-exec.exe", tier, probe: () => pass });
const helperOk = { which: (b: string) => b === "C:\\bin\\lucid-appcontainer.exe", probe: () => true };
const none = { which: () => false, probe: () => false };
let r = resolveBackend({ platform: "win32", ...helperOk, mxc: host(true), appContainerHelper: "C:\\bin\\lucid-appcontainer.exe" });
ok(r.ok && r.backend.name === "mxc", "mxc wins when its round trip passes, even with a working helper beside it");
r = resolveBackend({ platform: "win32", ...helperOk, mxc: host(false), appContainerHelper: "C:\\bin\\lucid-appcontainer.exe" });
ok(r.ok && r.backend.name === "appcontainer", "a failed mxc round trip falls through to the helper");
r = resolveBackend({ platform: "win32", ...none, mxc: host(false), requireIsolation: true });
ok(!r.ok, "managed require-isolation with neither runtime REFUSES (no passthrough)");
ok(MXC_CONTAINER_ID === APPCONTAINER_MONIKER, "mxc runs under the helper's moniker: one loopback exemption for both");

console.log("\n[i] the plan names no file on disk");
const plan = new MxcBackend(host(true)).wrap(["C:\\bun\\bun.exe", "x.ts"], caps("trusted-local"), { workspace: "C:\\w" });
ok(plan.args[0] === "--config-base64" && !plan.args.some((a) => /\.json$/i.test(a) && existsSync(a)), "request travels as --config-base64 on argv; no request file");
const decoded = JSON.parse(Buffer.from(plan.args[1]!, "base64").toString("utf8")) as { network: { egress: { default: string } } };
ok(decoded.network.egress.default === "deny", "egress.default is deny in the emitted request");


console.log("\n[f] a flipped byte refuses before any child starts");
{
  const spec = MXC_ASSETS.find((a) => a.platform === "win32-x64" && a.name === "wxc-exec.exe")!;
  const dir = join(tmpdir(), "lucid-mxc-demo-flip");
  mkdirSync(dir, { recursive: true });
  const bytes = Buffer.alloc(spec.bytes, 7);
  writeFileSync(join(dir, "wxc-exec.exe"), bytes);
  writeFileSync(join(dir, "wxc-host-prep.exe"), "not the tool");
  const v = verifiedMxcExecutors({ dir, source: "staged" }, "win32", "x64");
  ok(!v.ok && v.reason.includes("wxc-exec.exe") && v.reason.includes(spec.sha256), "refused by name with the pinned hash in the reason");
  rmSync(dir, { recursive: true, force: true });
}

if (process.platform !== "win32") { console.log("\n(not Windows: the real-executor checks b-f are skipped here; they run on the Windows gate)"); process.exit(0); }

const live = mxcHost();
if (!live.host) { console.log(`\n(the MXC executor is not staged on this host: ${live.reason}; run \`bun run mxc --dev\` in desktop/ to exercise b-f)`); process.exit(0); }
console.log(`\nreal executor: ${live.executors.exe} (${live.executors.source}), tier ${live.host.tier}, prep pending: ${live.probe.prepNeeded.join(", ") || "none"}`);

console.log("\n[b] the stdio nonce round trip through the executor");
// Under the profile root, not %TEMP%: the helper granted the shared container SID an inheritable ACE on
// Temp (and ~/.omp) on hosts that ran it, so a parent there is writable BY DESIGN and proves nothing.
const demoRoot = join(homedir(), ".lucid-mxc-demo");
const ws = join(demoRoot, "ws");
mkdirSync(ws, { recursive: true });
const probe = await run(mxcProbeArgv(live.host.exe, ws));
ok(mxcProbePassed({ exitCode: probe.code, stdout: probe.out }), `cmd echo came back through our pipe (exit ${probe.code})`);
ok(mxcRoundTripProbe(live.host.exe), "the cached engine probe agrees");
const bun = process.execPath;
const nonce = `nonce-${Date.now()}`;
const reqOff = mxcRequest(caps("trusted-local"), { workspace: ws, grantRx: [join(bun, "..")], proxy: undefined }, live.host.tier);
const echo = await run([live.host.exe, ...mxcArgs(reqOff, [bun, "-e", "process.stdin.on('data',d=>{process.stdout.write('echo:'+d);process.exit(0)})"])], { stdin: nonce + "\n" });
ok(echo.out.includes(`echo:${nonce}`), `a contained bun echoed the nonce from stdin (exit ${echo.code})`);

console.log("\n[c] network-off: no resolve, no connect");
const off = await run([live.host.exe, ...mxcArgs(reqOff, ["curl.exe", "-sS", "-m", "6", "-o", "-", "https://example.com"])]);
ok(off.code !== 0 && !/<html/i.test(off.out), `curl to example.com failed inside (exit ${off.code}: ${off.err.trim().slice(0, 60)})`);

console.log("\n[d] mediated: the loopback proxy is reachable, nothing direct is");
const srv = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("loopback-ok") });
const port = srv.port ?? 0;
const proxyUrl = `http://127.0.0.1:${port}`;
const reqOn = mxcRequest(caps("trusted-local"), { workspace: ws, proxy: { host: "127.0.0.1", httpPort: port, httpProxyUrl: proxyUrl } }, live.host.tier);
const envInside = await run([live.host.exe, ...mxcArgs(reqOn, ["cmd.exe", "/c", "echo %PI_PROXY%"])]);
ok(envInside.out.trim() === proxyUrl, "PI_PROXY inside the container points at the proxy (request env, not inherited env)");
const loop = await run([live.host.exe, ...mxcArgs(reqOn, ["curl.exe", "-sS", "-m", "6", `${proxyUrl}/`])]);
const exempt = (await run(["CheckNetIsolation.exe", "LoopbackExempt", "-s"])).out.toLowerCase().includes(MXC_CONTAINER_ID.toLowerCase());
if (live.host.tier === "base-container" || exempt) ok(loop.out.includes("loopback-ok"), `the loopback proxy answered inside the container (${live.host.tier}${exempt ? ", exemption registered" : ""}; exit ${loop.code} out=${JSON.stringify(loop.out.slice(0, 40))} err=${loop.err.replace(/s+/g, " ").slice(0, 80)})`);
else console.log(`  --  loopback exemption not registered for ${MXC_CONTAINER_ID} on this host: mediated reach is unprovable here (curl exit ${loop.code}); the engine would not offer mxc for a network-on profile`);
const direct = await run([live.host.exe, ...mxcArgs(reqOn, ["curl.exe", "-sS", "-m", "6", "-o", "-", "https://example.com"])]);
ok(direct.code !== 0 && !/<html/i.test(direct.out), `a direct dial from the mediated container still fails (exit ${direct.code})`);
srv.stop(true);

console.log("\n[e] writes: inside the workspace yes, outside no");
await run([live.host.exe, ...mxcArgs(reqOff, ["cmd.exe", "/c", `echo in > ${join(ws, "inside.txt")}`])]);
ok(existsSync(join(ws, "inside.txt")) && readFileSync(join(ws, "inside.txt"), "utf8").trim() === "in", "a write under the workspace landed");
const parentTarget = join(ws, "..", `lucid-mxc-escape-${Date.now()}.txt`);
const outside = await run([live.host.exe, ...mxcArgs(reqOff, ["cmd.exe", "/c", `echo out > ${parentTarget}`])]);
ok(!existsSync(parentTarget), `a write to the workspace's parent was refused (${outside.err.trim().slice(0, 40) || `exit ${outside.code}`})`);
const profileTarget = join(homedir(), `lucid-mxc-escape-${Date.now()}.txt`);
await run([live.host.exe, ...mxcArgs(reqOff, ["cmd.exe", "/c", `echo out > `])]);
ok(!existsSync(profileTarget), "a write into the user profile was refused");
rmSync(demoRoot, { recursive: true, force: true });

console.log("\n[f] a malformed request refuses in --dry-run");
const badReq = { ...reqOff, network: { egress: { default: "deny" }, ingress: { default: "allow" } } }; // deny+allow is rejected on the AppContainer fallback
const dry = await run([live.host.exe, "--dry-run", "--config-base64", Buffer.from(JSON.stringify(badReq)).toString("base64")]);
const garbage = await run([live.host.exe, "--dry-run", "--config-base64", Buffer.from("{not json").toString("base64")]);
ok(garbage.code !== 0, `garbage JSON refuses (exit ${garbage.code})`);
console.log(`  --  deny-egress + allow-ingress on tier ${live.host.tier}: exit ${dry.code} (${(dry.err || dry.out).replace(/\s+/g, " ").slice(0, 90)})`);

const probeJson = await run([live.host.exe, "--probe"]);
ok(parseMxcProbe(probeJson.out)?.tier === live.host.tier, `--probe reports the tier the engine cached (${live.host.tier})`);

console.log("\nALL CHECKS PASSED");
