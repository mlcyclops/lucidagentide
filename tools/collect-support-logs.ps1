# Copyright (c) 2026 TechLead 187 LLC
# SPDX-License-Identifier: BUSL-1.1

# tools/collect-support-logs.ps1
#
# Collect a LUCID support bundle on Windows: the engine log, the omp/ACP logs, the model-relevant
# telemetry tails, and a machine/version report, zipped to the Desktop so a user can attach ONE file.
#
# Secret custody is the whole point of doing this with a script instead of "zip up ~/.omp":
#   - Every text file is redacted on the way in (bearer tokens, sk-* keys, api-key / token / secret /
#     password assignments).
#   - lucid-gui.json is NEVER copied verbatim. It holds provider API keys in PLAINTEXT
#     (GuiSettings.keys, desktop/settings_store.ts). Only a redacted projection is included: which
#     providers are configured, which model is selected, the lockdown flags.
#   - The credential vaults are excluded by construction, never by filter: ~/.omp/agent/agent.db
#     (omp's OAuth vault), ~/.omp/lucid-cred-vault, ~/.omp/lucid-vault, *.enc, the KG .duckdb files,
#     and the prompt-hash ledgers (lucid-turns.jsonl, lucid-ailoc.jsonl) are simply not read.
#
# Usage (from an ordinary PowerShell window - no admin, no execution-policy change):
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\collect-support-logs.ps1
#   ... -Days 14 -OutDir C:\temp        # widen the omp log window / change where the zip lands

[CmdletBinding()]
param(
  [string]$OutDir = [Environment]::GetFolderPath('Desktop'),
  [int]$Days = 7
)

$ErrorActionPreference = 'Continue'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stage = Join-Path $env:TEMP "lucid-support-$stamp"
$null = New-Item -ItemType Directory -Force -Path $stage
$cutoff = (Get-Date).AddDays(-[Math]::Abs($Days))
$notes = New-Object System.Collections.Generic.List[string]

# ---- redaction ---------------------------------------------------------------------------------
# Ordered most-specific first. Each pattern keeps the label and burns the value, so a log line stays
# diagnosable ("auth header present, 401") without carrying the credential.
$RedactRules = @(
  @{ p = '(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{8,}';                                  r = '${1}<redacted>' },
  @{ p = '(?i)(x-api-key\s*[:=]\s*)["'']?[A-Za-z0-9._~+/=-]{8,}';                  r = '${1}<redacted>' },
  @{ p = 'sk-[A-Za-z0-9._-]{8,}';                                                  r = 'sk-<redacted>' },
  @{ p = 'gh[pousr]_[A-Za-z0-9]{12,}';                                             r = 'gh_<redacted>' },
  @{ p = 'xox[abps]-[A-Za-z0-9-]{10,}';                                            r = 'xox-<redacted>' },
  @{ p = 'AIza[A-Za-z0-9_-]{20,}';                                                 r = 'AIza<redacted>' },
  @{ p = 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+';              r = '<redacted-jwt>' },
  @{ p = '(?i)("?(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|client[_-]?secret|authorization)"?\s*[:=]\s*)["'']?[^"''\s,;}\]]{8,}'; r = '${1}<redacted>' }
)

function Protect-Text([string]$text) {
  if ([string]::IsNullOrEmpty($text)) { return $text }
  foreach ($rule in $RedactRules) {
    $text = [regex]::Replace($text, $rule.p, $rule.r)
  }
  return $text
}

# Copy a text file into the bundle, redacted, optionally keeping only the newest $TailLines lines.
function Add-TextFile([string]$Path, [string]$As, [int]$TailLines = 0) {
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  try {
    if ($TailLines -gt 0) {
      $body = (Get-Content -LiteralPath $Path -Tail $TailLines -ErrorAction Stop) -join "`r`n"
    } else {
      $body = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
    }
    $dest = Join-Path $stage $As
    $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest)
    Set-Content -LiteralPath $dest -Value (Protect-Text $body) -Encoding UTF8
    $notes.Add(("collected {0}  <- {1}" -f $As, $Path))
    return $true
  } catch {
    $notes.Add(("SKIPPED  {0}  ({1})" -f $Path, $_.Exception.Message))
    return $false
  }
}

# ---- 1. the engine log (Electron main tees the engine's stdout/stderr here) ---------------------
# %APPDATA%\lucidagentide-desktop is the standard Agent build's userData dir (Electron app name =
# desktop/package.json "name"). A non-default LUCID_PORT suffixes it with -<port>; the Creator
# flavor calls app.setName() and gets its own LucidCreator dir.
$userDataRoots = @()
Get-ChildItem -Directory -LiteralPath $env:APPDATA -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -eq 'lucidagentide-desktop' -or $_.Name -like 'lucidagentide-desktop-*' -or $_.Name -eq 'LucidCreator' -or $_.Name -like 'LucidCreator-*' } |
  ForEach-Object { $userDataRoots += $_.FullName }

