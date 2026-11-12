// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-RELEASE.7 - every released Windows build is signed by TECHLEAD 187 LLC, fail-closed
// (ADR-0450).
//
// P-RELEASE.6 made signing POSSIBLE: with the Azure secrets present, CI signs. It stayed opt-in, so a
// release cut on a day the secret was missing or renamed would have shipped unsigned installers to the
// GitHub Release and the rolling latest feed without a single red step. This demo proves the two gates
// that close that hole and the identity that the signed bytes carry, using the shipped pieces themselves:
//
//   1. The "Configure code-signing" step of BOTH workflows, executed for real under bash: a RELEASE run
//      (tag push, publish_latest, beta_release) on Windows with no signer secret EXITS NON-ZERO; with the
//      Azure secret or the .pfx fallback it signs and exports LUCID_RELEASE_RUN=1; a test dispatch with no
//      secret still builds unsigned; a macOS release run is not gated (no Apple certificate yet).
//   2. desktop/build/win-signing.cjs, the module electron-builder loads: a release run with no signer
//      THROWS, directly and through electron-builder's own getConfig for both Windows configs, so the gate
//      lives inside the build and not only in the workflow in front of it.
//   3. One publisher identity, the certificate's CN "TECHLEAD 187 LLC", on every install-facing surface:
//      the exe/installer CompanyName and Add/Remove Programs publisher (package.json author), the appx
//      publisher display name, the Linux vendor/maintainer, the updater's publisherName, and the About
//      dialog (the served renderer bundle, when it has been built).
//
// Run with: bun run desktop/scripts/demo_p_release_7.ts

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  releaseRun: (env: Record<string, string>) => boolean;
  windowsSignerConfigured: (env: Record<string, string>) => boolean;
  withWindowsSigning: (cfg: Record<string, unknown>, env: Record<string, string>) => Record<string, unknown>;
};

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  \u2717 " + msg); process.exit(1); }
  console.log("  \u2713 " + msg);
}

interface Step { name?: string; run?: string; env?: Record<string, string> }
function configureStep(workflow: string): Step {
  const doc = Bun.YAML.parse(readFileSync(join(REPO, ".github", "workflows", workflow), "utf8")) as {
    jobs: Record<string, { steps?: Step[] }>;
  };
  const step = Object.values(doc.jobs).flatMap((j) => j.steps ?? []).find((s) => s.name?.startsWith("Configure code-signing"));
  if (!step?.run) throw new Error(`${workflow}: no "Configure code-signing" step`);
  return step;
}

