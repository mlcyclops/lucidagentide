# Agent Firewall — Testing & Verification (P-AGENTFW.1)

> Companion to `docs/AGENT-FIREWALL.md` · design **ADR-0147** · issue **#198**

This documents exactly what was tested to prove the agent-firewall works and is safe, and how to reproduce
each check. Verification runs at **three layers**, because a security boundary is only as trustworthy as the
adversarial cases you actually exercised:

1. **Unit** — the gate/MCP logic with injected dependencies (fast, deterministic).
2. **Integration** — the firewall driving a **real subprocess** over the actual ACP stdio transport (a
   faithful fake agent), so the wire path itself is exercised, not mocked.
3. **Live** — connecting to the **real `hermes` and `openclaw` binaries** (gated; off by default).

Headline results (this branch, post-merge with `origin/master`):

| Check | Result |
|---|---|
| `bun test harness/mcp` | **18 pass / 2 skip / 0 fail** (20 tests, 3 files) |
| Live hermes + openclaw handshakes (`LUCID_LIVE_HERMES=1 LUCID_LIVE_OPENCLAW=1`) | **8 pass / 0 fail** |
| `make demo-P-AGENTFW.1` | all 5 scenarios green |
| Full harness suite (`bun test harness`, excl. stale `desktop/release`) | **566 pass / 3 skip / 0 fail** (77 files) |
| `bun x tsc --noEmit` (root, merged tree) | clean (exit 0) |
| `tools/license_headers.ts --check` | all first-party files headered ✓ |

---

## 1. Unit tests

### `harness/mcp/registry.test.ts` (5) — the connection registry & custody

| Test | What it proves |
|---|---|
| upsert persists a normalized entry; list + get see it | round-trip of a `RemoteAgentEntry` through `~/.omp/lucid-agents.json` |
| upsert with the same id updates in place (no duplicate) | idempotent edit by id |
| setRemoteAgentEnabled toggles; removeRemoteAgent deletes | enable/remove lifecycle |
| remoteAgentMcpServers emits an McpServerStdio ONLY for enabled+command entries | the ACP `session/new.mcpServers` assembly shape (`agentfw-<id>` / `lucid agent-firewall --conn <id>`); disabled entries excluded |
| the registry file is written 0600 (never world-readable) | custody — the token-adjacent config can't leak to other users |

### `harness/mcp/agent_firewall.test.ts` (7) — the security keystones

