# Agent Firewall — connecting LUCID to remote ACP agents (Hermes / OpenClaw)

> Increment **P-AGENTFW.1** · design **ADR-0147** (`DECISIONS.md`) · issue **#198**

LUCID can drive remote agent runtimes that speak the **Agent Client Protocol (ACP)** — such as
[Hermes Agent](#setting-up-hermes-agent) and [OpenClaw](#setting-up-openclaw) — through a first-party
**Agent Firewall**: a Model Context Protocol (MCP) server that proxies to the remote agent and runs every
message crossing the boundary through LUCID's existing security stack, in **both** directions, **fail-closed**.

You get the remote agent's capabilities inside LUCID **without** splicing its (large) attack surface —
prompt-injection in its output, exfiltration of what you send it, its permission escalations — straight into
your session.

---

## 1. How it works

```
LUCID (omp)  ──MCP (stdio)──▶  [ Agent Firewall ]  ──ACP client (stdio)──▶  remote hermes / openclaw
                                 scan ⇄ gate ⇄ label
```

- **To LUCID**, the firewall is an ordinary stdio **MCP server** exposing one tool, `prompt`. omp connects to
  it through the standard `session/new.mcpServers` seam (P-MCP.1) — no new transport.
- **To the remote**, the firewall is an **ACP client**: it spawns the remote's `… acp` command over stdio,
  runs the ACP handshake with **least privilege** (it offers the remote *no* client filesystem), and drives
  `session/new` → `session/prompt`.
- The firewall process is spawned per connection as `lucid agent-firewall --conn <id>` and stays long-lived.

### The bidirectional gate

Both directions go through the same fail-closed scanner gate (`scanAndDecide`). **Any** scan failure — dead
sidecar, timeout, malformed result — is treated as **block**, never "safe".

| Direction | What is scanned | Verdict |
|---|---|---|
| **Outbound** (LUCID → remote) | the prompt LUCID sends | a hidden-vector payload (bidi / zero-width / homoglyph / PUA) LUCID was coerced into relaying is **blocked and never sent**. *This is injection-relay protection via the Unicode scanner — NOT secret/PII DLP.* |
| **Inbound** (remote → LUCID) | the remote's reply + tool activity | **quarantine → the reply is WITHHELD** (LUCID's model never sees the poison); clean/suspicious → wrapped in `UNTRUSTED_CONTENT_START/END`, trust-labeled `untrusted`/`suspicious` (**never `trusted`**), and returned as the tool result. |

Additional guarantees:

- **Delimiter-injection breakout is closed.** A hostile remote embedding a literal `UNTRUSTED_CONTENT_END`
  to escape the envelope is neutralized (`neutralizeDelimiters`) before wrapping.
- **The remote's permission asks are denied.** If the remote sends `session/request_permission` (to run one
  of *its* privileged tools), the firewall denies it — LUCID is not a confused deputy for the remote's exec.
