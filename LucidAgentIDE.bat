@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion
title Lucid Control Panel

rem ===========================================================================
rem  LucidAgentIDE.bat  -  double-click control panel for omp + the security
rem  harness. Checks dependencies / PATH / provider keys, lets you pick a model,
rem  launches omp (in its own window) with the security gate, and stays open as a
rem  cheatsheet to switch model/provider, view dashboards, and check status.
rem
rem  Hidden modes (for scripting / testing):
rem     LucidAgentIDE.bat doctor      - run dependency check and exit
rem     LucidAgentIDE.bat dashboard   - render the security dashboard and exit
rem ===========================================================================

rem --- repo root = this file's directory (works wherever the repo lives) ---
set "REPO=%~dp0"
if "%REPO:~-1%"=="\" set "REPO=%REPO:~0,-1%"
cd /d "%REPO%"

rem --- make sure bun / uv / omp are reachable even before a terminal restart ---
call :ensurepath

rem --- defaults ---
set "PROVIDER=Anthropic"
set "MODEL=claude-opus-4-8"
set "KEYVAR=ANTHROPIC_API_KEY"
rem  Models offered to omp's live Ctrl+P switcher (--models). Kept in sync with MODEL.
set "MODELS=claude-opus-4-8,claude-sonnet-4-6,claude-haiku-4-5"

rem --- arg dispatch (non-interactive helpers) ---
if /i "%~1"=="doctor"    ( call :doctor & exit /b 0 )
if /i "%~1"=="dashboard" ( call :dashboard & exit /b 0 )

call :banner
call :doctor
call :detectkeys
goto :menu

rem ===========================================================================
:banner
echo.
echo    =====================================================================
echo        L  U  C  I  D     A  G  E  N  T     I  D  E
echo    ---------------------------------------------------------------------
echo         .---.        scan   every tool call checked for hidden-unicode
echo        /  _  \              prompt injection + homoglyph spoofing
echo       :  /_\  :      gate   quarantined content blocked, fail-closed
echo        \  #  /       audit  findings / approvals / exports all logged
echo         '---'        omp    security harness  -  extend, never fork
echo    =====================================================================
echo.
goto :eof

rem ===========================================================================
:doctor
echo  [ checking dependencies + PATH ]
call :check "bun"    bun
call :check "uv"     uv
call :check "python" python
call :check "omp"    omp
call :checkfile "security extension" "%REPO%\harness\omp\security_extension.ts"
call :checkfile "scanner sidecar venv" "%REPO%\scanner-sidecar\.venv"
echo.
goto :eof

:check
set "_ok="
for /f "delims=" %%P in ('where %2 2^>nul') do set "_ok=1"
if defined _ok ( echo    [ OK ]  %~1 ) else ( echo    [MISS]  %~1   ^<- not on PATH )
goto :eof

:checkfile
if exist "%~2" ( echo    [ OK ]  %~1 ) else ( echo    [MISS]  %~1 )
goto :eof

rem ===========================================================================
:detectkeys
echo  [ checking provider auth ]
echo    - environment API keys:
call :keystate "Anthropic" ANTHROPIC_API_KEY
call :keystate "OpenAI"    OPENAI_API_KEY
call :keystate "Google"    GEMINI_API_KEY
call :keystate "OpenRouter" OPENROUTER_API_KEY
echo    - omp credential vault (OAuth / subscription logins):
set "VAULT_ANTHROPIC="
rem  One bun call: write the vault report to a temp file, print it, derive the flag.
where bun >nul 2>&1 && (
  bun run "%REPO%\tools\omp_auth_status.ts" > "%TEMP%\lucid_auth.txt" 2>nul
  type "%TEMP%\lucid_auth.txt" 2>nul
  findstr /i "anthropic" "%TEMP%\lucid_auth.txt" >nul 2>&1 && set "VAULT_ANTHROPIC=1"
  del "%TEMP%\lucid_auth.txt" >nul 2>&1
) || echo      ^( -- ^) bun not on PATH - cannot read omp vault
echo.
rem  Only nag for a key if there's NO Anthropic auth at all (no env key AND no omp OAuth login).
if not defined ANTHROPIC_API_KEY if not defined VAULT_ANTHROPIC (
  echo    No Anthropic auth found ^(no ANTHROPIC_API_KEY and no omp OAuth login^).
  echo    Tip: run "omp" once and use its /login for Claude Pro/Max, or paste a key below.
  set /p "ENTERKEY=    Paste your ANTHROPIC_API_KEY now (or Enter to skip): "
  if defined ENTERKEY set "ANTHROPIC_API_KEY=!ENTERKEY!"
  echo.
)
goto :eof

:keystate
if defined %2 ( echo    [ SET ]  %~1 ^(%2^) ) else ( echo    [ -- ]   %~1 ^(%2 not set^) )
goto :eof

