# Copyright (c) 2026 TechLead 187 LLC
# SPDX-License-Identifier: BUSL-1.1

# desktop/build/stage-trusted-signing.ps1 - P-RELEASE.6 (ADR-0447). Runs on a windows-latest runner BEFORE
# electron-builder, only when Azure Artifact Signing is switched on.
#
# Why: electron-builder signs four files at once, and each Invoke-TrustedSigning (TrustedSigning 0.4.1)
# installs its two NuGet dependencies on first use: NugetInstall.psm1 Install-NugetPackage runs
# `Remove-Item "$PackageVersionsPath\*" -Recurse -Force` then Install-Package when the package folder is
# missing. Four concurrent first calls delete each other's half-installed packages; run 38636580105 died
# with "Could not find a part of the path ...\metadata.json" and "Start-Process: The system cannot find
# the file specified" (signtool.exe). The module treats a package as installed when
# %LOCALAPPDATA%\TrustedSigning\<Name>\<Name>.<Version> exists (Get-EveryDependency, Test-Path), so
# staging both here, once, before any signing starts, removes the race.
#
# The versions are exactly the ones TrustedSigning 0.4.1 hardcodes (Get-BuildToolsPackageInfo,
# Get-TrustedSigningPackageInfo). The SHA-256 pins were taken 2026-10-14 from nuget.org downloads whose
# SHA-512 matched nuget.org's published catalog packageHash. A mismatch fails the step: never sign with
# tools we did not verify.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$packages = @(
  @{ Name = "Microsoft.Windows.SDK.BuildTools"; Version = "10.0.22621.3233"; Sha256 = "333109862e342aa04c217c91ebb2d550d8a5decdcb0a7e8b83f115623c830e0b"; Probe = "bin\10.0.22621.0\x64\signtool.exe" },
  @{ Name = "Microsoft.Trusted.Signing.Client"; Version = "1.0.53"; Sha256 = "b5abe405d1464e59c2c4f4fe8b4653bf184fe3e975a75c9628d366ed384c6979"; Probe = "bin\x64\Azure.CodeSigning.Dlib.dll" }
)

$root = Join-Path $env:LOCALAPPDATA "TrustedSigning"
foreach ($p in $packages) {
  $versions = Join-Path $root $p.Name
  $install = Join-Path $versions "$($p.Name).$($p.Version)"
  if (Test-Path -LiteralPath (Join-Path $install $p.Probe)) { Write-Host "already staged: $($p.Name) $($p.Version)"; continue }

  $id = $p.Name.ToLowerInvariant()
  $url = "https://api.nuget.org/v3-flatcontainer/$id/$($p.Version)/$id.$($p.Version).nupkg"
  $nupkg = Join-Path $env:RUNNER_TEMP "$id.$($p.Version).zip"
  Invoke-WebRequest -Uri $url -OutFile $nupkg
  $hash = (Get-FileHash -LiteralPath $nupkg -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne $p.Sha256) { throw "$($p.Name) $($p.Version): sha256 $hash, expected $($p.Sha256)" }

  if (Test-Path -LiteralPath $versions) { Remove-Item -LiteralPath $versions -Recurse -Force }
  New-Item -ItemType Directory -Path $install -Force | Out-Null
  Expand-Archive -LiteralPath $nupkg -DestinationPath $install
  Remove-Item -LiteralPath $nupkg -Force
  if (-not (Test-Path -LiteralPath (Join-Path $install $p.Probe))) { throw "$($p.Name): $($p.Probe) missing after extraction" }
  Write-Host "staged: $($p.Name) $($p.Version) (sha256 $hash) -> $install"
}
