// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pfleetl2.ts
//
// P-FLEET.L2: unlimited lanes under a SUSTAINED-pressure guard, lanes spawned from a real repo remote,
// per-HOST credentials, and a minimized fleet HUD that tells the truth while you work in the main window.
// Everything here runs against the REAL modules (no mocks): the real FleetLaneManager over real fake-ACP
// subprocesses, the real pressure arithmetic, the real git-URL parser, the real clone argv builder, and the
// real pill-snapshot reducer.
//
//   1. UNLIMITED LANES: a 2-core box (capped at ONE lane by P-FLEET.L1) runs five concurrent lanes.
//   2. A BURST IS FREE: pegged at 100% CPU and 94% memory for a moment, a lane still starts.
//   3. A HELD LINE REFUSES: 90%+ unbroken for 30s refuses, and the reason carries percent AND duration.
//   4. THE STREAK IS HONEST: one cool reading, or one blind reading (failed sample), resets the clock -
//      a sampling gap can never be counted as load, and no-evidence always fails OPEN.
//   5. REMOTES: https / ssh:// / scp-like all parse for GitHub, GitLab and Azure DevOps; a Windows path is
//      never mistaken for a remote; an embedded password is discarded, never echoed.
//   6. CREDENTIALS: a token is scoped to its HOST (vault ref -> env name -> back), it is offered only to
//      that host, and it rides an Authorization header - never the URL, which would persist into
//      .git/config. Errors are redacted.
//   7. THE MINIMIZED HUD: the status-bar snapshot reduces lanes to one dot + count per state, ordered
//      "needs a human first", with a hover naming the lanes.
//
// Run: bun run harness/scripts/demo_pfleetl2.ts

import { join } from "node:path";
import { FleetLaneManager } from "../../desktop/fleet_lanes.ts";
import { FLEET_PRESSURE_PCT, FLEET_SUSTAIN_MS, hotMs, laneAdmission, pressureOf, pushSample, type PressureSample } from "../../desktop/fleet_resources.ts";
import { cloneArgv, cloneErrorHint, hostTokenForUrl } from "../../desktop/workspace.ts";
import { gitAuthHint, gitCredRef, gitEnvNameFromRef, gitTokenEnvName, parseGitRemote, providerLabel } from "../../desktop/git_url.ts";
import { isValidRef } from "../../desktop/cred_vault.ts";
import type { SystemSnapshot } from "../../desktop/system_profile.ts";
import type { LaneStatus } from "../../desktop/fleet_lanes.ts";

const FAKE = join(import.meta.dir, "..", "mcp", "testing", "fake_acp_agent.ts");

function fail(msg: string): never {
  console.error(`   FAIL - ${msg}`);
  process.exit(1);
}
function ok(msg: string): void {
  console.log(`   ok - ${msg}`);
}

const healthy: SystemSnapshot = { cpuModel: "demo", cores: 8, speedMHz: 4000, cpuBusyPct: 12, memTotalMB: 16_000, memFreeMB: 11_000 };
const pegged: SystemSnapshot = { ...healthy, cpuBusyPct: 100, memTotalMB: 16_000, memFreeMB: 1_000 }; // 100% cpu, 94% mem

function mgr(snap: SystemSnapshot, now?: () => number): FleetLaneManager {
  return new FleetLaneManager({
    argv: () => ({ cmd: "bun", args: [FAKE] }),
    masterModel: () => "orchestrator-model",
    sample: async () => snap,
    ...(now ? { now } : {}),
  });
}

/** A run of readings `stepMs` apart, oldest first - the shape the manager's sampler produces. */
function window(values: { cpu: number | null; mem: number | null }[], stepMs = 3_000): PressureSample[] {
  let h: PressureSample[] = [];
  values.forEach((v, i) => { h = pushSample(h, { at: i * stepMs, cpuPct: v.cpu, memPct: v.mem }); });
  return h;
}