interface ConfigureResult { status: number; ghEnv: string; stderr: string; stdout: string }
// Executes the step's own bash, exactly as the runner would, and returns its exit status plus what it
// wrote to GITHUB_ENV. A non-zero status is a RESULT here, not an error: it is the gate firing.
function runConfigure(script: string, env: Record<string, string>): ConfigureResult {
  const dir = mkdtempSync(join(tmpdir(), "p-release-7-"));
  const ghEnv = join(dir, "github_env");
  try {
    Bun.write(ghEnv, "");
    const r = spawnSync("bash", ["-e", "-c", script], { env: { PATH: process.env.PATH ?? "", GITHUB_ENV: ghEnv, ...env }, encoding: "utf8" });
    return { status: r.status ?? -1, ghEnv: readFileSync(ghEnv, "utf8"), stderr: r.stderr, stdout: r.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Resolved { appId: string; azure: Record<string, string> | null; publisherName: unknown }
// electron-builder's getConfig, run where electron-builder runs (Node). Returns null when the config
// load itself fails, which is exactly what a release run without a signer must do.
function resolve(configFile: string, env: Record<string, string>): { resolved: Resolved | null; stderr: string } {
  const electron = desktopRequire("electron") as string;
  const code = `
    const { getConfig } = require("app-builder-lib/out/util/config/config.js");
    getConfig(process.cwd(), ${JSON.stringify(configFile)}, null).then((c) => {
      process.stdout.write("\\n@@" + JSON.stringify({
        appId: c.appId,
        azure: (c.win && c.win.azureSignOptions) || null,
        publisherName: (c.win && c.win.signtoolOptions && c.win.signtoolOptions.publisherName) || null,
      }));
    }).catch((e) => { console.error(String(e && e.message || e)); process.exit(1); });`;
  const clean: Record<string, string | undefined> = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  delete clean.LUCID_WIN_AZURE_SIGN;
  delete clean.LUCID_RELEASE_RUN;
  delete clean.CSC_LINK;
  const r = spawnSync(electron, ["-e", code], { cwd: DESKTOP, env: { ...clean, ...env }, encoding: "utf8" });
  const marker = r.stdout.lastIndexOf("@@");
  if (r.status !== 0 || marker < 0) return { resolved: null, stderr: r.stderr };
  return { resolved: JSON.parse(r.stdout.slice(marker + 2)) as Resolved, stderr: r.stderr };
}

const pkg = JSON.parse(readFileSync(join(DESKTOP, "package.json"), "utf8")) as {
  author: string;
  build: { appx: { publisher: string; publisherDisplayName: string }; linux: { vendor: string; maintainer: string } };
};
const PUB = signing.PUBLISHER_NAME;

console.log("\n[1] The shipped Configure step refuses an unsigned RELEASE run on Windows, and only that");
for (const [wf, inputs] of [
  ["build-desktop.yml", ["startsWith(github.ref, 'refs/tags/')", "inputs.publish_latest", "inputs.beta_release"]],
  ["build-creator.yml", ["startsWith(github.ref, 'refs/tags/')", "inputs.publish_latest"]],
] as const) {
  const step = configureStep(wf);
  const expr = step.env?.RELEASE_RUN ?? "";
  for (const trigger of inputs) assert(expr.includes(trigger), `${wf}: RELEASE_RUN is derived from ${trigger}`);
  const script = step.run!;

  const blocked = runConfigure(script, { RUNNER_OS: "Windows", RELEASE_RUN: "1" });
  assert(blocked.status !== 0, `${wf}: Windows RELEASE run with no signer secret -> the step exits ${blocked.status} (the build never starts)`);
  assert(blocked.stdout.includes("::error::") && blocked.stdout.includes("TECHLEAD 187 LLC"), `${wf}: ...and the annotation names the rule and the publisher`);

  const azure = runConfigure(script, { RUNNER_OS: "Windows", RELEASE_RUN: "1", AZURE_CLIENT_ID: "app-id" });
  assert(azure.status === 0 && azure.ghEnv.includes("LUCID_WIN_AZURE_SIGN=1") && azure.ghEnv.includes("LUCID_RELEASE_RUN=1"), `${wf}: Windows RELEASE run + Azure secret -> signs through Azure and marks the run a release for the build`);

  const pfx = runConfigure(script, { RUNNER_OS: "Windows", RELEASE_RUN: "1", WIN_CSC_LINK: "pfx", WIN_CSC_KEY_PASSWORD: "pw" });
  assert(pfx.status === 0 && pfx.ghEnv.includes("CSC_LINK=pfx") && pfx.ghEnv.includes("LUCID_RELEASE_RUN=1"), `${wf}: Windows RELEASE run + only a .pfx -> the .pfx fallback still satisfies the gate`);

  const test = runConfigure(script, { RUNNER_OS: "Windows", RELEASE_RUN: "" });
  assert(test.status === 0 && test.ghEnv.trim() === "", `${wf}: a Windows TEST dispatch with no secret -> nothing exported, builds unsigned as before`);

  for (const os of ["macOS", "Linux"]) {
    const other = runConfigure(script, { RUNNER_OS: os, RELEASE_RUN: "1" });
    assert(other.status === 0 && !other.ghEnv.includes("CSC_LINK"), `${wf}: a ${os} RELEASE run is not gated (no Windows bytes, no Apple certificate yet)`);
    // ADR-0459: Creator's overlay (which carries the Windows gate) loads on every runner, so its workflow marks
    // ONLY the Windows job; Agent's mac/Linux jobs never load win-signing, so its marking is inert there.
    if (wf === "build-creator.yml") assert(!other.ghEnv.includes("LUCID_RELEASE_RUN"), `${wf}: ...and NOT marked, so the Creator overlay and the identity gate load on ${os}`);
  }
}

console.log("\n[2] win-signing.cjs enforces the same rule inside electron-builder's config load");
assert(signing.releaseRun({ LUCID_RELEASE_RUN: "1" }) && !signing.releaseRun({}), "releaseRun() reads exactly LUCID_RELEASE_RUN=1");
assert(signing.windowsSignerConfigured({ LUCID_WIN_AZURE_SIGN: "1" }) && signing.windowsSignerConfigured({ CSC_LINK: "x.pfx" }) && !signing.windowsSignerConfigured({}), "windowsSignerConfigured() is Azure OR a .pfx");
let threw = "";
try { signing.withWindowsSigning({ appId: "x" }, { LUCID_RELEASE_RUN: "1" }); } catch (e) { threw = String((e as Error).message); }
assert(threw.includes("P-RELEASE.7") && threw.includes("TECHLEAD 187 LLC"), "withWindowsSigning() THROWS on a release run with no signer");
assert(signing.withWindowsSigning({ appId: "x" }, { LUCID_RELEASE_RUN: "1", CSC_LINK: "x.pfx" }).appId === "x", "...returns the config untouched on a release run signed by the .pfx fallback (electron-builder reads CSC_LINK itself)");
const signed = signing.withWindowsSigning({ appId: "x" }, { LUCID_RELEASE_RUN: "1", LUCID_WIN_AZURE_SIGN: "1" }) as { win: { azureSignOptions: Record<string, string> } };
assert(signed.win.azureSignOptions.certificateProfileName === signing.AZURE_ARTIFACT_SIGNING.certificateProfileName, "...and signs through Azure on a release run with the Azure switch on");
assert(signing.withWindowsSigning({ appId: "x" }, {}).appId === "x", "...a non-release run with no signer stays unsigned (test builds are not gated)");

for (const [file, appId] of [
  ["build/electron-builder.win.cjs", "com.lucidagentide.desktop"],
  ["build/electron-builder.creator.cjs", "com.lucidcreator.desktop"],
] as const) {
  const blocked = resolve(file, { LUCID_RELEASE_RUN: "1" });
  assert(blocked.resolved === null && blocked.stderr.includes("P-RELEASE.7"), `${file}: electron-builder's getConfig FAILS on a release run with no signer`);
  const ok = resolve(file, { LUCID_RELEASE_RUN: "1", LUCID_WIN_AZURE_SIGN: "1" });
  assert(ok.resolved?.appId === appId && ok.resolved.azure?.certificateProfileName === signing.AZURE_ARTIFACT_SIGNING.certificateProfileName && ok.resolved.publisherName === PUB, `${file}: a signed release run resolves to ${appId} with the Azure profile and publisher ${PUB}`);
}

console.log("\n[3] One publisher identity on every install-facing surface");
assert(signing.CERTIFICATE_SUBJECT.startsWith(`CN=${PUB},`), `the certificate's CN is "${PUB}"`);
assert(pkg.author.replace(/\s*<.*$/, "") === PUB, `package.json author -> exe CompanyName, installer CompanyName and Add/Remove Programs publisher: "${PUB}"`);
assert(pkg.build.appx.publisher === signing.CERTIFICATE_SUBJECT, "appx.publisher is the certificate subject (signtool refuses anything else)");
assert(pkg.build.appx.publisherDisplayName === PUB, `appx.publisherDisplayName (Intune / Store listing): "${PUB}"`);
assert(pkg.build.linux.vendor === PUB && pkg.build.linux.maintainer.startsWith(`${PUB} <`), `linux vendor and maintainer (.deb/.rpm metadata): "${PUB}"`);
const aboutSrc = readFileSync(join(DESKTOP, "renderer", "about.ts"), "utf8");
assert(aboutSrc.includes(`<b>${PUB.replace(/ /g, "&nbsp;")}</b>`) && aboutSrc.includes(`© 2026 ${PUB}`), `About dialog source names "${PUB}"`);
const bundle = join(DESKTOP, "renderer", "app.bundle.js");
if (existsSync(bundle)) {
  const served = readFileSync(bundle, "utf8");
  assert(served.includes(`<b>${PUB.replace(/ /g, "&nbsp;")}</b>`) && !served.includes("<b>TechLead&nbsp;187&nbsp;LLC</b>"), `the SERVED renderer bundle (renderer/app.bundle.js) carries "${PUB}" and no longer the mixed-case name`);
} else {
  console.log("  - renderer/app.bundle.js not built here (bun run build-renderer); the served-bytes check ran only on the source");
}

console.log("\nP-RELEASE.7 demo: PASS");