# One unsuffixed dir is the installed app. The -<port> dirs are ad-hoc/dev instances; a machine that has
# run many accumulates dozens of stale ones, so those are filtered to the collection window and capped -
# a bundle full of 200-byte logs from March buries the one log that matters.
$engineLogs = @()
foreach ($root in $userDataRoots) {
  $leaf = Split-Path -Leaf $root
  $f = Get-Item -LiteralPath (Join-Path $root 'engine.log') -ErrorAction SilentlyContinue
  if (-not $f) { continue }
  $primary = ($leaf -eq 'lucidagentide-desktop' -or $leaf -eq 'LucidCreator')
  if ($primary -or $f.LastWriteTime -ge $cutoff) {
    $engineLogs += [pscustomobject]@{ File = $f; As = "engine/$leaf-engine.log"; Primary = $primary }
  }
}
foreach ($e in ($engineLogs | Sort-Object @{e = 'Primary'; Descending = $true }, @{e = { $_.File.LastWriteTime }; Descending = $true } | Select-Object -First 12)) {
  $null = Add-TextFile $e.File.FullName $e.As
}
if ($userDataRoots.Count -eq 0) { $notes.Add('SKIPPED  no userData dir under %APPDATA% - is LUCID installed for this user?') }

# ---- 2. the ACP log: every omp child's stderr, one rolling file (desktop/acp.ts) ----------------
$omp = Join-Path $env:USERPROFILE '.omp'
$null = Add-TextFile (Join-Path $omp 'lucid-acp.log') 'omp/lucid-acp.log'

# ---- 3. omp's own daily logs + its rejected-request dumps ---------------------------------------
# This is where a provider-side model failure actually lands: HTTP status, model id, error body.
$ompLogs = Join-Path $omp 'logs'
Get-ChildItem -LiteralPath $ompLogs -File -Filter 'omp.*.log' -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -ge $cutoff } |
  ForEach-Object { $null = Add-TextFile $_.FullName ("omp/logs/" + $_.Name) }
# .gz rotations are copied verbatim (already-compressed bytes cannot be redacted in place); they are
# omp's own older logs, so they are included only when the caller widens the window to reach them.
Get-ChildItem -LiteralPath $ompLogs -File -Filter 'omp.*.log.gz' -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -ge $cutoff } |
  ForEach-Object {
    $dest = Join-Path $stage ("omp/logs/" + $_.Name)
    $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest)
    Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
    $notes.Add(("collected omp/logs/{0}  (gz, NOT redacted - compressed)" -f $_.Name))
  }
# omp dumps the FULL rejected request, prompt and all: a single file here was 5.9 MB of conversation and
# file contents. The diagnosis lives in the envelope (provider / api / model / url / request params), so
# only a summary is collected - never the message bodies. Support gets the shape; the user keeps the text.
Get-ChildItem -LiteralPath (Join-Path $ompLogs 'http-400-requests') -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 15 |
  ForEach-Object {
    $src = $_
    try {
      $j = Get-Content -LiteralPath $src.FullName -Raw -ErrorAction Stop | ConvertFrom-Json
      $sum = [ordered]@{
        file       = $src.Name
        at         = $src.LastWriteTime.ToString('o')
        bytes      = $src.Length
        provider   = $j.provider
        api        = $j.api
        model      = $j.model
        method     = $j.method
        url        = $j.url
        headerKeys = @(if ($j.headers) { $j.headers.PSObject.Properties.Name } else { @() })
      }
      if ($j.body) {
        $params = [ordered]@{}
        foreach ($p in $j.body.PSObject.Properties) {
          if ($p.Name -eq 'messages' -or $p.Name -eq 'system' -or $p.Name -eq 'tools') { continue }
          if ($p.Value -is [string] -or $p.Value -is [int] -or $p.Value -is [long] -or $p.Value -is [double] -or $p.Value -is [bool]) { $params[$p.Name] = $p.Value }
          else { $params[$p.Name] = '<object>' }
        }
        $sum['requestParams'] = [pscustomobject]$params
        $sum['toolCount'] = @($j.body.tools).Count
        # AGGREGATE, not per-message: a 6 MB dump has thousands of turns, and one row each turned a
        # 1 KB summary into 280 KB of noise. Counts plus the largest few are what diagnose an
        # oversize-request rejection.
        $sizes = @($j.body.messages | ForEach-Object {
            [pscustomobject]@{ role = $_.role; contentBytes = (($_.content | ConvertTo-Json -Depth 30 -Compress -ErrorAction SilentlyContinue)).Length }
          })
        $sum['messageCount'] = $sizes.Count
        $sum['messageBytesTotal'] = ($sizes | Measure-Object -Property contentBytes -Sum).Sum
        $byRole = [ordered]@{}
        foreach ($g in ($sizes | Group-Object role | Sort-Object Name)) { $byRole[[string]$g.Name] = $g.Count }
        $sum['messagesByRole'] = [pscustomobject]$byRole
        $sum['largestMessages'] = @($sizes | Sort-Object contentBytes -Descending | Select-Object -First 5)
      }
      $dest = Join-Path $stage ("omp/logs/http-400-requests/" + [IO.Path]::GetFileNameWithoutExtension($src.Name) + ".summary.json")
      $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest)
      Set-Content -LiteralPath $dest -Value (Protect-Text (([pscustomobject]$sum) | ConvertTo-Json -Depth 8)) -Encoding UTF8
      $notes.Add(("summarized omp/logs/http-400-requests/{0} ({1:N0} KB of request body NOT included)" -f $src.Name, ($src.Length / 1KB)))
    } catch {
      $notes.Add(("SKIPPED  http-400 dump {0} ({1})" -f $src.Name, $_.Exception.Message))
    }
  }

