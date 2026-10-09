<!-- Copyright (c) 2026 TechLead 187 LLC -->
<!-- SPDX-License-Identifier: BUSL-1.1 -->

# PDR: P-CTRL-RO.1 - read-only MCP introspection seam (Phase 1)

Implements ADR-0447. Phase 1 only: read-only introspection for an external MCP orchestrator
(for example Claude via Dispatch). No state-changing command ships in this PDR.

## Preconditions
- ADR-0438 (P-CTRL.2) is merged to master, or this work branches off `feat/p-ctrl.2-policy-core`.
  It supplies the controller token scope, the pairing store, and the `lanes`/`status`/`result`
  reads this seam narrows and exposes.
- Baseline green: `make test && make demo-P-CTRL.2` before touching anything (AGENTS.md ritual).
- Branch off master (not the stale `release/v2.4.0-beta.1`). One increment per session.

## Subtasks (each is its own session + demo)

### (a) MCP server scaffold + loopback/bearer/fail-closed transport  [P-CTRL-RO.1c]
- Reuse `McpStdioServer` (`harness/mcp/mcp_server.ts`). Add `lucid mcp-serve --read-only`
  registering exactly three tools.
- Attach to the engine via `engine-discovery-<port>.json` (port + nonce only), win the ADR-0305
  handshake; read `LUCID_CONTROLLER_TOKEN` from env; send it in the `x-lucid-token` header only.
- Fail-closed: no engine / bad handshake / revoked token / a write tool requested all return an
  MCP `isError` naming the cause. Never spawn an engine, never fall back to another credential.
- Exit: scripted stdio MCP client lists tools and gets the three; `tools/call` on a would-be write
  name is refused at the server before any HTTP.

### (b) The three read-only tool handlers wired to fleet state  [P-CTRL-RO.1b, engine side]
- `fleet.list_agents` -> `/api/controller/lanes` (pairing-owned lanes; id, label, status, created).
- `agent.get_status` -> `/api/controller/status` (owned lane state + pending ask KIND only).
- `fleet.tail_logs` -> new read route projecting `desktop/fleet_lanes.ts` state: status transitions,
  tool-trail metadata (name, risk tier, path, allow/block), assistant text since `sinceSeq`.
  Redaction is a pure, tested projector: NO file contents, prompt/assignment text, secrets, vault,
  env, or UNTRUSTED_CONTENT body; unknown-safety field omitted.
- Exit: `tail_logs` over a seeded lane carrying a secret and an untrusted body emits neither;
  ownership isolation holds (other pairing + user lanes invisible, same not-found).

### (c) Auth + audit-log plumbing  [P-CTRL-RO.1b, guard side; P-CTRL-RO.1a, contract]
- `controllerReadRoutes` subset in `desktop/origin_guard.ts`; `readOnly` capability in
  `desktop/controller/store.ts` (a read-only pairing is 403 on every write controller route).
- Add `controller_read` to `EVENT_NAMES` (`harness/contracts.ts`) as a frozen-contract sub-step
  (mirrors P-CTRL.1/ADR-0426). One metadata-only audit record per read (pairing id, tool, lane id,
  bytes, redaction count; no token, no contents), written BEFORE the response (fail-closed).
- Exit: read-only token is 403 on `spawn`/`prompt`/`cancel`/`answer`/`approve`/`auto`/`settings`;
  `?t=` and the bare UI token are 403 on controller reads; a typo'd event name still raises; an
  audit line precedes every successful read.

### (d) Tests / demo gate  [spans a-c]
- `desktop/controller/controller_ro.test.ts`: the 403 matrix, ownership isolation, redaction,
  revoke-then-refuse, malformed-store-refuses-all (reuse ADR-0438 harness), audit-before-response.
- `desktop/scripts/demo_p_ctrl_ro_1.ts` + `make demo-P-CTRL-RO.1`: boot the REAL engine on loopback
  with a scratch data root, create a read-only pairing, run the stdio MCP client through all three
  tools, prove the write-tool refusal and the redaction, revoke and confirm 403.
- If renderer touched (1d), rebuild `app.bundle.js` and grep served `/app.js` for the observe chip
  marker and confirm no write-control marker is present (AGENTS.md ADR-0260/0303 trap).

## Out of scope (Phase 2/3, not this PDR)
- Any state-changing verb over MCP (spawn/prompt/cancel) - Phase 2, reuses ADR-0438 + human approvals.
- Any non-loopback transport (LAN/VPN gateway, relay) and signed capability tokens - Phase 3,
  public gateway ADR + private ADR-A024 (ECDSA P-256 signed tokens + SIEM export).

## Sequencing
1a (contract) -> 1b (engine guard + handlers) -> 1c (MCP server) -> 1d (renderer). Each lands with
its own demo; the prior demo stays green.
