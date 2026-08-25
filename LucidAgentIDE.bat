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
rem  The slick UTF-8 art lives in an external file rendered with TYPE - inlining
rem  multibyte chars in the script desyncs cmd's parser under "chcp 65001" and
rem  silently aborts the menu. TYPE just streams the bytes, so the .bat stays ASCII.
echo.
if exist "%REPO%\.github\assets\cli-banner.txt" (
  type "%REPO%\.github\assets\cli-banner.txt"
) else (
  echo    L U C I D   A G E N T   I D E   -   security . provenance . memory
)
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
echo     F^)  Fleet GUI               ^(project-bound window: own workspace + Knowledge^)
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
if /i "%CH%"=="F" ( call :fleetgui & goto :menu )
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
rem  Pick a free port instead of stomping on port 5319. If another LUCID app (or a stale
rem  server) already holds 5319, we roll a free high port and use THAT - we never kill it.
rem  The chosen port flows into the app: Electron (main.ts) reads LUCID_PORT and passes it
rem  to dev.ts; the browser fallback sets PORT for dev.ts and opens the matching URL.
call :pickport
rem  OneDrive sync can strip node_modules\.bin (the tiny shim launchers) while leaving the
rem  package dirs intact. Then "bun run start" dies with "command not found: electron" even
rem  though electron\dist\electron.exe is right there. Detect the stripped state and relink
rem  the shims with a quick bun install before deciding native vs web.
if exist "%REPO%\desktop\node_modules\electron\dist\electron.exe" if not exist "%REPO%\desktop\node_modules\.bin\electron.exe" (
  echo    Electron is installed but node_modules\.bin lost its shims - relinking with bun install...
  pushd "%REPO%\desktop"
  bun install
  popd
)
set "NATIVEOK=1"
if not exist "%REPO%\desktop\node_modules\electron\dist\electron.exe" set "NATIVEOK="
if not exist "%REPO%\desktop\node_modules\.bin\electron.exe" set "NATIVEOK="
if defined NATIVEOK (
  echo    Launching the native Electron app on port !GUIPORT! in a new window...
  start "LucidAgentIDE GUI" cmd /k "chcp 65001>nul & cd /d "%REPO%\desktop" & set "LUCID_PORT=!GUIPORT!" & set "ANTHROPIC_API_KEY=%ANTHROPIC_API_KEY%" & bun run start"
) else (
  echo    Electron isn't installed yet - opening the browser GUI instead.
  echo    ^(For the native app:  cd desktop  ^&^&  bun install  ^&^&  bun run start^)
  start "LucidAgentIDE GUI (web)" cmd /k "chcp 65001>nul & cd /d "%REPO%" & set "PORT=!GUIPORT!" & set "ANTHROPIC_API_KEY=%ANTHROPIC_API_KEY%" & bun run desktop:web"
  timeout /t 3 >nul
  start "" "http://localhost:!GUIPORT!"
)
echo    Done.
echo.
goto :eof

rem ===========================================================================
rem  Fleet GUI: launch a PROJECT-BOUND Lucid window (Fleet Profile prototype for
rem  the Fleet Management feature request / ADR-0260). Each profile gets its own
rem  lucid-gui.json (workspace + recents), its own Personal Knowledge dir, and
rem  its own port. NEVER 5319: the default port keeps the canonical Electron
rem  userData identity + the lucid:// OAuth deep-link (desktop/main.ts), so the
rem  primary instance owns it. Isolation comes from three env vars the app
rem  already honors: LUCID_PORT, LUCID_GUI_SETTINGS_FILE, LUCID_PERSONAL_DIR.
rem  Profile home: %%LOCALAPPDATA%%\LucidFleet\profiles\<NAME>\
:fleetgui
echo.
echo    [ Lucid Fleet GUI - project-bound profile window ]
where bun >nul 2>&1 || ( echo    bun not found - cannot start the GUI. & goto :eof )
set "FLEETROOT=%LOCALAPPDATA%\LucidFleet\profiles"
if exist "%FLEETROOT%" (
  echo    Existing profiles ^(type a name to relaunch it^):
  for /d %%D in ("%FLEETROOT%\*") do echo       - %%~nxD
) else (
  echo    No profiles yet - the first one is created below.
)
set "FLNAME="
set /p "FLNAME=    profile name (e.g. INTELLIGRC, Enter to cancel): "
if not defined FLNAME ( echo    ^(no name - cancelled^) & goto :eof )
set "FLNAME=!FLNAME:"=!"
set "FLNAME=!FLNAME: =-!"
set "PROFDIR=%FLEETROOT%\!FLNAME!"
if exist "!PROFDIR!\lucid-gui.json" (
  echo    Reusing profile "!FLNAME!".
  goto :fl_launch
)
set "WSPATH="
set /p "WSPATH=    workspace folder to bind (e.g. C:\Source\MyRepo): "
if not defined WSPATH ( echo    ^(no folder - cancelled^) & goto :eof )
set "WSPATH=!WSPATH:"=!"
if "!WSPATH:~-1!"=="\" set "WSPATH=!WSPATH:~0,-1!"
if not exist "!WSPATH!\" ( echo    Folder not found: !WSPATH! & goto :eof )
mkdir "!PROFDIR!\personal" >nul 2>&1
rem  Seed the profile's OWN GUI settings with the bound workspace. JSON wants
rem  doubled backslashes; every other setting stays default. Never reseeded on
rem  relaunch, so an in-app workspace change sticks to THIS profile only.
set "WSJSON=!WSPATH:\=\\!"
> "!PROFDIR!\lucid-gui.json" echo {"workspace":"!WSJSON!","recentWorkspaces":["!WSJSON!"]}
echo    Created profile "!FLNAME!" bound to !WSPATH!
:fl_launch
call :fleetport
if not defined FLPORT goto :eof
rem  Same OneDrive shim-relink + native detection as :gui.
if exist "%REPO%\desktop\node_modules\electron\dist\electron.exe" if not exist "%REPO%\desktop\node_modules\.bin\electron.exe" (
  echo    Electron is installed but node_modules\.bin lost its shims - relinking with bun install...
  pushd "%REPO%\desktop"
  bun install
  popd
)
set "NATIVEOK=1"
if not exist "%REPO%\desktop\node_modules\electron\dist\electron.exe" set "NATIVEOK="
if not exist "%REPO%\desktop\node_modules\.bin\electron.exe" set "NATIVEOK="
if defined NATIVEOK (
  echo    Launching Fleet profile "!FLNAME!" on port !FLPORT! in a new window...
  start "LucidAgentIDE Fleet !FLNAME!" cmd /k "chcp 65001>nul & cd /d "%REPO%\desktop" & set "LUCID_PORT=!FLPORT!" & set "LUCID_GUI_SETTINGS_FILE=!PROFDIR!\lucid-gui.json" & set "LUCID_PERSONAL_DIR=!PROFDIR!\personal" & set "ANTHROPIC_API_KEY=%ANTHROPIC_API_KEY%" & bun run start"
) else (
  echo    Electron isn't installed yet - opening the browser GUI instead.
  start "LucidAgentIDE Fleet !FLNAME! (web)" cmd /k "chcp 65001>nul & cd /d "%REPO%" & set "PORT=!FLPORT!" & set "LUCID_GUI_SETTINGS_FILE=!PROFDIR!\lucid-gui.json" & set "LUCID_PERSONAL_DIR=!PROFDIR!\personal" & set "ANTHROPIC_API_KEY=%ANTHROPIC_API_KEY%" & bun run desktop:web"
  timeout /t 3 >nul
  start "" "http://localhost:!FLPORT!"
)
echo    Health:  http://127.0.0.1:!FLPORT!/api/health
echo    Profile: !PROFDIR!
echo.
goto :eof

