# LucidAgentIDE with Microsoft Defender for Endpoint and Agent 365

For endpoint and security admins in Microsoft 365 E5/E7 or Agent 365 tenants. Decision records:
ADR-0384 (P-LEGIBLE.1) and ADR-0437 (P-LEGIBLE.2), issue #302. Microsoft sources were re-checked on
2026-10-04; the Learn pages they rest on are dated 2026-09-16.

## What Defender sees today

| Defender capability | Status for LucidAgentIDE | Why |
| --- | --- | --- |
| Local AI agent inventory (`AgentsInfo`, `Platform == "LocalAgents"`) | Not listed yet | Microsoft maintains the list of supported agents. There is no public registration API or manifest a vendor can use to enroll. |
| Entra Agent ID | Not used by the Defender inventory | Defender links a local agent to the signed-in OS user with a `used by` edge; `can authenticate as` is for cloud agents. Global Secure Access is different, see below. |
| Runtime protection, agent-native hooks | Not available | Defender inspects agents through each vendor's hook interface (user prompt, pre-tool call, post-tool response). LucidAgentIDE does not expose one to third parties yet. |
| Runtime protection, network inspection | Not effective | Microsoft lists one supported agent for it (OpenClaw). It also does not support certificate pinning or HTTP/3, and loopback traffic to local models never crosses the network. |
| Standard EDR telemetry (process, file, network) | Full | LucidAgentIDE runs as ordinary user-mode processes, like any other application. |

## Agent 365 registry, Shadow AI and Global Secure Access

**Shadow AI is a catalog, not a default.** The Shadow AI page in the Microsoft 365 admin center
(Frontier preview) detects seven named agents through Defender: OpenClaw, ChatGPT Desktop, Ollama
Desktop, Poe Desktop, Claw/ZeroClaw, OpenCode and Claude Desktop. It can block only OpenClaw, and only
on Intune-managed Windows devices. LucidAgentIDE is not in that catalog, so it is not listed as shadow
AI and not blocked by that feature. The block it can actually meet is ordinary application control
(App Control for Business/WDAC, AppLocker, Smart App Control) refusing an unsigned binary; allow it by
path or hash until the installers are signed.

**Registering it yourself (optional, admin side).** The Agent Registration API (Microsoft Graph beta)
creates an Agent 365 registry entry without an app package. It needs `AgentRegistration.ReadWrite.All`
and runs in the Global service only (not US Government L4 or L5). Nothing in Microsoft's documentation
links such an entry to the agents Defender detects on endpoints, so treat it as a record for your
governance process, not as enrollment:

```http
POST https://graph.microsoft.com/beta/copilot/agentRegistrations
Content-Type: application/json

{
  "displayName": "LucidAgentIDE",
  "description": "Local agentic IDE. Runs as the signed-in user; loopback-only control plane.",
  "createdBy": "<object ID of the admin or app creating the entry>",
  "ownerIds": ["<owner object ID>"],
  "originatingStore": "LucidAgentIDE",
  "sourceAgentId": "com.lucidagentide.desktop",
  "sourceCreatedDateTime": "2026-10-04T00:00:00Z",
  "sourceLastModifiedDateTime": "2026-10-04T00:00:00Z"
}
```

**Global Secure Access** (preview) labels each local agent it sees on the network as managed or
shadow by whether the agent is registered with Microsoft Entra Agent ID. It needs the GSA client with
TLS inspection on, and it sees internet-bound traffic only, so a fully local model is invisible to it.
Whether it identifies LucidAgentIDE's model traffic as an agent at all is not documented. A managed
label would need an agent identity your tenant provisions; the app cannot create one.

Sources: [Shadow AI](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-shadow-ai),
[Create agentRegistration](https://learn.microsoft.com/en-us/microsoft-365-copilot/extensibility/api/admin-settings/agent-registration/agentregistration-create),
[AI agent discovery in Global Secure Access](https://learn.microsoft.com/en-us/entra/global-secure-access/concept-ai-agent-discovery),
[Discover local AI agents](https://learn.microsoft.com/en-us/defender-endpoint/discover-local-ai-agents),
[AI agent runtime protection](https://learn.microsoft.com/en-us/defender-endpoint/ai-agent-runtime-protection-overview).

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
  not supported. The Agent Registration API is not available in US Government L4 or L5 either, so a
  GCC High or DoD tenant has nothing to integrate with.
- In audit or block mode, runtime-protection detections are sent to Defender XDR. A hook payload can
  include prompt and tool content, so an agent-native hook is a potential content egress path.
  Defender XDR's **Prompt evidence collection** (Settings > Security for AI) is on by default and
  attaches prompt snippets to alerts; Microsoft documents it for Security for AI alerts without saying
  whether local-agent alerts are covered.
- LucidAgentIDE exposes no agent-native hook, so Defender receives nothing beyond ordinary endpoint
  telemetry. The honest posture for a CUI tenant is "network inspection only", and since network
  inspection does not cover this app either, that means EDR telemetry (process, file, network) and no
  content inspection.
- The manifest is local, metadata-only, and never transmitted by the app. Whether to collect it into
  a cloud console is the admin's decision.

## Not yet done

Each item is a separate increment (ADR-0384):

1. A hook seam for user prompt, pre-tool call and post-tool response that works with the same
   contract peer CLIs use. It will be off by default under the AskSage lockdown and in CUI sessions,
   controlled by a managed tighten-only policy, with a metadata-only payload mode. It can add a block,
   never remove one, and it runs after the built-in gate.
2. Authenticode and Apple Developer ID signing. Defender's `trustedProcess` field depends on it, and
   it is what keeps application control from blocking the app.
3. Asking Microsoft to add LucidAgentIDE to the supported agent list.

These need a real tenant to confirm: whether discovery can use this manifest, how long XDR retains
hook payloads, whether Global Secure Access identifies the app's model traffic as an agent, and
whether an Agent Registration API entry is ever linked to Defender's endpoint detections.
