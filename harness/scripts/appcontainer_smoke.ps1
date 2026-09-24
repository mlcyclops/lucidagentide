# Copyright (c) 2026 TechLead 187 LLC
# SPDX-License-Identifier: BUSL-1.1

# harness/scripts/appcontainer_smoke.ps1 - P-SANDBOX.10 (ADR-0387). Runs on a windows-latest runner.
# Fails unless (1) a contained child's stdout reaches us and (2) the real omp boots inside the
# AppContainer with the engine's grants, on the bundled bun version. Every probe is time-bounded.
$ErrorActionPreference = "Stop"
$helper = (Resolve-Path "bin/lucid-appcontainer.exe").Path
$bun = (Get-Command bun).Source
$repo = (Resolve-Path ".").Path
$ws = Join-Path $env:USERPROFILE "smoke-ws"
$ompHome = Join-Path $env:USERPROFILE ".omp"
$tmp = Join-Path $ompHome "lucid-sandbox-tmp"
New-Item -ItemType Directory -Force $ws, $tmp | Out-Null
$cli = Join-Path $repo "node_modules\@oh-my-pi\pi-coding-agent\dist\cli.js"
Write-Host "bun $(& $bun --version) at $bun"

function Contained([string]$label, [string[]]$cmd) {
  # The same grant shape the engine passes (appContainerRuntimeGrants): repo + bun dir rx, ~/.omp rw.
  $argv = @("--workspace", $ws, "--deny-network", "--grant-rx", $repo, "--grant-rx", (Split-Path $bun), "--grant-rw", $ompHome, "--grant-rw", $tmp, "--") + $cmd
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $helper
  foreach ($a in $argv) { [void]$psi.ArgumentList.Add($a) }
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.RedirectStandardInput = $true
  $psi.UseShellExecute = $false
  $psi.Environment["TEMP"] = $tmp; $psi.Environment["TMP"] = $tmp
  $p = [System.Diagnostics.Process]::Start($psi)
  $p.StandardInput.Close()
  $out = $p.StandardOutput.ReadToEndAsync(); $err = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit(90000)) { & taskkill /PID $p.Id /T /F | Out-Null; throw "$label - timed out" }
  Write-Host "== $label  exit=$($p.ExitCode)`nstdout: $($out.Result)`nstderr: $($err.Result)"
  return @{ code = $p.ExitCode; out = $out.Result }
}

$r = Contained "stdio round trip" @("cmd", "/c", "echo lucid-appcontainer-stdio-ok")
if ($r.code -ne 0 -or $r.out -notmatch "lucid-appcontainer-stdio-ok") { throw "FAIL: a contained child's stdout did not reach us" }

$r = Contained "contained omp --version" @($bun, $cli, "--version")
if ($r.code -ne 0 -or $r.out -notmatch "omp/") { throw "FAIL: the real omp did not boot inside the AppContainer" }

Write-Host "`nOK: stdio round-trips and the contained omp boots on bun $(& $bun --version)."
