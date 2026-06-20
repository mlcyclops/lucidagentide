# PROGRESS.md

Three lines per session: **shipped / stubbed / next** (CLAUDE.md session ritual).

-----

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
- **next:** build **P8.1 memory-recall** first (migration 0007_memory_session.sql + EventName
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
