# Building & securely configuring the JetBrains + VS Code extensions

> Build & secure-config detail for **ADR-0038** (marketplace IDE extensions over ACP). This is a
> working guide for the P-EXT.1–4 increments; the authoritative design + invariant mapping lives in
> ADR-0038 in `DECISIONS.md`. Status: design — not built.

## The one rule everything hangs on

**The extension is untrusted; `lucid acp` is the trust anchor.** A marketplace extension is the
most-replaceable, least-trusted code in the system, so the *gate-or-no-gate* decision must never live
in extension code. Every editor talks to a Lucid-owned launcher that hard-codes the gated command and
fail-closes. The extension cannot express "run omp without the gate."

```
VS Code ext (TS)  ─┐
                   ├─ spawn ─►  lucid acp  ──►  omp acp -e security_extension.ts …  ──► gate pre-hook (in-process)
JetBrains plugin ──┘  (stdio)   (Lucid-owned,         (same OS process tree)            fail-closed
                                 fail-closed)                                            scanner sidecar)
```

No socket in the primary path → no network attack surface. Same security posture as the desktop shell.

The exact gated command the launcher must reproduce — from `desktop/acp_backend.ts:125`:

```
omp acp -e <repo>/harness/omp/security_extension.ts \
        -e <repo>/harness/omp/asksage_extension.ts \
        [--isolate <repo>/harness/omp/acp_config.yml] \
        --append-system-prompt "<DELEGATION_POLICY>\n\n<BUILD_POLICY>"
```