rem ===========================================================================
:menu
echo  ---------------------------------------------------------------------
echo    provider : %PROVIDER%        model : %MODEL%
echo  ---------------------------------------------------------------------
echo     1^)  Launch / relaunch omp   ^(terminal, with the security gate^)
echo     G^)  Desktop GUI             ^(chat + dashboards in a window^)
echo     2^)  Switch model
echo     3^)  Switch provider
echo     4^)  Dashboards  ^(security  /  memory ^& context^)
echo     5^)  Status check  ^(is omp running?^)
echo     6^)  Live injection demo  ^(blocks a poisoned tool call^)
echo     7^)  Re-run dependency doctor
echo     8^)  Cheatsheet
echo     9^)  Setup / install missing dependencies
echo     0^)  Quit
echo.
set /p "CH=    select: "
if "%CH%"=="1" goto :launch
if /i "%CH%"=="G" ( call :gui & goto :menu )
if "%CH%"=="2" goto :pickmodel
if "%CH%"=="3" goto :pickprovider
if "%CH%"=="4" ( call :dashboardmenu & goto :menu )
if "%CH%"=="5" ( call :statuscheck & goto :menu )
if "%CH%"=="6" ( call :demo & goto :menu )
if "%CH%"=="7" ( call :doctor & goto :menu )
if "%CH%"=="8" ( call :cheatsheet & goto :menu )
if "%CH%"=="9" ( call :install & goto :menu )
if "%CH%"=="0" goto :bye
echo    ^(unrecognized^)
goto :menu

rem ===========================================================================
:launch
echo.
echo    Launching omp with model "%MODEL%" + the security gate in a new window...
start "LucidAgentIDE %MODEL%" cmd /k "chcp 65001>nul & cd /d "%REPO%" & set "ANTHROPIC_API_KEY=%ANTHROPIC_API_KEY%" & omp --model %MODEL% --models %MODELS% -e harness/omp/security_extension.ts"
echo    Done.  In omp:  /lucid:help  .  /lucid:memory  .  Ctrl+P switches model live
echo.
timeout /t 2 >nul
goto :menu

rem ===========================================================================
rem  Launch the desktop GUI (chat + dashboards). Prefers the native Electron app
rem  if its binary is installed; otherwise opens the browser GUI and the browser.
:gui
echo.
echo    [ Lucid desktop GUI ]
where bun >nul 2>&1 || ( echo    bun not found - cannot start the GUI. & goto :eof )
if exist "%REPO%\desktop\node_modules\electron\dist\electron.exe" (
  echo    Launching the native Electron app in a new window...
  start "LucidAgentIDE GUI" cmd /k "chcp 65001>nul & cd /d "%REPO%\desktop" & set "ANTHROPIC_API_KEY=%ANTHROPIC_API_KEY%" & bun run start"
) else (
  echo    Electron isn't installed yet - opening the browser GUI instead.
  echo    ^(For the native app:  cd desktop  ^&^&  bun install  ^&^&  bun run start^)
  start "LucidAgentIDE GUI (web)" cmd /k "chcp 65001>nul & cd /d "%REPO%" & set "ANTHROPIC_API_KEY=%ANTHROPIC_API_KEY%" & bun run desktop:web"
  timeout /t 3 >nul
  start "" "http://localhost:4318"
)
echo    Done.
echo.
goto :eof

rem ===========================================================================
:pickmodel
echo.
echo    Anthropic models (current):
echo       1^)  claude-opus-4-8     most capable
echo       2^)  claude-sonnet-4-6   balanced speed/intelligence
echo       3^)  claude-haiku-4-5    fastest / cheapest
echo       4^)  custom  (type any id, e.g. openai/gpt-5.2)
echo.
set /p "M=    select: "
if "%M%"=="1" set "MODEL=claude-opus-4-8"
if "%M%"=="2" set "MODEL=claude-sonnet-4-6"
if "%M%"=="3" set "MODEL=claude-haiku-4-5"
if "%M%"=="4" ( set /p "MODEL=    enter model id: " )
rem  put the chosen model at the head of the Ctrl+P cycle list
set "MODELS=%MODEL%,claude-opus-4-8,claude-sonnet-4-6,claude-haiku-4-5"
echo    model is now: %MODEL%
goto :applychange

rem ===========================================================================
:pickprovider
echo.
echo       1^)  Anthropic   (ANTHROPIC_API_KEY)
echo       2^)  OpenAI      (OPENAI_API_KEY)
echo       3^)  OpenRouter  (OPENROUTER_API_KEY)
echo       4^)  custom
echo.
set /p "P=    select: "
if "%P%"=="1" ( set "PROVIDER=Anthropic"  & set "MODEL=claude-opus-4-8" )
if "%P%"=="2" ( set "PROVIDER=OpenAI"     & set "MODEL=gpt-5.2" )
if "%P%"=="3" ( set "PROVIDER=OpenRouter" & set "MODEL=anthropic/claude-opus-4-8" )
if "%P%"=="4" ( set /p "PROVIDER=    provider name: " )
set "MODELS=%MODEL%,claude-opus-4-8,claude-sonnet-4-6,claude-haiku-4-5"
echo    provider: %PROVIDER%   default model: %MODEL%
echo    (omp resolves the provider from the model id + its OAuth login or API key)
goto :applychange