| Test | What it proves |
|---|---|
| clean remote reply is returned as UNTRUSTED_CONTENT, labeled untrusted (never trusted) | inbound clean path: delimiting + trust label; **never `trusted`** (inv #7) |
| poisoned remote reply (hidden zero-width) is quarantined and WITHHELD | inbound quarantine **withholds** the poison — LUCID's model never sees it |
| outbound hidden vector is blocked BEFORE the remote is reached | outbound injection-relay block; the remote's `prompt()` is never called |
| **FAIL-CLOSED: a dead scanner blocks every call and never reaches the remote** | invariant #3 kill-sidecar keystone — scan-unavailable ⇒ block, both directions |
| delimiter-injection breakout is neutralized (exactly one real closing delimiter) | a hostile `UNTRUSTED_CONTENT_END` in the reply can't escape the envelope |
| onEvent surfaces the decision per direction | audit events fire with the right direction/blocked/trust label |
| MCP server: handshake, tools/list, tools/call, unknown tool, and stays long-lived | MCP protocol correctness + the long-lived (fork-loop-safe) property |

### Captured output

```
harness/mcp/agent_firewall.test.ts:
(pass) clean remote reply is returned as UNTRUSTED_CONTENT, labeled untrusted (never trusted)
(pass) poisoned remote reply (hidden zero-width) is quarantined and WITHHELD
(pass) outbound hidden vector is blocked BEFORE the remote is reached
(pass) FAIL-CLOSED: a dead scanner blocks every call and never reaches the remote
(pass) delimiter-injection breakout is neutralized (exactly one real closing delimiter)
(pass) onEvent surfaces the decision per direction
(pass) MCP server: handshake, tools/list, tools/call, unknown tool, and stays long-lived

harness/mcp/registry.test.ts:
(pass) upsert persists a normalized entry; list + get see it
(pass) upsert with the same id updates in place (no duplicate)
(pass) setRemoteAgentEnabled toggles; removeRemoteAgent deletes
(pass) remoteAgentMcpServers emits an McpServerStdio ONLY for enabled+command entries
(pass) the registry file is written 0600 (never world-readable)
```

Reproduce: `bun test harness/mcp/registry.test.ts harness/mcp/agent_firewall.test.ts`

---

## 2. Integration tests (real subprocess boundary)

`harness/mcp/agent_firewall.integration.test.ts` spawns a **real** child process — the faithful ACP
stand-in `harness/mcp/testing/fake_acp_agent.ts` — and drives it through the whole stack
(`McpStdioServer` → `AgentFirewall` → `AcpAgentClient` → child). This exercises the actual stdio JSON-RPC
transport, not an in-process mock. The fake agent's behavior is chosen per test via `FAKE_ACP_MODE`
(`clean` / `poison` / `breakout` / `permission`).

| Test | What it proves |
|---|---|
| handshake over real stdio: connect() returns the remote session id | `AcpAgentClient` completes initialize + session/new against a real process |
| clean reply round-trips as delimited UNTRUSTED_CONTENT (incl. scanned tool activity) | full stack, end to end, over a process boundary; remote tool activity is scanned + carried |
| poisoned remote reply is quarantined and WITHHELD across the process boundary | inbound quarantine holds over the real transport |
| a real remote embedding the closing delimiter is neutralized (no breakout) | breakout defense holds over the real transport |
| the remote's session/request_permission is DENIED over the real transport | the fake agent asks to exec; our client returns `cancelled`; the echoed outcome proves the deny |
| full MCP chain: tools/call → firewall → real subprocess → delimited result | omp's MCP path is faithfully served |
| *(gated)* live: real hermes acp handshake yields a session id | see §4 |
| *(gated)* live: real openclaw acp handshake (via a gateway) yields a session id | see §4 |

Reproduce: `bun test harness/mcp/agent_firewall.integration.test.ts`

---

## 3. Demo — `make demo-P-AGENTFW.1`

Runs the firewall with the **real scanner sidecar** and a fake remote, asserting all five load-bearing
properties, then exits non-zero on any failure.

```
1) clean remote reply
   ok — returned as UNTRUSTED_CONTENT, …
2) poisoned remote reply (hidden zero-width)
   ok — quarantined + withheld — Response from "hermes-demo" was WITHHELD by the Lucid agent-firewall (quarantined: 1 finding(s) …)
3) remote embeds the closing delimiter (breakout attempt)
   ok — embedded UNTRUSTED_CONTENT_END neutralized; envelope intact
4) outbound prompt carrying a hidden vector
   ok — blocked before relay — … Nothing was sent to "hermes-demo".
5) scanner sidecar killed → fail closed
   ok — fail-closed block — … (fail-closed: scan unavailable (scanner not running)) …
demo_pagentfw1 OK — the agent-firewall scans both directions, quarantines poison, neutralizes breakout, and fails closed.
```

---

## 4. Live verification against the real binaries

Gated behind env flags (off by default so CI stays hermetic). Each asserts the **handshake** — a full prompt
depends on the remote's own model being reachable, which is out of our control.

### 4.1 Hermes (self-contained)

`hermes acp` runs the agent locally; it only needs the `[acp]` extra (fetched by `uvx`) and a model config.

```bash
LUCID_LIVE_HERMES=1 bun test harness/mcp/agent_firewall.integration.test.ts
# → 7 pass / 1 skip / 0 fail   (the openclaw live case skips without a gateway)
```

Observed against **hermes-agent 0.18.0** (via `uvx --from 'hermes-agent[acp]' hermes-acp`), the real ACP
server logged our client's full round-trip:

```
acp_adapter.server: ACP client connected
acp_adapter.server: Initialize from unknown (protocol v1)
acp_adapter.session: Created ACP session 57649de9-…
acp_adapter.server: Prompt on session 57649de9-…: Reply with exactly: PONG
```

(A manual prompt round-trip also completed; the only error was hermes's own offline local model —
`gemma4:31b-nvfp4` at an unreachable endpoint — proving our transport, not the model, is what's exercised.)

### 4.2 OpenClaw (gateway bridge)

`openclaw acp` is a **bridge** — it needs a running OpenClaw Gateway. Start one, then run the gated test:

```bash
openclaw gateway run --dev --auth none --bind loopback --port 18789 --force   # in another shell
LUCID_LIVE_OPENCLAW=1 bun test harness/mcp/agent_firewall.integration.test.ts
# → 7 pass / 1 skip / 0 fail   (the hermes live case skips this run)
# for a remote gateway:  OPENCLAW_ACP_ARGS="--url wss://host:18789 --token-file /abs/path"
```

Observed against **openclaw 2026.6.11**: `AcpAgentClient.connect()` returned a real gateway session id
(e.g. `817b141e-…`), and a full `handlePrompt` wrapped the reply as `UNTRUSTED_CONTENT` with
`trust="untrusted"`. This also confirmed the compatibility detail that our `session/new.mcpServers: []` is
**accepted** (OpenClaw's bridge rejects a *non-empty* array but early-returns on an empty one).

### 4.3 Both together

```bash
LUCID_LIVE_HERMES=1 LUCID_LIVE_OPENCLAW=1 bun test harness/mcp/agent_firewall.integration.test.ts
# → 8 pass / 0 fail
```

---

## 5. Static analysis & whole-suite

```bash
bun x tsc --noEmit          # root: clean (exit 0), including the merge with origin/master
bun run tools/license_headers.ts --check   # all first-party source carries the BUSL-1.1 header ✓
bun test "$PWD/harness"     # full harness suite: 566 pass / 3 skip / 0 fail (77 files)
```

> The absolute-path form of the suite command excludes stale packaged copies under the git-ignored
> `desktop/release/**` (which fail with their own module-resolution errors, unrelated to this work — the
> baseline has them too). A bare `bun test harness` also traverses those copies.

---

## 6. What is deliberately NOT claimed

- **Outbound is injection-relay protection, not DLP.** The scanner detects hidden Unicode vectors
  (zero-width / bidi / homoglyph / PUA), **not** secrets or plaintext exfil — LUCID has no secret detector.
  No test asserts secret-exfil blocking, because the scanner cannot do it.
- **A full live prompt** depends on the remote's configured model being reachable; the live tests assert the
  handshake (the part we own), not model output.
- **The general in-process `tool_result` gate** for *all* MCP servers (the ADR-0020 gap) is out of scope
  here and tracked as P-MCP-GATE.1; this feature closes the guardrail at the firewall boundary only.