- **omp's in-process `tool_call` gate is unchanged** and remains the load-bearing backstop for any action the
  model attempts (invariant #4).

> **Scope note (ADR-0147).** This closes the "scan + delimit MCP output" guardrail *at the firewall boundary*
> for hermes/openclaw. The equivalent in-process gate for **all** MCP servers (the ADR-0020 gap) is tracked
> separately as P-MCP-GATE.1.

---

## 2. Registering a connection

Connections live in **`~/.omp/lucid-agents.json`** (created mode **0600** — never world-readable, git-ignored).
Each entry describes how to spawn the remote's ACP server:

```jsonc
{
  "agents": [
    {
      "id": "hermes-local",           // stable id; used by `lucid agent-firewall --conn <id>`
      "name": "Hermes (local)",       // display name (appears in the tool description)
      "kind": "hermes",               // "hermes" | "openclaw" | "acp" (label only)
      "command": "uvx",               // executable that speaks ACP over stdio
      "args": ["--from", "hermes-agent[acp]", "hermes-acp"],
      "enabled": true
    }
  ]
}
```

Fields: `id`, `name`, `kind`, `command`, `args`, optional `cwd`, optional `env` (a map — **never put a raw
secret here**; prefer a token *file*), optional `remoteUrl` (display/audit only), and `enabled`.

**Custody.** The registry stores commands/args, not secrets. For a token-authenticated remote (OpenClaw),
point the remote at its own token *file* (`--token-file`) so the secret never lands in this file. It is
plaintext-at-0600 (like `lucid-gui.json`), not OS `safeStorage`, because the omp-spawned firewall subprocess
cannot reach the Electron keychain oracle.

**How an enabled connection reaches the agent.** LUCID's desktop assembles enabled connections into the
`session/new.mcpServers` array (`remoteAgentMcpServers()` → `mcpServersForAcp()`), so each enabled entry
attaches to the live session as a `agentfw-<id>` MCP server. You can also run one standalone and point any
MCP client at it:

```bash
lucid agent-firewall --conn hermes-local      # serves the stdio MCP firewall for that connection
```

Paths in `args` are **not** shell-expanded (the firewall spawns without a shell) — use **absolute** paths
(no `~`).

---

## 3. Setting up Hermes Agent

Hermes ([NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)) exposes an ACP server via
`hermes acp` / `hermes-acp`. It runs the agent **locally**, so it only needs the ACP extra plus a configured
model provider.

### 3.1 Install with the ACP extra

The ACP server needs the `agent-client-protocol` Python dependency. A stock `brew`/`pipx` install of hermes
often ships **without** it (`hermes acp` then prints *"ACP dependencies not installed"* and exits). The
supported way to run it — the same one the Zed ACP registry uses — is via `uv`:

```bash
# one-off / no install: uv fetches hermes-agent + the [acp] extra into a cache and runs it
uvx --from 'hermes-agent[acp]' hermes-acp --version
```

Or, in a hermes checkout / virtualenv:

```bash
pip install -e '.[acp]'      # enables `hermes acp`, `hermes-acp`, `python -m acp_adapter`
```

### 3.2 Configure a model provider

Hermes reads `~/.hermes/.env` and `~/.hermes/config.yaml`. Configure a provider/model so prompts can be
answered:

```bash
hermes model                 # interactive provider/model setup
# or edit ~/.hermes/.env directly (API keys, base URLs, etc.)
```

A prompt will fail if the configured model endpoint is unreachable — the **handshake still succeeds**, so
connectivity is provable independently of the model (see [§5](#5-verifying-a-connection)).

### 3.3 The LUCID connection entry

```jsonc
{
  "id": "hermes-local",
  "name": "Hermes (local)",
  "kind": "hermes",
  "command": "uvx",
  "args": ["--from", "hermes-agent[acp]", "hermes-acp"],
  "enabled": true
}
```

If you installed the ACP extra system-wide, you can instead use `"command": "hermes", "args": ["acp"]`.

### 3.4 What hermes exposes

Its `hermes-acp` toolset is broad — `terminal`, `process`, `write_file`, `patch`, `execute_code`,
`delegate_task`, browser, vision. All of it runs **on the hermes host**, and every reply it streams back to
LUCID is scanned + delimited by the firewall.

---

## 4. Setting up OpenClaw

OpenClaw ([openclaw/openclaw](https://github.com/openclaw/openclaw)) is different: **`openclaw acp` is a
bridge**, not a standalone agent. It speaks ACP over stdio to LUCID and forwards to a running **OpenClaw
Gateway** over WebSocket. So you need a gateway *and* the bridge.

### 4.1 Install

```bash
npm install -g openclaw          # provides the `openclaw` CLI
openclaw --version
```

### 4.2 Run a Gateway

The bridge connects to a gateway (default `ws://127.0.0.1:18789`). Pick one:

**Local dev gateway (quick test, no auth):**

```bash
openclaw gateway run --dev --auth none --bind loopback --port 18789
# --dev creates ~/.openclaw/openclaw.json + a dev workspace; runs in the foreground
```

**Production-style gateway (token auth):**

```bash
openclaw gateway run --auth token --token "$OPENCLAW_GATEWAY_TOKEN" --bind loopback --port 18789
# or run it as a managed service:  openclaw gateway start
```

Configure a model/provider in `~/.openclaw/openclaw.json` (or via `openclaw config set …`) so the gateway's
agent can actually answer — otherwise, as with hermes, the handshake works but a prompt returns no text.

### 4.3 The LUCID connection entry

Point the bridge at the gateway. Prefer a **token file** so no secret enters the registry, and use an
**absolute** path:

```jsonc
{
  "id": "openclaw-gw",
  "name": "OpenClaw gateway",
  "kind": "openclaw",
  "command": "openclaw",
  "args": ["acp", "--url", "wss://gateway-host:18789", "--token-file", "/Users/you/.openclaw/gateway.token"],
  "remoteUrl": "wss://gateway-host:18789",
  "env": { "OPENCLAW_HIDE_BANNER": "1", "OPENCLAW_SUPPRESS_NOTES": "1" },
  "enabled": true
}
```

For a local no-auth dev gateway on the default port, `"args": ["acp"]` is enough.

### 4.4 OpenClaw specifics you should know

- **It needs the gateway first.** With no reachable gateway, `openclaw acp` exits with
  `ECONNREFUSED …:18789` *before* the ACP handshake. Start the gateway, then connect.
- **Per-session `mcpServers` are rejected — but an empty array is required.** OpenClaw's bridge rejects a
  *non-empty* `session/new.mcpServers`, yet its check early-returns on an **empty** array. LUCID always sends
  `mcpServers: []` (least privilege — the remote gets none of LUCID's tools), which OpenClaw accepts. Do not
  expect to hand OpenClaw MCP servers through LUCID; configure those on the gateway instead.
- **Auth resolution.** `--url`/`--token`/`--token-file` on the bridge take precedence over
  `gateway.remote.*` config. Prefer file/env (`OPENCLAW_GATEWAY_TOKEN`) over `--token` (visible in process
  listings).

---

## 5. Verifying a connection

**Offline, deterministic (no remote needed)** — the firewall's security behavior against a faithful ACP
stand-in, plus the fail-closed / quarantine / breakout proofs:

```bash
make demo-P-AGENTFW.1          # clean→delimited, poison→withheld, breakout→neutralized,
                               # outbound-relay→blocked, dead-scanner→fail-closed
bun test harness/mcp           # 18 unit + integration tests over a real subprocess boundary
```

**Live handshake against the real binaries** (gated, off by default so CI stays hermetic):

```bash
# Hermes (self-contained; uv fetches the acp extra)
LUCID_LIVE_HERMES=1 bun test harness/mcp/agent_firewall.integration.test.ts

# OpenClaw (needs a running gateway — e.g. `openclaw gateway run --dev --auth none --port 18789`)
LUCID_LIVE_OPENCLAW=1 bun test harness/mcp/agent_firewall.integration.test.ts
# point at a remote gateway with:  OPENCLAW_ACP_ARGS="--url wss://host:18789 --token-file /abs/path"
```

Each live test asserts only the **handshake** (a session id) — a full prompt depends on the remote's own
model being reachable.

---

## 6. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| hermes: `ACP dependencies not installed` | Install the ACP extra — use `uvx --from 'hermes-agent[acp]' hermes-acp` or `pip install -e '.[acp]'`. |
| hermes prompt returns an API/connection error | The transport is fine; hermes's configured model endpoint is unreachable. Run `hermes model` / fix `~/.hermes/.env`. |
| openclaw: `ACP bridge failed: connect ECONNREFUSED …:18789` | No gateway running. Start one (`openclaw gateway run …`) or fix `--url`. |
| openclaw: session/new rejected re: mcpServers | You (or a non-LUCID client) sent a non-empty `mcpServers`. LUCID sends `[]`, which is accepted. |
| Every call returns `[BLOCKED … fail-closed: scan unavailable]` | The Python scanner sidecar isn't reachable. This is by design (invariant #3) — fix the sidecar/venv; the firewall never fails open. |
| A reply comes back `[QUARANTINED …]` / `WITHHELD` | The remote's output tripped the scanner (hidden Unicode vector). That is the firewall doing its job; the raw output is intentionally not shown. |
| Connection isn't attached in the desktop | Confirm the entry is `enabled` and that `bin/lucid` exists (built by the desktop packaging / `make compile-lucid`); omp spawns it as the MCP command. |

---

## 7. References

- "ACP Editor Integration." *Hermes Agent Documentation*, NousResearch, 2026,
  github.com/NousResearch/hermes-agent. Accessed 4 July 2026. — Hermes's `hermes acp` server, the `[acp]`
  extra, and the `uvx` launch path.
- "ACP." *OpenClaw Documentation*, 2026, github.com/openclaw/openclaw. Accessed 4 July 2026. — OpenClaw's
  gateway-backed ACP bridge, session mapping, and the per-session `mcpServers` rejection.
- "Agent Client Protocol." *agentclientprotocol/agent-client-protocol*, 2026. — the `McpServer` transport
  union (stdio mandatory) and the `session/*` methods.
- "ADR-0147 — Agent Firewall MCP." *LucidAgentIDE DECISIONS.md*, 2026,
  github.com/mlcyclops/lucidagentide/blob/master/DECISIONS.md. Accessed 4 July 2026. — the design + security
  rationale this guide implements.
