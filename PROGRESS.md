# PROGRESS.md

Three lines per session: **shipped / stubbed / next** (CLAUDE.md session ritual).

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