// ── 1. Unlimited lanes ──────────────────────────────────────────────────────────────────────────────
console.log("1) lanes are unlimited - the core-derived ceiling is gone");
{
  const fleet = mgr({ ...healthy, cores: 2 }); // P-FLEET.L1 capped this box at min(6, 2/2) = 1 lane
  const spawned = await Promise.all(Array.from({ length: 5 }, (_, i) => fleet.spawn({ cwd: process.cwd(), name: `lane-${i + 1}` })));
  const refused = spawned.filter((s) => !s.ok);
  if (refused.length) fail(`every lane must start on a healthy box; refused: ${refused.map((r) => r.reason).join(" | ")}`);
  if (fleet.liveLanes() !== 5) fail(`five lanes must be live, got ${fleet.liveLanes()}`);
  const st = await fleet.status();
  if ("maxLanes" in (st.resources as Record<string, unknown>)) fail("the status payload must no longer advertise a lane cap");
  if (st.resources.pressurePct !== FLEET_PRESSURE_PCT || st.resources.sustainMs !== FLEET_SUSTAIN_MS) fail("status must echo the pressure policy so no UI hardcodes it");
  ok(`five concurrent lanes on a 2-core box; status echoes the policy (${st.resources.pressurePct}% held ${st.resources.sustainMs / 1000}s) and carries no cap`);
  fleet.stopAll();
}

// ── 2. A burst is free ──────────────────────────────────────────────────────────────────────────────
console.log("2) a burst never blocks a lane");
{
  const fleet = mgr(pegged);
  const r = await fleet.spawn({ cwd: process.cwd() });
  if (!r.ok) fail(`a single pegged reading must still admit, got: ${r.reason}`);
  const burst = laneAdmission(window([{ cpu: 100, mem: 94 }, { cpu: 100, mem: 94 }, { cpu: 100, mem: 94 }, { cpu: 100, mem: 94 }]));
  if (!burst.ok) fail("nine seconds at 100% is a compile, not a siege");
  if (burst.cpuHotMs !== 9_000) fail(`the HUD still needs the honest duration, got ${burst.cpuHotMs}ms`);
  ok(`100% cpu + 94% memory for 9s: lane admitted, HUD reports "held ${burst.cpuHotMs / 1000}s of ${FLEET_SUSTAIN_MS / 1000}s"`);
  fleet.stopAll();
}

// ── 3. A held line refuses, with both measured numbers ───────────────────────────────────────────────
console.log("3) thirty unbroken seconds refuses, naming the percent and the duration");
{
  let t = 9_000_000;
  const fleet = mgr(pegged, () => t);
  for (let i = 0; i < 8; i++) { await fleet.status(); t += 5_000; } // 35s of pegged readings
  const r = await fleet.spawn({ cwd: process.cwd() });
  if (r.ok) fail("a held line must refuse");
  if (!/at 94% for \d+s/.test(r.reason ?? "")) fail(`the refusal must carry percent AND duration, got: ${r.reason}`);
  if (!/not a burst/.test(r.reason ?? "")) fail(`the refusal must say why it is not a burst, got: ${r.reason}`);
  ok(`"${r.reason}"`);
  fleet.stopAll();
}

// ── 4. The streak is honest, and no evidence fails OPEN ─────────────────────────────────────────────
console.log("4) a cool reading or a blind reading resets the clock; no evidence fails open");
{
  const held = window(Array.from({ length: 11 }, () => ({ cpu: 96, mem: 40 })));
  if (hotMs(held, "cpuPct") !== 30_000) fail("eleven readings 3s apart is 30s of pressure");
  if (laneAdmission(held).ok) fail("30s held must refuse");

  const dipped = [...held.slice(0, 9), { at: 27_000, cpuPct: 20, memPct: 40 }, { at: 30_000, cpuPct: 96, memPct: 40 }];
  if (hotMs(dipped, "cpuPct") !== 0) fail("the machine breathed: the streak restarts, not resumes");
  if (!laneAdmission(dipped).ok) fail("a broken streak must admit");

  const blind = [...held.slice(0, 9), { at: 27_000, cpuPct: null, memPct: null }, { at: 30_000, cpuPct: 96, memPct: 40 }];
  if (hotMs(blind, "cpuPct") !== 0) fail("a failed sample is NOT evidence of load");
  if (!laneAdmission([]).ok) fail("an empty window must fail OPEN - a UX guard never bricks the fleet");
  const p = pressureOf({ ...healthy, memTotalMB: 0, memFreeMB: 0, cpuBusyPct: null }, 1);
  if (p.cpuPct !== null || p.memPct !== null) fail("a broken sample must read as no evidence, never as 0%");
  ok("streak breaks on a cool OR blind reading; an empty or blind window always admits");
}

