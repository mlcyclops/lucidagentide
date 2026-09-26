@echo off
rem Copyright (c) 2026 TechLead 187 LLC
rem SPDX-License-Identifier: BUSL-1.1
rem
rem P-SANDBOX.17 (ADR-0399): the contained agent's `git`. First on its PATH, it runs git_shim.ts with the
rem agent's own bun, which asks the engine to run the real git outside the sandbox.
setlocal
set "LUCID_GIT_BUN=%LUCID_BUN_BIN%"
if not defined LUCID_GIT_BUN set "LUCID_GIT_BUN=bun"
"%LUCID_GIT_BUN%" "%~dp0git_shim.ts" %*
exit /b %ERRORLEVEL%
