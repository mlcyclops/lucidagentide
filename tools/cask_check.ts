// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1
//
// demo-P-BREW.1: the distribution contract between the Homebrew cask, the
// electron-builder artifact naming, and the update-cask CI job.
//
// The cask is an `app` cask over the release .zip app bundle. The old
// `pkg ... allow_untrusted: true` path is deprecated in Homebrew 6 (package
// trust); a drift back to it, or a rename of the mac artifacts that the cask
// and the update-cask job both hard-code, must fail this check loudly.

function fail(msg: string): never {
  console.error(`cask_check: ${msg}`);
  process.exit(1);
}

const root = new URL("../", import.meta.url);
const read = (p: string) => Bun.file(new URL(p, root)).text();

const caskRaw = await read("Casks/lucidagentide.rb");
// Strip `# ...` comments (comments may legitimately mention pkg/allow_untrusted
// history). Ruby string interpolation `#{...}` is never preceded by `# `, so
// only strip hash-space tails and whole-line comments.
const caskCode = caskRaw
  .split("\n")
  .map((l) => l.replace(/(^|\s)#(\s.*)?$/, ""))
  .join("\n");

if (/\ballow_untrusted\b/.test(caskCode))
  fail("allow_untrusted is back in the cask (deprecated in Homebrew 6)");
if (/^\s*pkg\s/m.test(caskCode))
  fail("a pkg stanza is back in the cask; it must stay an app cask over the .zip");
if (/sha256\s+:no_check/.test(caskCode))
  fail("sha256 :no_check: the cask must stay pinned to real checksums (ADR-0258)");
if (/sudo:\s*true/.test(caskCode))
  fail("postflight sudo is back; the app-stanza copy is user-owned, no sudo");
if (/^\s*postflight do\b/m.test(caskCode))
  fail("block-form postflight is deprecated in Homebrew 6; use postflight_steps");
if (!/^\s*postflight_steps do\b/m.test(caskCode))
  fail("the quarantine-strip postflight_steps is gone; unsigned builds would hit Gatekeeper");
if (!/^\s*url ".*\/LucidAgent-mac-#\{arch\}\.zip"$/m.test(caskRaw))
  fail("cask url must point at LucidAgent-mac-#{arch}.zip");

const appStanza = caskCode.match(/^\s*app "([^"]+)"$/m)?.[1] ?? fail("no app stanza in the cask");

const shas = [...caskCode.matchAll(/\b(?:arm|intel):\s+"([0-9a-f]+)"/g)].map((m) => m[1]!);
if (shas.length !== 2) fail(`expected 2 pinned sha256 values, found ${shas.length}`);
for (const s of shas) if (s.length !== 64) fail(`sha256 ${s.slice(0, 12)}… is not 64 hex chars`);
if (shas[0] === shas[1]) fail("arm and intel sha256 are identical; one arch is mispinned");

const pkg = JSON.parse(await read("desktop/package.json")) as {
  build: { productName: string; mac: { artifactName: string; target: { target: string; arch?: string[] }[] } };
};
if (`${pkg.build.productName}.app` !== appStanza)
  fail(`app stanza "${appStanza}" != productName "${pkg.build.productName}.app"`);
if (pkg.build.mac.artifactName !== "LucidAgent-mac-${arch}.${ext}")
  fail(`mac artifactName "${pkg.build.mac.artifactName}" no longer matches the cask url pattern`);
const zipTarget = pkg.build.mac.target.find((t) => t.target === "zip");
if (!zipTarget) fail("desktop/package.json mac targets no longer build a zip");
for (const a of ["arm64", "x64"])
  if (!zipTarget.arch?.includes(a)) fail(`mac zip target no longer builds ${a}`);

const wf = await read(".github/workflows/build-desktop.yml");
for (const asset of ["LucidAgent-mac-arm64.zip", "LucidAgent-mac-x64.zip"])
  if (!wf.includes(`sha "${asset}"`))
    fail(`update-cask no longer pins ${asset}; the cask sha256 would go stale`);
if (/sha "LucidAgent-mac-[a-z0-9]+\.pkg"/.test(wf))
  fail("update-cask is hashing .pkg assets again; the cask consumes the zips");

console.log("cask_check: app cask over LucidAgent-mac-{arm64,x64}.zip, pinned sha256 pair,");
console.log("cask_check: artifact naming and update-cask job agree. No package-trust path. OK");
