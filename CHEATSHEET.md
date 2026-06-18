# LucidAgentIDE — cheatsheet

## Start it (the easy way)

**Double-click `LucidAgentIDE.bat`.** It checks dependencies + PATH + provider
keys, lets you pick a model, launches omp with the security gate in its own
window, and stays open as a control panel to switch model/provider, view
dashboards, and check status.

```
LucidAgentIDE.bat            # interactive control panel
LucidAgentIDE.bat doctor     # just run the dependency check
LucidAgentIDE.bat dashboard  # just render the security dashboard
```

On a fresh machine, pick **9) Setup / install missing dependencies** — it
installs bun, uv, omp, and the project deps (only what's missing). Every block
the gate makes in omp is logged to `agent_obs.duckdb`, so the dashboard fills in
with real findings as you use it (demo data until the first block).

## Inside omp (the agent window)

| You type | What happens |
| --- | --- |
| `/lucid:help` | quickstart for the security harness + commands |
| `/lucid:scan <text>` | scan text for hidden-Unicode prompt injection; the agent reads the findings |
| `/lucid:dashboard` | show the security dashboard in the TUI |
| `!bun run dashboard:tui` | instant dashboard, no agent turn |
| `!bun run demo-P2.4` | live demo: a poisoned tool call is blocked |
| `!bun test harness` | run the test suite |
| `Ctrl+P` | cycle models · `/usage` token usage · `?` shortcuts |

The gate is always on (`-e harness/omp/security_extension.ts`): every tool call
is scanned, and quarantined content is blocked fail-closed.

## Switching model / provider

In the control-panel window: **2** switch model, **3** switch provider, **1**
relaunch omp. Or relaunch omp directly:

```powershell
omp --model claude-opus-4-8   -e harness/omp/security_extension.ts   # most capable
omp --model claude-sonnet-4-6 -e harness/omp/security_extension.ts   # balanced
omp --model claude-haiku-4-5  -e harness/omp/security_extension.ts   # fast/cheap
```

Use the **full model id** (e.g. `claude-sonnet-4-6`), not the bare alias
`sonnet` — the alias can resolve to a retired id and 404.

## Auth — two ways, both detected

**OAuth login (Claude Pro/Max, ChatGPT, etc.)** — run `omp` once and use its
`/login`. omp stores the credential in its vault (`~/.omp/agent/agent.db`); no env
var needed. The launcher reads the vault and shows e.g. `[ OK ] anthropic (OAuth
login)`, so it won't nag for a key you don't have. Check it any time:

```bash
bun run tools/omp_auth_status.ts        # which providers you're logged into
```

**API key (environment variable)** — the alternative if you're not using OAuth:

| Provider | Env var |
| --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."      # this session
setx ANTHROPIC_API_KEY "sk-ant-..."         # persist (new terminals)
```

## Current Anthropic models

`claude-opus-4-8` (most capable) · `claude-sonnet-4-6` (balanced) ·
`claude-haiku-4-5` (fast/cheap).
