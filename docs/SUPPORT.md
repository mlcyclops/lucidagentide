# Getting help with LUCID

Check the **[open bug list](https://github.com/mlcyclops/lucidagentide/issues?q=is%3Aissue+is%3Aopen+label%3Abug)** first. If your bug is already there, add a comment with your details.

> **Issues are public.** Never paste an API key, token, password, or anything under CUI into an issue, a screenshot, or a log you attach.

## Report a bug

**[Open a new issue](https://github.com/mlcyclops/lucidagentide/issues/new?template=bug_report.yml)** (the form asks for each of these) and include:

1. **Version and machine:** the LUCID version from the **About** button at the bottom of the left rail, your OS and version, and the model and provider you were using.
2. **What happened:** the steps, what you expected, and what you got instead.
3. **Screenshots:** capture the whole window if you can (Windows `Win+Shift+S`, macOS `Cmd+Shift+4` then `Space` to pick a window, Linux `PrtSc`) and paste straight into the issue box. For a sandbox or security problem, include the **Security** panel's **Runtime sandbox** section. For a tool call that was blocked or prompted unexpectedly, turn on **Settings > Developer > Developer mode** and include the **Logs** panel's *Exec / egress gate decisions* section.
4. **Logs:** a support bundle or log files, as described below.

## Known issues

- **Windows: turn the sandbox on.** Do it from **Security > Runtime sandbox**; it asks for administrator approval once if Windows needs it. If the panel stays on **disclosed** instead of **isolated**, it says in one line exactly what is missing. When that line asks for host prep, press **Prepare host** under it; the prep survives a restart. If it still shows **disclosed** after that, the contained runtime failed its boot check and LUCID fell back safely. Send a screenshot of the Runtime sandbox section plus the support zip below.
- **Judgments start off.** Settings > Judgment defaults to **None**. Opt in to Jev (paste a TypeSafe key) or to your own models there.

## How to pull your logs

**Windows: one command, redacted zip.** Open **PowerShell** (Start, type *PowerShell*) and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Programs\LucidAgentIDE\resources\repo\tools\collect-support-logs.ps1"
```

This writes `lucid-support-<date>-<time>.zip` to your Desktop. It collects the engine log, the agent runtime logs from the last 7 days (add `-Days 14` for more), metadata-only telemetry tails, a redacted settings summary, and a system report (OS, versions, and which process owns port 5319). Keys, tokens and passwords are redacted, and the credential vaults are never read. It **does** include your sign-in email, your folder paths, and the last four characters of each configured key, so open the zip and remove anything you would not post publicly. If the script is not at that path, download it and run it from there:

```powershell
irm https://raw.githubusercontent.com/mlcyclops/lucidagentide/master/tools/collect-support-logs.ps1 -OutFile "$env:TEMP\collect-support-logs.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\collect-support-logs.ps1"
```

**macOS and Linux: attach the log files.** There is no collector script yet, so zip these by hand:

| Log | What it shows | macOS | Linux |
| :-- | :-- | :-- | :-- |
| Engine log | startup, crashes, port and sandbox errors | `~/Library/Application Support/lucidagentide-desktop/engine.log` | `~/.config/lucidagentide-desktop/engine.log` |
| Runtime stderr | why an agent process exited | `~/.omp/lucid-acp.log` | `~/.omp/lucid-acp.log` |
| Runtime daily logs | provider errors, HTTP status, model id | newest one or two `~/.omp/logs/omp.<date>.<pid>.log` | same |

```bash
# macOS
cd ~ && zip -j ~/Desktop/lucid-logs.zip "Library/Application Support/lucidagentide-desktop/engine.log" .omp/lucid-acp.log $(ls -t .omp/logs/omp.*.log | head -2)
# Linux
cd ~ && tar czf ~/lucid-logs.tar.gz .config/lucidagentide-desktop/engine.log .omp/lucid-acp.log $(ls -t .omp/logs/omp.*.log | head -2)
```

These files are **not** redacted. Search them for `sk-`, `Bearer`, `token` and `key` before you attach them. On Windows the same files live at `%APPDATA%\lucidagentide-desktop\engine.log` and `%USERPROFILE%\.omp\`, and an instance started on a non-default port writes to `lucidagentide-desktop-<port>` instead.

**Never attach these:** `~/.omp/lucid-gui.json` (holds provider keys in plain text), `~/.omp/agent/agent.db` and `~/.omp/lucid-cred-vault/` (your credential vaults), or anything under `~/.omp/logs/http-400-requests/` (a full copy of the rejected request, including your prompt and file contents).