rem ===========================================================================
rem  A model/provider choice only reaches omp at LAUNCH (--model) or live via
rem  Ctrl+P inside omp. The control panel can't reach into a running process, so
rem  we offer to relaunch with the new selection.
:applychange
echo.
call :ompstatus
if "%OMP%"=="running" (
  echo    A running omp session keeps its CURRENT model until you relaunch it.
  echo    Tip: inside omp, Ctrl+P switches between: %MODELS%
)
set /p "RL=    Relaunch omp now with %MODEL%? (Y/N): "
if /i "%RL%"=="Y" goto :launch
echo.
goto :menu

rem ===========================================================================
:dashboardmenu
echo.
echo       1^)  Security dashboard       findings / quarantine / approvals / exports
echo       2^)  Memory ^& context         context window / KV-cache / compaction / semantic memory
echo.
set /p "D=    select: "
if "%D%"=="1" ( call :dashboard & goto :eof )
if "%D%"=="2" ( call :memdash & goto :eof )
echo    ^(unrecognized^)
goto :eof

:dashboard
echo.
where bun >nul 2>&1 || ( echo    bun not found - cannot render dashboard. & goto :eof )
bun run "%REPO%\tools\dashboard_tui.ts"
echo.
goto :eof

:memdash
echo.
where bun >nul 2>&1 || ( echo    bun not found - cannot render dashboard. & goto :eof )
bun run "%REPO%\tools\memory_tui.ts"
echo.
goto :eof

rem ===========================================================================
:demo
echo.
where bun >nul 2>&1 || ( echo    bun not found. & goto :eof )
echo    Running demo-P2.4: a poisoned tool call is blocked by the gate...
bun run "%REPO%\harness\scripts\demo04_quarantine_hook.ts"
echo.
goto :eof

rem ===========================================================================
:ompstatus
set "OMP=stopped"
for /f "tokens=*" %%T in ('tasklist /v /fo csv 2^>nul ^| findstr /i "LucidAgentIDE" ^| findstr /v /i "Control"') do set "OMP=running"
echo    omp session : %OMP%
goto :eof

:statuscheck
call :ompstatus
if "%OMP%"=="running" ( echo    [ OK ] an omp / LucidAgentIDE window is open. ) else ( echo    [ -- ] no omp window detected. Use option 1 to launch. )
echo.
goto :eof

rem ===========================================================================
:cheatsheet
echo.
echo    ============================  CHEATSHEET  ===========================
echo    Inside omp (the agent window):
echo       /lucid:help          quickstart for the security harness + commands
echo       /lucid:scan TEXT     scan text for hidden-unicode prompt injection
echo       /lucid:dashboard     security dashboard (findings / quarantine / exports)
echo       /lucid:memory        memory ^& context dashboard (context / cache / semantic)
echo       !bun run dashboard:tui   instant security dashboard (no agent turn)
echo       !bun run memory:tui      instant memory ^& context dashboard
echo       Ctrl+P               switch model live      /usage   token usage
echo.
echo    In THIS control panel:
echo       1 launch omp   G desktop GUI    2 switch model   3 switch provider
echo       4 dashboards   5 status         6 demo   7 doctor   9 install
echo.
echo    Models (current):  claude-opus-4-8 . claude-sonnet-4-6 . claude-haiku-4-5
echo    Keys (env var):    ANTHROPIC_API_KEY . OPENAI_API_KEY . OPENROUTER_API_KEY
echo    =====================================================================
echo.
goto :eof

rem ===========================================================================
:ensurepath
if exist "%USERPROFILE%\.bun\bin"                 set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
if exist "%USERPROFILE%\.local\bin"               set "PATH=%USERPROFILE%\.local\bin;%PATH%"
if exist "%APPDATA%\Python\Python314\Scripts"     set "PATH=%APPDATA%\Python\Python314\Scripts;%PATH%"
if exist "%REPO%\node_modules\.bin"               set "PATH=%REPO%\node_modules\.bin;%PATH%"
goto :eof

rem ===========================================================================
:install
echo.
echo    [ setup / install missing dependencies ]
echo    Installs only what's missing: bun, uv, omp, then the project deps.
echo    (downloads from bun.sh / astral.sh / npm; needs internet)
set /p "GO=    Proceed? (Y/N): "
if /i not "%GO%"=="Y" goto :eof
echo.
where bun >nul 2>&1 || ( echo    -- installing bun ... & powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex" )
call :ensurepath
where uv >nul 2>&1 || ( echo    -- installing uv ... & powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex" )
call :ensurepath
where omp >nul 2>&1 || ( echo    -- installing omp ^(bun add -g^) ... & bun add -g @oh-my-pi/pi-coding-agent )
call :ensurepath
echo    -- installing harness deps ^(bun install^) ...
where bun >nul 2>&1 && bun install
echo    -- syncing scanner sidecar ^(uv sync^) ...
where uv >nul 2>&1 && ( pushd "%REPO%\scanner-sidecar" & uv sync & popd )
echo.
echo    setup complete. Note: a NEW terminal may be needed for global PATH changes.
call :doctor
goto :eof

rem ===========================================================================
:bye
echo.
echo    Bye. (omp windows you launched keep running.)
echo.
endlocal
exit /b 0