# ---- 4. model-relevant telemetry tails (metadata only; no prompt or reply text) -----------------
foreach ($t in @(
  @{ f = 'lucid-latency.jsonl';      n = 400 },   # per-turn TTFT/total + model + ok flag
  @{ f = 'lucid-eval-metrics.jsonl'; n = 200 },
  @{ f = 'lucid-events.ndjson';      n = 600 },   # EventName stream
  @{ f = 'lucid-blocks.jsonl';       n = 200 },   # security-gate blocks
  @{ f = 'lucid-fleet-lanes.jsonl';  n = 200 }
)) {
  $null = Add-TextFile (Join-Path $omp $t.f) ("telemetry/" + $t.f) $t.n
}

# ---- 5. a REDACTED projection of lucid-gui.json -------------------------------------------------
# The original holds plaintext provider keys, so it is never copied. What support needs is the SHAPE:
# which providers have a key at all, which model is selected, whether AskSage lockdown is on.
$SecretName = '(?i)^(keys|token|secret|password|passwd|apikey|api_key|client_secret|authorization)$'
function Protect-Node($node, [string]$name) {
  if ($name -match $SecretName) {
    if ($node -is [string]) { return ("<redacted len={0}>" -f $node.Length) }
    if ($node -is [System.Management.Automation.PSCustomObject]) {
      $shape = [ordered]@{}
      foreach ($p in $node.PSObject.Properties) {
        $v = if ($p.Value -is [string]) { "<set len={0} last4={1}>" -f $p.Value.Length, ($p.Value.Substring([Math]::Max(0, $p.Value.Length - 4))) } else { '<set>' }
        $shape[$p.Name] = $v
      }
      return [pscustomobject]$shape
    }
    return '<redacted>'
  }
  if ($node -is [System.Management.Automation.PSCustomObject]) {
    $out = [ordered]@{}
    foreach ($p in $node.PSObject.Properties) { $out[$p.Name] = Protect-Node $p.Value $p.Name }
    return [pscustomobject]$out
  }
  if ($node -is [System.Object[]]) { return @($node | ForEach-Object { Protect-Node $_ $name }) }
  if ($node -is [string]) { return Protect-Text $node }
  return $node
}

$guiPath = Join-Path $omp 'lucid-gui.json'
if (Test-Path -LiteralPath $guiPath) {
  try {
    $gui = Get-Content -LiteralPath $guiPath -Raw -ErrorAction Stop | ConvertFrom-Json
    $safe = Protect-Node $gui ''
    Set-Content -LiteralPath (Join-Path $stage 'settings-redacted.json') -Value ($safe | ConvertTo-Json -Depth 20) -Encoding UTF8
    $notes.Add('collected settings-redacted.json  <- lucid-gui.json (key VALUES replaced with length/last4)')
  } catch {
    $notes.Add(("SKIPPED  lucid-gui.json could not be parsed, so it was NOT included ({0})" -f $_.Exception.Message))
  }
}

# ---- 6. machine + install report ---------------------------------------------------------------
$report = New-Object System.Collections.Generic.List[string]
$report.Add("LUCID support bundle  $stamp")
$report.Add('')
$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
$cs = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
$report.Add("OS            : $($os.Caption) build $($os.BuildNumber) ($($os.OSArchitecture))")
$report.Add("CPU           : $((Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1).Name)")
$report.Add("RAM           : $([Math]::Round($cs.TotalPhysicalMemory / 1GB, 1)) GB")
$report.Add("GPU           : $(((Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue).Name) -join ', ')")
$report.Add("PowerShell    : $($PSVersionTable.PSVersion)")
$report.Add('')

