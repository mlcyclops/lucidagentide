// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/version.ts — the single source of truth for the LUCID Agent IDE app version.
//
// The About panel reads APP_VERSION (bundled into the renderer), so bumping the version here
// updates the UI everywhere with no hardcoded duplicate in the markup. desktop/package.json
// MIRRORS this string (electron's app.getVersion() / electron-builder read package.json);
// version.test.ts asserts the two stay equal, so a bump in one is forced into the other.
//
// Launch baseline: v1.8.7. v1.8.8 = role onboarding + tour + providers reorg.
// v1.8.10 = Perplexity→Providers, set-note readability, Gemini model cards, macOS .pkg/cask.
// v1.8.11 = in-app network diagnostics (OAuth callback watcher) + OAuth re-login self-heal.
// v1.8.12 = OAuth broker lifespan fix (stdin:pipe) + device-flow support + auto-refresh.
// v1.8.14 = agent-trust UX (honest tool-failure chip, local-file egress, AI-LOC discoverability) +
//           role user guides + in-app browser Preview (panel, auto-surface-on-write, hardened sandbox).
//           (v1.8.13 skipped.)
// v1.8.15 = full-tree workspace folder browser (open a folder anywhere, ADR-0103) + bun trustedDependencies
//           so a from-source `bun install` actually installs Electron's binary.
// v1.8.16 = preview remote egress-gating (P-PREVIEW.3b) + every gate denial auditable & attributed
//           (P-ENT.4). Also carries the defensive, functionally-unverified agent preview_open (P-PREVIEW.3a).
// v1.8.17 = preview actually RENDERS the agent's apps: per-frame served CSP (P-PREVIEW.4b) fixes games that
//           showed only their HUD (a srcdoc frame inherited script-src 'self' and blocked inline scripts) +
//           agent-driven preview_open finalized against the real omp API + PREVIEW_POLICY steers the agent
//           to the panel instead of browser/eval/bash (P-PREVIEW.3a, PREFIX_VERSION 6).
// v1.8.18 = the agent can SEE its own rendered UI: preview_screenshot returns a PNG of the live preview as
//           ImageContent (P-PREVIEW.3a-shot) — renderer caches the shot, the read-tier tool fetches it.
// v1.8.19 = MULTI-FILE apps preview: fold an app's own relative css/js/img/fonts inline before serving
//           (P-PREVIEW.4c) so index.html + style.css + game.js renders under the same egress-blocked CSP.
// v1.8.20 = inline expandable code preview for tool steps (P-CHAT.1) — writes syntax-highlighted (Monaco),
//           edits as red/green diffs, "Open in editor →" into the full Monaco panel; FIX file-edit failures
//           via edit.mode=replace + native folder Browse (P-EDIT.1); preview auto-shows (no toast) + renders
//           nested-iframe wrappers (P-PREVIEW.4c follow-up); bigger default zoom + memory→$ icon.
// v1.8.21 = network whitelist FOUNDATION (P-NETWL.1, ADR-0106): a curated allow-list — internal/external
//           domain patterns (TLD `*.com` + exact sub-level) and IP/CIDR ranges, per-entry trust scope
//           (always|project|loop) + call budget — auto-allows egress on top of the per-site gate, always
//           under the enterprise-managed ceiling (fail-closed). Adds an OS-encrypted credential vault
//           (Electron safeStorage/DPAPI) for JWT/OAuth/SAML/PEM/API-key/basic secrets — stored encrypted or
//           REFUSED (never plaintext); native file picker + vault IPC/bridge plumbing. UI lands in .2–.4.
// v1.8.22 = network whitelist Settings UI (P-NETWL.2, ADR-0106): a "Network Whitelist" section to add/list/
//           remove domain patterns (`*.com` + exact) and IP/CIDR ranges by internal/external zone + trust
//           scope + call budget, with an optional auth credential (paste or native file upload) stored in the
//           OS-encrypted vault (fail-closed: refused, never plaintext). CRUD via /api/whitelist; a match is
//           read by the live egress gate to auto-allow under the managed ceiling.
// v1.8.23 = finish the whitelist set: ENFORCE project/loop trust scopes + per-loop call budget (P-NETWL.3 -
//           egressDecisionDetailed threads project+loop context; the loop runner caps auto-allows per host);
//           credential last-4 masking (P-KEYS.1, ADR-0107 - the vault stores <=4 chars, the UI shows ••••XXXX);
//           and click-to-whitelist on the Network-diagnostics DNS pills (P-NETWL.4 - a quick-add popover with
//           zone/scope/budget). All still under the managed ceiling, fail-closed.
// v1.8.24 = credential rotation (P-KEYS.2, ADR-0107): rotation VISIBILITY on each whitelisted key
//           (rotated Nd ago / rotation due / expires in Nd / expired - all from non-secret metadata) + manual
//           ROTATE-in-place (paste or file, same vaultRef preserved, rotatedAt bumped, last-4 refreshed;
//           fail-closed - the old secret is left intact if the OS keystore is unavailable). Optional
//           "rotate every N days" reminder on the add form.
// v1.8.25 = egress posture (P-NETWL.5, ADR-0108): two PRE-CHECKED personal-mode toggles - "Allow web search"
//           and "Allow all websites + local LAN" - so agents reach the internet out of the box. The curated
//           whitelist ENFORCES only when "Allow all" is off; with it on, egress auto-allows EXCEPT it still
//           prompts for a public IP literal or a foreign-country-TLD site. An enterprise managed policy clamps
//           allow-all off (the Support-Desk path). Scanner gate unchanged (still fail-closed).
//           ALSO Fable 5 in the model picker (P-IDE.1e, ADR-0109): enabled when a Claude account is connected
//           (OAuth or ANTHROPIC_API_KEY), it routes through Anthropic; carries a U.S.-government privacy notice
//           (row marker + hover banner + a persistent notice when selected).
// v1.8.26 = FIX live-chat tool calls (P-EXEC.2, ADR-0110): omp 16.1 moved per-tool approval to a FORM
//           elicitation the client must advertise; without it EVERY bash/eval/edit/delete call silently
//           failed with "Tool call denied by user" and no prompt. LUCID now advertises `elicitation.form`
//           + answers the approval (accept the affirmative option), so the approve/deny prompt surfaces and
//           gated commands run once approved (our session/request_permission gate stays authoritative).
//           ALSO fixes 12 CodeQL findings (stack-trace exposure, insecure temp files, postMessage origin).
// v1.8.27 = loop AAR + brief podcast + persistence fixes: chat history now SURVIVES app upgrades (stable
//           default workspace, not the versioned install dir - ADR-0111/P-WS.1); BROWSE past After-Action
//           Reports from the goal modal (ADR-0112/P-GOAL.14); the Engineering Update podcast now SYNTHESIZES
//           real audio (WAV) with inline play + Download, via Kokoro (air-gap) or ChatGPT/OpenAI TTS
//           (ADR-0113/P-BRIEF.4); the brief accordion relabeled so it's not mistaken for the loop AAR.
// v1.8.28 = engagement policy (P-CHAT.2, ADR-0114, PREFIX v7): a bare "hi" / new session no longer makes
//           the agent scan or edit the cwd unprompted - it greets, waits, and offers opt-in numbered next
//           steps drawn from context + KG recall (with "review the working directory" as an explicit choice).
// v1.9.0  = a big feature batch (ADR-0115..0128):
//   • VOICE (ADR-0115): ElevenLabs read-aloud + speech-to-text mic in the composer, offline Whisper/Kokoro
//     for air-gap, per-report cost hints, and TTS-friendly narration (codes/symbols/markdown stripped).
//   • ENGINEERING REPORTS rail (ADR-0116/0117): role-tailored briefs (developer/security/manager/executive)
//     + every loop After-Action Report, with copy / download .md / PRINT-to-PDF (white paper + "Prepared for")
//     / two-stage archive-delete / push-to-KG, plus a Ctrl/⌘+Space read-aloud hotkey and a NotebookLM link.
//   • SECURITY COMPLIANCE (ADR-0122): the Security brief ends with a NIST 800-171/800-53 + DISA STIG CCI
//     crosswalk, and exports an eMASS-aligned POA&M CSV + a native STIG-Viewer .ckl (DRAFT, analyst-validate).
//   • REPORT ANNEXES (ADR-0124): a change-annotated dependency graph + data-schema map (styled SVG image AND
//     copyable Mermaid for draw.io), page-broken as print annexes; green/red by lines added/removed.
//   • UI REVAMP (ADR-0118/0120): live "game-HUD" scoreboard (neutral-until-changed + clockwise racing pulse),
//     beautiful colour report charts with plasma-on-hover, custom premium SVG icons, print/PDF.
//   • EXEC TLDR (ADR-0119): a "TLDR" button explains an intimidating command in plain terms via a cheap model;
//     plus composer spell-check with correction suggestions.
//   • CHAT BACKGROUND (ADR-0125): a personal background image at 25% - ambient wash, or a flashlight that
//     reveals it only under the cursor like a dark room.
//   • PREVIEW MARKUP (ADR-0126): pen / rectangle / text markup over the preview (captured with the screenshot
//     to chat) + Browse-the-cwd; the token/s readout removed and the done-line contrast raised.
//   • CODE KNOWLEDGE GRAPH (ADR-0127/0128): ingest the workspace into a file-import OR TypeScript-AST symbol
//     graph in the KG canvas (click a node → open the file in the IDE), with a level-picker and an opt-in
//     read-only `codegraph_query` tool the AGENT can call to get blast-radius instead of reading many files.
// v1.9.1  = tag-only hotfix release (the #192 typescript-bundle fix so the packaged app starts); the in-repo
//           version strings were not bumped for it - reconciled here.
// v1.9.2  = battery-aware PERFORMANCE epic (ADR-0129..0132, #193): power/spec-aware render tiers (on battery
//           the KG goes calm/capped; LOW battery pauses the visualization - the agent's knowledge access is
//           never gated) + a #kgPerf mode chip; KG layout continuity (re-open = static paint, 0 sim frames)
//           + kinetic-energy early settle (~87% of the O(n²) budget skipped); incremental session index
//           (warm sidebar polls parse NOTHING) + tail-first transcript pages ("last N of M") + AC-only
//           idle prefetch; optimistic model switch + write-behind lastModel + memoized settings load/picker.
// v1.10.0 = big feature batch since 1.9.2: LOCAL/hybrid PROVIDERS (self-hosted / custom / VPN-routed
//           OpenAI-compatible LLMs, keys in the OS vault, ADR-0135); MULTIMODAL prompts (paste/drop
//           screenshots, ADR-0136); the agent REVIEWS + TESTS its work live in the preview (glow/pill +
//           read-DOM + click/type over a sandboxed postMessage bridge, ADR-0153); DESIGN.md invariants
//           honored per-turn + native FIGMA import & guided review via /figma (ADR-0154); Agent Builder
//           epic (allow-list chips, live canvas, portable share/import, n8n interop, /command authoring);
//           the Agent FIREWALL (fail-closed proxy to remote hermes/openclaw ACP agents) + in-process MCP
//           tool-result gate; and NEOVIM / terminal integration.
// v1.10.1 = the RUNTIME EXECUTION BOUNDARY epic (P-SANDBOX, ADR-0157): an approved subprocess is now
//           OS-isolated (Linux bwrap, macOS Seatbelt) and its egress is MEDIATED through a loopback proxy
//           decided by your curated egress policy - an import-time DNS exfil is refused + audited, and the
//           whole posture is visible in the Security panel (ADR-0159/0166/0167/0168/0169; Windows AppContainer
//           verified for deny-network, mediated egress disclosed as a managed/enterprise capability, ADR-0172/3).
//           Plus: model-picker FAVORITES (ADR-0165), multi-repo Engineering Reports + reach-out audit
//           (ADR-0162/0164), security review-ACKs + resumed-session history (ADR-0170/0171), a toolbox badge
//           for failed tool calls (ADR-0163), the LUCID TUI theme + bare `lucid` (ADR-0160/0161), and the
//           Plugin Marketplace popup (ADR-0158).
// v1.10.2 = the TRIVIA WIRE (P-TRIV.1-.3, ADR-0174/5/6): a role-aware word-game ticker in the status bar's
//           idle gap - 100-question developer/security/manager banks + 50 executive, streak scoring, idle
//           engagement, and the executive INTEL WIRE (curated defense/intel RSS, fetched first-party,
//           scan-gated FAIL-CLOSED, host-only egress audit) interleaving live headlines between questions;
//           status bar decluttered (model seg + gate-active pill removed, ticker text at chip white).
//           Plus the SKILLS GOVERNANCE suite + compiled KNOWLEDGE BASE (P-SKILL.4/.5, P-SKILLREG.1/.2,
//           P-KB.1/.2/.2b): the governed Skills directory + management menu, Skill Studio (draft skills
//           from recent work, gated), the enterprise registry reader/publish seams (Ed25519 + scan-gate),
//           and the compiled KB spine with graph migrations.
// v1.10.3 = HOTFIX (ADR-0177): v1.10.2's engine bricked at boot - packaging stripped node_modules *.md while
//           the engine newly imported @oh-my-pi/pi-coding-agent, which loads its prompt .md files at import.
//           Fix + robustness: .md no longer stripped; the omp import is lazy/fail-soft (a broken optional dep
//           degrades its feature, never the engine); engine output teed to <userData>/engine.log and the
//           failure dialog points at it; a packaged-boot CI guard emulates the filter so this class of brick
//           can never ship again.
// v1.10.4 = HOTFIX (ADR-0178): v1.10.3's skill discovery was broken-but-quiet in packaged installs - the
//           filter also stripped @opentelemetry, which omp's agent chain imports at load; discovered/codified
//           skills never appeared. Exclusion dropped; the packaging guard now materializes a REAL filtered
//           install (excluded packages absent, stripped file types deleted) and requires boot + every lazy
//           feature dep to load, so broken-but-quiet features fail CI too.
// v1.10.5 = the QUALITY batch (ADR-0179-0185): LIVE SUBAGENT ACTIVITY (the delegation card opens each
//           subagent's thinking/tool calls/output, tailed from omp's per-subtask transcripts, P-TASK.5);
//           graphs FORM IN PLACE (the KG/code-graph settle runs off-screen, opens snapped at the final
//           center, parked - no on-screen shake, P-KGVIZ.1); the SYSTEM RESOURCE GUARD (a weak CPU under
//           heavy load pauses the heavy graph builds behind a notice + top-processes panel + re-check,
//           FAIL-OPEN, P-SYSRES.1); the ELECTRON PREVIEW explained + runnable outside LUCID (user-clicked,
//           audited, P-PREVIEW.7); the KG header decluttered to "KG" + two labeled dropdowns (views + Data,
//           P-KGUI.1/.2); and the marketplace curated for fit (Mermaid/Gitleaks/Semgrep/Trivy/Pandoc in,
//           competitors out, P-MARKET.1b).
// v1.10.6 = the AGENT-TURN + MODEL-EVALUATION batch (ADR-0186-0191): the CHAT TURN REDESIGN - a settled
//           answer splits into collapsible sections on its own headings (P-CHAT.A), each tool call threads
//           back inline as an expandable chip with a +/- diffstat + code drilldown when it genuinely
//           interleaves - otherwise the rich activity window (tool steps + diffstats) and the expanded
//           subagent detail stay (P-CHAT.B/.B.1), and a settled file-writing turn offers a thin, subdued
//           "Generate engineering report" (P-CHAT.C/.C.1). The MODEL-EVALUATION suite: a pure metrics +
//           per-model API-latency core with direct/proxy/needs_signal honesty tiers (P-EVAL.1), the latency
//           capture hook + frozen api_latency/eval_metrics DuckDB tables (P-EVAL.2), per-run metrics
//           persistence + a cross-run rollup report kind in the Reports panel (P-EVAL.3). PATIENCE for
//           overloaded providers - a 10-min turn with an honest "still waiting" notice (P-STALL.1); and an
//           AI RE-SEED for the Trivia Wire (now default-OFF, an opt-in easter egg, P-TRIV.4).
// v1.11.0 = LIVE COLLABORATION (P-COLLAB, ADR-0192-0204): share a running LUCID session with another LUCID,
//           live + end-to-end encrypted. A host broadcasts its own ChatEvent stream over an E2E-sealed relay
//           (AES-256-GCM - the relay only ever sees ciphertext); a guest pastes an invite link and WATCHES
//           read-only, or - with a full/edit link - DRIVES the host's session (every guest prompt still runs
//           ON THE HOST through its own fail-closed scan gate + exec/egress approvals, so a guest bypasses
//           nothing). Self-hosted by default: "be the relay" on this device (loopback / LAN / VPN bind picker)
//           or run the standalone broker on a jumpbox; the public relay is opt-in. Enterprise/MDM governance
//           clamps who may host + which binds/relays are allowed (fail-closed). "Prefer direct connection
//           (WebRTC)" upgrades a share to a direct DTLS DataChannel - the relay only brokers the signaling
//           handshake, then peers go P2P, with automatic relay fallback - and a metadata-only audit trail
//           records share/join start/stop over both transports (never keys, links, or content).
//           Plus: a Copy button + right-click Copy for chat text & code blocks (P-COPY.1); the product website
//           in the About panel with its brand emblem inlined so it paints instantly; and the default zoom
//           pulled back a notch (what used to read 90% is the new 100%).
// v1.11.1 = HOTFIX: v1.11.0's packaged engine bricked at boot ("Cannot find module './collab/relay_server.ts'
//           ... could not start its local engine / blank window") - the extraResources `to:"repo"` filter
//           shipped `desktop/*.ts` (DEPTH-1 only) + `desktop/renderer/**`, so the brand-new `desktop/collab/`
//           dir (P-COLLAB, which dev.ts imports at boot) was excluded from the package. Fix: the filter now
//           ships `desktop/**/*.ts` (any depth), so a new desktop subdir can't be left out. Root cause of the
//           MISS: the packaged-boot guard (ADR-0177/0178) that exists to catch this NEVER RAN in CI (the job
//           ran `bun test harness` only) AND its own sim mirrored the depth-1 copy - both fixed: the guard
//           now copies desktop sources recursively, and CI runs it as a required step. This class (v1.9.0 /
//           1.10.3 / 1.10.4 / 1.11.0) is now gated, not shipped.
// v1.11.2 = ENTERPRISE PROVIDERS + IMAGES IN CHAT (ADR-0208/0210) on top of the KG-Packs / marketplace arc
//           (ADR-0205/0206/0207) landed since 1.11.1. Settings -> Providers now surfaces three omp-native
//           first-party providers it hid before: AZURE OPENAI (your Microsoft tenant's own deployments -
//           key + resource/base/version/deployment-map), GITHUB COPILOT via OAuth (the Business/Enterprise
//           "easy button" - a device-code sign-in that also handles a GitHub Enterprise domain), and GOOGLE
//           CLOUD - GEMINI ENTERPRISE (formerly Vertex AI: an API key, or gcloud ADC with project+location).
//           The existing Gemini OAuth card also gained a GCP project field, which is what makes Workspace /
//           Enterprise Google accounts sign in at all (without it omp aborts non-personal accounts). Under
//           the hood the provider descriptor grew multi-field config that rides the same key->env->omp seam,
//           so nothing new is stored. GENERATED / TOOL IMAGES now render INLINE in the chat reply (validated
//           fail-closed - SVG refused), each with a Download and a "Send to preview" that drops the image
//           under the markup canvas so you can annotate + Screenshot->chat to iterate (great for image gen).
//           Plus KG PACKS (named, swappable Knowledge Graphs + signed, sellable .lkgpack packs plus the
//           gated marketplace) and a headless `make kg-pack` builder. SECURITY: every dev-server error now
//           returns a generic client message (the full error stays server-side) - CWE-209 - and the CodeQL
//           SAST config excludes non-shipped mockups.
// v1.11.3 = BUG-FIX RELEASE (2026-07-13). Two defects autonomously diagnosed + fixed, and one usability
//           enhancement, by Claude Code. BUG (ADR-0211): AI-authored lines of code were recorded but never
//           appeared in the metrics UI ("AI-authored code" read "none yet"). Root cause: AI-LOC was written
//           only into agent_obs.duckdb, which the security gate holds open read-write for the whole session;
//           DuckDB is single-writer, so the desktop's read-only roll-up query lock-failed, the error was
//           swallowed to null, and the panel showed the empty state despite rows being in the DB. Fix: the
//           desktop now mirrors each edit into a lock-free GUI-owned ledger (~/.omp/lucid-ailoc.jsonl) it can
//           read live, exactly like the turns / security / latency logs; the DuckDB stays the audit record.
//           BUG (ADR-0210 follow-up): provider config fields (e.g. the Gemini "GCP project ID") rendered as a
//           tiny sliver squeezed between the label and the Save/Clear buttons; the label now sits on its own
//           line with a full-width input beneath it. ENHANCEMENT (ADR-0212): a written/edited file is one
//           click from the chat feed to your OS file manager, HIGHLIGHTED in its folder (a "Reveal" button).
// v1.11.4 = GOV HARDENING + RAG FOR EVERYONE + BETTER SESSION SHARING (2026-07-14, ADR-0214-0222).
//           ASKSAGE LOCKDOWN is now enforced SERVER-SIDE, fail-closed: every maker + checker + built-agent
//           turn is clamped to the accredited gov gateway (it was renderer-only, so it silently fell back to a
//           DIRECT model on a fresh launch or an omp respawn). CUI CONTROLS: a per-chat-session CUI vs Search
//           mode - a CUI session fail-closed BLOCKS all public web egress (no spillage), a Search session may
//           search while still gov-routed; a violet CUI banner, a DoD/STIG Notice & Consent banner (gov-gated,
//           per launch), and the AskSage Datasets picker restored to the titlebar. New GPT-5.6 gov models
//           (luna / sol / terra; the RAG route defaults to gpt-5.6-luna) verified live against the gateway.
//           CLONE: Settings -> "Clone a git repo" now clones PRIVATE repos headlessly (a host token, incl. a
//           vault-stored PAT) exactly like the agent does, instead of failing with a generic toast.
//           RAG FOR NON-ASKSAGE USERS: a `knowledge_search` tool lets ANY model (Claude / GPT / local) ground
//           on your OWN notes/docs - an Obsidian vault, folders, or imported chat history - LEXICAL today, and
//           SEMANTIC via bring-your-own embeddings (a local Ollama for air-gap, or your OpenAI/Azure key; no
//           bundled weights), with a "Semantic search" Settings card + a Test-endpoint probe + Re-index.
//           SHARED SESSIONS: a viewer now sees the host's THINKING + TOOL CALLS (not just the final answer),
//           and the watch window fills the app instead of a small centered modal.
// v1.11.5 = "LUCID AGENT" RENAME + AIR-GAP-CAPABLE INSTALLER (2026-07-14, ADR-0225). The app now shows as
//           "Lucid Agent" (shorter icon/shortcut label); the appId is UNCHANGED so auto-update + your chat
//           history carry over. INSTALLER FIX: first launch no longer phones home. The two runtimes that used
//           to be FETCHED on first run - the omp agent (`bun add -g`) and the scanner's Python (`uv venv`) -
//           are now BUNDLED and resolved offline (a relocatable CPython 3.12.13, SHA-pinned/fail-closed; omp
//           via the vendored package + bundled bun). An air-gapped host works cold, and a CI air-gap gate runs
//           the packaged omp + scanner from bundled resources on every build so a non-self-contained installer
//           can't ship. (v1.11.5 was PULLED before release - see v1.11.6.)
// v1.11.6 = fixes two regressions the v1.11.5 rename introduced (ADR-0225): (1) a spaced productName
//           ("Lucid Agent") gave the Linux rpm an `/opt/Lucid Agent` path that rpmbuild rejects (spaces break
//           the spec %files), and (2) more seriously, changing productName moved Electron's userData dir
//           (app.getName()-keyed), which would ORPHAN every existing user's settings/vault on upgrade. Fix:
//           productName stays "LucidAgentIDE" (so userData + the rpm path are unchanged) and the "Lucid Agent"
//           label is applied per-OS at the DISPLAY layer only - Windows shortcut name, macOS
//           CFBundleDisplayName, Linux .desktop Name - never touching app.getName()/userData.
//           (v1.11.6 built Win+mac but the Linux air-gap gate caught a bundling bug - see v1.11.7.)
// v1.11.7 = the air-gap installer, complete on all three OSes (ADR-0225). The bundled relocatable CPython
//           ships `bin/python3` as a SYMLINK to the real `bin/python3.12`; electron-builder dropped that
//           symlink when copying into the Linux package, so the packaged app had no interpreter (the CI
//           air-gap gate caught it on Linux; Windows/mac were unaffected). Fix: copy the Python tree with
//           symlinks DEREFERENCED (all real files, nothing for packaging to drop) and resolve `python3.12`
//           as a fallback. v1.11.5/.6 were pulled; this is the first fully-built, gate-green air-gap release.
// v1.11.8 = the consolidated fix release that supersedes the pulled v1.11.4/.5/.6/.7. Rolls up the whole
//           clean-machine fix batch onto one build: the CRITICAL air-gap fix (bundle a plain `bun[.exe]`
//           alias so omp's shim starts with no global bun - the real cause of "bun is not installed", no
//           AskSage models, and no OAuth on a cold box), reliable OAuth connect/disconnect (same-omp broker
//           + visible sign-in URL + authoritative logout), the overloaded-provider no-response fallback
//           (P-NORESP.1), the model-picker freeze safety-net, and the v1.11.7 Linux air-gap Python fix.
// v1.11.9 = PERFORMANCE (P-PERF.3): fixes "LUCID is slow / model replies crawl back". The live-dashboard poll
//           was hammering four observability endpoints continuously; each re-aggregated the ENTIRE history
//           (~1300+ sessions) and — worst of all — spawned an omp subprocess synchronously just to read static
//           compaction config, blocking the server's single event loop (and the model stream) for seconds every
//           few seconds. Fix: gate the poll (don't run it during a stream or when its panel is closed), memoize
//           the obs reads, and cache the underlying scans/DuckDB-opens/omp-spawn so repeat polls are ~0ms
//           (usageLedger 958ms→2ms, memorySnapshot ~4s→0ms warm). Idle server CPU dropped ~29%→~8% of a core.
// v1.11.10 = mobile-safe Share invites (P-SHARE.3: the https phone link is featured + QR'd; the wss
//            LUCID-to-LUCID link is demoted to a labeled "desktop only" row and never offered/QR'd to a
//            phone, closing the room-secret-in-the-path leak) + first-run Government/CUI onboarding
//            (P-GOVCUI.1: asks once, prefills the AskSage CIV gov endpoint with token steps; a key turns
//            lockdown ON, keyless never flips it) + the 11-SKU KG-pack storefront reconcile (SPM flagship
//            replaces capture) + the Remote PWA /r forwarder and comp-grant entitlement auto-recheck.
// v1.11.11 = Session Share + preview polish. Instant Start/Stop for Session Share (P-SHARE.4: a two-line
//            handshake progress readout under the button + optimistic teardown, so neither action hangs);
//            readable Thinking on the phone PWA (P-REMOTE.9b: the live reasoning block streams open with a
//            gist summary and stays open across repaints); reliable preview screenshots/inspection for
//            tool-conservative models like Fable 5 (P-PREVIEW.9: trigger-prescriptive tool descriptions +
//            self-correcting fallbacks to preview_inspect); and the Linux air-gap sandbox fix (functional
//            bwrap probe so Ubuntu 24.04's blocked user namespaces no longer kill the model picker, plus
//            shipping omp's native addon next to the compiled launcher).
// v1.11.12 = reliable OFFLINE VOICE + bundled Whisper installers. Fixes dictation showing "heard you, but
//            nothing transcribed": the mic recorded WebM/Opus but whisper.cpp's /inference decodes WAV/PCM
//            only, so every clip 400d; the composer now transcodes each utterance to 16 kHz mono 16-bit WAV
//            before upload. Also strips whisper's non-speech tokens ("[BLANK_AUDIO]", music notes) so a silent
//            tail merges nothing, and only falls back to the OpenAI /v1 shape on a real transport failure, so a
//            healthy whisper.cpp that heard silence is never mislabeled "no STT server answered". Ships the
//            zero-prereq BUNDLED offline Whisper installers on all 3 OSes (P-STT.2c/.2d), the mic waveform
//            (P-STT.4) + orphan whisper-server reaper (P-STT.5), the Provider Hub + one-click local-model
//            presets (P-PROV.2 / P-LOCAL.4), and the model-picker cold-start warm-poll.
// v1.12.0 = Voice mode. Hands-free conversation (Ctrl/Cmd+G: streaming read-aloud that starts after the
//            first sentence, auto-mic on finish, silence sends the turn), answers shaped for the ear,
//            the glowing pop-out equalizer, spoken thinking acknowledgements, and the truth-telling
//            per-engine voice picker (P-VOICE.2-.6, ADR-0246/0247).
// v1.12.1 = the LUCID Trainer + role-generic training packs + the LUCID Agent immersive role
//            (scenario-first expert interviews, fail-closed distillation, teach-back promotion,
//            drills from confirmed knowledge; P-TRAINER.1-.9, ADR-0252..0257).
// v1.12.2 = the Windows Program Files fix arc + no-cutoff turns: compiled engine (bin/lucid-engine),
//            the strict CI boot gate from a real write-denied Program Files tree, per-machine installs
//            re-enabled, event-driven transport-death rejection + pending-task visibility
//            (P-WINBOOT.2C/.3 + P-STALL.2, ADR-0259..0263).
// v1.13.0 = the Fleet Manager: async job handles through the Agent Firewall (dispatch/status/cancel
//            over one fail-closed path), local lanes streaming into the movable fleet-grid dock with
//            fail-closed approval glows, Fleet Profiles, spoken thinking snapshots, an ingest that
//            cannot hang, real OS folder dialogs from the browser build, and no turn clock
//            (P-FLEET.1/.L1/.P*, ADR-0264..0272).
// v1.13.1 = unlimited fleet lanes under the sustained-pressure guard (90% held 30s; the cap deleted),
//            lanes spawned straight from GitHub/GitLab/Azure DevOps remotes with per-host tokens in the
//            OS-encrypted vault, the real OS folder dialog in the lane form, and the truthful minimized
//            per-state pill (P-FLEET.L2, ADR-0273).
// v1.13.2 = the fleet fidelity arc: no lane turn clock + Retry/Respawn recovery spawns with memory
//            (session/load or transcript replay, approvals re-asked), diff chips + pasted-image
//            thumbnails + staged prompt queues in lane cards, the durable lane-session ledger, and the
//            reviewable Timeline dock across every workspace (P-FLEET.L3/.L4/.L5, ADR-0274..0277).
// v1.14.0 = the control + reach arc: fleet approval SCOPES (Allow / Allow-for-session / Deny) and a
//            full auto-mode behind an explicit risk acceptance; MID-TURN interjection (the security
//            gate's tool-result seam carries a typed note to the model at its next tool boundary),
//            stacked hold-or-push prompt queues, check-in cards, and a running-processes popover; an
//            agent-controlled VISIBLE browser window (open / screenshot / scroll / click / type / drag /
//            keys, egress-gated, breathing glow, close-X kill switch); per-lane Preview tabs plus auto
//            send-to-phone; workspace INIT offers that scaffold the .agents framework; the phone PWA
//            gains fleet control (name filter, prompt / stop / approve) and OPTIONAL device-native STT
//            that is refused unless the audio can be PROVEN to stay on the device; the Timeline hides
//            its own self-test throwaways and becomes a two-pane inspector; ACP child stderr persists
//            to ~/.omp/lucid-acp.log and a code-1 exit quotes its last line (the "no response from the
//            provider" support ticket); and on Windows every port-keyed instance now shares ONE
//            safeStorage os_crypt key, so a vault credential written by one instance is readable by the
//            next and the Local Provider stops vanishing from the picker; and the site + About link move
//            to the canonical lucid-agents.com (the PWA and sign-in origin stay on lucid-agent.web.app,
//            where the OAuth authDomain is registered) (P-FLEET.L6, P-WSSETUP,
//            P-INTERJECT.1, P-BROWSER.1..3, P-REMOTE.14, P-TL.2/.3, ADR-0278).
// v1.14.1 = the phone follow-through + the honest gate: the PWA composer collapses to ONE row (same-family
//            controls fold into menus, Queue and Send merge, the voice caution moves behind an amber-aware ?),
//            the fleet strip costs 33px collapsed (double-decker with the desktop pill's own count pips,
//            per-lane composers, desktop-matched lane colours), a lane's CONVERSATION reaches the phone
//            (subscribe-only watch frames unicast to peers that asked, bounded lane-sync replay, a distinct
//            lane-error chip), per-target seen counters draw a "new since you looked away" boundary that
//            Sync scrolls to, and no phone panel ever opens itself (P-REMOTE.15, P-PWA-FLEET.2,
//            P-PWA-FOCUS.1/.2, ADR-0298..0302). The Preview panel gains deterministic CAPTURE (a scene
//            defining lucidRenderAt is stepped on LUCID's clock, fingerprinted against a measured readback
//            noise floor, and compared to its baseline with the method named; ADR-0297). The test gate now
//            measures what it claims (scope by exclusion, ADR-0303). And the Creator flavor lands on trunk
//            behind build_flavor gates with its own creator-v* release channel that can never cross-install
//            with Agent (ADR-0279..0296, 0304).
// v1.14.2 = the trust-boundary pass, all four increments traced back to ONE field report ("v1.14.1 installed
//            a different product"): the window can no longer render a STRANGER - main mints a per-launch
//            nonce, the engine echoes it on /api/health, and a foreign process squatting the engine port
//            fails LOUDLY with a pasteable incident report naming the process, pid, start time and command
//            line, never a silent roll onto someone else's UI (P-PORTGUARD.1, ADR-0305); CI now reads each
//            artifact's EMBEDDED identity before upload (pkg bundle id + payload .app path, deb package
//            name, rpm lead, the updater feed's declared path) so a mis-flavored or mis-versioned build
//            fails the build instead of reaching a Release (P-RELEASE.4, ADR-0307); agents get real
//            Word/Excel/PowerPoint through a pinned, digest-verified OfficeCLI as a GATED skill with the
//            render-look-fix loop on the existing Preview tools, graded per subcommand by exec_policy
//            (P-OFFICE.1, ADR-0306); and the Preview panel obeys the agent again - preview_open reports
//            itself over its own channel instead of relying on an ACP call title that omp's intent tracing
//            rewrites to the model's prose, which had also left every preview activity pill dark
//            (P-PREVIEW.11/.11b, ADR-0308). Plus two stacked chat scroll helpers for long sessions (step a
//            page, or run to the end) and paste-safe Homebrew docs (stock zsh does not strip # comments).
// v2.0.0 = the major, and the reason it is a MAJOR rather than a 1.15: this batch changes defaults users
//            were relying on and REMOVES models from the catalog, which is what a major version exists to
//            announce. Eighteen increments (ADR-0309..0326), the largest batch in the project's history.
//            MODELS: the catalog moves to the current generation and stops going stale - Claude Opus 5 as
//            the house default (1M ctx), GPT-6 Astra (1M, the first OpenAI generation to match Claude's
//            window), the Gemini 3 / 3.1 Pro + 3.5 Flash family, Fable/Mythos 5.1, with the picker default
//            following the USER instead of a hardcoded id, capability tiers derived from one source of
//            truth (a hand-copied third regex had never learned GPT-6 and mis-ranked a flagship as a
//            workhorse), and a deprecation floor that DROPS superseded ids (GPT below 5.4) - the breaking
//            half of the model story (P-MODEL.2, ADR-0317).
//            LOOK: light mode arrives with SEVEN themes and a picker, after a dark-only lifetime; every
//            palette is token-complete by test, because a light theme that forgets one token inherits the
//            dark base and ships unreadable (P-THEME.1, ADR-0320). P-THEME.2 then makes the DEFAULT honest:
//            "never chosen" used to mean "follow the OS", so shipping light mode moved long-time users off
//            the dark UI they already had; unset now means Lucid Dark and following the OS is an explicit
//            choice (ADR-0326).
//            SESSIONS THAT FINISH: the harness watches its own sessions and recovers a wedged one in place
//            (ADR-0311), and now RESUMES the run that recovery interrupted, with a short operator note and
//            a plain notice that it is picking up where it left off - bounded per run, never after a user
//            Stop (P-HEALTH.2, ADR-0324). A dropped engine stream no longer freezes the composer in
//            silence while the turn keeps working.
//            THE FLEET GROWS UP: lane tool-call fidelity and the repaint that was eating transcripts
//            (ADR-0309), promote a lane into the main composer as an ATTACH rather than a handoff
//            (ADR-0310/0314), dismiss a lane (ADR-0313), a spend meter that refuses to invent numbers
//            (ADR-0312/0315), and cards you can actually size and drag: pixel widths tracking the pointer
//            1:1, headers that wrap instead of clipping, a real grab grip (P-FLEET.L12, ADR-0325).
//            THE AGENT WRITES TO MEMORY: it can finally write to the knowledge graph, and a locked vault
//            stops lying about what it holds (P-KG.3, ADR-0319).
//            PREVIEW BECOMES A SURFACE: twelve renderable kinds, rendered markdown, working PDFs, and an
//            auto-open trigger narrowed back to html/svg/pdf after it started hijacking the screen for
//            every .md and .json an agent writes (ADR-0321/0322/0323, P-PREVIEW.15..18).
//            Plus: tools that name themselves so evaluation can attribute them (P-EVAL.4, ADR-0318), a
//            login confirmed by the VAULT rather than an exit code (ADR-0316), one-gesture bulk dismissal
//            of a 100-row security queue, and the test suite no longer appending its fixture blocks into
//            the operator's real security ledger (P-SEC.4).
// v2.1.0 = the OAuth fix users actually needed, plus lane scroll affordances.
//            AUTH: "Connect via OAuth" failed on packaged Windows installs with Bun's own
//            `EPERM reading ...pi-coding-agent\dist\cli.js`. The resolver accepted LUCID_OMP_BIN because
//            the path EXISTED, so the broker spawned a file it could not read inside the ACL-protected
//            app directory. NOT a 2.0.0 regression: the offending resolver landed in c2d8cf9 (2026-07-15)
//            and shipped in every tag from v1.11.8 onward, so this had been broken for anyone whose
//            install directory denied the read. Existence was never the question; runnability is, so the
//            resolver now PROBES each candidate by running `--version` and falls through to one that
//            works, logging every path it tried when none do. Three files had grown private copies of
//            that resolver and had already drifted once (c2d8cf9 exists only because the broker picked a
//            different omp than the model list); they now share desktop/omp_bin.ts, so the class cannot
//            recur (11 tests).
//            FLEET: a lane transcript scrollbar you can actually grab (the global thumb is 5px of
//            pointer target once its 3px transparent border is accounted for, fine on a full-height chat
//            and unusable in a 300px card), plus the main composer's two catch-up buttons per lane (step
//            a page keeping a line of overlap, or run to the newest line). The arithmetic moved to
//            renderer/scroll_jump.ts and BOTH the chat and the lanes read it, so the chat can never get a
//            tuning pass the lanes miss (11 tests, aimed at the NaN scroll target that fails invisibly).
// v2.2.0 = the reported fixes, plus the two surfaces that had no way in.
//            FLEET: a lane could not run bash or eval AT ALL. There are TWO approval gates in front of a
//            tool call: ours (ACP `session/request_permission`, which lane auto-approve resolves with no
//            human) and omp's own per-tool gate, which it raises as an `elicitation/create` request. The
//            lane had a handler for that request and had never ADVERTISED the capability, so omp never
//            sent it and denied every bash and eval regardless of what the user had configured
//            (ADR-0337). Fixing the advertisement exposed the second half: the handler read the offered
//            options from the wrong path and answered in the wrong shape, so waking it up still resolved
//            to nothing (ADR-0338). Both halves now live in exec_policy.ts and BOTH interactive clients
//            import them, so a third client gets it right by construction. Confirmed on a live DGX lane.
//            PREVIEW: a FAILED preview was photographed and published to a phone guest, toast baked into
//            the shot and captioned with a file from an unrelated session, because /api/preview/serve
//            answers a failure with HTTP 200 and an HTML body that says so, so every guard read it as a
//            working page. The gate now PROBES the target, hides the toast for the capture, and claims
//            the rate-limit slot only once a send is authorized (ADR-0335). Separately, the panel no
//            longer follows the user into the next conversation: an unresolvable target was remembered
//            exactly like a success and outlived the session boundary (ADR-0339). A file the user opened
//            by hand is still left alone, broken or not.
//            KG + MARKET: the Role KG Packs storefront gets a button in the KG header (until now the only
//            way in was typing its name into the command palette), a purchase RESUMES the exact pack after
//            the sign-in detour under a 15-minute one-shot intent (the deep link is shared with LUCID
//            Remote and Drive, so it must not turn every future sign-in into a payment page), and the
//            Personalization card is rebuilt for a user with MANY named KGs: a hero row opening the
//            existing picker plus a two-row stat strip (ADR-0333, ADR-0336).
//            RELEASE: the rolling `latest` channel can publish at all. The identity gate compared deb and
//            rpm versions literally, so every prerelease failed it (`~` is the only legal separator in
//            those formats), and a publishing dispatch stamped itself as a test build (ADR-0332).
export const APP_VERSION = "2.2.0";
