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

Each launch, the app writes a metadata-only identity file to its user data directory:

| OS | Path |
| --- | --- |
| Windows | `%APPDATA%\LucidAgentIDE\local-agent-manifest.json` |
| macOS | `~/Library/Application Support/LucidAgentIDE/local-agent-manifest.json` |
| Linux | `~/.config/LucidAgentIDE/local-agent-manifest.json` |

An instance started on a non-default port uses `LucidAgentIDE-<port>` instead. The Creator build uses
`LucidCreator`.

The fields follow the names Defender uses in `RawAgentInfo.localAgentMetadata`:

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

### Collecting it

Intune remediation (detection script), run in the user context:

```powershell
$m = Join-Path $env:APPDATA 'LucidAgentIDE\local-agent-manifest.json'
if (Test-Path $m) { Get-Content $m -Raw; exit 0 } else { exit 1 }
```

Defender live response: `getfile "C:\Users\<user>\AppData\Roaming\LucidAgentIDE\local-agent-manifest.json"`.

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