foreach ($d in (Get-ChildItem -Directory (Join-Path $env:LOCALAPPDATA 'Programs') -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'Lucid*' })) {
  foreach ($exe in (Get-ChildItem -LiteralPath $d.FullName -Filter '*.exe' -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike 'Uninstall*' })) {
    $report.Add("install       : $($exe.FullName)  v$($exe.VersionInfo.ProductVersion)")
  }
}
# Name the dirs an installed app owns; a machine with a history of ad-hoc ports has dozens of stale
# -<port> siblings, and listing each one pushes the real lines off the top of the report.
$primaryRoots = @($userDataRoots | Where-Object { (Split-Path -Leaf $_) -in @('lucidagentide-desktop', 'LucidCreator') })
foreach ($root in $primaryRoots) { $report.Add("userData      : $root") }
$staleCount = $userDataRoots.Count - $primaryRoots.Count
if ($staleCount -gt 0) { $report.Add("userData      : + $staleCount port-suffixed instance dir(s) under %APPDATA% (ad-hoc/dev launches)") }

# The omp binary a turn actually runs on. Candidate order mirrors ompBin() in
# harness/launcher/lucid_acp.ts: the app-managed runtime first, then the installed repo's
# node_modules/.bin, then a user-level bun install, then whatever is on PATH. Reporting only the
# managed path would print a scary "NOT FOUND" on the common install where omp came from bun.
$ompCandidates = New-Object System.Collections.Generic.List[string]
foreach ($root in $userDataRoots) { $ompCandidates.Add((Join-Path $root 'runtimes\bun-global\bin\omp.exe')) }
foreach ($d in (Get-ChildItem -Directory (Join-Path $env:LOCALAPPDATA 'Programs') -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'Lucid*' })) {
  $ompCandidates.Add((Join-Path $d.FullName 'resources\repo\node_modules\.bin\omp.exe'))
}
$ompCandidates.Add((Join-Path $env:USERPROFILE '.bun\bin\omp.exe'))
$onPath = (Get-Command omp -ErrorAction SilentlyContinue)
if ($onPath) { $ompCandidates.Add($onPath.Source) }

$ompExe = $ompCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($ompExe) {
  $report.Add("omp binary    : $ompExe")
  try { $report.Add("omp --version : $((& $ompExe --version 2>&1) -join ' ')") } catch { $report.Add("omp --version : failed - $($_.Exception.Message)") }
  $others = @($ompCandidates | Where-Object { (Test-Path -LiteralPath $_) -and $_ -ne $ompExe } | Select-Object -Unique)
  if ($others.Count -gt 0) { $report.Add("omp also at   : $($others -join '; ')") }
} else {
  $report.Add("omp binary    : NOT FOUND - a model turn cannot start. Probed: $($ompCandidates -join '; ')")
}

# The fail-closed preflight: gate extension present + scanner sidecar reachable. Exit 1 here is the
# single most common reason a model turn never starts.
$lucidExe = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Programs\Lucid*\resources\repo\bin\lucid.exe') -ErrorAction SilentlyContinue | Select-Object -First 1
if ($lucidExe) {
  $report.Add('')
  $report.Add("lucid check   : $($lucidExe.FullName)")
  try { $report.Add((& $lucidExe.FullName check 2>&1) -join "`r`n") } catch { $report.Add("failed to run - $($_.Exception.Message)") }
}

# Who owns the engine port. A foreign listener on 5319 is a known cause of "LUCID is behaving like a
# different app" reports (ADR-0305), and it looks exactly like a model/runtime failure from the UI.
$report.Add('')
foreach ($p in @(5319, 5320)) {
  $conn = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn) {
    $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    $report.Add("port $p      : LISTEN pid $($conn.OwningProcess) $($proc.ProcessName) $($proc.Path)")
  } else {
    $report.Add("port $p      : free")
  }
}

$report.Add('')
$report.Add('--- collection log ---')
$report.AddRange([string[]]$notes)
Set-Content -LiteralPath (Join-Path $stage 'system-info.txt') -Value ((Protect-Text ($report -join "`r`n"))) -Encoding UTF8

# ---- 7. zip -------------------------------------------------------------------------------------
$null = New-Item -ItemType Directory -Force -Path $OutDir
$zip = Join-Path $OutDir "lucid-support-$stamp.zip"
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force
Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host 'LUCID support bundle written to:' -ForegroundColor Green
Write-Host "  $zip"
Write-Host ''
Write-Host ("  {0:N0} KB - attach this one file to your support email." -f ((Get-Item -LiteralPath $zip).Length / 1KB))
Write-Host '  Provider API keys, OAuth tokens, and the credential vaults are NOT in it.'
Write-Host ''
