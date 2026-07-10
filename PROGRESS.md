# PROGRESS.md

Three lines per session: **shipped / stubbed / next** (CLAUDE.md session ritual).

-----

## P-THEME.1: the LUCID skin for gated terminals — omp theme + per-session -e apply (ADR-0160)
- **shipped:** `lucid tui` now wears the brand. `harness/omp/themes/lucid.json` translates the desktop design system (styles.css: bg `#0a0b0f→#222736`, magenta accent `#c64bd6`/`#e07bf0`, cyan-for-data, semantic green/amber/red; alpha tints flattened onto bg-1) into omp's 66-token theme schema; `harness/omp/lucid_theme_extension.ts` (a new optional `-e`, wired into `LaunchAssets`/`buildTuiArgs`/`runTui` AFTER the mandatory gate `-e`) provisions it into `~/.omp/agent/themes/` on `session_start` (read-then-compare, byte-idempotent) and applies it via `ctx.ui.setTheme("lucid")` — per-session only (setTheme never persists `theme.dark`), so bare omp keeps the user's theme and the skin doubles as the visible "this terminal is gated" tell. FAIL-OPEN by design (inverse of the gate): any theming failure degrades to omp's default theme, never blocks; `LUCID_THEME=off|<name>` escape hatch. TUI-only (ACP stubs setTheme; the desktop has its own skin). Docs: NEOVIM.md "The LUCID skin". SESSION MAINTENANCE (pre-increment, in ADR): repaired the red baseline — platform.test.ts navigator bitrot (Bun ≥1.x ships `navigator`; tests now stub the throw/Linux branches + pin the tour's LIVE modCombo portably) and `make test-harness` now passes `--path-ignore-patterns='desktop/release/**'` so bare `bun test` stops walking stale GENERATED packaged repo copies (340→157 real files).
- **verified:** `make test` 1527 pass / 0 fail (+16: lucid_theme_extension.test.ts 12 — provisioning idempotence/self-heal, LUCID_THEME matrix, all four fail-open paths incl. rejecting setTheme, factory session_start via fake ctx, 66-token asset check; lucid_acp.test.ts +4 — -e order gate→mcpGate→asksage→theme, policy after, passthru last, runTui threading) + sidecar green; `make demo-P-THEME.1` green (token resolution, idempotent provision + setTheme, fail-open × fail-closed, argv order, truecolor swatches); `make demo-P-NVIM.1` still green; root tsc clean. LIVE: deleted `~/.omp/agent/themes/lucid.json`, ran `lucid tui --model claude-haiku-4-5 -p …` → gated turn exit 0 AND the file re-provisioned byte-identical (extension loads + session_start fires under real omp 16.x).
- **stubbed:** interactive PAINT is asserted via the verified extension-ui-controller setTheme path, not a PTY screenshot (print mode stubs the UI — a truecolor-PTY assertion would be its own harness); omp bumps that GROW the required-token set surface as a live setTheme validation error (fail-open to default theme) — the 66-token list in the test pins today's schema. No light-mode lucid variant.
- **next:** optional — a lucid `symbols`/spinner set (brand glyphs), a light-mode variant for `theme.light` slots, and revisiting the stale `bin/lucid` compiled launcher so the shim can retire.
## P-NVIM.5: bare `lucid` starts the gated TUI (ADR-0161)
- **shipped:** `tui` is now the **default subcommand** — `lucid`, `lucid "prompt"`, `lucid --model haiku -p hi` all start the gated TUI exactly like their `lucid tui` spellings (which remain an explicit alias). `main()` routes any non-subcommand argv to `runTui` as omp passthru; `-h`/`--help`/`help` print usage and exit 0. New `deps` injection seam on `main()` for spawn-free routing tests. Every `lucid tui` invocation updated accordingly: the Neovim plugin's `_build_tui_args` (no subcommand), helpers_spec expectations, docs/NEOVIM.md examples (`:terminal lucid`), extensions/neovim/README.md, `lucid stats` hint, usage text.
- **stubbed:** nothing new — unknown-word "typos" intentionally become initial prompts (designed semantic, ADR-0161). `bin/lucid` compiled launcher remains stale (pre-`tui`, ADR-0150 note).
- **next:** ship a fresh signed launcher build so the bare-`lucid` ergonomics reach installed users.

## P-SANDBOX: runtime execution boundary — plan + ADR (ADR-0157)
- **shipped:** ADR-0157 (SCOPE/PLAN) for the post-approval runtime blind spot a reviewer named (a package's `__init__.py` doing `socket.gethostbyname()` on a TXT record → decode → in-process `exec()`, invisible to the argv classifier). Plan: an OS sandbox seam (`sandbox_exec.ts`, bwrap `--unshare-net`+seccomp on Linux, disclosed passthrough elsewhere) wrapping the omp process we already spawn (no fork, inv #1), a loopback DNS+CONNECT egress proxy (`egress_proxy.ts`) that REUSES `egressDecisionDetailed` so subprocess DNS/egress obeys the existing P-NETWL whitelist/posture/managed ceiling, and enforcing the `canNetwork`/`canExec` caps `profiles.ts` only declares today. "Still functions" = the P-NETWL.5 allow-all default stays on (pip/npm work, now mediated+logged); whitelist/enterprise mode is where hard blocks live.
- **stubbed:** implementation is deferred to the phased increments — no code yet. Interpreter audit-hooks (`sys.addaudithook`) explicitly REJECTED (would need a `.py` outside `scanner-sidecar/`, inv #2). macOS/Windows backends + raw-socket (non-proxied) forwarding are P-SANDBOX.4. New EVENT names are quarantined to P-SANDBOX.3 (inv #8 = its own contracts increment).
- **next:** P-SANDBOX.1 — the seam + `BwrapBackend`/`NoopBackend` + `resolveBackend`, enforce `canNetwork:false`/`canExec:false` for the auto-downgrade profiles, managed require-isolation flag, disclosed-passthrough audit.

-----

## P-NVIM.4: Neovim top-notch pass — gate block banner, context sparkline, three real bugs (ADR-0156)
- **shipped:** a deliberate GUI-vs-Neovim + TUI review, then fixes. BUGS: (1) `jobstart({term=true})` is Neovim 0.11+ while the README promises ≥0.10 — new `start_term()` feature-detects and falls back to `termopen()` on 0.10; (2) `:10,20LucidSend` read STALE `'<`/`'>` marks — `send_range` now uses the passed line range unless the marks exactly match it (fresh visual ⇒ charwise-precise, cmdline range ⇒ those lines); (3) `statusline = false` crashed `statusline()` — now returns "" and never starts the poll. PARITY: the gate's authoritative `[BLOCKED tool_call:…] severity=… findings=…` stderr line (the SAME signal the GUI banner + ide_client.ts parse; `ext_parity.json` contract) is now parsed from the Lucid terminal stream (`_parse_block_line`) and raised as a `vim.notify` ERROR banner; `SessionStats` gains `prompts[]` (per-turn context occupancy) and `:LucidStats` renders a `history` sparkline (`_sparkline`, downsampled/min-max/flat-safe) — the GUI's context graph, in the float. Demo now also asserts the MCP result-gate arg (locks the parity fix). Docs updated (banner, sparkline, `statusline=false`, cmdline ranges, 0.10 fallback).
- **verified:** the block-banner DELIVERY path is proven, not assumed — the headless spec runs a REAL PTY job that prints the parity block line to STDERR and asserts `on_stdout` delivered it parseably (PTY merges stderr; `%S+` stops before the CR). +16 headless assertions (all 4 ext_parity block cases, sparkline shapes incl. flat/downsample, statusline=false no-crash, float history row); `session_metrics.test.ts` asserts `prompts`; live `lucid stats --json` carries the real 117-point prompts series (44k→281k). Root tsc clean; launcher/metrics/nvim tests 23 pass / 0 fail; `make demo-P-NVIM.1` green.
- **stubbed:** the ADR-0011 all-time usage ledger in `lucid stats --ledger` was considered and DESCOPED by the user (statusline poll stays session-only); block-banner dedup/throttle not needed yet (the gate emits once per block).
- **next:** optional later — usage-ledger surfacing if asked; a `:LucidStats` cost-per-turn sparkline variant.

## P-NVIM.3: session metrics in Neovim — spend, KV-cache, context (ADR-0155)
- **shipped:** the GUI Memory-inspector numbers (session **spend**, **KV-cache hit %**, **context-fill**) are now in Neovim. Extracted a DuckDB-FREE `tools/session_metrics.ts` from `memory_data.ts` (moved the session-transcript primitives — `CTX_WINDOW`/`ctxWindow`/`Turn`/`Session`/`findSession`/`sessionPathById`/`parseSession`/`Budget`/`rateLimits` — + new `sessionStats()`/`formatStats()`); `memory_data.ts` now imports + RE-EXPORTS them, so it stays the single source (TUI/web/desktop unchanged) while the fail-closed `lucid` launcher reads metrics WITHOUT loading the DuckDB addon. New **`lucid stats [--json] [--budgets] [--session]`** (session-only fast path — plain .jsonl reads, one optional sqlite read). Plugin: **`:LucidStats`** float (mirrors the Memory inspector) + **`require("lucid").statusline()`** (`Lucid $x · cache y% · ctx z%`, cached, light poll of `lucid stats --json`). Docs + `<leader>lm` keymap.
- **verified:** live — `lucid stats` on a real session printed model / turns / **$15.5611** spend / **99%** cache hit / **28%** context-fill (281k/1M) / rate-limit budgets; `--json --budgets` emits the matching payload. Tests — `harness/launcher/session_metrics.test.ts` (sessionStats spend/cache/context + null + formatStats over a fixture .jsonl) + headless-nvim asserts for `_pct`/`_bar`/`_fmt_statusline`/`_fmt_stats_lines`. Refactor safety: `usage_ledger`/`code_activity` tests green, `bun test harness` 580 pass / 4 skip / 0 fail, root tsc clean.
- **stubbed:** the statusline poll is session-only by design (spend/cache/context); compaction policy + harness/AI-LOC + omp `config` stay in the heavier `memory:tui`/web dashboard (not polled). `:LucidStats` reflects the newest omp session for the cwd (same heuristic as the GUI's findSession).
- **next:** optional — a per-turn cost sparkline in the float; live cost delta since a session baseline.

- P-NVIM.3b: now that P-MCP-GATE.1 (ADR-0152) merged to master, threaded its result-gate into `lucid tui` (`runTui` passes `-e mcp_result_gate.ts` when present, like `runAcp`) — terminal sessions scan external MCP tool results exactly like `lucid acp`; `runTui` test asserts the gate is loaded. Closes the P-NVIM.1 stub.

## P-AGENTFW.2 + .3: Remote-agents Settings UI + per-connection permission policy & surfaced ACP updates (ADR-0149)
- **shipped (P-AGENTFW.2):** a Settings **"Remote agents"** card (mirrors the P-MCP.1 connectors card) so connecting a hermes/openclaw instance needs no hand-edited `~/.omp/lucid-agents.json`. `GET/POST /api/agents` + `/api/agents/remove` + `/api/agents/toggle` (`desktop/dev.ts`) call the harness registry; a change `backend.restart()`s omp so enabled connections attach as `agentfw-*` MCP servers next session. `bridge.remoteAgent*` (renamed off `agent*` to avoid the Agent-Builder `agentList` collision) + `RemoteAgentStatus` + `secAgents()` card (name/kind, command+args, permission badge, enable/remove + add form). No secret crosses the wire (command/args only; the note steers to `--token-file`).
- **shipped (P-AGENTFW.3):** per-connection **`permissionPolicy` ("deny" default | "allow")** on `RemoteAgentEntry`; the `AcpAgentClient` honors it (`deny`→cancelled, `allow`→`pickApproveOption`). Every `session/request_permission` is RECORDED (`permissionRequests`) and SURFACED in a `[permission-requests]` section of the delimited output — and because that text is remote-controlled (the toolCall title), it is added to the INBOUND `scanAndDecide` text + neutralized (a hidden vector in a permission title quarantines like the reply body — regression-tested). `plan` updates now noted alongside `tool_call`. Deferred: a TRUE interactive per-request approval prompt (the firewall is an omp-spawned subprocess with no UI channel — needs a new IPC surface).
- **verified:** 25 harness/mcp tests (23 pass / 2 gated-live skip / 0 fail) incl. `acp_client.test.ts` (permission helpers), registry policy round-trip, firewall surfacing + poisoned-permission-title quarantine; root tsc clean; my desktop code typechecks (pre-existing netdiag/dev omp-bump errors untouched). Rebased onto master after #201 merged; ADR-0149 (0152 is the sibling P-MCP-GATE.1 PR).
## P-MCP-GATE.1: in-process gate for MCP tool RESULTS — closes the ADR-0020 guardrail for EVERY MCP server (ADR-0152)
- **shipped:** the ADR-0020 promise ("MCP tool output passes the gate + is UNTRUSTED_CONTENT-wrapped") was never implemented (`security_extension.ts` `tool_result` only did LOC + `<task-result>`), so every P-MCP.1 connector's OUTPUT re-entered the model UNSCANNED. New `harness/omp/mcp_result_gate.ts` — a SEPARATE `-e` extension (keystone `security_extension.ts` untouched) on omp's `tool_result` hook, which may REPLACE the result (`ToolResultEventResult`; the runner captures the last handler's return, security_extension returns nothing → the gate wins). SOURCE-SCOPED to MCP results (`toolName` starts `mcp__` OR `details.serverName`), so local `read`/`bash`/`write`/`edit`/`grep`/`glob` are LEFT UNTOUCHED (scanning a user's own file read is wrong + a FP/perf hazard). Fail-closed (inv #3): quarantine → content REPLACED with a redacted block notice + `isError` (poison never reaches the model); clean/suspicious → wrapped `UNTRUSTED_CONTENT` + `[mcp-server name=… trust=…]` (never `trusted`, inv #5), embedded delimiters neutralized, image blocks preserved. Wired into `desktop/acp_backend.ts` + the `lucid acp` launcher (`buildAcpArgs`, existsSync-guarded). 10 tests (`mcp_result_gate.test.ts`: source-scoping, wrap/block, breakout, image-preserve, real-scanner decision mapping + fail-closed) + `make demo-P-MCP-GATE.1`; root tsc clean.
- **stubbed:** delimiting EVERY clean MCP result is the faithful ADR-0020 posture but a behavior change for existing connectors (Linear/GitHub MCP output now arrives delimited) — acceptable per inv #5; a per-server opt-out is a possible later knob. `neutralizeDelimiters` is duplicated with the agent-firewall's copy (fold into a shared home when convenient). Live end-to-end against a 3rd-party MCP server not exercised here (covered by the source-scoped unit + real-scanner tests).
- **next:** P-AGENTFW.2 (desktop Remote-agents UI) + P-AGENTFW.3 (per-connection permission policy + richer scanned updates).
## P-NVIM.2: distribute lucid.nvim as a standalone branch, still inside the monorepo (ADR-0151)
- **shipped:** the Neovim plugin is now installable as a normal standalone plugin WITHOUT a separate repo. lazy.nvim/LazyVim can't install a subdir of a monorepo, so a generated **`lucid.nvim` branch of this same repo** carries the plugin at the tree root (via `git subtree split --prefix=extensions/neovim`); source of truth stays `extensions/neovim/`. CI (`.github/workflows/nvim-plugin-mirror.yml`, `contents:write`) subtree-splits + force-pushes `lucid.nvim` on every master push touching the plugin; `make nvim-plugin-split` does it locally (dry-run; `PUSH=1` publishes). Install: `{ "mlcyclops/lucidagentide", name = "lucid.nvim", branch = "lucid.nvim", main = "lucid", cmd = {…}, keys = {…}, opts = { keymaps = false } }`. Docs (`docs/NEOVIM.md` + plugin README) lead with the branch install + a LazyVim spec; `extensions/neovim/LICENSE` makes the branch self-contained; a `neovim` job in `extensions.yml` runs the headless helper spec beside the VS Code/JetBrains jobs.
- **verified:** `git subtree split --prefix=extensions/neovim HEAD` yields a branch whose ROOT is the plugin (`README.md`, `lua/lucid/*`, `plugin/lucid.lua`, `test/`, `LICENSE`) — confirmed locally; `make nvim-plugin-split` dry-run prints the split sha. lazy.nvim `branch` + short-name install + `main`/`opts` auto-setup confirmed against the lazy.nvim docs (`/folke/lazy.nvim`). Caught + fixed a real bug in the LazyVim spec: visual-mode send must use the `:LucidSend<cr>` colon form (applies `'<,'>`), not `<cmd>` (which would send the whole file).
- **stubbed:** the `lucid.nvim` branch is published by CI on master pushes — until #207 merges it doesn't exist on origin yet (run `make nvim-plugin-split PUSH=1` to publish early). The branch is GENERATED: never hand-edit it, edit `extensions/neovim/`. No rockspec / luarocks packaging (branch install covers lazy/packer/vim-plug).
- **next:** after #207 merges, confirm the first CI mirror run produces an installable `lucid.nvim`; optional luarocks/rockspec if a user needs it.

## P-NVIM.1: Neovim + terminal integration for the gated agent (ADR-0150)
- **shipped:** two Neovim-friendly ways to drive the gated LUCID agent, both on the fail-closed `lucid` launcher (never a bare omp). (1) A new **`lucid tui`** subcommand — the SAME gated command as `lucid acp` (gate `-e` first, byte-identical appended policy, invariant #6) MINUS the `acp` subcommand, so it runs omp's native terminal UI over inherited stdio; extra args pass through (initial prompt, `--model`, `--continue`, `-p`). Factored the spawn into a shared `execGated` so `acp`+`tui` share ONE fail-closed launch path (`runAcp` behavior unchanged). (2) A first-party **`extensions/neovim/`** plugin (`lucid.nvim`): `:Lucid`/`:LucidToggle`/`:LucidSend` (visual selection or `@file`)/`:LucidCheck` + `:checkhealth lucid` + keymaps, all hosting `lucid tui` in a terminal buffer (no reimplemented ACP UI — YAGNI). Docs: `docs/NEOVIM.md` (three paths incl. an ACP-client → `lucid acp` config for CodeCompanion.nvim) + plugin README.
- **verified:** live (Neovim 0.12, omp 16.3.6) — `lucid check` → OK; `lucid tui --model claude-haiku-4-5 -p …` returned a gated real turn (exit 0); `lucid acp` initialize → oh-my-pi 16.3.6, ACP protocol v1, loadSession, auth agent (backs the Neovim ACP path). Tests — `harness/launcher/lucid_acp.test.ts` (buildTuiArgs no-`acp`/gate-first/policy/passthru-last; runTui fail-closed = exit 1 + ZERO spawns; spawns gated omp w/ workspace cwd; exit-code + 127) + `harness/launcher/neovim_plugin.test.ts` drives the plugin's pure helpers (`_build_tui_args`/`_selection_text`/`_resolve_cmd`) through a headless `nvim -l` (skips when nvim absent). `make demo-P-NVIM.1` green; root tsc clean.
- **stubbed:** `lucid tui` doesn't yet pass the P-MCP-GATE.1 result-gate `-e` — that extension + `assets().mcpResultGate` live in the unmerged #206; `buildTuiArgs` already accepts a forward-compat `mcpResultGate?`, so post-#206 it's a one-line thread-through in `runTui`. The ACP-client path (Path 3, CodeCompanion.nvim) is documented + handshake-verified but the third-party adapter config isn't pinned by a test (its API evolves); the terminal paths (1–2) are the tested ones. `bin/lucid` is a stale compiled build (predates `tui`) — run from source until the next signed build.
- **next:** thread the MCP result-gate into `lucid tui` once #206 merges; optionally publish `extensions/neovim/` as its own installable repo/rockspec for lazy.nvim/packer users.
## P-FIGMA.2: guided review + build/pop-out DESIGN.md after import (ADR-0154; /figma epic complete)
- **shipped:** `/figma` import now ends in a **guided next step** instead of a bare toast. `openFigmaForm` swaps to a next-steps card (event-delegated) offering: **"Have the agent review the design"** (seeds `seedFigmaReview` — the agent screenshots + inspects the board + checks DESIGN.md → summary/issues/recommendations) and, driven by a new `hasDesign` flag on the import response, either **"Review DESIGN.md in the IDE"** (project already has one) or **"Build a DESIGN.md from this design"** (`seedFigmaBuildDesign` — the agent inspects the board then WRITES a DESIGN.md of enforceable invariants: grid, palette w/ hex, type scale, components, tone, a11y). When the agent writes DESIGN.md, `acp_backend` emits a new additive `design-available` ChatEvent (pure `isDesignDocPath` predicate in `design_doc.ts` — any separator, case-insensitive, no look-alike false positives) → a toast **"Review in the IDE"** that pops DESIGN.md out in Monaco via `openDesignInIde` (new `/api/design` GET returns `{exists,path,name,content}`) for the user to review/edit; P-DESIGN.1 then honors it every turn. `bridge.designDoc`; the `check`/`markup`/`info` glyphs reused. 2 new `isDesignDocPath` tests + `make demo-P-FIGMA.2`; suite **1320 pass** (only the 5 pre-existing `fs_browse` Windows/home-dir fails); root+desktop tsc clean; renderer bundles clean (verified via the same `Bun.build` the dev server runs — `figmaNextStepsHtml`/`openDesignInIde`/`design-available` present). No frozen-prefix/contract change; no version bump.
- **stubbed:** the built DESIGN.md is authored by the agent from the rendered board (no direct Figma design-token/variable extraction). Reaching the next-steps card end to end requires a real Figma import (PAT + file); the guided logic is unit-tested + the renderer bundles clean, but a full click-through wasn't run live (token-gated API + the documented preview-harness flakiness on this host). `design-available` fires on the first DESIGN.md write of a turn.
- **next:** the /figma epic (ADR-0154) is feature-complete: DESIGN.md honored (P-DESIGN.1) → import (P-FIGMA.1) → guided review + build/pop-out (P-FIGMA.2). Then P-RAG.2 (screenshot→RAG ingest) once the RAG branches land on master. Optional: extract Figma variables/tokens directly into DESIGN.md.

## P-FIGMA.1: /figma — import a Figma design into the Preview (ADR-0154)
- **shipped:** the `/figma` command imports a Figma file's frames into the Preview panel as a design board. New pure `desktop/figma_client.ts`: `parseFigmaFileKey` (Figma file/design/proto URL or bare key → key), `collectTopFrames` (walk the `/v1/files` document → top-level FRAME/COMPONENT/SECTION nodes across pages, capped at 24), `figmaBoardHtml` (a labelled card per frame with its PNG inlined as a data URL — names HTML-escaped, only `data:image/*` ever set as a src, else a placeholder). New `dev.ts` `POST /api/figma/import` (server-side): PAT from the request or `LUCID_FIGMA_TOKEN` → `GET /v1/files/:key?depth=2` + `GET /v1/images/:key?ids=…&format=png&scale=2` → fetch each render → data URL → write `.omp/figma/<key>.html` → return the path (clear 403/404/timeout errors). **Secure key:** the PAT is stored in the OS-encrypted vault (`credStore`, ref `figma_pat`); `main.ts prepareFigmaToken()` reads it from the vault and injects `LUCID_FIGMA_TOKEN` into the dev child at spawn — the token is used server-side only, NEVER reaching the renderer or the agent. UI: a `/figma` slash command + `send()` intercept → a secure modal (`openFigmaForm`: file URL + PAT, vault note) → on import, loads the board via the existing preview pipeline (`onPreviewAvailable`) + a toast whose action seeds a review turn (`seedFigmaReview`: the agent screenshots + inspects the board + checks DESIGN.md). `bridge.figmaImport`; `.figma-modal` styles. 7 tests (`figma_client.test.ts`) + `make demo-P-FIGMA.1`; suite **1318 pass**; root+desktop tsc clean. **Verified live:** `/figma` opens the form (URL + password PAT + Import, vault-explained, input cleared); a bad URL is refused end to end ("That doesn't look like a Figma file URL or key"). A real successful fetch needs the user's PAT + file (unit-tested; loads through the verified preview pipeline). No frozen-prefix/contract change; no version bump.
- **stubbed:** the guided REVIEW flow is minimal here (a toast action seeds a review prompt) — the richer flow (ask-to-review, build DESIGN.md if absent, pop it out in the IDE for review/edit) is **P-FIGMA.2**. Frames render as static PNGs (no interaction/inspect of Figma layers; the agent inspects the rendered board). A live figma.com embed is intentionally not attempted (egress-blocked sandbox). PAT reuse across sessions relies on the vault→env-at-spawn injection (a freshly-entered token works immediately via the request).
- **next:** P-FIGMA.2 — after import, ask the user if the agent should review; the agent reviews (screenshot + inspect + DESIGN.md) → recommendations; if no DESIGN.md, offer to build one → `openIde({path:"DESIGN.md"})` pops it out for the user to review/edit; future design work adheres (P-DESIGN.1 already injects it).

## P-DESIGN.1: honor a project's DESIGN.md invariants (ADR-0154; foundation for the /figma epic)
- **shipped:** a workspace-root **DESIGN.md** is now honored as standing design guidance — the design equivalent of CLAUDE.md. New pure `desktop/design_doc.ts` (`designInvariantsBlock` wraps DESIGN.md into a `<design-invariants>` block that instructs the agent to honor it across all UI/design/styling work; `designDocPath`; 12k-char clip). `acp_backend` reads DESIGN.md each turn (`readDesignInvariants(currentWorkspace())`, fail-soft) and passes it to `buildUserTurnPreamble` via a new `designInvariants` field (`preamble.ts`) — so it rides in the user-turn tail (NEVER the frozen prefix → no cache bust) and is re-delivered EVERY turn (never fades across a conversation), exactly like the persona/skill/profile standing blocks. It's the user's own project file → trusted INSTRUCTIONS (the agent obeys it), not untrusted-delimited data. Absent DESIGN.md → no block (the agent just proceeds). 5 tests (`design_doc.test.ts` 4 + a `preamble.test.ts` case) + `make demo-P-DESIGN.1`; suite **1311 pass**; root+desktop tsc clean. No frozen-prefix/contract change; no version bump.
- **stubbed:** no UI yet to CREATE/edit DESIGN.md (that + the IDE pop-out is P-FIGMA.2); DESIGN.md is workspace-root only (no nested/dir-scoped design docs); it's injected as a whole (no section-targeting). The Figma import + `/figma` command are P-FIGMA.1/.2.
- **next:** P-FIGMA.1 — the `/figma` command + secure PAT (→ vault) + import the file's frames as inlined PNG images → load in the preview (via the existing pipeline). Then P-FIGMA.2 — the guided review flow (agent reviews the board with preview_screenshot/preview_inspect + DESIGN.md → recommendations; build DESIGN.md if absent → pop out in the IDE for review/edit).

## P-AGENTFW.1: Agent Firewall MCP - fail-closed security proxy to remote ACP agents (hermes/openclaw) (#198, ADR-0147)
- **shipped:** LUCID can now connect to remote **hermes** (`hermes acp`) / **openclaw** (`openclaw acp --url wss://…`) agent runtimes THROUGH a first-party security-firewall MCP that mediates both directions. `harness/mcp/`: a hand-rolled stdio MCP server (`mcp_server.ts` - initialize/tools/list/tools/call, long-lived so omp won't fork-loop it), a harness ACP client (`acp_client.ts` - least-privilege handshake: no client fs; denies the remote's `session/request_permission`), and the gate (`agent_firewall.ts`): OUTBOUND prompts scanned (injection-relay block via `scanAndDecide`, homoglyph-demoted like the model's own content) so nothing hidden is relayed; INBOUND remote replies scanned strict → quarantine WITHHOLDS the reply, clean/suspicious is wrapped in `UNTRUSTED_CONTENT` + trust-labeled (never `trusted`), with `neutralizeDelimiters` closing the envelope-breakout hole; fail-closed by law (dead scanner → block, remote never reached). Registry (`registry.ts`, `~/.omp/lucid-agents.json` @ 0600) + `lucid agent-firewall --conn <id>` subcommand + `mcpServersForAcp()` concats enabled connections as `McpServerStdio`. 12 tests (registry 5 + firewall 7, incl. kill-sidecar fail-closed + delimiter-breakout) + `make demo-P-AGENTFW.1`; real harness suite 493✓/0, root tsc clean, license headers ✓.
- **verified (live + integration):** connected end-to-end to a REAL `hermes acp` instance through the firewall — `uvx --from 'hermes-agent[acp]' hermes-acp` (hermes-agent 0.18.0): our `AcpAgentClient` completed initialize → session/new (session `57649de9…`) → session/prompt and received the streamed reply; the only error was hermes's OWN offline local model, transport was clean. `harness/mcp/testing/fake_acp_agent.ts` (a faithful ACP stdio stand-in) drives 6 deterministic integration tests over a REAL subprocess boundary (handshake→sessionId, clean→delimited-untrusted incl. scanned tool-activity, poison→withheld, breakout→neutralized, remote permission-ask→denied, full MCP `tools/call` chain) + a `LUCID_LIVE_HERMES=1`-gated real-hermes handshake test (`acp_client.connect()` added to substantiate connectivity distinctly from a prompt). Real harness suite **499✓ / 0 fail**, root tsc clean, license headers ✓.
- **verified (openclaw, live):** ALSO connected end-to-end to REAL **openclaw** 2026.6.11 — `openclaw acp` bridged to a local `openclaw gateway run --dev --auth none` on :18789: `AcpAgentClient.connect()` returned a gateway session id and a full firewall `handlePrompt` wrapped the reply as `UNTRUSTED_CONTENT` (trust="untrusted"). Confirms our `mcpServers: []` in session/new is accepted — openclaw's bridge `assertSupportedSessionSetup` early-returns on an EMPTY array, so `[]` is required (omitting the key would crash it; NO client change). openclaw acp is a gateway BRIDGE (needs a live gateway; without one it exits ECONNREFUSED before initialize). Locked by a `LUCID_LIVE_OPENCLAW=1`-gated test (+ `OPENCLAW_ACP_ARGS` for a remote gateway).
- **stubbed:** desktop Settings "Remote agents" UI to add/edit connections (P-AGENTFW.2) - today a connection is registered via the 0600 registry file (+ the demo/tests populate it programmatically); surfacing the remote's denied permission asks for opt-in user approval + forwarding richer scanned ACP updates is P-AGENTFW.3. FLAGGED: ADR-0020's claim that general MCP tool results pass the in-process gate + delimiters is UNIMPLEMENTED (`security_extension.ts` `tool_result` only does LOC + `<task-result>` promotion) - this increment closes it at the firewall boundary only; the general in-process `tool_result` scan for ALL MCP servers (and folding `neutralizeDelimiters` into `wrapRetrieved`) is recommended as P-MCP-GATE.1. Pre-existing (NOT this increment): `bun test harness` also runs stale gitignored `desktop/release/**` packaged copies (baseline 6, now 8 as those copies can't resolve the new import) and `desktop/{netdiag,dev}.ts` fail desktop-tsc under the uncommitted omp 16.3.6 bump.
- **next:** P-AGENTFW.2 (Remote agents Settings UI), then P-MCP-GATE.1 (in-process tool_result gate for every MCP server, closing the ADR-0020 gap globally).

## P-PREVIEW.6c: the agent CLICKS/TYPES in the live preview — structured actions (ADR-0153; preview-review epic COMPLETE)
- **shipped:** the agent can now TEST its UI — click a button or type into a field in the live preview by CSS selector, then screenshot/inspect the effect. Built on 6b's relay + bridge: `InspectCommand` gained `action`/`value` (`preview_inspect_relay.ts`), the injected bridge (`preview_bridge.ts`) routes `cmd.action ? act(cmd) : inspect(cmd)`, and `act()` is a FIXED allowlist — **click / type / focus / scroll** only: it calls `el.click()`, sets `el.value`/`textContent` + dispatches input+change, or scrolls into view — **never `eval`/`Function`/`innerHTML`/`document.write`** (proven by a grep test). New `/api/preview/act` endpoint (GET, token-gated) + `LUCID_PREVIEW_ACT_URL`; new READ-tiered `preview_click` + `preview_type` omp tools (`harness/omp/preview_extension.ts`) that go through the same held relay + 8s fail-closed timeout; both light the 6a "Testing the preview" pill. Read-tier is safe: the preview is opaque-origin sandboxed + `connect-src 'none'` (a click can't reach the network or LUCID). 3 tests (relay action command + bridge action-allowlist) + `make demo-P-PREVIEW.6c`; suite **1306 pass**; root+desktop tsc clean. **Verified live end to end:** `preview_click` on `#go` fired the button's onclick and the page's `<h1>` actually changed from "idle" to "clicked!"; `preview_type` set an input's value to "Nicholas". No frozen-prefix/contract change; no version bump. **This completes the preview-review epic (ADR-0153): glow/pill (6a) + read the DOM (6b) + click/type (6c) — the agent reviews AND tests its work live in front of the user.**
- **stubbed:** no key-press/select/drag actions yet (click/type/focus/scroll cover the common cases); `preview_type` replaces a field's value (no incremental keystroke simulation); actions are read-tier (not approval-gated) since the preview is fully sandboxed — revisit if remote previews are ever allowed. The bridge captures console errors only after it loads (end-of-body injection).
- **next:** P-RAG.2 (screenshot→RAG ingest: caption/OCR → the existing scan→embed→store seam) once the RAG branches land on master. The multimodal + preview-review arc (P-VISION.1 + P-PREVIEW.6a/b/c) is otherwise complete.

## P-PREVIEW.6b: the agent READS the live preview DOM — postMessage bridge + held relay (ADR-0153)
- **shipped:** the agent can now inspect the live preview DOM to review its work. Because the preview iframe is opaque-origin sandboxed (the renderer can't touch its DOM), a **read-only bridge** (`desktop/preview_bridge.ts` `PREVIEW_BRIDGE_JS`) is injected into the served HTML (in `/api/preview/serve`; inline JS is CSP-allowed, `connect-src 'none'` still blocks egress) — it answers `postMessage` queries from the renderer (page text/headings/controls, element details by CSS `selector`, or captured console `errors`) and posts a compact, clipped snapshot back; NO eval, NO mutation (proven by a test that greps the script). A held **relay** (`desktop/preview_inspect_relay.ts` `InspectRelay`, unit-tested) bridges the process gap: the agent's new READ-tiered `preview_inspect` tool (`harness/omp/preview_extension.ts`) GETs `LUCID_PREVIEW_INSPECT_URL`; the dev server HOLDS the request; the renderer polls `/api/preview/inspect/next` (450ms while the panel is open), runs the query on the frame via the bridge, and POSTs `/api/preview/inspect/result` — resolving the held tool call (8s fail-closed timeout → "open a preview first"). The `preview_inspect` tool-call also lights the 6a "Inspecting the preview" pill. **Also fixed a real pre-existing bug:** `preview_screenshot` read `body?.png` while the endpoint wraps `{ok,data:{png}}`, so the agent had NEVER actually seen its screenshots — now reads `body.data.png`, so the review-your-work loop (screenshot + inspect) works. 16 tests (`preview_inspect_relay.test.ts` 5 + `preview_bridge.test.ts` 3 + reused) + `make demo-P-PREVIEW.6b`; suite **1304 pass**; root+desktop tsc clean. **Verified live end to end:** the injected bridge answered a real inspect query, returning title "Demo App" / heading "Welcome" / controls ["Launch","your name"] / body text from a served sandboxed preview. No frozen-prefix/contract change; no version bump.
- **stubbed:** the bridge captures console errors that fire AFTER it loads (injected at end-of-body, so pre-bridge init errors are missed — acceptable; interaction-time errors are caught). Structured ACTIONS (click/type) are P-PREVIEW.6c (they extend the same bridge/relay with mutating commands + a stricter allowlist). The relay poll runs only while the preview panel is open (a query with no panel open times out server-side with a helpful message).
- **next:** P-PREVIEW.6c — `preview_click` / `preview_type` by CSS selector over the same bridge (mutating, read-tier or approval-gated per action). Then, once RAG lands on master, P-RAG.2 (screenshot→RAG).

## P-PREVIEW.6a: the agent reviews its work live — Preview panel glow + "testing" pill (ADR-0153)
- **shipped:** the visible signal that the agent is looking at / testing the live preview. New pure `desktop/preview_activity.ts` `previewActivityLabel(title)` maps a preview tool-call (screenshot/open/inspect/click/type — matching omp's tool-name titles AND human-summarized ones) to a user-facing label (else null; non-preview tools never trigger it). `acp_backend` emits a new additive `preview-activity` ChatEvent in the tool_call block (visuals-only, never a gate); `bridge` mirrors the type. The renderer `flashPreviewTesting(label)` adds `.testing` to `#preview` (a pulsing accent glow on `.preview-body`) + shows a `#prevPill` pill with the label + a pulsing dot, surfaces the panel if a loaded preview is hidden (so the user SEES the review), debounces (fades ~4.5s after the last signal), and clears on turn `done`. So when the agent screenshots/opens/inspects the preview, the panel glows and a "Reviewing/Inspecting/Testing the preview" pill appears. 3 tests (`preview_activity.test.ts`) + `make demo-P-PREVIEW.6a`; suite **1296 pass**; **root + desktop tsc clean** (verified with desktop deps installed — the local desktop typecheck now works). Verified live: opening the panel + firing the state applied the glow (box-shadow) + a visible pill labelled "Reviewing the preview" with an accent background. No frozen-prefix/contract change; no version bump.
- **stubbed:** this is the SIGNAL only — the agent's live DOM inspect + structured click/type are P-PREVIEW.6b/.6c (they need a postMessage bridge injected into the served preview, since the iframe is opaque-origin sandboxed and the renderer can't touch its DOM directly). The indicator currently keys on `preview_screenshot`/`preview_open`; the new DOM tools' titles will light it too once built. The screenshot didn't surface the right-edge panel in the headless preview (a documented render quirk on this host), so the glow/pill were verified via computed styles, not a screenshot.
- **next:** P-PREVIEW.6b — a postMessage bridge in the served preview + a READ-tiered `preview_inspect` tool (text/attributes/console/errors, NO arbitrary eval) over a small command/result relay (extends the shot-cache pattern). Then P-PREVIEW.6c — structured `preview_click`/`preview_type` by CSS selector. Then, once RAG lands on master, P-RAG.2 (screenshot→RAG).

## P-VISION.1: paste / drop images into the composer — multimodal user prompts (ADR-0136)
- **shipped:** the user can paste a snipping-tool / desktop screenshot (or drag-drop an image file) straight into the prompt bar; it shows as a **mini thumbnail just above the prompt bar**, and travels to the model — as an omp image content block alongside the text — **only when the user hits Enter/Send** (no auto-push). New pure `desktop/renderer/composer_attachments.ts` (`parseImageDataUrl`/`acceptAttachment`/`promptImageBlocks`/`thumbStripHtml`): fail-closed validation (only image/png|jpeg|webp|gif base64 — SVG excluded for script-risk; ≤6 images; ≤12 MB each), and NO data URL is ever interpolated into HTML (the caller sets `img.src` as a DOM property). Wired end-to-end: `state.attachments` + paste/drop/remove handlers + `#composerThumbs` strip in `app.ts`; `send()` emits `promptImageBlocks` → `bridge.sendPrompt(text, onEvent, images)` → `/api/chat {text,images}` (defensively filtered) → `backend.prompt(text, emit, images)` → ACP `session/prompt: [{type:text}, ...imageBlocks]` (verified against omp's `ImageContent` type; the agent's `preview_screenshot` tool already proves the round-trip). Image-only messages can send; the sent message renders the images inline. 11 tests + `make demo-P-VISION.1`; suite **1293 pass**; root+desktop tsc clean. **Verified live** in the preview: dropping an image staged a thumbnail (strip visible, remove button, send-enabled), and Remove cleared it (strip hidden, send disabled). No frozen-prefix/contract change; no version bump.
- **stubbed:** attaching while a turn streams keeps the images staged and sends them with the queued/next message (no separate queued-attachment slot); a retry re-sends text only (not the images); non-image clipboard/files pass through untouched; no server-side scan of image BYTES (a user's own pasted image is trusted input, like typing — text is still scanned everywhere it matters). Full model round-trip (actually generating a vision reply) needs a live model, not exercised headlessly.
- **next:** P-PREVIEW.6 — the agent reviews its work live in the preview (inspect + structured click/type over a postMessage bridge) with a glowing panel + a "testing" pill (user-chosen scope). Then, once RAG lands on master, P-RAG.2 screenshot→RAG ingest (caption/OCR → the existing scan→embed→store seam).

## P-LOCAL.3: Settings → Local Providers card — add/manage self-hosted LLMs from the UI (ADR-0135)
- **shipped:** the user-facing surface. New default-collapsed **"Local Providers"** card in Settings, positioned right under "Providers" (verified live: renders, sits after Providers, auto-collapsed, expands on click). New pure builder `desktop/renderer/local_providers_ui.ts`: `localProvidersCardBody` (list of providers with endpoint + models + a vault/enable status pill + delete; an "Add a local provider" form — name, base URL, model ids, auth kind, key), `draftFromForm` (validates → a `LocalProviderDef` draft, fail-closed, no vaultRef yet), `providerStatus`. Wired in `app.ts`: `hydrateLocalProviders` (lists providers + which cred refs are in the vault), `addLocalProviderFromForm` (validate → if authed, `bridge.credStore` the key into the OS-encrypted vault → save the def with only the `vaultRef`), `deleteLocalProvider`, and enable-toggle; click/change handlers + `state.localProviders`. Backend `/api/local-providers` GET/POST/delete/enable in `dev.ts` (upsert validates fail-closed) + `bridge` methods. `.lp-*` styles. 8 tests (`local_providers_ui.test.ts`: card HTML, empty state, form parsing, reserved-id refusal, escaping, status); full suite **1278 pass**; root + desktop tsc clean (modulo the missing-electron env gap).
- **shipped (polish, same session):** the optional polish items are done. **Test connection** — per-row + add-form reachability/TLS probe (`/api/local-providers/test` hits the OpenAI-compatible `/models` with a 4.5s timeout and NO key; any HTTP response incl. 401/403 = reachable, else a network/TLS/timeout error with a VPN/port hint). **External-zone toggle** — a checkbox in the add form drives `zone` internal|external (default internal for LAN/VPN/localhost). **Re-key** — authed rows get a "Key" button that reveals an inline paste field → stores/rotates the key straight into the OS-encrypted vault (`credStore`), no delete+re-add. **Apply/Restart** — an Electron `lucid:relaunch` IPC + a "Restart to apply" button (shown only in the desktop app with enabled providers) since the omp child env is set at dev-spawn. **Safety:** unsupported `basic` auth is removed from the picker and skipped by the overlay emitter (never mis-emitted as a bearer). +4 tests (40 provider tests total); suite **1282 pass**; root+desktop tsc clean; polish strings verified in the served bundle.
- **stubbed:** full inline field-edit (name/URL/models) is still delete+re-add (re-key covers the common case); `basic` auth overlay emission remains deferred (needs a username + base64 scheme incompatible with the env-ref model). Full settings-panel HYDRATION still couldn't be exercised in the local preview (all cards sit on skeletons — a documented preview-env flake on this host, not code-specific); the card + polish are covered by unit tests + bundle checks.
- **next:** the Local Providers epic (ADR-0135) is feature-complete for the release. Optional later: full inline edit, `basic`-auth support. Otherwise done: declare → vault → omp models.yml → routed, with test/re-key/zone/apply all from the UI.

## P-LOCAL.2 (core): omp custom-provider delivery — resolved + verified live, secure env-ref secrets (ADR-0135)
- **shipped:** the delivery mechanism that makes omp actually recognize a self-hosted model, VERIFIED LIVE against omp 16.0.8. Found the registry path — **`~/.omp/agent/models.yml`** (primary; `models.json` is a migration fallback), NOT `~/.omp/models.json` and NOT `--config` (that loads the general config.yml). Fixed two silent-drop bugs in the emitter: an open provider must emit **`auth:"none"`** (else omp demands an apiKey and discards the whole file), and the `api` must be **`openai-completions`** (omp's models.yml enum rejects `ollama-chat`; Ollama's `/v1` is OpenAI-compatible). Added the SECURE runtime path `toOmpRuntimeOverlay(defs, availableRefs)` + `providerEnvVar`: authed providers reference their secret by **env-var NAME** in models.yml (omp's `resolveConfigValue` reads a value as `Bun.env[name]` first), and LUCID injects the real key into the omp CHILD env from the vault — so the **secret never lands in the file**; fail-closed (a provider whose vault ref isn't available is skipped, no env leaked). Live proof: a materialized `~/.omp/agent/models.yml` (open Ollama + a bearer DGX-over-VPN provider using `apiKey:"LUCID_LP_DGX_VIENNA_KEY"`) → `LUCID_LP_DGX_VIENNA_KEY=… omp models` listed BOTH `ollama-local` and `dgx-vienna`. 20 tests (`local_providers.test.ts`) + demo; full suite **1262 pass** / only the 5 pre-existing fs_browse Windows fails; root tsc clean. On branch `feat/local-providers`. No version bump.
- **shipped (wiring, same session):** the full MAIN-process delivery. New `desktop/local_providers_runtime.ts`: `mergeModelsYaml` (safe merge — preserves non-LUCID providers, drops previously-managed ids via a sidecar, REFUSES to overwrite an unparseable hand-authored YAML), `materializeLocalProviders` (resolve vault secrets → write models.yml → return `{ENV_VAR→secret}` child env; fail-closed), `registerLocalProviderEgress`/`localProviderEgressEntry` (whitelist entry per endpoint, `AuthRef→vault`). Wired in `desktop/main.ts`: the omp acp runs in the spawned dev child but the vault (safeStorage) is main-only, so MAIN calls `prepareLocalProviders()` at dev-server spawn — reads the vault, writes `~/.omp/agent/models.yml`, registers egress, and injects the keys into the dev child's env (inherited by the omp grandchild). Integrated live proof: the real `materializeLocalProviders` wrote `~/.omp/agent/models.yml` + returned the child env, and `omp models` with that env listed BOTH `ollama-local` and the env-ref-authed `dgx-vienna`. 8 more tests (`local_providers_runtime.test.ts`); suite **1270 pass**; root tsc clean; desktop tsc clean except the pre-existing missing-electron-types env gap.
- **stubbed:** no Settings UI yet (P-LOCAL.3). Providers configured before launch route on start; a provider added/changed at runtime takes effect on the next app restart (the child env is set at dev-spawn) — P-LOCAL.3 will add an apply/restart trigger. A call-level token-generation proof needs a running Ollama (else the `omp models` listing is the proof). `basic` auth overlay emission deferred.
- **next:** P-LOCAL.3 — the collapsed Settings → Local Providers card (add/edit/delete servers+models, store key to vault via `lucid:credStore`, reachability/TLS "test connection", apply/restart trigger).

## P-LOCAL.1: Local Providers foundation — securely declare self-hosted / custom / VPN-routed LLMs (ADR-0135)
- **shipped:** the pure core for pointing LUCID at a self-hosted / custom OpenAI-compatible LLM (Ollama, llama.cpp, vLLM, a DGX box over a SonicWall VPN). New `desktop/local_providers.ts`: `LocalProviderDef` (a DECLARATION — endpoint + models + `authKind` + opaque `vaultRef`, **never a secret**); `validateLocalProvider` fail-closed (non-http(s) URL, bad slug, zero/dup models rejected; a provider id that would SHADOW a built-in vendor like `anthropic`/`openai` is refused; `scanForInlineSecret` rejects a pasted key — mirrors the ADR-0134 guardrail); `toOmpConfigOverlay` emits the exact `{providers:{<id>:{baseUrl,api,apiKey?,headers?,models:[…]}}}` shape omp loads (secret injected from the vault by MAIN at spawn; a provider whose required secret is ABSENT is SKIPPED, never emitted half-authenticated); `egressProposal` turns the endpoint host into a domain/IP whitelist proposal + AuthRef→vault. `settings_store.ts` gains `localProviders` CRUD (validated before write; the settings file holds the `vaultRef`, never the key). Feasibility confirmed against the installed omp 16.0.8 — the emitted overlay is schema-valid against omp's real model-config schema (root + model-entry fields verified). Proof: 17 tests (`local_providers.test.ts`) + `make demo-P-LOCAL.1`; full suite **1259 pass** / only the 5 pre-existing fs_browse Windows fails; root tsc clean; ADR-0135 written. No frozen-contract touch, no version bump.
- **stubbed:** the RUNTIME delivery is not wired yet — I confirmed the overlay SHAPE matches omp's schema but `omp models` did not surface it via `--config` (that flag loads the config.yml, a different file from the `~/.omp/models.json` custom-provider registry); resolving omp's exact models.json load path (and whether a catalog reload is needed) is the first task of P-LOCAL.2. No Settings UI yet (P-LOCAL.3). `basic` auth is declared but its overlay emission is deferred.
- **next:** P-LOCAL.2 — materialize the overlay for `omp acp` at spawn (decrypt the vault secret in MAIN → transient 0600 overlay / child env → the correct omp load path), auto-register egress in the whitelist, and LIVE-verify a custom model routes to a local OpenAI-compatible endpoint. Then P-LOCAL.3 (the collapsed Settings → Local Providers UI + health check).

## P-PERF.5: switch-path hygiene - optimistic model switch, write-behind lastModel, memoized load + picker (ADR-0132)
- **shipped:** switching models/modules no longer blocks on the backend. `applyConfig` paints OPTIMISTICALLY (badge/status/composer instantly; the omp round-trip reconciles in the background; failure keeps the prior keep-optimistic semantic but now warns honestly instead of silently). `settings_store.setLastModel` is a 250ms generation-token write-behind - a picker flip-burst coalesces to ONE write; `lastModel()` is read-your-writes; `flushPendingSettings()` (exported, exit-hooked) makes it deterministic; ONLY this low-stakes setter is deferred (keys/MCP/scopes stay sync). `load()` is memoized on mtime+size with `structuredClone` results (read-modify-save semantics preserved; TOCTOU existsSync pair removed; `LUCID_GUI_SETTINGS_FILE` per-call test seam). The model picker memoizes its built rows (list+selection+query+collapse+gov-order key) so reopening reuses the last build. Proof: 6 tests (`settings_perf.test.ts`, no wall-clock waits) + `make demo-P-PERF.5`; suite 1152 green (5 pre-existing fs_browse Windows-host fails untouched; the asksage diag test needs LUCID_ASKSAGE_DEBUG unset - it leaks from a dev-mode LUCID launch on this machine); tsc root+desktop clean; bundle ok; sidecar ok; license headers ok. The external-edit test CAUGHT a real same-mtime-tick staleness bug -> memo key now includes size. **Closes the battery-perf epic (ADR-0129-0132).**
- **stubbed:** no debounce on rail-button clicks (panel switches are now cheap enough that it wasn't warranted); the picker memo keeps only the last build (one entry - reopen-same-state is the common case); streaming-markdown incremental render (P-PERF.6, optional) not started.
- **next:** battery epic complete. Optional P-PERF.6 (incremental streaming markdown render) if chat-stream CPU shows up in practice; otherwise back to the feature backlog.

## P-PERF.4: incremental session index + tail-first transcripts + AC-only prefetch (ADR-0131)
- **shipped:** the sidebar poll no longer re-reads the whole chat history. `sessions.ts` gains a module-level index keyed by mtime+size: `listSessions` re-parses ONLY changed files (append-only .jsonl always bumps both), caches empty/probe skip-verdicts, prunes deleted files per root, and stays cwd-agnostic (workspace switches don't invalidate). A warm poll is O(stat) - the demo's 30-session corpus: cold scan 30 parses, 10 polls add ZERO, one appended turn costs exactly 1 re-parse with the fresh turn count shown. `sessionMessages(id, limit, root?)` now returns `TranscriptPage {messages,total}` (tail-first; limit 0 = all) through `/api/session?limit` + `bridge.sessionMessages(id, limit?)` (tolerates an older server's bare array); `resumeSession` loads `RESUME_TAIL=400` (matches the ADR-0084 cache cap) and prepends an honest "Showing the last N of M" note when truncated. `warmTranscripts` prefills the SWR cache for the 5 most-recent sessions at idle - ONLY at perf tier `full` (prefetch is anti-battery), aborting mid-warm on unplug. Proof: 5 tests (`sessions_index.test.ts`) + `make demo-P-PERF.4`; suite 1147 green (5 pre-existing fs_browse Windows-host fails untouched); tsc root+desktop clean; bundle ok; sidecar ok; license headers ok.
- **stubbed:** no "load older messages" UI yet (the tail note is honest but not clickable - the full history stays on disk and export paths still get everything); the index is per-process (a GUI-server restart re-scans once, by design - no on-disk index file to go stale).
- **next:** P-PERF.5 - async settings write + optimistic model switch + build-once model picker (the last item from the battery investigation).

## P-PERF.3: KG layout continuity + energy-based settle exit (ADR-0130)
- **shipped:** the "nodes wildly pulled around" mount explosion is gone for every RE-open. `graph.ts` `GraphPerfOpts` gains `positions`/`onPositions`: destroy harvests node x/y into `app.ts kgLayoutCache` (module-level Map, keyed `personal`/`code:file`/`code:symbol`) and the next mount seeds from it - pure `kg_ops.ts settleStart` decides: fully seeded = STATIC paint (0 sim frames + a one-time fit), >=80% seeded (live refresh) = 120-frame nestle for just the newcomers, else full budget. Cold opens get pure `settleDone`: the tick loop accumulates kinetic energy and ends the O(n^2) sim once mean motion drops under `KE_REST` after a 30-frame grace (final fit included) - a typical decay exits at frame ~64 vs the fixed 480 (~87% of the budget never runs). IN-MEMORY only per the ADR-0084 boundary (entity-id-keyed positions never touch disk). Proof: 9 tests in `kg_ops.test.ts` + `make demo-P-PERF.3`; suite 1142 green (5 pre-existing fs_browse Windows-host fails untouched); tsc root+desktop clean; renderer bundle ok; license headers ok.
- **stubbed:** cold APP starts still simulate (positions are deliberately not persisted - privacy boundary; the energy exit bounds the cost); no on-disk cache for the non-private code graph either (deferred until proven needed); `update()`'s reheat-on-change behavior untouched.
- **next:** P-PERF.4 - main-process session index (mtime-incremental listSessions) + tail-first paginated transcripts + AC-only prefetch warm.

## P-PERF.2: power/spec-aware performance tiers — battery-adaptive KG rendering + poll backoff (ADR-0129)
- **shipped:** a battery-throttled laptop no longer starves the UI. New pure `desktop/renderer/perf_tier.ts`: `resolveTier` (user override wins; auto: discharging ≤20% → minimal, on-battery / ≤4 cores / reduced-motion → reduced, else full; unknown signals NEVER degrade), `pollDelay` (the 1s/4s/15s app.ts polls now stretch 4× on battery, 4× more hidden, skip work while hidden, catch up on visibilitychange), `graphOpts` + non-mutating `capGraph` (reduced/minimal mount the KG calm — no particles, shorter O(n²) settle — with a top-hubs cap; full = today). `graph.ts` gains `GraphPerfOpts` + live `setCalm()` (plug/unplug calms/wakes in place, no remount). At minimal the KG paints a pause card BEFORE the decrypt (“the agent still reads and writes your knowledge”) with a one-shot “Render anyway”; a `#kgPerf` chip cycles auto→full→reduced→minimal (persisted `lucid.perfMode`, junk fails safe to auto). Render-tier ONLY — the agent's KG access takes no tier input. Proof: 19 tests (`perf_tier.test.ts`) + `make demo-P-PERF.2`; suite 1133 green (5 pre-existing fs_browse Windows-host fails untouched); tsc root+desktop clean; renderer bundle ✓; sidecar pytest ✓.
- **stubbed:** live plug/unplug adapts calm + polls but does NOT re-cap/remount an open graph (next open applies the tier); Battery API absent (some desktops) = always plugged-in — by design, degrade only on evidence; deeper fixes tracked as P-PERF.3 (KG layout persistence + energy-based settle exit), P-PERF.4 (main-process session index + paginated transcripts + AC-only prefetch), P-PERF.5 (async settings write, optimistic model switch).
- **next:** P-PERF.3 — persist KG node positions so a cold open is a static paint (kills the “wild node explosion” outright) + energy-based early settle exit.

## chore: Business Source License 1.1 (ADR-0086)
- **shipped:** the core is now licensed **BUSL-1.1** (HashiCorp/Terraform model). Root `LICENSE` (Licensor TechLead 187 LLC · Licensed Work LucidAgentIDE · non-compete production grant · Change Date 2030-06-27 · Change License MPL-2.0). `tools/license_headers.ts` idempotently applied `Copyright (c) 2026 TechLead 187 LLC` + `SPDX-License-Identifier: BUSL-1.1` to **278** first-party source files (TS `//`, Py `#`), EXCLUDING `vendor/oh-my-pi`, `node_modules`, `desktop/release`, `.venv` (they keep their own licenses). `make license-headers` / `make license-check` (CI guard). `package.json` → `"license": "BUSL-1.1"`. README corrected ("OSS core" → "source-available core"; the old All-Rights-Reserved note → BSL summary). Verified: tsc clean, sidecar pytest green, `harness/prompt` byte-stable-prefix tests green (headers don't affect the frozen prefix), bundle OK. **Not legal advice** — counsel should review; LLC registering (FL).
- **stubbed:** a licensing@ contact email (LICENSE points at the GitHub repo for now); a CI workflow step calling `make license-check` (target exists, wiring it into the CI yaml is a follow-up).
- **next:** —

## P-KG-INGEST.4: true ingest concurrency — dedicated omp connection (#136, ADR-0085)
- **shipped:** extraction now runs on its OWN omp connection, never the chat one. `acp_backend` lazily spawns a 2nd `omp acp` (`utilAcp`) with its own event sink (`utilSink`, text-only); `complete()` routes via pure `util_conn.ts completionPath()` → **dedicated** (`completeOn`, flat-out, no ChatGate yield) when the util omp spawned, else **shared-fallback** (`completeShared` = the old path verbatim: shared connection + listener-swap + ChatGate). So a 25-min AI import no longer competes with chat at all; a host that can't run a 2nd omp degrades safely to today's behavior. `restart()` tears down both. Supersedes P-KG-INGEST.3's yield (now the fallback). Proof: `util_conn.test.ts` (3) + `make demo-P-KG-INGEST.4` for the routing/fail-safe contract; chat path UNCHANGED → desktop+harness suites green (the load-bearing regression check). tsc clean.
- **stubbed:** the live "import while chatting stays smooth" property is integration behavior (real omp + model) — verified here by design + fail-safe + the suite; a manual end-to-end check is the follow-up. The util omp drops the chat-only system-prompt appends (delegation/build policy) since extraction is text-only.
- **next:** backlog clear again — KG epic + perf + concurrency all shipped (ADR-0075–0085).

## P-PERF.1: snappy cached UI — instant session list + transcripts (#134, ADR-0084)
- **shipped:** a returning user gets an instant UI. New `desktop/renderer/swr_cache.ts` — localStorage-backed stale-while-revalidate: `renderSessions` paints the cached session list on a cold load (no skeleton flash) then refreshes + re-caches; `resumeSession` paints `cachedTranscript(id)` instantly (no blank thread) then reconciles, re-rendering ONLY if `transcriptSig` differs (no flicker on a hit). Transcripts LRU-capped (15 sessions × ≤400 msgs) so localStorage stays bounded. **Privacy boundary:** only the session list + transcripts are cached — omp already stores those as plaintext `*.jsonl`, so no NEW at-rest exposure; the **encrypted KG store is never persisted to localStorage** (stays in-memory). Storage backend is injectable (in-memory fallback) → testable + fail-safe. Proof: `swr_cache.test.ts` (8) + `make demo-P-PERF.1`. ADR-0084 BUILT.
- **stubbed:** KG re-open still re-decrypts (intentionally not localStorage'd; an in-memory instant-show on same-session re-open is a possible follow-up); live panels (security/memory/usage) already instant via the 4s poll + hash-memoization, so untouched.
- **next:** P-KG-INGEST.4 — true ingest concurrency (a second omp session/process so extraction never shares the chat connection).

## P-KG-SEARCH.1: find a node in the graph (#132, ADR-0083)
- **shipped:** a `#kgSearch` box in the KG toolbar. As you type, pure `kg_ops.ts matchNodes(nodes, query)` (case-insensitive substring; empty → clear) returns matching ids → `graph.setSearch(ids)` rings + brightens matches, **dims** the rest, and **centers** on them (`computeFit` over the matched subset, reusing the #112 fit math). Esc clears; an active search survives a live remount (like relate mode). Display-only — no store/scan change, no new per-frame cost (just node-class toggles). Proof: `kg_ops.test.ts` matchNodes + `make demo-P-KG-SEARCH.1`; renderer bundle ✓. ADR-0083 BUILT.
- **stubbed:** no fuzzy/typo-tolerant match (substring only); no next/prev-match cycling when several match.
- **next:** the KG view is now navigable on big imported graphs; epic + follow-ups (ADR-0075-0083) all shipped.

## P-KG-REL.3: remove a relationship (#130, ADR-0082)
- **shipped:** the node panel now lists a node's **Relationships** (direction arrow + label) each with a remove (×) — closing the create-only asymmetry of REL.1/.2. New `store.removeLink(from, to, relation?)` (data layer) + `unrelateEntities` (`desktop/personal.ts`, mirrors `relateEntities`) + `POST /api/personal/unrelate` + `bridge.personalUnrelate`. Removal is optimistic (`kg_ops.ts removeEdgeOptimistic`, rollback-safe) then reconciled with the server — symmetric with the forget flow. Authored edges stay first-party; nodes/facts untouched. Proof: `kg_ops.test.ts` removeEdgeOptimistic + `make demo-P-KG-REL.3` (optimistic + `store.removeLink` persists only the targeted edge). ADR-0082 BUILT.
- **stubbed:** no edit-in-place of a relation's label (remove + re-add); no multi-edge bulk remove.
- **next:** KG import-feedback epic + all follow-ups (ADR-0075-0082) shipped.

## P-KG-INGEST.3: chat stays responsive during an AI-mode ingest (#125, ADR-0081)
- **shipped:** a long AI import no longer freezes chat. `desktop/chat_gate.ts ChatGate` (begin/end/whenIdle) lets background extraction yield to a live chat turn: `acp_backend.prompt()` brackets a chat turn with `chatGate.begin()/end()`; `complete()` (every util completion — import extraction + the /goal checker) `await chatGate.whenIdle()` before creating its session. So while the user chats, the import pauses between extractions and resumes after the reply — chat preempts with ≤1 in-flight extraction of latency instead of waiting out the whole import. Zero overhead when idle (`whenIdle()` resolves synchronously). Fail-safe: `end()` is in `prompt()`'s `finally` so a stalled chat can't pause the import forever. Proof: `chat_gate.test.ts` (5) + `make demo-P-KG-INGEST.3`. ADR-0081 BUILT.
- **stubbed:** a SECOND omp process dedicated to extraction would remove even the one-extraction latency (true concurrency) — deferred as a much larger change; the gate delivers responsive chat with a tiny surface.
- **next:** ALL KG import-feedback work + the 4 backlog ADRs (0078-0081) are now shipped. Backlog clear.

## P-VAULT-HINT.2: fact count in the locked-vault hint (#124, ADR-0080)
- **shipped:** the locked-vault hint now carries a COUNT (`facts="N"` / "about N stored facts") when known. Captured **in memory** at lock time (`lockPersonal`/`lockCui` snapshot `store.graph().facts.length` into `lastFactCount`) and passed to `lockedVaultHint` via `recallPreamble`. **Deliberately NOT an on-disk manifest** — a plaintext count next to the encrypted vault would leak "this user has N facts"; in-memory means no disk surface + no decrypt. Count appears in the common unlock→use→lock→ask flow; a fresh locked start falls back to the boolean form (ADR-0077). Still content-free (a number, never the facts); CUI counts kept per-compartment. Proof: `vault_hint.test.ts` (+3) + `make demo-P-VAULT-HINT.2`. ADR-0080 BUILT.
- **stubbed:** a CROSS-RESTART count needs the on-disk manifest — left as an opt-in follow-up (managed-config gated per ADR-0077), off by default; the privacy tradeoff is the reason it's not the default.
- **next:** P-KG-INGEST.3 ingest concurrency (#125) — the last backlog item.

## P-KG-INGEST.2: "Clear ingest sessions" bulk action (#123, ADR-0079)
- **shipped:** the grouped throwaway extraction sessions are now bulk-deletable. `desktop/sessions.ts clearIngestSessions(cwd, root?)` removes a file only when it's BOTH this workspace's AND an extractor throwaway (`isIngestPrompt`) — a real chat is never touched; returns the count, idempotent. `POST /api/sessions/ingest/clear` + `bridge.clearIngestSessions()`; renderer adds a trash button on the "Knowledge Graph Ingest · N" group header with a confirm toast (KG store untouched — only omp transcripts). Proof: `sessions_ingest.test.ts` (+2: clears only ingest, workspace-scoped) + `make demo-P-KG-INGEST.2`. ADR-0079 BUILT.
- **stubbed:** still no ephemeral-session SDK seam (omp persists ingest sessions up front; this is the cleanup path); no auto-clear-on-import-finish (the user clears when they want).
- **next:** P-VAULT-HINT.2 locked count (#124), P-KG-INGEST.3 ingest concurrency (#125).

## P-KG-REL.2: custom relation labels (#122, ADR-0078)
- **shipped:** the Relate bar gains an optional label input (`#kgRelateLabel`, max 40, placeholder "related"); both gestures (drag-to-relate + multi-select chain) read it via `currentRelationLabel()` → pure `kg_ops.ts resolveRelationLabel` (trimmed, or "related" when blank). The label flows through the existing optimistic path + `bridge.personalRelate`; backend `relateEntities`/`sanitizeRelation` already sanitize + cap it (no backend change). Proof: `kg_ops.test.ts` resolveRelationLabel cases + `make demo-P-KG-REL.2` (custom "deploys with" round-trips through the encrypted store). ADR-0078 BUILT.
- **stubbed:** Enter-to-relate in the label input (Relate button works); no per-edge label editing after creation.
- **next:** P-KG-INGEST.2 clear ingest sessions (#123), P-VAULT-HINT.2 locked count (#124), P-KG-INGEST.3 ingest concurrency (#125).

## P-VAULT-HINT.1: locked-vault existence signal (#111, ADR-0077)
- **shipped:** with the vault locked, the agent used to get nothing from `recallPreamble()` and answered "what do I like?" from empty. Now, when a vault is **configured but locked** for the current scope, `recallPreamble()` (`desktop/personal.ts`) falls through to a content-free `<encrypted-vault locked="true" scope="…">` hint (pure `desktop/vault_hint.ts lockedVaultHint`) so the agent KNOWS a vault exists and **asks the user to unlock** — never guessing/fabricating. Fail-closed by construction: the builder takes only booleans + a scope label (NO graph/fact input) so it **cannot** leak decrypted content; the COUNT is omitted because it lives inside the AES blob (ADR-0077 degrade-to-boolean). First-party signal (not untrusted-delimited), in the same `<user-profile>` injection slot; stripped from session-title display (`sessions.ts` PREAMBLE_BLOCKS). CUI hard isolation (ADR-0014) preserved — a view only signals its OWN locked store. Proof: `desktop/vault_hint.test.ts` (7) + `make demo-P-VAULT-HINT.1`; tsc clean. **ADR-0077 BUILT.**
- **stubbed:** showing a fact COUNT while locked would need a non-secret sidecar manifest written on save (deferred; gated by managed-config per ADR-0077 — exposing even a count is a deployment choice). The `recallPreamble()` integration isn't unit-tested headlessly (it would touch the user's REAL vault paths via the singleton); covered by the pure hint tests + typecheck.
- **next:** all four KG import-feedback bugs + three feature ADRs are now shipped. Remaining backlog: a "clear all ingest sessions" bulk action; the locked-vault count manifest; custom relation labels (P-KG-REL follow-up).

## P-KG-INGEST.1b: collapse ingest sessions out of the chat list (#110, ADR-0076)
- **shipped:** the throwaway "Extract DURABLE facts…" omp sessions a model-mode import (and live AI-learn) mint no longer pollute the chat history. `desktop/sessions.ts` detects them by the stable `EXTRACT_SYSTEM` sentinel (`isIngestPrompt`), titles them by the actual learned snippet (`ingestPreview`) instead of the extractor prompt, and `listSessions` now returns `{ sessions, ingest }` — real chats (capped 40, so a big import can't crowd them out) vs the grouped extraction throwaways. Renderer shows a collapsible **"Knowledge Graph Ingest · N"** group (collapsed by default; expand to inspect). `bridge.sessions()` returns the split shape (tolerates a pre-1b bare-array server). Proof: `desktop/sessions_ingest.test.ts` (3) + `make demo-P-KG-INGEST.1b`; tsc clean. With 1a, **ADR-0076 is now BUILT**.
- **stubbed:** ingest sessions are still persisted to disk by omp (no ephemeral-session SDK seam wired) — they're grouped, not suppressed; a "clear all ingest sessions" bulk action is a possible follow-up. Detection keys on the `EXTRACT_SYSTEM` text (same-repo constant, so robust); if that prompt is reworded, update the sentinel.
- **next:** P-VAULT-HINT.1 (#111) — locked-vault existence signal.

## P-KG-REL.1: manual relationship authoring (#109, ADR-0075)
- **shipped:** the read-only graph can now take user-authored relationships. New `relateEntities` (`desktop/personal.ts`) validates both nodes are visible in the current scope, rejects self-links, dedups, and sanitizes the label → `store.addLink`; exposed via `/api/personal/relate` (`dev.ts`) + `bridge.personalRelate`. `graph.ts` gains a relate mode: drag one node onto another draws an edge (cursor-following ghost), or click nodes to build an ordered pick set; `app.ts` adds a **Relate** toolbar toggle + action bar (Relate/Clear) and applies edges optimistically (rollback on failure). Authored edges are first-party — they never hit the scanner and never auto-promote facts (keystone #2); links carry no trust label. Pure cores (`nodeAtPoint`/`togglePick`/`chainPairs`/`addEdgeOptimistic`) in `kg_ops.ts`. Proof: `desktop/renderer/kg_ops.test.ts` (14) + `make demo-P-KG-REL.1` (store edge persists + interaction logic); tsc clean.
- **stubbed:** custom relation labels beyond the neutral "related" default (the data layer + sanitizer already accept any string; only the inline-label UI is deferred); multi-select defaults to a chain (A→B→C), not a clique/star.
- **next:** P-KG-INGEST.1 (#110) background ingest, P-VAULT-HINT.1 (#111) locked-vault signal.

## B-KG.1: Knowledge-graph interaction polish (#112 / #113 / #114)
- **shipped:** pure DOM-free cores in `desktop/renderer/kg_ops.ts` wired into `graph.ts` + `app.ts`. **#112** `fitTransform` drops the min-scale floor 0.4 → 0.05 and re-fits at frames 90/240/SETTLE-2, so a big imported graph fits the panel on open (returns null on a 0×0 host so it never centers onto nothing). **#114** split paint into a cached `paintLayout` (expensive, only when geometry moved) + cheap `paintParticles`; `frameWork` skips idle layout repaints, throttles idle particles to ~30fps, and halts the rAF loop under reduced-motion (`kick()` resumes it). **#113** `applyForget` removes the fact (+ now-empty node + dangling edges) optimistically and snapshot-safely; the Forget handler de-dups mashed clicks (`forgettingIds`), updates the graph instantly, fires exactly one settle-toast, and rolls back on server failure. Proof: `desktop/renderer/kg_ops.test.ts` (10 tests) + `make demo-B-KG.1`; harness 542✓ / desktop 425✓ / typecheck clean.
- **stubbed:** non-calm idle still runs a throttled particle rAF (keeps the "alive" look by design — full halt is reduced-motion only); the ~20-30s `personalGraph()` decrypt cost itself is unchanged (perceived latency fixed by the optimistic path; a decrypt-cache is a separate follow-up); visual confirmation of centering/CPU/forget on a large live graph needs the user's unlocked vault (not reproducible headlessly).
- **next:** the remaining KG import-feedback items — #115 export-path recovery (bug), then the feature ADRs P-KG-REL.1 (#109), P-KG-INGEST.1 (#110), P-VAULT-HINT.1 (#111).

## B-KG.2: recoverable export location (#115)
- **shipped:** the export destination no longer flashes-and-vanishes. New `revealPath` capability through the native shell (`preload.ts` → `main.ts` `ipcMain.handle("lucid:revealPath")` → `shell.openPath`, guarded to an existing path) + `bridge.revealPath`/`canRevealPath`. Pure `desktop/renderer/kg_export.ts exportActionPlan` decides the affordances; `showExportToast` in `app.ts` keeps the toast up (timeout 0) with a `→ <dest>` line and **Open folder** (desktop) + **Copy path** actions, for both vault export and the CUI archive. Proof: `desktop/renderer/kg_export.test.ts` (4 tests) + `make demo-B-KG.2`; desktop 419✓ / typecheck clean.
- **stubbed:** no persistent "recent exports" history surface yet (the toast is recoverable but transient once dismissed; `personalExports()` already records them server-side — a future Settings list could render it); Open folder is Electron-only by design (browser build offers Copy path only).
- **next:** the KG import-feedback feature ADRs — P-KG-REL.1 (#109), P-KG-INGEST.1 (#110), P-VAULT-HINT.1 (#111).

## P-KG-INGEST.1a: non-blocking background ingest with live progress + cancel (#110, ADR-0076)
- **shipped:** the ~25-min import no longer freezes the app with no status. New `desktop/import_job.ts` runs the import as a tracked BACKGROUND job (single-flight — a 2nd start is refused; returns a `jobId` immediately so the request never blocks); `importConversations` now emits a per-message progress tick (fixed total → real countdown) and honors an `AbortSignal` (cancels at a conversation boundary, **keeping** the facts learned so far — fail-safe, no torn write). `/api/personal/import` starts the job; `/status` + `/cancel` added; `bridge.personalImport`→start + `personalImportStatus`/`personalImportCancel`. Renderer shows a persistent bottom-right **status pill** (live %/countdown + Cancel) polled every 1.2s; pure `desktop/renderer/import_progress.ts formatImportLine`. Proof: `desktop/import_job.test.ts` (5) + `desktop/renderer/import_progress.test.ts` (6) + 2 importer tests + `make demo-P-KG-INGEST.1`; harness 545✓ / desktop 452✓ / tsc clean. ADR-0076 lands with #116.
- **stubbed:** P-KG-INGEST.1b — tag distiller-minted sessions `kind:"kg-ingest"` and collapse them out of the chat list (the "Extract DURABLE facts…" pollution, ADR-0076 decision #3). Model-mode ingest still serialises through the one omp session, so live chat competes with extraction during AI imports (the pill + cancel make it tolerable; true concurrency is a deeper follow-up). Visual confirmation of the pill needs a live import.
- **next:** P-KG-INGEST.1b (session grouping), then P-VAULT-HINT.1 (#111).

## P-ENT.1: enterprise managed-policy override for the security knobs (ADR-0068, #96)
- **shipped:** extended `desktop/managed_config.ts` with the `security.{exec,egress,loop}` / `logging` / `models` schema (+ `RiskTier` T0–T4), the pure `clampToManaged` tier ceiling plus `clampEgress` / `modelAllowed` / `dangerModeAllowed` / `managedAsksageOnly` / `managedLocks` helpers (managed is a CEILING — only ever tightens, fail-safe to unmanaged), and a Windows Group-Policy channel (`parseRegistryPolicy` reads `HKLM\Software\Policies\LucidAgentIDE`; `mergeManaged` overlays the file UNDER it per leaf). Wired the enforcement points that exist today: `egress_policy.egressDecision` honors the managed egress ceiling (deny/allow-list/danger-off), `acp_backend.asksageLocked` generalizes to `managedAsksageOnly`, and `/api/managed` + the renderer lock the AskSage toggle with "Managed by <org>". 26 new tests (clamp/lock/registry/merge + egress clamp) + `demo-P-ENT.1`; full desktop suite (266) green, server typecheck clean.
- **stubbed:** exec + loop ENFORCEMENT — `exec_policy.ts` (ADR-0066) and the loop Speed↔Risk dial (ADR-0067) aren't built, so their managed ceiling/lock schema + clamp helpers ship ready-to-consume but have no live module to wire into yet. `logging` is schema-only (consumed by ADR-0069). Managed egress denial maps to "always prompt" (the allow|prompt verdict has no hard "deny"); no looser default-verdict knob (would violate tighten-only).
- **next:** ADR-0066 P-EXEC.1 (exec gate consuming the exec ceiling) and ADR-0069 P-ENT.2 (SIEM export consuming `logging`).
## R-06: subagent edits gated + attributed, no stash-masking (ADR-0055)
- **shipped:** verified + regression-locked that subagent (`task`) edits are NOT masked from the gate or code-activity attribution. With task isolation OFF (ADR-0032), a subagent edits the REAL workspace → its write/edit tool calls route through the same in-process fail-closed gate → ADR-0031 attribution counts them from the gate's tool_result hook, and `EditResultLike` carries no agent/provenance dimension (so nothing can drop a subagent's edit). `harness/runs/loc_count_subagent.test.ts` (3 tests). ADR-0055.
- **stubbed:** the stash-isolate/apply/merge masking risk only exists if isolation is RE-enabled (ADR-0032 conditions: patch-review UI + reliable Windows merge-back) — ADR-0055 is the tripwire to re-open R-06 then (gate-scan + attribute the merged diff; nested-repo dirty-state test).
- **next:** add-on PI items continue (R-08 #38, B-ADR-001 #40, B-ADR-006 #42).
## R-04: thinking-item governance (ADR-0054)
- **shipped:** `desktop/thinking_governance.ts` — `isLearnableAssistantText` / `accumulateAssistantText`: **only assistant `token` text is learnable** (eligible for `recordTurns` persistence + `learnFromTurn` distiller/promotion). Reasoning/thinking (and tool/block/subagent/usage) are display-only (ratifies ADR-0027 as a security policy): never persisted → never recalled → never exported → CUI-excluded by construction; never auto-promoted to semantic memory (keystone #2). `acp_backend.prompt()`'s `sink` now routes the per-turn `assistant` buffer through the predicate. 3 regression tests lock it.
- **stubbed:** persisting thinking in future REQUIRES scan + trust-label + promotion-gate + CUI-exclude first (gated by this ADR + the test). CI's `bun test harness` doesn't run `desktop/` yet (pre-existing; R-01 CI scope) — covered by `bun test` / `make test`.
- **next:** R-06 (subagent stash-isolation provenance) — confirm lineage/attribution track subagent edits under ADR-0032 (isolation off).
## R-02: prefix-hash regression vs omp auto-compaction
- **shipped:** `harness/prompt/prefix_compaction.test.ts` — drives a REAL omp agent session (echo model) at the pinned omp **16.0.6**, forces a manual compaction (`AgentSession.compact()` with `compaction.keepRecentTokens` lowered so a headless session is compactable), and asserts the byte-stable frozen prefix (layers 1-4, invariant #6) in `session.systemPrompt` is unchanged across the compaction AND still present verbatim in what omp hands the model on the next turn. Plus an exact-pin assertion on all four `@oh-my-pi/*` packages. Finding: omp 16.0.6 compaction operates on conversation history only (system block preserved) — the invariant HOLDS, no forced change, so no ADR (per R-02's "ADR if omp forces a change").
- **stubbed:** compaction is exercised via a lowered `keepRecentTokens` (echo turns can't reach the 20k default headlessly); the `snapcompact` strategy is not covered (it needs a vision-capable model) — the `context-full` path is tested. R-02's broader "supported-omp matrix" + scheduled bump CI is R-01 (Nicholas).
- **next:** R-01's scheduled omp-compat CI should run this test against candidate omp bumps. PRE-EXISTING baseline break unrelated to R-02 — `harness/memory/db.test.ts` asserts `appliedVersions [1..7]` but migrations `0008_memory_session`/`0009_turn_transcripts` (P8.x) make it `[1..9]`; the test wasn't updated when those landed (memory lane to fix).

-----

## P-EXT.5.0: attach-mode roadmap (planning only — ADR-0039)
- **shipped:** ADR-0039 in DECISIONS.md — designs the deferred ADR-0038 optional attach-mode (an IDE
  extension SHARING the running desktop's already-gated session instead of spawning its own `lucid acp`).
  Locked: stdio `lucid acp` stays the DEFAULT (attach is opt-in + best-effort, falls back to the launcher
  on ANY failure); token custody via an OWNER-ONLY userData handshake file `{port,token,pid,workspace}`
  (per-launch rotation; the same same-user boundary as the cred vault / encrypted store); transport reuses
  the UNCHANGED hardened loopback control-plane (ADR-0022 Host/Origin guard + ADR-0024 token) over the
  existing `/api/chat` surface; the gate stays in the desktop omp child (#4). No code this session.
- **stubbed:** all of P-EXT.5a (desktop handshake writer + opt-in toggle) / 5b (extension attach path +
  fallback) / 5c (concurrency + lifecycle) designed, unbuilt.
- **next:** resolve the KEY open security question first — workspace boundary: attach ONLY when the IDE
  folder == the desktop workspace (path containment, ADR-0022/23), else spawn `lucid acp` for the IDE's
  own folder. Then build P-EXT.5a.

## P-EXT.4b: marketplace publish pipelines (ADR-0038)
- **shipped:** the tag-triggered publish path for both editors. .github/workflows/extensions-publish.yml
  (on `ext-v*` tags / dispatch): a VS Code job (esbuild --production → vsce publish + ovsx publish) and a
  JetBrains job (gradle buildPlugin → publishPlugin). Every publish step is SECRET-GATED (no token →
  builds but skips publish, workflow stays green), so it's safe before secrets exist. build.gradle.kts
  gains intellijPlatform.publishing{token} + signing{certChain/key/password} as LAZY env providers
  (resolved only by the publish/sign tasks → the green `gradle test buildPlugin` verify job is
  unaffected). docs/EXT-SECURE-BUILD.md documents the required repo secrets + the `ext-v<x.y.z>` release
  flow. Verified by the existing Extensions CI re-configuring the project with the publishing block.
- **stubbed:** the actual publishes need the user's marketplace tokens (VSCE_PAT / OVSX_PAT /
  JETBRAINS_PUBLISH_TOKEN) + optional JetBrains signing certs as repo secrets; no version-bump
  automation (manual tag); the `lucid` launcher ships + signs with the DESKTOP installer, not here.
- **next:** attach-mode (optional) as its own security-reviewed increment — the desktop writes the
  ADR-0024 capability token to userData; the extension reads it same-machine + shares the gated loopback
  session (ADR-0022 Host/Origin guard). stdio `lucid acp` stays the default; attach-mode never bypasses it.

## P-EXT.4a: ship the compiled `lucid` launcher + standalone resolution (ADR-0038)
- **shipped:** the load-bearing integration so installed editors actually FIND the launcher. A
  package.json `bin` never materializes a node_modules/.bin/lucid shim for the package itself, so the
  installed-app path was a dead end. Fix: a desktop `compile-lucid` step (`bun build --compile`
  harness/launcher/lucid_acp.ts → <repo>/bin/lucid[.exe]) wired into dist:*, shipped via extraResources
  (bin/**) to resources/repo/bin/lucid; both extensions' installedAppLauncherPaths (ide_client.ts +
  Kotlin Launcher.kt) resolve there. lucid_acp gained execPath-based repoRoot (a --compile binary
  VIRTUALIZES import.meta), resolveScannerEnv (LUCID_SCANNER_DIR + SCANNER_PYTHON from the real on-disk
  sidecar/venv incl. the desktop userData venv), and a `lucid check` preflight command. scanner_client
  reads LUCID_SCANNER_DIR LAZILY — a module-const captured the stale virtual path (caught by running the
  compiled binary). VERIFIED LOCALLY by compiling + running the real lucid.exe: `check` → OK in-repo,
  fail-closed (gate missing) from an isolated dir, `--help` → 0. 440 harness + 261 desktop green; tsc
  clean (3 configs).
- **stubbed:** the compiled binary is ~98MB (embeds the bun runtime) — works, but a size cost; the
  installed-app scanner-venv path is best-effort (worst case = fail-closed, safe); an end-to-end install
  verify (a packaged build that actually contains bin/lucid) needs the desktop CI build.
- **next:** P-EXT.4b — marketplace publish (vsce/ovsx + Gradle publishPlugin, tag+secret gated) +
  optional token-gated attach-mode.

## P-EXT.3: JetBrains plugin — Kotlin ACP client of `lucid acp` (ADR-0038)
- **shipped:** extensions/jetbrains/ — a Gradle IntelliJ-Platform plugin (Kotlin) driving the gated
  agent over ACP from a tool window. Launcher.kt mirrors the tested ide_client.ts security core
  (isLucidBinary only-lucid filter — never a raw agent command, candidate resolution, [BLOCKED]
  parser); AcpClient.kt is the Kotlin twin of desktop/acp.ts (line-delimited JSON-RPC over stdio);
  LucidToolWindow.kt spawns `lucid acp` with the project dir as cwd, streams reply + tool activity, runs
  the FAIL-CLOSED permission round-trip (cancel/close ⇒ deny), shows the gate block banner. A SHARED
  parity spec harness/launcher/ext_parity.json pins isLucidBinary + parseBlockLine; BOTH the TS
  extension (ext_parity.test.ts) and the Kotlin ParityTest run against it → one verified contract across
  editors. 439 harness green (extracted isLucidBinary + 2 parity tests); root tsc clean.
- **stubbed:** the Kotlin DOES NOT compile/test in the Bun harness env (no JDK/Gradle) — it builds +
  runs ParityTest in CI / on a JVM machine; the security contract IS verified here via the shared spec
  on the TS side. The Swing tool-window UI is an MVP (agent_thought_chunk omitted from the log);
  publishPlugin is P-EXT.4. DECISIONS.md/ADR-0038 left to the cloud author to avoid a clash.
- **next:** P-EXT.4 — marketplace packaging (vsce/ovsx for VS Code + OpenVSX; Gradle publishPlugin for
  JetBrains), sign + ship the `lucid` bin in the installer, optional token-gated attach-mode.

## P-EXT.2: VS Code extension — thin ACP client of `lucid acp` (ADR-0038)
- **shipped:** extensions/vscode/ — a VS Code extension that drives the gated agent over ACP. Resolves
  the Lucid launcher SECURELY (lucid.launcherPath → installed app → PATH; NEVER a raw agent command —
  enforced by harness/launcher/ide_client.ts buildLauncherCandidates) and spawns `lucid acp` with the
  opened workspace folder as cwd (the path boundary, ADR-0022/23), reusing the proven desktop/acp.ts
  transport (bundled by esbuild, vscode external). A Webview chat view (activity-bar container) renders
  streaming reply + thinking + tool activity, the gate's [BLOCKED] banner, and the Ask-mode permission
  round-trip — FAIL-CLOSED (timeout/dismiss ⇒ deny). The security-critical editor-agnostic logic
  (only-lucid candidate list, block-signal parser, ACP-update mapping) is in the shared TESTED
  ide_client.ts (6 tests; JetBrains will reuse it). 437 harness + 261 desktop green; extension + root
  tsc clean; bundle builds (dist/extension.js).
- **stubbed:** end-to-end (install .vsix → gated reply → block banner in an Extension Dev Host) needs a
  real VS Code — proven here only via pure-logic tests + clean bundle/typecheck; Plan/Ask/Agent map to
  omp default/plan ids (Ask = default + per-tool prompts); marketplace publish (vsce/ovsx) is P-EXT.4.
- **next:** P-EXT.3 — JetBrains plugin (Kotlin ACP-client port + tool window, reuse ide_client
  semantics); then P-EXT.4 — marketplace packaging + token-gated attach-mode.

## P-EXT.1: `lucid acp` launcher — fail-closed ACP trust anchor (ADR-0038)
- **shipped:** harness/launcher/lucid_acp.ts — the single sanctioned `lucid acp` entrypoint the IDE
  extensions spawn INSTEAD of bare `omp acp`. Reproduces the EXACT gated command acp_backend.ts uses
  (omp -e security_extension.ts -e asksage_extension.ts [--isolate acp_config.yml] --append-system-prompt
  DELEGATION+BUILD, byte-identical order → inv #6), resolves omp (LUCID_OMP_BIN → bundled
  node_modules/.bin/omp → ~/.bun → PATH) + assets from repoRoot (dev == packaged, two levels up), and
  FAIL-CLOSES at startup: a missing gate or unreachable scanner sidecar → exit 1 with omp NEVER spawned
  (the IDE shows "agent unavailable", never an ungated agent → inv #3/#4). New `lucid` bin in
  package.json. 12 launcher tests (injected probe/spawn: exact argv, gate-can't-be-bypassed,
  kill-the-sidecar) + demo-P-EXT.1 (offline fail-closed proof; live scanner probe). 431 harness + 261
  desktop green, tsc clean (3 configs); prefix-hash demo unaffected.
- **stubbed:** the "serves a real model turn" half needs creds/omp (the offline demo proves
  command-assembly + fail-closed); translating omp's `-e`-load-failure into a clean ACP `initialize`
  error (vs exit-non-zero) is an open item; packaging the `lucid` bin into the installer is P-EXT.4.
  DECISIONS.md ADR-0038 "BUILT" status left to the cloud author to avoid a clash; design in
  docs/EXT-SECURE-BUILD.md.
- **next:** P-EXT.2 — VS Code extension (reuse desktop/acp.ts → spawn `lucid acp` → Webview Plan/Ask/
  Agent + thinking + block banner); then P-EXT.3 JetBrains, P-EXT.4 marketplace packaging/CI.

## P8.2 / Phase B: prompt/response traceability — turn transcripts (ADR-0009 Phase B, issue #12)
- **shipped:** the deferred Phase B (Alex's #12). HARNESS CORE: migration 0009_turn_transcripts.sql
  (`turns` table) + new EventName `turn_captured` (contracts.ts) + harness/memory/turns.ts —
  captureTurn archives the RAW turn in archive_chunks (by sha), escapeMarkdowns it into the turns row
  (the only text rendered), and emits a METADATA-ONLY event (ids/role/seq/sha/trust/blocked — never
  the text); getTurns reads transcripts in order. DESKTOP: the omp hook never sees the prompt/reply, so
  capture lives in acp_backend.prompt() (GUI-side, can't co-write DuckDB) → desktop/turns_log.ts appends
  sanitized+sha to ~/.omp/lucid-turns.jsonl + the event, best-effort after `done` (mirrors security_log/
  skills_log). The Phase D Logs view now surfaces them (Turn transcripts accordion + turns chip),
  closing its stub. 9 new tests (turns 6 + turns_log 3); harness 419 + desktop 261 green, tsc clean
  (3 configs), demo-P8.2 passes. Verified live (preview): panel renders transcripts, corrupt-line guard
  holds, no console errors.
- **stubbed:** GUI live path passes blocked-count 0 (per-turn finding correlation from the gate's
  security_log not yet wired); audited per-transcript raw-reveal shares Phase D's deferred raw_revealed
  gate; the harness `turns` DuckDB table is written by the tested core + demo (live capture uses the
  JSONL sidecar — the same two-process split as Phase A / security_log).
- **next:** wire the per-turn blocked-count from security_log into recordTurns; then Phase D raw-reveal
  (POST /api/dev/reveal + raw_revealed), or ADR-0015 P9.6 crypto-agility.

## P11.2: right rail UX — memory default, security triage, ledger hierarchy (ADR-0021)
- **shipped:** (1) **Default tab → Memory** — `state.inspectorTab` now initialises to `"memory"`,
  and the HTML tab buttons match (Memory gets `active` class). When the inspector is collapsed to
  the metrics rail, expanding it re-checks `hasActiveBlocks()` and overrides to Security if the gate
  quarantined something. (2) **Security triage pulse** — new `@keyframes chipPulseGlow` (glowing
  border) + `@keyframes chipShimmer` (sweeping gradient across the chip card) CSS animations.
  Applied via `.chip.alert` / `.chip.alert.alert-amber` classes conditionally when `qCount > 0`
  (quarantined → red shimmer) or `aCount > 0` (awaiting review → amber shimmer). The CSS uses
  `--chip-alert-color` / `--chip-alert-dim` custom properties so the shimmer inherits the metric's
  semantic colour. (3) **Ledger hierarchy** — `ledgerBody()` refactored into `ledgerSplit()` which
  returns `{ peek, rest }`: the snapshot card + first (highest-spend) model row are rendered in a
  `.ledger-peek` div OUTSIDE the accordion, always visible. Only the remaining N−1 models are
  wrapped inside the chevron accordion. root+desktop tsc clean.
- **stubbed:** the `onBlock` handler already calls `focusInspector("security")` on quarantine,
  so auto-override on block arrival is covered; no separate poll-driven override needed.
- **next:** P-MCP.1 (manual MCP connector + overlay UI) or P11.3 (further UX refinements).
## P10.3a/UX: proactive budget warning · copy-own-prompts · profile name · folder browser
- **shipped:** (P10.3 partial) the Claude 5-hour chip now turns RED and a once-per-window toast fires
  at ≥90% — you see the wall coming instead of stalling into it (header probes deferred; the oauth
  5-hour limit has no header + probing would consume it — see ADR-0011 note). Plus three UX fixes:
  Copy/Save .md on your OWN prompts; the saved Profile name now shows as the message label (loaded at
  boot, relabels existing turns on save); Workspace "Browse" opens an in-app folder browser (GET
  /api/fs/list) that works in BOTH the packaged app and the browser build, with git-repo badges.
  Verified live: 95% budget → red chip + warning toast; folder browser lists/navigates; user-message
  copy/save + name label. desktop tsc clean.
- **stubbed:** P10.3 live header probe for API-key providers (anthropic-ratelimit / x-ratelimit) —
  needs a live key to verify and doesn't help the oauth case.
- **next:** P10.3 header probes (when an API key is available) or P10.4 local-vs-gateway attribution.

## P11.1: chat reading experience + LaTeX (ADR-0016) · stall fix · CI/mac fixes
- **shipped:** (1) FIX — a rate-limited/stalled turn no longer hangs on "Thinking…" forever (idle
  timeout in acp_backend.prompt, resets on every event). (2) LaTeX math via bundled-offline KaTeX
  (vendored CSS + woff2; rendered up front, placeholdered through marked+DOMPurify, reinserted
  trusted; render cache; currency guard) — the one renderer dependency, airgap-clean. (3) Chat UX:
  per-message Copy + Save .md, HUD moved below the streaming line (token counter kept), wider column
  (min(1080px,94vw)), font smoothing, clearer code blocks, stick-to-bottom autoscroll, and a fix for
  orphaned model hover-cards. Also CI: mac unsigned build (identity:null) + checkout@v5 + extraResources
  excludes. Verified live (synthetic stream): math renders, HUD-below, copy/save present, tooltip
  dismisses, width applied. desktop tsc clean; JS bundle +~460KB (KaTeX).
- **stubbed:** per-code-block copy button (per-message copy covers it for now); bundling a mono font
  (system stack used); the "breaks after 3rd prompt" root cause is rate-limiting — surfaced, not
  removed (P10.3 live rate-limit probes would warn earlier).
- **next:** P10.3 (live provider rate-limit probes) so you see the 5-hour wall coming; optional
  per-code-block copy + bundled mono.

## P10.2: cross-model usage & cost ledger (ADR-0011)
- **shipped:** usageLedger() in tools/memory_data.ts aggregates per-model tokens + cost across ALL
  omp session .jsonl (with a per-file mtime cache so repeat calls are cheap). Savings is DERIVED from
  the data (cache reads billed at ~10% of input → est. savings = cost.cacheRead × 9 — no price table,
  no drift). Exposed via GET /api/usage; rendered as a "Cost & savings ledger" accordion in the Memory
  inspector — a summary card (all-models spend, est. cache savings + "% off full price", cache
  hit-rate, sessions/turns/models, provider-vs-local split) + a per-model table sorted by spend (where
  the tokens go). 5 new tests (175 harness green); root+desktop tsc clean. Verified live against the
  real ~/.omp data: 439 sessions, 11 models, $12.62 spend, $26.29 est. savings, 82% hit-rate.
- **stubbed:** local-vs-gateway split is structurally present but always subscription until a local
  runtime exists (P10.4); the savings ratio assumes Anthropic's 10% cache-read pricing for all
  providers (a reasonable estimate, labeled "est."); no per-turn/by-provider flip toggle yet.
- **next:** P10.3 — live provider rate-limit probes (replace the lagging "Claude 5 Hour" with a 5-min
  header probe); then P10.4 — local-vs-gateway attribution.

## P10.1: response activity HUD + per-model context window (ADR-0011)
- **shipped:** a live per-response HUD on the streaming assistant message — MM:SS timer counting up,
  a semantic phase label (opening guess from the user's ask, then driven by REAL tool events on the
  stream: Searching the codebase / Editing files / Running tests / Responding), and a running token +
  ~cost readout from the streamed usage events; freezes to a "Done" line with a green check on
  completion. Also surfaced each model's context window as a chip in the model picker (modelCtx +
  MODEL_INFO.ctx). All client-side, no contract change. Also updated stale ADR statuses (0014 →
  Built, 0002 → Finalized in P2.1). desktop tsc clean; renderer bundles; verified live via a
  synthetic event stream (phase transitions, cost, Done+check, timer, ctx chips).
- **stubbed:** the phase heuristic is best-effort (maps common omp tool names); no per-phase timing
  breakdown yet. Cost uses the stream's usage.cost (omp/AskSage-provided), not a local pricing table.
- **next:** P10.2 — cross-model usage & cost ledger (per-model totals, provider-vs-local, cache-savings
  card); then P10.3 (live rate-limit probes) + P10.4 (local-vs-gateway attribution).

## P9.5b: audited CUI migration + NARA records destruction (ADR-0014)
- **shipped:** the migration that MOVES legacy cui facts out of a pre-isolation main store into the
  isolated CUI store — store.ts migration primitives (importEntity/importFact/importLink preserve
  ids+timestamps and re-check the isolation guard; removeFact hard-deletes from the source);
  migrateCuiIntoStore() copies the cui subgraph to the cui store, saves it, THEN clears all cui
  (incl. forgotten) from the main store (crash-safe order, idempotent). Plus destroyCui() — the
  irreversible NARA-aligned records destruction (zeroize key + delete the encrypted cui file). New
  events personal_cui_migrated / personal_cui_destroyed (metadata-only audit); routes POST
  /api/personal/cui/{migrate,destroy}; UI = a "Move into the CUI store" button on the legacy note +
  a danger "Destroy CUI records" button (confirm gate). 3 new tests (170 harness green); root+desktop
  tsc clean; verified live: routes reachable + gated, all CUI action buttons render, no stray files.
- **stubbed:** OS-keystore custody for the cui store (passphrase path wired); pre-filling the CUI
  designation fields for the archive (still REQUIRED placeholders, ADR-0013).
- **next:** P9.6 — crypto-agility `suite` descriptor + algorithm registry + FIPS-mode/gov-build guard
  + Argon2id non-gov opt-in (ADR-0015); or the ADR-0012 layer-3 scope-declaring connector.

## P9.5a: hard CUI isolation — separate encrypted CUI store (ADR-0014)
- **shipped:** CUI now lives in its OWN encrypted store (personal-cui.v1) with its own DEK +
  passphrase, so one key never decrypts both CUI and non-CUI. store.ts gained a version-parameterized
  variant + a data-layer guard (main store REFUSES cui facts; the cui store refuses work/personal).
  desktop/personal.ts holds two stores + scope routing: cui learning/recall/graph/export route to the
  cui store; the main store never sees cui; the CUI store AUTO-LOCKS the moment CUI is deselected
  (re-auth to return); Combined never includes cui. New EventName personal_cui_store_unlocked; routes
  POST /api/personal/cui/{setup,unlock,lock}; a CUI sub-panel in the compartment selector (Create/
  Unlock/Lock, count shows "—" when locked) + a legacy-cui-in-main migration note. 8 new isolation
  tests (167 harness green); root+desktop tsc clean; verified live: new routes reachable + gated, all
  four CUI UI states render, no stray store files created.
- **stubbed:** legacy cui facts already in a pre-isolation main store are hidden (not recalled/exported)
  but not yet MOVED — that audited migration + the "destroy CUI records" action are P9.5b. OS-keystore
  custody for the cui store still a documented seam (passphrase path wired).
- **next:** P9.5b — audited migration (move legacy cui out of the main store into the isolated store)
  + records-destruction action (zeroize DEK + delete file); new events personal_cui_migrated/_destroyed.

## P9.6.0: crypto-agility + PQC readiness roadmap (planning only — ADR-0015)
- **shipped:** ADR-0015 — LucidAgentIDE is algorithm-agile + post-quantum-READY. Honest headline:
  data at rest is ALREADY quantum-resistant (AES-256-GCM + PBKDF2/SHA-256 are symmetric/hash-based;
  no asymmetric crypto at rest → no harvest-now-decrypt-later exposure for the store/archive). PQC
  enters only with asymmetric needs: FIPS 203 ML-KEM (connector key establishment / DEK wrapping),
  FIPS 204 ML-DSA (signed exports), FIPS 205 SLH-DSA + SP 800-208 LMS/XMSS (long-term NARA archival
  signatures); AES-256 + SHA-384/512 stay. Plan: a self-describing `suite` descriptor on every
  envelope/export + an algorithm registry in crypto.ts so PQC/Argon2id drop into versioned slots
  without breaking old artifacts; prefer hybrid during transition.
- **stubbed:** PQC is READY not IMPLEMENTED — Bun/BoringSSL + node:crypto don't yet expose
  FIPS-validated ML-KEM/ML-DSA/SLH-DSA; slots populated when a validated module ships. Suite
  descriptor + Argon2id opt-in land with P9.5 crypto work.
- **accreditation (NIPR/SIPR/TS):** Argon2id is safe to keep ONLY if unreachable in the accredited
  config (SC-13/IA-7 judge the as-deployed configuration). Resolution: a `gov`/`fips` build profile
  excludes non-approved algorithms from the bundle + an enforced runtime FIPS mode fails closed on any
  non-approved suite (never downgrades). SIPR/TS → CNSA/CNSA 2.0, NSA-approved, Argon2id excluded.
  Dominant gate is the un-validated BoringSSL MODULE, not the algorithm — a validated module is the
  real ATO work.
- **next:** P9.6 — add the `suite` descriptor + algorithm registry + FIPS-mode/gov-build guard
  (additive, back-compatible) and the Argon2id non-FIPS KDF opt-in (non-gov build only); wire KEM/sig
  slots when the connector + a validated PQC module arrive.

## P9.5.0: hard CUI isolation roadmap (planning only — ADR-0014)
- **shipped:** ADR-0014 — resolves ADR-0012's open "CUI isolation strength" question. Decision:
  Option A, a SEPARATE encrypted CUI store (new format personal-cui.v1, its own DEK + custody) so a
  single key never decrypts both CUI and non-CUI; the main store rejects cui writes; CUI can lock
  independently and be destroyed independently (ties to ADR-0013 NARA records destruction). Rejected
  one-file-two-DEKs (couples lifecycle) + HKDF-from-one-master (master KEK could derive both — defeats
  the goal). Phases P9.5a (store+dual-custody+routing) → P9.5b (audited migration + destroy) → P9.5c
  (UI). New EventNames + new frozen format reserved for the build increments; no code this session.
- **stubbed:** all of P9.5a–c (designed, unbuilt). Open questions now RESOLVED (2026-06-19):
  (1) separate CUI passphrase = recommend-not-force, with first-time setup UX = confirm-match +
  Caps Lock indicator + show/reveal (also retrofit the existing main-store field); (2) CUI auto-locks
  the moment it's not the selected compartment — re-auth to return; Combined never silently includes
  CUI (shows a "CUI locked" marker); (3) migration = explicit + audited, and align CUI markings/metadata
  to federal standards (ISOO CUI Registry, NARA schedules, NIEM-conformant interchange to evaluate).
  KDF decided: PBKDF2-HMAC-SHA256 STAYS (FIPS-approved; Argon2id/bcrypt are memory-hard but NOT
  FIPS-approved → not the CUI default; Argon2id reserved as a future explicit non-FIPS opt-in).
- **next:** build P9.5a — the personal-cui.v1 store + independent unlock + two-store routing (main
  store refuses cui writes; cui learning/recall/graph/export route to the CUI store).

## P9.4: audited Obsidian vault export + NARA-aligned CUI archive (ADR-0013 / ADR-0010/0012)
- **shipped:** harness/export/vault_export.ts — pure buildVault (note-per-entity, YAML frontmatter,
  sanitized-but-working links, [[wikilinks]], _index.md MOC; scope-filtered, CUI EXCLUDED by default)
  + buildCuiArchive (cui-only; CUI banner + (CUI) portion marks, SF-901-style cover sheet, NARA
  records-management manifest with a SHA-256 inventory + manifest_sha256). All text escapeMarkdown'd.
  Store gains an encrypted, in-store export audit trail (PersonalExportEvent, additive to personal-kg.v1).
  Desktop exportVault/exportCuiArchive (decrypt→write→audit, path-escape-safe) + metadata-only telemetry
  (new EventNames personal_vault_exported / personal_cui_archived). Routes POST /api/personal/{vault,
  cui-archive} + GET /api/personal/exports. UI: "Export vault" + danger "CUI archive" buttons on the
  Knowledge toolbar (CUI behind a NARA confirm). 11 new tests (171 total path); verified live: routes
  reachable + fail-safe gated when off, on-disk vault excludes CUI, CUI archive marks + manifests with
  no cross-compartment leak.
- **stubbed:** native folder picker for the destination (browser falls back to ~/.omp/lucid-{vault,
  cui-archive}); a designation form to pre-fill CUI category/agency/decontrol (today they're flagged
  REQUIRED placeholders); the scope-declaring MCP connector (ADR-0012 portability layer 3).
- **next:** ADR-0012 layer-3 connector (read-only, scope-declaring) OR hard CUI isolation
  (separate store / per-compartment DEK) if an accreditation requires it.

## P9.3: in-app SVG Knowledge Graph view (ADR-0010/0012)
- **shipped:** a hand-rolled, dependency-free force-directed SVG graph (desktop/renderer/graph.ts) on a
  new "Knowledge" rail tab. Nodes = entities (sized by fact count, coloured by a Kind/Trust lens),
  edges = links; pan / wheel-zoom / drag; click a node to drill in to its facts with a per-fact
  Forget (soft-delete). Server: personalGraph(scope) + forgetFact() in personal.ts, GET
  /api/personal/graph + POST /api/personal/forget; new EventName personal_fact_forgotten; a custom
  "graph" rail icon. Gated: shows a message when personalization is off / locked / empty.
- **stubbed:** edit (rename/relabel) facts; node-level forget; the security-lens currently recolors
  by trust (provenance overlay can deepen later).
- **next:** P9.4 — Obsidian vault export (personalization-focused, audited decrypt→write).

## P9.2: conversation distiller + scope-aware recall (ADR-0010/0012)
- **shipped:** harness/personal/distiller.ts — learn durable user-facts from a turn, FAIL-CLOSED:
  the user's text is scanned and only a clean+trusted source contributes facts (suspicious/
  quarantined/unscannable learn NOTHING — keystone #2 on the personal path). Pluggable extractor:
  heuristicExtractor (offline, the desktop default) + modelExtractor(callModel) (the production
  seam). harness/personal/recall.ts — buildRecall() makes a scoped <user-profile> block (trusted/
  untrusted facts only, escaped). New EventNames personal_fact_learned / personal_recall_injected.
  Wired into desktop: acp_backend captures the assistant reply, injects recall once per session in
  the user turn (never the frozen prefix), and runs the distiller after each turn (enabled+unlocked
  only). 8 new distiller tests (incl. quarantined/suspicious → learns nothing); 149 harness green.
- **stubbed:** desktop uses the heuristic extractor by default (no per-turn model cost); the model
  extractor is implemented + tested but needs an opt-in + a callModel wiring to avoid surprise spend.
- **next:** P9.3 — the in-app SVG Knowledge Graph view (nodes/edges, drill-down, edit/forget).

## P9.1c: Settings UX — snappy progressive load + compartment switch fix
- **shipped:** Settings now paints a shell instantly (~2ms) and hydrates each section independently —
  a slow omp/AskSage fetch no longer blocks the page (root cause of both "Settings slow" and the
  compartment feeling "stuck": the old renderSettings awaited every fetch + two 8s dataset/persona
  timeouts). Heavy sections (AskSage/Compression/Personalization/More providers) are now collapsible
  cards (shorter panel). Compartment switching is fixed + now confirms with a per-mode warning
  ("Switch to CUI?") before applying — freely changeable both ways. Right metrics rail tightened:
  left-aligned sharp metric cards, less padding, auto-grows (fit-content, 86–176px) for big numbers.
- **stubbed:** —
- **next:** P9.2 — conversation distiller (model-based, auto-gated) + scope-aware recall.

## P9.1b: personalization desktop wiring + compartments (ADR-0010/0012)
- **shipped:** Settings "Personalization" section — enable toggle (default OFF), passphrase create/unlock/lock
  flow (`desktop/personal.ts` + `/api/personal/*`), and the **Work/Personal/Combined/CUI compartment
  selector with per-mode risk notices** (green/amber/red). Store gains a `scope` field + `graph({scope})` +
  `scopeCounts()`. ADR-0012 documents compartments + scope-aware portability (Obsidian vault = portable;
  encrypted store = private; CUI never auto-exported). Verified live: enable→create→switch CUI(red)/Personal
  (green)→lock→wrong-pass fails→right-pass unlocks; test store cleaned up. 141 green, tsc clean.
- **stubbed:** OS-keystore (Electron safeStorage) custody IPC (passphrase path is wired + verified); the
  scope-aware export/connector + the CUI hard-isolation option (ADR-0012 open question).
- **next:** P9.2 — conversation distiller (model-based, auto-gated) + recall into the prompt tail, scope-aware.

## P9.1: encrypted personalization store + crypto (ADR-0010)
- **shipped:** harness/personal/crypto.ts (AES-256-GCM + PBKDF2-HMAC-SHA256, all FIPS-approved) and
  harness/personal/store.ts — the encrypted KG store (`personal-kg.v1`): entities/facts/links, DEK in
  memory only, two custody paths (passphrase-wrapped DEK; OS-keystore via an externally-unsealed key).
  New EventName `personal_store_unlocked`; `personalizationEnabled` opt-in flag (default OFF) +
  personalStorePath(). 10 new tests (round-trips, wrong-key/tamper fail-closed, forget, the event). 140 green.
- **stubbed:** desktop wiring — the Settings "Personalization" toggle UI, the Electron safeStorage IPC for
  OS-keystore custody, and the passphrase-unlock flow (the harness foundation is done + tested).
- **next:** P9.1 desktop integration (toggle + unlock + safeStorage seam), then P9.2 (distiller + recall).

## P10.0: context-window fix + observability roadmap (ADR-0011)
- **shipped:** fixed the context-window display (status bar + Memory panel showed 256k/200k for a 1M
  Gemini) via a per-model MODEL_CTX/CTX_WINDOW map keyed by short id. ADR-0011 captures the
  observability/cost-intelligence roadmap: live response HUD (MM:SS + semantic phase + cost estimate),
  cross-model usage/cost ledger + flippable savings card, live provider rate-limit probes (accurate
  "Claude 5 Hour"), local-vs-gateway attribution.
- **stubbed:** P10.1–P10.4 designed, unbuilt; pricing currently duplicated (MODEL_CTX) — should move to a
  shared API to avoid drift; provider-probe header semantics to confirm.
- **next:** continue the P9 path — build **P9.1** (encrypted personal store) now; sequence P10 after P9.

-----

## P9.0: personalization knowledge-graph roadmap (planning only — ADR-0010)
- **shipped:** ADR-0010 in DECISIONS.md — a detailed design for a private, FIPS-grade,
  inspectable **personalization** knowledge graph (a Karpathy-style "second brain" about the user
  that the agent learns/remembers/recalls to tailor responses). Refines ADR-0009 Phase C. Locked
  decisions: hand-rolled SVG graph (zero deps); dedicated AES-256-GCM encrypted store; OS-keystore
  (Electron safeStorage) + passphrase (PBKDF2) key custody; model-based auto-gated distiller. No code.
- **stubbed:** all four phases (P9.1–P9.4) designed but unbuilt. Honest FIPS posture documented
  (FIPS-approved algorithms + OS-keystore custody + a deployment checklist; Bun uses BoringSSL, so
  no FIPS *mode* in-runtime). The project's first encryption-at-rest surface.
- **next:** build **P9.1** (encrypted store + crypto + key custody + opt-in toggle; new EventName
  personal_store_unlocked; no DuckDB migration — the store is a separate encrypted file).

Roadmap phases (each its own future increment + ADR for its frozen-contract delta):
- **P9.1 store+crypto+keys+opt-in** — encrypted personal store, AES-256-GCM, OS-keystore/passphrase. (first)
- **P9.2 distiller+recall** — model-based auto-gated user-fact distiller; recall into prompt tail layer 9.
- **P9.3 KG view** — hand-rolled SVG node/edge graph, drill-down, edit/forget, security-lens toggle.
- **P9.4 vault-export** — personalization-focused Obsidian vault (audited decrypt→write, escaped).

-----

## P8.0: memory/KG/observability roadmap (planning only — ADR-0009)
- **shipped:** ADR-0009 in DECISIONS.md — a phased roadmap for the four user asks (cross-session
  memory, Obsidian KG export, prompt/response traceability, dev/admin logging). Locked decisions:
  auto-distill through the existing fail-closed gate; dev view behind a "Developer mode" toggle;
  sanitized-by-default with an audited "reveal raw (dangerous)" gate. No functional code this session.
- **stubbed:** all four phases (P8.1–P8.4) are designed but unbuilt; the auto-distiller half of
  cross-session memory already exists (rememberActivity in security_extension.ts) — the gap is recall.
- **next:** build **P8.1 memory-recall** first (migration 0008_memory_session.sql + EventName
  memory_recalled + harness/memory/recall.ts + backend.setRecall via the persona seam), per ADR-0009.

Roadmap phases (each its own future increment + ADR for its frozen-contract delta):
- **P8.1 memory-recall** — recall distilled facts into new sessions, delimited + post-cache. (first)
- **P8.2 traceability** — capture per-turn prompt/response (sanitized; raw by sha) in the ACP stream.
- **P8.3 vault-export** — Obsidian KG vault (note-per-entity, [[wikilinks]], provenance, escaped).
- **P8.4 dev-logging** — Developer-mode Logs tab over telemetry/lineage/turns + audited raw-reveal.

-----

## P-ASKSAGE.6: expandable RAG citations + premium model tooltips
- **shipped:** (a) RAG citations are now expandable — the adapter splits the trailing
  "References\n[n] …" block AskSage inlines in /query replies into a collapsed
  <details> (renders via marked+DOMPurify; URLs autolinked & hardened). Verified live:
  Log4Shell turn → "📎 3 references · grounded on 1 dataset", collapsed by default.
  (b) Premium per-model hover cards in BOTH model pickers — token-efficacy star rating
  (1–5) + "best for" + context, from a curated MODEL_INFO table; delegated, survives
  search re-render, pointer-events:none. Fixed model-picker dropdown earlier this session.
- **stubbed:** efficacy ratings are editorial guidance (no live benchmark feed); RAG
  citations only structure when AskSage emits a "References" header (inline-cite replies pass through).
- **next:** training-token usage chip; OR AskSage agents/plugins; OR headroom routing + gov review.

## P-ASKSAGE.6b: dual model ratings + panels collapsed on boot
- **shipped:** model hover card now shows TWO ratings — Token Expense (red stars) +
  Intelligence Level (green stars) — plus the model id; the green Intelligence stars also
  render inline in each dropdown row. Both slide-out panels (left sessions, right inspector)
  now start collapsed on boot. Verified live: red/green star colors, no row overflow, panels collapsed.
- **stubbed:** ratings remain editorial (no live benchmark feed).
- **next:** training-token usage chip; OR AskSage agents/plugins; OR headroom routing + gov review.

## 2026-06-18 — Increment 0: harness bring-up + invariants

- **shipped:** Toolchain (Bun 1.3.14 + uv 0.11.21); repo skeleton; omp vendored
  (`vendor/oh-my-pi@faa96a81`) + SDK installed (`@oh-my-pi/pi-coding-agent@16.0.6`);
  **ADR-0003** confirming real omp API shapes; frozen contracts (`contracts.ts`,
  `tools/result_adapter.ts`); Python scanner sidecar (zero-width / tag / bidi /
  PUA / Cf detection over NDJSON, ADR-0002); `scanner_client.ts` + fail-closed
  `gate.ts`; no-network echo model/session on omp's mock provider; `.agents/`
  framework folder + 2 vendor-trusted skills with provenance. All green:
  `demo-00` (echo + scanner + **fail-closed**), 5 bun tests, 12 pytest, tsc 0.
- **stubbed:** `makeQuarantineHook` omp pre-hook wiring (full at P2.4);
  `telemetry/events.ts` (Increment 1); DuckDB (P2.3); homoglyph / mixed-script
  detection (P2.1); `make` not installed on this host → use `bun run demo-00` /
  `bun test harness` (Makefile remains the canonical spec).
- **next:** Increment 1 — boundary contracts demo (`demo-01`): `emit()` events to
  JSONL + `ToolResult` round-trips through the adapter both ways.

-----

## 2026-06-18 — Increment 1: boundary contracts

- **shipped:** `harness/telemetry/events.ts` — `Telemetry.emit()` writes the typed
  JSONL envelope (ts/run_id/session_id/artifact_id?), validates the name against
  the `EventName` enum and **raises `UnknownEventError`** on an off-enum name
  (invariant #8); file or custom sink; injectable clock. `demo-01` proves the
  emitter + the `result_adapter` round-trip BOTH ways (PRD→omp→PRD keeps
  tool_name/success/summary/duration; omp→PRD→omp keeps text + isError). IDs minted
  via omp `Snowflake` (invariant #9). All green: `demo-01`, 15 harness tests
  (+10: events + adapter), 12 sidecar, tsc 0; demo-00 regression OK.
- **stubbed:** events.ts uses `appendFileSync` (fine at this volume; a stream is a
  later perf concern); no DuckDB ingestion yet (P3.2 reads this JSONL); finding/
  approval ID minting helper deferred until those entities exist (P2.x).
- **next:** Increment 2 — cache-optimized prompt assembly (`demo-02`): 9-layer
  composer with a byte-stable frozen prefix; push omp's auto-injected env/git/date
  into the tail; prefix-hash test identical across tasks/cwd/branch.

-----

## 2026-06-18 — Increment 2: cache-optimized prompt assembly

- **shipped:** `harness/prompt/assembler.ts` (FROZEN CONTRACT) — 9 PRD layers split
  hard at the cache breakpoint: byte-stable `FROZEN_PREFIX` (layers 1–4:
  identity/safety, tool-use/permission, coding rules, security/trust-boundary),
  volatile tail (5–9). Untrusted retrieved content enters only via `wrapUntrusted`
  (delimited, labeled, tail-only, invariant #5). `PREFIX_VERSION` gates any prefix
  change; sha256 `prefixHash` is the cache fingerprint. `demo-02` proves the prefix
  is byte-identical (2203 B, hash `e077d6fc…`) across two requests differing in
  task/cwd/branch/retrieved, AND that omp threads our prefix through as system
  block[0] (task lands in the tail). **ADR-0004** records the integration:
  passing `systemPrompt: [prefix, tail]` replaces omp's default wholesale
  (resolves ADR-0003 #5). All green: 22 harness tests (+7), 12 sidecar, demos
  00/01/02, tsc 0.
- **stubbed:** Layer-5 instruction-file loading + layer-8 volatile-context
  gathering are caller-supplied inputs (real omp instruction discovery wired in a
  later increment); tool-schema stability is omp-managed (noted, not yet asserted).
- **next:** Phase 2 / P2.1 — expand the scanner with mixed-script + homoglyph
  detection and build the adversarial fixture corpus (keystone #1, over-test).

-----

## 2026-06-18 — P2.1: Unicode scanner + adversarial fixtures (keystone #1)

- **shipped:** scanner `0.2.0` adds **mixed-script-homoglyph** detection — a
  token-level pass flagging Latin mixed with Cyrillic/Greek inside one word (the
  classic look-alike attack: Cyrillic `е` in `edit_file`, `pаypаl`, Greek omicron
  in `login`). Deliberately narrow so legit multilingual text (Japanese, Arabic,
  pure Cyrillic, Hangul, accented Latin) is NOT flagged. Adversarial corpus
  `fixtures/adversarial.py` (14 poisoned fixtures w/ expected types + 13 clean
  controls), all built via `chr()` (no literal invisibles). `test_fixtures.py`
  over-tests: every fixture fires its expected types, clean corpus is
  false-positive-free, every finding type exercised. `demo-P2.1`
  (`demo_p2_1.py`, UTF-8 stdout) prints the scan report + asserts. All green:
  54 sidecar tests (was 12), 22 harness, demos 00/01/02/P2.1, tsc 0.
- **stubbed:** confusable set is Cyrillic+Greek only (Cherokee/Coptic/fullwidth +
  a full confusables table = future, possibly a pinned offline dep per ADR-0001);
  homoglyph check is context-free (PRD's "sensitive fields" scoping comes later).
- **next:** P2.2+P2.3 — DuckDB bootstrap + security DDL, NFKC sanitation +
  sanitized-derivative + trust labeling; write artifact/scan/finding rows.

-----

## 2026-06-18 — P2.2 + P2.3: DuckDB bootstrap + sanitation + trust labeling

- **shipped:** `@duckdb/node-api` brought in (ADR-0005). `harness/memory/db.ts`
  — DuckDB wrapper + numbered-migration runner (`schema_migrations`-tracked,
  frozen-on-first-write, idempotent reopen). `migrations/0001_security_tables.sql`
  — the 7 PRD security tables (FKs within the security family; `run_id` a soft
  ref, deferred to P3.2). `sanitize.ts` — NFKC + strip zero-width/tag/bidi
  (homoglyph/PUA flagged-not-stripped). `ingest.ts` — scan → trust-label →
  sanitize → persist artifact/scan/findings/sanitized rows, **fail-closed**
  (dead scanner ⇒ artifact recorded quarantined), external-clean ⇒ `untrusted`
  (never auto-trusted), emits the P2 telemetry events. `demo-P2.3` ingests a
  multi-vector poisoned artifact and shows the rows. All green: 36 harness tests
  (+14), 54 sidecar, demos 00/01/02/P2.1/P2.3, tsc 0.
- **stubbed:** identity tables (`projects/sessions/runs`) deferred to P3.2 (hence
  soft `run_id`); approval/export/alert tables created but not yet written by a
  workflow (P2.4 approvals, P6 export); no JSONL→DuckDB telemetry ingestion yet
  (P3.2 reads the events.jsonl into tables).
- **next:** P2.4 — quarantine gate as an omp `pre`-hook on `tool_call` +
  approval workflow (notification payload, `approval_events` rows); prove
  blocked content cannot reach a tool call end-to-end through omp.

-----

## 2026-06-18 — P2.4: quarantine pre-hook + approval workflow (Phase 2 COMPLETE)

- **shipped:** `harness/hooks/quarantine_hook.ts` — `makeQuarantineExtension`, a
  real omp `ExtensionFactory` registering `pi.on("tool_call", …)` that scans the
  tool input via `scanAndDecide` and returns `{block, reason}` when quarantined,
  fail-closed. Proven through omp's OWN runtime: a poisoned tool call's
  `execute()` never runs (keystone test + `demo-P2.4`). `notification.ts`
  (`buildNotification`/`summarizeNotification`: source, trust, max severity,
  finding types, what's blocked — no raw content inline). `approvals.ts`
  (`recordApproval` → `approval_events`, emits approval_granted/denied).
  `testing/echo.ts` extended with scripted `responses`/`customTools`/`extensions`
  (mock tool-call → block → text). Replaced the Increment-0 gate stub. All green:
  45 harness tests (+9), 54 sidecar, demos 00/01/02/P2.1/P2.3/**P2.4**, tsc 0.
  **PRD Phase 2 acceptance met:** suspicious Unicode detected+classified; user
  sees finding type + severity before privileged execution; blocked content
  provably cannot reach a tool call.
- **stubbed:** notification raw/sanitized diff handles are artifact-id stubs (UI
  diff view is Phase 7); approvals are recorded but no release-re-scan loop yet
  (quarantine-release re-validation is a later refinement).
- **next:** P3.1 — verification engine (test/lint/typecheck runners wrapped) with
  the security scan as a fail-closed precondition for prompt/exec-bearing work.

-----

## 2026-06-18 — P3.1: verification engine with security precondition

- **shipped:** `harness/verification/engine.ts` — `runChecks` (spawns
  test/lint/typecheck command specs, per-check pass/fail + aggregate),
  `securityPrecondition` (a run's quarantined/suspicious artifacts that lack an
  approve/quarantine_release/promotion_approve block completion; fail_closed
  surfaced), and `verifyTask` gating: `completionAllowed = securityOk &&
  (allChecksPassed || acceptPartial)`. The security precondition is **fail-closed
  and NOT waivable** by `acceptPartial` — only a recorded approval clears it;
  partial only waives failed checks. `demo-P3.1` shows a quarantined artifact
  blocking completion despite green checks, then clearing after a
  quarantine_release approval. All green: 55 harness tests (+10), 54 sidecar,
  demos 00/01/02/P2.1/P2.3/P2.4/P3.1, tsc 0.
- **stubbed:** check specs are caller-supplied commands (repo-policy/task-type
  inference comes later); no verification telemetry event yet (EventName is a
  closed set — adding `verification_*` would be its own contract change + ADR);
  wrapping omp's built-in test/lint tools specifically is deferred (generic
  command runner suffices for now).
- **next:** P3.2 — JSONL→DuckDB ingestion (`post` hook ingests omp session JSONL
  into episodic/telemetry tables) + stable-ID guarantee; security events
  queryable & replayable.

-----

## 2026-06-18 — P3.2: JSONL→DuckDB ingestion + stable IDs (Phase 3 COMPLETE)

- **shipped:** every telemetry event now carries a stable `event_id` (Snowflake,
  invariant #9). Migration `0002_telemetry_tables.sql` adds `telemetry_events`
  (envelope columns promoted; rest kept in a `fields` JSON). `ingest_jsonl.ts`
  — `ingestTelemetryJsonl` reads events.jsonl into DuckDB, **idempotent** via
  `INSERT OR IGNORE` on `event_id`; malformed/incomplete/insert-failing lines are
  counted-skipped, never silently dropped. `queries.ts` — event-counts-by-type,
  findings-by-type, blocked-tool-calls, approvals-by-action, run-timeline
  (replay). `demo-P3.2` runs a task → ingests → re-ingests (0 new) → sample
  queries. Also fixed a real bug: the migration splitter broke on a `;` inside a
  comment → now strips line comments before splitting (the ADR-0005 caveat, hit
  for real). All green: 60 harness tests (+5), 54 sidecar, demos
  00/01/02/P2.1/P2.3/P2.4/P3.1/P3.2, tsc 0. **Phase 3 acceptance met:** stable
  IDs; security events queryable & replayable; export table audited.
- **stubbed:** ingests OUR telemetry JSONL (the security events); ingesting omp's
  own session JSONL into PRD episodic tables (tool_events/retrieval_events) is a
  later mapping task; auto-trigger via an omp session-end post-hook deferred
  (ingestion is an explicit call for now — the demo wires the full loop).
- **next:** Phase 4 / P4.1 — memory layers (working/episodic/semantic/archive) +
  state artifacts (NOW/PROGRESS/DECISIONS/FAILURES) with security metadata on
  every promoted artifact.

-----

## 2026-06-18 — P4.1: memory layers + state artifacts

- **shipped:** migration `0003_memory_tables.sql` — working_state (one snapshot
  per run), archive_chunks (raw source-of-truth + sha + artifact provenance),
  semantic_entities/facts/links. Every semantic fact carries **provenance**
  (source_artifact_id + source_archive_chunk_id) and a **trust_label** — the
  metadata the P4.3 gate will enforce. `memory.ts` — `upsertWorkingState`,
  `archiveChunk`, `promoteFact` (upserts entity, records provenance+trust),
  `getFacts`. `state.ts` — `StateArtifacts` managing NOW.md (overwritten
  snapshot) + PROGRESS/DECISIONS/FAILURES (append-only), injectable clock.
  `demo-P4.1` exercises all three layers + provenance + the state files. All
  green: 69 harness tests (+9), 54 sidecar, demos 00..P3.2 + P4.1, tsc 0.
- **stubbed:** PRD episodic tables (episode_events/tool_events/retrieval_events/
  verification_events) served by telemetry_events for now; promoteFact does NOT
  yet block suspicious sources — that GATE is P4.3 (keystone #2). semantic_links
  table created but unused until an entity-graph consumer needs it.
- **next:** P4.2 — security-aware compaction: summaries generated from sanitized
  derivatives; raw spans kept in archive; provenance links to source spans +
  scan findings preserved.

-----

## 2026-06-18 — P4.2: security-aware compaction

- **shipped:** migration `0004_compaction_tables.sql` — compaction_spans,
  compaction_summaries, compaction_promotions. `compaction.ts` — `compactSpan`
  generates the summary from **sanitized derivatives only** (the module never
  reads content_artifacts.raw_content; SQL selects sanitized_content), records
  `generated_from='sanitized'`, preserves the span's aggregate finding_count +
  artifact-id provenance, keeps raw spans in archive, and marks
  suspicious/quarantined sources promotion-INELIGIBLE (trusted/untrusted
  eligible). Injectable summarizer (LLM later); default is deterministic.
  `demo-P4.2` proves the summary has no invisibles while raw is preserved. All
  green: 75 harness tests (+6, incl. the keystone "summary from sanitized"), 54
  sidecar, demos 00..P4.1 + P4.2, tsc 0.
- **stubbed:** wiring `compactSpan` to omp's own compaction trigger is deferred
  (the transform is the security-bearing part; trigger is mechanism);
  compaction_promotions records ELIGIBILITY only — the enforced semantic-write
  gate is P4.3.
- **next:** P4.3 — semantic-promotion gate (keystone #2, over-test):
  suspicious-source promotions blocked until reviewed; resume-from-durable-state
  works; `demo-P4.3` proves a poisoned promotion is blocked.

-----

## 2026-06-18 — P4.3: semantic-promotion gate + safe resume (keystone #2, Phase 4 COMPLETE)

- **shipped:** `promotion_gate.ts` — `promoteFactGated` resolves a promotion's
  effective trust from its **source artifact's** trust (provenance wins; a caller
  CANNOT lie about trust), blocks suspicious/quarantined sources until a recorded
  approval (approve/quarantine_release/promotion_approve), and is **fail-closed**
  on unverifiable provenance (unknown source → block). Writes nothing to
  semantic memory on block; emits `memory_promotion_blocked`. `resume.ts` —
  `resumeRun` reconstructs working state + fact count and surfaces the security
  posture (unreviewed quarantined/suspicious artifacts) via the P3.1 precondition;
  `safe=false` until reviewed. `demo-P4.3` proves a poisoned promotion is blocked,
  fails closed on unknown provenance, unblocks after approval, and resumes safely.
  Over-tested (keystone #2): 11 gate+resume tests incl. the caller-cant-lie case.
  All green: 86 harness tests (+11), 54 sidecar, demos 00..P4.2 + P4.3, tsc 0.
  **PRD Phase 4 acceptance met:** suspicious artifacts can't auto-promote;
  compaction preserves provenance; a run resumes safely. Both correctness
  keystones (scanner P2.1, promotion gate P4.3) are in and over-tested.
- **stubbed:** promoteFactGated is the enforced path; compaction's
  promotion-eligibility flags (P4.2) are advisory and would feed this gate when
  compaction auto-promotes (not yet wired to auto-promote).
- **next:** Phase 5 / P5.1 — parent/child runs + subagent dispatch; each child
  run carries its own trace, sandbox, and scan lineage; store lineage.

-----

## 2026-06-18 — P5.1: parent/child run lineage + subagent dispatch

- **shipped:** migration `0005_runs_lineage.sql` — the `runs` table (the deferred
  identity table), with `parent_run_id` as a soft self-reference + kind / mode /
  sandbox_profile / status. `runs/lineage.ts` — `startRun` / `endRun` /
  `spawnSubagent` (links parent, inherits session), `getRunTree` (recursive CTE →
  nested tree with **per-run suspicious-artifact counts** = scan lineage), and
  `getLineage` (root-to-node chain). Each child carries its own trace (run_id-
  scoped telemetry), sandbox (column), and scan lineage (run_id-scoped artifacts).
  `demo-P5.1` spawns a root + 2 children + a grandchild, renders the run tree
  flagging where suspicious content entered, and shows a child's poisoned
  artifact being blocked from promotion into shared semantic memory (P4.3 gate
  across the child→parent boundary). All green: 92 harness tests (+6), 54
  sidecar, demos 00..P4.3 + P5.1, tsc 0.
- **stubbed:** sandbox_profile is recorded but not yet enforced (P5.2 maps
  profiles onto omp isolation backends + auto-downgrade); real omp subagent
  dispatch is modeled by our lineage records (wiring to omp's task system is the
  P5.2 integration); replay rendering here is a CLI tree (the Phase-7 dashboard
  consumes the same getRunTree).
- **next:** P5.2 — sandbox profiles mapped onto omp isolation backends;
  suspicious tasks auto-downgrade; security-review subagent is read-only/quarantine.

-----

## 2026-06-18 — P5.2: sandbox profiles + security-review subagent (Phase 5 COMPLETE)

- **shipped:** `runs/profiles.ts` — the 5 profiles as a policy layer over omp
  isolation: `PROFILE_CAPS` (write/exec/network + omp backend none/worktree/
  overlay) and `chooseProfile` **auto-downgrade** (suspicious → container-local,
  quarantined → quarantine, security-review/replay → read-only-audit, remote →
  remote-runner; approval lifts the downgrade; never upgrades past requested).
  `runs/security_review.ts` — `spawnSecurityReview` spawns a read-only child and
  **rejects any write-capable profile** (enforced, not convention). Extended
  `getRunTree` with per-run `findingCount` + `approvalCount` so replay renders
  injection + approval lineage. `demo-P5.2` shows the downgrade table, the
  capability matrix, the read-only security-review enforcement, and the run tree
  with injection/approval lineage. All green: 105 harness tests (+13), 54
  sidecar, demos 00..P5.1 + P5.2, tsc 0. **PRD Phase 5 acceptance met:** lineage
  stored; security-review read-only; replay renders injection/approval lineage.
- **stubbed:** profiles select the omp backend conceptually; binding
  `chooseProfile`'s output to omp's actual isolation at session-spawn time is the
  Phase-6 remote-runner integration; "overlay" resolves to fuse-overlay/ProjFS by
  platform inside omp (not re-implemented here).
- **next:** Phase 6 / P6.1 — remote runner gate: payload scanned BEFORE a run is
  created; suspicious → blocked or routed to security-review; findings + approval
  lineage on the run record.

-----

## 2026-06-18 — P6.1: remote runner gate (pre-dispatch scan)

- **shipped:** `runs/remote_gate.ts` — `dispatchRemoteRun` creates the run RECORD
  (not execution), runs the **pre-dispatch scan** by ingesting+scanning the
  comment/API payload under that run, then disposes: clean → `dispatched`
  (remote-runner); suspicious/quarantined → `blocked` (status=blocked,
  profile=quarantine) and, by default, **routed to a read-only security-review
  subagent**; fail-closed (unscannable payload → quarantined → blocked). Emits
  `remote_run_blocked`. Findings + approval lineage live on the run record
  (run_id-scoped). `lineage.ts` gained `setRunDisposition` + `blocked`/`dispatched`
  statuses. `demo-P6.1` shows clean-dispatch, poison→review, the P3.1 precondition
  blocking the build until a `quarantine_release` approval clears it, and hard
  no-route block. All green: 110 harness tests (+5), 54 sidecar, demos 00..P5.2 +
  P6.1, tsc 0. **PRD remote-runner reqs met:** payload scanned before dispatch;
  suspicious blocked/routed; run record stores findings + approval lineage; no
  privileged execution until reviewed.
- **stubbed:** the actual GitHub/Actions trigger wiring is omp's; this gate is the
  pre-dispatch policy that omp's comment/CI entrypoint would call. Re-dispatch of
  an approved run is modeled via the cleared securityPrecondition (no separate
  re-dispatch API yet).
- **next:** P6.2 — safe export + incident bundles: escaped MD report, sanitized-
  only CSV, JSON evidence bundle (raw flagged + separate), export metadata +
  payload hash; raw dangerous content never rendered by default.

-----

## 2026-06-18 — P6.2: safe export + incident bundles (Phase 6 COMPLETE)

- **shipped:** `export/safe_export.ts` — `exportMarkdownReport` (escaped MD,
  finding metadata + sanitized excerpt, raw referenced by sha only),
  `exportCsv` (sanitized-only finding rows), `exportJsonBundle` (raw OMITTED by
  default; when `includeRaw`, isolated under `raw_evidence` + flagged
  DANGEROUS_RAW_DO_NOT_RENDER). Defense in depth: `escapeMarkdown`/`csvField`
  neutralize ANY zero-width/tag/bidi/control codepoint to `\u{..}` notation, so
  an export can't emit an invisible even from unsanitized input. Every export
  writes an `export_events` audit row (type, sanitization_status, included_raw,
  reviewer, payload sha256) and emits safe_export_created / incident_bundle_
  created. `demo-P6.2` proves MD/CSV/default-JSON are invisible-free + raw-free
  while the raw bundle isolates+flags. All green: 117 harness tests (+7), 54
  sidecar, demos 00..P6.1 + P6.2, tsc 0. **PRD safe-export reqs met:** raw never
  rendered by default; sanitized/escaped derivatives only; export audit complete.
- **stubbed:** the dashboard-feed table is the CSV/finding-metadata shape here;
  rendering it as a live Observable page is Phase 7. Exports return content +
  audit row; writing files to disk is the caller's choice (custom-tool wrapper
  later).
- **next:** Phase 7 / P7.1 — Observable dashboards from DuckDB exports
  (operational + the six security dashboard views).

-----

## 2026-06-18 — P7.1: Observable dashboards from DuckDB exports

- **shipped:** `dashboards/views.ts` — the six PRD security views (findings
  overview, Unicode analysis, approval queue, quarantine review, memory-promotion
  risk, export audit) + operational (active runs), all selecting **metadata only**
  (no raw_content column is ever read). `dashboards/materialize.ts` —
  `materializeDashboards` runs every view and writes `<name>.csv` through the
  safe-export `csvField`, so the feed can never carry an invisible/control char.
  `observable/` — Framework config + `docs/{index,security}.md` pages (tables +
  Plot) consuming the CSVs, README, generated `docs/data/` gitignored.
  `materialize_dashboards.ts` CLI + `make dashboards`. `demo-P7.1` builds a
  workload, materializes all 7 views, and asserts no invisibles + expected
  contents. All green: 122 harness tests (+5), 54 sidecar, demos 00..P6.2 + P7.1,
  tsc 0. **PRD dashboard reqs met:** six security views; feed exposes metadata,
  never raw.
- **stubbed:** Observable Framework is not a harness dep (kept Bun install lean) —
  run on demand via `npx @observablehq/framework`; the materialized CSVs are the
  tested contract. Compaction-quality / verification-failures operational pages
  are future view additions on the same pipeline.
- **next:** P7.2 — replay + benchmark + prompt-version comparison; tie cache-hit
  rate / token consumption per prompt-prefix version back to Increment 2.

-----

## 2026-06-18 — P7.2: replay + benchmark + prompt-version comparison (Phase 7 + BUILD PLAN COMPLETE)

- **shipped:** `runs/replay.ts` — `buildReplay` reconstructs the run tree +
  telemetry timeline across the subtree + suspicious/injection/approval totals;
  `renderReplay` prints it. `bench/benchmark.ts` (+ migration `0006_benchmark_
  tables.sql`) — `runBenchmark` classifies each request as a prefix-cache hit/miss
  by the assembler's prefix hash, recording token splits + security outcomes;
  `cacheByPrefixVersion` + `outcomesByDimension(source|mode|model)` compare across
  versions/dimensions. `stablePrefixBuilder` vs `volatilePrefixBuilder` make the
  Increment-2 point concrete. `demo-P7.2`: stable prefix = **0.90 hit-rate / 4959
  cache-read tokens** vs the volatile anti-pattern = **0.00 / 5670 rewritten** —
  proof the KV-cache discipline holds. All green: **130 harness tests (+8)**, 54
  sidecar, **all 17 demos (00..P7.2)**, tsc 0. **PRD Phase 7 acceptance met:**
  finding-type trends inspectable; incidents comparable by model/source/mode;
  prompt changes evaluable against BOTH security outcomes and cache/token metrics.
- **stubbed:** token counts are a chars/4 estimate (swap a real tokenizer when a
  live model is wired); benchmark requests are synthetic (the framework records
  real runs once a non-echo provider is configured).
- **next:** BUILD PLAN complete (Increment 0–2, Phases 2–7). Optional follow-ups:
  real-model providers, live Observable build in CI, richer confusables set,
  compaction-quality/verification-failure dashboard pages.

## DX: memory dashboard + launcher model handoff (post-build)
- **shipped:** `/lucid:memory` + `bun run memory:tui` — a MEMORY & CONTEXT dashboard
  reading omp's own session jsonl (context-window gauge, KV-cache hit-rate proving
  invariant #6, token-growth sparkline, cost), `omp config` compaction policy,
  `agent.db` rate-limit budget, and the Lucid memory layers + promotion gate;
  shared `tools/_tui.ts` (gauges/sparklines/tables) now backs both dashboards.
- **shipped:** launcher passes `--models` (Ctrl+P live switch) and offers to
  relaunch omp after a model/provider switch, so panel choices actually reach omp.
- **next:** optional — persist last model across launches; per-turn compaction-event
  markers in the memory view once omp emits them to the session log.

## DX: web dashboard + ACP proof (Electron front-end spike)
- **shipped:** `bun run dashboard:web` — a live, auto-refreshing browser dashboard
  (tools/web/) serving the security + memory views from agent_obs.duckdb + omp,
  READ-ONLY (security reuses views.ts SQL via a READ_ONLY DuckDB adapter; memory
  via the new shared tools/memory_data.ts). Screenshotted rendering real data.
- **shipped:** `bun run acp:probe` proves omp speaks Agent Client Protocol
  (initialize handshake → caps + ~/.omp auth) — the seam an Electron/desktop shell
  (or acp-ui/Zed/JetBrains) uses. Gate stays in-process; invariants intact. ADR-0006.
- **next:** Electron shell embedding the web page + an omp `acp` chat panel;
  click-to-approve quarantine actions; SSE push instead of 4s polling.

## DX: Electron desktop GUI (chat + dashboards)
- **shipped:** desktop/ — a polished Electron shell. Renderer (vanilla TS): custom
  frameless titlebar, icon rail, sessions sidebar, streaming chat, collapsible
  Security + Memory inspector, ⌘K command palette, delayed SVG tooltips, and a
  non-modal fly-in toast when the gate quarantines a tool call. Screenshot-verified
  in-browser (bun run desktop:web); renderer + main + preload type-clean.
- **shipped:** main/preload/acp wire omp via `omp acp -e <gate>` (gate stays
  in-process on the chat path) + read-only dashboards; reuses ~/.omp credentials.
- **next:** confirm ACP session/update→event field shapes on a live model turn;
  surface tool-permission prompts in the UI; package installers (electron-builder).

## DX: desktop GUI — functional chat, model picker, zoom, omp commands
- **shipped:** captured the live omp ACP wire format and wired real chat
  (session/new → session/prompt, agent_message_chunk streaming, usage_update →
  live context/cost). main.ts/preload.ts/acp.ts use the exact shapes.
- **shipped (renderer, screenshot-verified):** titlebar Model·Mode·Thinking picker
  driven by omp configOptions (set via session/set_config_option); text-zoom
  controls (− 100% +, Ctrl ±/0; webFrame in Electron, CSS zoom in browser); the 39
  ACP slash commands surfaced in the ⌘K palette. Desktop dev port → 5319 (4318 hit
  a Windows excluded range).
- **next:** confirm tool_call event shapes in the live window; surface tool-
  permission prompts; persist per-session model choice.

## DX: real chat backend (no more simulation)
- **shipped:** desktop/acp_backend.ts — a singleton omp-ACP session (gate loaded)
  exposed by dev.ts as /api/chat (streaming), /api/config, /api/setConfig,
  /api/commands. The browser build now produces GENUINE model replies; removed the
  canned "caught an injection" simulation entirely.
- **shipped:** unified architecture — bridge.ts is HTTP-only; main.ts is a thin
  Electron shell (spawn dev server + window); preload.ts is native zoom/window only.
  Verified end-to-end: a real /api/chat prompt returned "Red, Green, Blue" with live
  usage; /api/config = 26 models, /api/commands = 39, screenshot of real reply.
- **next:** confirm tool_call event shapes on a tool-using turn; per-session model
  persistence; package installers.

## Packaging: cross-platform installers + brand icon + CI
- **shipped:** Windows NSIS installer + portable .exe (electron-builder `win`/`nsis`),
  a brand app icon (build/icon.svg → make-icons.ts rasterizes icon.png/.ico/.icns),
  and .github/workflows/build-desktop.yml (mac .dmg + win .exe on native runners,
  attaches to Releases on tags). Verified on Windows: win-unpacked builds with the
  icon embedded + repo bundled into resources/repo (harness + scanner + gate).
- **stubbed:** code signing/notarization (config builds unsigned; cert env hooks
  documented); the final Setup.exe locally needs Developer Mode — CI does it.
- **next:** run the workflow / tag a release to publish the first installers;
  optionally embed bun/omp/python for a zero-prerequisite install.

## Packaging: code signing + in-app auto-update
- **shipped:** electron-updater wired (desktop/updater.ts; packaged-only, checks
  GitHub Releases, prompts Restart-now/Later) + a `publish:github` provider; the CI
  workflow now maps per-OS signing secrets (WIN_/MAC_CSC_*, APPLE_*) gracefully
  (absent ⇒ unsigned) and attaches the update feed (latest*.yml + .blockmap) to
  releases on tags. desktop/SIGNING.md documents the secrets + release flow.
- **stubbed:** actual signing (no certs in repo — opt-in via GitHub secrets); mac
  auto-update needs a signed build (Squirrel.Mac), documented.
- **next:** embed bun/omp/python so installs need zero prerequisites.

## Packaging: embed runtimes (zero-prerequisite install)
- **shipped:** desktop/runtime.ts (resolve bundled bun/uv → app-managed → user →
  PATH; first-run bootstrap installs omp via bun + provisions the scanner
  interpreter via `uv venv --python 3.12` into userData) + splash.ts (setup window
  shown only when needed). main.ts runs bootstrap before the dev server and passes
  LUCID_OMP_BIN/SCANNER_PYTHON/PATH down; acp_backend honors LUCID_OMP_BIN. CI
  downloads bun+uv per-OS into desktop/runtimes/ (extraResources). Verified: dev
  server boots, omp returns live config via the new resolver; 130 harness tests green.
- **stubbed:** packaged-app first-run bootstrap is wired but only exercised on a
  real install/CI (can't run the Electron bundle from this host); mac arch picks
  the right bundled bun/uv at runtime.
- **next:** cut a tag to produce signed installers + smoke-test first-run on a Mac.

## P-ASKSAGE: AskSage gov gateway as an omp provider extension
- **shipped:** harness/omp/asksage_extension.ts registers AskSage as two omp
  providers via pi.registerProvider (openai + anthropic routes, x-access-tokens
  header), loaded alongside the gate (second -e). Desktop: key in Settings, gov
  models auto-listed over ACP, monthly-usage chip (5-min poll), persona dropdown
  (scanned + delimited), AskSage-only lockdown w/ auto-switch. ADR-0007.
- **stubbed:** Google/Gemini route deferred; live model reply + SSE streaming need
  real AskSage quota (fallback to non-streaming compat flagged).
- **next:** smoke-test a live AskSage turn (header on the wire, reply renders) and
  populate personas from a real account; add Gemini route.

## P-ASKSAGE.1: smoke test, model-id fix, quota increments
- **shipped:** verified the AskSage OpenAI route live (gpt-5.2 real reply, x-access-tokens
  accepted, streams); corrected gov model ids from the live /openai/v1/models (gpt-o3 etc.,
  +gpt-5.5/5.4/5.1/4.1); local adjustable monthly-token allowance (default 200k) with
  +50K/+250K/+1M/Reset increments + a Usage&Billing tooltip; Gov chip uses used(API)/limit(local).
- **stubbed:** Claude + Gemini disabled — AskSage serves them non-streamed (claude turn used
  tokens, returned no text); both land next via a custom streamSimple adapter.
- **next:** build the streamSimple adapter (AskSage native non-streaming endpoints → one
  delta) to re-enable Claude and add Gemini.

## P-ASKSAGE.2: Claude + Gemini via streamSimple adapter
- **shipped:** harness/omp/asksage_stream.ts — a custom streamSimple that calls
  AskSage's non-streaming Anthropic + Google endpoints and replays the reply through
  omp's AssistantMessageEventStream. Re-enabled Claude (opus-4/sonnet-4) and added
  Gemini (2.5 pro/flash) via pi.registerProvider({api, streamSimple}). Verified live:
  claude-sonnet-4 → "CLAUDE OK", gemini-2.5-flash → "GEMINI OK", with usage; gate
  still fail-closed on these turns. 130/130 harness tests green.
- **stubbed:** adapter is non-streaming (one delta per reply) — fine for AskSage,
  which doesn't stream these routes anyway; thinking/tools not surfaced for them.
- **next:** (optional) per-model thinking for gemini/claude if AskSage exposes it.

## P-ASKSAGE.3: more gov models + datasets in gov-only mode
- **shipped:** added verified gov models — Gemini 3.1 Pro, Gemini 3.5 Flash (Gov),
  Claude 4.5 Opus/Sonnet, Claude 4.5 Sonnet (Gov/Bedrock) — 19 gov models total
  (broken gpt-5.4-gov/-sec omitted). Gov datasets (/get-datasets, 34 KBs: DoD, Air
  Force, NIST…) now listed in Settings when AskSage-only lockdown is on.
- **stubbed:** datasets are read-only (display); not yet wired as a per-turn RAG
  `dataset` selector. AskSage has NO skills API (/get-skills 404) — the prototype's
  "skills" were local, not an AskSage feature.
- **next:** (optional) dataset-grounded queries; decide on headroom integration.

## P-HEADROOM.0: opt-in compression proxy scaffold
- **shipped:** desktop/headroom.ts (detect CLI, start/stop `headroom proxy :8787`,
  status) + /api/headroom + a Settings "Token compression" toggle. Off by default,
  no-op until installed+enabled; shows the install hint when absent. ADR-0008.
- **stubbed:** request-routing through the proxy + the gov security review (on-device
  confirm, gate-ordering, AskSage custom-upstream + x-access-tokens forwarding) —
  deliberately not wired blind; needs headroom actually installed.
- **next:** install headroom together, verify the three security checks, then route
  the OpenAI-compatible providers through it behind the toggle.

## P-ASKSAGE.4: native /query RAG route + selectable datasets
- **shipped:** asksage-query provider with an "AskSage RAG (dataset-grounded)" model
  via the streamSimple adapter's new "query" route (POST /server/query). Gov-datasets
  list is now selectable (toggle chips in gov-only mode); selected sets ground the RAG
  model's answers (env ASKSAGE_DATASETS), underlying model configurable (ASKSAGE_QUERY_MODEL,
  default gpt-5.2). Verified live: NIST_NVD_CVE-grounded turn returned a cited Log4Shell answer.
- **stubbed:** native persona-by-id on /query (env ASKSAGE_PERSONA) wired in the adapter
  but no persona-id picker yet; references shown as a count note (not expandable).
- **next:** persona-id picker for the RAG route; expandable reference citations.

## P-ASKSAGE.5: RAG persona-id picker
- **shipped:** Settings "Gov datasets & persona" section now has a native RAG-persona
  picker (dropdown of the 39 AskSage personas) → persisted as asksagePersona → exported
  as ASKSAGE_PERSONA → adapter passes persona:<int> to /query. No scan needed (an id, not
  injected text — distinct from the scanned/delimited composer persona). Also FIXED a
  double-/server bug in listPersonas (base already ends in /server) that returned null.
- **stubbed:** expandable reference citations on RAG replies (still a count note).
- **next:** expandable reference citations; OR headroom request-routing + gov security review.

## P9.6: knowledge-graph relational edges (fix: no lines between nodes)
- **shipped:** the distiller now produces LINKS, so the KG shows relational lines. Root
  cause: neither extractor emitted relations, so store.links stayed empty. Fix: model
  extractor requests+parses a `relations[{to,relation}]` array (semantic edges); the
  offline heuristic chains same-turn non-link facts with a "mentioned with" co-occurrence
  edge; distillTurn resolves a relation's target to the real turn-entity (correct kind) and
  dedups undirected. +4 tests assert links appear in store.graph().links. 356 pass.
- **stubbed:** existing pre-fix facts have no edges (only new/imported data gets them);
  no retroactive relink pass.
- **next:** P9.7 multi-vendor chat-export importer (ChatGPT/Claude → gated distill → KG).

## P9.7: multi-vendor chat-export importer (ChatGPT / Claude → KG)
- **shipped:** import a ChatGPT or Claude data export into the personalization graph through
  the SAME fail-closed distiller as live chat — every imported user message is scanned before
  any fact is stored (keystone #2). New harness modules: import_adapters.ts (detectVendor +
  parseExport for both formats) + importer.ts (gated, deferred-save, provenance-tagged
  import:<vendor>). New EventName personal_facts_imported (ADR-0017). Desktop:
  importChatExport() + POST /api/personal/import + "Import history" button in the Knowledge
  toolbar (reuses the folder browser; pick the unzipped export folder). 363 pass; tsc + bundle
  clean; endpoint verified live in preview.
- **stubbed:** import uses the offline heuristic extractor (no model cost) → modest facts; a
  model-extractor upgrade would yield richer facts + semantic edges. No Gemini/Takeout adapter
  yet (the design generalizes — ~30 lines). No ZIP unzip (point at the extracted folder).
- **next:** optional model-extractor import pass; Gemini/Takeout adapter; server-side unzip.

## P9.8: import enhancements — model extraction, Gemini, in-memory unzip
- **shipped:** (1) opt-in model extractor for imports via new backend.complete() one-shot
  (throwaway omp session, serialized, no new keys) — richer facts + real relations; capped at
  500 msgs/import, skips surfaced (never silent); "AI" toggle in the Knowledge toolbar. (2)
  Gemini Takeout (MyActivity.json) as a 3rd vendor (detectVendor/parseGemini). (3) hand-rolled
  zero-dep ZIP reader (harness/personal/unzip.ts, node:zlib) so import takes a folder, .json,
  OR the .zip directly. 368 pass; tsc + bundle clean; endpoint verified live (model flag routes
  + guards). ADR-0018.
- **stubbed:** model mode is per-message (not batched per-conversation) — simpler, reuses the
  gated pipeline, but more model calls; the 500-cap bounds cost. No zip64/encrypted-zip support
  (exports don't use them).
- **next:** optional per-conversation batching to cut model-call volume; resumable AI import
  past the 500 cap.

## P-PROV: OAuth model refresh + Perplexity + tier clarity
- **shipped:** fixed "OAuth connected but no models in the dropdown" — the running omp built its
  model list at spawn and never reloaded after an OAuth login (API keys already triggered a
  restart; OAuth didn't). Now: omp respawns when the auth-broker exits successfully, the front-end
  polls auth status after login and refreshes the model list, and a "Refresh models" button in the
  picker (POST /api/config/refresh) re-reads providers on demand. Added Perplexity (Sonar) as a
  key-based provider (its OAuth is interactive email-OTP, which our non-interactive broker can't
  drive). Added per-provider hints clarifying OAuth = subscription tier (ChatGPT-Codex /
  Gemini-CLI) vs an API key = full commercial catalog. 368 harness pass; tsc+bundle clean;
  /api/config/refresh + Perplexity verified live in preview.
- **stubbed:** OAuth-restart + post-login poll can't be exercised headless (need a real provider
  login); logic typechecks. Perplexity OAuth (OTP/macOS-app) intentionally not wired here.
- **next:** surface which credential (oauth vs key) a model came from in the picker hover card.

## P11.1: scanner homoglyph precision + source-scoped gate (ADR-0019 A+B)
- **shipped:** fixed the generate_image false positives. (A) scanner mixed-script-homoglyph now
  flags ONLY Latin-confusable Greek/Cyrillic codepoints — math (Δ Σ λ μ π) passes, real spoofs
  (Cyrillic а, Greek omicron) still caught; clean-corpus + adversarial fixtures green. (B) gate
  GatePolicy.nonBlockingTypes demotes homoglyph-only hits in the model's OWN tool content to
  recorded-but-not-blocked (suspicious), while dangerous vectors still hard-block and external
  text stays strict; fail-closed law untouched. harness 369 pass, scanner pytest green.
- **stubbed:** Part C — block observability (the chat shows blocks but the Security panel reads
  an empty DB because the omp-child gate can't co-write the GUI's single-writer DuckDB) + the
  toast "Review" + an audited "Approve & retry". Next increment.
- **next:** P11.2 — persist gate blocks GUI-side, wire Review to the finding, add approve/override.

## P11.2: security block observability + review + approve/override (ADR-0019 C)
- **shipped:** the gate's blocks now reach the UI. Root cause of "isn't in the metrics / Review did
  nothing": the gate runs in the omp child and can't co-write the GUI's single-writer DuckDB, so
  blocks only hit stderr. Fix: GUI-owned desktop/security_log.ts (append-only JSONL + in-memory),
  recorded by acp_backend on the gate's authoritative stderr signal; the generic tool_call_update
  rejection is relabelled "tool call rejected" (no longer a fake security block). /api/security
  merges liveBlocks(); Security panel gains a "Live blocks" accordion + quarantined chip + rail
  badge; toast/chip Review opens it; POST /api/security/approve + an "Approve & retry" button
  release one block (audited) and re-send the last prompt. Verified live: endpoint returns live
  blocks, approve is idempotent, panel + badge render. desktop tsc + bundle clean, harness 369 pass.
- **stubbed:** approved blocks aren't yet replayed at the omp tool level (retry = re-send the turn);
  live blocks are session/JSONL-scoped, not folded into the DuckDB quarantine views.
- **next:** none queued.

## P-FIX: silent launch (no console pop-up on Windows)
- **shipped:** the installed app flashed a black `bun-win32-x64.exe` console window on launch. Cause:
  Electron main spawned the bundled Bun GUI server with stdio:"inherit" + no windowsHide, so the
  console-subsystem child allocated its own window in the packaged (console-less) GUI app. Fixed all
  three Node child spawns (main.ts server, runtime.ts provisioning, acp.ts omp child): windowsHide:true
  and piped (not inherited) stdio with output forwarded for dev. desktop tsc clean.
- **stubbed:** Bun.spawn auth-broker (OAuth-only, transient) left as-is (no windowsHide option on Bun.spawn).
- **next:** P10.3 rate-limit header probe; ADR-0009 Phase D dev-logging view.

## P10.3: live API-key rate-limit probe (ADR-0011, completes P10.3)
- **shipped:** the deferred half of P10.3. desktop/ratelimit_probe.ts probes a keyed provider's
  rate-limit response headers (Anthropic anthropic-ratelimit-*, OpenAI x-ratelimit-*) → remaining /
  resets-at, 5-min cache, fails soft. OPT-IN (off by default; each check is one tiny request that
  costs a token or two). Pure header parsers unit-tested (4 pass). Settings/state: rateLimitProbe +
  setRateLimitProbe; GET/POST /api/ratelimits; bridge rateLimits/setRateLimitProbe; budget panel
  shows probed limits (cyan "API key · live" tag) + an in-panel toggle. Verified live: off→[],
  toggle flips, no probe fires without a key. desktop+root tsc clean, bundle OK, harness 369 pass.
- **stubbed:** live header correctness needs a real Anthropic/OpenAI key to fully validate (parsers
  tested, gating + graceful-empty verified). Probe model ids (haiku/gpt-4o-mini) are sensible defaults.
- **next:** ADR-0009 Phase D — developer-mode logging view.

## P8.4 / Phase D: developer-mode Logs view (ADR-0009 Phase D, scoped)
- **shipped:** a Settings "Developer mode" toggle reveals a read-only Logs rail panel (third
  inspector view). GET /api/dev (gated server-side on developerMode) surfaces, metadata-only +
  READ_ONLY: telemetry_events stream (new telemetryStream dashboard view), run lineage (activeRuns),
  the gate block audit (ADR-0019-C security_log), and the export audit. settings_store
  developerMode/setDeveloperMode; bridge dev()/setDeveloperMode; new desktop/ratelimit-free devHtml
  renderer + rail button (hidden until on). Verified live: off→null, toggle reveals the rail +
  renders the 4 accordions. harness 369 pass (telemetry view + count test updated), tsc+bundle clean.
- **stubbed:** per-turn transcripts (depend on Phase B / alex's #12 — omitted, not faked); the
  audited raw-reveal (POST /api/dev/reveal + raw_revealed) left as a careful follow-up.
- **next:** ADR-0009 Phase A/B (alex); optional Phase D raw-reveal; ADR-0015 PQC when FIPS requires.

## P-MCP.1: MCP connector + omp mcpServers seam (ADR-0020)
- **shipped:** the first MCP-hub increment, built as an EXTENSION of omp (inv. #1): omp already
  accepts session/new.mcpServers, so mcpServersForAcp() assembles authenticated configs (HTTP/SSE,
  bearer→Authorization header) and the hub does auth+config only — omp owns the transport.
  settings_store McpServerEntry registry (git-ignored lucid-gui.json, masked over the wire);
  GET/POST /api/mcp + /remove + /toggle (respawn omp on change); bridge mcp* methods; a Settings
  "MCP connectors" card (list/add/enable/remove). EventName mcp_server_connected added. Verified
  live: add→masked (token never leaks), toggle, remove; harness 369 pass, tsc+bundle clean.
- **stubbed:** full slide-over overlay → P-MCP.2; telemetry emission of mcp_server_connected awaits
  GUI-side telemetry persistence (two-process DuckDB); MCP tool output scanning relies on the
  existing gate (omp tool calls are already scanned) — confirm the path in P-MCP.2.
- **next:** P-MCP.2 — Entra/Okta OIDC via ephemeral-localhost PKCE + safeStorage via Electron main.

## P11.3/SEC: local control-plane hardening (ADR-0022 — SAST H1/H2/M1)
- **shipped:** CodeQL/SAST fixes for the desktop control plane (desktop/dev.ts, spawned by main.ts as
  the shipped app's data plane, + tools/web/server.ts). H1: both Bun.serve bind hostname 127.0.0.1
  (was 0.0.0.0/LAN-exposed). H2: new pure, unit-tested desktop/origin_guard.ts front-gates both
  servers — Host allowlist (defeats DNS rebinding) on every method + Origin allowlist & JSON
  content-type on state-changing methods (defeats drive-by CSRF against keys/passphrase/clone). M1:
  desktop/path_guard.ts pathWithin() confines /api/fs/list to the home subtree (was arbitrary
  readdir/js/path-injection). Verified live: legit GET 200, forged Host 403, cross-site POST 403,
  fs/list?path=/etc→home. harness 194 pass, desktop 17 pass (12 new), root+desktop tsc clean.
- **stubbed:** per-launch capability token (transport-independent 4th layer) deferred; import/vault
  `dest` paths remain user-scoped (remote/CSRF vector closed by H1/H2) — allow-list tightening is a
  follow-up. CodeQL alert IDs not machine-fetchable in-session (no list_code_scanning_alerts tool).
- **next:** optional per-launch token + import/vault `dest` containment; then back to ADR-0021 P11.2 UX.

## P11.4/SEC: GUI filesystem path containment (ADR-0023 — completes ADR-0022 M2 residual)
- **shipped:** confined the personalization endpoints' file paths to the user's home subtree, the
  same boundary M1 gave the folder browser. desktop/personal.ts gains confineToHome() (reuses
  ADR-0022 path_guard.pathWithin) run as EARLY input validation in exportVault, exportCuiArchive,
  and importChatExport — an out-of-home dest/source is rejected ("…inside your home folder") before
  any FS read/write, closing the residual arbitrary-read (import) / arbitrary-write (export dest)
  from ADR-0022 (CodeQL js/path-injection). Defaults (~/.omp/lucid-vault, lucid-cui-archive) are
  under home, unaffected. New desktop/personal_paths.test.ts (7 pass). desktop 24 pass (+7), harness
  194 pass, root+desktop tsc clean.
- **stubbed:** external-drive exports are now rejected (deliberate tradeoff — future explicit
  user-confirmed allow-list entry); setWorkspace local-folder path tightening not bundled here.
- **next:** the per-launch capability token (server-minted + HTML-injected, both runtimes); optional
  setWorkspace containment; then back to ADR-0021 P11.2 UX.

## P11.5/SEC: per-launch capability token (ADR-0024 — ADR-0022's deferred 4th layer)
- **shipped:** a transport-independent gate on the desktop control plane (desktop/dev.ts). dev.ts
  mints randomBytes(32) hex once per launch, injects it as <meta name="lucid-token"> into served
  index.html (SOP keeps cross-origin pages from reading it), and requires it via tokenValid() (new
  pure, constant-time-ish fn in origin_guard.ts) on every /api/* call except /api/health. bridge.ts
  reads the meta once and echoes x-lucid-token on all four fetch sites. Static assets/HTML need no
  token. Sits BEHIND the ADR-0022 loopback bind + Host/Origin gate (defense-in-depth). Verified live:
  HTML carries the token; /api/usage + /api/personal/unlock 403 without it, 200 with it (latter even
  with a valid Origin → independent layer); health + styles.css need none. desktop 27 pass (+3),
  harness 194 pass, root+desktop tsc clean, renderer bundles.
- **stubbed:** tools/web read-only dashboard keeps only the Host/Origin gate (serves no bridge/app.js
  to carry a token; no secrets) — low-value follow-up. Token is DOM-readable, so a renderer XSS could
  read it (already full renderer compromise; markdown is DOMPurify-sanitized) — it guards the
  network/CSRF boundary, not in-page injection.
- **next:** optional token for tools/web; setWorkspace path containment; then back to ADR-0021 P11.2 UX.

## P11.6/SEC: TOCTOU-safe import reader (ADR-0025 — CodeQL alert #15 js/file-system-race)
- **shipped:** fixed the High file-system-race in desktop/personal.ts loadExportText. Was stat-then-
  read (statSync to branch file/dir, separate readFileSync — swappable in between); now read-and-handle:
  read raw directly and let EISDIR (→ folder) / ENOENT (→ missing) classify it, and read the directory
  listing ONCE (names.includes) instead of per-file existsSync. Dropped statSync/existsSync imports.
  User-facing errors + ambiguous-folder rejection preserved. loadExportText exported for direct FS
  testing; new desktop/export_loader.test.ts (6 pass). desktop 33 pass (+6), harness 194 pass,
  root+desktop tsc clean.
- **stubbed:** readdir→readFileSync(join(dir,name)) still has a theoretical swap window, but no
  type-check is relied upon (read succeeds on what's there or fails closed) — the property CodeQL wants.
- **next:** sweep remaining CodeQL alerts (e.g. autofix #40 alert #2 string-escaping landed on master);
  optional tools/web token + setWorkspace containment; then ADR-0021 P11.2 UX.

## P11.7/SEC: CodeQL alert sweep (ADR-0026 — alerts #1,#3,#4,#5,#6; #7-12/#16/#17 dismissed by-design)
- **shipped:** five real CodeQL fixes. #3/#4 stack-trace-exposure (desktop/dev.ts + tools/web/server.ts):
  catch logs server-side, returns generic {error:"internal error"} (was String(err)). #5 file-system-race
  (harness/memory/state.ts): existsSync-then-write → atomic writeFileSync flag:"wx" (EEXIST-safe), dropped
  existsSync import. #6 insecure-temporary-file (harness/personal/store.ts): encrypted store created
  owner-only via {mode:0o600} (no 0644 window before chmod). #1 incomplete-html-attribute-sanitization
  (tools/web/index.html): dashboard esc() now escapes " and ' too (matches desktop esc) — was attribute
  XSS. Added store-perms test (0600); state reopen/no-clobber already covered. Verified live: forced
  handler error → generic body, real SyntaxError only in server log. harness 195 pass (+1), desktop 33,
  root+desktop tsc clean.
- **stubbed:** 8 "file data outbound" alerts (asksage ×6, ratelimit_probe ×2) are API keys to their own
  configured provider endpoints — intended; dispositioned dismiss-as-by-design in the UI (no code change).
  #14/#15 (personal.ts fs-race) already fixed by #41 — auto-close on next scan.
- **next:** confirm the next CodeQL run auto-closes #14/#15; optional tools/web token + setWorkspace
  containment; then back to ADR-0021 P11.2 UX.

## Design session: ACP modes + thought streaming (ADR-0027) and proactive Task delegation (ADR-0028)
- **shipped:** verification + two design ADRs, no feature code. Confirmed against pulled `master`:
  token caching green (demo02 prefix-hash; frozen prefix byte-stable, volatile in tail), harness
  370/370. Live-probed `omp acp` v16.0.8: it DOES stream `agent_message_chunk` and (thinking on)
  `agent_thought_chunk` first — root-caused the "big dump" to the GUI dropping every thought chunk
  (`acp_backend.ts` has no `agent_thought_chunk` case). Confirmed native ACP modes
  `[default, plan]` via `session/new`+`session/set_mode` (no native "ask"). Mapped the existing
  subagent data layer (P5.1/P5.2) and the delegation gaps. Wrote ADR-0027 (Plan/Ask/Agent + thought
  streaming, phased P-ACP.1/2/3) and ADR-0028 (proactive omp-Task delegation, phased P-TASK.1–4).
- **stubbed:** all implementation deferred (user chose ADRs-only). Fixed one Windows-only test bug in
  `desktop/path_guard.test.ts` (hardcoded `/` vs platform `sep`) to restore a green desktop baseline
  (207→208 pass); the guard itself was already correct.
- **next:** build P-ACP.1 (thought streaming — smallest, highest-value) as the first implementation
  increment; then P-ACP.2 (Plan/Agent selector), then P-ACP.3 (Ask round-trip); P-TASK.1 in parallel.

## P-ACP.1: live thought streaming + composer input polish (ADR-0027)
- **shipped:** the agent's reasoning now streams live. `acp_backend.ts` handles `agent_thought_chunk`
  → new `ChatEvent {type:"thinking"}` (mirrored in renderer `bridge.ts`); `app.ts` renders a
  collapsible reasoning block ABOVE the answer that fills in live ("Thinking…"), then auto-collapses
  to "Thought for Ns" when the first answer token arrives — fixing the "big dump" (thought chunks were
  previously dropped). Thinking text is display-only: never added to the assistant buffer the
  personalization distiller learns from, never persisted. New `.reasoning` CSS (own `thinkpulse`
  keyframe, no collision with the existing `pulse`). Composer polish: left padding 14→18px; `autosize`
  now grows to 3 rows (line-height×3 + padding ≈ 82px) then scrolls internally (`overflow-y:auto`),
  CSS `max-height` matched. Verified live in the browser preview: a reasoning turn streamed thinking
  then collapsed ("Thought for 4.0s", expandable to the captured reasoning); a 5-line prompt capped at
  82px with an internal scrollbar (scrollHeight 239 > clientHeight 82). desktop 208 pass, tsc clean,
  renderer bundles, no console errors.
- **stubbed:** P-ACP.2 (Plan/Agent mode selector via session/set_mode) and P-ACP.3 (Ask-mode
  permission round-trip) not started. Also fixed the Windows-only path_guard.test.ts separator bug.
- **next:** P-ACP.2 mode selector, then P-ACP.3 Ask round-trip; P-TASK.1 (surface omp's Task tool).

## P-ACP.2: Plan / Agent mode selector via ACP session/set_mode (ADR-0027) + composer polish
- **shipped:** the composer Mode control now switches the ACP session mode through the canonical
  `session/set_mode` (was routed through a config option). `acp_backend.ts` captures `sess.modes`
  (availableModes + currentModeId), tracks `current_mode_update` (so omp auto-exiting Plan reflects in
  the UI), and exposes `getModes()`/`setMode()`; `dev.ts` adds `/api/modes` (GET list+current, POST
  switch); `bridge.ts` adds `modes()`/`setMode()` + `ModeState`; `app.ts` routes mode changes in
  `applyConfig` to `setMode`, adds `syncMode()` (called on load + after every turn). Probed omp 16.0.8:
  `session/set_mode` returns `{}` and fires `current_mode_update`. Verified live in preview: dropdown
  lists Agent(default)/Plan; selecting Plan → composer label "Plan" AND backend `/api/modes`.current =
  "plan"; reset → default. desktop 208 pass, tsc clean, bundles, no console errors.
  Composer polish (follow-up to P-ACP.1 feedback): the few-px gap is now on the textarea text
  (`padding-left:4px` on the cursor), not the box frame; the Send button moved OUT of the bordered
  input box into a new `.composer-row` (bottom-aligned beside it, 8px gap) so the 3-row scroll window
  contains only text. Verified: button outside box, textarea scrolls internally (scrollHeight>client).
- **stubbed:** P-ACP.3 (Ask mode = forward session/request_permission to the UI, fail-closed) not
  started. New sessions start in omp's default (Agent) mode — the selected mode is not yet persisted
  across a new-session/respawn (re-captured from the fresh session).
- **next:** P-ACP.3 Ask-mode permission round-trip; then P-TASK.1 (surface omp's Task tool in the UI).

## P-ACP.3: Ask mode — interactive tool-permission round-trip (ADR-0027)
- **shipped:** the composer Mode control is now the full Claude-Code-style 3-way **Agent / Ask / Plan**
  (`MODE_UI_OPTS`; both the composer dropdown AND the model-badge popover seg unified on it). "Ask" is
  a client posture (omp has no native ask): omp mode stays `default` but `permissionMode="ask"` so each
  tool-permission request is forwarded to the UI. `acp_backend.ts`: `onRequest` forwards
  `session/request_permission` (only inside a live chat turn) via a new `{type:"permission"}` ChatEvent,
  parks the JSON-RPC reply in `permPending`, and resolves it from `resolvePermission()`; fail-closed —
  no decision (5-min timeout / turn-end / respawn / disconnect) ⇒ deny. The turn's idle/stall clock is
  paused while a permission is pending (`pendingPerms`). `setUiMode()` derives omp-mode + permissionMode;
  `uiMode()` derives the 3-way from (currentModeId, permissionMode). dev.ts: `/api/uimode` (POST) +
  `/api/chat/permission` (POST). bridge: `setUiMode`/`respondPermission` + `permission` ChatEvent +
  `ModeState.ui/permissionMode`. app.ts: inline `.perm` approve/deny card (allow* vs reject* options,
  resolves on click, finalizes to Denied on turn-end). New `.perm` CSS.
  Verified live (preview, omp 16.0.8 Opus): set Ask → label "Ask"; a read (`ls`) ran with NO prompt
  (omp doesn't gate reads — expected); an exec (`echo …`) raised the card with Allow once / Always allow
  / Reject / Always reject → **Allow once** ran the command + card shows "Allowed"; a second exec →
  **Reject** → card "Denied" and the model reported the command was not run. desktop 208 pass, tsc clean,
  bundles, no console errors.
- **stubbed:** Ask only prompts when omp itself emits request_permission (writes/exec), not for
  read-only tools — matches omp's approval model. "Always allow/reject" are passed through to omp as
  given (we don't yet persist a client allowlist). uiMode (incl. Ask) survives a respawn; a brand-new
  session still starts in omp default but permissionMode is preserved.
- **next:** P-TASK.1 — surface omp's Task tool in the UI (proactive subagent delegation, ADR-0028).

## P-TASK.1: surface omp's Task tool as a subagent card (ADR-0028)
- **shipped:** delegations to omp's `task` tool now show a distinct Claude-Code-style card instead of a
  nameless "other" tool chip. First confirmed the real ACP wire shape with a live probe (omp 16.0.8):
  a spawn is a `tool_call` with `kind:"other"` whose `rawInput` is `{agent, context, tasks[]}` (batch)
  or `{agent, assignment}` (flat) — detection is rawInput-shape-based; omp runs subagents as background
  jobs so the model then issues `rawInput.poll[]` calls until the `<task-result>` lands. `acp_backend.ts`
  detects the spawn → new `{type:"subagent", id, agent, title, assignments[]}` ChatEvent, and suppresses
  poll/list/cancel/wait coordination calls as noise (mirrored in `bridge.ts`). `app.ts` renders a
  collapsible cyan `.subagent` card ("Delegated to <agent>" + the assignment[s]), spinner while running,
  resolves to done when the turn ends; new `.subagent` CSS. The rawInput strings are still scanned by
  the in-process pre-hook gate (no new gating this increment, per ADR scope). Verified live: "spawn an
  explore subagent…" → card "Delegated to explore · List top-level repo files", poll noise suppressed,
  card → done with a green check, orchestrator summarized the subagent result. desktop 208 pass, tsc
  clean, bundles, no console errors. ADR-0028 status → P-TASK.1 Built (+ confirmed-wire-shape note).
- **stubbed:** no live per-subagent progress yet (card shows running→done, not streamed steps); the
  `<task-result>` payload from the final poll isn't parsed into the card. No proactive delegation
  policy yet (the model only delegates when asked) — that's P-TASK.2. No Task pre-dispatch/result
  gating beyond the existing pre-hook — P-TASK.3/4.
- **next:** P-TASK.2 — proactive delegation policy in the frozen layer-3 rules + token-efficiency check.

## P-TASK.2: proactive subagent-delegation policy (ADR-0028) + green-neon digging icon
- **shipped:** added a byte-stable `DELEGATION_POLICY` to the frozen prompt prefix (layer 3,
  `harness/prompt/assembler.ts`; `PREFIX_VERSION` 1→2) telling the model to PROACTIVELY hand
  multi-file / broad-exploration / isolable subtasks to the `task` tool, pass a crisp assignment +
  minimal context, and continue from the distilled result (keeps context small + cache hot). KEY
  finding: the FROZEN_PREFIX assembler is NOT wired to the live ACP chat (omp owns its system prompt;
  the gate injects none), so the policy is also delivered to the running model via `omp acp
  --append-system-prompt DELEGATION_POLICY` in `acp_backend.ts` — proven the flag reaches the model
  (marker probe). Byte-stable, no volatile content → stays in omp's cached prefix (invariant #6).
  Also (user request): the subagent card's spinner is a custom animated green-neon SVG of a "stick
  man peering through a looking glass" (`LOOKER_SVG` in app.ts; `.looker`/`@keyframes peer` CSS — the
  head + raised glass-arm bob slightly up/down while running, settle on done). (Superseded an earlier
  digging-shovel variant per feedback — exploring/scanning reads better than digging.)
  Verified: demo-02 prefix-hash green, assembler tests 14 pass, harness 370, desktop 208, tsc clean,
  bundles. Live: digging icon renders green (rgb 70,210,126) with neon double drop-shadow + `dig`
  animation; subagent spawn/card still works. Honest note: a read-only "overview" prompt did NOT
  delegate — the model did efficient inline parallel reads (Claude-Code-like judgment); delegation is
  guidance, not forced. The mechanism is delivered + cache-stable; behavior is the model's call.
- **stubbed:** no automated token-efficiency MEASUREMENT (relied on: policy in cached prefix, stable
  bytes, and P-TASK.1's finding that subagent sub-tool-calls don't enter the parent context). Didn't
  test a real multi-file CHANGE delegation (would mutate the repo). Policy wording is balanced to
  avoid over-delegation; tune later if it under-delegates in practice.
- **next:** P-TASK.3 — explicit Task pre-dispatch gating + lineage binding (child run via
  spawnSubagent, profile downgrade, suspicious→security-review); then P-TASK.4 result gating.

## UX polish: SAVINGS metric, smaller tiles, receding collapsed rails, auto-collapsing sessions
- **shipped (renderer-only):** (1) right metric tiles smaller (`.tile .n` 17→14px, `.l` 9→8px,
  tighter padding/min-width). (2) Renamed the CACHE tile → **SAVINGS** with a CFO/5th-grade tooltip
  ("…re-reads the same background every turn; that repeat is billed at ~1/10th the price — ~90% off…
  higher = smaller bill"); value still the prompt-cache hit %. (3) Collapsed side rails recede to
  ~55% opacity so they don't distract, full on hover/expand: `.inspector.rail` opacity .55 (+:hover 1);
  the left nav `.rail` dims via `#app-inner.sidebar-collapsed` (toggled in `toggleSidebar`). (4)
  Sessions panel auto-collapses on the FIRST chat message (`autoCollapsedSessions` one-shot in
  `send`); the nav hamburger (`#sideToggle`) reopens it (Claude-Code style). Verified live: savings
  label+tooltip, 14/8px fonts, both rails 0.55 collapsed / 1.0 expanded, hamburger reopen → 236px +
  full opacity, send → auto-collapse + dim. desktop 208 pass, tsc clean, bundles, no console errors.

## P-TASK.3: Task pre-dispatch gating + lineage binding (ADR-0028)
- **shipped:** the security gate (`harness/omp/security_extension.ts`) is now Task-aware: on a
  `task` tool_call (detected via `event.toolName === "task"` — confirmed against omp source, where the
  tool is `readonly name = "task"` and omp's own executor keys on the same) it records the dispatch
  into the run lineage, best-effort and AFTER the existing fail-closed scan (never affects the block
  decision). New `harness/runs/task_gate.ts` `gateTaskDispatch(db, parent, {block, trustLabel})`:
  clean -> `spawnSubagent` child run with a profile from `chooseProfile` (auto-downgraded:
  suspicious->container-local, else trusted-local); blocked -> `spawnSecurityReview` read-only child
  run (work NOT dispatched). New `task_gate.test.ts` (4 pass: dispatch+profile, suspicious downgrade,
  blocked->review, session inheritance). Verified live (headless `omp -e gate -p "use task..."`): a
  real explore dispatch wrote a `subagent` run under `omp-live` (mode subagent, sandbox trusted-local,
  clean) AND still ran/answered - lineage is provenance, not a gate. harness 374 pass (+4),
  fail-closed keystone still green, root tsc clean.
- **stubbed:** the chosen sandbox profile is recorded as POLICY/provenance - omp still owns the
  subagent's actual isolation (we don't force omp's backend from it). Blocked->security-review path is
  unit-tested (a live hidden-Unicode-in-assignment block wasn't separately exercised; the gate's
  fail-closed block decision is covered by the keystone tests). No subagent RESULT gating yet - P-TASK.4.
- **next:** P-TASK.4 - gate the subagent's returned text before it re-enters parent memory (keystone
  #2 / promotion_gate) + EventName additions (frozen-contract sub-increment) + DuckDB lineage rows.

## P-TASK.4: subagent result-promotion gating (keystone #2) + rail/status UI polish (ADR-0028)
- **shipped:** subagent RESULTS can no longer poison durable memory. New `gateSubagentResult(db,
  scanner, {runId, agent, resultText})` in `harness/runs/task_gate.ts`: ingest (scan + trust-label,
  raw preserved) -> `promoteFactGated` (keystone #2 blocks suspicious/quarantined unreviewed sources).
  Wired a `tool_result` hook in the gate (`security_extension.ts`) that detects the assembled
  `<task-result agent="..">` and routes it through the gate (best-effort, override-free - never alters
  tool output). Two new `EventName`s (`subagent_dispatched`, `subagent_result_gated`) in contracts.ts
  (the only frozen-contract change) + emitted from task_gate. Discovered the subagent's own
  `yield`/tool calls ALSO already hit the gate's tool_call handler (same omp process) - so results are
  gated on both seams. 2 new tests (clean result -> promoted 1 fact; hidden-Unicode result ->
  quarantined, 0 facts). Verified live (headless `omp -e gate -p "use task"`): a real explore result
  was ingested as a `subagent:explore` artifact. harness 376 pass (+2), fail-closed + promotion
  keystones green, root+desktop tsc clean. **ADR-0028 fully shipped (P-TASK.1-4).**
- **UI polish (this session, renderer-only):** right metrics rail thinner (min-width 80->54, tiles
  min 48, fit-content tightly expands for big numbers: ~72px idle -> ~77px with 248.5k); metric
  numbers/labels now CENTERED with tighter padding (5px 6px, label 7.5px); status-bar pills got more
  right padding (`.seg` +5px, seg-btn 0 8px 0 5px); `fmtUSD` now rounds to the nearest cent ($0.0000
  -> $0.00). Verified live: centered tiles, $0.00, no console errors; desktop 208 pass.
- **next:** ADR-0028 complete. Open follow-ups: live per-subagent progress in the UI card (parse the
  `<task-result>` poll payload); optional enforce omp isolation backend from the chosen profile.

## UX: instant Profile load, inline Knowledge-graph unlock, status-bar $0.00 (renderer-only)
- **shipped:** (1) **Profile no longer lags** — Settings → Profile is just the local name, already in
  `state.username`, so `settingsShell` now renders it from cache instead of a skeleton that waited on
  `/api/settings` (measured: warm 2-7ms but a ~660ms COLD first hit — that was the lag). Background
  refresh only re-fills if the value changed AND the field isn't focused (no clobber while typing).
  (2) **Inline Knowledge-graph unlock** — when the store is configured-but-locked, the graph panel now
  shows a passphrase field + Unlock right under "Your store is locked…" (no trip to Settings), via new
  `renderKgLocked`. Input validation (empty → "Enter your passphrase."), **Caps-Lock warning**
  (`getModifierState`), a **show/hide** eye toggle, inline error on wrong passphrase (surfaces
  `personalUnlock`'s message), and on success it mounts the graph. Not-yet-set-up still points to
  Settings (setup needs the confirm flow). New `.kg-unlock*` CSS. (3) **Status bar** `$0.0000 → $0.00`
  (fmtUSD nearest cent, from the prior session) + a touch more right padding on each pill.
  Verified live: profile input present instantly ("Nick", no skeleton); KG empty-validation, show/hide
  (password↔text), and wrong-passphrase error all work; $0.00 in the bar. desktop 208 pass, tsc clean,
  bundles, no console errors.
- **stubbed:** Caps-Lock + show/hide are wired and code-correct; synthetic CapsLock can't be faked in
  the headless check so it wasn't auto-asserted. Inline unlock targets the MAIN personal store
  (matches the old "Unlock in Settings"); a CUI-scope inline unlock could be added later.
- **next:** (unchanged) live per-subagent progress card; optional isolation-backend enforcement.

## UX cleanup: centered side buttons, settings density, personalization placement, em-dash purge, no Runs rail
- **shipped (renderer-only):** (1) New-session "+" and collapse "<<" glyphs truly centered (`.side-new
  .ic{display:block}` drops the inline-SVG baseline gap). (2) Tighter Settings density (`.set-sec`/
  `.set-coll` margin 14->9, `.set-coll-h` pad 12/13->10/12, body 14/16/24->12/14/20, label mb 10->7).
  (3) Personalization moved directly under Profile in `settingsShell` + a quiet accent GLOW
  (`.set-coll[data-sec="personal"]` box-shadow/border). (4) Removed the **Runs** rail button - it only
  called `focusInspector("security")` (duplicated Security); dropped the dead handler branch too (the
  `runs` icon name is still used by tool-phase glyphs). (5) Purged em dashes from rendered UI text
  (replace_all "—"->"-" in app.ts + bridge.ts; remaining ones are code comments only, not rendered).
  Verified live: + / << centered, section order workspace>profile>personal>providers, personal glow on,
  no Runs button, empty-state text uses hyphens. desktop 208 pass, tsc clean, bundles, no console errors.
- **note (answered for the user):** "root" = the top/orchestrator run (kind in `runs`), parent of the
  subagents; "parent" is the relationship (parent_run_id), "root" is the run's role. Sandbox profiles
  are recorded POLICY (chooseProfile), NOT yet enforced on omp's actual isolation - clean task spawns
  run trusted-local (shared cwd, in-process gate still scans every call); real per-agent containers
  require enforcing the isolation backend (the open follow-up).

## AskSage live token readout (Civ API) + subagent isolation enablement
- **shipped (AskSage):** the AskSage box is now fully dynamic from the Civ API - no manual limit.
  Probed the real API: `/count-monthly-tokens` -> used (1,139,721), `/count-monthly-tokens-left` ->
  404 (no user-only endpoint), `/count-monthly-tokens-left-with-org` -> remaining incl. org (860,279);
  used + remaining = exactly 2.00M = the real allowance. `asksage.ts monthlyTokens()` now returns
  `{used, remaining, limit=used+remaining}` (falls back to stored limit only if remaining 404s).
  Renderer: `quotaControls` (the +50K/+250K/+1M/Reset boxes) replaced by read-only `quotaDisplay`
  showing "used / limit", "% used · N left (you + org)"; hydrate fetches tokens then re-renders so the
  USED figure populates (the "0 used" bug was a render-before-fetch timing issue, not the API). Dead
  manual-quota handler removed. Verified live: 1.14M / 2.00M, 57% used · 860.3k left, no boxes.
- **shipped (isolation):** `omp acp` now launches with `--config harness/omp/acp_config.yml`
  (`task.isolation.mode: auto`, merge: patch) so the per-spawn `isolated` option is available; the
  frozen delegation policy (PREFIX_VERSION 2->3) steers write/exec subtasks to spawn isolated (patch +
  contained blast radius), read-only ones skip it. omp owns execution (auto backend, rcopy fallback on
  Windows); no global force-isolate exists, so it's enable+steer not a hard guarantee; isolated needs
  a git workspace. Verified: omp acp loads the overlay (handshake OK), prefix-hash green v3.
- **verified:** harness 376 pass, desktop 208 pass, tsc clean both, bundles, no console errors.
- **stubbed:** a full isolated patch-merge run wasn't exercised (rcopy of this repo+node_modules is
  slow); enabled + steered, best verified in a real git workspace in use.
- **next:** live per-subagent progress card (parse `<task-result>`); optional CUI-scope inline unlock.

## Bundled-safe isolation + panel UX (right-panel auto-collapse + KG resizer)
- **shipped:** (1) **Isolation works bundled** - `acp_config.yml` already ships via the extraResources
  `harness/**/*` glob (same path as the gate extension) and `acp_backend` resolves `ACP_CONFIG` from
  `REPO = import.meta.dir/..`, which is `<resources>/repo` in packaged builds (the dev server is spawned
  with `cwd: REPO` from `<resources>/repo/desktop`). Made it FAIL-OPEN: `--config` is only passed when
  `existsSync(ACP_CONFIG)`, so a missing overlay degrades isolation off instead of crashing `omp acp`
  (the in-process gate still scans every call). (2) **Opening Settings or the Knowledge graph now
  auto-collapses the Sessions panel** (`toggleSidebar(true)` in `openSettings`/`openKnowledge`) for
  more chat real estate; the nav hamburger reopens it. (3) **Knowledge-graph left-edge resizer** - a
  `.resizer-l[data-resize="kg"]` in the KG aside; `.kg` width is now `var(--kg-w, min(900px,70vw))`;
  `initResize` handles `kg` (maps to `#knowledge`, left-edge drag, clamp 360px..80vw, persisted to
  `lucid.kg-w`). Verified live: KG open → sessions collapsed; drag → 674→360 (min) and →770 (≈80vw),
  persisted; Settings open also collapses sessions. desktop 208 pass, tsc clean, bundles, no errors.
- **stubbed:** still didn't run a full isolated patch-merge end-to-end (rcopy of repo is slow); the
  config-ships + path-resolves + fail-open are verified, omp owns the actual isolated execution.
- **next:** (unchanged) live per-subagent progress card; optional CUI-scope inline unlock.

## KG facts panel: show only on selection (reclaim space) + graph auto-refit on resize
- **shipped:** the Knowledge-graph right-hand facts panel (`#kgSide`, 250px) no longer shows an empty
  "Click a node" strip - it's `hidden` until a node is selected (`renderKgSide` toggles `side.hidden`;
  the locked/empty/gate states also hide it), so the graph canvas uses the full width. `graph.ts` W/H/
  cx/cy made mutable + a `ResizeObserver` re-fits the layout (computeFit) when the canvas changes size
  (facts panel toggling, the KG resizer, or the window) - only when the user hasn't manually pan/zoomed,
  preserving their view; observer disconnected on destroy. `.kg-side[hidden]{display:none}` safety.
  Verified live: no selection → side display:none, canvas full width (741px), no console errors.
  desktop 208 pass, tsc clean, bundles.
- **reviewed ADR-0029** (model family picker, 18 bundled skills + /task proforma, Monaco IDE slide-out;
  committed f100a57 - DECISIONS.md ONLY, no code yet). Flagged: (1) invariant-#6 wording is
  self-contradictory - skills can't be both `--append-system-prompt` AND "volatile tail"; per-skill
  prompts should ride the user-turn tail (persona/recall pattern), not respawn omp; (2) overlaps omp's
  native skills surface (two skill systems) - needs reconciliation; (3) the 18 ported prompts are
  injected as TRUSTED, so they need a security review before shipping; (4) Monaco web-workers are an
  airgap gotcha (must vendor workers locally); (5) coordinate IDE-panel z-index with the KG/Settings/
  inspector right panels. Otherwise well-structured + invariant-mapped.
- **reviewed + corrected ADR-0030** (code-activity dashboard). Applied fixes in DECISIONS.md: (1)
  attribution honesty — `git log` churn ≠ AI-authored; v1 must be labelled "workspace/repo activity,"
  real attribution deferred; (2) safe git invocation — args-array (no shell), `pathWithin`-confined
  paths, exec timeout; (3) exclude vendored/generated/lockfiles via pathspec so the metric isn't
  dependency churn; (4) perf-claim nit (`--numstat` diffs, not pack-index); merges excluded. Added a
  high-level "premium BI add-on seam" note ONLY (real PRD kept out of this repo).
- **drafted the premium BI add-on PRD in the PRIVATE repo** (`mlcyclops/lucidagentIDEaddon`, pushed
  to `main`): an MCP server that publishes core's read-only observability to Power BI (GCC-High),
  Looker, AWS QuickSight, self-hosted Kibana, SharePoint, and a standalone single-HTML CIO/CFO
  dashboard, with per-target Terraform/IaC; metadata-only, gov-cloud/airgap-aware, no core fork. PRD +
  ROADMAP + data-contract + scaffolding stubs. IP intentionally separate; this repo holds only the
  high-level seam note. (Cloned as a sibling dir, NOT inside this repo.)

## Attribution identity: corporate-email profile field + first-open prompt (ADR-0030 prerequisite)
- **shipped:** the foundation for per-model/per-repo code attribution. `settings_store` gains an
  `email` field + `setProfile({username,email})`; `/api/settings` GET returns `{username,email}` and
  POST updates only the provided fields; `bridge.saveProfile`. Profile (Settings) now has a corporate-
  email input with validation + an attribution note. **First-open modal** (`promptForEmailIfMissing`)
  asks for the work email on launch when unset (validated; "Later" defers to next launch; re-renders
  Profile + toasts on save). New `.modal-*` CSS. Verified live: modal appears on no-email, empty/
  invalid rejected, valid save persists (`/api/settings` returns it), Profile shows it, no re-prompt.
  desktop 208 pass, tsc clean, bundles, no console errors.
- **next / plan (large, multi-increment — building in order):**
  - **AI-LOC attribution (the core ask):** the honest "what the AI wrote per model/repo/user" source
    is the agent's OWN edits, NOT `git log` (which counts human commits too). Plan: in the gate
    (`security_extension`), on an allowed `write_file`/`edit_file` tool_call, compute lines added/
    removed and record `{model, workspace, email, added, removed}` — model+email passed to the omp
    spawn via env from `acp_backend` (re-spawn on model/email change so the tag is current), workspace
    from cwd. Store in a new DuckDB table (numbered migration = frozen-contract increment). This
    SUPERSEDES ADR-0030's git approach for the AI-authored metric; git stays for total repo activity.
  - **ADR-0029 phases:** P-IDE.1 model family picker (renderer-only) → P-IDE.2 skills + `/task`
    proforma (deliver skill prompt in the USER TURN per the ADR-0029 review correction, not
    --append-system-prompt) → P-IDE.3 `skill_activated` event → P-IDE.4-6 Monaco IDE panel.
  - **ADR-0030 phases:** P-CODE.1 git collection + ledger metric (safe-spawn + pathspec excludes per
    review) → P-CODE.2 monthly workspace table (joined with the AI-LOC attribution above) → P-CODE.3
    polish.
- **also pending:** live per-subagent progress card; optional CUI-scope inline unlock.

## Attribution identity v2: skip → workstation fallback + MCP OAuth/X.509 design
- **shipped (core):** email is now OPTIONAL — the first-open prompt has a **"Skip - use <hostname>"**
  button that records the **workstation name** as the attribution identity (still traceable, still
  rolls up to the dashboard / MCP push), so a user without an email is never forced. `settings_store`:
  `attributionMode` ("email"|"workstation"), `setAttributionSkip()`, and `attribution()` →
  `{identity, source, email, workstation, decided}` (any saved email OR a skip = decided → no
  re-prompt; undecided falls back to hostname). `/api/settings` returns `attribution` + accepts
  `{skip:true}`; `bridge.skipEmail()`; Profile shows the effective identity line. Verified live (with
  the settings file temporarily stripped): modal shows "Skip - use DESKTOP-LGF6LQP", Skip →
  attribution `{identity:"DESKTOP-LGF6LQP", source:"workstation", decided:true}`, no re-prompt,
  Profile note correct; restored the real email after. desktop 208 pass, tsc clean, bundles.
- **designed (private repo `lucidagentIDEaddon`, pushed):** `docs/identity-and-auth.md` — the MCP
  server authenticates clients via **OAuth/OIDC** (Entra Gov/Okta/WIF, reusing core ADR-0020) **or
  X.509 workload identity** (mTLS client cert from a corporate CA / SPIFFE; import a cert or generate
  a CSR via EST/SCEP/ACME). Attribution resolves X.509 > OAuth > email > workstation; the verified
  MCP identity overrides the local tag for non-repudiable reporting. Fail-closed, metadata-only,
  CUI-excluded. Added `attribution` to the contract. Core ADR-0030 carries the high-level note only.
- **next:** AI-LOC attribution backend (gate edit-counting → DuckDB, tagged model+repo+identity), then
  ADR-0029 phases, then ADR-0030 git metric.

## Enterprise-managed config: admin-deployable policy (GPO/Intune/MDM)
- **shipped (core capability):** `desktop/managed_config.ts` reads a read-only policy file at startup
  from a machine-wide admin-only path (`%ProgramData%\LucidAgentIDE\managed-config.json`, macOS
  `/Library/Application Support/…`, Linux `/etc/lucidagentide/…`, or `LUCID_MANAGED_CONFIG` env) and
  ENFORCES it. v1 enforces attribution policy: `requireEmail` / `allowSkip` / `allowedEmailDomains` +
  `orgName` + `asksageOnly`. `settings_store.attribution()` folds policy in (decided/skip/domain);
  `/api/settings` enforces server-side (rejects skip/bad-domain) + `/api/managed`; renderer hides Skip,
  org-brands the prompt, validates domain, shows "Managed by …". Security: admin-only path (POSIX
  rejects group/world-writable; Windows = dir ACL), only ADDS constraints, absent/malformed ⇒
  unmanaged. Verified: unit (Acme policy → skipAllowed=false, gmail rejected, decided=false) AND live
  (file at the real ProgramData path → modal "Required by Acme Corp · use @acme.com", no Skip, gmail
  rejected client+server); removed the test file after. desktop 208 pass, tsc clean, bundles, no errors.
- **shipped (private repo, pushed):** tested `managed-config/managed-config.template.json` + a
  GPO/Intune/JAMF/MDM deployment runbook with per-OS paths + ACL hardening. Core ADR-0030 carries only
  the high-level capability note; the template + runbook are IP in the add-on repo.
- **next (unchanged):** AI-LOC attribution backend, then ADR-0029 phases, then ADR-0030 git metric.

## P-LOC.1: AI-LOC attribution backend (ADR-0031)
- **shipped:** the in-process gate counts every AI-authored file mutation that PASSES it (a successful
  omp `write`/`edit` `tool_result`) from omp's OWN post-apply diff — one pure counter covers all edit
  modes incl. the default hashline, and never over-counts failed edits (`isError`). `harness/runs/loc_count.ts`
  (over-tested keystone) + `loc_ledger.ts` (writer + `aiLocRollup` per model/repo/identity) → new FROZEN
  table `ai_loc_ledger` (migration 0007) + EventName `ai_edit_recorded`. Attribution threaded to the gate
  via env at omp spawn (`LUCID_MODEL`/`LUCID_IDENTITY`/`LUCID_IDENTITY_SOURCE`/`LUCID_REPO`); model
  reconciled from omp's active-model config (persisted `lastModel`, one-time respawn if it differs).
  Best-effort: a DB-open failure skips the row, never the gate. Verified: 27 new unit tests + `demo-P-LOC.1`
  + harness 403 pass + desktop 208 pass + tsc clean + prefix-hash unaffected + a LIVE end-to-end gate
  drive (real `edit` → one `+1/-1` row; `read` ignored; self-cleaned).
- **stubbed:** live in-session model switching must respawn omp to keep the model tag exact (a documented
  constraint on ADR-0029 P-IDE.1); surfacing `aiLocRollup` on the dashboard / BI push is a later increment.
- **next:** ADR-0029 P-IDE.1 (model family picker), then surface AI-LOC on the dashboard.

## P-IDE.1: model family picker (ADR-0029)
- **shipped:** the model picker now groups models into collapsible **family** sections (Anthropic
  Claude · OpenAI o-series · OpenAI GPT · Google Gemini · AskSage RAG · Other) instead of a flat list.
  Pure classification/grouping in new `desktop/renderer/model_families.ts` (`familyOf`/`groupByFamily`/
  `filterModels`; regex ORDER = o-series before GPT; robust to `asksage-…/` prefixes; unmatched → Other),
  unit-tested (`model_families.test.ts`, 15 tests). `app.ts` adds the collapsible UI (`familyListHTML`,
  collapse persisted in `localStorage`) to BOTH the badge popover and the composer chip; the selected
  model's family + any family during search are force-expanded; empty/no-match families hide; hover card
  + click unchanged. Renderer-only — no contract/schema change. Verified LIVE in the preview vs real omp
  models (27 → 5 families: claude 12·o-series 3·gpt 7·gemini 4·rag 1), collapse-toggle + persistence,
  cross-family search + auto-expand, empty state, selected-family-expanded, zero console errors,
  screenshot. desktop 223 pass, tsc clean, renderer build clean.
- **stubbed:** P-IDE.2 (slash-command skills + `/task` proforma — reconcile with omp-native skills per
  the ADR review finding #2) onward not yet built.
- **next:** ADR-0029 P-IDE.2 (bundled skills, unified with omp-native skills), or surface AI-LOC on the dashboard.

## P-LOC.2: AI-LOC roll-up on the dashboard (ADR-0031)
- **shipped:** the Memory tab now shows an **"AI-authored code"** card — the output counterpart to the
  cost ledger. `tools/memory_data.ts` adds `aiLocSummary()` (READ_ONLY DuckDB roll-up of `ai_loc_ledger`:
  totals + per-model + per-(model·repo·identity) + distinct identities; coexists with the live gate's
  write lock; null when no edits recorded), folded into the existing `MemorySnapshot` (no new endpoint).
  `app.ts` renders an accordion: +added/−removed totals, a per-model table, and a by-repo·identity
  breakdown (corporate email vs. workstation fallback marked `⌂`). Verified LIVE in the preview with
  seeded rows — totals (+64/−2), per-model (opus +62/−1, sonnet +2/−1) and per-repo math exact,
  attribution + workstation marker correct, card hidden when empty, zero console errors, screenshot;
  seeded rows cleaned up after. desktop 223 pass, tsc clean, renderer build clean.
- **settled (no code):** ADR-0029 P-IDE.2 open questions resolved — ONE unified skills picker
  ("Built-in" + "Project" sections, reusing the P-IDE.1 family-section UI), bundled prompts via the
  user-turn tail (omp-native stays on `useSkill`), inline auditable array (no `.md` on disk), each
  ported prompt security-reviewed as it lands. Recorded in ADR-0029 review findings #2/#3 + the phase.
- **next:** ADR-0029 P-IDE.2 (bundled slash-command skills + `/task` proforma), per the settled plan.

## P-IDE.1b: model picker corrections (ADR-0029)
- **shipped:** five user-reported fixes, verified live against the real omp catalog (**85 models**, not
  27). (1) **Show ALL models** — `curatedModels` was dropping the user's direct-OAuth GPT (23) + Gemini
  (20), keeping only curated Claude + AskSage; now returns every model omp exposes. (2) **Collapse bug**
  — the selected model's family couldn't collapse (removed the `!hasSel` guard); collapse is now fully
  user-driven + persisted. (3) **Fable 5 unavailable** — greyed, non-selectable, "Currently Unavailable"
  tag + ITAR explanation in the hover card (`UNAVAILABLE` registry). (4) **AskSage ordering** — gov
  configured → GPT/o-series/Gemini above Claude (`ASKSAGE_FAMILY_ORDER` + new `groupByFamily(order)`).
  (5) **Gov advisory** — gov models show "internal prototype use only until cleared" in the hover card.
  Plus cold-start: removed P-LOC.1's one-time startup respawn (dropped the session/slowed first load —
  see ADR-0031 revision) + snappier popover open. Render ~4ms for 85 rows (never the bottleneck).
  Verified: Claude collapses, Fable non-clickable + ITAR banner, o3 gov advisory, 85-model gov-first
  ordering, no console errors, screenshot. desktop 225 pass · harness 403 pass · tsc clean · build clean.
- **stubbed:** the 3 "Other"-family entries are omp auxiliary models (tab-completion, codex auto-review)
  — left visible in Other (honest: don't hide available models); exact live-model-switch tagging deferred
  (documented limitation in ADR-0031).
- **next:** ADR-0029 P-IDE.2 (bundled skills + `/task`), per the settled unified-picker plan.

## P-IDE.1c: model picker curation + data-sovereignty gating (ADR-0029)
- **shipped:** rule-based curation in `model_families.ts` (omp gives no deprecation/provider metadata):
  moderate deprecation (drop dated snapshots + legacy Claude 3.x/4.0-4.1 + Gemini 2.0); **GPT 5.4+
  everywhere** (gov + direct; o-series/gpt-oss exempt); **gov models hidden unless an AskSage key is
  set**; **gov at top of each family, newest→oldest**; drop omp auxiliary models; **China-origin gate**
  (DeepSeek/Kimi/MiniMax/GLM/Qwen) hidden until a typed-ACKNOWLEDGE unlock in Settings (persisted;
  card shows only when such a model exists — none currently, so forward-looking); **provider
  disambiguation** tag for models that appear via multiple providers + a final identical-render dedup.
  Wiring: settings_store `chinaModelsAcknowledged` + `/api/china-ack` + bridge `chinaAck/setChinaAck` +
  `state.chinaAck`. Verified LIVE: user's catalog 85 → 47, gov-first ordering, GPT<5.4 gone, zero visual
  duplicates, no console errors, screenshot. desktop 235 pass · model_families.test.ts 27 · tsc/build clean.
- **stubbed:** the China unlock UI couldn't be exercised live (no China models in the catalog) — covered
  by `isChinaModel` unit tests + the gated Settings card; live-verify when such a provider is connected.
- **next:** Send→Stop button + prompt prestaging (P-ACP.4), then ADR-0029 P-IDE.2.

## P-ACP.4: Stop button + prompt pre-staging (ADR-0027)
- **shipped:** while a turn runs, the Send button becomes a red **Stop** that interrupts the reply +
  tool calls via the ACP `session/cancel` notification (new `ACPClient.notify()` + `backend.cancel()` +
  `/api/chat/cancel` + `bridge.cancelChat()`). **Pre-staging:** typing + Enter mid-turn no longer drops
  the input — it's queued (one slot) with a "Queued · sends when this turn ends" chip (cancelable), and
  auto-sends when the turn ends (naturally or via Stop). Renderer: `state.queued`, `renderQueued()`,
  `stopTurn()`, `setSendEnabled()` Send/Stop toggle; auto-send in `send()`'s finally. No contract change.
  Verified LIVE: Stop halts omp in ~155ms (reply stops growing, grewAfterStop=0), red Stop button +
  queued chip render, queued prompt auto-sends after Stop, no console errors, screenshot. desktop 235
  pass · harness 403 pass · tsc/build clean.
- **gotcha (recorded):** the dev SERVER process must be restarted (not just page-reloaded) to pick up
  `dev.ts`/`acp_backend.ts`/`acp.ts` edits — an early Stop test hit a stale 404 and looked broken.
- **next:** ADR-0029 P-IDE.2 (bundled skills + `/task`), per the settled unified-picker plan.

## P-IDE.1d: picker polish + queued-chip refinement (ADR-0029 / ADR-0027)
- **shipped:** (1) **Mythos 5** now matches **Fable 5** — greyed "Currently Unavailable" (ITAR) + the same
  rich hover card. (2) **Every listed model** gets a hover card via `resolveModelInfo()`
  (curated→base-id→inferred-by-family/tier); rows show stars + context uniformly. (3) **Cold-boot cache**
  — last config persisted to localStorage + painted instantly on boot (`loadCachedConfig`); `loadConfig`
  only adopts a NON-empty live config (a cold omp no longer blanks the picker), with an "updating…"
  spinner + in-place `pickerRedraw` when live lands (drops revoked providers). (4) **Family headers** —
  removed the leading icon, bold label + count, higher contrast. (5) **Queued chip** — compact, subdued,
  right-aligned 11px pill with a "Queued" tag + a delete (✕) that removes the pre-staged prompt before it
  sends. Verified LIVE (47-model catalog): stars on every row, Mythos/Fable cards match, icon-less bold
  headers, queued pill + working delete (deleted prompt doesn't send). desktop 235 · tsc/build clean.
- **bug caught in verification:** `inferModelInfo` used `familyOf` without importing it → runtime
  ReferenceError that emptied the picker; NEITHER tsc NOR Bun.build flagged the undefined free variable
  (renderer type-safety gap — a missing import isn't caught; found only by live test + DOM instrumentation).
- **next:** ADR-0029 P-IDE.2 (bundled skills + `/task`), per the settled unified-picker plan.

## ADR-0032 fix: agent now builds files directly (was: stranded in isolation)
- **shipped:** root-caused "Agent not building a file" — the gate block log showed NO write block, so
  the write wasn't blocked; it was being STRANDED. ADR-0028 had (a) enabled task isolation
  (`acp_config.yml` mode:auto/merge:patch) and (b) a `DELEGATION_POLICY` line steering the model to
  "spawn ISOLATED … captured as a reviewable patch" for file edits. A delegated build ran in an
  isolated copy → returned as a patch with NO apply-UI + fragile Windows merge → file never hit disk.
  Fix: `DELEGATION_POLICY` rewritten to APPLY FILE EDITS DIRECTLY (gate-scanned), isolation reserved for
  untrusted EXECUTION only (frozen-prefix change, PREFIX_VERSION 3→4, ADR-0032); `acp_config.yml` set
  `mode: none` so a `task` subagent writes to the REAL workspace even if the model still tries to
  isolate. Security gate (in-process, fail-closed) remains the load-bearing protection.
- **caveat:** couldn't read the exact live chat session (sessions dir held only old omp-echo tests; the
  Bash safety-classifier was intermittently down). Diagnosis rests on: no gate block logged + the
  isolation/delegation steer I added in ADR-0028 + no patch-apply UI. Fix is safe regardless (can't make
  file-building worse; writes land directly + gate-protected). Verify pending: full test run once the
  classifier is back (prefix-hash self-test unaffected; isolation deferred until a patch-apply UI exists).
- **next:** confirm with the user that builds now land; then ADR-0029 P-IDE.2.

## Tooling: close the renderer type-check gap (root cause of the P-IDE.1d bug)
- **shipped:** the renderer/Electron code IS covered by `desktop/tsconfig.json` (DOM types) — but my
  verification only ran `tsc --noEmit` (root project = `harness/**`+`tools/**`), so renderer changes were
  NEVER type-checked; that's why a missing `familyOf` import slipped to runtime in P-IDE.1d. Fixes:
  excluded `**/*.test.ts` from `desktop/tsconfig.json` (they import `bun:test`, run under `bun test`) so
  `tsc -p desktop/tsconfig.json` is a clean gate; updated the `typecheck` script to run BOTH projects
  (root + desktop) + added `typecheck:desktop`. Verified `bun run typecheck` clean across both. Renderer
  edits are now caught at build time.
- **known gap (deferred → spawned task):** Bun-runtime desktop SERVER files (`dev.ts`, `acp_backend.ts`,
  `settings_store.ts`, …) are in NEITHER tsconfig (`dev.ts` alone shows ~81 strict errors, mostly
  `unknown`-typed `req.json()`). Covered by `bun test desktop` at runtime; strict type-checking deferred.
- **next:** ADR-0029 P-IDE.2 (bundled skills + `/task`), per the settled unified-picker plan.

## ADR-0033: build / anti-over-refusal policy (model refused to build a game)
- **shipped:** user hit Gemini 3.1 Pro flatly refusing "make a single-HTML killer-rabbit game with
  graphics/music in OSP-Tests" ("I cannot create… capabilities are limited… cannot generate rich
  media"). The restrictive phrasing was NOT in our prompt — the model invented the limit. Added a
  `BUILD_POLICY` block to the frozen prefix (layer 3, next to `DELEGATION_POLICY`): a self-contained
  app/game/visualization in one HTML file is CODE (canvas/SVG/CSS + Web Audio + rAF + inline JS, no
  external assets); build it and write it where asked; don't refuse buildable work on capability
  grounds. Bumped `PREFIX_VERSION` 4→5; exported + appended to the live ACP chat via
  `--append-system-prompt` (acp_backend now appends `DELEGATION_POLICY` + `BUILD_POLICY`).
- **verified LIVE** with the SAME model + prompt: refusal gone — Gemini "Designing the Killer Rabbit
  Game…" then wrote `OSP-Tests/killer-rabbit.html`, a real game (7× canvas, Web Audio AudioContext,
  requestAnimationFrame, Caerbannog/Killer-Rabbit theme). prefix-hash green at v5 · harness 403 ·
  desktop 235 · typecheck clean (3 projects). Distinct from ADR-0032 (which fixed file *stranding*); this
  fixes the model *declining to attempt* the build.
- **next:** ADR-0029 P-IDE.2 (bundled skills + `/task`), per the settled unified-picker plan.

## P-IDE.2: unified skills picker + /task proforma (ADR-0029)
- **shipped:** `desktop/renderer/skills.ts` — `INSTALLED_SKILLS` (12 audited, trusted prompts: Frontend
  Design, Code Review, TDD, Security Audit, Refactor, Debug, Write Tests, Explain, Performance,
  Accessibility, Session Handoff, Plan) + usage-frequency sort + the `/task` proforma. ONE picker behind
  the composer Skills button: "Built-in" (/task + bundled, most-used first) + "Project" (omp-native via
  `/skill:`). Activating a bundled skill delivers its prompt as an `<active-skill>` preamble in the USER
  TURN (persona/recall path: acp_backend `setSkill`/`skillDelivered`, reset on new session/respawn) —
  never the frozen prefix, never `--append-system-prompt`, distiller ignores it. `/api/skill` (set/clear)
  + bridge `setActiveSkill`/`clearActiveSkill`; Skills chip shows the active skill + a Clear row; command
  palette lists /task + bundled + project. Scoped to 12 strong prompts (not literal 18) so each got a real
  safety pass (ADR review #3); more add the same way. Verified LIVE: 12 built-in + 2 project sections,
  activate → chip "Code Review" + backend round-trips active name, /task appends template, Clear resets
  both, no console errors. desktop 235 · typecheck clean (3 projects) · build clean.
- **next:** ADR-0029 P-IDE.3 (`skill_activated` telemetry event — frozen-contract sub-increment).

## P-IDE.3: skill_activated telemetry event (ADR-0029, frozen-contract sub-increment)
- **shipped:** added `skill_activated` to `EVENT_NAMES` (frozen contract). `desktop/skills_log.ts`
  `recordSkillActivated({command,name,source})` emits via the canonical `Telemetry` class (so the name
  is validated against the enum) — METADATA ONLY (command/name/source, never user content) — to an
  append-only NDJSON (`~/.omp/lucid-events.ndjson`), since the GUI can't co-write agent_obs.duckdb
  (omp child holds it), mirroring `security_log.ts`. New `POST /api/skill/activated` + bridge
  `skillActivated`; renderer fires it on bundled activation, project `useSkill`, and `/task`.
  Verified: 3 unit tests (valid event + enum membership + all 3 sources) + LIVE (activating Security
  Audit + /task appended valid `skill_activated` lines with correct metadata). desktop 238 · harness
  403 · typecheck clean (3 projects) · build clean.
- **next:** ADR-0029 P-IDE.4 — Monaco IDE panel scaffold (read-only; vendor workers locally; right-panel
  exclusivity), then P-IDE.5/6.

## P-IDE.4: read-only Monaco IDE panel scaffold (ADR-0029)
- **shipped:** Monaco 0.55 added as a desktop dep; AMD `min/vs` served LOCALLY from node_modules via a
  guarded dev.ts route (`/vendor/monaco/*`, pathWithin guard) — airgap-clean, no 16MB commit; packaged
  via electron-builder `files`. `desktop/renderer/ide_panel.ts` lazy-loads Monaco (AMD loader) on first
  open (app.js stays lean), creates a `readOnly` lucid-dark editor that slides over the inspector
  (translateX), with a header (title + lang chip + close), footer (live Ln/Col + Read-only), and a drag
  resize handle (persisted). "View in IDE" buttons are injected onto chat code blocks post-render
  (DOMPurify forbids `<button>` in sanitized markdown) → delegated handler opens the panel with the
  block's code + language. Right-edge exclusivity: IDE ↔ Settings ↔ KG mutually close. CSP gained
  `worker-src 'self'` + `font-src 'self'`. Verified LIVE: renders + highlights TS/Python/Rust/Go, footer
  tracks cursor, close + both-direction exclusivity + injected buttons all work, zero console
  errors/CSP violations.
- **worker note (ADR review #4):** a read-only viewer needs no language-service worker (highlighting is
  main-thread); Monaco 0.55's worker is a hashed AMD chunk that's fragile under our strict CSP, so the
  viewer uses the main-thread fallback and silences only Monaco's benign "could not create web worker"
  notice. Real workers are P-IDE.5 (read-write/IntelliSense) scope, as the review anticipated.
- **stubbed / pending:** packaged-build worker verification (couldn't build a packaged app here);
  P-IDE.5 (read-write + Save-via-write_file + pop-out) and P-IDE.6 (polish + integration tests).
- **next:** ADR-0029 P-IDE.5 (IDE read-write + save through omp's write tool + pop-out).

### P-IMP.1 — onboard the modern (sharded) ChatGPT export (ADR-0034)
- **shipped:** made the existing gated import shard-aware so a real 2026 OpenAI export onboards
  directly (it ships `conversations-000…NNN.json`, no single `conversations.json`, and was being
  rejected as an "ambiguous directory" — the one thing blocking ChatGPT→Lucid onboarding). Three pure,
  over-tested additions, extending — never forking — the existing pipeline: `readZipEntriesMatching`
  (pull every shard from a .zip in one pass), `isConversationShard` + `mergeConversationShards`
  (concatenate shard arrays, skip bad ones), and `loadExportData` (shard-aware folder/zip resolver,
  same TOCTOU-safe reads as `loadExportText`, legacy single-file fallback). Same fail-closed scanner
  gate, same suspicious-source promotion gate, same encrypted store + "Import history" UI — unchanged.
  Verified on the **real 669 MB export**: 5 shards → 420 conversations / 1,952 user msgs (~109 K
  tokens, voice transcripts folded in) in 98 ms; full gated run into a throwaway temp store scanned all
  1,952 msgs in ~1 s with 1 blocked + 100 heuristic facts. harness 408 / desktop 242 / typecheck clean.
- **stubbed / pending:** AI extraction is the existing opt-in "AI" checkbox (capped 500 msgs), not run
  here; media `.dat` (images/PDFs) left for a future OCR/vision opt-in (voice is already transcribed in
  the JSON, so the 586 WAVs need no compute).
- **next:** ADR-0029 P-IDE.5 (IDE read-write + save through omp's write tool + pop-out).

### P-IMP.1 addendum — live UI walkthrough + two IDE bug fixes (ADR-0034 addendum)
- **shipped:** drove the import through the real UI in an **isolated** preview (new `LUCID_PERSONAL_DIR`
  store-dir override) so it never touched the user's existing real store (verified byte-identical
  before/after) — enable → passphrase → KG → Import history → folder picker → synthetic *sharded*
  export → audit `personal_facts_imported{conversations:4 (both shards merged via the picker),
  messages:5, learned:3, blocked:0}`, graph rendered the nodes. Fixed two real bugs found doing it:
  (1) **View in IDE** "Couldn't load" — `loadMonaco` cached the rejected promise so a transient/stale-
  server miss was permanent; now clears on failure + retries on reopen (the user's case was a dev
  server started before the `/vendor/monaco` route shipped). (2) the IDE button **overlapped** the
  message copy/save-`.md` actions → moved to the code block's bottom-right (measured 65px clear).
  Also: `setup{Personal,Cui}` now `mkdir -p` the store dir (latent first-run gap), and the Import
  tooltip no longer points at a `conversations.json` that sharded exports don't have.
- **verified:** typecheck (3 projects) clean · desktop 244 · harness 408 · renderer bundle builds ·
  View-in-IDE + overlap fixes confirmed live (Monaco renders, 65px gap, zero console errors).
- **next:** ADR-0029 P-IDE.5 (IDE read-write + save through omp's write tool + pop-out).

### P-IMP.2 — ChatGPT-import onboarding (ADR-0035)
- **shipped:** (1) first-run **nudge** + Personalization settings section now **expanded until
  configured** (was a collapsed accordion → undiscoverable for new users); the one-time "Make
  LucidAgent yours" toast's CTA opens Settings scrolled to enable→passphrase. (2) **AI extraction now
  defaults on for the first import**, behind a pre-import **confirm toast** that warns `~tokens · ~time`
  — backed by a new read-only, home-confined `estimateChatExport` (shard-aware count, no scan/store).
  Also corrected my earlier bogus "18 nodes" claim — real graph was 3 nodes / 2 edges (= learned:3).
- **verified live (isolated demo, real store byte-identical throughout):** nudge fired → CTA expanded
  + scrolled the section; Import → confirm "Import 4 ChatGPT conversations? · AI: ~1.6k tokens · ~13s ·
  Quick: free + instant" (AI first = first-import default, warn tone) → Quick completed the import
  (learned:3). Tests added for the estimate. typecheck clean · desktop 246 · harness 408 · bundle builds.
- **next:** ADR-0029 P-IDE.5 (IDE read-write + save through omp's write tool + pop-out).

### P-IDE.5 — IDE read-write: gated Save + Save-As + conflict banner + Send to chat (ADR-0036)
- **shipped:** the Monaco panel is now an editor. New `desktop/editor.ts` (read + **gated save**):
  paths confined to home (ADR-0023 boundary), conflict detection (on-disk hash drift / Save-As clobber),
  and **`scanAndDecide` — a >=high finding or an unavailable scanner BLOCKS the write** (omp's ACP fs
  write is disabled for the GUI, so this gated endpoint is the persistence path, keeping the gate in the
  loop). Renderer: Edit/View toggle, modified dot + status states, Ctrl/⌘-S, Save-As (folder browser +
  new `promptText` filename overlay), conflict banner (Overwrite/Reload/Cancel), Send-to-chat (fenced
  block into the composer via `setIdeHooks`), detached pop-out, unsaved-changes close guard. Workers
  still deferred (main-thread tokenization is fine; semantic IntelliSense under strict CSP is its own task).
- **verified live (real scanner):** clean save wrote; a zero-width space hidden in a comment was BLOCKED
  and never hit disk; outside-home rejected; full UI Save-As + conflict→Overwrite + Send-to-chat +
  status transitions + pop-out (graceful) + close guard all confirmed. 9 `editor.test.ts` cases added.
  typecheck clean (3 projects) · desktop 255 · harness 408 · bundle builds.
- **next:** P-IDE.6 (polish + integration tests; optional: Monaco language-service workers under CSP).

### P-IDE.6 — IDE polish: modal stacking, concurrent-save safety, lifecycle tests (ADR-0037)
- **shipped:** fixed the Save-As folder browser rendering UNDER the IDE panel (lifted modal scrim/box to
  z-index 110/111 > panel 90; toasts → 120 so IDE notifications aren't occluded). Hardened Save: a
  `saving` guard set BEFORE the async Save-As picker (a rapid double-click used to open two browsers) +
  released in `finally`, plus a 20 s request timeout so a hung scanner gives "Save timed out → Retry"
  instead of a stuck spinner. Polish: Save-As dialog copy (dropped inaccurate "your workspace"; saves are
  home-confined) and a clean `snippet.<ext>` suggested name. Integration tests for the read↔save
  round-trip + conflict/overwrite/chain cycles.
- **verified live:** Save-As browser now above the panel; triple-click Save → exactly 1 browser (guard
  holds); refactored happy path still saves ("Saved ✓"); suggested "snippet.rs". typecheck clean ·
  desktop 258 · harness 408 · bundle builds.
- **next:** optional P-IDE.7 — Monaco language-service workers under strict CSP (semantic IntelliSense),
  and an "Open file…" entry point wiring the (already-built) editorRead into the UI.

## ADR-0040 — standing user-turn guidance re-delivered every turn (+ KG/memory polish)

- **shipped:** ADR-0040 (DECISIONS.md): persona (ADR-0007) / bundled skill (ADR-0029) / personalization
  `<user-profile>` profile (ADR-0009 P9.2) now re-deliver on EVERY user turn instead of once per session,
  so they stop fading mid-conversation; cross-session `<recalled-memory>` stays once. Safe — all post
  cache-breakpoint (invariant #6 holds; demo02_prefix_hash green). Documents this session's fixes:
  recall excludes mechanical tool activity + stops promoting raw tool I/O as facts; preamble stripped from
  chat/titles; KG live-refresh + cross-turn linking + opt-in model extraction; persona-button label;
  delete-session; toasts; Logs-button removal; and the omp compatibility-probe CI (POAM R-01).
- **stubbed:** omp exact-pin PR (#49) still open — caret remains on master until merged; the compat probe
  derisks the bump but the pin closes the silent-drift gap.
- **next:** merge #49; consider an ADR for the omp version-pin policy + an ADR for the opt-in model
  extractor (cost-vs-quality learning) if it graduates from opt-in.

## ADR-0041 — omp version-pin policy (exact pin + compatibility-probe-gated bumps)

- **shipped:** ADR-0041 (DECISIONS.md): formalizes the now-built policy — exact-pin all four `@oh-my-pi/*`
  at the tested baseline `16.0.6` (PR #49, merged; caret gone, lockfile committed), and bump ONLY via the
  weekly + on-demand compatibility probe (`.github/workflows/omp-compat.yml`, PR #67) that runs the full
  suite + both keystones (fail-closed gate, byte-stable prefix) on a branch → green opens a ready-to-merge
  bump PR, red files an issue. Never auto-merges; a human reviews omp's seam changes and moves the pin.
- **stubbed:** SBOM-side version+license recording per build is the add-on Phase 3 (POAM R-10), not core.
- **next:** run the probe (Actions → omp compatibility probe) when you want omp's reliability fixes;
  optional ADRs for the opt-in model extractor (#66) and recall hygiene (#50/#56) if you want them recorded.

## ADR-0042 + ADR-0043 — KG model-extraction (opt-in) + memory recall hygiene

- **shipped:** ADR-0042 (opt-in `personalAiExtract` model extractor, default OFF — richer semantic facts +
  cross-turn relations at one model call/turn; reuses `backend.complete()`; PR #66) and ADR-0043 (memory
  recall hygiene — `buildRecall` excludes `omp:*`/`subagent:*` mechanical activity (PR #50) and
  `rememberActivity` stops promoting raw tool I/O as facts while keeping provenance ingest (PR #56);
  keystone #2 subagent-result promotion untouched).
- **stubbed:** none — both decisions were already built/merged; these ADRs formalize them.
- **next:** nothing pending. Use the omp compatibility probe (Actions) to adopt omp fixes; flip "Richer
  graph (uses the model)" in Settings if you want model-based learning.

-----

## P-CODE.1: git workspace code-activity metric (ADR-0030)
- **shipped:** `codeActivity()` + pure `parseNumstat`/`renamedPath` in `tools/memory_data.ts` (git
  `--numstat` for the calendar month; args-array spawn, `pathWithin` home-subtree confinement, 15s timeout,
  vendored-churn pathspec excludes, rename + binary handling, fail-closed omit of non-git/out-of-home/failed
  dirs); `GET /api/code-activity` in `dev.ts` (30s cache, `?force=1` bypass); `CodeActivity` bridge type +
  accessor; ledger-card "workspace activity" row + green/red `.loc-add`/`.loc-del` CSS + a "lines" rail tile
  (honest label — repo activity, NOT AI authorship; AGENTS.md #10). New `harness/code_activity.test.ts` (12
  tests, parser keystone) + `demo-P-CODE.1`. Verified: 456/456 harness green; demo OK; live endpoint 403
  w/o token, real data with (+39,271/-2,801, 302 files this month); UI rendered + screenshot, no console errors.
- **stubbed:** per-workspace **spend** attribution (session `cwd` → ledger) deferred to P-CODE.2 (`spend:0`
  for now); P-CODE.2 monthly workspace accordion/table and P-CODE.3 polish (no-changes/detached-HEAD edges)
  not started. Pre-existing typecheck error `desktop/personal.ts:50` (ADR-0042 `aiExtract`) left as-is — out of scope.
- **next:** P-CODE.2 — monthly workspace activity section (summary card + per-workspace table) + spend
  attribution; then the add-on can re-pin its data contract and flip drift D-4 (code-activity) to ✅.

-----

## P-TPS.1: streaming output-token readout — terminal + desktop (ADR-0044)
- **shipped:** vendored pi-token-speed's pure engine (MIT) as a shared, UI-agnostic core
  `harness/metrics/token_speed.ts` (config injected, clock injectable, plain-text `formatReadout`; engine +
  sliding-window + word/punct estimator) with `harness/metrics/token_speed.test.ts` (10 tests: output-only
  counting, provider-token reconciliation, TTFT realign, windowed tok/s). Two thin adapters off the one core:
  terminal `harness/omp/token_speed_extension.ts` (omp `message_update`→`ctx.ui.setStatus` `⚡ TPS:`, `/tps`
  cycles mode, `useProviderTokens` for exact counts; wired into `omp:secure`) and desktop HUD in
  `desktop/renderer/app.ts` (same engine fed from the `token`/`thinking` ChatEvents → `· N tok out · R tok/s`;
  existing `usage_update` figure relabelled **`ctx`** so output ≠ context) + `.hud-tps` CSS. New ADR-0044,
  `demo-P-TPS.1` (`demo_ptps1.ts`, proves the system prompt is excluded + provider reconciliation). Verified:
  typecheck clean (3 cfgs); `bun test harness` 466/466; browser bundle of app.ts succeeds; demo PASS.
- **stubbed:** desktop count is an ESTIMATE (ACP deltas carry no per-delta `usage.output`; `usage_update` is
  context, not output) — terminal count is exact when omp reports usage. Not added to the ACP launcher
  (`lucid_acp.ts`): `ui.setStatus` is a no-op there + would break the `ext_parity` `-e`-ordering tests. No
  live in-desktop streaming screenshot (needs a real model turn / provider auth).
- **next:** optional — surface a per-turn output total on `done` from an authoritative source if omp ever
  exposes per-turn output over ACP (would make the desktop figure exact); a `/tps`-style toggle in desktop Settings.

-----

## P-SKILL.1: gated drag-and-drop skill import (ADR-0045)
- **shipped:** ADR-0045 (3-phase design: gated import + model-assisted builder + session-derived skills).
  P-SKILL.1 built: `desktop/skills_import.ts` `importSkill()` scans a dropped `.md` fail-closed
  (`scanAndDecide`/DEFAULT_POLICY, same seam as `scanPersona`) → clean writes to
  `<ws>/.omp/skills/<slug>/SKILL.md` (omp discovers it natively) under a `pathWithin` check; flagged →
  NOT written, `recordBlock`'d to the Security panel ("block + review" posture). New `POST /api/skills/import`
  (dev.ts), `bridge.skillImport` + `SkillImportResult`, a drop zone in the Skills popover's Project section
  (`app.ts` `handleSkillFiles`/`projSkillRows`) + `.skill-drop` CSS. New `demo-P-SKILL.1` (clean writes,
  poisoned bidi/zero-width blocks). Verified: typecheck clean (3 cfgs); demo PASS; live endpoint round-trip
  (clean → written + appears in `/api/skills`; poisoned → quarantined + reaches `/api/security`); drop zone
  renders. This makes the gate authoritative for IMPORTED project skills (omp's native loader bypasses it).
- **stubbed:** P-SKILL.2 (skills-builder via most-used model + `complete()`, opt-in, re-scanned output) and
  P-SKILL.3 (session-derived skills from selected sessions) — designed in ADR-0045, not built. Hand-placed
  `.omp/skills/` files (outside the app) are still not retroactively scanned. The synthetic DOM file-drop
  couldn't be simulated in-preview (real OS drag-drop unverified by automation — needs a real file drop).
- **next:** P-SKILL.2 — wire the opt-in skills-builder (`usageLedger().models[0]` → `complete()` with a
  model override on the throwaway session; re-scan + preview-to-accept), then P-SKILL.3 session-derived.

-----

## P-SLASH.1: "/" command + skill autocomplete in the composer (builds on ADR-0029)
- **shipped:** inline autocomplete in the prompt bar (`desktop/renderer/app.ts` `updateSlashAC`/`filterSlash`/
  `slashKeydown`/`applySlash` + `.slash-ac` CSS): typing `/` pops a filtered list of omp slash commands +
  built-in skills (most-used first via `bundledSkillsByUsage`) + project skills; filters character-by-
  character; ↑/↓ to move, Tab/Enter to complete (commands/project skills → text with trailing space;
  built-in skills → activate). Added two built-in skills: **Goal Loop** (`/goal` — iterate to a verifiable
  stop condition, checked by an objective run, maker≠checker; omp has no native `/goal`) and **Loop
  Engineering** (Osmani's loop design: automations · worktrees · skills · connectors · sub-agents + on-disk
  memory). Removed the em dash from the `/task` list entry + proforma (now `/task:`). Verified live: AC
  appears on `/`, `/go`→Goal Loop, `/loop`→Loop Engineering, `/mod`+Tab→`/model `, Enter on Goal Loop
  activates it, most-used floats up, no em dashes in the list; typecheck clean (3 cfgs).
- **stubbed:** the REAL `/goal` loop primitive (a control loop that re-runs until a verifiable condition
  with a separate checker model) is only LISTED as a skill, not built — it's a harness-level increment of
  its own (would need an ADR). No demo script (browser-only composer UX; verified in the preview). Slash
  autocomplete triggers only when the whole input is a single `/…` token (closes once you type a space).
- **next:** build the `/goal` loop primitive (ACP-backend control loop + objective stop-condition checker)
  as its own increment+ADR; surface the other Loop-Engineering building blocks (automations/scheduling) that
  this harness doesn't yet expose.

-----

## P-GOAL.1: the /goal loop primitive (ADR-0046)
- **shipped:** ADR-0046 + the real `/goal` loop. `backend.runGoal({goal,condition,command,maxIters}, onEvent)`
  (`desktop/acp_backend.ts`): runs MAKER iterations via `prompt()` on the persistent session toward the
  goal, and after each one a SEPARATE checker (`checkGoal` → `complete()`, a throwaway session = maker≠checker)
  decides "done" — running the verification `command` and reporting exit-0 (objective proof), or a
  conservative model judgment as fallback. Capped (`maxIters`, ceiling 20) + auto-stop on 2 no-progress
  iterations; runs unattended (`permissionMode:"auto"`) but EVERY tool call still scanned fail-closed by the
  gate (the load-bearing safety boundary). `parseGoalVerdict` extracted to `desktop/goal_verdict.ts`, FAIL-
  CLOSED (empty/garbled/malformed ⇒ not-done) with 10 unit tests. `POST /api/goal` streams NDJSON
  (chat events + goal-iter/check/done/stop); `bridge.runGoal` (generalized `streamNdjson`); composer `/goal`
  opens a launcher (goal · verify command · max iters) and renders the loop inline (iteration dividers,
  per-round checker verdict, success/stop banner). Verified live: endpoint + UI both ran a real loop
  (goal→READY, `echo ok`→exit 0→done in 1 iteration); typecheck clean (3 cfgs); goal_verdict 10/10; no console errors.
- **stubbed (P-GOAL.2+):** pause/resume/clear + on-disk loop state (the article's "memory"); a DISTINCT
  checker model (reuses the session model via `complete()` for now — same ADR-0045 model-override wrinkle);
  scheduled automations (the loop's "heartbeat"). No `make demo` (loop needs a live model; parser is unit-tested,
  loop integration-tested live).
- **next:** P-GOAL.2 — persist loop state to disk + pause/resume; then automations/scheduling so a loop can
  run on a cadence (the last missing Loop-Engineering building block in this harness).

-----

## P-GOAL.2: stop a running /goal loop (ADR-0046)
- **shipped:** loop cancellation. `backend.cancelGoal()` (`desktop/acp_backend.ts`) sets a `goalCancelled`
  flag and aborts the in-flight maker turn (`cancel()`); `runGoal` checks it before each iteration and right
  after the maker turn, emitting `goal-stop "stopped by you"` and halting (no checker, no further iterations).
  `goalActive`/`isGoalRunning` track loop state. `POST /api/goal/cancel` (dev.ts) → `cancelGoal`;
  `bridge.cancelGoal`; the composer Stop button routes to the LOOP cancel while a loop streams
  (`goalLoopRunning` flag in `runGoalLoop`, branch in `stopTurn`) and to the normal turn-cancel otherwise.
  Verified live: a 5-iteration loop (verify `exit 1`, so the checker never says done) cancelled mid-iteration
  → `goal-stop "stopped by you"` and the stream ended; goal_verdict 10/10; typecheck clean; no console errors.
- **stubbed:** still no pause/RESUME or on-disk loop "memory" (cancel is a hard stop, not a resumable pause);
  no distinct checker model; no scheduled automations. UI Stop-button routing verified by logic + endpoint
  (the goalLoopRunning branch), not a synthetic button click.
- **next:** P-GOAL.3 — on-disk loop state ("memory") + pause/resume so a stopped loop can be continued; then
  scheduled automations (the loop's heartbeat).

-----

## P-GOAL.3: durable on-disk loop memory (ADR-0046)
- **shipped:** the loop's "memory on disk" (Osmani: "the model forgets between runs, the repo doesn't").
  `desktop/goal_memory.ts` (`startGoalMemory`/`appendGoalIteration`/`finishGoalMemory`) writes a markdown
  record under `<ws>/.omp/loops/<id>-<slug>.md` — goal header + condition + verify command, then an entry
  per iteration (maker summary + checker verdict) and the final result. `pathWithin`-confined, best-effort
  (null/unwritable ⇒ safe no-op, the loop still runs). `runGoal` creates it, references its path in the
  maker prompt, appends each round, and finalizes on done/stop/cancel/error; emits a new `goal-memory`
  event (ChatEvent parity in bridge.ts) and the composer renders a `loop memory: <path>` line. Em dash in
  the verdict swapped to `·` for consistency. 3 unit tests (format · null-safe · path-confined).
  Verified live: a real loop wrote the file with the correct header/iteration/result; `bun test desktop`
  290/290; typecheck clean (3 cfgs); test artifacts cleaned from the workspace.
- **stubbed:** still no RESUME (the memory is written but not yet read back to continue a stopped loop — the
  file format is the foundation for it); no distinct checker model; no scheduled automations. The agent is
  TOLD about the memory file but the loop owns the writes (the agent reads, in-context within a run).
- **next:** P-GOAL.4 — resume from a loop-memory file (read status/last iteration, continue); then automations.

-----

## P-GOAL.4: resume a stopped loop from its memory file (ADR-0046)
- **shipped:** loop resume. `desktop/goal_memory.ts` gains `parseGoalMemory` (pull goal/condition/command/
  iterations + `succeeded` from a memory markdown), `listResumableLoops` (incomplete loops, newest first),
  and `resumeGoalMemory` (reopen an existing file confined to `.omp/loops/`, append a `## Resumed` marker,
  return the prior content). `runGoal` takes `resume?: <rel>` — reuses that memory file (no new one) and
  INJECTS the prior progress into the maker prompt ("do not redo completed work, continue from where it
  stopped"). `GET /api/goal/resumable` + `resume` on the `/api/goal` POST; `bridge.resumableLoops` +
  `GoalOpts.resume` + `ResumableLoop`; the `/goal` launcher shows a "Resume a stopped loop" list. 4 more
  unit tests (parse / succeeded-excluded / lister / resume+traversal-reject). Verified live, full cycle:
  a loop stopped on an unsatisfiable `exit 1` → listed as resumable → resumed (SAME memory file, prior
  progress carried in) → met the condition with `echo ok` → dropped off the resumable list; one file holds
  the whole history (run → `## Resumed` → run → Goal met). `bun test desktop` 294/294; typecheck clean; clean console.
- **stubbed:** resume re-runs fresh maker iterations seeded by the memory (the original ACP session is gone,
  so it's continue-by-context, not session-restore); no distinct checker model; no scheduled automations.
- **next:** P-GOAL.5 — scheduled automations (run a loop / discovery on a cadence) — the last Loop-Engineering
  building block this harness doesn't expose; then a distinct/cheaper checker model.

---
**P-GOAL.5 — scheduled automations (the loop's heartbeat) (ADR-0047)**
- **shipped:** an automation = a saved `/goal` spec + a cadence, run by an IN-PROCESS scheduler (ticks every
  30s while the app is open; never the OS — keeps the fail-closed gate armed, invariant #2/#3). `desktop/automations.ts`
  = store (`<ws>/.omp/automations.json`, pathWithin-confined, fail-safe) + PURE `isDue` (interval `everyMin` OR
  `daily` `hhmm`, local time). Created **disabled** until the user arms it; a tick never preempts a chat/loop/pending
  permission and runs at most one due automation, stamping `lastRunAt` up-front. `runAutomation` reuses `runGoal`
  (same maker/checker, durable memory, gate). Endpoints `GET/POST /api/automations` + `/{enable,delete,run}`; the
  `/goal` modal gained a schedule picker + saved-automations list (toggle · run-now · delete · last-run). 10 new unit
  tests; `bun test desktop` 304/304; typecheck clean (3 cfgs); live-verified CRUD + UI (disabled-by-default, condition
  defaults to command, picker reveals interval/daily, toggle persists), workspace cleaned, clean console.
- **stubbed:** no distinct/cheaper CHECKER model (checker still shares the maker model via `complete()`); no OS-level
  scheduling for app-closed runs (intentionally out of scope — fail-closed grounds); run-now streams, background ticks don't.
- **next:** distinct/cheaper checker model — the last stub on the goal loop; the Loop-Engineering building blocks are now all exposed.

---
**P-GOAL.6 — a distinct, recommended checker model for the loop (ADR-0048)**
- **shipped:** the /goal checker now runs on a RESOLVED checker model (user's choice → auto recommendation →
  maker model), drawn only from the user's own accessible picker. `desktop/checker_model.ts` (pure, 9 tests):
  recommend by tier (haiku/flash/mini over nano/lite/oss over flagship) → same provider family → newest version
  (dates stripped, light flagship-cost tiebreak) → clean alias. `complete()` gained an optional per-session
  `model` (session/set_config_option before the prompt — chat session untouched; best-effort/fail-safe). A
  stale override falls through to the recommendation, empty list to the maker model. Persisted as `checkerModel`
  in GUI settings (""=auto). `GET/POST /api/checker-model`; the /goal modal got a "Checker model" picker (Auto —
  recommended: <name> + one-line why, then provider-grouped list). Automations inherit it. `bun test desktop`
  313/313; typecheck clean (3 cfgs). Live-verified: maker opus-4-8 → recommends haiku-4-5; override persists +
  resets; real loop ran with checker forced onto a DISTINCT haiku-4-5 (echo ok → exit 0 → goal-done). Workspace cleaned.
- **stubbed:** recommendation is a name-pattern heuristic (no live price table / per-token cost data); cross-family
  version scale is approximate (only compared within a provider); no per-automation checker override (global setting).
- **next:** the Loop-Engineering building blocks are all exposed now — natural follow-ups are a price-aware ranker and per-automation checker overrides.

---
**P-GOAL.6.1 — checker picker: GOV lock, readability, token estimate (ADR-0048 addendum)**
- **shipped:** AskSage lock (user OR managed) now restricts the checker's accessible models to GOV-only AskSage
  routes in `accessibleModels()` (fail-safe narrow; constrains both picker + recommendation; locked → recommends
  asksage-google/google-gemini-3.5-flash-gov). Checker picker/label/why text bigger + higher-contrast (13px/--txt-2).
  Live token estimate at the modal's lower-left (`desktop/loop_estimate.ts`, pure, 3 tests): iters × (~9k maker +
  ~1.5k checker), clamped 1..20, hover names maker+checker models + explains it's a ceiling; "Auto" option label
  em-dash-free. `bun test desktop` 316/316; typecheck clean. Live-verified: lock → 2 GOV options; estimate 6→63k,
  12→126k; tooltip renames checker on override; reset clean; no console errors.
- **stubbed:** estimate is a flat per-iteration heuristic (no live price/cost table, no thinking-budget factor).
- **next:** a price-aware ranker + cost (not just token) display; per-automation checker override.

---
**P-GOAL.7 — /goal launcher: dollar estimate + per-run model/skill/persona (ADR-0049)**
- **shipped:** the goal modal now shows a cache-rationalized DOLLAR estimate (`~$0.00 · ~Nk tokens · N loops`)
  at the lower-left via the premium `data-tip` tooltip. `desktop/model_pricing.ts` (pure, 6 tests): price a model
  from the user's ACTUAL usage-ledger cost÷tokens when metered, else a per-tier LIST table; `estimateGoalCost`
  (loop_estimate, +4 tests) splits in/out tokens, prices maker+checker separately, discounts cached input at 10%
  using the observed cache-hit rate. New "Run with" row: base model / thinking / skill / persona selects, defaulting
  to session state, updating the estimate live and applied to the session ONLY at Run time (browsing never mutates).
  Whole module text enlarged + higher contrast. `bun test desktop` 326/326; typecheck clean (3 cfgs). Live-verified:
  opus $1.05 → haiku $0.06 → haiku×12 $0.13; premium tooltip renders (title + cache text); session unchanged while
  browsing; pickers populate (8 model groups, thinking, bundled skills, persona); no console errors; session reset clean.
- **stubbed:** list prices are approximate + age (actual-usage pricing is exact only for metered models); saved
  automations don't yet capture the run-with selections; per-iteration token split is a flat heuristic.
- **next:** carry run-with into automations; a maintained price table or a live pricing source.

---
**P-GOAL.8 — /goal launcher: guided walkthrough + premium tooltips + lockdown base model (ADR-0050)**
- **shipped:** the goal modal defaults to a 5-step GUIDED walkthrough (Goal / Verification / Effort+checker /
  Run with / Schedule), 1-3 inputs per step with a note + premium info-dot tooltip; Back/Next nav (step 1 requires
  a goal); an "Advanced" pill top-right toggles the all-at-once view and persists (localStorage). Same field DOM
  backs both modes, so all existing wiring is unchanged. Fixed the cost tooltip rendering UNDER the modal (#tip
  z-index 120 -> 260). Verification command now has a ~20-entry datalist of common commands (free-typing preserved).
  AskSage lockdown: the BASE model picker is now restricted to AskSage-routed models, grouped Gemini -> GPT ->
  Anthropic (GOV first within each, via model_families groupByFamily/sortGovFirstNewest), RAG/aux excluded; checker
  stays GOV-only. typecheck clean (3 cfgs); bun test desktop 326/326. Live-verified: guided default, step nav +
  empty-goal guard, advanced toggle persists, tooltip renders above modal (z 260>200), 5 info dots, 20 cmd
  suggestions, lockdown base list all-AskSage ordered Gemini/GPT/Anthropic; session model restored; no console errors.
- **stubbed:** lockdown detection uses the user asksageOnly flag in the renderer (backend already enforces the
  checker GOV filter); walkthrough copy is static; datalist styling is the native control.
- **next:** carry run-with into saved automations; a maintained/live price source.

---
**P-GOAL.8.1 — walkthrough polish: combobox, step order, skill/persona fixes**
- **shipped:** replaced the mispositioned native <datalist> with a custom verify-command combobox anchored
  directly under the field (filter + click + arrow/Enter nav, free-typing preserved). Back chevron now points
  left (rotate 180). Reordered guided steps so "Run with" (base model) is step 3, BEFORE "Effort and grading"
  (iterations + checker) at step 4. Skill picker now excludes meta skills (goal, loop-engineering, plan, explain,
  session-handoff) — only build-oriented skills suited to a loop. Persona dropdown shows the human description,
  not the numeric id. typecheck clean; bun test desktop 326/326. Live-verified: menu sits under the field (4px,
  left-aligned), Back arrow matrix(-1,0,0,-1,0,0), step3=Run with / step4=Effort, 9 build skills only, persona
  names; no console errors.
- **next:** carry run-with into saved automations; a maintained/live price source; shorter persona display names.

---
**Locked-down fixes: AskSage Claude tool use (ADR-0051) + Monaco CSP (ADR-0052)**
- **shipped:** (1) AskSage Anthropic route is now TOOL-CAPABLE — harness/omp/asksage_stream.ts passes
  context.tools as input_schema (via omp toolWireSchema), parses tool_use blocks into omp ToolCalls, builds
  proper tool_use/tool_result message structure (toAnthropicMessages), and emits toolcall_start/end + stopReason
  "toolUse" so omp executes the call and loops (each scanned by the gate). Google/RAG stay text-only (out of
  scope, no regression, never sent tools). 5 new tests (asksage_stream.test.ts). (2) Monaco CSP relaxed two
  directives in index.html: font-src adds data: (codicon font is inlined as data:font/ttf in Monaco's min build),
  worker-src adds blob: (language-service worker) — egress still locked by connect-src/script-src. bun test
  harness 471 · desktop 326 · typecheck clean (3 cfgs). Live-verified: blob worker constructs + data: font load
  raise ZERO CSP violations; tool-use unit tests cover the wire format + event emission + round-trip.
- **stubbed:** Gemini tool use (needs functionDeclarations) deferred; AskSage tool use verified via mocked HTTP
  (live gov-gateway round-trip is the manual check in the bug doc).
- **next:** Gemini functionDeclarations tool support if needed; live end-to-end tool run on the gov gateway.

---
**AskSage Gemini tool use (completes ADR-0051)**
- **shipped:** the AskSage Gemini route is now tool-capable, mirroring omp's native Google provider:
  callGoogle sends functionDeclarations (parametersJsonSchema via normalizeSchemaForGoogle+toolWireSchema),
  parses functionCall parts into omp ToolCalls (synthetic id; results replayed by NAME since Gemini gives no
  id), and toGoogleContents rebuilds functionCall (model turn) / functionResponse (merged user turn) for
  multi-turn loops. Shared emit() path → same toolcall events + gate scanning as Anthropic. RAG /query stays
  text-only. 3 new Gemini tests (+4 Anthropic) = 7 in asksage_stream.test.ts. bun test harness 473 · desktop
  326 · typecheck clean (3 cfgs).
- **stubbed:** verified against mocked HTTP only — live AskSage gov-gateway tool round-trip (both Claude and
  Gemini) is the manual check; parametersJsonSchema assumes AskSage's Gemini proxy is current (omp uses it for
  real Gemini).
- **next:** live end-to-end tool run on the gov gateway for both providers.

---
## P-RAG.1: the local knowledge spine (ADR-0058, first build under ADR-0053)
- **shipped:** the air-gap-clean RAG core, server-side, no new runtime deps. `Db.open(path, migrationsDir?)`
  parameterized (additive; every existing caller unchanged) so a SEPARATE `knowledge.duckdb` gets its own
  migration set (ADR-0053 #3); migration `0010_knowledge_vectors.sql` (kb_datasets U|CUI/local|asksage +
  kb_chunks with `embedding FLOAT[]` + trust_label) applies ONLY to it, never agent_obs.duckdb. New
  `harness/knowledge/`: pure `chunk.ts` (overlapping, boundary-preferring, deterministic); `embedder.ts`
  (an `Embedder` interface + deterministic dependency-free `HashEmbedder`, so the spine is testable offline
  and the real WASM bge drops in later behind the same seam); `store.ts` (dataset/chunk CRUD + brute-force
  `list_cosine_distance` retrieval, vectors inlined as numeric SQL list literals since the node binding
  can't bind a JS array param); `ingest.ts` `ingestText` (chunk -> scanAndDecide fail-closed -> embed only
  clean -> store; blocked chunk never embedded/stored, audited via an `onBlock` hook = clean layering) +
  `wrapRetrieved` (UNTRUSTED_CONTENT delimited, invariant #5). 20 new tests; bun test harness 493 · desktop
  326 · typecheck clean (3 cfgs). `make demo-P-RAG.1` proves it against the REAL scanner + a temp
  knowledge.duckdb: clean doc stored, Trojan-Source (bidi/zero-width) note blocked + never stored, cosine
  retrieval returns the relevant chunk first, injection delimited.
- **stubbed:** the embedder is the deterministic `HashEmbedder`, NOT a real model (P-RAG.1b: WASM
  `bge-small-en-v1.5` + bundled weights + `unpdf` PDF parse). No Knowledge UI / per-turn injection wiring yet
  (P-RAG.1c). New EventNames deferred (a contracts change is its own increment). No live multimodal.
- **next:** P-RAG.1b (real WASM embedder + PDF parse behind the `Embedder` seam, weights bundled as
  extraResources), then P-RAG.1c (Knowledge popup guided+advanced for the local path, fixed-path
  knowledge.duckdb, desktop recordBlock via onBlock, retrieval injection mirroring the dataset selector).

---
## P-ASKSAGE.1: AskSage tool-loop diagnostics + tolerant extraction (ADR-0059)
- **shipped:** live UI testing showed AskSage Claude/Gemini run tools but the loop "gives up too soon"
  (half-done files, no retry, no visible reasoning) while public models + AskSage GPT do fine — GPT uses
  omp's NATIVE openai-completions provider, Claude/Gemini use our non-streamed streamSimple adapter, so
  the bug is isolated there. Most likely silent cause: a follow-up reply parsed to empty text + 0 tool
  calls → omp thinks the model finished. Fix: (1) per-call diagnostics in asksage_stream.ts — one
  `[ASKSAGE_DIAG] {json}` line per call (env LUCID_ASKSAGE_DEBUG) capturing request (route/model/maxTokens/
  tools/msgs) + parsed response (status/respKeys/via/textLen/toolCalls/stopReason/usage), with an explicit
  `empty-response`/`truncated` anomaly + raw snippet on the give-up path; (2) tolerant extraction
  (anthropicBlocks/googleParts) that recovers content from wrapped shapes (response.content,
  OpenAI choices[].message, plain-string message) — fires ONLY when the strict parse is empty, so it can
  only turn a premature empty stop into a real turn; (3) acp_backend sets the env in DEVELOPER MODE,
  onStderr rings the diagnostics (last 200) + echoes to console; (4) renderer Logs → "AskSage tool calls"
  accordion (auto-opens + chip on any anomaly); toggling developer mode respawns omp (backend.restart on a
  real change) so the debug env takes effect with NO app restart. Also ADDED the missing Developer-mode
  toggle to Settings (Settings → Developer) — the #devModeToggle handler existed but no card rendered it,
  so dev mode (and thus the Logs panel + these diagnostics) was unreachable from the UI; live-verified the
  card renders, toggles on/off, and respawns cleanly. ALSO added the missing #railLogs rail button (its
  loadDev() un-hide existed but no button was rendered) AND fixed focusInspector so an explicit Logs/Memory
  click from the collapsed metrics rail is no longer hijacked to Security by the ADR-0021 active-blocks
  override — live-verified the Logs button appears in dev mode and opens the Developer-logs panel (AskSage
  accordion at top). 7 new tests (asksage_stream 14 total); harness 500 ·
  desktop 326 · typecheck clean · bundle OK. demo-P-ASKSAGE.1 proves recover/flag/off-by-default.
- **stubbed:** thinking-block relay (no reasoning shown yet) and a max_tokens override are DEFERRED until
  the live diagnostics say which failure it is; whether omp re-invokes streamSimple after each tool result
  for a custom provider is now observable (the per-call log) but unconfirmed live. Tolerant fallbacks are
  for SHAPES NOT YET CONFIRMED against the real gateway (conservative — only recover, never override).
- **next:** the user re-tests live with developer mode on; read the AskSage-calls diagnostics (look for
  `empty-response`/`truncated`/error rows + the `via`/raw shape) and fix the confirmed root cause
  (likely either a wrapper shape to parse, a max_tokens bump, or relaying thinking).

---
**AskSage Stop fix + live, readable Logs (follow-ups to P-ASKSAGE.1, ADR-0059)**
- **shipped:** (1) STOP now cancels AskSage turns — omp passes options.signal (AbortSignal, aborted on
  session/cancel) but the adapter ignored it, so a non-streamed AskSage fetch ran on after Stop and the
  turn hung; threaded signal into every fetch (anthropic/google/query) + settle cleanly (done/stop, no
  error) on abort. (2) Developer Logs poll live — refresh() re-fetches /api/dev while the Logs tab is open,
  so AskSage rows + transcripts update mid-turn instead of only on tab-switch/refresh. (3) Turn transcripts
  + AskSage calls now render NEWEST-FIRST with a US-Eastern (auto EST/EDT) timestamp column. 1 new abort
  test (asksage_stream 15); harness 501 · desktop 326 · typecheck clean · bundle OK; live-verified the
  transcript order + EDT stamps.
- **stubbed:** the native-provider hang (public Claude/Opus "searching the codebase" that wouldn't stop) is
  NOT this fix — that path is omp-native and was already cancellable; if it recurs it's a separate
  gate/omp-level investigation. Live gov-gateway Stop round-trip still the manual check.
- **next:** user re-tests live: AskSage rows should populate without a refresh, Stop should end a hung
  AskSage turn, transcripts newest-first with ET times. Then read the diagnostics for the give-up root cause.

---
**Stop reliably recovers a wedged turn (client-side abort) — follow-up to ADR-0059**
- **shipped:** live AskSage Claude-45-Sonnet-Gov trace showed a HEALTHY adapter loop (read→write→end_turn,
  msgs 27→29→31, all ok via:content, no anomalies) yet the chat UI hung showing only the first tool call
  and Stop didn't recover it. Root cause: the turn settles only when bridge.sendPrompt's NDJSON stream
  ends; if omp never resolves session/prompt (turn-finalization wedge — the model finished but omp didn't
  close the stream), reader.read() blocks forever and the UI is stuck. Fix: streamNdjson takes an
  AbortSignal; a module-level chatAbort controller wraps the chat stream; cancelChat() now aborts it
  (client read ends → sendPrompt resolves → the send finally settles the UI) AND posts the server cancel.
  So Stop ALWAYS recovers the UI even when omp is wedged. typecheck clean · desktop 326 · bundle OK.
- **stubbed:** the underlying wedge (omp not resolving session/prompt after a custom-provider turn ends, and
  only the first tool_call reaching the desktop over ACP while the model loop ran ahead) is an
  omp-integration issue not root-caused here — the adapter is provably healthy (stderr diag), the gap is in
  omp's ACP session/update + prompt-completion emission for the custom streamSimple provider. No client
  watchdog added (a single gov-gateway call can exceed 60s, so a silence-timeout would false-settle).
- **next:** capture omp's own logs during a wedge to see why session/prompt doesn't resolve; consider an
  omp issue/upstream fix or a per-turn server-side timeout in acp_backend.prompt().

---
**Chat reconciles full reply on `done` (follow-up to ADR-0059)**
- **shipped:** live AskSage turns sometimes completed server-side (captured in the turns log) yet the chat
  showed only the first tool call and no answer until a browser reload (which then lost the live tool chips
  + time/token stats). The server-side `assistant` accumulator and the browser stream are fed by the same
  listener, so a completed turn HAS the full text. Now `prompt()` emits `{type:"done", text: assistant}`
  and the renderer reconciles: on done, if the server's full text is longer than what streamed, it replaces
  buf — so the complete final answer always renders when the turn settles, even if live token chunks were
  lost. typecheck clean · desktop 326 · bundle OK.
- **stubbed:** this only helps when `done` REACHES the browser. The deeper failure — omp not resolving
  session/prompt at all (a genuine wedge: the model finished per the stderr diag + turns log, but the ACP
  turn never closes) and intermediate tool_call/agent_message events dropping mid-stream — is an
  omp-integration issue that needs omp's own logs to root-cause. Stop (client abort, prior commit) is the
  recovery path meanwhile.
- **next:** capture omp's terminal output during a wedge; determine if it's every AskSage turn or only
  long multi-tool ones; consider a server-side per-turn timeout in acp_backend.prompt() as a backstop.

---
**Turn-lifecycle diagnostics + listener-clobber guard (debugging the AskSage long-turn hang, ADR-0059)**
- **shipped:** user confirmed long multi-tool AskSage turns hang with done never reaching the browser (blank
  till reload). Added `[TURN_DIAG]` logging (developer mode → dev-server console): prompt.start /
  prompt.resolved|stalled|error (with chars, enqueueErr, listenerIntact) / complete.end (clobberAvoided) /
  chat-stream-write-failed. This disambiguates the three hypotheses on the NEXT hang: omp wedge (no
  prompt.resolved line ever), listener clobber (listenerIntact=false), or browser disconnect (enqueueErr>0 /
  write failed). Also: sink now swallows onEvent throws (counts enqueueErr) so a closed browser stream can't
  break the server turn; and complete() no longer restores the shared this.listener if a chat turn took it
  over mid-completion (clobberAvoided) — a real orphan bug for overlapping turns. typecheck · desktop 326 ·
  bundle OK.
- **stubbed:** root cause still unconfirmed pending a live `[TURN_DIAG]` capture; if it's the omp wedge
  (session/prompt never resolving while events trickle, so the 2-min idle never fires) the fix is upstream
  or a hard per-turn cap (user deferred the timeout).
- **next:** user reproduces a long-turn hang with developer mode ON and pastes the `[TURN_DIAG]` lines from
  the dev-server terminal; that pins wedge vs clobber vs disconnect and the fix follows.

---
**P-EGRESS.1 UI polish: docked, subdued, de-duplicated egress dialog (ADR-0062)**
- **shipped:** per UX feedback — the egress approval card now DOCKS directly above the prompt bar (egressDock
  in .composer-wrap) instead of inline in the chat; restyled subdued to match the app (outline buttons, no
  bright magenta fills, thin amber accent, app text styles); the choices were de-duplicated from 5 to 4
  ("ask me every time" had the same outcome as "Allow once" — both ask again next time — so it was dropped):
  Allow once / Always allow this site / Always allow every site (amber-tinted = the risky one) / Block. On
  answer the docked card removes itself + a brief toast. typecheck clean · bundle OK · egress tests 13 ·
  card visually verified in the dev server.
- **next:** remaining selected threads — tool curation, lossy streaming ([TURN_DIAG]), P-CONTINUE.1.

---
**P-GOAL.9 — /goal After-Action Report + termination guards (ADR-0054)**
- **shipped:** the loop's LAST task is now an After-Action Report — `desktop/loop_report.ts` (PURE,
  unit-tested) renders a deterministic markdown AAR with portable Mermaid graphs (pie: Tool Calls by type;
  xychart bars: LOC added/removed + Errors per iteration) + a unicode scoreboard + Websites-visited table,
  written beside the memory file via `saveGoalReport` (same `<id>-<slug>` stem, `.report.md`) and streamed
  as a new `goal-report` ChatEvent rendered as a collapsible card in the chat. Same instrumentation powers
  three guards: convergence-stall detection (3 identical checker blockers → stop "not converging", #2
  Infinite Fix Loop), per-iteration tool-failure counts fed back into the next maker prompt (#3), and LOC
  via best-effort git numstat. Fixed the resume bug: `prior.slice(0,3000)` (head/stale) → `slice(-3000)`
  (most-recent rounds). bun test desktop 143 pass (+19 new; 4 fails are the pre-existing missing-omp-dep
  env issue, unchanged from baseline); `make demo-P-GOAL.9` green; AAR artifact renders pie+bar on GitHub/VSCode.
- **stubbed:** typecheck not run here (this container lacks @types/node/electron/bun); in-app `marked` view
  shows the scoreboard+tables, not Mermaid (charts live in the on-disk record by design).
- **next:** structured JSONL run-log for cross-run success-rate/eval; live per-loop token budget + kill
  switch; escalation ping on unattended stop (loop-engineering Token Burn / Escalation Failure).

---
**P-GOAL.10 — cross-run evaluation: the /goal run-log + stats surface (ADR-0055)**
- **shipped:** every completed /goal run now appends one compact JSON line to `.omp/loops/run-log.jsonl`
  (best-effort, path-confined, written in runGoal's finally beside the AAR). New PURE `desktop/loop_runlog.ts`
  (unit-tested) projects a P-GOAL.9 LoopMetrics → record, round-trips JSONL (malformed lines skipped), and
  `aggregateRuns` computes the eval stats: success rate, avg iterations-to-success (over met runs), avg
  duration, summed tools/LOC/errors, and a failure breakdown that collapses recurring blockers via
  stallSignature. Surfaced via backend `loopRunStats()` → `GET /api/goal/stats` → a compact evaluation
  banner in the /goal launcher (hidden until there's history). Flat JSONL by design — stays in the
  goal-memory lane, never touches the frozen DuckDB schema (invariant #10). bun test desktop 158 pass
  (+11 new); `make demo-P-GOAL.10` green; typecheck clean across all 3 desktop/root tsconfigs (verified
  after installing the container's missing bun/node type stubs, then reverting the manifest).
- **stubbed:** the launcher shows aggregate stats + a 10-run recent slice from the API but no deep
  per-run history drill-down UI yet (records carry enough to build it without a migration).
- **next:** live per-loop token budget + kill switch; escalation ping on unattended stop (loop-engineering
  Token Burn / Escalation Failure) — both can read/append this same ledger.

---
**P-GOAL.11 — live spend meter + budget kill switch (ADR-0056)**
- **shipped:** the /goal loop now meters ACTUAL spend and enforces an optional hard dollar cap (loop-
  engineering "Token Burn" kill switch). New PURE `desktop/loop_budget.ts` (unit-tested) sums each maker
  turn's peak cost (context tokens tracked as a high-water mark, never summed) and `overBudget` trips the
  switch. runGoal aborts the in-flight turn the instant running spend crosses the cap, then ends the loop
  "budget cap $X reached" before wasting a checker call. Spend flows through everything the metrics already
  touch: LoopMetrics gains spendUsd/peakContextTokens/budgetUsd (null when no usage telemetry, not $0); the
  After-Action Report shows a Spend row; the run-log + cross-run eval sum actual spend; a "Budget cap" field
  sits beside Max iterations in the launcher (plumbed via GoalOpts → /api/goal → runGoal). bun test desktop
  195 pass / 0 fail (+10 new); make demo-P-GOAL.{9,10,11} green; typecheck clean across all 3 tsconfigs.
- **stubbed:** scheduled automations run uncapped for now (the iteration cap still bounds them) — a budget
  field on the Automation schema/form is the clean follow-on; the meter measures MAKER spend (checker runs
  in a separate throwaway session, cheap by ADR-0048 design).
- **next:** escalation ping on unattended stop (loop-engineering Escalation Failure) — the last follow-on;
  then a budget field for automations.

---
**P-GOAL.12 — the Pre-Flight Audit: loop design + readiness before you build (ADR-0057)**
- **shipped:** an optional "Pre-Flight Audit" button above the Goal input that pauses the builder and
  designs the loop first. New PURE `desktop/loop_preflight.ts` (unit-tested): `assessReadiness` scores the
  spec L0→L3 with GATED levels (L3 needs the safety-bearing four — verify command, budget, scope, cheap
  checker — so a verbose goal can't buy L3 without a real verifier); `renderLoopDesign` emits a repeatable
  Loop Design .md; history awareness (`relevantPriorRuns`/`renderPriorRuns`) surfaces prior runs of a similar
  loop so context isn't lost; a prompt-engineering interview (`preflight*Prompt`/`parsePreflightJson`/
  `mergeMatured`) matures the goal with user/PO + engineer feedback; `successCriteria` distills the checker's
  grading rubric. Backend `preflightAudit` reads the run-log, runs ONE interview pass on the cheap checker
  (best-effort, deterministic fallback), writes `.omp/loops/*.preflight.md`, returns matured goal + criteria;
  `loopScopes` lists branches/worktrees. The checker (`runGoal`/`checkGoal`) now grades against the matured
  `criteria` and reports which are met/unmet — closing the recursive self-improvement loop (AAR/run-log →
  preflight → run → AAR). UI: scope picker + interview panel + readiness chip + rendered report + "Adopt as
  goal". bun test desktop 216 pass / 0 fail (+21); make demo-P-GOAL.12 green; typecheck clean across all 3
  tsconfigs (verified with electron/node/bun types installed, manifest reverted).
- **stubbed:** the interview is one structured maturation pass (not open-ended multi-turn); adopting carries
  criteria to the immediate next run only; automations still don't take a budget/criteria.
- **next:** escalation ping on unattended stop; a budget + criteria field for scheduled automations; an
  optional multi-turn interview.

---
**P-RAG.1b - the real bge-small embedder (ADR-0063)**
- **shipped:** `TransformersEmbedder` (bge-small-en-v1.5, 384d, transformers.js) behind the unchanged P-RAG.1 `Embedder` seam - semantic retrieval proven by `demo-P-RAG.1b` (a query sharing ZERO content words ranks the right chunk first: kittens d=0.47 vs 0.58/0.72); air-gap `modelPath` option (local weights + remote disabled); opt-in real-model test (`LUCID_TEST_EMBED=1`). harness 513 pass / 1 skip / 0 fail; typecheck clean.
- **stubbed:** the WASM web-build backend + bundled model WEIGHTS for the PACKAGED app are deferred to P-RAG.1c (node/native backend works in the harness + dev server today); the embedder is not yet imported by the chat path.
- **next:** P-RAG.1c - Knowledge ingest UI + PDF (`unpdf`) + image caption-at-ingest + per-turn retrieval injection + the WASM packaging (bundle weights as extraResources).

---
**P-RAG.1c slice 1 - PDF ingest through the same scan gate (ADR-0064)**
- **shipped:** `harness/knowledge/pdf.ts` - `extractPdfText` (unpdf/pdf.js, pure JS, air-gap clean; fail-closed `%PDF-` sniff + non-destructive copy) and `ingestPdf` that delegates to the UNCHANGED scan-gated `ingestText`, so PDF pages are gated/embedded exactly like .txt; `demo-P-RAG.1c` proves semantic retrieval FROM a 3-page PDF (zero-shared-word query ranks the pets page first, d=0.45 vs 0.58/0.70) + a corrupt PDF fails closed; `pdf.test.ts` covers a POISON page blocked + a dead scanner; `pdf_fixture.ts` (test-only PDF writer, no binary in git). harness 518 pass / 1 skip / 0 fail; typecheck clean; new DIRECT dep `unpdf`.
- **stubbed:** image/scanned-PDF OCR (a text-less PDF yields zero chunks, not an error); PDF code is not yet imported by the dev server / chat path (only pdf.ts + its test + demo).
- **next:** remaining P-RAG.1c slices - WASM packaging (web build + bundled weights as extraResources), per-turn retrieval injection into chat, Knowledge ingest UI + image caption-at-ingest.

---
**ADR-A009 / #74 - managed-config update channel (OSS-core)**
- **shipped:** `managed_config.ts` gains `updateChannel: "github"|"feed"|"managed"` + `updateFeedUrl` and a PURE `resolveUpdatePolicy` (fail-safe: unmanaged/unknown→github, feed-without-url→managed, managed→disabled); `updater.ts` honors it - `managed` skips the in-app check entirely (no offline nag/hang), `feed` points electron-updater's generic provider at the customer mirror, `github` unchanged. 8 new tests; full typecheck clean.
- **stubbed:** the internal-feed mirror layout + native enterprise packages (MSI/MSIX/rpm/deb/pkg) are the rest of ADR-A009 (private follow-on issues #75-79); macOS feed-update still needs signing.
- **next:** wire the channel into the managed-config TEMPLATE + ADMX (private ADR-A010), and the Channel-B/C packaging.

---
**P-BRIEF.1 - Executive Engineering Update generator (ADR-0070)**
- **shipped:** `harness/brief/engineering_update.ts` (PURE, air-gap) - parses PROGRESS.md + DECISIONS.md (+ optional AAR) into a typed `EngineeringUpdate` (load-bearing deps / tech debt / upcoming decisions / shipped / risks) and renders a written brief AND a TTS-ready two-host podcast script; a vendor-agnostic `PodcastBackend` seam with a `ScriptOnlyBackend` default (no cloud key needed). `demo-P-BRIEF.1` runs against THIS repo's logs (6 shipped, the ADR-0067→0066 edge, 7 debt, 12 decisions). Deep-research chose the backend: NotebookLM Enterprise audioOverviews API (primary), ElevenLabs (multi-vendor), Podcastfy+Kokoro (air-gap), NO headless browser. 10 tests; typecheck clean.
- **stubbed:** the audio adapters (NotebookLM Enterprise / ElevenLabs / Podcastfy+Kokoro) behind the seam, Slack/Workspace delivery, and the Goal Loop accordion config are P-BRIEF.2/.3.
- **next:** P-BRIEF.2 - implement one audio backend (likely ElevenLabs or Podcastfy+Kokoro first) + delivery, egress/managed-config gated.

---
**P-BRIEF.2 - first audio backend: OpenAI-compatible (Kokoro) TTS (ADR-0071)**
- **shipped:** `harness/brief/tts_backend.ts` - `OpenAiCompatibleTtsBackend` fills the ADR-0070 `PodcastBackend` seam: POSTs each turn to `{baseUrl}/v1/audio/speech` (self-hosted Kokoro / any OpenAI-compatible TTS) with a per-speaker voice, concatenates the WAV segments into one briefing. PURE chunk-aware `parseWav`/`buildWav`/`concatWav` + injectable `fetchImpl` = fully tested offline (9 tests). Fail-safe: any synth error degrades to script-only. `demo-P-BRIEF.2` runs repo-logs→script→synth→WAV via a mock by default (air-gap/CI), live with `LUCID_TTS_BASE_URL`. No new Python (invariant #2); `PodcastResult` gained additive `audio?`.
- **stubbed:** delivery (Slack `files.upload` + Workspace MCP) and the cloud adapters (NotebookLM Enterprise, ElevenLabs) are P-BRIEF.2b; the Goal Loop accordion is P-BRIEF.3.
- **next:** P-BRIEF.3 - Goal Loop accordion (provider picker + cadence + destinations) WITH a premium hover tooltip framing it as mitigating "Cognitive Surrender and Information Overload" / finding signal in the noise during orchestration looping.

---
**P-BRIEF.3 - Engineering Update in the Goal Loop UI (ADR-0072)**
- **shipped:** a `<details class="goal-eu">` accordion in the goal modal's last step (provider picker Script-only|Local-TTS, "Generate update now", inline brief) with a PREMIUM `goalInfoDot` tooltip using the user's exact framing ("Cognitive Surrender and Information Overload" / signal in the noise during orchestration looping); read-only `GET /api/brief` (desktop/dev.ts) runs the pure `buildEngineeringUpdate` over the repo's DECISIONS/PROGRESS and returns `{brief, scriptText, counts}`, rendered via DOMPurify `renderMarkdown`; `bridge.engineeringBrief()` typed client; provider choice persists to localStorage. Preview-verified (endpoint 200 + correct counts; markers in served /app.js; typecheck clean; no console errors).
- **stubbed:** audio playback + Slack/Workspace delivery (P-BRIEF.2b); the cloud adapters (NotebookLM Enterprise, ElevenLabs) behind the same seam.
- **next:** P-BRIEF.2b - render the podcast audio via the selected backend + deliver (Slack files.upload / Workspace MCP), egress + managed-config gated.

---
**P-STT.1 - speech-to-text (mic) behind a vendor-agnostic seam (ADR-0073)**
- **shipped:** `harness/voice/transcription.ts` - `TranscriptionBackend` seam + `OpenAiCompatibleSttBackend` (POSTs mic audio as multipart to `{baseUrl}/v1/audio/transcriptions`; self-hosted Whisper / any OpenAI-compatible endpoint). Air-gap default (local Whisper, audio never leaves host), NO new Python (invariant #2), transcript is ordinary user input through the existing scanned path (no new trust surface). Injectable `fetchImpl` + fail-safe (empty audio short-circuits; error/non-200/missing-text → empty transcript, never throws). 5 tests; `demo-P-STT.1` (mock offline, `LUCID_STT_BASE_URL` live). The symmetric mirror of P-BRIEF.2's TTS backend.
- **stubbed:** the mic button UI in the chat + goal composer is P-STT.2 (record → transcribe → fill the field), with two guardrails: local-only STT under managed lockdown; no voice-confirm of a catastrophic exec-approval.
- **next:** P-STT.2 - the composer mic UI + MediaRecorder capture, egress/managed-config gated.

---
**P-GOAL-DIAG.1 - maker-turn diagnostics for the Anthropic empty-loop bug (ADR-0074)**
- **shipped:** dev-mode `turnDiag` instrumentation in `acp_backend.ts` - `prompt.resolved … stopReason=` (omp turn stop reason, now captured) + per-iteration `goal.iter <i> maker-turn: answer_chars=… thinking=…/…c tools=… blocks=… acted=…`. Pinpoints whether a Claude maker turn is thinking-only (answer_chars=0, tools=0, thinking_chars>0), tools-not-surfacing, or empty/early-ended. No behavior change; developerMode-gated; typecheck clean.
- **stubbed:** the FIX awaits one Claude `/goal` run's data (manage maker thinking / feed thinking to the checker / fix event mapping or file an omp issue). The GPT "stall" is the by-design maker->checker pause (optional "Checking…" indicator is a separate follow-up).
- **next:** run a Claude goal loop with Developer mode on, read the `[TURN_DIAG] goal.iter` lines, then ship the targeted fix.

---
**Packaging: Linux rpm (YUM/DNF) + deb (APT) + internal-mirror runbook (PI-4/ADR-A009, #76)**
- **shipped:** `desktop/package.json` build.linux now targets `["AppImage","deb","rpm"]` with `deb`/`rpm` config blocks (runtime `depends`, versioned `artifactName`, maintainer/vendor). `build-desktop.yml` attaches `*.deb`/`*.rpm` to run artifacts + tag and rolling-"latest" releases (Linux matrix builds them via `dist:linux`). `docs/LINUX-ENTERPRISE-DEPLOYMENT.md`: org-key GPG signing (`rpm --addsign`; APT signs the repo `Release`), YUM (`createrepo_c`) + APT (`reprepro`) internal-mirror layout, client `.repo`/sources.list, `dnf/apt install`+`upgrade` runbook, and the upgrade-preservation guarantee (user data in `~/.config/LucidAgentIDE`, admin policy in `/etc/lucidagentide/` — neither packaged, so upgrades never clobber them) + the `fpm --config-files` (conffiles/`%config(noreplace)`) recipe for any future packaged `/etc` file. Mirrors the macOS `.pkg` precedent (build target + enterprise runbook in core). package.json valid JSON; workflow YAML valid.
- **stubbed:** producing/installing the actual `.rpm`/`.deb` is CI/runner-bound (electron-builder + `rpm`/`fpm` on a Linux runner) and the air-gap-built variant is gated on the air-gap build profile (#73); the packaging targets, signing, mirror layout, and upgrade semantics are independent of #73 and complete now. Packages are unsigned from CI by design — the org signs with its own key at the mirror.
- **next:** once #73 lands, build on an air-gapped runner and run the §"Validation checklist" (install/upgrade-in-place/data-preservation/signature) on RHEL + Debian.

---
**P-ABOUT.1 - About panel + single-sourced dynamic app version (ADR-0087)**
- **shipped:** animated `#railAbout` rail glyph (book + twinkling sparkle, above Commands/Settings) opens a polished dark-mode About modal (`about.ts`, pure builder) — LUCID · AGENT IDE hero, product blurb, TechLead 187 LLC emblem + BUSL-1.1 terms (Change Date 2030-06-27 → MPL-2.0). Version single-sourced in `desktop/version.ts` (`APP_VERSION`), mirrored by `desktop/package.json`, drift-guarded by a test; launch baseline bumped to **v1.8.7**. Also: BUSL header + `make install-hooks`-per-clone note added to CLAUDE.md/AGENTS.md invariants. `make demo-P-ABOUT.1` green; `about.test.ts` 10/10; desktop typecheck + renderer bundle clean.
- **stubbed:** none. (Optional future: surface the version in the titlebar/status bar too; add an "About" command-palette entry.)
- **next:** live-verify the panel in the preview, then merge to master.

---
**P-EXEC.1 - per-action exec approval gate for bash + eval (ADR-0066, issue #95)**
- **shipped:** `desktop/exec_policy.ts` mirrors egress — pure `classifyCommand` (safe read-only allowlist + git read-only subcommands + safe-program-dangerous-flag table; risky default fail-closed; a non-silenceable catastrophic ALWAYS_PROMPT set: sudo/rm -rf/pipe-to-shell/dd/mkfs/fork-bomb/git reset --hard·clean -f·push --force), `execVerdict`/`applyExecChoice`/`clampExec` + `loadExec`/`recordExec` (`~/.omp/lucid-exec.json`). `acp_config.yml` forces bash+eval→prompt; `acp_backend` onRequest gains an isExec branch (safe→approve · risky→`askExec` interactive or BLOCK unattended · catastrophic always prompts/blocks) + an in-memory allow-turn scope; renderer exec dialog (docked, copy, program+why, high-risk red variant, limited choices for catastrophic/compound). 107-test classifier corpus + `make demo-P-EXEC.1` green; desktop typecheck + renderer bundle clean; live boot smoke clean.
- **stubbed:** ssh + task tools are P-EXEC.2; a dedicated `exec_approved`/`exec_blocked` EventName is a contracts.ts change (own increment, invariant #8) — v1 reuses the permission/block emit.
- **next:** P-GOAL.13 (#97) — grade the classifier into tiers T0-T4 + a per-command-type loop dial that consults `loopVerdict` unattended, and AAR blocks.

---
**P-GOAL.13 - per-command Speed↔Risk dial for the unattended loop + AAR Blocks (ADR-0067, issue #97)**
- **shipped:** `classifyCommand` graded to an ordered tier T0 read-only · T1 local-mutate · T2 reach-out · T3 destructive · T4 catastrophic (fail-closed: unknown/compound = T3); pure `loopVerdict(dialMax, tier)` (auto iff tier ≤ dial; T4 ALWAYS blocks; unset dial = safest T0-only) + `clampDialRow` managed ceiling. `acp_backend` consults the dial in unattended loop mode instead of prompting + records every block; `loop_report` gains `LoopMetrics.blocks` + a **Blocks** section (risk-dial / catastrophic / security-gate tallied separately, by-tier breakdown, dial posture in the header). Renderer **plasma-slider matrix** (green→amber→red, one row per command type) in the goal advanced settings, persisted to localStorage + ridden on the `/api/goal` payload (sanitized server-side). 191 desktop loop/exec tests (tier ladder + every tier×dial + Blocks section) + `make demo-P-GOAL.13` green; live-verified the slider (6 rows, gradient, label + persistence); typecheck + bundle clean.
- **stubbed:** the dial actively gates the SHELL exec path (the security-meaningful one); web rows compose with the egress gate, and edit/delete/subagent rows are recorded posture (omp auto-runs those without a permission request) — a fuller per-type intercept is a follow-up. A dedicated `exec_blocked` EventName stays a contracts.ts increment (#8).
- **next:** P-ENT.2 (#98) — emit every exec/egress/loop/scanner decision as one OCSF-aligned SecurityEvent to a SIEM-ready file sink.

---
**P-ENT.2 - security audit export seam (SIEM-ready, OCSF-aligned) (ADR-0069, issue #98)**
- **shipped:** `desktop/audit_export.ts` — one canonical versioned `SecurityEvent` (metadata only, never raw content), an OCSF Detection-Finding mapper (`toOcsf`, vendor-neutral; class 2004 / category Findings; severity + disposition mapping), a `Sink` interface, a fail-safe `AuditDispatcher` (maps once, fans out, ring-buffers; a dead/slow sink NEVER throws into a turn), and the append-only `FileSink` (`~/.omp/lucid-audit.jsonl`). Emitted ADDITIVELY from `security_log` (scanner block + approve/dismiss) and `acp_backend` (exec gate decision, egress decision, loop dial/catastrophic block). `/api/audit` + a "Security event export (SIEM)" card in the Logs view (unified stream + per-sink delivery status). 13 OCSF/fail-safe tests + `make demo-P-ENT.2`; desktop suite 689/0; typecheck + bundle clean; `/api/audit` live-verified (file sink registered, OCSF-ready).
- **stubbed:** the per-SIEM network CONNECTORS (Splunk HEC, syslog/CEF, Elastic, AWS Security Lake, Azure Sentinel, GCP Chronicle, Tenable) are private-repo IP (ADR-A011) — they implement the SAME `Sink`. A dedicated `exec_blocked`/`audit_export` EventName stays a contracts.ts increment (#8); v1 maps existing records.
- **next:** wire the private SIEM connectors (ADR-A011) behind the `Sink` interface; optional richer dashboard (per-sink retry/backoff, event filters).

---
**P-ROLE.1 + P-ROLE.1b - role onboarding + first-run guided walkthrough (ADR-0088/0089)**
- **shipped:** Four onboarding roles (`developer|security|manager|executive`, closed set) persisted as cosmetic `userRole`/`tourSeen` in `lucid-gui.json` via `/api/settings` + bridge (`saveRole`/`setTourSeen`); fail-safe `normalizeRole` (unknown→developer); two-step first-run flow (role picker → email → tour) + a Settings→Profile role switcher; role→default landing tab (Security→queue, else Memory). The tour (`desktop/renderer/tour.ts`, pure step catalog + `coachHtml`) reuses the model hover-card idiom: a dimmed, dismissable spotlight + anchored premium card (Back/Next/Skip, step dots), tailored per role, opens on the composer + closes on a target-less card, skips absent targets. About gains a "Take the tour" replay button. 15 new tests + `make demo-P-ROLE.1/.1b`; desktop 704/0; root typecheck + license-check clean; live-verified in the dev preview (role gate fires when `role:null`, Security tour spotlights the Security rail, Skip + About-replay both work, no console errors).
- **stubbed:** the full per-role CHROME presets (status pills + quick tiles + rail visibility) are P-ROLE.2; the reveal-on-relevance escalation engine + managed-policy role pin are P-ROLE.3; dedicated Manager/Exec aggregate dashboards are P-ROLE.4 (Mgr/Exec reuse Memory ledger + P-BRIEF for now). Role default surfacing is the landing tab only.
- **next:** P-ROLE.2 — per-role status-bar pills + quick-metric tiles + default rail visibility over the existing panels.

---
**P-NETDIAG.1 - in-app network diagnostics for the OAuth localhost callback (ADR-0090)**
- **shipped:** a developer-mode **Network diagnostics** accordion in the read-only Logs panel, fed by an always-on backend watcher (`desktop/netdiag.ts`, 2s poll, started on dev-mode toggle + self-healed on each `/api/dev` read). Captures loopback connections, EVERY listener incl. all-interface `0.0.0.0`/`[::]` binds (the fix for the missed-bind blind spot), an active TCP probe of the OAuth callback port (`:1455`, `nc -z`-style), Windows DNS cache, and a rolling event log; a new LISTENING socket on a watched/loopback port is flagged a "callback?" candidate (the bind-or-not evidence). Pure parse (`netstat -ano`/`lsof`/`tasklist`) + diff helpers, OS shell-outs read-only. Standalone CLI sibling `tools/netwatch.ts`. 13 tests + `make demo-P-NETDIAG.1`; desktop 731/0 + harness 544/0, typecheck clean; live-verified in the dev preview (watcher live, `:1455` probe closed, 36 listeners with all-interface binds + process names, event table + DNS render, no console errors).
- **stubbed:** macOS/Linux use the `lsof` path with no DNS (unknown OS → `supported:false`, empty non-throwing view); auto-discovery of a provider's EPHEMERAL callback port (vs the fixed `:1455`) leans on the new-listener diff rather than reading the broker's `redirect_uri`.
- **next:** optionally scrape the broker's printed `redirect_uri` to auto-probe the exact (ephemeral) callback port, and add a one-click "watch the next OAuth attempt" highlight that pins the candidate listener.

---
**P-NETDIAG.1b - OAuth re-login self-heal (ADR-0091)**
- **shipped:** root-caused a live "logged into OpenAI but it didn't save" via the vault - `openai-codex` had a valid, freshly-written token but a stale `disabled_cause: "logged out by user"` that omp's re-`login` never clears (and `logout` disables rather than deletes, so the UI could never recover). New `desktop/auth_vault.ts` `clearDisabledCredential(provider)` nulls ONLY that flag (token blob untouched, read-before-write, `busy_timeout`, best-effort); wired into `dev.ts startOauthBroker` success path so a login self-heals before `backend.restart()`. One-shot CLI `tools/omp_auth_reenable.ts` un-stuck the user's `openai-codex` live (now `[ OK ] OAuth login`). 4 tests, typecheck clean.
- **stubbed:** omp exposes no delete/re-enable verb, so we write omp's vault directly (one column); if a future omp clears the flag itself this becomes a harmless no-op. No UI surface yet for "your last login was re-enabled" (silent + logged).
- **next:** a small toast/badge when a connect self-heals a previously-disabled provider; consider having the app's Disconnect fully remove rather than disable, so logout/login is symmetric.

---
**P-OAUTH.1 - OAuth broker lifespan fix + device-flow support + auto-refresh (v1.8.12)**
- **shipped:** root-caused the OAuth `stdin: 'ignore'` broker death bug (broker reads stdin as cancellation channel; `ignore` closes it → immediate EOF → callback server dies before the browser redirect lands); fixed to `stdin: 'pipe'`. Discovered two distinct OAuth patterns: redirect-flow (OpenAI :1455, Anthropic :54545, Google :8085 — automatic callback) vs device-flow (xAI Grok — user pastes a code from the provider's page). Built the full device-code forwarding pipeline: `oauthBrokers` Set→Map keyed by oauthId, `sendOauthCode()` writes to broker stdin, `POST /api/auth/oauth-code` endpoint, `bridge.oauthCode()` front-end method, and a device-code paste UI (input+Submit) injected into the provider card for xAI/GitHub/device-variant providers. Fixed Settings panel not auto-refreshing after OAuth by adding a `visibilitychange` listener (Chrome throttles `setTimeout` in background tabs; this fires the instant the user returns from the provider's login page). Poll interval reduced from 5s to 2s (150 iterations, same 5-min window). Expanded Netdiag `DEFAULT_CALLBACK_PORTS` to watch :1455 (OpenAI), :54545 (Anthropic), :8085 (Google). Added `PROV_HINTS` for xAI (subscription plan note) and Anthropic. OAuth-relevant events sorted to top of Netdiag panel with CSS highlights. URL-detection timeout extended to 60s for OTP/MFA flows. 17 tests green; live-verified OpenAI, Google, and xAI OAuth end-to-end.
- **stubbed:** xAI ephemeral-port probing relies on socket diff (no fixed port to watch); device-flow detection is a known-set of oauthIds (not auto-detected from broker output). No toast for self-heal re-enable yet.
- **next:** auto-detect device-flow from broker stdout (`Paste the authorization code`); toast when a previously-disabled provider is silently re-enabled; consider scraping the broker's `redirect_uri` for ephemeral-port auto-probe.

---
**P-DOC.1 - role-based user guides (per-role capability docs w/ screenshot placeholders, Tips, cited Notes & References) (ADR-0092)**
- **shipped:** ADR-0092 freezes a fixed per-guide structure (role one-liner → "Who this is for / What you'll see" → "Getting started" → capability walkthroughs, each with a `images/<role>-<slug>.png` screenshot placeholder + italic *Figure N* caption + `> [!TIP]`/`[!NOTE]`/`[!WARNING]` callouts → "Notes and References" in MLA 9, mixing real repo docs + external research). Four first-pass guides under `docs/guides/` (developer 8 figs/7 tips, security 8/5, manager 6/4, executive 3/3 + index `README.md`), all mirroring ADR-0088's role foregrounding; wired into the README "Project docs" table (and fixed its stale "ADR-0001 … ADR-0053" range → 0092). Verified: no broken non-image links, every cited ADR (0011–0092) has a real header, all cited README sections exist, every capability section has ≥1 figure + ≥1 tip.
- **stubbed:** screenshot PNGs are documented placeholders (captions are the capture spec) — P-DOC.2 captures + commits them and adds a CI link-check so a renamed ADR/section can't silently rot a reference. P-DOC.3 = ADR-keyed refresh pass + in-app deep-links from the About panel.
- **next:** P-DOC.2 — capture the real screenshots against each *Figure N* caption + add the markdown link-check to CI.

---
**P-TOOLFAIL.1 - an honest chip for a failed/rejected tool call (ADR-0093)**
- **shipped:** root-caused a live "tool call rejected" mystery (a browser-open + js-execute that showed grey "rejected" chips with NO approval prompt) to a messaging defect, not a gate denial — `~/.omp/lucid-audit.jsonl` had no exec/egress block for the turn, so the gate never ran; omp couldn't run those tools and returned them `failed`/`rejected`, which the desktop flattened verbatim to "tool call rejected" (read as a DENIAL). New pure `desktop/tool_failure.ts`: `toolFailureReason(u)` distinguishes ran-and-errored (`failed` → "tool failed") from did-not-run (`rejected` → "tool did not run", never the word "rejected"/"denied"), and `toolFailureMessage(u)` surfaces omp's own message across its shapes (content[]/rawOutput/message-error, whitespace-collapsed, 160-cap). Wired into `acp_backend.ts` `tool_call_update`; `onBlock` tooltip now says "not a security block". 11 tests + `make demo-P-TOOLFAIL.1`; full `bun test` green; no frozen-contract bytes touched (the `block` event already had an unused `reason` field).
- **stubbed:** when omp attaches no message to a `rejected` update the chip is the bare "tool did not run" — honest, but it can't name "tool not enabled" vs "omp refused it" without an omp-side change (extend-don't-fork). Sibling gaps from the same investigation are queued: P-EGRESS.2 (local-file browser preview wrongly gated as internet egress), P-ENT.3 (egress no-listener block emits no SecurityEvent → no audit trail), P-LOC.3 (AI-LOC ledger discoverability + empty state).
- **next:** P-EGRESS.2 — stop classifying a `file://`/local-path browser preview as network egress (gate on the actual target, not the tool name).

---
**P-EGRESS.2 - local-file browser open labeled + audited (not a website) + audit the no-listener egress block (ADR-0094, folds in P-ENT.3)**
- **shipped:** second fix from the minesweeper investigation. New pure `isLocalFileTarget()` in `egress_policy.ts` (file:// or absolute Win/UNC/POSIX/~ path → local; http(s)/other-scheme/bare-host/relative → not local, fail-safe). A recognized local-file browser open now routes to `askEgress(localFile=true)`: skips the host-based auto-allow, shows a distinct "open a local file in your browser" card (path + "can still load remote resources" warning, no Cloudflare-Radar), offers open-once/block only (`EGRESS_LOCAL_OPTIONS`), persists no host decision — still a PROMPT, never auto-allowed (gate preserved); http(s) egress unchanged. Folds in P-ENT.3: the no-live-listener egress block now emits an `egress_decision`/block SecurityEvent (`egress`/`egress-local-file`) — was the one silent gate path. Added `localFile?` to the permission `ChatEvent` (renderer type, not a frozen contract). 4 new egress tests (egress_policy 19→23) + `make demo-P-EGRESS.2`; full bun test 1108/0; no frozen-contract bytes touched.
- **stubbed:** detection is path-shaped — a browser tool passing a local file as a bare RELATIVE path (no scheme, no leading slash) reads as ambiguous and gets the website-style prompt (still gated; widening risks misclassifying real bare hosts). No standing "always open local files" pin (open-once only, by design).
- **next:** P-LOC.3 — AI-authored code ledger discoverability (command-palette entry + empty-state placeholder so it never silently vanishes).

---
**P-LOC.3 - AI-authored code ledger is discoverable + never silently vanishes (ADR-0095)**
- **shipped:** third fix from the minesweeper investigation, answering "where did the AI-LOC go?". The ledger (data IS stored: frozen `ai_loc_ledger`, written at the gate) was an accordion buried in the Memory panel that disappeared entirely when `aiLocSummary()` returned null (empty/unreadable DB). Now `memoryHtml` renders the `mem.ailoc` section whenever a session is active and branches on a new pure `aiLocHasData()` (`desktop/ailoc_view.ts`): data card when ≥1 edit, else an explicit "No AI-authored lines recorded yet" empty state — never just absent. Added a command-palette entry "Open AI-authored code ledger" that opens Memory with the section expanded (same reveal idiom as a Security block). 3 new tests + `make demo-P-LOC.3`; full bun test green; no frozen-contract bytes touched (presentation only).
- **stubbed:** still surfaced inside the Memory panel, not a dedicated Manager/Exec dashboard (P-ROLE.4). No rail glyph (palette + Memory accordion only). Empty-state copy is fail-quiet (reads "none yet" if the gate-write path ever regresses; the gate's own tests guard that path).
- **next:** (investigation queue clear) — candidates: P-ROLE.4 Manager/Exec aggregate dashboard; fix the 11 Windows-local typecheck errors in dev.ts/netdiag.ts.

---
**P-PREVIEW.1 - in-app browser preview fly-out the user can open for apps the agent builds (ADR-0096)**
- **shipped:** closes the build→see loop the minesweeper turn exposed (agent wrote a game, had no way to run it). New right-edge **Preview** fly-out (`#preview`, cloned from the KG panel: `eye` rail glyph, left-edge resizer + persisted `--preview-w`, mutually exclusive with inspector/KG/IDE/settings), rendering a local app in a **sandboxed `<iframe>`** (path bar → Open/Reload). Pure `desktop/preview_resolve.ts` `resolvePreview()` is fail-safe: local file → `file://` rendered; http(s) → recognized but NOT auto-loaded (egress-gated, P-PREVIEW.3); ambiguous/empty → blocked. A **Screenshot → chat** button captures the panel via a new `capturePreview` seam (bridge → preload → main `webContents.capturePage(rect)`) and drops the PNG into the transcript; Electron-only (disabled in the browser). 8 new resolver tests + `make demo-P-PREVIEW.1`; resolver verified + panel DOM-verified in the dev server.
- **stubbed:** the **agent driving it** (gated omp custom tools: preview_open/screenshot/snapshot/click + feeding the shot to the model as multimodal input) is **P-PREVIEW.2**; remote URLs + sandbox hardening + a managed preview profile are **P-PREVIEW.3**. The Electron `capturePage` path is implemented behind the preload seam but **verified live in the packaged app** (no Electron/display in CI) — flagged, not claimed tested.
- **next:** P-PREVIEW.2 — gated custom tools so the agent opens + screenshots the preview itself and self-corrects.

---
**P-PREVIEW.2 - auto-surface the agent's freshly-written app in the Preview panel (ADR-0096 addendum)**
- **shipped:** re-scoped from "agent calls custom tools" (a feasibility wall: LUCID registers no custom omp tools today, omp's custom-tool API is unconfirmed, and the omp↔Electron↔capturePage round-trip can't be verified without live omp+Electron) to the verifiable, equally-faithful **auto-on-write**. New pure `previewablePath()` (`preview_resolve.ts`): a write/edit of a browser-previewable file (`.html`/`.svg`) → its path; reads, non-page writes (.ts/.md/.json), and non-write tools → null. acp_backend's `tool_call` handler emits a new `preview-available` `ChatEvent` (added to both ChatEvent unions); the renderer's `onPreviewAvailable` renders it live if the panel is open, else shows a one-click "Open preview" toast, and `openPreview` defaults to the agent's most recent previewable write. Surfaced path still flows through the fail-safe resolver (local-only). 4 new tests (preview_resolve 8→12) + `make demo-P-PREVIEW.2`; full bun test green; my files typecheck clean.
- **stubbed:** the true agent-*invoked* preview (custom omp tools + screenshot-as-multimodal-ToolResult so the model sees + self-corrects on its own UI) is **P-PREVIEW.3a** — needs omp's custom-tool API confirmed + live omp+Electron to verify. Egress-gated remote URLs + sandbox hardening + managed preview profile are **P-PREVIEW.3b**.
- **next:** P-PREVIEW.3a — confirm omp's `pi` custom-tool factory, then add gated preview tools the agent calls (built/verified in a live omp+Electron env).

---
**P-PREVIEW.3 - hardened preview sandbox + confirmed agent-tool feasibility (ADR-0096 finalize) + v1.8.14**
- **shipped:** locked down the `<iframe>` that runs untrusted, agent-authored pages, via a single-source policy in `preview_resolve.ts`: `PREVIEW_SANDBOX="allow-scripts allow-forms"` (scripts run but **opaque-origin** — no `allow-same-origin`, can't read LUCID's storage/cookies), `PREVIEW_ALLOW=""` (Permissions-Policy denies camera/mic/geolocation/all), and `PREVIEW_SANDBOX_FORBIDDEN` (a test fails if same-origin/top-navigation/popups/modals/pointer-lock/downloads ever appear). Markup interpolates the constants so policy + tests can't drift. **Resolved the 3a open question:** omp's `pi.registerTool()` exists AND `AgentToolResult.content` accepts `ImageContent`, so the agent-invoked preview (incl. the model seeing its own screenshot) is buildable without forking — held back from this release only because a faulty new `-e` extension could break omp launch and can't be verified without live omp+Electron. 3 sandbox tests (preview_resolve 12→15) + `make demo-P-PREVIEW.3`; full bun test green. Version bumped 1.8.12 → **1.8.14** (v1.8.13 skipped).
- **stubbed:** P-PREVIEW.3a (agent `preview_open`/`preview_screenshot` via `pi.registerTool`, cross-process capture round-trip) + P-PREVIEW.3b (egress-gated remote URLs + managed preview profile) — **ready, pending a live omp+Electron session** to verify the extension + round-trip.
- **next:** P-PREVIEW.3a in a live env — write `harness/omp/preview_extension.ts`, verify omp launches with it, wire the screenshot round-trip.

---
**P-SKILL.4 + P-SKILLREG.1 - skill directory/management menu + enterprise registry spike (ADR-0097, ADR-0098)**
- **shipped:** two SCOPE/PLAN ADRs. ADR-0097 (P-SKILL.4) designs one Agent Skill **directory + management menu** unifying bundled (ADR-0029) · omp-discovered · scan-gated import (ADR-0045) · `.agents/skills/` under one view with source root, closed-set trust label, enable/disable, inspect, re-scan (fail-closed gate), and confined remove. ADR-0098 (P-SKILLREG.1) is the **enterprise skills registry capability spike**: cross-provider research of record (AWS Agent Registry / Azure Foundry Skills / Google Skill Registry all **preview, not GA, no Terraform, AWS metadata-only**; OCI / IBM / VMware / Nutanix / NetApp / KVM = **none**), decision = **skills-as-OCI-artifacts + S3 backend, self-hosted everywhere via Terraform, first-party registries as optional sync only, always self-host in IL5** (separate `aws-us-gov` / `usgovcloudapi.net` / `oraclegovcloud.com` OC2/OC3 partitions; GCP Assured Workloads). Public README gains an "Agent Skills directory & enterprise registry (Coming Soon)" section + two roadmap rows; ADR count 96→98.
- **stubbed:** no code built (both are design/spike). The private add-on repo (`mlcyclops/lucidagentIDEaddon`) artifacts — ADR-A012 (registry reference architecture + skills-as-OCI distribution), ADR-A013 (per-provider Terraform runbook framework + IL5 matrix), and `terraform/<provider>/` skeleton runbooks for all 10 surfaces — are staged as a bundle (out of public GitHub scope; cannot be pushed from this session).
- **next:** build P-SKILL.4 (the directory view + per-skill management routes reusing `importSkill`'s scan + `pathWithin` confinement; disabled/flagged skills never loaded; `make demo-P-SKILL.4`), then land ADR-A012/A013 + runbooks in the private add-on repo and wire the public `registry` source reader (verify-signature → scan-gate → install).

---
**P-KB.1-2 + P-SKILL.5 + P-SKILLREG.2 - compiled KB sibling + Skill Studio + publish seam (ADR-0099-0102)**
- **shipped:** four SCOPE/PLAN ADRs (design-only, no code this round). ADR-0099/0100 (P-KB.1-2) design an **OpenKB-style compiled KB** — a TS+DuckDB (no Python) **sibling** to the vector RAG spine (ADR-0058): a new `kb_graph.duckdb` (migrations 0011+) of `kb_documents`/`kb_pages` (summary|concept|entity|source) / `kb_links` (wikilinks) / `kb_page_sources` (citations) / `kb_changelog`, compiled by the most-used model via `backend.complete`, with **both the source and every derived page scanned fail-closed** (keystone #2), a retrieval router (vector | compiled | both), and the ADR-0075 graph renderer reused for page-graph viz. ADR-0101 (P-SKILL.5) designs **Skill Studio**: a button that analyzes today/past-week work (`listSessions`/`sessionMessages`, AI-LOC, loop run-log, usage ledger) and drafts Agent Skills via the most-used model, each scanned through the `importSkill` gate and **reviewed before codified** into the Local Skills Registry — concretizes the deferred P-SKILL.2/.3. ADR-0102 (P-SKILLREG.2) designs a `RegistryPublisher` seam (mirrors the SIEM `Sink`): public ships the interface + a default **local** publisher; remote publishers (cloud OCI registries + custom git: GitLab/GitHub/Azure DevOps) are private add-on IP, egress-gated. README gains a compiled-KB block, a Skill Studio + remote-publish block, 4 roadmap rows; ADR count 98→102.
- **stubbed:** no production code (design-only by request). New `contracts.ts` EventName values (`kb_document_ingested`, `kb_page_compiled`, `kb_page_quarantined`, `kb_retrieved`, `skill_drafted`, `skill_published`) are NAMED but deferred to their own frozen-contract increment (#8). Private add-on artifacts — ADR-A014 (remote skill publishers: git providers + cloud OCI registries) + ADR-A015 (publish runbooks/CI) — staged as a bundle (out of public GitHub scope; cannot be pushed from this session).
- **next:** build P-KB.1 first (the `harness/kb/` schema + compile pipeline + `make demo-P-KB.1`), then P-KB.2 (router + viz), P-SKILL.5 (Skill Studio panel + routes), and the public half of P-SKILLREG.2 (the publisher seam + local publisher); land ADR-A014/A015 + remote publishers in the private add-on repo.
**P-FS.1 - full-tree workspace folder browser (ADR-0103, supersedes ADR-0022 M1)**
- **shipped:** lifted the folder browser's home-subtree lock so the Workspace picker can open a folder ANYWHERE on the machine (above home → the FS root on POSIX; a "computer" level enumerating drives on Windows). New pure `desktop/fs_browse.ts` `listDir()` (platform-aware via `path.win32`/`path.posix`, dependency-injected, never throws); `/api/fs/list` in `dev.ts` now delegates to it (dropped unused `statSync`/`dirname` imports). ADR-0022's transport gates (H1 loopback bind, H2 Origin/CSRF + token) are UNTOUCHED — the endpoint is still reachable only by the local authenticated user, which is why the M1 directory-listing-oracle confinement is safe to lift. Added optional enterprise `ManagedConfig.workspaceRoots` (+ `managedWorkspaceRoots()` + the `WorkspaceRoots` GPO reader) to re-confine the browser (ADR-0068 "only tightens"). 9 tests (`desktop/fs_browse.test.ts`) + `make demo-P-FS.1`; my files typecheck clean; renderer picker unchanged (it round-trips whatever the endpoint returns).
- **stubbed:** the renderer doesn't yet add a dedicated "Computer/Drives" affordance — Windows drives arrive as normal folder rows and the existing "Up" button reaches them via the COMPUTER sentinel; a polished drive chooser is a follow-up. No managed-lock UI badge on the picker yet (the allowlist is enforced server-side).
- **next:** optional renderer polish (a drives/root shortcut + "Managed by <org>" hint when `workspaceRoots` is set); consider a recent-roots quick list.

---
**v1.8.15 - release the full-tree folder browser + fix from-source Electron install**
- **shipped:** bumped APP_VERSION 1.8.14 → 1.8.15 (version.ts + desktop/package.json + about.test.ts assertions) to release the full-tree workspace folder browser (P-FS.1/ADR-0103, already on master via #174). Added `trustedDependencies: ["electron","@resvg/resvg-js"]` to desktop/package.json so a from-source `bun install` runs Electron's postinstall and actually downloads its binary (Bun skips postinstalls by default → "Electron failed to install correctly" on `bun run start`; CI packaging was unaffected since electron-builder fetches its own Electron). Fixed the stale `demo_p_about_1.ts` hardcoded "1.8.11" assertion to check semver shape so it never rots on a bump.
- **stubbed:** nothing — desktop suite 602/0, `make demo-P-ABOUT.1` green. The release installers are built by the `Build desktop installers` workflow on the `v1.8.15` tag (Win NSIS + portable, mac .zip/.pkg, Linux AppImage/deb/rpm), attached to the v1.8.15 GitHub Release.
- **next:** verify the tagged build's Windows installer launches and the folder picker climbs above home to the drive list on a real machine.

---
**P-PREVIEW.3b - a remote URL previews only through the egress gate (ADR-0096)**
- **shipped:** a remote URL in the Preview panel reaches the internet, so it's gated by the EXISTING egress allow-list (ADR-0062/0094, managed-ceiling-aware) — no new approval path. The resolver classifies `http(s)` as `remote`; the renderer asks `/api/preview/egress-check?url=` (→ `egressDecision`), and a pure `canPreviewRemote(url, egressAllowed)` loads it **iff the site is already egress-approved AND it's https** (no plaintext into the sandbox), in the SAME hardened opaque-origin iframe as a local file. Otherwise it stays gated with a message that the agent must visit the site first (which fires the normal egress prompt). New: `canPreviewRemote()` (+ 4 tests, preview_resolve 15→19), `bridge.previewEgressAllows()`, `/api/preview/egress-check` in dev.ts, `make demo-P-PREVIEW.3b`. No new approval UI, gate not weakened; my files typecheck clean.
- **stubbed:** P-PREVIEW.3a (agent-invoked `preview_open`/`preview_screenshot` via `pi.registerTool`) is the only remaining preview piece — built as a flagged draft, needs a live omp+Electron session to verify (a faulty `-e` extension can break omp launch).
- **next:** P-PREVIEW.3a draft — `harness/omp/preview_extension.ts` (`preview_open`) + acp_backend tool_call→panel wiring, verified live before merge.

---
**P-PREVIEW.3a - agent-invoked preview_open (DRAFT, ADR-0096)**
- **shipped (as a flagged DRAFT PR — do NOT merge until verified live):** "the agent drives the preview". New `harness/omp/preview_extension.ts` registers a `preview_open(path)` tool via `pi.registerTool`; the tool (in the omp subprocess) validates a local `.html`/`.svg` path + acknowledges, and acp_backend detects the `preview_open` tool_call (pure `previewOpenPath()`) → emits the existing `preview-available` event → renderer opens the panel + re-gates via `resolvePreview`. De-risked so it can NEVER break omp launch: clean import verified, registration fully try/catch-wrapped (unit-tested: `previewExtension` never throws for missing/throwing `registerTool`), `-e` arg `existsSync`-guarded. 8 new tests (preview_extension 5 + previewOpenPath 3; preview_resolve 19→22) + `make demo-P-PREVIEW.3a`; my files typecheck clean.
- **stubbed:** the THREE things only a live omp+Electron run can confirm — (a) omp launches with the `-e` extension, (b) the exact `pi.registerTool` param-schema format, (c) the model invoking it. And **P-PREVIEW.3a-shot**: `preview_screenshot` returning the PNG as a multimodal `ToolResult` image (the model seeing its own UI) via a cross-process file-handshake — the final preview piece.
- **next:** live-env session — confirm omp launch + tool invocation, then build P-PREVIEW.3a-shot (screenshot round-trip).

---
**P-ENT.4 - every per-action gate denial is auditable + attributed (ADR-0069)**
- **shipped:** investigating "why a bunch of tool call fails?" (browser/bash/eval denied while the agent smoke-tested a built game) found the denials had NO record in the OCSF audit log — the `askExec`/`askEgress` fail-closed TIMEOUT path settled silently (emitted only on the click-resolve path). Now the timeout paths `emitSecurityEvent(block)` too, and a pure `gateDenyReason(optionId, timedOut)` (`desktop/gate_audit.ts`) attributes every denial: "denied by you" (explicit Block) vs "fail-closed (turn ended)" (null optionId) vs "fail-closed (no response in 5m)" (timeout) — so the audit answers "did I deny it, or did it auto-deny?". Both exec + egress deny paths use it. 3 tests (`gate_audit.test.ts`) + `make demo-P-ENT.4`; my files typecheck clean. (Diagnosed via the now-informative chips from P-TOOLFAIL.1.)
- **stubbed:** the CHIP text is still omp's wording ("denied by user"); surfacing fail-closed-vs-you ON the chip (not just the audit) is a small follow-up. Denials still aren't shown in the Security panel's live-blocks view (only the OCSF feed) — a candidate P-ENT.5.
- **next:** P-PREVIEW.3a live verification (omp launch + invocation), or P-ENT.5 (denials in the live Security panel + chip attribution).

---
**CORRECTION (2026-06-30): P-PREVIEW.3a landed on master via #178 (not a draft anymore)**
- P-ENT.4's branch (#178) was inadvertently based on the P-PREVIEW.3a draft branch, so the 3a code (`preview_extension.ts`, the `-e PREVIEW_EXT` wiring, `previewOpenPath` + detection, demo) merged into master with it. Kept (owner's call): it's DEFENSIVE — verified clean import + `try/catch` registration + `existsSync`-guard, so it CANNOT break omp launch (worst case `preview_open` simply doesn't register). It remains FUNCTIONALLY UNVERIFIED — a live omp+Electron run must still confirm the model can invoke `preview_open` before it's relied upon. Draft PR #177 closed as superseded. Ships in v1.8.16 defensively-but-unverified.

---
**v1.8.16 - release: preview remote egress-gating + auditable gate denials (carries defensive agent preview_open)**
- **shipped:** bumped APP_VERSION 1.8.15 → 1.8.16 (version.ts + desktop/package.json + about.test.ts) to release P-PREVIEW.3b (remote URLs preview only through the egress allow-list, opaque-origin) + P-ENT.4 (every per-action gate denial auditable & attributed). Also carries the defensive, functionally-unverified agent `preview_open` (P-PREVIEW.3a, see correction above). Installers built by the `Build desktop installers` workflow on the `v1.8.16` tag.
- **stubbed:** P-PREVIEW.3a needs live omp+Electron functional verification; P-PREVIEW.3a-shot (the agent seeing its own screenshot) is the final preview piece.
- **next:** verify v1.8.16 installs/launches; live-verify preview_open; then 3a-shot.

---
**P-GATE-DIAG.1 - diagnostics for "I never got a prompt, it just denied" (ADR-0066/0062)**
- **shipped:** two live runs (Claude, then GPT-5.5) showed browser/bash/eval denied with NO approval prompt. omp forwards these (acp_config `tools.approval`), so the silent deny is our `onRequest` hitting the no-prompt block path — the `interactive` check (`askActive && listener && !goalActive && !autoRunning`) was false when the request arrived. Couldn't pin the cause from logs (denials weren't even auditable until P-ENT.4) and the gate is too load-bearing to guess-fix. So (mirroring P-ASKSAGE.1) added a dev-mode ring `gateDiagnostics()` recording the interactive-check inputs + verdict/decision for EVERY exec/egress permission request, surfaced in Logs → "Exec / egress gate decisions" (chip + ⛔ count). A `block(no-ui)` row shows which input was false = the root cause. Observability only — gate behavior unchanged, fail-closed preserved. Wired: `gateDiag`/`recordGateDiag` (acp_backend) + exec & egress records, `gate` in `/api/dev` + DevView, the Logs accordion, `make demo-P-GATE-DIAG.1`. Typecheck clean; dev Logs accordion DOM-verified.
- **stubbed:** no unit test (the capture is inline in the omp-dependent onRequest; verified via typecheck + DOM). The ACTUAL root-cause fix awaits a live denied run's diagnostics (same pattern as P-ASKSAGE.1: ship diagnostics → capture → fix).
- **next:** user runs a turn that denies a tool, opens Logs → Exec/egress gate decisions, reports the `block(no-ui)` row (which of askActive/listener/goal/auto is false) → then the targeted fix.

---
**P-PREVIEW.4 - the Preview panel now actually RENDERS a local file (fix the blocked file://) (ADR-0096)**
- **shipped:** live testing exposed that the panel NEVER rendered local files — it set `iframe.src = file://…`, which Chromium blocks from an http origin (the renderer is served over http://localhost in dev AND packaged). So the feature was visually broken since P-PREVIEW.1 (the earlier check only confirmed `src` was set). This is also WHY the agent kept trying the browser to view its games. Fix: serve the file content same-origin behind the transport gate (`/api/preview/file?path=` → pure `readPreviewFile()` in `desktop/preview_file.ts`, gated to local `.html`/`.svg`, exists, ≤5MB), fetched by `bridge.previewFile()`, rendered via the iframe's `srcdoc` in the same hardened opaque-origin sandbox. **Live-verified end-to-end** in the dev server: a real local game renders (DOM + screenshot "LUCID PREVIEW WORKS ✓" via the actual Open→loadPreview→previewFile→srcdoc flow). 6 tests (`preview_file.test.ts`) + `make demo-P-PREVIEW.4`; my files typecheck clean.
- **stubbed:** `srcdoc` has no base URL → a multi-file app's RELATIVE assets (external CSS/JS/images) won't load. Fine for the self-contained single-file games the agent builds; a base-aware http-served preview is **P-PREVIEW.4b**.
- **next:** P-PREVIEW.4b (multi-file/relative-asset preview); cut a release so the rendering fix reaches the installed app.

---
**P-PREVIEW.3a FINALIZED - the agent drives the preview (the draft is now real) (ADR-0096)**
- **shipped:** corrected the draft `preview_open` tool against the INSTALLED omp extension API: `pi.registerTool` IS exposed to `-e` extensions; params must be a real `TSchema` (now authored via the injected `pi.typebox` shim, not a raw JSON object that omp would reject); `approval:"read"` so opening a preview never hits the exec gate. Fixed a desktop bug too — a custom tool's name does NOT survive as the ACP `kind` ("other"); omp renders the call TITLE as `"preview_open: <path>"`, so `acp_backend` now matches `previewOpenPath` on the title (keeps `previewablePath` on `kind`). Root-cause fix: new **`PREVIEW_POLICY`** in the frozen prefix (layer 3, **PREFIX_VERSION 5→6**) tells the agent NOT to use browser/bash/eval to view its work (all gated → denied) — write the `.html` (auto-preview) or call `preview_open`, prefer one self-contained file. Tests updated (`preview_extension.test.ts` +typebox stub +`approval`, `preview_resolve.test.ts` +title case); `make demo-P-PREVIEW.3a` rewritten + green; full suite: only the 5 pre-existing fs_browse Windows-local fails (0 new), typecheck clean.
- **stubbed:** the model actually invoking `preview_open` is confirmed only live (omp+Electron) — verifiable now from the dev server.
- **next:** P-PREVIEW.3a-shot (`preview_screenshot` multimodal round-trip so the model SEES its rendered UI); P-PREVIEW.4b (base-aware http-served preview for multi-file apps); cut a release carrying 3a + the PREVIEW_POLICY + the P-PREVIEW.4 render fix.

---
**P-PREVIEW.4b - served preview with a per-frame CSP (games now actually render, not just the HUD) (ADR-0096)**
- **shipped:** live testing showed a self-contained game rendering only its static HUD in-panel while rendering FULLY in a browser. Root cause (proven by reproducing the exact sandbox headless): the renderer's CSP `script-src 'self'` (no 'unsafe-inline') is INHERITED by a `srcdoc` iframe, blocking the previewed app's inline scripts. Fix: serve the file via `iframe.src` from a new `/api/preview/serve?path=` endpoint returning the doc with its OWN per-frame CSP (`PREVIEW_FRAME_CSP`) - inline JS/CSS run, but `default-src/connect-src 'none'` block ALL egress (a previewed app can't bypass the egress gate), still opaque-origin sandboxed. The iframe-src GET carries the transport token via `?t=` (missing token → 403). **Verified end-to-end in the real dev server**: endpoint returns the 64KB game + exact CSP header (200 w/ token, 403 w/o), and driving the actual Preview panel renders the full game (title + legend + JS-drawn Play button). Supersedes P-PREVIEW.4's render mechanism (srcdoc→served frame), reuses `readPreviewFile`. `make demo-P-PREVIEW.4b` + CSP tests green.
- **stubbed:** multi-file apps with RELATIVE assets (external CSS/JS/images) need base-aware serving - a future increment. Single-file apps (what the agent builds) render fully now.
- **next:** P-PREVIEW.3a-shot (`preview_screenshot` multimodal so the model SEES its rendered UI); commit 3a+4b and cut a release so the render fix + agent-driven preview reach the installed app.

---
**P-PREVIEW.3a-shot - the agent SEES its own rendered UI (preview_screenshot) (ADR-0096)**
- **shipped:** a read-tier `preview_screenshot` tool that returns a PNG of the current preview as `ImageContent` so the model can see how its app renders and self-correct (instead of gated browser/bash/eval). Cross-process solved without fragile round-trips: the renderer proactively caches a PNG after each render (`capturePreview` IPC → POST `/api/preview/shot-cache`), and the tool fetches it from `/api/preview/shot`. omp reaches the endpoint via `LUCID_PREVIEW_SHOT_URL` (real port+token) which it inherits from dev.ts's `process.env` - no ACPClient change. Every failure path (no shot / no desktop / fetch error) degrades to text; never throws. **Verified:** cache round-trip live in the real dev server (empty→cached→exact match; bad token→403; non-image body rejected) + the tool's fetch→ImageContent + graceful paths by unit test + `make demo-P-PREVIEW.3a-shot`.
- **stubbed:** the model ACTUALLY seeing the image needs `capturePage` (Electron/packaged app) - the honest live boundary, same class as 3a's model-invocation. Verifiable now from the installed app.
- **next:** multi-file/relative-asset preview (base-aware serving); cut a release carrying 3a-shot.

---
**P-PREVIEW.4c - MULTI-FILE apps render (inline the app's own relative assets) (ADR-0096)**
- **shipped:** an app split into index.html + style.css + game.js (+ images/fonts) now renders in the preview. The frame is opaque-origin with no remote origins in its CSP, and we must not allow the serving origin (would leak same-origin reach into the sandbox) - so instead of widening the CSP, we INLINE the app's own pure-relative assets before serving: `<link>`→`<style>`, `<script src>`→inline `<script>`, `<img>`/CSS `url()`→`data:`. Fits the existing PREVIEW_FRAME_CSP exactly (no CSP change, egress still `connect-src 'none'`). Fail-safe + bounded (`desktop/preview_inline.ts`, pure): only pure-relative in-dir refs, no `..`/scheme/root/protocol-relative, per-asset 2MB + total 12MB caps, `</script>` neutralized, best-effort. **Verified end-to-end in the real dev server**: a 4-file app rendered correctly in the actual Preview panel - styled green box (external CSS), "MULTI-FILE OK ✓" (external JS ran), inlined PNG. 13 unit tests + `make demo-P-PREVIEW.4c`; typecheck + license clean.
- **stubbed:** a page pulling from a real CDN still can't load it - intentional (that's an egress concern, not a render bug).
- **next:** preview story is complete for agent-built apps (single-file + multi-file). Candidate follow-ups: P-ENT.5 (denials in the Security panel), restore clean local fs_browse baseline.

---
**P-PREVIEW.4c follow-up - auto-show the preview (no toast) + render nested-iframe wrappers (ADR-0096)**
- **shipped:** (1) auto-show - a previewable write now OPENS the Preview panel on that file automatically instead of a toast that vanished before the user could click it ("it's just a preview"); always points at the new file. (2) the agent's self-test wrapper (`<iframe src="game.html?selftest=1">`) now renders - `inlinePreviewAssets` folds a relative `<iframe src=*.html>` into `srcdoc` by recursively inlining the target (attribute-escaped, query dropped, depth-capped). **Verified live in the real dev server**: the exact wrapper renders the full game in the panel; no CSP change needed (Chromium allows the same-document srcdoc child under `default-src 'none'`). 16 unit tests + `make demo-P-PREVIEW.4c`.
- **stubbed:** none for this scope.
- **next:** preview render story is complete (single-file, multi-file, and wrapper). Candidate follow-ups: P-ENT.5 (denials in Security panel); the noisy "tool failed" chip when the agent tries eval for syntax-checking (gate working as designed - could soften via policy).

---
**P-CHAT.1 - inline expandable code preview for tool steps (like Claude Code) (ADR-0104)**
- **shipped:** tool steps that carry authored code now EXPAND to an inline preview - a write/create shows the new file syntax-highlighted (reusing the vendored Monaco's `colorize`, no new dep, lazy-loaded), an edit shows a green/red line diff with a `+N −M` badge. Contract: the `tool` ChatEvent gained `code: { path, content?, oldText?, newText? }` (both parallel defs), filled by acp_backend from the tool_call rawInput (bounded 64KB). Rendering is injection-safe: code goes in only via `textContent` (escaped) or Monaco's escaped colorize HTML. Pure `lineDiff` (LCS, unit-tested). **Verified live in the dev server**: app bundles+loads clean, Monaco colorize returns highlighted spans, and the injected step markup renders exactly right (highlighted write + green/red edit diff). 7 diff tests + `make demo-P-CHAT.1`.
- **stubbed:** bash OUTPUT + read CONTENT inline need tool_call↔tool_result correlation by id (command already shows in the step detail) - a fast follow-up.
- **next:** the bash/read output correlation; optional syntax highlighting WITHIN diff lines.

---
**P-CHAT.1 follow-up - real edit format (hashline patch) + "Open in editor" (ADR-0104)**
- **shipped:** captured omp's actual edit rawInput at runtime - it's a hashline PATCH in a single `input` string (`[path#hash]` + `SWAP`/anchor directives + `+`/`−` lines), not oldText/newText. Backend now maps that to `code.patch`; the renderer colors it per line (`patchLineType`: add/del/meta/ctx) with a `+N −M` badge (`patchStat`). Added an "Open in editor" button on every expanded preview that opens the actual file in the full Monaco IDE panel (editable, gate-protected save) - "expand for context" like Claude Code. **Verified live with real agent turns**: a write renders syntax-highlighted inline, an edit renders a colored patch inline (`+1 −0`), and "Open in editor" opens the file in Monaco. Tests: +patchLineType/patchStat (9 diff tests total); typecheck + license clean.
- **stubbed:** edits show omp's hashline patch (additions clearly; the removed line is implied by the SWAP anchor, not shown as a red line). A reconstructed full old→new diff would need tool_result correlation - a follow-up. Bash/read OUTPUT inline likewise.
- **next:** tool_result correlation for true old→new edit diffs + bash/read output.

---
**P-EDIT.1 - fix file-edit failures (edit.mode: replace) + native folder Browse (ADR-0105)**
- **shipped:** switched omp's edit tool from the default `hashline` (strict line-hash anchors → constant "anchors to lines … never displayed" / "one hunk per range" failures) to `replace` (classic search/replace, `edits: [{old_text,new_text}]`) via acp_config.yml. **Verified live: zero tool failures** on write+edit turns (vs the prior stream), and the P-CHAT.1 inline preview now shows a clean old→new red/green diff (acp_backend reads old_text/new_text). Also: Workspace "Browse" now uses the NATIVE OS folder dialog (Electron showOpenDialog + createDirectory) - browse anywhere + create folders, no home confinement; falls back to the in-app browser only in a plain-browser build.
- **stubbed:** native dialog is Electron-only (verifies in the packaged app).
- **next:** none for this scope.

---
**P-NETWL.1 - network whitelist foundation + OS-encrypted credential vault (ADR-0106)**
- **shipped:** `network_whitelist.ts` (pure) - a curated allow-list of internal/external domain patterns (`*.com` TLD + exact sub-level) and IP/CIDR ranges, each with a frozen closed-set trust scope (`always|project|loop`) + optional call budget + an `auth` ref. Wired into the live gate: `egressDecision` auto-allows a whitelist match via the new pure `egressWhitelistAllows`, but the enterprise-managed ceiling still WINS (tighten-only, fail-closed). Added `cred_vault.ts` - an OS-encrypted (Electron safeStorage/DPAPI) credential vault for JWT/OAuth/SAML/PEM/API-key/basic secrets: stored encrypted or REFUSED (throws, never plaintext); decrypt is main-only, entries hold only an opaque `vaultRef`. Native file picker + `credStore/List/Delete` IPC through preload+bridge. `make demo-P-NETWL.1` + 27 tests green; desktop suite 844 pass / 5 pre-existing fs_browse fails; typecheck + license clean.
- **stubbed:** only the `always` scope is ENFORCED; `project`/`loop` + call budget persist but grant nothing yet. No UI - the Settings section, Goal-Loop field, and DNS-pill quick-add consume this foundation in .2-.4.
- **next:** P-NETWL.2 - Settings "Network Whitelist" section (internal/external/IP inputs, native file upload, username/password, trust-scope pickers, tooltips).

---
**P-NETWL.2 - Network Whitelist Settings UI (ADR-0106); v1.8.22**
- **shipped:** a "Network Whitelist" section in Settings (secWhitelist) to add/list/remove domain patterns (`*.com` TLD + exact sub-level) and IP/CIDR ranges by internal/external zone + trust scope + per-loop call budget, each control with a custom tooltip. CRUD via `/api/whitelist` (GET/POST + /remove) backed by the pure store; bridge gains whitelistList/Upsert/Remove. Optional credential attach (JWT/OAuth/SAML/PEM/API-key/basic) via paste (credStore) or NATIVE FILE UPLOAD (new credStoreFile IPC - reads+encrypts in main, secret never enters the renderer) into the OS-encrypted vault. **Live-tested in the real dev server:** add/list/remove works, badges correct, and END-TO-END the live egress gate auto-allows a UI-added whitelisted host (egress-check true for the subdomain, false for a non-listed host); fail-closed held (a pasted secret in the plain browser was refused, nothing plaintext persisted). Typecheck + license clean.
- **stubbed:** only `always` scope is ENFORCED; project/loop + call-budget persist but grant nothing (P-NETWL.3). Vault ENCRYPTION-success path + native file upload verify in the packaged Electron app (safeStorage). Last-4 masking is P-KEYS.1.
- **next:** P-NETWL.3 - Goal Loop authorized search engines + preference-ordered URLs (`url1; url2; url3`) + per-loop call-budget enforcement; then P-NETWL.4 DNS-pill quick-add.

---
**P-NETWL.3 + P-KEYS.1 + P-NETWL.4 - scope/budget enforcement, last-4 masking, DNS-pill quick-add (ADR-0106/0107); v1.8.23**
- **shipped:** (P-NETWL.3) ENFORCE trust scopes + per-loop call budget - `whitelistMatch(ctx)` honors always/project(workspace)/loop; `egressDecisionDetailed(url,ctx)` returns the granting entry; acp_backend threads `{project,loop}` at the egress site and caps auto-allows per host per loop (`loopHostCalls` + pure `withinCallBudget`), recording a `call-budget` LoopBlock. (P-KEYS.1) credential last-4 masking - `deriveLast4` stores <=4 non-secret chars, UI shows `••••XXXX`. (P-NETWL.4) click a Network-diag DNS pill → quick-add popover (zone/scope/budget) → whitelistUpsert. **Live-tested:** clicked a real `mail.google.com` DNS pill (generated via Resolve-DnsName, no account access) → added `scope=loop, budget=5`, persisted + popover closed (screenshot); loop-scoped host not auto-allowed without loop context (egress-check false). demo-P-NETWL.3 + 57 tests green; typecheck + license clean.
- **stubbed:** last-4 full vault roundtrip + call-budget runtime enforcement verify in the packaged Electron app; the rest of ADR-0107 (rotation visibility/manual rotation, self-host KmsProvider) + the enterprise KMS tier (add-on ADR-A012) remain.
- **next:** wire the remaining ADR-0107 public tier (rotation visibility + manual rotation + HashiCorp connector), or begin the add-on LAI-KMS cloud connectors.

---
**P-KEYS.2 - credential rotation visibility + manual rotate-in-place (ADR-0107); v1.8.24**
- **shipped:** rotation VISIBILITY on each whitelisted key (non-secret `rotatedAt`/`expiresAt`/`rotationIntervalDays` → pure `rotationStatus`/`rotationLabel`: `rotated Nd ago` / `rotation due` / `expires in Nd` / `expired`, ok/warn/danger tone) + manual ROTATE-in-place (`rotateCredential` re-encrypts under the SAME vaultRef so the entry keeps working, bumps rotatedAt, refreshes last-4; fail-closed - old secret left intact if the OS keystore is down). Main IPC `credRotate`/`credRotateFile` (paste or native file, secret never enters the renderer); UI adds a rotation badge, a **Rotate** popover (paste/file), and an optional "rotate every N days" reminder on the add form. **Tested:** demo-P-KEYS.2 + 16 vault tests; live - Rotate button + popover render, browser fail-closed path shows "old secret left untouched".
- **stubbed:** the full vault encryption/rotate roundtrip verifies in the packaged Electron app (browser has no safeStorage). The self-host `KmsProvider` connector + expiry-date UI remain.
- **next:** P-KEYS.3 - the self-host/HashiCorp `KmsProvider` connector (the last public-tier piece of ADR-0107); then the add-on LAI-KMS cloud connectors (ADR-A012).

---
**P-NETWL.5 - egress posture (allow-all + web-search toggles) + P-IDE.1e Fable 5; v1.8.25**
- **shipped:** (P-NETWL.5, ADR-0108) two PRE-CHECKED toggles in the Network Whitelist - "Allow web search" (auto-approves omp's web_search) and "Allow all websites + local LAN". With allow-all on, egress auto-allows EXCEPT a public IP literal or a foreign-ccTLD site (LAN/private always allowed); the curated whitelist ENFORCES only when allow-all is off (UI dims it to standby). Managed policy clamps allow-all off (Support-Desk path); scanner gate untouched. Posture at `/api/whitelist/posture`. (P-IDE.1e, ADR-0109) Fable 5 (`claude-fable-5`) is selectable when a Claude account is connected (OAuth or ANTHROPIC_API_KEY), with a U.S.-gov privacy notice on the row + hover card + a persistent toast on selection. **Live-tested:** allow-all on → github/LAN allow, baidu.cn/8.8.8.8 prompt; allow-all off → github prompts; Fable selectable under Claude OAuth with the privacy notice (screenshot). demo-P-NETWL.5 + tests; full suite green; typecheck + license clean.
- **stubbed:** the Fable negative case (no Claude auth → greyed "connect Claude") is code-correct but wasn't toggled live (OAuth was active); IP country is a heuristic (public IP always prompts) rather than real GeoIP.
- **next:** ship v1.8.25 (P-NETWL.5 + Fable); then the add-on LAI-KMS cloud connectors (ADR-A012).

**P-EXEC.2 - answer omp's FORM-elicitation tool approval (fix: every gated tool call silently "denied by user")**
- **shipped:** (ADR-0110) live chat regressed - EVERY bash/eval/edit/delete call failed with `Tool call denied by user: bash` and NO approve/deny prompt. Root cause: omp 16.1.20 wraps tools with `ExtensionToolWrapper` (because we load `-e GATE -e ASKSAGE`); its inner approval calls `uiContext.select` → an ACP `elicitation/create` gated on the client advertising `elicitation.form`, which we never did, so omp's `select()` returned `undefined` → treated as deny. Our OUTER `session/request_permission` gate had already ALLOWED (gate-diag confirmed). Fix: advertise `elicitation: { form: {} }` in `initialize` + answer `elicitation/create` via `answerElicitation`/`elicitationApproval` (pure, in exec_policy.ts) - accept the affirmative option (whole-word approve/allow/yes/proceed/accept), decline custom questions. Safe: the elicitation is a redundant inner gate that fires only after our real gate ran. **Live-tested:** node (pinned)→`4`; unpinned `python --version`→ real `permission` event → approved → `Python 3.14.2`; `echo hello123`→`hello123`; all previously denied. `elicitationApproval` unit-tested (164 exec_policy tests green); root+desktop typecheck clean.
- **stubbed:** plan-mode approval now routes through the same elicitation (auto-accepts "Approve and execute", preserving prior auto-approve) - not separately exercised live this session.
- **next:** ship the fix (version bump + PR); consider surfacing the elicitation decision in the Logs panel UI (it's already in the gate-diag ring).

**P-WS.1 · P-GOAL.14 · P-BRIEF.4 - AAR/podcast bug-check + persistence, past-AAR browser, real podcast audio; v1.8.27**
- **shipped:** (1) **Chat history survives upgrades** (ADR-0111) - the default workspace was the versioned install dir (`import.meta.dir`), so sessions (matched by recorded cwd) were orphaned on every update; the default is now a STABLE `~/.omp/lucid-workspaces/default` in packaged builds (dev-from-source keeps the repo). (2) **Browse past After-Action Reports** (ADR-0112, P-GOAL.14) - `listGoalReports`/`readGoalReport` + `/api/goal/reports`; the goal modal lists saved `.report.md` files and opens each in a viewer. (3) **Real podcast audio** (ADR-0113, P-BRIEF.4) - `/api/brief/audio` synthesizes the two-host script to WAV via the existing OpenAI-compatible TTS backend; inline `<audio>` + **Download WAV**; providers = Kokoro (air-gap, no key) or **ChatGPT/OpenAI TTS** (stored OPENAI_API_KEY, `gpt-4o-mini-tts`); the Engineering Update accordion relabeled "from your repo logs" so it's not mistaken for the loop AAR. **Investigation delivered:** the loop AAR never generated audio (podcast belongs to the separate brief; TTS backend existed but was unwired); the NotebookLM loop's AAR is on disk and its **budget report is accurate** ($5.33 actual = run-log 5.329, peak context 162k, 1 iter, no cap). **Live-tested:** past-AAR list + viewer (real NotebookLM report), audio endpoint fail-safe (Kokoro down → script-only note), bundle builds, goal_memory tests green.
- **stubbed:** MP3 output (WAV only - MP3 needs an encoder dep); `openai-tts` not exercised live (avoids real OpenAI charges) but uses the unit-tested backend path; prior-version orphaned sessions aren't auto-migrated (re-home by opening the old path as a workspace).
- **next:** optional - a one-time migration to re-home pre-1.8.27 orphaned sessions; a TTS-endpoint/voice settings panel; MP3 via a WASM encoder.

**P-CHAT.2 - engagement policy: no autonomous cwd action on a greeting; opt-in numbered next steps; v1.8.28**
- **shipped:** (ADR-0114, PREFIX v7) a new byte-stable `ENGAGEMENT_POLICY` in layer 3, appended to the live omp ACP chat via `--append-system-prompt` alongside DELEGATION/BUILD/PREVIEW. Opening a chat is not a task and the cwd's files are not a request: on a new session / low-signal opener (hi, emoji, thanks, no concrete ask) the agent must NOT scan/read-broadly/edit/run tools - it greets, waits, and offers a SHORT numbered (1./2./3.) list of choose-by-number next steps drawn from the conversation + KG/user-memory recall (never a fresh scan), always including "review the working directory" as an explicit opt-IN. Fixes the reported Grok behavior (said "hi" → it started editing cwd files). PREFIX_VERSION 6→7 (deliberate prefix increment); prefix-hash test asserts stability/version-binding (no hardcoded hash) so it stays green. **Live-tested:** fresh session + "hi" on claude-opus-4-8 → only token/usage/done events (zero tool calls / edits), conversational reply + 4 numbered opt-in steps referencing the project from KG context. Model-agnostic (applies to Grok too). demo02 + assembler + prefix_compaction green; typecheck clean.
- **stubbed:** verified on opus (couldn't drive Grok directly this session), but the policy reaches every model via the appended system prompt so it's universal.
- **next:** optional - a client-side "quick reply" affordance that turns the agent's numbered next steps into one-tap buttons.

**P-VOICE.1 - ElevenLabs TTS/STT + mic button + read-aloud + offline-STT choice (NO version bump - batched for weekly release)**
- **shipped:** (ADR-0115) ElevenLabs voice backends (`harness/voice/elevenlabs.ts`, pure fetch clients - zero install bloat): TTS (podcast + single-clip read-aloud), STT (Scribe), voice list. A dedicated **Voice** settings card holds the `ELEVENLABS_API_KEY` (get-key link + per-AAR cost estimate ~$0.10-$0.30), a **selectable STT engine** (offline Whisper = air-gap/DoD default, or ElevenLabs Scribe cloud) with a Whisper-URL field, a TTS engine choice, and a **voice picker with favorites** (★ toggle, favorites first). A **mic STT button** (custom SVG) sits next to Skills in the composer (record→stop→transcribe→insert for review). Read-aloud speaker button on assistant replies; **AAR narration** "Listen" in the report viewer; ElevenLabs added as a podcast audio provider. Endpoints: /api/voices, /api/voice-settings, /api/transcribe, /api/tts/speak, /api/brief/audio (+elevenlabs). Cloud-vs-air-gap mirrors the gov/personal split. **Offline STT for DoD** documented (whisper.cpp self-host [already supported], in-app WASM Whisper, faster-whisper, Vosk, Parakeet, Moonshine). **Tested:** elevenlabs.test.ts green (voice-parse/PCM→WAV/xi-api-key/fail-safe); live endpoints all fail-safe to notes without keys; DOM verified (mic button, Voice card, selects, key field + link + cost); typecheck clean.
- **stubbed:** live ElevenLabs synth + mic recording not exercised (needs the user's ElevenLabs key + a mic permission grant); backends are unit-tested and endpoints fail-safe. In-app WASM Whisper (fully offline, no server) is documented but not built.
- **next:** once the user adds an ElevenLabs (or OpenAI) key + confirms audio plays, add the README hero section for voice; consider in-app WASM Whisper for zero-setup offline STT.

**P-REPORT.1 - Engineering Reports rail feature: role-tailored briefs + unified past-reports browser + voice/cost/player fixes (NO version bump)**
- **shipped:** (ADR-0116) a dedicated **left-rail "Engineering Reports"** glyph (all roles) opens a panel: generate a **role-tailored** brief (Developer→Tech-debt-first, Security→Risks-first, Manager→Shipped+Decisions, Exec→Shipped+Risks; pure `renderEngineeringBrief(u, role)`/`buildPodcastScript(u, role)`, all sections retained), with the P-VOICE.1 **voice picker (favorites, pre-generate)**, a **~10¢ per-generation cost note**, and podcast **audio (blob-URL player + Download)**. A **right-side unified list** of ALL past reports - per-workspace loop **AARs** + repo-wide saved **briefs** (`report_store.ts` → `~/.omp/lucid-briefs/`) - via `/api/reports`; each row opens a viewer with **Listen** (TTS). **Bug fixed:** the inline audio player didn't play a large WAV served as a `data:` URL → now a `URL.createObjectURL` **blob URL** (applied to podcast + read-aloud + AAR narration). **Tested:** role-tailoring unit tests (14 green); live - rail opens panel, developer brief generated+saved+tailored, `/api/reports` returns brief+aar, list renders both with badges; typecheck clean.
- **stubbed:** ElevenLabs audio not re-generated in-panel during test (avoids the user's ~10¢); reuses the verified blob-URL + engineeringBriefAudio path. No delete-UI for saved briefs yet. Briefs are about the LUCID app repo (not the open workspace) - existing P-BRIEF scope.
- **next:** ship the batched release when the user says (single version bump + consolidated changelog + README voice/reports hero); optional brief delete + a per-workspace brief scope.

**P-REPORT.2 - report lifecycle: copy, download .md, two-stage archive/delete (NO version bump)**
- **shipped:** (ADR-0117) every report (loop AAR + saved brief), in the Reports-panel row AND the viewer, gets **Copy to clipboard** + **Download .md**. **Two-stage archive/delete**: active row → **Archive** (soft-delete to an `archived/` subfolder); an **Active/Archived** tab switch shows the archive where rows offer **Restore** + **Delete (permanent)**. "Delete twice = gone." Guard: permanent delete only touches archived items (`deleteGoalReport` rejects non-`archived/` rels; `deleteBrief` no-force). Endpoints `/api/report/{archive,restore,delete}` + `/api/reports?archived=1`; icons archive/restore added. **Tested:** live lifecycle (generate→archive→restore→archive→delete, active-delete refused); unit test for the two-stage guard (goal_memory.test, 13 green); UI verified (tabs switch, row actions render); typecheck clean.
- **stubbed:** the **push-to-KG** ask is deferred to P-REPORT.3 - it's a gated slice (encrypted KG compartments + the semantic-promotion invariant), and the shape (summary-fact vs distilled facts vs document node) needs confirming first.
- **next:** P-REPORT.3 KG push (compartment select from `personalStatus()` unlock state, default the sole unlocked one) once the ingest shape is confirmed.

**P-REPORT.3 - push report to Knowledge Graph (NO version bump)**
- **shipped:** (ADR-0117 P-REPORT.3) optional **Push to KG** on every report row + the viewer. Ingest shape = user-confirmed **"one report node"**: `addReportToKg(scope,title,md)` does `upsertEntity("Engineering Report: <title>","user:decision","trusted")` + one `addFact({statement: md.slice(0,20_000), trustLabel:"trusted", scope})`. Compartment select from `bridge.personal()` unlock state: 0 unlocked → fail-closed toast; exactly 1 → push directly; >1 → `.kg-pick` popover (work/personal/cui). Endpoint `/api/report/to-kg` re-derives markdown server-side and **also** fail-closes if personalization off or compartment locked (defense in depth). Reports are first-party → trusted; the semantic-promotion gate (stops *suspicious* auto-promotion) is respected, not bypassed.
- **stubbed:** nothing - slice complete.
- **next:** ship the batched release when the user says (single version bump + consolidated changelog + README voice/reports hero for all uncommitted work).

**P-REPORT.4 - premium UI pass: Scoreboard + Engineering Report viewer (NO version bump)**
- **shipped:** (ADR-0118) Scoreboard tiles reworked - **neutral by default, bloom to their accent only when the value changes** (`prevMetrics` delta + `railPrimed` + signature-guarded DOM write), a **clockwise conic light sweep** on tiles needing triage (findings/quarantine > 0, via `@property --sweep`), plus premium finish: custom-SVG icon chips (new `gauge`/`loop`/`scan` glyphs), layered gradients, hover lift, reduced-motion safe. Report viewer (`.aar-viewer` scoped): body 12.5→**14px**/1.68 line-height, real heading scale (H1 underline, H2 gradient bar), styled lists/code/pre/blockquote/tables; **compact icon-forward header buttons** (4x9 pad, 15px glyphs, icon-only close, new duotone `headphones` for Listen).
- **stubbed:** nothing - presentational pass only, no data/security path touched.
- **next:** ship the batched weekly release when told (single version bump + consolidated changelog + README voice/reports hero for all uncommitted work).

**P-REPORT.4b - Scoreboard + report revamp, feedback round (NO version bump)**
- **shipped:** (ADR-0118 rev) Rail tiles: **removed the icons** (user didn't want them), now uniform-neutral-until-changed with a game-like reaction on change - **clockwise racing ring + diagonal shine + number flash** (`tileRace`/`tileShine`/`tileNumBloom`), plus persistent clockwise pulse on attention tiles. Report viewer: **dropped the duplicate title H1**, body 14→**15.5px**, H2 section eyebrows; **custom SVG outcome badge** (`checkBadge`/`stopBadge`/`alertBadge`) replacing the ✅ emoji; the ASCII Scoreboard + raw mermaid pie/xychart blocks now render as **beautiful colour bar charts with plasma-on-hover** (`.rchart`, per-metric colour + gradient + glow, 0 raw `<pre>` left); **"To KG" → "KG"** single-line with 16px icons, nowrap action row. `enhanceReportBody` does it all at render time; stored markdown untouched (loop_report byte-stable).
- **stubbed:** nothing - presentational; no data/security path touched.
- **next:** ship the batched weekly release when told (single version bump + consolidated changelog + README voice/reports hero for all uncommitted work).

- P-REPORT.4c: removed the composer bar's duplicative Model / Mode / Thinking buttons (`ctModel`/`ctMode`/`ctThink`) - the top `#modelBadge` picker already covers all three. Composer keeps only Persona / Skills / mic. NO version bump.

**P-EXEC.3 - TLDR command explainer + spell-check + report-title cleanup (NO version bump)**
- **shipped:** (ADR-0119) **TLDR** button under Copy in the exec approval card (tight padding) - one cheap one-shot call (`explain_command.ts`: Haiku → gpt-4o-mini → Gemini flash, cheapest keyed provider; command sent as delimited inert DATA; fail-soft "add a key" when none) → plain-English explanation + risk flag inline (`POST /api/explain`, `bridge.explainCommand`, `.perm-tldr` UI). Composer `<textarea>` now `spellcheck="true"` + Electron `context-menu` handler in `main.ts` offering dictionary suggestions/"Add to dictionary" (only on a misspelled word, so Monaco is untouched). Removed the small glyph before the report-viewer title.
- **stubbed:** OAuth-only users get the fail-soft "add a small key" message (no clean one-shot over managed OAuth); local no-LLM fallback not built.
- **next:** ship the batched weekly release when told (single version bump + consolidated changelog for all uncommitted work).

**P-REPORT.5 - print/PDF + report-panel polish + subdued inline code (NO version bump)**
- **shipped:** (ADR-0120) **Print** button in the report viewer → `printReport` renders the enhanced report into a hidden iframe with a self-contained LIGHT stylesheet (white paper, dark text, print-safe bar colours, `break-inside:avoid`, `@page` margins) and fires the OS print dialog (Save-as-PDF or printer); works in browser + Electron. Removed the `graph` glyph before the Active/Archived tabs; bumped the reports-panel intro to 13.5px. Re-toned chat inline `code` from loud cyan to a subdued neutral mono chip (`--txt-2` on a faint gray), matching the lower-left model readout. New `print` icon.
- **stubbed:** nothing - presentational.
- **next:** ship the batched weekly release when told (single version bump + consolidated changelog for all uncommitted work).

**P-REPORT.5b - print "Prepared for" footer + cost-notice fix + Listen UX + voice hotkeys (NO version bump)**
- **shipped:** (ADR-0121) Print doc now has a bottom-left **"Prepared for: <email|workstation>"** footer (repeats per page). Fixed the ElevenLabs/OpenAI TTS **cost notice** fragmenting into flex columns (wrapped text in one span; rewrote copy). **Listen** button hardened: it already synthesizes on demand (independent of Generate) - now shows a spinner → Stop control and surfaces the real engine error when TTS isn't configured. Voice **hotkeys**: `Ctrl/⌘+Space` toggles read-aloud in the open report, `Ctrl/⌘+D` toggles the mic, both shown in tooltips.
- **stubbed:** the dev browser still draws its own "localhost:5323" URL footer (Chrome print-UI, absent in the packaged Electron app); our content footer carries the "Prepared for" line.
- **next:** ship the batched weekly release when told (single version bump + consolidated changelog for all uncommitted work).

- P-REPORT.5c: CSP fix - added `media-src 'self' blob: data:` to the renderer CSP (desktop/renderer/index.html) so locally-synthesized TTS audio (Listen read-aloud + the podcast player, decoded to a Blob URL in-renderer) can actually play; previously `default-src 'self'` blocked blob media. Egress stays locked (connect-src unchanged). NO version bump.

**P-REPORT.6 - Security compliance crosswalk + POA&M CSV + bigger brief text (NO version bump)**
- **shipped:** (ADR-0122) new pure `harness/brief/compliance.ts`: maps security-relevant changes to **NIST SP 800-171 / 800-53** control families + representative **DISA STIG CCIs** with a Fixed/Improved/Regressed/Open/Planned disposition; the **Security brief** ends with a crosswalk table + rollup (`renderComplianceSection`), and `renderPoamCsv` emits an **eMASS-POA&M-aligned CSV** (import-template columns, one escaped row per mapped item, CCIs in "Security Checks", source in "Source Identifying Vulnerability"). `GET /api/brief/poam` + `bridge.engineeringBriefPoam` + an **Export POA&M (CSV)** button shown only for the Security role. Clearly labeled a **DRAFT** crosswalk requiring analyst validation (section text + toast). Brief preview text enlarged 12→13.5px + higher contrast. Tested: `compliance.test.ts` (6 green), all 31 brief tests green.
- **stubbed:** control/CCI selection is heuristic (keyword) - a starting point for analyst validation, not an authoritative mapping; no CKL/STIG-Viewer XML export (CSV only).
- **next:** ship the batched weekly release when told (single version bump + consolidated changelog for all uncommitted work).

**P-REPORT.7 - TTS-friendly audio + Listen cost note + NotebookLM link (NO version bump)**
- **shipped:** (ADR-0123) new exported pure speakable() sanitizes spoken text (strips code blocks/markdown/ADR+increment+CCI+version codes, symbols to words, expands POA&M/AAR/KG/CUI/TTS, sentence-ends) - applied to every podcast turn AND the read-aloud speakText, so the podcast/Listen no longer read technical noise. Report viewer shows a Listen cost note (ElevenLabs full read-aloud ~$0.50-1.50; podcast summary cheaper) + a NotebookLM link (copies the report, opens notebooklm.google.com for a free two-host Audio Overview); generate-panel has the same NotebookLM tip. Tested: 4 new speakable tests, 35 brief tests green.
- **stubbed:** nothing.
- **next:** ship the batched weekly release when told (single version bump + consolidated changelog for all uncommitted work).

**P-REPORT.8 - dependency-graph + schema annexes + STIG .ckl (NO version bump)**
- **shipped:** (ADR-0124) new pure harness/brief/change_graph.ts turns git numstat/name-status into a change-annotated **application dependency graph** (layered styled SVG: green grew / red shrank, +added/-removed line counts, dependency edges) + a **data-schema change map** (changed files → data stores), each rendered as BOTH a stunning SVG image AND copyable Mermaid (draw.io-importable). Appended as **Annex A/B** to developer+security reports; the print version starts each annex on a **new page** (page-break) with the SVG as an image. Security report also exports a native **STIG Viewer .ckl** (compliance.ts renderCkl: one VULN per control-mapped change, CCIs as CCI_REF, disposition→STATUS). All clearly DRAFT/analyst-validate. `/api/brief` (annexes) + `/api/brief/ckl`; renderer parses our Mermaid back to the SVG + Copy button + collapsible source. Tested: 43 brief tests green (7 change-graph + 1 CKL new).
- **stubbed:** the print SVG uses the dark app palette (dark node boxes on white paper - readable, colored borders); Mermaid is the draw.io path (no native .drawio XML). Vuln/Rule IDs synthetic; control/CCI mapping heuristic.
- **next:** ship the batched weekly release when told (single version bump + consolidated changelog for all uncommitted work).

**P-APPEAR.1 - personalized chat background: ambient 25% + flashlight-on-hover (NO version bump)**
- **shipped:** (ADR-0125) users can set a chat-interface background image, shown as **Ambient** (faint 25% wash behind the whole chat) or **Flashlight** (black background; the image is revealed only under the cursor at 25% via a mouse-tracked radial mask - a flashlight sweeping a dark room). New `desktop/chat_bg.ts` store (own file `~/.omp/lucid-chatbg.json`, separate from settings so hot load() stays light; ~9 MB cap, TOCTOU-safe); `GET/POST /api/chat-bg` + bridge. `.chat-bg` layer behind chat content (z-index), `applyChatBg` + mousemove tracking; new **Chat background** settings card (image picker, Display select, thumbnail, Remove, mode note); loaded at boot. Verified both modes visually + endpoint + settings card; no console errors.
- **stubbed:** opacity fixed at 25% (per request); no per-image position/blur controls; image stored as a data URL (one image).
- **next:** ship the batched weekly release when told (single version bump + consolidated changelog for all uncommitted work).

- P-APPEAR.1b: removed the redundant titlebar "Commands" button (the palette still opens from the left-rail glyph + Ctrl/Cmd+K); shrank the text-zoom control (smaller buttons + less padding). NO version bump.

**P-PREVIEW.5 - preview markup tools + Browse-cwd + status-line cleanup (NO version bump)**
- **shipped:** (ADR-0126) preview panel gets a `<canvas>` markup overlay + a single **Markup** dropdown (Pen / Rectangle / Text, mini SVG icons, colour swatches, Cursor, Clear); drawing arms the canvas pointer-events, and "Screenshot → chat" captures the markup TOGETHER with the iframe (Electron capturePage) - no compositing - so the marked-up image reaches the agent. **Browse…** button opens the native picker so the user previews a cwd file themselves. Removed **tokens/s** from the HUD status line and raised its contrast (txt-3/4 → txt-2). New icons pen/textT/markup. Verified: dropdown + tool arming + canvas drawing (pixels) live.
- **stubbed:** markup capture-together is Electron-only (the browser build can't capturePage); no undo/redo or shape-move (Clear + redraw).
- **next:** ship the batched weekly release when told (single version bump + consolidated changelog for all uncommitted work).

- P-PREVIEW.5b: trimmed the preview header vertical padding (13px to 5px) and compacted the toolbar to a single row (input shrinks, buttons tightened, no wrap) - header ~65px to ~49px. NO version bump.

**P-KG-CODE.1 - workspace code graph + KG header padding (NO version bump)**
- **shipped:** (ADR-0127) new `desktop/code_graph.ts` walks the workspace, parses import/require/dynamic-import edges, and builds a file→import dependency graph in the KG component's shape (files as nodes coloured by top-dir, imports as edges), persisted at `<root>/.omp/codegraph.json` (gitignored). `/api/codegraph` GET(status+graph)/POST(ingest). Below **Relate**, a 2px-gap stack adds **Code graph** (toggle: ingest-on-first-use + render in the canvas, bypassing personalization unlock) and **Update** (re-sync, shown once ingested); big repos cap to the top-600 hubs; node click → imports/imported-by side panel. Live personal-graph refresh suppressed in code mode. Trimmed the KG header vertical padding to 6px. Tested: 3 code-graph unit tests + real-repo run (354 files/754 imports) + live UI (stack, toggle, render, update, side panel).
- **stubbed:** file/module-level graph only (no symbol/function call graph); render capped to 600 hubs on huge repos (full graph stored); external packages excluded.
- **next:** ship the batched weekly release when told (single version bump + consolidated changelog for all uncommitted work).

- P-KG-CODE.1b: KG side flyout is horizontally resizable (drag handle + persisted --kgside-w); a floating re-center button (bottom-right, slides left of the flyout when open) calls graph.fit(); the code-node "Imported by" / "Imports" lists are numbered (ol). NO version bump.

- P-KG-CODE.1c: the code-graph "Update" button is now icon-only (refresh glyph + tooltip), moved out of the Relate/Code-graph stack to sit between Code graph and the AI checkbox. NO version bump.

- P-KG-CODE.1d: in the code-graph node panel, the file path + every Imports / Imported-by entry is now a clickable link that opens the real file in the Monaco IDE (resolved from the workspace root the endpoint now returns; editorRead + openIde; clear toast if the file moved since ingest). NO version bump.

**P-KG-SYM.1 - symbol-level AST code graph + level popup + agent codegraph_query tool (NO version bump)**
- **shipped:** (ADR-0128) new `desktop/symbol_graph.ts` builds a real **TypeScript-AST symbol graph** (functions/classes/methods/types/consts as nodes; cross-file-import + intra-file references as edges; `file#symbol` ids, kinds), persisted at `.omp/codegraph-symbol.json` (355 files→3093 symbols/5449 refs in <1s). Clicking Code graph now opens a **level-picker popup** (File graph fast vs Symbol graph AST, with trade-offs + a "Let the agent query this graph" checkbox); `/api/codegraph?level=` builds/loads either; the node panel switches to symbol semantics (kind, Uses/Used-by, file links). New read-only omp tool **`codegraph_query`** (`harness/omp/codegraph_extension.ts`) the agent calls to get import/use blast-radius from the stored graph instead of reading many files - loaded only when the user opts in (dedicated setting `codeGraphAgent`, `/api/codegraph/agent` restarts the backend). Clearly labeled a symbol-DEPENDENCY graph, not a fully type-resolved call graph. Tested: 6 graph unit tests + tool query logic + live UI (popup, 5095-symbol render, side panel, agent toggle).
- **stubbed:** symbol graph resolves references via imports + local names (AST), not value-typed method dispatch / overloads / dynamic dispatch; render capped to 600 hubs (full graph stored + queryable).
- **next:** ship the batched weekly release when told (single version bump + consolidated changelog for all uncommitted work).

- P-KG-SYM.1b: reworked the code-graph level-picker popup - wider (560 to 660px), the File/Symbol options are now distinct cards (darker fill, strong border + shadow, 14px gap) with left-aligned, brighter, larger (13px) text. NO version bump.

**P-AGENT (design): Agent Builder architecture + roadmap (ADR-0133, DESIGN ONLY - no feature code)**
- **shipped:** ADR-0129 in DECISIONS.md - the full architecture + phased roadmap for the **Agent Builder**: a visual workflow **canvas** (reuse `desktop/renderer/graph.ts` `mountGraph` + KG panel patterns) that edits a canonical validated **Agent Spec**, a **compiler** `buildAgent(spec) -> AgentBundle` that emits header-carrying, try/catch-wrapped omp `-e` extensions (the `codegraph_extension.ts` shape) + tail-only prompt, an **in-LUCID runtime** that runs built agents through the SAME `acp_backend` -> omp path under the mandatory fail-closed gate + tool allow-list + egress whitelist (goal-loop reuse for autonomous runs), and DuckDB migration `0010_agent_specs.sql`. Enterprise export = public core emits a portable signed bundle; the private `lucidagentIDEaddon` owns Electron/web/cloud deploy + the ADK adapters. Mapped all 10 invariants; codified the session's lazy-load/fail-soft lessons into the generator. Also this session: fixed `symbol_graph.ts` (typescript now type-only + lazy `loadTs()`, degrades to empty graph) and the About-panel avatar eager-load; version bump held per instruction.
- **stubbed:** ALL P-AGENT implementation (P-AGENT.1 spec+migration+EventNames, .2 canvas, .3 compiler, .4 in-LUCID run, .5 untrusted-spec gate, .6 enterprise export). ADK adapters (Google ADK / AWS Strands / Azure AI Foundry Agent Service) planned only -> future add-on **ADR-A013**, no work done per the user's directive.
- **next:** kickoff decisions RESOLVED with user (v1 = DAG-only; NEW `AgentMode`/`ExecutionProfile` in contracts.ts; self-edit policy-gated - enterprise OFF via managed policy, individuals ON but audit-mode dry-run + lessons-learned feedback + vault secrets w/ disclosure; Builder must lint/test/TDD + offer to search official docs). Build **P-AGENT.1** next session (Agent Spec DAG validator + `0010_agent_specs.sql` + new `AgentMode`/`ExecutionProfile`/EventNames + `selfEdit` policy field) as its own increment.

**P-AGENT.1 - Agent Spec contract + fail-closed DAG validator + DuckDB store (ADR-0133, BUILT)**
- **shipped:** the Agent Spec spine. New `harness/agent/spec.ts` (types + `validateSpec` fail-closed: rejects non-objects, unknown mode, duplicate/dangling ids, self-loops, tool nodes off the allow-list, CYCLES (v1 = DAG via DFS), and entry-less graphs; + `newSpecId`/`emptySpec`/`clampSelfEdit` tighten-only). New `harness/agent/store.ts` DuckDB persistence: `saveSpec` validates BEFORE insert (invalid spec never persisted), `loadSpec` re-validates on read (corrupted row -> null), `listSpecs`/`deleteSpec`, upsert on `spec_id`, provenance `trust_label`. Migration `0010_agent_specs.sql`. Frozen `contracts.ts` extended (own ADR-0133 touch): `AgentMode` + `ExecutionProfile` gain `built-agent`, 7 `agent_*` EventNames; `harness/runs/profiles.ts` PROFILE_CAPS/RANK cover the new profile (capable but isolated+gated). `make demo-P-AGENT.1`. Verified: 18 new unit tests + demo green; full suite 1136 pass / 5 pre-existing fs_browse Windows fails only; tsc clean; license headers pass; sidecar pytest green.
- **stubbed:** persistence is core-DB only (no desktop `/api/agent/*` wiring yet); spec is data-only (no canvas, compiler, or runtime yet); `selfEdit`/`built-agent` profile defined but not yet enforced at run time.
- **next:** P-AGENT.2 - the workflow canvas UI (rail + `#agentBuilder` panel + `desktop/renderer/agent_builder.ts` pure builder + `mountGraph` reuse + `/api/agent/*`), serializing to/from the Agent Spec.

**P-AGENT.2 (core) - workflow canvas pure builders + spec↔graph adapters (ADR-0133, BUILT)**
- **shipped:** `desktop/renderer/agent_builder.ts` (pure, no DOM, about.ts convention): `agentBuilderPanelHtml()` (the `#agentBuilder` right-edge surface - header + toolbar with an add-node button per kind + Validate/Save + `#abCanvas` host + `#abSide` node editor), `nodeEditorHtml(node, tools)` (kind-specific fields, esc-escaped), `specToGraphData(spec)` (adapts an Agent Spec into graph.ts's `PersonalGraphData` shape so the canvas mounts with the SAME `mountGraph` engine as the KG - no new dep, degree-counted nodes, kind preserved for the colour lens), `saveErrors()` (imports the real `validateSpec` for instant UX; server re-validates fail-closed), `newCanvasSpec()`. Single source of truth: imports Agent Spec types/validator from `harness/agent/spec.ts` (renderer already imports harness + is Bun.build-bundled). Verified: 7 unit tests green (panel ids, per-kind add buttons, kind-specific editor, HTML-escape injection guard, degree mapping, cycle surfaced); tsc clean.
- **stubbed:** the INTERACTIVE wiring (P-AGENT.2b): inject the panel into `app.ts` buildShell, add the rail glyph + open/close mutual-exclusivity, mount `mountGraph` into `#abCanvas` with add/drag/connect/select handlers, `/api/agent/*` (list/load/save/delete via `harness/agent/store.ts`), and `styles.css` for `.ab-*`. Needs browser verification.
- **next:** P-AGENT.2b interactive wiring, then P-AGENT.3 (the compiler `buildAgent(spec) -> AgentBundle`).

- P-PREVIEW.3a-shot fix (NO version bump): the agent's `preview_screenshot` often returned stale/empty text and the agent fell back to reading the DOM. Root cause = the preview PNG was captured ONCE (`frame.onload` + 150ms), so it went stale the moment the previewed app animated or the file was re-edited, and was blank if first paint took >150ms. Fix: a 1.5s **freshness loop** (`startPreviewShotLoop`/`stopPreviewShotLoop` in `desktop/renderer/app.ts`, tied to `openPreview`/`closePreview`) re-captures while the preview is visible so the cached shot tracks what's on screen (`cacheRenderedPreviewShot` no-ops when hidden). tsc clean. (Note: the tool only ever captures the preview IFRAME, never LUCID's own chrome - `capturePage` is Electron-only so it can't be checked in the browser preview MCP.)

**P-AGENT.2b - Agent Builder interactive canvas wired into the app + persistence (ADR-0133, BUILT + verified live)**
- **shipped:** the Agent Builder is now a working right-edge surface. `harness/agent/file_store.ts` = workspace-local spec persistence (`.omp/agents/<id>.json`, path-traversal-guarded, fail-closed on save AND load; the engine holds the DuckDB read-only so authored specs live as workspace files). `desktop/dev.ts` `/api/agent` (GET list / GET ?id= load / POST validate-then-save fail-closed) + `/api/agent/delete`; `bridge.ts` `agentList/agentLoad/agentSave/agentDelete`. `app.ts` wiring: `spark` rail glyph + `data-rail="agentBuilder"`, panel injected into buildShell, `openAgentBuilder`/`closeAgentBuilder` with full right-surface mutual-exclusivity, `mountGraph` (the KG engine) into `#abCanvas` via `specToGraphData`, add-node (4 kinds) + node editor (label/prompt/tool/subagent + delete) + Connect mode (relate-mode edge draw) + Validate (live `saveErrors` banner) + Save (toast). `.ab-*` styles. `.gitignore` += `.omp/agents/`. Verified LIVE in the browser dev server (preview MCP): panel opens, canvas mounts + renders nodes (1079x785), add-node grows the graph (1->2->3 circles) + opens the editor, an unfilled tool node surfaced "nodes[2] (tool) must name a tool" in the error banner, Save persisted a valid 2-node spec JSON to disk ("Agent saved" toast). 13 new unit tests (file_store 6 + agent_builder 7). Full suite 1149 pass / only the 5 pre-existing fs_browse Windows fails; tsc + license clean.
- **stubbed:** node auto-layout is the graph engine's force layout (no DAG left-to-right layering yet); the tool-node select is empty until the spec has a `tools` allow-list (no allow-list editor yet); no rename/new/list-of-agents UI (loads the most-recent saved spec).
- **next:** P-AGENT.3 - the compiler `buildAgent(spec) -> AgentBundle` (emit header-carrying, try/catch-wrapped omp `-e` extensions + tail-only prompt).

**P-AGENT.3 - the Agent Builder compiler buildAgent(spec) -> AgentBundle (ADR-0133, BUILT)**
- **shipped:** `harness/agent/compiler.ts` - pure `buildAgent(spec)` that lowers a validated spec into a portable **AgentBundle** (systemPrompt + files[] + manifest). Emits: (1) a **system prompt** (TAIL content, never the frozen prefix) = persona + the DAG rendered as an ordered step list (`topoOrder` = deterministic Kahn sort) + the tool allow-list line + `LUCID_CORE_INSTRUCTIONS` (fail-closed gate / use preview not browser-bash-eval / egress whitelist / untrusted content is data / secrets in the vault - the "how to use LUCID's core features" the built agent needs); (2) a generated omp `-e` **allow-list enforcement extension** in the EXACT `codegraph_extension.ts` shape - BUSL header stamped, try/catch-wrapped fail-soft, a `tool_call` hook that returns `{block,true,reason}` for any tool the spec didn't allow-list (matches the live gate's `event?.toolName`); (3) manifest.json + spec.json. Codifies the lessons: FAIL-CLOSED (refuses to compile an invalid/cyclic spec), injection-safe (all spec values embedded via JSON.stringify), header-on-every-file. `make demo-P-AGENT.3`. Verified: 8 unit tests incl. one that WRITES the generated extension + dynamically imports + runs it (blocks `bash`, allows `web_search`); demo green; full suite 1157 pass / only the 5 pre-existing fs_browse Windows fails; tsc + license clean.
- **stubbed:** v1 emits only the allow-list extension (no per-node custom-tool codegen yet); the bundle isn't yet RUN (P-AGENT.4) or persisted/signed (P-AGENT.6); the workflow renders as a linear ordered list (branch/loop is later).
- **next:** P-AGENT.4 - run a built AgentBundle INSIDE LUCID through `acp_backend` -> omp under the mandatory fail-closed gate + the generated allow-list extension (`-e`), with provenance events; reuse the goal loop for autonomous runs.

**P-AGENT.4a - AgentBundle runner foundation: materialize + gate-first omp launch composition (ADR-0133, BUILT)**
- **shipped:** `harness/agent/runner.ts`. `materializeBundle(bundle, runDir)` writes every bundle file to disk (nested paths honored) and returns the omp launch inputs: `extensionPath` + `ompExtensionArgs` (`["-e", <allowlist.ts>]`), the `systemPrompt` (TAIL), and the requested `egress` patterns surfaced for the caller to register under the managed whitelist ceiling (the runner never widens egress). `composeBuiltAgentArgs({gate, run, basePolicy?, extraExtensions?})` assembles the full omp argv + appended prompt and GUARANTEES the fail-closed security gate is the FIRST `-e` extension (invariant #4 - a built agent's own allow-list extension is appended AFTER it, never before) and that the agent prompt is TAIL-appended after any base policy (never the frozen prefix). Pure-of-omp so it's unit-testable without a live model. Verified: 6 runner tests (materialize + import-and-run the written extension + gate-first ordering + TAIL-append); all 36 harness/agent tests green; tsc + license clean.
- **stubbed:** the LIVE integration (P-AGENT.4-live): a `Backend.runBuiltAgent` in `desktop/acp_backend.ts` that spawns omp with these composed args, streams, registers the egress, emits `agent_run_started`/`agent_run_gated`/`agent_run_finished`, plus a Run action + streaming in the Agent Builder UI (reuse the goal loop for autonomous runs). This spawns a real model + touches the core gated runtime, so it can't be verified in this environment - deliberately left for a focused pass rather than shipped unverified.
- **next:** P-AGENT.4-live run wiring (fresh session, live model), then .5 untrusted-spec quarantine gate, .6 enterprise export.

**P-AGENT.5 - untrusted-spec quarantine gate (keystone-#2 analogue) (ADR-0133, BUILT)**
- **shipped:** `harness/agent/import_gate.ts` - a spec from an EXTERNAL source, or whose text carries an injection, can never auto-run. Mirrors `harness/security/gate.ts`: `scanSpec` = the FAIL-CLOSED seam (scans the spec's model/human-facing free text - name/description/persona/node labels+prompts, NOT tool identifiers - via the sidecar; any scan failure quarantines); `importDecision` (pure) = provenance + findings -> trust label (local+clean -> trusted; import+clean -> untrusted; sub-threshold findings -> suspicious; blocking/fail-closed -> quarantined); `canAutoRun` (pure) = only "trusted" auto-runs; `importSpec` = parse -> validate -> scan -> label -> run-permission (parse error / invalid spec -> fail-closed quarantine). `make demo-P-AGENT.5`. Verified: 9 unit tests + a scanner-integrated demo against the REAL sidecar (local-clean -> trusted+runnable; import-clean -> untrusted+blocked; zero-width-poisoned import -> quarantined+blocked, scanner flagged it; malformed JSON -> fail-closed). Full suite 1172 pass / only the 5 pre-existing fs_browse Windows fails; tsc + license clean.
- **stubbed:** the run path must CALL `canAutoRun(storedTrustLabel)` before executing (wired in P-AGENT.4-live); no review/approve UI to promote an untrusted spec to runnable yet.
- **next:** P-AGENT.6 - enterprise export (portable signed AgentBundle + target manifest for electron/web/cloud), then P-AGENT.4-live.

**P-AGENT.6 - enterprise export: portable, tamper-evident AgentBundle per target (ADR-0133, BUILT)**
- **shipped:** `harness/agent/export.ts` - the public core packages a compiled bundle for a deploy target (`electron`/`web`/`cloud`) via `exportBundle(bundle, target)` -> ExportPackage (the bundle files + an `export.json` manifest). "Signed" = a deterministic **SHA-256 content digest** over the bundle files (`bundleDigest`); `verifyExport` recomputes it and REJECTS a modified package (tamper-evidence). Honest split: the actual deploy adapters + cryptographic KEY signing live in the private add-on (ADR-A012/lucidagentIDEaddon), not the public core; the agent's egress requests are carried as DATA for the target to enforce, never auto-granted. `make demo-P-AGENT.6`. Verified: 5 unit tests (packages files + manifest, deterministic digest, per-target entry, verify passes untampered, verify FAILS when a file is modified) + demo (exports all 3 targets, tampering `allowlist.ts` block:true->false is caught). Full suite 1177 pass / only the 5 pre-existing fs_browse Windows fails; tsc + license clean.
- **stubbed:** real KMS-keyed signing + the electron/web/cloud deploy scaffolds are add-on (ADR-A012) territory.
- **next:** P-AGENT.4-live (Run button, needs a live model); ADK adapters remain deferred (ADR-A013).

**P-AGENT.6b - Export wired into the canvas + verified live (ADR-0133, BUILT)**
- **shipped:** `harness/agent/export.ts` `writeExportPackage(pkg, dir)` (writes the package to disk, re-verifies from disk in a test); `dev.ts` `POST /api/agent/export` (validate fail-closed -> `buildAgent` -> `exportBundle` -> write to `<workspace>/.omp/agent-exports/<spec_id>/<target>/`, returns dir+digest+fileCount); `bridge.agentExport`; an **Export** button in the canvas toolbar (`agent_builder.ts`) + `exportAgentBuilder()` in `app.ts` (validates, exports the electron target, toasts the path + digest); `.gitignore += .omp/agent-exports/`. Verified LIVE in the browser dev server: the export route returned `ok:true` with 5 files + a sha256 digest, all 5 files (SYSTEM_PROMPT.md, allowlist.ts, manifest.json, spec.json, export.json) written to disk with the per-target `entry` + carried egress, and the Export BUTTON produced the toast "Agent exported 5 files -> …". (The preview screenshot tool timed out on the infra side despite a responsive page - verified via DOM/network/disk instead; an identical panel screenshot succeeded earlier in P-AGENT.2b.) 1 new export test (14 total in the two files); full suite 1178 pass / only the 5 pre-existing fs_browse Windows fails; tsc + license clean.
- **next:** P-AGENT.4-live (Run button + live gated omp run), the last core increment before the deferred ADK adapters (ADR-A013).

**P-AGENT.4-live - a BUILT agent RUNS on a real Claude model, VERIFIED (ADR-0133)**
- **shipped:** two live integration demos (need a model + network; NOT in `make test`) that run a compiled agent through `omp -p --model haiku` with its generated allow-list `-e` extension + compiled system prompt. `demo_p_agent_4_live.ts`: the built agent answered "What is the capital of France?" -> "Paris…" AND followed its compiled persona (ended with the marker `LUCID-AGENT-DONE`) - so spec -> compile -> materialize -> live model works end-to-end, and the generated extension loads fail-soft without breaking the run. `demo_p_agent_4_live_enforce.ts`: an A/B that isolates the EXTENSION's hard enforcement (neutral tool-encouraging prompt) - CONTROL (no extension) read a secret file token `BANANA-42-XZ9Q`; ENFORCED (allow-list=[]) was BLOCKED by the generated `tool_call` hook (the live model reported "all file-reading and code-execution [tools blocked]") so the token never reached it. Runtime allow-list enforcement confirmed on a live model, independent of the prompt. `make demo-P-AGENT.4-live`. omp v16.0.8; env auth (ANTHROPIC_AUTH_TOKEN) reaches Haiku (smoke-tested).
- **stubbed:** the in-APP "Run" button (spawn from the canvas via `acp_backend`, stream into the UI, call `canAutoRun(trustLabel)` first, emit `agent_run_*` events, register egress) - the RUNTIME is now proven via the CLI path; the UI Run button is the remaining wiring.
- **next:** wire the in-app Run button (reusing the proven CLI mechanism via `acp_backend`); ADK adapters remain deferred (ADR-A013).

**P-AGENT.4-live UI - in-app "Run" button, RUN a built agent from the canvas + verified LIVE (ADR-0133, BUILT)**
- **shipped:** `desktop/agent_run.ts` `runBuiltAgent()` - fail-closed BEFORE spawn (`canAutoRun(trustLabel)` refuses a non-runnable-trust spec; invalid spec / empty prompt refused), then compile -> materialize -> spawn `omp -p --model <model>` with the mandatory security **gate FIRST** (`-e security_extension.ts`, invariant #4) + the generated allow-list extension + the compiled system prompt (TAIL), in an isolated `.omp/agent-runs/<id>/` dir, hard-timeout-bounded. `dev.ts` `POST /api/agent/run`; `bridge.agentRun`; a **Run ▸** button in the canvas toolbar + a Run flyout (`runPanelHtml`: task box + model pill + Run agent button + output area) wired in `app.ts` (`openAbRunPanel`/`runAgentBuilder`). `.gitignore += .omp/agent-runs/`. Verified LIVE in the browser dev server against a REAL Claude model: the `/api/agent/run` route (WITH the gate loaded) returned `ok:true` "Paris is the capital of France." on Haiku; the Run button opened the flyout (model pill `anthropic/claude-opus-4-8`), a run rendered the answer into the output area, and clicking "Run agent" fired the handler (-> "Running the agent…"). Status bar showed "gate active". Screenshot captured. 4 new hermetic guard/panel tests; full suite 1182 pass / only the 5 pre-existing fs_browse Windows fails; tsc + license clean.
- **stubbed:** the run is a one-shot `omp -p` in an ISOLATED dir (v1 doesn't touch the user's workspace) and is non-streaming (returns the final text); it doesn't yet emit the `agent_run_*` provenance events or register the agent's egress under the managed ceiling (both are additive follow-ons).
- **next:** streaming + `agent_run_*` provenance events + egress registration; the deferred ADK adapters (ADR-A013). The core Agent Builder epic (author -> compile -> quarantine-gate -> run-live -> export) is now COMPLETE.

**P-AGENT.8.1 - CONVERSATIONAL Agent Builder: the secret guardrail (ADR-0134, BUILT; design for .1-.5)**
- **shipped:** the security FOUNDATION for a chat-driven Agent Builder (user describes a goal -> LUCID drafts a secure agent -> opens the canvas pre-populated). The load-bearing rule ("the agent must NEVER collect secret values") is now enforced: the Agent Spec gains `secrets?: SecretRef[]` (`{name, kind, purpose}` - kinds mirror the vault's AuthKind; NO value field, and the validator rejects a secret entry carrying `value`/`secret`); new `harness/agent/secret_guard.ts` `scanSpecForSecrets` scans every free-text field (name/description/persona/node labels+prompts/secret purpose) for APPARENT secret VALUES (PEM keys, AWS/OpenAI-style/GitHub/Slack/Google key shapes, bearer tokens, `password/api_key = <value>`) with a REDACTED snippet; `assertSecretFree` throws on any hit and is wired into `buildAgent` (compile) + `saveSpecFile` + `saveSpec` (persist) + transitively the run path - so a credential can NEVER be compiled, saved, or run inside an agent. Declared refs + env-var NAMES + prose stay clean (high-signal detectors). ADR-0134 designs the full flow (`agent_builder_open` handoff tool reusing the `preview_open` pattern; `AGENT_BUILDER_POLICY`; a Secrets & connections panel wiring SecretRefs -> the OS-encrypted vault + egress -> the whitelist; doc-assisted token setup). `make demo-P-AGENT.8.1`. Verified: 9 unit tests + demo (declared-refs agent builds+saves clean; an embedded `sk-…` is refused at compile AND save); full suite 1191 pass / only the 5 pre-existing fs_browse Windows fails; tsc + license clean.
- **stubbed:** the CONVERSATIONAL half (P-AGENT.8.2-.5): the `agent_builder_open` tool + acp_backend handoff, the `AGENT_BUILDER_POLICY` (PREFIX_VERSION bump), the Secrets & connections vault/egress panel, and doc-assisted API-token setup.
- **next:** P-AGENT.8.2 - the `agent_builder_open` omp tool + acp_backend detection + open the canvas pre-populated with a drafted (secret-free, validated) spec.

**P-AGENT.8.2 + .8.4 - chat->canvas handoff + the Secrets & connections panel (ADR-0134, BUILT + verified live)**
- **shipped:** the seamless on-ramp. HANDOFF (.2): `harness/agent/handoff.ts` `parseDraftedSpec` (parse->validate->secret-scan, fail-closed) + `agentBuilderOpenSpec` detector; `harness/omp/agent_builder_extension.ts` registers the agent-callable **`agent_builder_open`** tool (the chat agent drafts a spec + calls this to open the canvas; a leaky/invalid draft is REJECTED with steering feedback); `acp_backend.ts` loads the `-e` extension, adds the `agent-builder-open` ChatEvent, and detects the tool_call (mirrors the `preview_open`->`previewOpenPath`->emit pattern, re-validating + secret-scanning authoritatively before opening); renderer `onEvent` -> `openAgentBuilderWithSpec` (opens the canvas pre-populated + auto-surfaces secrets). SECRETS & CONNECTIONS (.4): `secretsPanelHtml` + a **Secrets & connections** toolbar button + auto-open-on-handoff, listing the agent's CONNECTIONS (egress domains/API addresses) + CREDENTIALS (declared SecretRefs) with a per-row paste field that stores the value straight into the OS-encrypted vault via `bridge.credStore` (`ref`=the SecretRef name; Electron-only, fail-closed in browser) - the agent NEVER sees the value. `.ab-conn`/`.ab-cred` styles. Verified LIVE: a GovWin/Salesforce-style spec (declared creds + egress, no values) saved clean through the guardrail; opening the Agent Builder + Secrets showed all 3 connections (*.sam.gov/*.govwin.com/*.salesforce.com) + both creds (GOVWIN_PASSWORD basic, SALESFORCE_API_TOKEN apikey) with paste-to-vault fields + the doc hint ("generate under Setup → Personal → Reset Security Token") + "needs a value" status. Screenshot captured. Also CONFIRMED the existing preview markup->chat flow (`screenshotPreviewToChat`/#prevShot) already lets the user mark up the preview + send it to the agent. 9 new tests; full suite 1200 pass / only the 5 pre-existing fs_browse Windows fails; tsc + license clean.
- **stubbed:** P-AGENT.8.3 (`AGENT_BUILDER_POLICY` in the frozen prefix - the guardrail prompt that steers the chat agent to recognize automatable asks, explain, declare-not-collect secrets, and call `agent_builder_open`; PREFIX_VERSION 7->8 + ADR); the egress rows are display+confirm only (not yet writing `WhitelistEntry`s); doc-assisted token setup (.5) is surfaced as help-text, not yet an interactive doc-read flow; the site-login -> screen-capture -> ingest collaboration (constrained by X-Frame-Options / the sandbox) is designed in ADR-0134, not built.
- **next:** P-AGENT.8.3 - the `AGENT_BUILDER_POLICY` (frozen-prefix bump) so the chat agent actually drives this end-to-end; then .5 doc-assisted setup + egress->whitelist write.

- UI-FIX (NO version bump): the composer footer squished when a right-edge surface (KG / Monaco IDE / Agent Builder) narrowed the center. Moved the **Persona + Skills** chips OUT of the composer and INTO the titlebar next to the model picker (`.tb-chip`, full-width titlebar never squishes; ids/handlers unchanged) and REMOVED the "↵ send / ⇧↵ newline / Ctrl+K commands" hint text - the composer footer now keeps ONLY the mic button. Verified live (Persona/Skills render as titlebar pills; `#composerTools` = [ctMic] only; hint gone). tsc clean; suite 1200 pass.

**P-AGENT.8.3 - AGENT_BUILDER_POLICY: the chat agent drives the handoff (ADR-0134, BUILT; frozen-prefix v7->v8)**
- **shipped:** the conversational loop is now closed. New frozen `AGENT_BUILDER_POLICY` in `harness/prompt/assembler.ts` layer 3 (byte-stable, cached) steers the CHAT agent: when the user describes a repeatable task to automate, explain the plan + confirm, then call `agent_builder_open` to open the canvas pre-populated (nodes/tools/egress + credential NAMES); and the load-bearing guardrail - NEVER ask for/accept/embed a secret VALUE (declare a SecretRef; the user adds the value in the Secrets & connections panel -> vault; if the user pastes a secret, don't put it in the agent); read OFFICIAL docs to walk the user through generating a token they don't know how to get. `PREFIX_VERSION` 7->8 (its own frozen-prefix increment, ADR-0130); wired into `acp_backend` `appendedPolicy` so the live model sees it too. Verified: prefix byte-stability test green + a new test asserts the guardrail is IN the frozen prefix; full suite 1201 pass / only the 5 pre-existing fs_browse Windows fails (a transient 6th was a flake, gone on re-run); tsc + license clean.
- **stubbed:** the full LIVE chat->draft->open loop (agent decides to call the tool) needs a real model + is multi-turn (the policy has it CONFIRM before opening) - the mechanism + policy are all in place; a live end-to-end demo is available on request. `.8.5` doc-assisted interactive token setup + egress->whitelist write still pending.
- **next:** optional live end-to-end chat demo; then P-AGENT.8.5 (doc-assisted setup + egress->`upsertEntry` whitelist write).

**P-AGENT.8.2 fix + LIVE END-TO-END DEMO (ADR-0134) — the conversational loop works against a real model**
- **shipped:** ran the full chat->canvas flow live against Opus 4.8: typed "build a gov-bd-scout agent that searches DoD/DoW opportunities and logs to Salesforce…", the live agent DRAFTED a spec + called `agent_builder_open`, and the **Agent Builder canvas opened pre-populated** with the exact workflow (Find opportunities → web_search → Log to Salesforce) + the **Secrets & connections panel auto-opened** (GOVWIN_PASSWORD / SALESFORCE_API_TOKEN) + a confirmation toast. Along the way, TWO things proved out: (1) the fail-closed validation caught a real agent mistake live - the agent's first draft had a `http_request` tool node not in the allow-list, the tool REJECTED it ("tool node http_request is not in the tools allow-list") and the agent self-corrected; (2) a **detection BUG fixed**: omp renders a custom tool's call TITLE as a human summary ("Opening agent builder for X"), NOT the tool name - so the original title-regex in `agentBuilderOpenSpec`/`acp_backend` never matched. Switched detection to key on the UNIQUE `specJson` arg (read from `rawInput` OR `input`), which is robust + still fail-closed (leaky/invalid draft -> null, never opens). Verified via the diagnostic (`specJsonLen=1243`, title="Reopening agent builder with fixed spec"). Handoff test updated; tsc + license clean; suite 1202 pass. (Screenshot tool flaked on this run; verified via DOM eval - canvas open, nodes rendered, secrets panel open, toast shown; identical panel screenshotted cleanly earlier.)
- **stubbed:** the model NARRATES before invoking unless pushed - a natural "build me X" often explains + confirms first (by design), then calls the tool on the follow-up; the policy could be tightened to invoke sooner. P-AGENT.8.5 (doc-assisted setup + egress->whitelist write) still pending.
- **next:** P-AGENT.8.5.

**P-AGENT.8.6 - the `/agent` slash command: one-tap Agent Builder interview (ADR-0134, BUILT + verified live)**
- **shipped:** `/agent [optional description]` starts the guided "what kind of agent do you want to build" interview. `agentInterviewPrompt(desc)` in `desktop/renderer/agent_builder.ts` (pure) builds a kickoff that makes the chat agent - steered by the frozen `AGENT_BUILDER_POLICY` - ask (1) what it should do, (2) tools + sites/APIs, (3) credentials by NAME only (never values), (4) read docs for tokens, then call `agent_builder_open`. Client-side wiring in `app.ts`: `send()` detects a leading `/agent` (word-boundary regex, so `/agenda` is untouched) and sends the kickoff to the model while showing the user's `/agent …` in the transcript; `slashSource()` adds `/agent` PROMOTED to the top of the "/" autocomplete (`complete: "/agent "` so the user can add a one-liner first). Verified LIVE: `/agent` tops the autocomplete ("Build an AI agent — LUCID interviews you…"); sending it made Opus open the interview - "Step 1 of 4 — What should this agent do?" with an example - i.e. the transform + guardrailed interview work end-to-end (screenshot). 1 new test; full suite 1203 pass / only the 5 pre-existing fs_browse Windows fails; tsc + license clean.
- **stubbed:** `/agent` reuses the same interview->handoff path (P-AGENT.8.2-.4); no separate modal (the agent conducts the interview conversationally). Retry-after-/agent re-sends the raw `/agent` (minor edge; the policy still recognizes it).
- **next:** P-AGENT.8.5 (doc-assisted token setup + egress->`upsertEntry` whitelist write).

**P-AGENT.8.5 - approve connections -> whitelist + doc-assisted credential setup (ADR-0134, BUILT + verified live)**
- **shipped:** the Secrets & connections panel is now ACTIONABLE. (1) EGRESS -> WHITELIST: each connection row shows an **Approve** button; clicking it calls `bridge.whitelistUpsert({kind:"domain",pattern,zone:"external",scope:"project"})` -> `dev.ts` `/api/whitelist` (now defaults `project` to `currentWorkspace()` for project-scoped entries) -> `upsertEntry` writes a project-scoped `WhitelistEntry`; the row flips to "✓ approved" (the panel reloads the whitelist to show current state). (2) DOC-ASSISTED SETUP: each credential row shows a **"How do I get this?"** link that seeds + sends a message asking the agent to read the vendor's OFFICIAL docs and give numbered steps to obtain the credential (value -> vault, never chat) - reuses the proven `send()` path + the frozen `AGENT_BUILDER_POLICY`. `secretsPanelHtml` gains an `approvedEgress` set; `.ab-conn-approve`/`.ab-cred-help` styles. Verified LIVE: with a gov-bd-scout spec, clicking Approve on `*.sam.gov` WROTE it to the whitelist (confirmed via `/api/whitelist`) + flipped the row to "✓ approved" + toast; the "How do I get this?" link fired a real doc-assist turn ("Walk me through generating SALESFORCE_API_TOKEN… read the official documentation…"). Screenshot captured. 2 new tests; full suite 1204 pass / only the 5 pre-existing fs_browse Windows fails; tsc + license clean.
- **stubbed:** egress approve writes a `domain` project-scoped entry (no per-entry auth binding or call-budget yet); doc-assist depends on the agent having web/doc access (egress) to read live docs.
- **next:** the P-AGENT.8 conversational epic is feature-complete (secret guardrail -> chat->canvas handoff -> policy -> Secrets & connections w/ vault + whitelist + doc-assist -> `/agent` command). Optional: tighten the policy to invoke the handoff sooner; per-entry auth binding.

**FIX - tool node dropdown was empty on a hand-built canvas (P-AGENT.2 follow-up)**
- **shipped:** `TOOL_CATALOG` (17 omp tools + descriptions) in `desktop/renderer/agent_builder.ts`; the tool node dropdown now offers allow-list + catalog (grouped, tooltip descs, "(choose a tool)" placeholder), and picking a non-allow-listed tool AUTO-ADDS it to `spec.tools` in app.ts so the validator invariant holds; 2 new tests, `bun test desktop/agent_builder.test.ts` 14/14 + `typecheck:desktop` green.
- **stubbed:** the catalog is a hand-curated static list (not queried from the running omp instance); no UI to REMOVE a tool from the allow-list yet.
- **next:** derive the catalog from omp at runtime (or a shared harness constant) + an allow-list chip editor with remove.

**P-AGENT.9 - allow-list chips + live canvas collaboration + portable share/import w/ JIT credential provisioning (ADR-0137, BUILT + tested)**
- **shipped:** Tools flyout with removable allow-list CHIPS (in-use badges; removal blocks the call at run time, validator flags orphaned steps); agent_builder_open now LIVE-UPDATES an open canvas per turn (policy: explain changes, recommend, warn risk/benefit/mitigation for bash/eval/wildcard-egress/write); SecretRef.provisioning (user-input | jit-ticket w/ ServiceNow-style template + rationale) validated fail-closed, scanned by secret_guard + import gate; portable .lucid-agent.json (sha256 canonical digest, setup_md, NEVER credential values) with Share/Import buttons; imports run the P-AGENT.5 scanner gate, persist a trust sidecar, show a trust banner, and cannot run until "Approve after review" (quarantined never approvable). 115 tests green (agent+builder+prompt suites incl. prefix regression), typecheck root+renderer clean.
- **stubbed:** TOOL_CATALOG stays hand-curated (not queried from live omp); trust sidecar defaults missing->trusted for legacy local specs; server tsconfig has pre-existing netdiag.ts/dev.ts:253 diagnostics from unrelated in-flight work.
- **next:** derive the tool catalog from the running omp; per-secret vault-fill progress in the import flow; consider surfacing the setup_md as a rendered checklist panel on import.

**P-AGENT.10 - n8n interop (export ⇩ / import / enterprise push ⇧ seam) + roadmap ADRs 0136-0143**
- **shipped:** pure translator harness/agent/n8n.ts (spec→n8n scaffold: real Wait nodes for approvals, provenance sticky embeds the portable agent = digest-checked lossless round-trip; n8n→spec: wait→approval, executeWorkflow→subagent, httpRequest→read+egress harvest, creds→SecretRef names w/ provisioning, loop-backs dropped, every compromise in notes[]); /api/agent/import now detects BOTH formats and still funnels through the P-AGENT.5 scanner gate; /api/agent/n8n-export + n8n-push; desktop/addon_seam.ts (LUCID_ADDON_DIR or sibling lucidagentIDEaddon, connectors/<n>/src/cli.ts one-JSON-line contract, fail-honest dispatch, add-on code never in-process); toolbar n8n ⇩ / n8n ⇧ buttons; ADR-0138 (built) + design ADRs 0137-0143 (step-runner w/ ENFORCED approvals, MCP tool catalog, run traces, triggers, spec v2 reliability, external secret providers, history+gallery). 11 new tests; 111 green across agent+builder suites; renderer typecheck clean.
- **stubbed:** n8n push/pull connector itself is add-on work (contract spec'd in ADR-0138); generic n8n import is scaffold-fidelity by design (expressions/branch semantics await P-AGENT.11c/.15); trigger nodes noted-not-mapped until P-AGENT.14.
- **next:** P-AGENT.11a - the step-runner with enforced approval halts (ADR-0139 keystone: no post-approval output without an explicit approve).

**P-AGENT.11a - the step-runner: ENFORCED approval halts (ADR-0139; same-session continuation at user direction)**
- **shipped:** harness/agent/segments.ts — splitSegments (approval nodes become boundaries, never steps), renderSegmentPrompt (segment-only steps w/ global numbering, prior-output carry-forward, halt notice), and the SegmentedRun KEYSTONE machine: currentSegment() is the only source of an executable prompt and throws outside "running", so post-approval steps are structurally unreachable without approve(); deny is terminal; desktop/agent_run.ts drives segments through the same gated omp spawn (gate FIRST) with a 30-min-TTL paused-run registry (expired/unknown approval = refusal); /api/agent/run returns paused, /api/agent/run/approve resolves; Run-flyout approval card (approve/deny). 10 keystone tests + card test; 122 green across agent/builder/seam suites; root+renderer typecheck clean.
- **stubbed:** one-shot prose path still serves approval-free specs (by design); subagent steps still prose (11b); no branch nodes (11c); segment outputs not yet persisted as run traces (P-AGENT.13).
- **next:** P-AGENT.11b — subagent steps invoke runBuiltAgent on the child spec under the CHILD's allow-list + trust label (depth cap 3, spec_id cycle guard).

**P-AGENT.11b - real sub-agents: child runs under the CHILD's allow-list + trust (ADR-0139)**
- **shipped:** subagent nodes are now machine boundaries — SegmentedRun adds "awaiting-subagent" (post-subagent segments structurally unreachable until recordSubagentOutput) + pure subagentGuard (unset child / missing spec / spec_id cycle / depth cap 3 / child-with-approvals all refuse, fail-closed); desktop/agent_run.ts execChildAgent materializes the CHILD's own bundle (its allow-list extension, gate FIRST) and honors the child's STORED trust label via canAutoRun — an unapproved imported child refuses exactly like a top-level run; child output feeds the parent's next segment; recursion covers grandchildren with guards re-run per level. 6 new tests; 128 green across agent/builder/seam; root+renderer typecheck clean.
- **stubbed:** nested approval halts refused (not parked) by design; child runs share the parent's model + timeout; no per-child run trace yet (P-AGENT.13).
- **next:** P-AGENT.11c branch nodes (after P-AGENT.13 traces, per ADR-0139) or P-AGENT.12 MCP tool catalog — user's pick.

**P-AGENT.13 - per-run execution traces + Runs flyout (ADR-0141, w/ recorded file-backed delta)**
- **shipped:** harness/agent/trace.ts — fail-soft TraceRecorder (a trace write never breaks the run), snippet truncation, corrupted-file-skipping list/load, path-safe run ids; agent_run.ts instruments one-shot runs, every segment spawn, approval approve/deny decisions, and sub-agent hops (children get their OWN trace linked by run id + lineage); the stable run_id now doubles as the approval-resume handle (invariant #9, replaces the separate segrun id); /api/agent/traces + /api/agent/trace; Runs toolbar flyout → trace list → per-step detail with status pills. DELTA recorded in ADR-0141: traces are workspace FILES (desktop holds agent_obs.duckdb read-only; DuckDB ingest joins the future gate-child pipeline). 6 new trace tests + builders test; 134 green; root+renderer typecheck clean (server-config diagnostics are the pre-existing netdiag/dev.ts:253 items from unrelated in-flight work).
- **stubbed:** canvas node-highlighting from a selected trace (future polish); no DuckDB ingestion yet; prompt-step attribution is segment-level until 11c branch semantics land.
- **next:** P-AGENT.12 — dynamic tool catalog from MCP servers + live omp (ADR-0140), then 11c branching.

**P-AGENT.12 - dynamic tool catalog: MCP server tools in the Builder pickers (ADR-0140)**
- **shipped:** desktop/mcp_probe.ts — MCP JSON-RPC over streamable HTTP (initialize/initialized/tools/list, mcp-session-id, SSE-framed bodies tolerated, bearer auth), 5-min probe cache, tested against a LIVE in-process fixture server (no mocks); tool names use omp's VERIFIED runtime convention `mcp__<server>_<tool>` (prefix de-dup confirmed from the pinned bundle) so the compiled allow-list + gate match exactly; /api/agent/tools + bridge.agentMcpTools; the node-editor dropdown AND the chips add-picker grow an “MCP tools (third-party)” group with per-tool provenance titles; AGENT_BUILDER_POLICY risk bullet now names the transiting MCP server (prefix regression green). Fail-soft everywhere: no servers / probe failure / SSE-legacy → exactly the built-in picker. 9 new tests; 158 green; root+renderer typecheck clean (server-config diagnostics remain the pre-existing netdiag/dev.ts:253 items).
- **stubbed:** legacy SSE-transport servers aren't enumerated (their tools still run under omp); live-omp builtin tool enumeration still static; ADR-0137's catalog stub now closed for MCP, open for omp-native discovery.
- **next:** P-AGENT.11c branch nodes (traces now exist to debug them) or P-AGENT.14 triggers — user's pick.

**P-AGENT.11c + .15 - branch nodes + segment-granular reliability (spec v2; ADR-0139/0141)**
- **shipped:** spec v2 (v1 files stay valid — version list is a compatibility marker, validation is field-driven): `branch` node kind (≥2 labeled outgoing edges enforced), edge labels, node.retry{max≤3,backoffMs} + node.timeoutMs (bounded); SegmentedRun gains at-branch state + reachability skip-set — takeBranch cuts the not-taken subtree so a skipped approval NEVER halts while joins/parallel chains run untouched; parseBranchChoice is strict (no CHOICE line ⇒ run fails naming the options; the runner never guesses); driveSegments adds bounded retries w/ linear backoff (each attempt traced) + tightest-node timeout; canvas: Branch node kind, per-edge choice-label inputs, retry/timeout inputs, edge labels render as canvas relations; n8n import maps IF/Switch → branch w/ true/false lane labels (underconnected ones demote to prompt, noted); policy + tool description mention branch (prefix regression green). 15 new tests; 168 green; root+renderer typecheck clean.
- **stubbed:** edge.kind onError stays design (ADR-0143; no version bump needed when it lands); branch decisions are model-emitted CHOICE lines — deterministic expression predicates deferred; one-shot prose path unchanged for boundary-free specs.
- **next:** P-AGENT.14 triggers (scheduled runs for trusted specs via automations) or P-AGENT.17 history+gallery — user's pick; enterprise seams (n8n push connector, KMS providers) wait on the add-on repo.

**P-AGENT.14 phase 1 - scheduled agent runs through the automations engine (ADR-0142)**
- **shipped:** automations kind "agent" {agentSpecId, agentPrompt, agentModel} created DISARMED; pure agentAutomationGate (missing spec / untrusted / suspicious / quarantined ⇒ schedule SUSPENDS itself; approval checkpoints ⇒ tick refused, schedule stays armed); acp_backend.runAutomation dispatches agent-kind through the SAME startAgentRun pipeline as Run ▸ (gate first, allow-list, stored trust label, P-AGENT.13 trace; lastResult carries outcome + run id); /api/automations accepts the new fields; Builder Schedule flyout (cadence interval/daily, task prompt, honest refusal for untrusted or approval-carrying specs — mirrors the runtime gate). In-process only, runs only while LUCID is open (ADR-0047 envelope preserved). 3 new tests; 154 green; typecheck fingerprint unchanged (pre-existing netdiag/dev.ts:253 only).
- **stubbed:** phase 2 webhooks (token-gated, untrusted-delimited payloads) remain design; no automation-created notification toast yet (lastResult in the Automations list is the surface); agent-kind run-now doesn't stream events.
- **next:** P-AGENT.17 history + gallery, or ADR-0143's onError edges — the roadmap's remaining public items.

**P-AGENT.17 - revision history + starter-template gallery (ADR-0145)**
- **shipped:** every save snapshots `.omp/agents/history/<id>/<updated_at>.json` (pruned to newest 20, fail-soft — a snapshot failure never fails the save); History flyout lists revisions w/ Restore (restore re-saves as current with fresh updated_at — itself versioned, so undo is undoable; trust sidecar untouched); Templates flyout lists `templates/agents/*.lucid-agent.json` (2 starters demoing v2: approval+retry research digest, branch+timeout repo triage) — only digest-valid files appear, and "Use" mints a fresh spec_id then routes through the STANDARD gated import (scanner + trust + review; curated ≠ exempt) via the new shared dev.ts gatedAgentImport; CI test re-validates every shipped template. 5 new tests; 160 green; typecheck back to the pre-existing baseline (one self-inflicted duplicate import caught + fixed).
- **stubbed:** no diff view between revisions (name/step-count summary only); template gallery is in-repo only — community submissions wait on ADR-A012 signing.
- **next:** public roadmap remainder: ADR-0143 onError edges, ADR-0142 phase-2 webhooks; enterprise connectors in lucidagentIDEaddon.

**P-CMD.1 - user-authored "/" slash commands, landed + gated (ADR-0146)**
- **shipped:** UserCommand spec/validator (name = stable id + filename, reserved tokens refused, $ARGS/$1..$9/$$ expansion), traversal-safe .omp/commands store, secret-guarded handoff (parseDraftedCommand + slashCommandCreateDraft keyed on the unique commandJson arg), triple-gated create path (validator → secret guard → Unicode scanner, all fail-closed) w/ metadata-only command_created/command_rejected EventNames (frozen contracts.ts touch acked in ADR-0146), SLASH_COMMAND_POLICY (prefix v9, regression green), slash_command_create omp tool, /command interview, autocomplete integration; 12 new tests for the pure layer. Collision cleanup for the PR: the entire session ADR block renumbered 0135-0145→0137-0145+0146 (68 refs across 32 files) because upstream #197/#199 took ADR-0135/0136; .gitignore grew .omp/agent-shares/, .omp/loops/, .omp/commands/*.json (user commands are personal data; the tracked lucid-* command dirs stay).
- **stubbed:** command edit UI is delete+recreate; skill-mode commands don't yet show an active-skill pill; the scanner leg is exercised via the import-gate seam's tests, not a dedicated live-sidecar command test.
- **next:** merge origin/master (vision + local-providers), resolve the shared-file conflicts, full verification, then PR.

**P-AGENT.16 - provider-sourced secrets: core wiring for the enterprise KMS connector (ADR-0144)**
- **shipped:** SecretProvisioning.provider {kind, ref} (closed kinds, scheme/kind consistency fail-closed, refs scanned by secret_guard + import gate); pure harness/agent/kms.ts request builder (ADR-A014 artifact shape); agent_run.resolveProviderSecrets dispatches kms fetch through the add-on seam, reads the 0600 env file, deletes BOTH artifacts immediately, injects into the child run env only — wired into one-shot, segmented, and sub-agent paths (children fetch under their OWN declarations); failed/lying fetch ⇒ run refused (no partial credentials); no refs / no connector ⇒ honest skip (vault flow unchanged); trace kind "secrets"; secrets panel shows the provider note; policy bullet extended (prefix regression green). 8 new tests incl. seam integration against a REAL fake-connector child process via LUCID_ADDON_DIR; 173 green; typecheck at the pre-existing baseline.
- **stubbed:** managed-config "require provider-sourced secrets" (org policy) remains design; only the vault provider kind exists add-on-side; parked (awaiting-approval) runs hold fetched values in process memory ≤ the 30-min TTL (documented).
- **next:** roadmap items still open: ADR-0143 onError edges, ADR-0142 phase-2 webhooks, P-AGENTFW.2/3 (collaborator's follow-ups); add-on side: AWS Secrets Manager provider (ADR-A012 order).

**P-CMD.2 - builtin /licensing walkthrough + "/" commands anywhere in the body (ADR-0148)**
- **shipped:** harness/commands/builtins.ts (builtins share the UserCommand shape/validator; user-saved commands shadow by name, deletion resurfaces) with /licensing — guided + approval-gated licensing application (discover convention → one interview round → exact per-language header plan → idempotent apply w/ SPDX-skip + shebang-aware insert + read-then-write → totals + CI check/pre-commit/LICENSE offers; vendored trees excluded loudly); expandInlineCommands (known-names-only, path/URL-immune token grammar, in-place send-mode expansion, skill strip+activate, single-pass non-recursive) wired into send() with start-anchored P-CMD.1 args semantics preserved; slashTokenBeforeCaret drives the autocomplete at the caret anywhere in the body and applySlash now replaces only that token. BONUS: cleared the 11 pre-existing server-tsconfig diagnostics (netdiag ×9, oauth stdin ×2) — bun run typecheck green across ALL THREE configs. 13 new tests; 32 green (commands+netdiag); renderer+root tsc clean.
- **stubbed:** builtins ship one command; /licensing applies headers via the chat agent's tools (no dedicated header engine — deliberate: the walkthrough adapts to any language mix); bundled-skill activation from the mid-body menu keeps surrounding prose but sends nothing extra.
- **next:** more builtins as they earn their keep (/changelog, /release-notes candidates); P-CMD.3 command edit UI.

**P-MARKET.1 - the Plugin Marketplace popup (ADR-0158)**
- **shipped:** desktop/renderer/marketplace.ts (curated static registry - Excalidraw pinned first per requirement, then Obsidian's "3rd Party Integrations" top-10 by community downloads: Git/Remotely Save/Copilot/Importer/BRAT/Advanced URI/Zotero/Paste-URL/LanguageTool/Readwise - with sortMarket/filterMarket/fmtDownloads + pure HTML builders); openMarketplace() scrim-modal on the About conventions (X/backdrop/Escape, live search, rows only window.open their GitHub repo); #railMarket rail button + `market` icon + palette action; .mkt-* styles; 14 tests + demo-P-MARKET.1 green; tsc clean; no new suite failures.
- **stubbed:** catalog is static (no fetch, no install - deliberate fail-closed posture); download counts only where verified (nulls render no badge); Preview-panel visual check written to .omp/tmp/market_preview.html but not screenshot-verified in-app.
- **next:** P-MARKET.2 - BRAT-style install-from-GitHub-URL through the agent-template import gate seam (digest + scanner + trust + approval); Excalidraw whiteboard embedded in the sandboxed Preview panel; registry refresh cadence.

**P-SANDBOX.1 - the runtime sandbox seam: declared caps enforced at the omp spawn (ADR-0157/0159)**
- **shipped:** harness/runs/sandbox_exec.ts (SandboxBackend bwrap|noop, pure resolveBackend, wrapForProfile = the single fail-closed decision point: managed require-isolation unsatisfiable => refuse; canExec:false => refuse-exec; canNetwork:false on a passthrough => refuse, under bwrap => --unshare-net total deny - the chooseProfile suspicious downgrade is finally REAL); wired at BOTH spawns (lucid_acp execGated: refused resolution = exit 1 pre-spawn like the scanner preflight + loud sandboxDisclosure() passthrough line; acp_backend resolveSandboxPlan: managed-require w/o backend spawns with EVERY exec permission denied + audited via existing SecurityEvent - no new EventNames, P-SANDBOX.3 owns those); security.exec.requireIsolation managed knob (+ GPO ExecRequireIsolation), tighten-only. 16+4 new tests (801 green), tsc x3 clean, standalone launcher still compiles, demo-P-SANDBOX.1 green. Merge housekeeping: local marketplace ADR renumbered 0156->0158 (upstream took 0156/0157).
- **stubbed:** bwrap mount plan binds $HOME rw (fs containment stays omp --isolate's; network is the v1 boundary); seccomp deferred (needs a compiled BPF fd); agent_run.ts spawnGatedOmp not yet routed through the seam; macOS/Windows have NO isolating backend (disclosed passthrough) until P-SANDBOX.4.
- **next:** P-SANDBOX.2 - egress_proxy.ts (loopback DNS + CONNECT proxy consulting egressDecisionDetailed) for canNetwork:true profiles; the increment that directly answers the DNS-TXT exfil.

**P-REPORT.9 - multi-repo remote fetch + PR aggregation for the Engineering Report (ADR-0162)**
- **shipped:** harness/brief/repo_activity.ts (PURE: parseRemoteUrl/parseCommits/parsePrJson/buildRepoActivity + renderRepoActivityAnnex → the "Annex C - Cross-repo activity" markdown; clean() neutralizes untrusted commit/PR text - HTML escape + fence-breakout strip + pipe escape + cap, invariant #5); desktop/repo_collect.ts (fetch-only `git fetch --prune --no-tags`, for-each-ref branch enumeration capped at 8 by recency w/ origin-HEAD filtered, per-branch git log, window diff totals, gh PR list opt-in behind ghAvailable cache; listReportRepos/addReportRepo/collectRepoActivity - first-party spawn like cloneRepo, fail-soft + timeouts); /api/brief POST path + /api/report/repos(/add) endpoints; settings_store reportRepos; bridge reportRepos/addReportRepo + engineeringBrief(repos); Reports-panel repo picker (checkable rows + remote-URL verify surface + per-repo PR toggle gated on GitHub+gh-auth + Add-repo path/URL + Fetch-latest checkbox) + .rp-repo* styles. 25 tests + demo-P-REPORT.9 green; harness 826 pass/0 fail; verified live against real GitHub/GitLab/Azure-DevOps remotes.
- **stubbed:** fetch-only (no pull/merge - deliberate); brief NARRATIVE still primary-repo DECISIONS/PROGRESS (only the annex is cross-repo); PRs GitHub-only (GitLab MRs / Azure DevOps detected + skipped-with-reason, not supported); no per-fetch formal audit event yet (fetch status is surfaced in the annex, reach-out is loopback first-party).
- **next:** P-REPORT.10 candidates - GitLab/Azure PR providers; a formal SecurityEvent per fetch/PR reach-out; optional pull (ff-only) as an explicit opt-in; cross-repo narrative synthesis.

**P-REPORT.10 - a formal SecurityEvent per fetch / PR reach-out (ADR-0164)**
- **shipped:** closes the P-REPORT.9 stub "no per-fetch formal audit event yet". The report collector's git fetch / gh PR list are FIRST-PARTY reach-outs that bypass the agent tool gate by design, so they left no audit trace. New PURE `reachoutAuditEvents(ref, {fetched, fetchOk, prStatus})` in `desktop/repo_collect.ts` maps each ACTUAL reach-out to a canonical desktop `SecurityEvent` (via the existing `emitSecurityEvent` seam / ADR-0069): `category:"egress"`, `decision:"allow"`, `severity:"info"`, `type` `report_fetch`/`report_pr_list`, `tool` `git`/`gh`; a fetch event fires iff a fetch was attempted, a PR event iff gh actually ran (`ok`/`error`) - the `skipped-*` statuses emit NOTHING. `collectRepoActivity` gains an injectable `emit` param (default the real dispatcher) and emits once per repo from the one site that already holds `ref`+`prStatus`. Reuses the SecurityEvent seam - adds NO contracts.ts EventName (invariant #8), like P-SANDBOX.1.
- **verified:** `bun test desktop` 910 pass / 5 fail (post-merge; 5 pre-existing `fs_browse` Windows env), `bun test harness` 843 pass / 1 fail (pre-existing Windows path-sep in the P-THEME.1 theme-asset test; harness untouched); +13 new `desktop/repo_collect.test.ts` (builder matrix incl. no-credential-leak from a token-bearing URL, + OFFLINE wiring: a temp repo with a LOCAL bare origin fires exactly one `report_fetch`, `fetch:false` fires none); `demo-P-REPORT.10` green (LIVE offline reach-out → real dispatcher → OCSF Detection Finding class_uid 2004); `demo-P-REPORT.9` still green; root+desktop tsc clean for touched files.
- **stubbed:** METADATA-ONLY - the reason carries the remote HOST (credential-free), never the raw URL; a local/unparsed remote logs `(local/unparsed remote)` (fail-toward-recording). `decision` is always `allow` (no managed "no report egress" clamp exists yet). Non-GitHub PR providers still `skipped-nonhub` (no reach-out, no event).
- **next:** P-REPORT.11 - GitLab/Azure PR providers (each a real reach-out → its own audited event); an in-app "report reach-outs" view over `audit.recent()`; an optional managed clamp that blocks report egress (would emit `decision:"block"`).

**P-TOOLFAIL.2 - failed tool calls collapse into a toolbox badge with Tool Call Actions (ADR-0163)**
- **shipped:** desktop/renderer/toolfail_group.ts (pure builders): consecutive failed/didn't-run tool calls = ONE small red toolbox badge (new icons.ts glyph) + count; click expands the "Tool Call Actions" list - per action the tool, reason, COMMAND ATTEMPTED (`toolFailureCommand`: rawInput exec-key set, `$ …` title fallback) and full multi-line error (`toolFailureDetail`, cap 2000); block ChatEvent carries command/detail (acp_backend + bridge in sync); tool_failure.ts converted any→unknown+guards; group ends when anything else lands in the thread; hostile output escaped (tested); tooltip keeps the ADR-0093 "not a security block" line. 28 tests + demo-P-TOOLFAIL.2 green; tsc clean; desktop suite 1072 pass / 5 pre-existing fs_browse (Windows) fails only.
- **stubbed:** no packaged-Electron visual pass yet (pure-builder tests + demo cover the HTML contract); group persistence across session reload not attempted (chips were never persisted either).
- **next:** P-SANDBOX.2 (egress_proxy.ts loopback DNS + CONNECT proxy, ADR-0157 - in flight, baseline green); model-picker favorite stars (user-queued separate increment).

**P-FAV.1 - model-picker favorite stars (ADR-0165)**
- **shipped:** desktop/renderer/model_favorites.ts (pure: parseFavs defensive vs corrupted storage, toggleFav w/ oldest-eviction at MAX_FAVS=24, starredOf in catalog order w/ stale-star survival) + star button on every selectable row (both pickers) + a pinned gold "Favorites" pseudo-section above the families (rows stay in their family too; collapses via the same data-fam-toggle mechanics); starring never selects (data-fav checked before data-val); P-PERF.5 memo key includes favs. 8 tests + demo-P-FAV.1 green; tsc clean; desktop suite 905/5 pre-existing fs_browse only.
- **stubbed:** packaged-Electron visual pass (shared debt w/ ADR-0163); no cross-device sync of stars (deliberate - local UI preference tier).
- **next:** P-SANDBOX.2 - egress_proxy.ts loopback DNS + CONNECT proxy (ADR-0157; baseline green, design scoped); P-SANDBOX.3 contracts increment after.

**P-SANDBOX.2 - mediated subprocess egress: the loopback DNS + CONNECT proxy (ADR-0166)**
- **shipped:** harness/runs/egress_proxy.ts - pure `decideEgress` keystone (ONLY an explicit allow passes; prompt/foreign-ccTLD/IP-literal/unparseable/thrown all DENY - fail-closed) reusing `egressDecisionDetailed` (the agent's own browser/web brain, so subprocess egress obeys the same P-NETWL whitelist + P-ENT.1 ceiling + P-NETWL.5 posture); a real UDP DNS forwarder (denied query → REFUSED w/o contacting the upstream, allowed → forwarded+relayed) + TCP CONNECT proxy (deny→403, allow→tunnel) + start/stop lifecycle + observable event log + `:53`-then-ephemeral graceful bind. sandbox_exec.ts `SandboxCtx.proxy` → bwrap binds resolv.conf (when privileged :53) + sets HTTP(S)_PROXY; `canNetwork:true` + no proxy now fails closed to `--unshare-net`. Wired at BOTH omp spawns (lucid_acp `execGated` injectable proxyStart; acp_backend `resolveSandboxPlan` async + ACPClient per-child env overlay). 34 tests (egress_proxy + updated sandbox_exec) + demo-P-SANDBOX.2 green; P-SANDBOX.1 demo/test updated to the post-.2 truth.
- **stubbed:** privileged in-namespace :53 bind + raw-IP-socket slirp funnelling = P-SANDBOX.4 (until then a non-:53 host degrades to HTTP(S)-only mediation, raw-IP sockets dropped by --unshare-net); the util-omp spawn stays unsandboxed (matches .1 scope).
- **next:** P-SANDBOX.3 - contracts.ts EventName additions (dns_query_blocked / subprocess_egress_blocked) + Security-panel surfacing + the LIVE kill-the-proxy fail-closed regression test (mirrors kill-the-sidecar).

**P-SANDBOX.3 - mediated-egress audit trail: blocked subprocess reach-outs become events (ADR-0167)**
- **shipped:** harness/runs/egress_proxy.ts pure `egressBlockAudit(ev)` (DENY → neutral audit fields type=dns_query_blocked/subprocess_egress_blocked, host, reason; ALLOW → null) + `ensureEgressProxy` onEvent; desktop/egress_audit.ts new `egressAuditSink(emit?)` - a host-DEDUPED sink mapping a blocked reach-out to a canonical `egress` SecurityEvent (block/high) on the SAME audit/OCSF pipeline P-REPORT.10 uses (injectable emit for tests). Wired at BOTH omp spawns (acp_backend per-session sink + lucid_acp per-launcher sink). 22 tests (egress_proxy audit cases + egress_audit.test.ts: mapping, allowed→nothing, 500x dedupe, throwing-emit swallowed, end-to-end proxy→one event, kill-the-proxy) + demo-P-SANDBOX.3 green; tsc + license clean.
- **stubbed:** NO new contracts.ts EventName (reused SecurityEvent free `type` string per P-SANDBOX.1/P-REPORT.10 precedent - frozen EVENT_NAMES untouched, inv #8 not exercised); audit-only channel (not an approvable recordBlock live-block); any richer per-event Security-panel view is a UI follow-up.
- **next:** P-SANDBOX.4 - macOS Seatbelt (sandbox-exec) + Windows AppContainer backends + slirp4netns-style raw-socket forwarding (so a socket ignoring HTTP_PROXY is funnelled through the proxy, not merely dropped by --unshare-net) + the privileged in-namespace :53 bind for full DNS steering.

**P-SANDBOX.4 - the macOS Seatbelt backend: runtime containment lands on macOS (ADR-0168)**
- **shipped:** harness/runs/sandbox_exec.ts SeatbeltBackend (sandbox-exec, isolates:true) + pure seatbeltProfile(caps,ctx) with the SAME three network states as bwrap: network-off → (deny network*) + deny mDNSResponder mach-lookup (DNS truly cut); mediated → egress CONFINED TO LOOPBACK ((deny network-outbound)+(allow remote ip localhost:*)) so a raw-IP socket ignoring HTTP_PROXY is kernel-DENIED (better than bwrap's --unshare-net drop) + HTTP(S)_PROXY set; no-proxy → fail-closed total deny. resolveBackend darwin→Seatbelt when sandbox-exec present (else disclosed/managed-fail-closed); disclosure + require-isolation reasons refreshed. 26 sandbox_exec tests (Seatbelt resolution/profiles/loopback-confine/DNS-cut/argv/require-isolation/downgrade) + demo-P-SANDBOX.4 green; tsc + license clean; worktree-isolated (feat/p-sandbox-4-seatbelt).
- **stubbed:** SPLIT the ADR-0157 ".4 (later)" catch-all - Windows AppContainer needs native Win32 (CreateProcess + SECURITY_CAPABILITIES) so it's its own future increment+ADR (Windows stays disclosed/fail-closed as in .1); Linux slirp4netns raw-socket forwarding is its own follow-up (Seatbelt already achieves loopback-confinement on macOS). Residual: macOS mediated profile leaves getaddrinfo→mDNSResponder reachable (DNS-TXT name lookup can resolve), full close needs resolver interception (macOS analogue of Linux privileged :53).
- **next:** Windows AppContainer backend (native surface, own ADR) OR Linux slirp4netns raw-socket funnel + privileged in-namespace :53 for full DNS steering.

**P-SANDBOX.5 - the runtime-execution boundary, made visible in the Security panel (ADR-0169)**
- **shipped:** desktop/sandbox_status.ts (GUI-owned store: setSandboxState posture + recordEgressBlockView bounded newest-first ring of refused reach-outs + sandboxStatus() defensive copy) + desktop/renderer/sandbox_panel.ts (PURE builder: green isolated / amber disclosed / red fail-closed posture, AUTO-OPENS when not isolated, refused-reach-out list + count, hostile text escaped). Wired: acp_backend.resolveSandboxPlan setSandboxState in every branch; egress_audit sink also feeds recordEgressBlockView (host-deduped, injectable recordView); dev.ts /api/security merges sandbox beside live; bridge.ts view types; securityHtml renders it up top; .sbx-* CSS. 15 tests (store + panel builder) + demo-P-SANDBOX.5 green; all 3 tsconfigs clean; /app.js bundles with the new import.
- **stubbed:** READ-ONLY visibility - no new EventName (inv #8) / trust label (inv #7) / enforcement; never weakens fail-closed (best-effort store, throwing recordView swallowed). Live pixel-screenshot NOT taken (preview MCP targets the primary checkout where a concurrent agent works, not this worktree; /api/security token gate + need-for-omp-spawn block a headless capture) - rendering pinned by pure-builder unit tests + demo + successful bundle instead.
- **next:** Windows AppContainer backend (native Win32, own ADR) OR Linux slirp4netns raw-socket funnel + privileged in-namespace :53; optionally a per-egress-block relative timestamp / "approve host" affordance in the panel.
**P-SECACK.1 - reviewed security rows leave the active view + prompt-bar clipboard menu (ADR-0170)**
- **shipped:** desktop/security_ack.ts GUI-owned append-only review-ack ledger (~/.omp/lucid-sec-acks.jsonl; pure corrupt-tolerant foldAcks, idempotent ackArtifact w/ injectable audit emit, MONOTONE findings-seen watermark; releases NOTHING - provenance DB stays READ_ONLY) + pure renderer split (sec_review.ts splitReviewed/freshFindings) feeding chips, rail badge, and per-row "Reviewed" / "Mark all reviewed" / "Mark seen" actions with a collapsed "reviewed · audit kept" shelf; REMOVED the fake Approval-queue Approve/Deny (toast-only, never drained); POST /api/security/ack (server-side watermark total); ctxmenu.ts right-click Cut/Copy/Paste/Select-all for all text fields (password fields never offer Cut/Copy; image paste rides the P-VISION.1 staging path). 24 tests + demo-P-SECACK.1 green; typecheck:desktop(+server) + license clean.
- **stubbed:** no OCSF event for the findings watermark (view preference, not a decision); reviewed-shelf rows have no un-ack (deliberate - the ledger is append-only; re-surfacing is a future increment if ever needed); packaged-Electron visual pass (shared ADR-0163 debt).
- **next:** P-RESUME.1 - persist + rehydrate thinking/tool-call/tool-failure steps across session switches (user-reported; scouted: sessions.ts filters .jsonl to user/assistant text only, streaming steps never persisted).

**P-RESUME.1 - a resumed session keeps its thinking + tool-call history (ADR-0171)**
- **shipped:** desktop/session_steps.ts GUI-owned per-session activity sidecar (~/.omp/lucid-steps/<sid>.jsonl; omp's transcript NEVER touched - invariant #1) teed at the ONE ChatEvent funnel (Backend.emit): thinking buffered to one record/turn, tool steps, and P-TOOLFAIL failures (real quarantines excluded - security ledger owns them); user-turn anchoring w/ resume-time forward-only re-sync (outside/TUI turns can't re-attach old activity); /api/session merges restored groups; renderThread anchors collapsed .reasoning/.thoughts "restored" blocks (steps_restore.ts pure builders, everything esc()'d) under the right user message, tail-trim + trailing-turn safe; session delete removes the sidecar. 24 new tests + demo-P-RESUME.1 green; full `bun test desktop` 1142/5 (the 5 = pre-existing Windows fs_browse set, ADR-0165); typecheck + license clean.
- **stubbed:** tool `code` payloads not persisted (bounded sidecar - expandable code/diff previews are live-only); within-turn thinking/tool interleaving not preserved (matches live layout); pre-increment sessions have no sidecar to restore.
- **next:** in-app visual pass of restored blocks + the P-SECACK.1 ack UI in packaged Electron (shared ADR-0163 debt); Windows AppContainer backend (native Win32, own ADR) remains queued from the sandbox epic.

**P-SANDBOX.6 - the Windows AppContainer backend seam + helper contract (ADR-0172)**
- **shipped:** harness/runs/sandbox_exec.ts AppContainerBackend (isolates:true; available()=lucid-appcontainer on PATH) + pure appContainerArgs(caps,ctx) — Windows has NO OS argv-wrapper for AppContainer, so a thin first-party `lucid-appcontainer <flags> -- <argv>` helper fits the seam's wrap→{cmd,args,env} contract. Same 3 network states as bwrap/Seatbelt: network-off → --deny-network; mediated → --loopback-only (raw-IP sockets WFP-denied) + HTTP(S)_PROXY; no-proxy → fail-closed --deny-network; --workspace/--home bind rw. resolveBackend win32→AppContainer when helper present (else disclosed/managed-fail-closed); disclosure + require reasons refreshed. 33 sandbox_exec tests (resolution with/without helper, require-isolation, flag states, loopback-confine, argv, available() gating, downgrade) + demo-P-SANDBOX.6 green; tsc + license clean; worktree-isolated.
- **stubbed:** the native helper is NOT bundled yet, so on real Windows available()=false ⇒ disclosed passthrough (behavior UNCHANGED from .1-.5 until it ships — fail-safe by construction). Rejected Bun-FFI-direct (breaks the seam's argv-plan contract) + Windows-Sandbox/Job-Objects (heavyweight / no net isolation); chose the helper approach.
- **next:** P-SANDBOX.7 — BUILD + bundle the native lucid-appcontainer helper (AppContainer SID + PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES + WFP egress rules honoring --deny-network/--loopback-only) + packaging/signing + a Windows integration smoke (the first native-code surface, its own plan). Also still open: Linux slirp4netns raw-socket funnel + privileged in-namespace :53.

**P-SANDBOX.7 - the native Windows AppContainer helper: lucid-appcontainer, BUILT + VERIFIED (ADR-0173)**
- **shipped:** tools/appcontainer/lucid_appcontainer.ts - a TypeScript helper compiled to a standalone lucid-appcontainer.exe via `bun build --compile` (make build-appcontainer, --target=bun-windows-x64) that uses bun:ffi for the real Win32: derive/create an AppContainer SID, SECURITY_CAPABILITIES with an EMPTY capability set (no internetClient ⇒ no network = --deny-network), CreateProcessW inside the AppContainer via PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, wait + propagate exit. Resolves ADR-0172's native-surface tension WITHOUT a C/Rust/Python source tree (inv #2 intact - Win32 via FFI from TS). Fail-closed: bad args → exit 2, un-enforceable/loopback/non-Windows/FFI-failure → exit 3, NEVER a passthrough. VERIFIED live on Windows 10: benign curl runs (exit 0), networked curl BLOCKED (http_code=000, exit 28) while the same curl outside returns 200; the compiled .exe reproduces the block. 11 pure parser tests + demo-P-SANDBOX.7 (live block on Windows, fail-closed refusal off-Windows) green.
- **stubbed:** deliberately NOT bundled/activated (not on PATH, not in packaging) - the common trusted-local omp session is canNetwork:true → --loopback-only (mediated), which needs an AppContainer loopback exemption (CheckNetIsolation) + per-child WFP rules = P-SANDBOX.7b; activating a deny-network-only helper would refuse the common session. Until .7b, Windows stays the disclosed passthrough (unchanged).
- **next:** P-SANDBOX.7b - implement --loopback-only (WFP egress rules + loopback exemption so the child reaches only the mediated proxy) + code-sign + bundle the .exe + let resolveBackend find it (activation). Also still open: Linux slirp4netns raw-socket funnel + privileged in-namespace :53.

**P-SKILL.4 - the Agent Skill directory + per-skill management menu (ADR-0097)**
- **shipped:** the four existing skill surfaces (bundled INSTALLED_SKILLS, omp discoverSkills, scan-gated import, curated .agents) now share ONE governed directory + management menu. New PURE `desktop/skills_gov.ts` (renderer-safe, no node: SkillRoot closed set, skillKey, rootTrust/rootRemovable, trustEnableable, the single `effectiveEnabled` decision, readinessChecklist); `desktop/skills_scan_log.ts` (per-user `~/.omp/lucid-skill-scans.jsonl` verdict ledger, corrupt-tolerant fold, latest-wins); `skills_data.ts` widened (classify root by path, attach trust from the ledger + invocation + removable) + confined inspect/rescan/remove (rescan reuses the fail-closed gate; recordBlock injectable for hermetic tests); renderer `skills.ts` enable/disable (localStorage `lucid.skill-enabled`; bundled delivery + `/skill:` picker skip disabled/flagged); pure `skills_dir.ts` builder (grouped rows, trust pills, locked flagged toggle, body-as-DATA inspect, all esc()'d); a Skills rail fly-out in app.ts (mutually exclusive, per-row menu -> inspect/rescan/remove) + 3 dev.ts routes + bridge view types + `.skdir` CSS.
- **verified:** `bun test desktop` 1198 pass / 5 fail (only the pre-existing fs_browse Windows path-sep fails; +44 new tests: gov trust/enable keystone, scan-verdict fold, skills_data classify/rescan-fail-closed/remove-refuses-immutable, pure-builder escaping+locked-flagged, enable/disable + bundled filter); `demo-P-SKILL.4` green (LIVE: real discoverSkills classifies project/untrusted vs agents/trusted, real scanner re-scan quarantines a bidi/zero-width skill + locks it off, remove refuses .agents + deletes a project skill); all 3 tsconfigs clean; renderer bundles; license headers present.
- **stubbed:** enable/disable is a renderer-local UI preference (localStorage, the ADR-preferred tier) - a user can still type `/skill:<name>` raw (omp resolves it), LUCID just won't OFFER a disabled one; the `registry` source root is declared but empty (reserved for ADR-0098's reader); bundled skills aren't re-scannable (frozen inline, no file); no new EventName/contract (governance reuses recordBlock; inv #8 untouched); packaged-Electron visual pass deferred (shared ADR-0163 debt) - rendering pinned by pure-builder tests + the successful bundle.
- **next:** P-SKILLREG.1 (ADR-0098) - the enterprise registry reader plugging in as the `registry` source (fetch -> verify signature -> scan-gate -> install -> appears as a normal row); or P-SKILL.5 (ADR-0101) Skill Studio drafting scanned skills into this directory.

**P-SKILLREG.1 - the enterprise Agent Skills registry READER seam (ADR-0098)**
- **shipped:** the public/source-available reader half of the enterprise registry (server + Terraform runbooks stay private add-on IP per ADR-A012/A013). New `desktop/skills_registry.ts`: `installRegistrySkill(artifact)` runs fetch(private) -> **verify Ed25519 signature** (node:crypto, against trusted keys from `LUCID_SKILL_REGISTRY_KEYS` env / `~/.omp/lucid-registry-keys.json`, base64 SPKI DER) -> **fail-closed scan-gate** (reuses scanAndDecide over the SKILL.md + every resource) -> **confined install** into `.omp/skills/<name>/` + a `.lucid-registry.json` provenance marker; `verifyArtifactSignature` + `loadTrustedKeys` exported. `skills_gov.ts` gained the shared `REGISTRY_MARKER` const + made `registry` removable; `skills_data.ts` re-classifies a marked install to the `registry` root (try-read marker, not existsSync-then-read), shows its provenance, and confines uninstall to `.omp/skills`; `dev.ts` `/api/skills/registry/install` route is the seam the private connector POSTs to; README registry bullet flipped to "reader seam ships now".
- **verified:** `bun test desktop` 1232 pass / 5 fail (only the pre-existing fs_browse Windows path-sep fails; +new skills_registry tests: signature verify pass/unsigned/no-keys/tampered/wrong-key, install fail-closed on unsigned+bad-sig+no-keys+scan-flagged+dead-scanner+bad-name writing NOTHING, resource-path traversal confined, clean+signed installs untrusted, directory shows it as registry/untrusted/removable + uninstalls); `demo-P-SKILLREG.1` green (LIVE: real Ed25519 keypair + real scanner - signed+clean installs as an untrusted registry row, unsigned + untrusted-key blocked at signature, validly-signed-but-poisoned blocked at the scan gate, 2 findings); all 3 tsconfigs clean; renderer bundles; license headers present.
- **stubbed:** fetch/OCI-pull, Cosign/SLSA packaging, the registry server, and the per-provider Terraform runbooks (AWS/Azure/GCP/OCI/IBM + VMware/Nutanix/ONTAP/KVM + IL5 partitions) are private add-on IP (ADR-A012/A013) - the public repo ships ONLY the verify->scan->install reader; signature covers the SKILL.md body (resources are independently scan-gated + path-confined, not yet in a signed SLSA manifest); no renderer "Install from registry" button (needs a registry URL/config that is private) - the HTTP route is the seam; keystone #2 upheld (installed skills are untrusted, a human re-scan certifies); no new EventName/contract (reuses recordBlock).
- **next:** P-SKILL.5 (ADR-0101) Skill Studio - analyze a day/week of work and draft scanned, reviewable Agent Skills into this directory; or P-SKILLREG.2 (ADR-0102) the publish seam (the write counterpart to this reader).

**P-SKILL.5 - Skill Studio: analyze recent work, draft + gate skills (ADR-0101)**
- **shipped:** `desktop/skill_studio.ts` - the gather -> analyze -> draft -> GATE -> codify flow. `gatherWorkDigest(window)` assembles recent sessions (user msgs already preamble-stripped via sessionMessages), AI-LOC by repo (aiLocSummary rows), /goal loop outcomes (readRunLog), and the most-used model (usageLedger().models[0].model), each fail-soft; `buildWorkDigest` frames it as delimited UNTRUSTED_CONTENT DATA (#5); `analyzeWork(window,{gather,complete})` sends it to backend.complete with the digest's model and `parseCandidates` DEFENSIVELY parses the untrusted model JSON (bare array / {candidates} / ```json fence; slugs names, drops thin, caps 6, never throws); `buildSkillMd` emits YAML-safe frontmatter (strips model frontmatter, one-line quoted desc); `codifyCandidate` runs ONE reviewed draft through the existing importSkill fail-closed gate. Seam: `/api/skill-studio/analyze` + `/draft` routes (analyze injects gatherWorkDigest + backend.complete), bridge methods + views, and a Skill Studio scrim modal launched from the Skills directory (window selector -> Analyze -> review/edit candidate cards -> Codify), pure `renderStudioCandidate` builder (escapes untrusted model output), `.sk-studio`/`.sk-cand` CSS. Realizes the deferred P-SKILL.2 (model-assisted) + P-SKILL.3 (session-derived).
- **verified:** `bun test desktop` 1258 pass / 5 fail (only the pre-existing fs_browse Windows path-sep fails; +new skill_studio tests: parseCandidates object/array/fenced/slug/drop-thin/cap/garbage-never-throws, delimited digest, YAML-safe SKILL.md build, analyzeWork threads the model + tolerates junk output; renderStudioCandidate escaping); `demo-P-SKILL.5` green (LIVE: injected synthetic week + fake model, REAL scanner - analyze writes NOTHING, the clean candidate codifies to .omp/skills, a poisoned candidate with hidden bidi/zero-width is BLOCKED at the gate, 2 findings); all 3 tsconfigs clean; renderer bundles; license headers present.
- **stubbed:** the model call + work-gather are injectable (analyze uses backend.complete + gatherWorkDigest in prod; tests/demo inject a fake model - no live model needed in CI); codified drafts land as PROJECT skills (importSkill), shown untrusted until re-scanned (keystone #2: agent-drafted skills are never auto-trusted; the user reviews/edits before codify); no separate `studio` source root (kept the reused import path); the `skill_drafted` EventName is deferred to a contracts increment (inv #8 untouched - governance reuses recordBlock); packaged-Electron visual pass deferred (shared ADR-0163 debt) - rendering pinned by pure-builder tests + the successful bundle.
- **next:** P-SKILLREG.2 (ADR-0102) the skill publish seam - a RegistryPublisher interface + default local publisher (the write counterpart to P-SKILLREG.1's reader), egress-gated; or P-KB.1 (ADR-0099) the compiled KB sibling to the vector spine.

**P-SKILLREG.2 - the skill publish seam: Local Skills Registry + remote-push spike (ADR-0102)**
- **shipped:** the WRITE counterpart to P-SKILLREG.1's reader - public ships the seam + local publisher only (remote cloud-OCI / custom-git publishers are private add-on IP per ADR-A014/A015). New `desktop/skill_publish.ts` mirrors the SIEM Sink/dispatcher (ADR-0069): the `RegistryPublisher` interface + `SkillArtifact` (content-addressed by sha256 digest, optionally Ed25519-signed) + `PublishReceipt` + `buildSkillArtifact(sign?)`; the default `LocalRegistryPublisher` writes `<root>/<name>/<version>/{SKILL.md,artifact.json,res/}` (pathWithin-confined, fail-safe - bad name/version or write error -> failed receipt, never a throw); `loadFromLocalRegistry` reads an artifact back as a reader-installable RegistrySkillArtifact (round-trip to P-SKILLREG.1); the fail-safe `PublishDispatcher` (a throwing publisher yields a failed receipt, others still run; a named target with no registered publisher is a clean no-op); `registerPublisher()` (the private add-on's remotes register here) + `publishersFor()` reading the new `ManagedSkillRegistry` managed-config (localRoot/enabled/remotes). `dev.ts` `/api/skills/publish` route (reads a codified skill -> buildSkillArtifact -> dispatch); README push bullet flipped to "seam ships now".
- **verified:** `bun test desktop` 1269 pass / 5 fail (only the pre-existing fs_browse Windows path-sep fails; +new skill_publish tests: digest stability + optional signing, confined local write + resource-traversal-refused + fail-safe on bad input, load round-trip incl. latest-version + null-on-missing, dispatcher throwing->failed-receipt + missing-target->no-op, publishersFor local-only/disabled/register-remote); `demo-P-SKILLREG.2` green (LIVE: real Ed25519 - sign+publish a codified skill to the local registry, a declared remote target no-ops fail-safe, then load it back and install through the P-SKILLREG.1 reader (real scan gate) into an untrusted `registry` directory row); all 3 tsconfigs clean; renderer bundles; license headers present.
- **stubbed:** remote publishers (AWS ECR/CodeArtifact, Azure ACR, GCP AR, OCI CR, IBM ICR; Enterprise GitLab/GitHub/Azure DevOps) are private add-on IP - they implement the SAME interface + register via registerPublisher; publish is fail-SAFE not fail-open (a dead/missing publisher never throws into a turn), and establishes NO trust (verify-signature + scan-gate still run on the READ side; keystone #2 holds); local signing is optional (an unsigned local artifact stores but isn't reader-installable until a trusted key signs it); the `/api/skills/publish` route has no public UI caller yet (the seam mirrors P-SKILLREG.1's install route); `skill_published` EventName deferred to a contracts increment (inv #8 untouched); remote pushes will route through egress_policy in the add-on.
- **next:** P-KB.1 (ADR-0099) the compiled KB (OpenKB-style summary/concept/entity pages) as a TS+DuckDB sibling to the vector RAG spine; or a UI pass surfacing Publish + the enterprise registry in the Skills directory once remote targets exist.

**P-KB.1 - the compiled KB (OpenKB-style), a sibling to the vector RAG spine (ADR-0099)**
- **shipped:** a NEW `harness/kb/` subsystem (TypeScript + DuckDB, no Python - inv #2) that COMPILES documents into a persistent page graph, alongside (not replacing) the vector store. `harness/kb/migrations/0011_kb_graph.sql` - the frozen schema (inv #10): kb_documents (source registry + status compiled|quarantined|stale) · kb_pages (summary|concept|entity|source, body_md, trust_label) · kb_links (PersonalLink-shaped wikilinks) · kb_page_sources (citation trail) · kb_changelog (append-only sync log) · kb_page_embeddings (frozen now, populated by P-KB.2). `kb/store.ts` (KbGraphStore over Db.open + the migration set, typed CRUD, Snowflake ids); `kb/compiler.ts` (COMPILE_SYSTEM prompt wrapping the doc as delimited DATA + `parseCompiled` - defensive: validates kind/slug/title/body, dedupes slugs, keeps only real non-self links, caps, never throws); `kb/ingest.ts` - the fail-closed pipeline: scan the SOURCE -> compile (injected backend.complete) -> RE-SCAN every derived page -> store, with changelog + onBlock audit hook.
- **verified:** `bun test harness` 888 pass / 1 fail (only the pre-existing lucid_acp Windows path-sep fail; +13 new kb tests: store migration+CRUD, parseCompiled defensive parse, ingest clean-compiles / poisoned-source-quarantined-never-compiled / dead-scanner-fail-closed / poisoned-derived-page-re-scanned-quarantined-links-dropped); `demo-P-KB.1` green (LIVE real Unicode scanner + temp DuckDB, injected model: a clean doc -> 3-page graph [concept/entity/summary] + 2 links all untrusted, a bidi/zero-width source quarantined at the gate never compiled, a model page hiding bidi/zero-width re-scanned + quarantined never stored with its link dropped); all 3 tsconfigs clean.
- **stubbed:** the model call is injectable (ingest uses backend.complete + usageLedger's most-used model in the dev.ts wiring; tests/demo inject a fake - no live model in CI); TEXT input only this round (PDF parse via ingestPdf/unpdf + the PageIndex long-doc tree are reuse/refinement, deferred); page embeddings table exists but ingest doesn't populate it (hybrid retrieval is P-KB.2); single-compile, no cross-run page diff/merge yet (the changelog makes re-runs auditable); keystone #2 upheld (derived pages stored `untrusted`, never auto-trusted); new EventNames (kb_document_ingested/kb_page_compiled/kb_page_quarantined) named in the ADR but DEFERRED to a contracts increment (inv #8 untouched); no renderer surface + no dev.ts route yet (harness core first).
- **next:** P-KB.2 (ADR-0100) the hybrid retrieval router (vector | compiled | both) + sync + the ADR-0075 graph-render reuse over kb_links; then the desktop wiring (ingest route + backend.complete + a Knowledge panel view).

**P-KB.2 - the hybrid retrieval router (vector | compiled | both) + kept-in-sync (ADR-0100)**
- **shipped:** `harness/kb/retrieve.ts` - one entry `retrieveKnowledge(query, {mode})`: `vector` -> the existing cosine retrieval (ADR-0058, unchanged); `compiled` -> VECTORLESS structural retrieval over kb_pages (`scoreCompiledPages` - keyword relevance title 3x/body 1x + link-neighbor expansion so a hit's linked concept/entity pages surface); `hybrid` (default) -> run both, `normalizeScores` each store into [0,1], merge + dedupe by citation, top-k, `wrapKnowledge` in UNTRUSTED_START/END with a store+citation label per hit (page:slug | source_path#ordinal). `harness/kb/sync.ts` - `syncDocument` re-runs the P-KB.1 GATED path: idempotent no-op on an unchanged sha256; a changed source re-compiles, appends a kb_changelog `resynced` entry, and flags a CONTRADICTION (a slug whose body changed) for review with the prior page RETAINED (never silent overwrite). Added `KbGraphStore.getDocumentBySourcePath` for the sha idempotency check. Pure READ router + gated-path-only writes; no schema change, no new trust value.
- **verified:** `bun test harness` 900 pass / 4 skip / 1 fail (only the pre-existing lucid_acp Windows path-sep fail; +12 new kb tests: scoreCompiledPages keyword+link-expansion+empty, normalizeScores, wrapKnowledge delimiting, retrieveKnowledge vector/compiled/hybrid over real temp stores; sync new/idempotent/contradiction-retained/poisoned-still-quarantined); `demo-P-KB.2` green (LIVE real scanner + both temp stores: compiled-only page hits, vector-only chunk hits, hybrid merges both + wraps delimited, sync no-op on unchanged then re-compiles + flags a contradiction); my files tsc-clean under both the root and desktop configs; license headers present.
- **stubbed:** NOTE the root `bun x tsc` currently reports errors from the user's UNTRACKED concurrent P-TRIV.3/intel WIP (harness/scripts/demo_ptriv3.ts imports desktop/renderer/trivia*.ts, dragging bridge.ts into the harness-scoped no-DOM lib) - NOT this increment (harness/kb is clean; desktop config compiles bridge.ts clean); left untouched (not my code). Compiled retrieval is keyword+link (no PageIndex tree / no kb_page_embeddings cosine re-rank yet - both P-KB.1-deferred); hybrid dedupes by exact citation (cross-store same-source dedup is a refinement); contradiction detection is body-diff-per-slug (semantic contradiction needs the model); the desktop Knowledge-view toggle + ADR-0075 graph reuse are DEFERRED (need the compiled-KB desktop wiring P-KB.1 didn't ship - a coherent separate increment); `kb_retrieved` EventName deferred (inv #8 untouched).
- **next:** the desktop compiled-KB wiring - a KbGraphStore instance + `/api/kb/ingest` + `/api/kb/retrieve` routes (backed by backend.complete + the most-used model) + a Knowledge panel view toggle (vector | compiled | both) reusing desktop/renderer/graph.ts over kb_links; then contradiction review UI.

**P-KB.2b - the desktop compiled-KB surface (ADR-0099/0100 desktop plumbing)**
- **shipped:** wired the harness compiled KB (P-KB.1/.2) into the desktop app. `desktop/kb_store.ts` - a process-wide `kbStore()` singleton (opens+migrates kb_graph.duckdb; LUCID_KB_DB_PATH override) + a shared `kbScanner()` + `stopKb()`. `dev.ts` routes: `/api/kb/ingest` (scan source + compile via backend.complete with the most-used usageLedger model + re-scan each page, all fail-closed; onBlock -> recordBlock for the Security panel), `/api/kb/retrieve` (the router; vector store isn't desktop-wired yet so vector/hybrid degrade to compiled hits), `/api/kb/graph` (pages+links). bridge kbIngest/kbRetrieve/kbGraph + view types. RENDERER (additive, mirroring the P-KG-CODE.1 code-graph toggle so it never touched the user's in-flight trivia code): a 3rd `Compiled KB` source button in the existing Knowledge panel that reuses the shared #kgCanvas + mountGraph - kb_pages -> nodes (kind/trust/degree), kb_links -> edges; a node click renders that page's body in the side panel as escaped DATA (invariant #5); mutually exclusive with the personal + code graphs (mirrored the kgCodeMode guards at the 3 live-refresh/redraw sites). + .kb-side CSS.
- **verified:** `demo-P-KB.2b` green (LIVE real scanner + desktop store: ingest compiles pages+links, retrieve returns cited hits wrapped as untrusted DATA, graph exposes nodes+edges, a bidi/zero-width source is quarantined through the desktop wiring); `bun test desktop` 1288 pass / 5 fail (only the pre-existing fs_browse Windows path-sep fails - zero regressions, zero in my files, and the user's untracked trivia/intel tests all pass); my surface tsc-clean under BOTH the root and desktop configs; renderer bundles; license headers present.
- **stubbed:** the vector store (P-RAG.1) is still NOT desktop-wired, so retrieve mode vector/hybrid returns compiled-only hits until a RAG-desktop increment adds the KnowledgeStore instance + a dataset picker (then true hybrid); NOTE the root `bun x tsc` remains red from the user's UNTRACKED P-TRIV.3/intel WIP (demo_ptriv3.ts imports desktop/renderer/trivia*.ts, dragging bridge.ts into the harness-scoped no-DOM lib) - NOT this increment, left untouched; ingest/retrieve are API routes with no composer affordance yet (drag-a-doc-to-ingest UI + a retrieve-into-context toggle are follow-ups); contradiction-review UI deferred (sync flags them in kb_changelog; a review surface is next); no new EventName (kb ingest reuses recordBlock; inv #8 untouched).
- **next:** the RAG (vector KB) desktop wiring so retrieve does true hybrid (KnowledgeStore instance + /api/rag routes + a dataset picker); a composer 'ingest this doc' + 'use my KB' affordance; and a contradiction-review surface over kb_changelog.
**P-TRIV.1 - the Trivia Wire: a word-game ticker in the status bar's idle gap (ADR-0174)**
- **shipped:** PURE game core `desktop/renderer/trivia.ts` (question shape gate, Fisher-Yates no-repeat cycle, base-100 x streak scoring capped x3 with idempotent answer(), injected-store persistence that degrades corrupt/throwing storage safely, streaming-only visibility rule w/ 8s grace, esc()'d per-letter ticker markup) + 56-question 8-topic seed bank `trivia_bank.ts` (the P-TRIV.2 fail-closed floor); app.ts thin shell: persistent ticker element re-adopted across renderStatus innerHTML swaps, rAF scroll (~78px/s) + hue-cycling letters, live-width stop recompute (a detached-measure parking bug was caught in live verification and fixed), hover pause, wheel scrub, A-D keys (never while typing), right-click hide + undo toast, prefers-reduced-motion static mode, lifetime score tile last in the metrics rail. 20 new tests + demo-P-TRIV.1 green; tsc + license clean; `bun test desktop harness` 1932/6 (the 6 = pre-existing Windows path-sep set); verified LIVE in the dev renderer end to end (hidden idle -> fades in mid-turn -> scrolls/parks with pills in view -> verdict/explain/advance -> score tile + localStorage tally -> gone on turn end).
- **stubbed:** questions are the static seed pack only (task-aware generated packs = P-TRIV.2 via the ADR-0048 checker-model picker + codeActivity topic fingerprint); enable/disable is localStorage + right-click only (Settings toggle UI = P-TRIV.3); no difficulty adaptation; score is purely local by design.
- **next:** P-TRIV.2 - topic fingerprint (workspace languages + recent prompt flavor) -> one ~20-question strict-JSON batch from the checker-tier model, isTriviaQuestion-gated, cached per workspace, seed-pack fallback on any malformed/unavailable generation.

**P-TRIV.2 - role-aware Trivia Wire banks + idle engagement (ADR-0175)**
- **shipped:** `desktop/renderer/trivia_roles.ts` - three authored 20-question domain banks riding the ADR-0088 role (executive → GovCon M&A/vehicles/budget-priority mechanics; manager → CMMI-DEV L3 + PM/EVM; security → CMMC 2.0 + NIST RMF) + `bankForRole` selection seam (developer/none/unknown → general bank); bank refresh hooked in `applyRoleDefault` pre-guard so onboarding/Settings/boot all retarget the live game idempotently (score survives, it lives in the store); `triviaVisible` grew the pure IDLE branch - empty composer 15s + (past sessions OR unlocked KG via a 60s-polled bridge.personal cache) wakes the ticker, one keystroke hides it, turn-end edge restarts the grace, streaming branch unchanged/precedent; role param is a plain string to keep DOM-typed bridge.ts out of the non-DOM tsconfig. 12 new tests (44 trivia total) + demo-P-TRIV.2 green (P-TRIV.1 demo still green); tsc + license clean; verified LIVE (idle wake, keystroke hide, Settings role switch → GovCon lines immediately).
- **stubbed:** banks are EVERGREEN fundamentals - live GovCon news + repo/prompt-tailored questions need the generated-pack increment (news additionally needs a fresh-context source + a network-gate decision, flagged in the ADR); manager "project relevant" = generic PM until the fingerprint lands; ADR-0088's "cosmetic" role note is now slightly stale (role selects trivia content too).
- **next:** P-TRIV.3 - generated packs: (topic fingerprint x role lens) → checker-model strict-JSON batches, isTriviaQuestion-gated, per-workspace cache, these banks as the fail-closed floor.

**P-TRIV.3 - 100-question banks + the executive INTEL WIRE (ADR-0176)**
- **shipped:** banks deepened via 4 parallel authoring agents + review: developer/security/manager 100 each, executive 50 (tests pin floors, shape, zero cross-bank duplicate prompts, answer spread >=8/position); `desktop/intel_news.ts` - curated first-party defense/intel RSS allowlist fetched server-side (20-min cache, 6s timeouts, per-feed cap 8, round-robin by source), each batch scan-gated FAIL-CLOSED through the real sidecar (findings or dead scanner drop the whole refresh + recordBlock), every reach-out audited as a host-only egress SecurityEvent (P-REPORT.10 pattern), fail-quiet to [] offline; `/api/intel-news` route + bridge.intelNews; renderer `trivia_news.ts` pure INTEL line (esc()'d letters, no answer pills, defensive shape gate; type lives here so non-DOM scripts never import bridge); app.ts interleave: explain → headline → next question, 45s park timeout via a new neutral game.skip() so the idle wire keeps streaming. 17 new tests (66 trivia/news total) + demo-P-TRIV.3 green incl. a LIVE 40-headline fetch through the REAL scanner; tsc + license clean; verified in the renderer (executive idle wire scrolled "INTEL · Defense One · Iran War supplemental..." between GovCon questions).
- **stubbed:** feed list is hardcoded first-party (no user URL surface - deliberate); news is executive-only per the ask; reduced-motion users get questions without news interstitials; batch scan is coarse (one finding drops the refresh, not the item); generated per-role question packs still pending (P-TRIV.4).
- **next:** P-TRIV.4 - checker-model generated packs (role x workspace fingerprint) with the static banks as the fail-closed floor; Settings toggle + feed controls; difficulty adaptation.


**P-PKG.1 - the v1.10.2 packaged-engine brick: fix + robustness layers (ADR-0177)**
- **shipped:** root-caused on the SHIPPED artifact (engine.log: pi-coding-agent imports prompt *.md at module load; extraResources stripped node_modules/**/*.md; dev.ts died at import, port 5319 never bound). Fix stack: (1) *.md no longer stripped from node_modules; (2) skills_data's @oh-my-pi/pi-coding-agent import is type-only + LAZY inside fail-soft discoverRaw - an unloadable optional dep degrades the Skills directory to bundled-only, never kills the engine (verified with the bad filter deliberately restored); (3) main.ts tees engine stdout/stderr to <userData>/engine.log and the failure dialog points at it; (4) desktop/packaged_boot.test.ts - CI guard that emulates the LIVE packaging exclusions via a Bun resolver plugin and boots the real dev.ts (red in <1s on the v1.10.2 state, green on the fix). Released as v1.10.3.
- **stubbed:** the guard emulates node_modules exclusions only (the repo-file globs are simple includes); .map/.d.ts/.bin + heavyweight package exclusions retained (guard-covered); a full end-to-end packaged smoke in CI (launch the built installer headless) remains future work.
- **next:** consider a build-time assert in build-desktop.yml that runs packaged_boot.test before uploading artifacts; P-TRIV.4 generated packs unchanged in queue.

**P-PKG.2 - v1.10.3's broken-but-quiet skill discovery + the honest packaging guard (ADR-0178)**
- **shipped:** root-caused from the shipped v1.10.3 tree (import probe: pi-agent-core/src/telemetry.ts needs @opentelemetry/api; the extraResources filter stripped @opentelemetry, so the ADR-0177 fail-soft made discovery return [] silently - Skills panel showed no discovered/codified rows). Fix: exclusion dropped; packaged_boot.test.ts REBUILT to materialize a real filtered install (junction/hardlink tree with excluded packages absent + file-type exclusions actually deleted inside @oh-my-pi) after discovering Bun resolver plugins do NOT intercept bare package specifiers (the ADR-0177 emulation's subtree half was unenforced); guard now requires boot AND every lazily-imported feature dep (maintained list) to load. Red with the exact shipped error pre-fix, green post-fix. Released as v1.10.4.
- **stubbed:** file-type exclusions materialized only inside @oh-my-pi (the in-process import surface - documented boundary); LAZY_FEATURE_DEPS is a maintained list (one entry today); full packaged-app smoke (launch the built installer in CI) still future work.
- **next:** consider running packaged_boot.test in build-desktop.yml before uploading artifacts; P-TRIV.4 generated packs remain queued.

**P-PREVIEW.7 - the silent-white preview explained + user-clicked external Electron run (ADR-0179)**
- **shipped:** injected bridge posts a one-shot preview-health report (emptyBody + bounded error tail, parent-only postMessage, zero egress); `desktop/preview_electron.ts` pure evidence-based detection (dep/start-script/main-imports, parent-dir fallback, FAIL-FALSE for plain pages) + launch planning (app-local electron install preferred → PATH → null); renderer overlay explains WHY the pane is blank and offers "Run with Electron - opens outside LUCID" (or the manual `npx electron .` command); dev.ts `/api/preview/electron-detect` + `/electron-launch` - launch is USER-click only, refuses non-Electron paths, spawns detached outside LUCID, audited as an exec SecurityEvent. 13 new tests + demo-P-PREVIEW.7 green; tsc + license clean; verified LIVE (overlay rendered over the white pane, button spawned a real electron.exe tree, plain pages unaffected).
- **stubbed:** launch uses the app's own/PATH electron only (no auto-download of a runtime - deliberate); the overlay's generic branch covers non-Electron script crashes minimally; inline scripts that crash before the bridge installs aren't in the error tail (emptyBody carries the signal).
- **next:** possible P-PREVIEW.8 - stream the launched app's console back into LUCID (a read-only tail of the spawned process's stdio) so the agent can also react to runtime errors.

**P-TASK.5 - live subagent activity in the delegation card (ADR-0180)**
- **shipped:** `desktop/subagent_activity.ts` - pure tailing of omp's per-subtask transcripts (artifactsDir = parent sessionFile minus .jsonl): assignment (preamble stripped), model, exact tool counts, last-12 thinking/tool/text steps with the model's `_i` intent labels, corrupt-tolerant, multi-MB tail-read; `/api/subagents` (current session only, path-confined via sessionPathById, fail-quiet []); the delegation card polls while streaming and renders one expandable row per subagent (status dot, generated name, live now-line, tool count → step trail), final refresh at finish, everything esc()'d. 9 tests + demo-P-TASK.5 green (demo tails the REAL four-game run that motivated this); tsc + license clean; verified LIVE with a real two-subtask delegation (rows appeared mid-turn, steps expanded, done dots on finish).
- **stubbed:** step view is the tail only (no full-transcript viewer - click depth is 12 steps); no per-run token/cost figures (transcripts don't carry usage per entry); temp-dir task runs (parent session without a file) have no artifacts to tail - card falls back to static rows.
- **next:** possible P-TASK.6 - a "open full transcript" action per run (Monaco read-only viewer) + per-run cost once omp exposes usage in subtask transcripts.

**P-MARKET.1b - curate the marketplace catalog for fit (ADR-0181)**
- **shipped:** the Plugin Marketplace registry curated for LUCID fit: retired `copilot` (competes with core chat + Local Providers), `brat` (competes with the P-MARKET.2 install path), `url-into-selection` + `readwise` (Obsidian niceties off-audience); added Mermaid, Gitleaks, Semgrep, Trivy, Pandoc as `planned` with honest null download badges; ordering = featured pin, then Obsidian popularity survivors, then curated additions; modal subtitle updated; 16 tests + demo-P-MARKET.1 green.
- **stubbed:** still a static catalog (P-MARKET.2 install path unbuilt); new entries' lucidPlan lines are roadmap one-liners, no integration code yet.
- **next:** P-MARKET.2 gated install-from-URL, or pick one added integration (Gitleaks pre-commit sweep is the smallest end-to-end win).

**P-SYSRES.1 - the system resource guard (ADR-0182)**
- **shipped:** `desktop/system_profile.ts` (CPU busy% from os.cpus() deltas, RAM headroom, closed verdict set ok/strained/blocked with tested thresholds, fixed-argv read-only top-processes listing) + `/api/system` (5s memo, ?fresh=1) + `system_guard.ts` pure builders; KG render + Code Graph ingest hard-pause at "blocked" behind a notice (why + machine line + Show-what's-using-resources panel + Re-check, deliberately NO render-anyway); palette "Open System resources"; FAIL-OPEN by design (UX guard, not the scan gate). 23 tests + demo-P-SYSRES.1 green; verified live (real route data, stubbed-blocked wiring, recheck lifts the pause).
- **stubbed:** gates cover the two graph builds only (KB graph + Agent Builder canvas mounts stay ungated - smaller sims); no background watcher (checked at build time, not continuously); battery stays with P-PERF.2 tiers.
- **next:** possibly gate the KB-graph mount the same way; a status-bar chip when verdict != ok; per-process kill action is deliberately out (LUCID must not kill user processes).

**P-KGVIZ.1 - form in place: the graph settle moves off-screen (ADR-0183)**
- **shipped:** kg_ops gains `stepForces` (the tick physics, extracted pure) + `presettle` (run to energy rest before first paint; frame budget + wall-clock deadline, grace counted in iterations run); graph.ts mounts pre-settle off-screen, PARK the sim, SNAP the fit (open at the final center) and fade the formed graph in (`.kg-form`, reduced-motion aware); live merges presettle silently (no more 160-frame reheat shake); resizes re-fit without reheating; drag remains the only visible sim. 8 tests + demo-P-KGVIZ.1 green (300 nodes ~260ms off-screen); verified live (formed, parked, camera still, drag re-rests).
- **stubbed:** presettle blocks the main thread up to ~420ms on huge graphs (acceptable vs seconds of shake; a worker would be over-engineering at current sizes); drag reheat is still global for its 160 frames.
- **next:** possible localized drag reheat (only neighbors within k hops); a "re-layout" button that presettles fresh for users who want a reshuffle.

**P-KGUI.1 - the KG flyout header, decluttered (ADR-0184)**
- **shipped:** the Relate / Code graph / Compiled KB triple stack is ONE labeled dropdown (`#kgViews`: label = the graph you're viewing, hover tip says it's a dropdown + lists the options, menu rows self-describe with the active view checked); title icon removed and "Knowledge graph" → "KG" with a Knowledge Graph hover; same handlers rewired (relate bar, level picker, re-sync icon all unchanged); pure `kg_header.ts` builders + 5 tests + demo-P-KGUI.1; verified live (one 51px header row, full dropdown flow, label/check tracking).
- **stubbed:** the remaining header controls (search, lens seg, perf chip, AI toggle, Import/Export/CUI) stay as-is - they're single-height and were not the complaint.
- **next:** if the header needs more room later, Import/Export/CUI could fold into the same dropdown pattern ("Data…" menu).

**P-KGUI.2 - the Data dropdown in the KG header (ADR-0185)**
- **shipped:** Import history / AI-extraction toggle / Export vault / CUI archive folded from three buttons + a checkbox into one "Data" dropdown (same pattern as the views menu): self-describing rows with stable data-kgdata handles, the AI choice as remembered module state (toggling never closes the menu), CUI keeps the danger look + confirm toast, handlers extracted unchanged; orphaned .kg-ai CSS removed. 3 new tests + demo-P-KGUI.2 green; verified live (one-row header, toggle persistence, real export/CUI flows).
- **stubbed:** the header now has exactly two dropdowns (views + Data) - search, lens, perf chip stay as single controls by design.
- **next:** none queued for the KG header; P-MARKET.2 / P-TRIV.4 / P-RAG.2 remain the open threads.

**P-STALL.1 - patience for overloaded providers (ADR-0186)**
- **shipped:** chat turn patience raised 5 → 10 min (IDLE_MS 600_000); a `{type:"slow", waitedMs}` ChatEvent at each silent 2-min mark drives an honest HUD phase ("Still waiting on the provider · silent for N min") + a once-per-turn toast naming the cap and Stop; the stall error now DERIVES its duration from the constant (the old text hardcoded "2 minutes" at a 5-min cap) and names overload/rate-limit; wording pure in stall_notice.ts; lockstep source pins stop both constants/text from drifting. 4 tests + demo-P-STALL.1 green; renderer boots clean.
- **stubbed:** no auto-retry/model-failover on stall (the turn still errors at 10 min - ADR-0060's wellness-check path remains the eventual answer); /goal checker completions keep their own 60-180s idles.
- **next:** consider surfacing provider status (Anthropic/Google status feeds) in the slow toast so "overloaded" is evidence, not a guess.

**P-TRIV.4 / P-EVAL.1 / P-CHAT.A-C - re-integrated onto master (ADR-0187-0191, renumbered from 0177-0181)**
- **shipped:** the five increments from the stale `feat/skills-kb-desktop` branch, re-based onto master on `feat/chat-eval-redesign` (the skills/KB commit was a duplicate of the already-merged #242 and was dropped). Pure cores dropped in unchanged; app.ts/dev.ts/bridge.ts/styles.css wiring re-applied against master's current renderer. P-EVAL.1=ADR-0187 (evals.ts, pure). P-CHAT.A=0188 sections + P-CHAT.B=0189 chips + P-CHAT.C=0190 run-report CTA wired at the settle points; P-CHAT.C's `/api/eval/report` verified END-TO-END in the preview (saves + lists + reads back). P-TRIV.4=0191 Settings card + `/api/trivia/reseed` + `effectiveTriviaBank` (generated pack ?? seed floor) rerouting both game builders; mini source checkboxes tightened (3px 8px padding, 14px boxes, txt-2 12.5px labels); the wire now defaults OFF. All 5 demos + 37 unit tests + full typecheck green.
- **stubbed:** the live-streaming settle path for P-CHAT.A/B (a real assistant turn rendering sections/chips) and the P-TRIV.4 re-seed round-trip (calls backend.complete) are typechecked + preview-verified structurally but need a live model turn for full in-app QA. Subagent-card: NO change - master's P-TASK.5 already collapses on settle (see ADR-0188).
- **next:** merged via #258; the live in-app QA of the streaming settle paths; P-TRIV.4's ADR moved 0186 -> 0191 to clear the collision with P-STALL.1.

**P-EVAL.2 - API-latency capture hook + frozen eval/latency DuckDB migrations (ADR-0187)**
- **shipped:** the per-turn latency capture at the chat seam and its persistence. `desktop/latency_log.ts` (`recordLatency`) turns t_sent/t_first_token/t_end into a `LatencySample` appended to an append-only JSONL (the GUI opens `agent_obs.duckdb` READ-ONLY, so it can't co-write - mirrors `turns_log.ts`); the hook lives in `acp_backend.prompt()` (t_sent at the `session/prompt` send, t_first_token on the first token/thinking chunk via the existing event sink, t_end at settle, `ok=false` on stall, context tokens + cost from the last usage event). Frozen migration `0011_eval_latency.sql`: `api_latency` (= evals.ts `ApiLatencyCall` + nullable token/cost) + `eval_metrics` (created, populated in .3) + the `latency_rollup` view. `harness/memory/latency_ingest.ts`: idempotent `ingestLatency` (single-writer) + `readLatencyCalls` (ok-only default; `includeFailed` opt) that round-trips rows back into `ApiLatencyCall` (ts as UNIX ms) so `rollupLatency` + render stay unchanged (P-EVAL.1 = source of truth). 14 tests + demo-P-EVAL.2 + full typecheck green; SPDX + license check clean.
- **stubbed:** `eval_metrics` is created but NOT populated (P-EVAL.3); the `latency_rollup` view is timezone-naive (UTC hour) - the DST-correct ET business-hours p50/p95 stays evals.ts on raw rows; `tokens_out` is null (no reliable server-side per-turn output count at the ACP seam); the live capture is wired but only exercised by a real chat turn (in-app), not runnable headless.
- **next:** P-EVAL.3 - populate `eval_metrics` from settled turns (reuse P-CHAT.C's observed-turn -> RunRecord), then surface both as a report kind (query -> rollupLatency -> the P-REPORT.4 accordion/chart viewer).

**P-EVAL.3 Part A - per-run eval-metrics persistence (ADR-0187)**
- **shipped:** the `eval_metrics` write path (the table was frozen empty by 0011). `eval_report.ts` gains `evalMetricsForTurn` (observed turn -> EvalMetrics, the same compute `renderTurnEvalReport` runs, exposed non-breaking). `desktop/eval_metrics_log.ts` `recordEvalMetrics` flattens EvalMetrics to a sample (each metric `.value` -> nullable column, `.tier` -> `tiers` JSON) + appends to `~/.omp/lucid-eval-metrics.jsonl`; the `/api/eval/report` route now persists alongside saving the brief. `harness/memory/eval_metrics_ingest.ts`: idempotent `ingestEvalMetrics` (single-writer, on `run_id`) + `readEvalMetricsRows` (ts UNIX ms, model/window scoped). Same read-only-DB pattern as P-EVAL.2. The honesty rule survives the round-trip: a no-signal metric stays NULL (never 0), its `needs_signal` tier restores. 9 tests + demo-P-EVAL.3 + full typecheck + license + the 107-test memory suite green.
- **stubbed:** Part B not built - no cross-run rollup aggregator, no eval report kind wired to a UI trigger yet (the P-REPORT.4 viewer already bar-ifies the xychart markdown + role=`evals` briefs already list/open, so Part B is render + route + button). The live capture rides the report route but is only exercised by a real generated report (in-app).
- **next:** P-EVAL.3 Part B - a pure cross-run aggregator over `readEvalMetricsRows` (+ `readLatencyCalls`/`rollupLatency`) -> combined Model-Evaluation markdown -> saved as an `evals` brief, with a "Generate metrics report" trigger in the Reports panel.

**P-EVAL.3 Part B - the cross-run Model-Evaluation rollup report kind (ADR-0187)**
- **shipped:** `harness/brief/eval_metrics_report.ts` (PURE) - `aggregateEvalMetrics` rolls per-run rows up per model (each metric a mean over ONLY runs-with-signal, nulls excluded not zeroed, with `n/runs` coverage + tier) + `renderEvalMetricsRollupMarkdown` (net-LOC xychart + per-model metric tables, "no signal" for zero-coverage, ASCII-only). `POST /api/eval/rollup` ingests the GUI-owned eval-metrics + latency JSONL ledgers into a THROWAWAY DuckDB the GUI owns (no contention with the read-only agent_obs.duckdb; reuses ingest + readers), aggregates + `rollupLatency`, renders the combined report, saves it as an `evals` brief (lists/opens in Reports; the P-REPORT.4 viewer already bar-ifies the xychart). `bridge.evalRollup()` + a "Model-Evaluation rollup" button in the Reports panel. Empty ledger -> friendly report. 6 tests + demo-P-EVAL.3b + typecheck + license green; button verified rendering in the preview; the route pipeline proven by the demo.
- **stubbed:** the ingest into agent_obs.duckdb by the single-writer omp gate (for cross-tool dashboards) is still NOT wired - this report sidesteps it by ingesting its own scratch copy from the JSONL on demand; no period/date filter (the rollup is lifetime, buckets latency by hour-of-day); the live button->route->open flow is in-app QA (route logic proven headless).
- **next:** wire the single-writer ingest of the JSONL ledgers into agent_obs.duckdb (so the latency_rollup view + cross-tool SQL see live data); a period selector (weekly/monthly) on the rollup; P-EVAL.4 if the report grows a trend/history view.

**P-CHAT.C.1 - the run-footer report CTA, gated + restyled (ADR-0190 follow-up)**
- **shipped:** in-app QA polish for the "Generate engineering report" CTA. GATE: `maybeAppendReport` only appends it when the turn actually wrote a file/code (a mark with a `path` + a diffstat), so a read/search/bash-only or pure-text turn shows no footer (the report scores written work). STYLE: `.report-cta` went from an embossed accent-2 gradient button to a thin, subdued, professional bordered pill (transparent bg, `--line` border, `--txt-3` text, 11.5px/500, `3px 9px` padding, 7px radius; hover = light lift + accent on the icon only); run-meta dropped to 10.5px `--txt-4`; icons 14->13. Verified in the preview (thin muted pill); typecheck + demo-P-CHAT.C green.
- **stubbed:** the gate's live behavior (no footer on a read-only turn) + the hover polish are in-app QA (not runnable headless).
- **next:** user QAs in-app; if the label should be even terser, shorten to "Engineering report".
**P-CHAT.B.1 - fix the settled-turn activity regression (ADR-0189 follow-up)**
- **shipped:** in-app QA found that a short/flat tool-using answer dropped the live activity window and dumped a pile of coarse "other" chips at the end (the rich tool detail + diffstats + code drilldowns + subagent detail gone). Root cause: the settle path dropped the window for ANY chip. Fix: `answer_chips.ts` `chipsInterleave` - true ONLY when a chip is sandwiched between prose blocks; `renderAnswerBody` gates the chipped path on it, so a short/flat answer KEEPS the `.thoughts` activity window (which already carries the +/- diffstat badges + `renderToolCode` code drilldowns). Also: the subagent delegation card no longer collapses on settle (dropped `finish`'s `toggle(false)`), so each subagent's thinking/tools stay visible. `chipsInterleave` unit-tested; settled subagent card run-detail verified in the preview; typecheck + demo-P-CHAT.B green; boots clean.
- **stubbed:** genuine mid-prose interleave still uses chips (the P-CHAT.B win for long structured answers); code capture for a fully-custom edit tool that sends its file in a non-standard field is still best-effort (acp_backend); the live streaming settle path is in-app QA (not runnable headless).
- **next:** user QAs in-app; if chips are still preferred for some flat answers, add a per-user toggle; consider a compact activity summary line above the window.

**P-COLLAB.1 - live session collaboration: the transport keystone (ADR-0192)**
- **shipped:** research + the pure, security-critical foundation for sharing a LUCID session with another LUCID session. Finding: omp's live-collab is `/collab`+`/join` over an E2E-encrypted WebSocket relay (NOT the SSH feature that was half-remembered); it's TUI-bound + not on ACP, and LUCID drives omp headless - so we EXTEND, not fork (invariant #1): reuse omp's `@oh-my-pi/pi-wire` collab constants + envelope + the WebCrypto AES-256-GCM seal, and share LUCID's OWN `ChatEvent` stream. `desktop/collab/`: `crypto.ts` (seal/open `[12B IV][ct+tag]` + `[4B BE peerId]` envelope), `link.ts` (`roomId.base64url(key[||writeToken])` invite - full=edit, view=read-only - parsing the bare / `host/r/` / browser-fragment forms), `frames.ts` (the LUCID collab frame union). 14 unit tests + demo-P-COLLAB.1 (host seals a ChatEvent -> envelope -> guest opens E2E; wrong key + tampered byte both fail-closed) + typecheck + license green. Decisions: self-hosted relay default (sovereign/air-gap), Phase 1 = view-only.
- **stubbed:** no relay CLIENT, host/guest logic, or Share UI yet (P-COLLAB.2/.3); no omp-TUI-guest interop (LUCID-native frames, LUCID<->LUCID only); guest prompts (which run tools on the HOST) will pass the host's fail-closed scan gate when guest-write lands (P-COLLAB.3).
- **next:** P-COLLAB.2 - the egress-gated WebSocket relay client + the HOST (broadcast ChatEvents + transcript to view-only guests) + the Share panel (generate link, participants, stop).

**AskSage model refresh - newer Anthropic Claude models (gov gateway)**
- **shipped:** driven live through LUCID's configured AskSage key, queried the CIV `/get-models` endpoint + verified each new model replies with a real `/query` (200 + reply). Added the newer gov-routed Claude models to `harness/omp/asksage_extension.ts` `ANTHROPIC_MODELS` (the picker's source of truth) - Claude **Sonnet 5**, **Fable 5**, **4.8 / 4.7 / 4.6 Opus**, **4.6 Sonnet**, **4.5 Haiku** - plus matching display metadata (`MODEL_META`) + the 200K context-window map in `app.ts`. Was capped at 4.5. Typecheck + the 47 model-families/asksage tests + license green.
- **stubbed:** the commercial `-com` Claude variants (opus-4-7-com / sonnet-4-6-com) reply too but are the non-gov route, left out of the gov gateway list; the picker sort encodes 4.5 as "45" so Sonnet 5 / Fable 5 (version "5") land just below 4.x Opus (cosmetic; a normalized version-sort is a future tidy).
- **next:** consider fetching the AskSage model list LIVE (asksage.ts `/get-models`) so new gov models appear without a code change.

**P-COLLAB.2 - live session collaboration: the relay client + the view-only host (ADR-0192)**
- **shipped:** the egress-gated relay CLIENT + the broadcast HOST, both fully unit-tested headless via injectable transports. `desktop/collab/relay_client.ts` (`CollabSocket`) mirrors omp's exact wire contract - `wss://host/r/<roomId>?role=`, `[4B BE peerId][sealed]` envelopes (peer 0 = broadcast), STRING=JSON relay-control / BINARY=sealed frame, jittered backoff reconnect - but seals with LUCID's own crypto + takes an INJECTABLE `wsFactory` so it needs no real socket to test. `desktop/collab/host.ts` (`CollabHost`) answers a guest `hello` with a unicast E2E `welcome` (header + replayed transcript + roster), broadcasts every LUCID `ChatEvent` as an `event` frame, folds `done`/`usage` into transcript + context fill, and pushes a `state` on join/leave. 15 new tests (7 host + 8 client) + demo-P-COLLAB.2 (an in-memory relay wiring a real host socket + real guest sockets end-to-end) + typecheck + license green; 29 collab tests total.
- **stubbed:** no Share panel UI, no dev.ts `/api/collab/*` routes, and no ChatEvent tap wired into the live prompt stream yet (P-COLLAB.3, QA-gated in-app like the P-CHAT DOM wiring); guest join/render + guest-write (prompt/abort through the host's fail-closed scan gate) are P-COLLAB.3. Fail-closed holds now: a bad-key frame terminates the socket (never reconnects), and a full-token guest is STILL read-only in Phase 1 (guest-write is off).
- **next:** P-COLLAB.3 - wire the host into dev.ts (tap the /api/chat ChatEvent stream + `/api/collab/start|stop|status`) + the Share panel (generate link, participants, stop) + the guest join/render surface.

**P-COLLAB.3 (backend slice) - the live-share host lifecycle wired into the backend (ADR-0192)**
- **shipped:** `desktop/collab/manager.ts` (`CollabManager`) - the one backend owner of the current share: mints the room + view/full invite links, stands up a `CollabHost` over a relay transport, taps the live session's ChatEvents into it, and exposes a `status` the Share panel will render. Transport- and policy-injectable so it's unit-tested headless (5 tests). Wired into `dev.ts`: `/api/collab/status|start|stop` + `/api/collab/relay` (GET/POST), and the `/api/chat` emit now passes each ChatEvent + the user turn through `collabManager.tap*` (best-effort - a collab failure never breaks local chat). Added `collabRelayConfig()`/`setCollabRelay()` to settings (self-hosted-default; public relay opt-in) + `backend.activeModelName()`. demo-P-COLLAB.3 drives the manager end-to-end through an in-memory relay (real guest socket joins, events tap through, stop, fail-closed refusal). 34 collab tests + typecheck + license + full suite green.
- **stubbed:** no Share panel UI in the renderer yet (the next slice, QA-gated in-app) and no bridge.ts client methods; the relay WebSocket egress is authorized at the `resolveRelay` seam but not yet added to the egress whitelist UI; guest join/render + guest-write (prompt/abort through the host's fail-closed scan gate) remain P-COLLAB (later).
- **next:** the Share panel UI (generate/copy link, live participants, stop) + the renderer bridge client + a Settings → Collaboration relay card; then the guest join/render surface.

**P-COLLAB.3 (UI slice) - the live-session Share panel (host side) (ADR-0192)**
- **shipped:** the HOST Share window, verified end-to-end in the live renderer (preview): a new `#railShare` rail glyph (with a pulsing live-dot when active) opens a modal that walks through relay setup (self-hosted-default URL + a public-relay opt-in, fail-closed when neither is set) -> a "relay ready / Start sharing" state -> a live state showing the view-only invite link (Copy), an E2E explainer, a live participants roster that polls every 2.5s, and Stop. Renderer bridge gained `collabStatus/collabStart/collabStop/collabSetRelay` (+ `CollabShareStatus`/`CollabParticipantView`/`CollabRelay` types); `collabStart` reads the full `{ok,error}` envelope so a fail-closed refusal surfaces as a toast. Added `share`/`link` icons + Share-panel CSS. Confirmed the whole flow live: setup -> save relay -> start (real roomId.base64url view link minted) -> roster "waiting to join" -> stop (rail dot clears); test relay config reset afterward. Typecheck + license green.
- **stubbed:** the GUEST side (join by pasting a link + render the shared turns) is still the next slice, so an active share shows "waiting for someone to join" until then; relay config lives in the Share panel setup (no separate Settings card); the relay WS egress is authorized at `resolveRelay` but not yet surfaced in the egress whitelist UI.
- **next:** the GUEST join/render surface (paste link -> connect -> render welcome + live events read-only), then guest-write (prompt/abort through the host's fail-closed scan gate) + enterprise relay policy/audit.

**P-COLLAB.4/.5 - the read-only guest + the optional embedded relay (ADR-0193)**
- **shipped:** the two pieces that make live collaboration work END-TO-END. `desktop/collab/guest.ts` (`CollabGuest`) - the mirror of CollabHost, transport-injectable: sends one `hello`, then applies welcome/event/state/bye/error into a `view()` (folds done/usage), view-only in Phase 1 (only ever sends a hello). `desktop/collab/relay_server.ts` (`startRelayServer`) - the OPTIONAL embedded relay so any LUCID hosts its own sessions with no third party: a dumb ciphertext forwarder over Bun's WS server, wire-compatible with the client (rooms, `[4B peer][sealed]` rewritten to sender id, JSON control, fatal 4004/4009/4029). Guard-railed (the one new attack surface): forwards ONLY ciphertext (never holds the key), OPT-IN + off by default, a SEPARATE listener from the localhost-only /api server, binds 127.0.0.1 by default (LAN is an explicit choice), hard limits (max rooms/peers/frame-bytes/idle). 14 new tests (10 guest via mock + 4 relay over REAL localhost sockets) + demo-P-COLLAB.4 (full host<->guest session end-to-end through LUCID's own embedded relay). 48 collab tests total; root + desktop tsc + license green.
- **stubbed:** no UI yet - the Join panel (paste link -> connect -> read-only live view) + the "be the relay" toggle + the backend routes (guest stream + relay lifecycle) are the next slice (QA-gated in-app); guest-write (prompt/abort through the host's fail-closed scan gate) + enterprise relay policy remain after that. NAT: the embedded relay needs host reachability (LAN/VPN/tunnel); arbitrary-internet peers still need a hosted rendezvous relay.
- **next:** the Join panel + "be the relay" toggle + `/api/collab/join|leave` + `/api/collab/relay/serve` routes, wired to the egress gate; then guest-write.

**P-COLLAB.6 - enterprise/MDM governance for the embedded relay (ADR-0193)**
- **shipped:** rock-solid, fail-closed controls over the "be the relay" toggle + an ABSOLUTE bind IP/DNS/port allowlist, extending the ADR-0068 managed-policy system (file + Windows GPO, tighten-only). `ManagedCollabPolicy` in `desktop/managed_config.ts`: `allowServe` (master switch), `allowedBinds` (absolute host/host:port allowlist for the listener), `allowedRelays` (which relay endpoints a user may connect to), `lock`. Pure enforcement: `collabServeAllowed`, `authorizeRelayBind` (localhost always ok; managed LAN/0.0.0.0 refused unless allowlisted; unmanaged = user's call), `authorizeRelayConnect` (opt-in connect allowlist, malformed fails closed), `managedLocks.collab`. Defense-in-depth: `startRelayServer` takes an injected `authorizeBind` and THROWS before opening the listener when denied. GPO knobs CollabAllowServe/CollabAllowedBinds/CollabAllowedRelays/CollabLock parsed + merged. 11 governance tests + demo-P-COLLAB.6 (incl. a real relay that throws under allowServe:false and binds under an allowlist). root + desktop tsc + license green.
- **stubbed:** the toggle/Join UI that READS `managedLocks.collab` + calls these authorizers isn't built yet (next slice); audit events for share/relay start/stop/join deferred; the org's real policy template is private add-on IP (this ships the capability + schema).
- **next:** the Join panel + "be the relay" toggle (respecting managedLocks.collab + authorizeRelayBind) + backend routes; then guest-write through the host's scan gate.

**P-COLLAB.7 - the "be the relay" toggle (UI slice, ADR-0193)**
- **shipped:** the clickable "host your own relay" control - any LUCID can be the relay for its own sessions, verified end-to-end in the live renderer. dev.ts: a module-level embedded-relay lifecycle (`serveRelay`/`stopRelay`/`relayServeStatus`/`effectiveRelay`) + routes `/api/collab/relay/status` (GET) + `/api/collab/relay/serve` (POST). Every start is governance-gated fail-closed (consumes P-COLLAB.6: collabServeAllowed + authorizeRelayBind + startRelayServer's injected authorizeBind). `effectiveRelay()` makes the manager AND the status route prefer the running embedded relay (source "embedded") over the configured external one, so enabling the toggle flips the Share panel to "Relay ready: this device". Renderer: a "Host the relay on this device" toggle card in the Share panel (`shareRelayServeHtml`) with host/port fields, respecting `managedLocks.collab` (disabled + "Managed by <org>" when locked; hidden entirely when allowServe:false). Bridge: `collabRelayServeStatus`/`collabRelayServe` + `CollabRelayServeStatus` type; `CollabRelay.source` widened to include "embedded". Verified live: toggle on -> relay on 127.0.0.1:8790 -> Share panel "ready" -> Start -> share LIVE on the embedded relay with a minted invite link -> Stop -> toggle off. desktop tsc 0 + license green (root tsc has 1 pre-existing Windows-only error in harness/tools/output_minify_proto.ts, not mine; CI-Linux green).
- **stubbed:** the GUEST Join panel (paste link -> connect -> read-only live view) still needs the invite link to carry the relay ENDPOINT (the bare `roomId.secret` link doesn't) - a small link.ts extension + guest streaming route are the next slice; the relay serve config isn't persisted (session-only; no auto-start on launch, by design); audit events for share/relay start/stop/join deferred.
- **next:** extend the invite link to carry the relay endpoint + the Join panel + `/api/collab/join|leave` guest stream, so a 2nd LUCID can watch; then guest-write.

**P-COLLAB.8 - WebRTC P2P DataChannel transport (spike, ADR-0194)**
- **shipped:** the encrypted-P2P-tunnel-already-in-the-build answer - Chromium's WebRTC, proven usable in our Electron build. `desktop/collab/signaling.ts` (PURE, DOM-free, unit-tested): the SDP/ICE/bye `SignalMessage` protocol + `SignalingChannel` interface + `LoopbackSignaling` hub. `desktop/collab/webrtc_transport.ts` (renderer-only, RTCPeerConnection): `WebRtcTransport` - a DROP-IN for CollabSocket (same interface CollabHost/CollabGuest drive) that opens a direct DTLS DataChannel; fixed roles (host=offerer/guest=answerer, no glare), trickled ICE buffered until remote-desc set, and frames STILL E2E-sealed with the room key over the channel (defense-in-depth vs a MITM signaling relay), fail-closed on bad-key/tamper/failed-connection. 3 signaling tests + a LIVE preview proof: two RTCPeerConnections in the Electron build reach connectionState "connected" via offer/answer + trickled ICE and carry an AES-256-GCM-sealed collab frame end-to-end (the exact flow the transport implements). root + desktop tsc + license green.
- **stubbed:** the transport class is renderer-only so not bun-testable (verified via the live mechanism proof + typecheck; integration-verified when wired to the UI). Deferred: signaling routed over the collab relay (real guest over WebRTC), CollabHost/CollabGuest driven by the WebRTC transport renderer-side, STUN/TURN config (self-hosted coturn for air-gap), a per-guest peer connection for multi-watcher (WebRTC is 1:1; the relay stays the multi-party path), and the UI. NAT still needs a coordination point (the relay brokers the handshake + is the E2E fallback).
- **next:** wire signaling over the relay + drive CollabGuest over the WebRTC transport (renderer-side) so a 2nd LUCID watches P2P; then STUN config + the Join UI.

**P-COLLAB.9 - the standalone relay broker (ADR-0195)**
- **shipped:** the same relay the desktop embeds, packaged headless in `tools/relay/` to run on a box both peers can reach - the rendezvous BOTH the relay path and the WebRTC signaling need. `serve.ts` CLI (env/--flag: HOST/PORT, TLS_CERT/KEY for wss://, MAX_ROOMS/PEERS/FRAME/IDLE, graceful shutdown, status line; standalone defaults 0.0.0.0:8790). `relay_server.ts` made SELF-CONTAINED (inlined the 4-byte envelope header ops → imports NOTHING, no pi-wire/WebCrypto) + gained optional `tls` (Bun serves wss:// directly) + a `/healthz` probe (aggregate counts only, never content). `Dockerfile` (2-file image), `lucid-relay.service` (hardened systemd for Ubuntu 24), `README.md` (local/office/DGX Spark/jumpbox; TLS direct or reverse-proxy; firewall; client wiring + collab.allowedRelays governance). demo-P-COLLAB.9 SPAWNS the deployable as a separate process + drives a real host<->guest session through it (welcome->event->bye, /healthz reflects the live room). Language stays TS (invariant #2: only the scanner is Python); a FastAPI relay for a Python ops shop is the SAME wire protocol and belongs in the private add-on repo. root+desktop tsc + relay tests + license green.
- **stubbed:** the FastAPI add-on-repo variant is spec'd (ADR-0195), not built here; no autocert (Let's Encrypt) in the image yet; no metrics endpoint.
- **next:** wire WebRTC signaling over this broker + drive CollabGuest over the WebRTC transport (renderer) so a 2nd LUCID watches P2P; then the Join UI (+ the link.ts relay-endpoint extension).

**P-COLLAB.10 - the guest end-to-end / Join panel (ADR-0196)**
- **shipped:** two LUCID sessions can now actually WATCH each other, verified live. `link.ts`: `formatRelayLink` mints endpoint-carrying invites (`<wss://relay>/r/roomId.secret`) + `parseShareLink` returns the `relay` endpoint (normalizes the browser https→wss form; null for bare → guest falls back to configured relay); manager mints endpoint-carrying links. dev.ts guest session: `/api/collab/join` (parse link -> authorizeRelayConnect fail-closed -> CollabGuest over CollabSocket -> NDJSON stream of welcome/event/state/error/end) + `/api/collab/leave`. Renderer: `bridge.collabJoin`/`collabLeave` (collabJoin peeks content-type to surface a JSON error vs the stream) + `openJoinPanel()` (paste link -> Connect -> read-only live transcript + watcher count + Leave), reached from the Share panel's "Join instead" CTA. link.test.ts +3; 54 collab tests + tsc + license green. VERIFIED LIVE: embedded relay on -> share (link carries ws://127.0.0.1:8790/r/…) -> Join from same instance -> guest got the E2E welcome "Watching LUCID session · Nick · claude-opus-4-8 · read-only", 1 watching.
- **stubbed:** WebRTC as a P2P option for the guest (transport built, ADR-0194; needs signaling over the broker); one watched session at a time; guest rendering is a simple transcript (no tools/thinking/full answer renderer); guest-WRITE through the host's scan gate is later.
- **next:** route WebRTC signaling over the broker + offer the guest a P2P transport; then guest-write.

**P-COLLAB.11 - WebRTC signaling over the relay (ADR-0197)**
- **shipped:** the keystone that lets WebRtcTransport (ADR-0194) reach the other peer over the relay we already have, before going DIRECT P2P. `frames.ts`: a bidirectional `SignalFrame {t:"signal";signal}` in the union + `isSignalFrame`; `isHostFrame` now excludes it so the host/guest SESSION handlers ignore signaling (the demux routes it to WebRTC). frames.ts imports the plain-data SignalMessage + stays DOM-free (root typecheck unaffected). `signaling.ts`: `RelaySignaling implements SignalingChannel` - a frame-agnostic adapter sending a signal to ONE peer (host=0; a guest=its relay peer id) whose `deliver()` the demux calls on an inbound signal frame; 1:1 per peer (host holds one transport+signaling per guest; relay stays the fan-out). signaling.test.ts +3 (narrowing, full offer/answer/ICE handshake routed host<->guest by peer id, terminal close) + demo-P-COLLAB.11. 57 collab tests + root/desktop tsc + license green.
- **stubbed:** no renderer wiring yet - the DataChannel is renderer-only (preview-verified in ADR-0194); this proves the signaling that carries it.
- **next (larger):** the renderer-side integration - drive CollabHost/CollabGuest over WebRtcTransport renderer-side (renderer already has the ChatEvent stream), with a demux splitting signal frames (-> RelaySignaling) from session frames (-> host/guest) over the collab transport; + STUN/TURN config + P2P/relay fallback + a UI toggle.

**P-COLLAB.12 - guest-write, the mechanism (ADR-0198)**
- **shipped:** the security-critical guest-write foundation (view-only -> a guest can DRIVE the host, host keeps the gate). frames.ts: guest->host `PromptFrame`/`AbortFrame`; GuestFrame = hello|prompt|abort. CollabHost: a prompt/abort requires the sender's roster `access === "edit"` (granted only via allowGuestWrite + a proven full-link write token) -> onGuestPrompt/onGuestAbort (the host runs it through its OWN in-process scan gate + approvals; the guest bypasses nothing); a view-only/unknown/empty prompt is refused with an error frame + never reaches the host session (fail-closed). CollabGuest: `sendPrompt`/`abort` (no-op when read-only/ended) + `readOnly` getter. manager.start({allowEdit}) mints the full link + wires allowGuestWrite + the callbacks; status.allowEdit. host.test +4, guest.test +2 + demo-P-COLLAB.12 over a REAL relay (edit guest drives host; a hand-crafted raw prompt from a view guest is refused host-side). 63 collab tests + tsc + license green.
- **stubbed:** no UI/backend-route wiring yet (the mechanism is tested; the integration is P-COLLAB.13).
- **next (P-COLLAB.13, the UI): the host "Allow edit" toggle (start with allowEdit), the guest prompt box in the Join panel (-> the backend guest's sendPrompt), and the host surfacing a guest prompt in its OWN chat flow so approvals fire + it taps back to collab (host-renderer auto-submit via the composer, attributed to the guest).

**P-COLLAB.13 - guest-write UI (ADR-0198)**
- **shipped:** guest-write is now clickable end-to-end. Host Share panel: an "Allow edit" checkbox on start -> collabStart({allowEdit}) -> mints + shares the EDIT (full) link; the live state shows a "can edit" tag + "Edit invite link (guest can drive)". Backend: /api/collab/start takes allowEdit; a guest-prompt INBOX (pendingGuestPrompt/guestAbortRequested, consume-on-read) fed by the manager's onGuestPrompt/onGuestAbort; routes /api/collab/guest-inbox (host polls), /api/collab/guest-prompt + /api/collab/guest-abort (the connected guest drives). Bridge: collabStart({allowEdit}), collabGuestInbox/collabGuestSendPrompt/collabGuestAbort; CollabShareStatus.allowEdit. Host renderer: a background poller (startCollabHostPoll) that, while sharing with edit, runs a pending guest prompt through the host's OWN composer (send()) - so omp's scan gate + exec/egress approvals fire + the turn taps back to collab - attributed via a "Running <name>'s prompt" toast; resumes across reload via refreshShareDot. Guest Join panel: a prompt composer (+ Enter) when the welcome grants edit; the draft survives the transcript re-render. VERIFIED LIVE: allow-edit -> live edit share + edit link + "can edit"; join with the edit link -> "Watching LUCID session · Nick · can edit" + the prompt box. 63 collab tests + root/desktop tsc + license green.
- **stubbed:** the final host auto-submit running the guest prompt as a full omp turn reuses the proven /api/chat path (gate+approvals+tap) + is typecheck-clean, but wasn't run to completion in the preview (heavy: needs a live model turn + the backend was flooded by the app's background polling). Guest render stays a simple transcript (no tools/thinking).
- **next:** the renderer-side WebRTC integration (P2P); richer guest rendering; per-guest edit revoke.

**P-COLLAB.14 - LAN/VPN bind-address picker (ADR-0199)**
- **shipped:** the "be the relay" toggle now OFFERS this machine's network addresses (not just loopback), so a peer on your LAN/VPN can reach the relay directly. `desktop/collab/net_addrs.ts`: `classifyBindAddresses` (pure over os.networkInterfaces()) + `localBindAddresses` classify loopback / LAN (RFC1918) / VPN (Tailscale CGNAT 100.64/10 or a tunnel iface name) / other, ordered + de-duped + labeled with a reachability hint. relayServeStatus returns them; the toggle renders a "Reachable at" <select> + a "Custom address…" fallback (DNS / 0.0.0.0). Every bind is STILL authorized fail-closed on serve (authorizeRelayBind) - surfacing an address never bypasses governance. net_addrs.test.ts (4) - 67 collab tests + tsc + license green. VERIFIED LIVE: the picker offered this machine's real LAN 192.168.254.123, and selecting it started the relay bound to 192.168.254.123:8790.
- **stubbed:** no reachability probe; last-picked address isn't remembered.
- **next: the renderer-side WebRTC P2P integration (RTCPeerConnection is renderer-only -> renderer-side host+guest + demux over the collab transport + STUN + fallback); richer guest rendering.