rem  Pick this profile's port: prefer its saved last port so the profile keeps a
rem  stable-ish address across restarts, else roll a free dynamic port. A busy
rem  saved port usually means the profile is ALREADY running - cheap duplicate
rem  protection, so we ask before opening a second window on the same profile.
:fleetport
set "FLPORT="
set "FLSAVED="
if exist "!PROFDIR!\port.txt" set /p FLSAVED=<"!PROFDIR!\port.txt"
if "!FLSAVED!"=="5319" set "FLSAVED="
if not defined FLSAVED goto :flp_roll_init
call :portfree !FLSAVED!
if not errorlevel 1 ( set "FLPORT=!FLSAVED!" & goto :flp_done )
echo    Port !FLSAVED! is busy - profile "!FLNAME!" may ALREADY be running.
echo    Check http://127.0.0.1:!FLSAVED!/api/health before duplicating.
set /p "DUP=    Launch a SECOND window for this profile anyway? (Y/N): "
if /i not "!DUP!"=="Y" goto :eof
:flp_roll_init
set /a _fp=0
:flp_roll
set /a _fp+=1
set /a FLPORT=49152 + ^(!RANDOM! %% 16000^)
call :portfree !FLPORT!
if not errorlevel 1 goto :flp_done
if !_fp! lss 50 goto :flp_roll
echo    ^(could not find a free port after 50 tries - trying !FLPORT! anyway^)
:flp_done
> "!PROFDIR!\port.txt" echo !FLPORT!
echo    Fleet port: !FLPORT!
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
echo       1 launch omp   G desktop GUI   F fleet GUI   2 switch model   3 switch provider
echo       4 dashboards   5 status         6 demo   7 doctor   9 install
echo.
echo    Models (current):  claude-opus-4-8 . claude-sonnet-4-6 . claude-haiku-4-5
echo    Keys (env var):    ANTHROPIC_API_KEY . OPENAI_API_KEY . OPENROUTER_API_KEY
echo    =====================================================================
echo.
goto :eof

rem ===========================================================================
rem  Pick a free GUI port. Prefer the default 5319; if it's already held (a separate
rem  installed LUCID app, or a stale server), roll a random high port in the dynamic
rem  range (49152-65151) until a free one is found. We NEVER kill the holding process.
:pickport
set "GUIPORT=5319"
call :portfree 5319 && goto :eof
echo    Port 5319 is already in use ^(another LUCID app?^) - selecting a free port instead...
set /a _pp=0
:pp_roll
set /a _pp+=1
set /a GUIPORT=49152 + ^(!RANDOM! %% 16000^)
call :portfree !GUIPORT! && goto :pp_done
if !_pp! lss 50 goto :pp_roll
echo    ^(could not find a free port after 50 tries - trying !GUIPORT! anyway^)
:pp_done
echo    GUI port: !GUIPORT!
goto :eof

rem  Port-free test. Sets errorlevel 0 if the port is FREE, 1 if in use in ANY TCP state
rem  (so we never lose a bind race). The ":<port> " match (colon prefix + trailing space)
rem  avoids false hits on longer ports (:53190) and on a bare PID column.
:portfree
netstat -ano | findstr /c:":%~1 " >nul 2>&1
if errorlevel 1 ( exit /b 0 )
exit /b 1

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