- cwd = the opened workspace folder (the path-containment boundary, ADR-0022/0023).
- omp resolved via `LUCID_OMP_BIN → ~/.bun → PATH` (`ompBin()` in `acp_backend.ts`).
- Policy order is `DELEGATION_POLICY` then `BUILD_POLICY` (`acp_backend.ts:124`) — reproduce **byte-for-byte** so the cache prefix stays stable (invariant #6).
- Block signal = stderr line `[BLOCKED tool_call:<name>] severity=<s> findings=<f>` (`acp_backend.ts:182`).

## P-EXT.1 — `lucid acp` launcher (build first)

A new `bin` in the root `package.json` (e.g. `"lucid": "tools/lucid_cli.ts"`), shipped inside the
app's `resources/repo` and installable standalone.

1. **Resolve assets from the installed-app location.** Mirror `runtime.ts` `repoRoot()`: packaged →
   `process.resourcesPath/repo/harness/omp/…`; dev checkout → relative to the binary. Resolve to
   **absolute** paths and `existsSync`-verify each before spawning.
2. **Reproduce the gated command byte-for-byte**, including the policy order above. Thread the AI-LOC
   env (ADR-0031); inherit omp's credential vault from the environment.
3. **Fail-closed at `initialize`:**
   - Scanner sidecar unreachable → probe at startup (reuse the Increment-0 kill-the-sidecar path);
     dead → return an ACP `initialize` error, exit non-zero.
   - Gate `-e` fails to load → catch omp's exit/stderr and translate to an `initialize` error.

Acceptance demo: `lucid acp` serves a real model turn with the gate loaded; killing the sidecar makes
`initialize` fail (fail-closed) — proven the same way as the Increment-0 kill-the-sidecar test.

## Shared ACP client contract (both editors)

Drive the loop already proven in `desktop/acp.ts` (line-delimited JSON-RPC over stdio):

- `initialize` → `session/new {cwd: workspaceFolder, mcpServers}` → read `modes` → `session/prompt`.
- Map `session/update`: `agent_message_chunk` (answer), `agent_thought_chunk` (display-only thinking,
  never re-fed to a prompt — ADR-0027), `tool_call(_update)`, `usage_update`.
- **Plan / Ask / Agent** via `session/set_mode`; **Stop** via `session/cancel`.
- **Permission round-trip** (`session/request_permission`) — **fail-closed**: timeout / view-closed /
  no-decision ⇒ `cancelled` (deny), per P-ACP.3.
- **Block banner**: watch stderr for `[BLOCKED tool_call:…]`.

## P-EXT.2 — VS Code extension

- TypeScript, `extensions/vscode/`. Reuse `desktop/acp.ts` **as-is** in the extension host. UI = a
  Webview view in a Lucid activity-bar container (full Plan/Ask/Agent + thinking + block-banner parity).
- **Secure launcher resolution** (read-only, no shell): installed LucidAgentIDE app path → `lucid` on
  `PATH` → user-set absolute path → else offer official download. **Never** fall back to `omp`.
- `cwd` = opened workspace folder = the boundary; multi-root ⇒ one session per folder, never a parent.
- **No `lucid.agentCommand` setting** (no ungated escape hatch). If ever added: behind a prominent
  "⚠ Lucid security gate disabled" wall, and `lucid acp` still self-verifies the gate.
- The extension holds **no provider secrets** — keys/OAuth stay in omp's vault.
- Publish to VS Code Marketplace + OpenVSX (Cursor/VSCodium/Windsurf).

Demo: install the `.vsix`, open a folder, get a gated reply; a poisoned tool call shows the block banner.

## P-EXT.3 — JetBrains plugin

- Kotlin, Gradle IntelliJ-Platform plugin, `extensions/jetbrains/`. Port `acp.ts` → `LucidAcpClient.kt`
  (trivial line-delimited JSON-RPC; the gate stays in `lucid acp`, never in the JVM). UI = a Lucid tool
  window. Spawn `lucid acp` with `project.basePath` as cwd via `GeneralCommandLine` (no shell interp).
- Same security matrix: launcher-only spawn, project-dir cwd boundary, fail-closed permissions
  (tool-window-closed ⇒ deny), `[BLOCKED]` banner, no ungated command setting.
- Publish to the JetBrains Marketplace (`publishPlugin`).

Demo: install the plugin zip, same gated reply + block banner in IntelliJ.

## Security configuration matrix

| Concern | Control |
|---|---|
| Gate can't be omitted (#4) | Decision lives in `lucid acp`, not extension; extensions only spawn `lucid acp` |
| Fail-closed (#3) | Launcher refuses on dead sidecar / unloadable gate; permission timeout/close ⇒ deny |
| Path containment (ADR-0022/23) | cwd = opened workspace folder only; multi-root ⇒ per-folder session |
| No escape hatch | No custom-agent-command setting; if added, behind a wall + launcher still self-verifies |
| Supply chain | Extension is untrusted (marketplace); trust anchored in the signed, app-shipped `lucid` binary |
| Secrets | Extensions hold none; credentials stay in omp's vault, inherited by the launcher |
| Frozen prefix (#6) | Launcher passes identical `--append-system-prompt` bytes; cwd is an arg, not prefix |
| New telemetry (#8) | `ide_session_started`/`attached` EventNames = frozen-contract change → its own sub-increment + ADR |

## P-EXT.4 — packaging, signing, CI, attach-mode

- Publish pipelines: `vsce`/`ovsx` (VS Code + OpenVSX), Gradle `publishPlugin` (JetBrains); versioning,
  auto-update, publisher verification.
- Ship `lucid` with the app + on `PATH` via the installer; sign alongside the desktop binary.
- **Optional attach-mode (Option B):** if the desktop control-plane is up, an extension may talk to its
  loopback control-plane instead — only through the ADR-0022 loopback bind + Host/Origin guard +
  ADR-0024 per-launch capability token (read from the running app's `userData` on the same machine,
  never sent over a wire the extension chose). stdio-`lucid acp` stays the default; attach-mode is
  convenience, never a bypass.

## Open items to lock before P-EXT.2/3

1. **Asset resolution** for `lucid acp` outside this checkout — resolve the gate/asksage/acp_config
   paths from the installed-app root (the `runtime.ts` `repoRoot()` model). Settles in P-EXT.1.
2. **omp's `initialize`-error shape** on `-e` load failure — drives the launcher's fail-closed signal.
   Probe with `tools/acp_probe.ts` against a deliberately-broken `-e`.
3. **VS Code surface:** Webview view (recommended, full parity) vs chat-participant / LM API — prototype
   both in P-EXT.2.

## Publishing (P-EXT.4b)

`.github/workflows/extensions-publish.yml` publishes on an `ext-v*` tag; each step is **secret-gated**
(no token → built but not published, workflow stays green). Required repo secrets:

| Secret | For |
|---|---|
| `VSCE_PAT` | VS Code Marketplace (publisher `lucidagentide`) |
| `OVSX_PAT` | Open VSX (Cursor / VSCodium / Windsurf) |
| `JETBRAINS_PUBLISH_TOKEN` | JetBrains Marketplace (`gradle publishPlugin`) |
| `JETBRAINS_CERTIFICATE_CHAIN` / `JETBRAINS_PRIVATE_KEY` / `JETBRAINS_PRIVATE_KEY_PASSWORD` | optional plugin signing |

Release: bump the version in `extensions/vscode/package.json` + `extensions/jetbrains/build.gradle.kts`,
then `git tag ext-v<x.y.z> && git push origin ext-v<x.y.z>`.

The `lucid` launcher (the trust anchor) is shipped + signed with the **desktop installer**
(`build-desktop.yml`), not the marketplace extensions — the extensions only locate it.

## Build order

P-EXT.1 (the security guarantee + foundation) → P-EXT.2 (VS Code) → P-EXT.3 (JetBrains) → P-EXT.4a
(ship the compiled `lucid` launcher) → P-EXT.4b (marketplace publish) → attach-mode (optional, its own
security-reviewed increment). Each is one increment with its own demo, per the session ritual.
