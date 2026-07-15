@echo off
setlocal EnableExtensions
title LUCID Agent - clear OAuth provider logins

REM ---------------------------------------------------------------------------
REM  Clears ALL OAuth provider logins from LUCID Agent / omp on THIS machine.
REM
REM  omp stores logins in ~/.omp/agent/agent.db (table auth_credentials). That
REM  file lives in your home folder, so uninstalling/reinstalling LUCID never
REM  removes it - which is why "Disconnect" alone didn't clear them. This deletes
REM  every credential_type='oauth' row (Anthropic, OpenAI, xAI, Google, Perplexity,
REM  GitHub Copilot, plus any stale/orphaned ones). Your API keys are NOT touched.
REM
REM  Save this file as clear-lucid-oauth-logins.bat and double-click it, or run it
REM  from a Command Prompt. No admin rights needed.
REM ---------------------------------------------------------------------------

set "DB=%USERPROFILE%\.omp\agent\agent.db"

echo(
echo   LUCID Agent - clear ALL OAuth provider logins
echo   =============================================
echo   Deletes every saved OAuth login from omp's credential store.
echo   Your API keys are NOT affected.
echo(
echo   Database: %DB%
echo(

if not exist "%DB%" (
  echo   No credential database found - nothing to clear.
  echo   ^(Either LUCID Agent isn't installed for this user, or you've
  echo    never signed in to a provider on this machine.^)
  echo(
  pause
  exit /b 0
)

echo   IMPORTANT: fully close LUCID Agent first, or the database may be locked.
echo(
set "CONFIRM="
set /p "CONFIRM=  Type YES and press Enter to wipe all OAuth logins: "
if /I not "%CONFIRM%"=="YES" (
  echo(
  echo   Cancelled - nothing was changed.
  echo(
  pause
  exit /b 0
)

REM --- write a tiny, stdlib-only Python cleaner (flat: no indentation needed) ---
set "PYS=%TEMP%\lucid_clear_oauth.py"
break> "%PYS%"
>>"%PYS%" echo import sqlite3, sys
>>"%PYS%" echo c = sqlite3.connect(sys.argv[1], timeout=8)
>>"%PYS%" echo names = ", ".join(x[0] for x in c.execute("select provider from auth_credentials where credential_type='oauth'"))
>>"%PYS%" echo n = c.execute("delete from auth_credentials where credential_type='oauth'").rowcount
>>"%PYS%" echo c.commit(); c.close()
>>"%PYS%" echo print("Removed", n, "OAuth login(s):", names if names else "(none)")

REM --- find a Python: LUCID's own scanner interpreter first, then a system one ---
set "PYEXE="
for %%P in (
  "%APPDATA%\LucidAgentIDE\runtimes\scanner-venv\Scripts\python.exe"
  "%LOCALAPPDATA%\Programs\LucidAgentIDE\resources\runtimes\python-win32-x64\python.exe"
  "%PROGRAMFILES%\LucidAgentIDE\resources\runtimes\python-win32-x64\python.exe"
) do if not defined PYEXE if exist "%%~P" set "PYEXE=%%~P"
if not defined PYEXE for %%C in (python.exe py.exe) do if not defined PYEXE where %%C >nul 2>&1 && set "PYEXE=%%C"

if not defined PYEXE (
  echo(
  echo   Couldn't find a Python interpreter to run the cleanup.
  echo   Open LUCID Agent once ^(it provisions one on first launch^) and
  echo   re-run this, or install Python from python.org and try again.
  del "%PYS%" >nul 2>&1
  echo(
  pause
  exit /b 1
)

echo(
echo   Using: %PYEXE%
"%PYEXE%" "%PYS%" "%DB%"
set "RC=%ERRORLEVEL%"
del "%PYS%" >nul 2>&1

echo(
if not "%RC%"=="0" (
  echo   FAILED ^(exit %RC%^). The database is most likely LOCKED - make sure
  echo   LUCID Agent is FULLY closed ^(check the system tray^), then run this again.
) else (
  echo   Done. Restart LUCID Agent - the Providers list will show them cleared.
)
echo(
pause
exit /b %RC%
