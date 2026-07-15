@echo off
setlocal EnableExtensions
title LUCID Agent - collect diagnostics

REM ---------------------------------------------------------------------------
REM  Gathers LUCID Agent diagnostics into a single zip on your Desktop that you
REM  can send back for troubleshooting. It collects:
REM    - engine.log (last ~3000 lines, with obvious secrets redacted)
REM    - OS + whether bun / omp resolve on PATH
REM    - which install is present and whether the bundled runtimes shipped
REM      (bun.exe / python / omp shim) -- the exact thing behind the "bun is
REM      not installed" issue
REM    - a listing (names + sizes only) of the userData and ~/.omp folders
REM  It does NOT read your API keys, OAuth tokens, or chat contents.
REM
REM  Just double-click it. Output: lucid-diagnostics.zip on your Desktop.
REM ---------------------------------------------------------------------------

set "OUT=%TEMP%\lucid-diag-%RANDOM%%RANDOM%"
set "UD=%APPDATA%\LucidAgentIDE"
set "OMPHOME=%USERPROFILE%\.omp"
set "INFO=%OUT%\info.txt"

if exist "%OUT%" rmdir /s /q "%OUT%" 2>nul
mkdir "%OUT%" 2>nul

echo   Collecting LUCID Agent diagnostics...
echo.

REM --- system + environment (no secrets) ---
>  "%INFO%" echo LUCID Agent diagnostics
>> "%INFO%" echo Generated: %DATE% %TIME%  on  %COMPUTERNAME%
>> "%INFO%" echo.
>> "%INFO%" echo == OS ==
ver >> "%INFO%" 2>&1
>> "%INFO%" echo.
>> "%INFO%" echo == bun / omp on PATH ==
>> "%INFO%" echo -- where bun --
where bun >> "%INFO%" 2>&1
>> "%INFO%" echo -- where omp --
where omp >> "%INFO%" 2>&1
>> "%INFO%" echo.
>> "%INFO%" echo == PATH ==
>> "%INFO%" echo %PATH%
>> "%INFO%" echo.

REM --- installed build + bundled runtimes present? ---
>> "%INFO%" echo == install / bundled runtimes ==
for %%D in ("%LOCALAPPDATA%\Programs\LucidAgentIDE" "%PROGRAMFILES%\LucidAgentIDE" "%PROGRAMFILES(X86)%\LucidAgentIDE") do (
  if exist "%%~D\LucidAgentIDE.exe" (
    >> "%INFO%" echo install found: %%~D
    if exist "%%~D\resources\runtimes\bun.exe" ( >> "%INFO%" echo   bundled bun.exe    : YES ) else ( >> "%INFO%" echo   bundled bun.exe    : NO )
    if exist "%%~D\resources\runtimes\bun-win32-x64.exe" ( >> "%INFO%" echo   bundled bun-suffix : YES ) else ( >> "%INFO%" echo   bundled bun-suffix : NO )
    if exist "%%~D\resources\runtimes\python-win32-x64\python.exe" ( >> "%INFO%" echo   bundled python     : YES ) else ( >> "%INFO%" echo   bundled python     : NO )
    if exist "%%~D\resources\repo\node_modules\.bin\omp.exe" ( >> "%INFO%" echo   bundled omp shim   : YES ) else ( >> "%INFO%" echo   bundled omp shim   : NO )
  )
)
>> "%INFO%" echo.

REM --- config presence (names + sizes only, NO contents) ---
>> "%INFO%" echo == userData: %UD% ==
dir "%UD%" >> "%INFO%" 2>&1
>> "%INFO%" echo.
>> "%INFO%" echo == omp home: %OMPHOME% ==
dir "%OMPHOME%" >> "%INFO%" 2>&1
>> "%INFO%" echo.
>> "%INFO%" echo == omp agent dir ==
dir "%OMPHOME%\agent" >> "%INFO%" 2>&1
>> "%INFO%" echo.
>> "%INFO%" echo == omp logs dir (names/sizes only) ==
dir "%OMPHOME%\logs" >> "%INFO%" 2>&1

REM --- engine.log: last ~3000 lines with obvious secrets redacted ---
if exist "%UD%\engine.log" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$c = Get-Content -LiteralPath '%UD%\engine.log' -Tail 3000 -ErrorAction SilentlyContinue; $c = $c -replace '(?i)(bearer\s+|x-access-tokens\s*[:=]?\s*|authorization\s*[:=]\s*|sk-|token\s*[:=]\s*|api[_-]?key\s*[:=]\s*)[A-Za-z0-9_\-\.]{10,}','$1<REDACTED>'; Set-Content -LiteralPath '%OUT%\engine.log' -Value $c" 2>nul
) else (
  > "%OUT%\engine.log" echo ^(no engine.log found at %UD%^)
)

REM --- zip onto the REAL Desktop (resolves a OneDrive-redirected Desktop) + reveal it ---
powershell -NoProfile -ExecutionPolicy Bypass -Command "$dt=[Environment]::GetFolderPath('Desktop'); $zip=Join-Path $dt 'lucid-diagnostics.zip'; if(Test-Path $zip){Remove-Item $zip -Force}; Compress-Archive -Path '%OUT%\*' -DestinationPath $zip -Force; if(Test-Path $zip){ Write-Host ''; Write-Host '  Done. Please send me this file:'; Write-Host ('    ' + $zip); Start-Process explorer.exe ('/select,' + $zip) } else { Write-Host '  ERROR: could not create the zip.' }"

rmdir /s /q "%OUT%" 2>nul
echo.
pause
