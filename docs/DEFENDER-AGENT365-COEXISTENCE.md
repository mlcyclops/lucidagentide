# LucidAgentIDE with Microsoft Defender for Endpoint and Agent 365

For endpoint and security admins in Microsoft 365 E5/E7 or Agent 365 tenants. Decision record:
ADR-0384 (P-LEGIBLE.1, issue #302).

## What Defender sees today

| Defender capability | Status for LucidAgentIDE | Why |
| --- | --- | --- |
| Local AI agent inventory (`AgentsInfo`, `Platform == "LocalAgents"`) | Not listed yet | Microsoft maintains the list of supported agents. There is no public registration API or manifest a vendor can use to enroll. |
| Entra Agent ID | Does not apply | Local agents run as the signed-in OS user. Defender links them to that user with a `used by` edge. Agent ID covers cloud agents only. |
| Runtime protection, agent-native hooks | Not available | Defender inspects agents through each vendor's hook interface (user prompt, pre-tool call, post-tool response). LucidAgentIDE does not expose one to third parties yet. |
| Runtime protection, network inspection | Not effective | Model traffic is TLS from the agent runtime, or loopback-only for local models. Network inspection does not support certificate pinning, HTTP/3 or loopback flows. |
| Standard EDR telemetry (process, file, network) | Full | LucidAgentIDE runs as ordinary user-mode processes, like any other application. |

## The local-agent manifest

**What this file is, and is not.** Microsoft publishes no vendor-writable manifest format and no
enrollment API for local agents, and nothing in Microsoft's documentation says Defender reads this
file. It is an advisory file defined by LucidAgentIDE (schema `lucid.local-agent-manifest/1`) for
admins to collect with their own tooling. Writing it does not make the app appear in Defender's
local agent inventory.

Each launch of the desktop app writes a metadata-only identity file to its Electron user data
directory. The standard build never renames itself, so Electron names that directory after the
package name, `lucidagentide-desktop` (the same folder that holds `engine.log`):

| OS | Path |
| --- | --- |
| Windows | `%APPDATA%\lucidagentide-desktop\local-agent-manifest.json` |
| macOS | `~/Library/Application Support/lucidagentide-desktop/local-agent-manifest.json` |
| Linux | `~/.config/lucidagentide-desktop/local-agent-manifest.json` |

An instance started on a non-default port (a `LUCID_PORT` other than the build's default, 5319 for
the standard build and 5320 for Creator) uses
`lucidagentide-desktop-<port>` instead. The Creator build renames itself to its product name, so it
uses `LucidCreator` (and `LucidCreator-<port>`) in the same locations.

The field names borrow the vocabulary of the profile Defender builds for the agents it supports
(`RawAgentInfo.localAgentMetadata`). Only the names are shared; the format is ours:

```json
{
  "schema": "lucid.local-agent-manifest/1",
  "name": "Lucid Agent",
  "agentType": "agentic-ide",
  "version": "2.3.0-beta.7",
  "vendor": "TechLead 187 LLC",
  "appId": "com.lucidagentide.desktop",
  "productName": "LucidAgentIDE",
  "relatedProcess": "LucidAgentIDE.exe",
  "processes": ["LucidAgentIDE.exe", "lucid-engine.exe"],
  "autoApprove": "true",
  "mcpServers": [{ "name": "jira", "type": "http", "endpoint": "https://mcp.example.com" }],
  "localMcps": [{ "name": "agentfw-1a2b", "transportType": "stdio", "commandName": "lucid.exe" }],
  "controlPlane": { "bind": "127.0.0.1", "port": 5319, "auth": "per-launch capability token (ADR-0024)" },
  "runtimeProtection": { "agentNativeHooks": "none", "networkInspection": "not-effective" },
  "content": "metadata-only",
  "generatedAt": "2026-09-23T00:00:00.000Z"
}
```

What it never contains: prompts, tool arguments or output, file content, credentials, MCP headers,
MCP arguments or environment, or any URL path or query string. Remote MCP servers are reduced to
their origin (`scheme://host:port`). Local MCP servers are reduced to the executable name.

`autoApprove` is `"true"` because Agent mode answers the runtime's per-tool prompts itself. Every
tool call still passes the in-process fail-closed security gate, and the exec and egress tier
prompts still apply. Enterprise policy can cap those tiers (managed config, ADR-0068).

### Lifecycle: a manifest alone does not prove an install

The file is rewritten at every launch (`generatedAt`), so an MCP change shows up at the next start.
User data survives an uninstall on purpose (settings, logs, keys), so the file needs its own cleanup:

- **Windows installer (NSIS):** uninstalling deletes `local-agent-manifest.json` (and any leftover
  `local-agent-manifest.json.<pid>.tmp`) from the user data directories above, including the
  `-<port>` ones, and nothing else. An auto-update does not delete it. The uninstaller runs as one
  user, so another Windows account's copy stays behind.
- **Portable Windows build, macOS, Linux:** there is no uninstall hook, so the file stays after the
  app is deleted.

So a detection check must confirm the executable is still installed, not just that the file exists.

### Collecting it

Intune remediation (detection script), run in the user context with **Run script in 64-bit
PowerShell** set to Yes. It reads the install location from the installer's own uninstall entry
(`Uninstall LucidAgentIDE.exe`, which the uninstaller removes), confirms `LucidAgentIDE.exe` is there,
and only then reports the manifest:

```powershell
$manifest = Join-Path $env:APPDATA 'lucidagentide-desktop\local-agent-manifest.json'
$uninstallKeys = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
                 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
$exe = Get-ItemProperty -Path $uninstallKeys -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.UninstallString -match '^"(.+)\\Uninstall LucidAgentIDE\.exe"') { Join-Path $Matches[1] 'LucidAgentIDE.exe' }
} | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($exe -and (Test-Path -LiteralPath $manifest)) { Get-Content -LiteralPath $manifest -Raw; exit 0 }
exit 1
```

Defender live response, checking the executable before trusting the file (the default per-user
install location is shown; a per-machine install uses `C:\Program Files\LucidAgentIDE`, and the user
can choose another folder):

```text
dir "C:\Users\<user>\AppData\Local\Programs\LucidAgentIDE\LucidAgentIDE.exe"
getfile "C:\Users\<user>\AppData\Roaming\lucidagentide-desktop\local-agent-manifest.json"
```

On macOS, pair the file with `/Applications/LucidAgentIDE.app`; for the Linux deb and rpm packages,
with `/opt/LucidAgentIDE`. An AppImage has no install location, so treat a manifest whose
`generatedAt` is older than your inventory window as stale.

### Finding installs with advanced hunting

Until Defender lists the agent natively, hunt its processes:

```kusto
DeviceProcessEvents
| where FileName in~ ("LucidAgentIDE.exe", "lucid-engine.exe")
| summarize LastSeen = max(Timestamp), Devices = dcount(DeviceId), Accounts = make_set(AccountName, 50)
    by FileName, FolderPath
```

## Government and CUI deployments

- Defender local-agent discovery requires the commercial cloud. Sovereign and national clouds are
  not supported.
- In audit or block mode, runtime-protection detections are sent to Defender XDR. A hook payload can
  include prompt and tool content, so an agent-native hook is a potential content egress path.
- LucidAgentIDE exposes no agent-native hook, so Defender receives nothing beyond ordinary endpoint
  telemetry. The honest posture for a CUI tenant is "network inspection only", which for this app
  means discovery-grade visibility and no content inspection.
- The manifest is local, metadata-only, and never transmitted by the app. Whether to collect it into
  a cloud console is the admin's decision.

## Not yet done

Each item is a separate increment (ADR-0384):

1. A hook seam for user prompt, pre-tool call and post-tool response that works with the same
   contract peer CLIs use. It will be off by default under the AskSage lockdown and in CUI sessions,
   controlled by a managed tighten-only policy, with a metadata-only payload mode. It can add a block,
   never remove one, and it runs after the built-in gate.
2. Authenticode and Apple Developer ID signing. Defender's `trustedProcess` field depends on it.
3. Asking Microsoft to add LucidAgentIDE to the supported agent list.

These need a real tenant to confirm: whether discovery can use this manifest, how long XDR retains
hook payloads, and whether the Agent 365 Registry accepts a local agent without an M365 app package.
