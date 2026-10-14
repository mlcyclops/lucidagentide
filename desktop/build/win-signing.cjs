// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/build/win-signing.cjs - P-RELEASE.6 (ADR-0447): Windows Authenticode through Azure Artifact
// Signing, applied identically to the Agent and Creator Windows builds.
//
// One switch. CI sets LUCID_WIN_AZURE_SIGN=1 ONLY when the AZURE_CLIENT_ID secret exists (the "Configure
// code-signing" step of build-desktop.yml and build-creator.yml), so forks, local builds and secretless
// runs stay unsigned instead of failing. With the switch on, electron-builder's own Azure signer
// (app-builder-lib/out/codeSign/windowsSignAzureManager.js) signs every exe, the msi and the appx with
// Invoke-TrustedSigning, and THROWS when AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET are
// missing: a build that was asked to sign never ships unsigned bytes.
//
// Why an env switch and not `-c.win.azureSignOptions.*` on the command line: combined with
// `--config <file>`, electron-builder turns the file into `extends` UNDER package.json's build block
// (electron-builder/out/builder.js normalizeOptions + app-builder-lib getConfig), so the Creator build
// resolved Agent's appId and output directory. Measured 2026-10-14; see ADR-0447.

// The Artifact Signing account and Public Trust certificate profile (subscription "Azure subscription 1",
// resource group rg-tl187-codesigning, East US). None of these are secrets: the credential is the Entra
// app's client secret, which only CI holds.
const AZURE_ARTIFACT_SIGNING = Object.freeze({
  endpoint: "https://eus.codesigning.azure.net/",
  codeSigningAccountName: "techlead187signing",
  certificateProfileName: "techlead187-public",
  // Artifact Signing certificates live 72 hours. Without an RFC 3161 timestamp every signature would
  // stop validating when its certificate expires.
  TimestampRfc3161: "http://timestamp.acs.microsoft.com",
  TimestampDigest: "SHA256",
});

// The profile's certificate subject, exactly as Azure issues it. desktop/package.json appx.publisher
// must equal it byte for byte, or signtool refuses to sign the appx and the Windows build fails.
const CERTIFICATE_SUBJECT = "CN=TECHLEAD 187 LLC, O=TECHLEAD 187 LLC, L=Sun City Center, S=Florida, C=US";

// The subject's CN. electron-builder writes it into app-update.yml, and electron-updater refuses an
// update whose Authenticode signer CN differs. Unset (the Azure path never derives it from a cert file),
// the updater would verify nothing.
const PUBLISHER_NAME = "TECHLEAD 187 LLC";

function azureSigningEnabled(env = process.env) {
  return env.LUCID_WIN_AZURE_SIGN === "1";
}

// Returns cfg unchanged when signing is off; otherwise a copy whose `win` block signs through Azure.
function withWindowsSigning(cfg, env = process.env) {
  if (!azureSigningEnabled(env)) return cfg;
  const win = cfg.win || {};
  return {
    ...cfg,
    win: {
      ...win,
      azureSignOptions: { ...AZURE_ARTIFACT_SIGNING },
      signtoolOptions: { ...win.signtoolOptions, publisherName: PUBLISHER_NAME },
    },
  };
}

module.exports = { AZURE_ARTIFACT_SIGNING, CERTIFICATE_SUBJECT, PUBLISHER_NAME, azureSigningEnabled, withWindowsSigning };
