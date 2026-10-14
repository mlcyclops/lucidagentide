// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-RELEASE.6 - Windows Authenticode through Azure Artifact Signing (ADR-0447).
//
// Real signing only happens on a Windows runner (Invoke-TrustedSigning is a PowerShell module), so CI's
// "Verify Authenticode signatures" step is the proof of the bytes. This demo proves everything that
// decides WHETHER and HOW that runner signs, using the shipped pieces themselves:
//
//   1. The "Configure code-signing" step of BOTH workflows, executed for real under bash with each secret
//      combination: Azure wins on Windows, the .pfx path remains the fallback, a secretless run and a
//      non-Windows runner never switch Azure signing on.
//   2. Both Windows configs resolved through electron-builder's OWN getConfig, under Electron's Node (the
//      runtime electron-builder runs on): signing off leaves no azureSignOptions (a secretless build must
//      not fail), signing on carries the exact account/profile/timestamp and the updater publisher, and
//      the Creator build keeps CREATOR identity while signed. That last one is the failure the obvious
//      design (-c.win.azureSignOptions.* on the command line) has: measured, it resolves Agent's appId.
//   3. The appx publisher equals the certificate subject Azure issued, so signtool can sign the appx.
//
// Optional live check: LUCID_DEMO_AZ=1 with a signed-in `az` compares the Public Trust profile's real
// certificate subject against the pinned one.
//
// Run with: bun run desktop/scripts/demo_p_release_6.ts

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DESKTOP = join(import.meta.dir, "..");
const REPO = join(DESKTOP, "..");
const desktopRequire = createRequire(join(DESKTOP, "package.json"));
const signing = desktopRequire("./build/win-signing.cjs") as {
  AZURE_ARTIFACT_SIGNING: Record<string, string>;
  CERTIFICATE_SUBJECT: string;
  PUBLISHER_NAME: string;
};

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  \u2717 " + msg); process.exit(1); }
  console.log("  \u2713 " + msg);
}

interface Step { name?: string; run?: string }
function configureStep(workflow: string): string {
  const doc = Bun.YAML.parse(readFileSync(join(REPO, ".github", "workflows", workflow), "utf8")) as {
    jobs: Record<string, { steps?: Step[] }>;
  };
  const step = Object.values(doc.jobs).flatMap((j) => j.steps ?? []).find((s) => s.name?.startsWith("Configure code-signing"));
  if (!step?.run) throw new Error(`${workflow}: no "Configure code-signing" step`);
  return step.run;
}