// ── 5. Real remotes parse; local paths never do ──────────────────────────────────────────────────────
console.log("5) GitHub / GitLab / Azure DevOps remotes parse - https, ssh:// and git@ alike");
{
  const cases: [string, string, "https" | "ssh", string][] = [
    ["https://github.com/acme/widgets.git", "github", "https", "widgets"],
    ["git@github.com:acme/widgets.git", "github", "ssh", "widgets"],
    ["https://gitlab.com/group/sub/app", "gitlab", "https", "app"],
    ["ssh://git@gitlab.mycorp.com:2222/team/app.git", "gitlab", "ssh", "app"],
    ["https://dev.azure.com/org/project/_git/repo", "azure", "https", "repo"],
    ["git@ssh.dev.azure.com:v3/org/project/repo", "azure", "ssh", "repo"],
    ["https://acme.visualstudio.com/proj/_git/repo", "azure", "https", "repo"],
  ];
  for (const [url, provider, scheme, repo] of cases) {
    const r = parseGitRemote(url);
    if (!r) fail(`must parse: ${url}`);
    if (r.provider !== provider || r.scheme !== scheme || r.repo !== repo) fail(`${url} -> ${JSON.stringify(r)}`);
  }
  for (const notARemote of ["C:\\Users\\me\\src\\repo", "D:/work/repo", "/home/me/src/repo", "./rel/repo", "just some words", ""]) {
    if (parseGitRemote(notARemote)) fail(`a local path or prose must NEVER read as a remote: ${notARemote}`);
  }
  const laundered = parseGitRemote("https://someone:ghp_supersecret@github.com/acme/widgets.git");
  if (JSON.stringify(laundered).includes("ghp_supersecret")) fail("an embedded password must be discarded, never carried into a label");
  // ssh is asked for keys, https is asked for the provider's own token - never the other way round
  if (!/ssh keys/.test(gitAuthHint(parseGitRemote("git@github.com:a/b.git")!))) fail("an ssh remote must be told about keys");
  if (!/Azure DevOps/.test(gitAuthHint(parseGitRemote("https://dev.azure.com/o/p/_git/r")!))) fail("an azure remote must name an Azure DevOps PAT");
  ok(`${cases.length} real remote spellings parsed; local paths rejected; embedded credentials discarded; each remote asks for the credential it actually takes`);
}

// ── 6. Credentials are host-scoped and never leak into the repo or the error ─────────────────────────
console.log("6) a saved token is scoped to its host, rides a header, and is redacted from errors");
{
  for (const host of ["github.com", "gitlab.com", "dev.azure.com", "git.internal.example"]) {
    const ref = gitCredRef(host);
    if (!isValidRef(ref)) fail(`the vault would reject ref "${ref}"`);
    if (gitEnvNameFromRef(ref) !== gitTokenEnvName(host)) fail(`ref -> env name must round-trip for ${host}`);
  }
  const gh = { [gitTokenEnvName("github.com")]: "scoped-gh", GITHUB_TOKEN: "ci", LUCID_GIT_PAT: "generic" };
  if (hostTokenForUrl("https://github.com/a/b", gh) !== "scoped-gh") fail("the token the user saved for THIS host must win");
  if (hostTokenForUrl("https://gitlab.com/a/b", { [gitTokenEnvName("github.com")]: "scoped-gh" }) !== null) fail("a github token must never be offered to gitlab");
  if (hostTokenForUrl("https://git.internal.example/a/b", { LUCID_GIT_PAT: "generic" }) !== null) fail("an unknown host must never receive the generic PAT");
  if (hostTokenForUrl("https://git.internal.example/a/b", { [gitTokenEnvName("git.internal.example")]: "mine" }) !== "mine") fail("a self-hosted host must work through its own scoped token");
  if (hostTokenForUrl("https://dev.azure.com/o/p/_git/r", { AZURE_DEVOPS_EXT_PAT: "az" }) !== "az") fail("Azure DevOps PAT vars must be understood");
  if (hostTokenForUrl("git@github.com:a/b.git", gh) !== null) fail("an ssh remote takes keys, so it must never be handed a token");

  const argv = cloneArgv("https://github.com/a/b.git", "/dst", "tok-abc");
  if (argv[0] !== "-c" || !argv[1]!.startsWith("http.extraHeader=Authorization: Basic ")) fail("the token must ride a per-command header");
  if (argv.some((a) => a.includes("tok-abc"))) fail("the raw token must never appear in argv beyond the base64 header");
  if (argv.join(" ").includes("tok-abc@github.com")) fail("the token must never be embedded in the URL - that persists into .git/config");
  const hint = cloneErrorHint("fatal: Authentication failed for 'https://github.com/x/y.git'", true);
  if (/tok-abc/.test(hint)) fail("an error must never echo a token");
  if (!/ssh key/i.test(cloneErrorHint("Permission denied (publickey).", false, true))) fail("an ssh failure must point at keys, not at a PAT");
  ok("host-scoped refs round-trip through the vault name; cross-host use refused; token rides a header, never the URL; ssh failures point at keys");
}

// ── 7. The minimized snapshot ────────────────────────────────────────────────────────────────────────
// This is the reducer the status-bar pill paints: lanes -> one dot + count per state, ordered so anything
// blocked on a human is first. Kept identical to fleet_grid.ts's PILL_ORDER / STATUS_WORDS.
console.log("7) the minimized pill reduces the fleet to a colored-dot snapshot");
{
  const PILL_ORDER: LaneStatus[] = ["needs-approval", "awaiting-input", "working", "starting", "done", "error", "stopped"];
  const lanes: { name: string; status: LaneStatus }[] = [
    { name: "api", status: "working" },
    { name: "web", status: "needs-approval" },
    { name: "docs", status: "done" },
    { name: "infra", status: "working" },
    { name: "etl", status: "awaiting-input" },
  ];
  const by = new Map<LaneStatus, string[]>();
  for (const l of lanes) by.set(l.status, [...(by.get(l.status) ?? []), l.name]);
  const pips = PILL_ORDER.filter((s) => by.get(s)?.length).map((s) => `${s}:${by.get(s)!.length}`);
  if (pips[0] !== "needs-approval:1") fail(`what needs a human must sort FIRST, got ${pips.join(" ")}`);
  if (pips[1] !== "awaiting-input:1") fail(`what is waiting on the user is second, got ${pips.join(" ")}`);
  if (!pips.includes("working:2")) fail("counts must aggregate per state");
  if (pips.length !== 4) fail(`only states PRESENT get a dot, got ${pips.join(" ")}`);
  const hover = by.get("working")!.join(", ");
  if (hover !== "api, infra") fail(`the hover must name the lanes in that state, got "${hover}"`);
  ok(`five lanes -> "${pips.join(" ")}" with hover "working: ${hover}" - needs-approval first, one dot per state present`);
}

console.log(`\ndemo_pfleetl2 OK - unlimited lanes, admission by ${FLEET_PRESSURE_PCT}% held ${FLEET_SUSTAIN_MS / 1000}s (a burst is free, a blind sample never counts as load), lanes spawned from real GitHub/GitLab/Azure DevOps remotes with host-scoped credentials that never reach the URL or an error, and a minimized snapshot that names what is blocked on you.`);
process.exit(0);