// Executes the step's own bash, exactly as the runner would, and returns what it wrote to GITHUB_ENV.
function runConfigure(script: string, env: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "p-release-6-"));
  const ghEnv = join(dir, "github_env");
  try {
    Bun.write(ghEnv, "");
    const r = spawnSync("bash", ["-e", "-c", script], { env: { PATH: process.env.PATH ?? "", GITHUB_ENV: ghEnv, ...env }, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`configure step failed: ${r.stderr}`);
    return readFileSync(ghEnv, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Resolved {
  appId: string;
  output: string;
  azure: Record<string, string> | null;
  publisherName: unknown;
  appxPublisher: string | null;
  files: unknown;
}

// electron-builder's getConfig, run where electron-builder runs (Node). Bun cannot load app-builder-lib:
// its source-map-support hook throws while formatting a stack.
function resolve(configFile: string, signOn: boolean): Resolved {
  const electron = desktopRequire("electron") as string;
  const code = `
    const { getConfig } = require("app-builder-lib/out/util/config/config.js");
    getConfig(process.cwd(), ${JSON.stringify(configFile)}, null).then((c) => {
      process.stdout.write("\\n@@" + JSON.stringify({
        appId: c.appId, output: c.directories && c.directories.output,
        azure: (c.win && c.win.azureSignOptions) || null,
        publisherName: (c.win && c.win.signtoolOptions && c.win.signtoolOptions.publisherName) || null,
        appxPublisher: (c.appx && c.appx.publisher) || null,
        files: c.files,
      }));
    }).catch((e) => { console.error(e); process.exit(1); });`;
  const env: Record<string, string | undefined> = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  if (signOn) env.LUCID_WIN_AZURE_SIGN = "1";
  else delete env.LUCID_WIN_AZURE_SIGN;
  const r = spawnSync(electron, ["-e", code], { cwd: DESKTOP, env, encoding: "utf8" });
  const marker = r.stdout.lastIndexOf("@@");
  if (r.status !== 0 || marker < 0) throw new Error(`getConfig(${configFile}) failed: ${r.stderr}`);
  return JSON.parse(r.stdout.slice(marker + 2)) as Resolved;
}

const pkg = JSON.parse(readFileSync(join(DESKTOP, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
  build: { appx: { publisher: string } };
};

console.log("\n[1] The shipped Configure step decides who signs, on every secret combination");
for (const wf of ["build-desktop.yml", "build-creator.yml"]) {
  const script = configureStep(wf);
  const azure = runConfigure(script, { RUNNER_OS: "Windows", AZURE_CLIENT_ID: "app-id", WIN_CSC_LINK: "pfx" });
  assert(azure.includes("LUCID_WIN_AZURE_SIGN=1") && !azure.includes("CSC_LINK"), `${wf}: Windows + Azure secret -> Azure signing, the .pfx is not also exported`);
  const pfx = runConfigure(script, { RUNNER_OS: "Windows", WIN_CSC_LINK: "pfx", WIN_CSC_KEY_PASSWORD: "pw" });
  assert(pfx.includes("CSC_LINK=pfx") && !pfx.includes("LUCID_WIN_AZURE_SIGN"), `${wf}: Windows + only a .pfx -> the .pfx fallback, Azure stays off`);
  const none = runConfigure(script, { RUNNER_OS: "Windows" });
  assert(none.trim() === "", `${wf}: Windows with no secrets -> nothing exported, the build stays unsigned instead of failing`);
  const mac = runConfigure(script, { RUNNER_OS: "macOS", AZURE_CLIENT_ID: "app-id" });
  assert(!mac.includes("LUCID_WIN_AZURE_SIGN"), `${wf}: a macOS runner never switches Azure signing on`);
}

console.log("\n[2] electron-builder's own getConfig, signing off and on");
assert(pkg.scripts["dist:win"].includes("--config build/electron-builder.win.cjs"), "dist:win builds through the signing-aware Agent config");
assert(pkg.scripts["dist:win:creator"].includes("--config build/electron-builder.creator.cjs"), "dist:win:creator builds through the Creator overlay (which applies the same switch)");
const expected = signing.AZURE_ARTIFACT_SIGNING;
for (const [file, appId, output] of [
  ["build/electron-builder.win.cjs", "com.lucidagentide.desktop", "release"],
  ["build/electron-builder.creator.cjs", "com.lucidcreator.desktop", "release-creator"],
] as const) {
  const off = resolve(file, false);
  assert(off.azure === null && off.publisherName === null, `${file}: signing OFF -> no azureSignOptions, no publisherName (secretless builds keep working)`);
  const on = resolve(file, true);
  assert(JSON.stringify(on.azure) === JSON.stringify(expected), `${file}: signing ON -> ${on.azure?.codeSigningAccountName}/${on.azure?.certificateProfileName} at ${on.azure?.endpoint}`);
  assert(on.azure?.TimestampRfc3161 === "http://timestamp.acs.microsoft.com", `${file}: every signature is RFC 3161 timestamped (the certificate lives 72 hours)`);
  assert(on.publisherName === signing.PUBLISHER_NAME, `${file}: app-update.yml gets publisherName "${on.publisherName}", so the updater verifies the signer`);
  assert(on.appId === appId && on.output === output, `${file}: signed build keeps its own identity (${on.appId} -> ${on.output})`);
  assert(JSON.stringify(on.files) === JSON.stringify(off.files), `${file}: signing changes no packaged payload`);
}

console.log("\n[3] The appx can be signed: its publisher IS the certificate subject");
const agentOn = resolve("build/electron-builder.win.cjs", true);
assert(pkg.build.appx.publisher === signing.CERTIFICATE_SUBJECT, `package.json appx.publisher === "${signing.CERTIFICATE_SUBJECT}"`);
assert(agentOn.appxPublisher === signing.CERTIFICATE_SUBJECT, "the resolved signed Agent config carries that publisher into the appx manifest");
assert(signing.CERTIFICATE_SUBJECT.startsWith(`CN=${signing.PUBLISHER_NAME},`), "the updater's publisherName is that subject's CN");

if (process.env.LUCID_DEMO_AZ === "1") {
  console.log("\n[4] Live: the Public Trust profile's real certificate");
  const url = "https://management.azure.com/subscriptions/8d796f5c-8e26-4785-9dc9-c572179cef58/resourceGroups/rg-tl187-codesigning/providers/Microsoft.CodeSigning/codeSigningAccounts/techlead187signing/certificateProfiles/techlead187-public?api-version=2025-10-13";
  const r = spawnSync("az", ["rest", "--method", "get", "--url", url, "--query", "properties", "-o", "json"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`az rest failed: ${r.stderr}`);
  const p = JSON.parse(r.stdout) as { status: string; certificates: { status: string; subjectName: string }[] };
  const active = p.certificates.filter((c) => c.status === "Active");
  assert(p.status === "Active" && active.length > 0, `profile techlead187-public is Active with ${active.length} active certificate(s)`);
  assert(active.every((c) => c.subjectName === signing.CERTIFICATE_SUBJECT), "every active certificate's subject equals the pinned appx publisher");
} else {
  console.log("\n[4] Live Azure check not run (set LUCID_DEMO_AZ=1 with a signed-in az to compare the real certificate)");
}

console.log("\nP-RELEASE.6 demo: PASS");
