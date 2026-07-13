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
export const APP_VERSION = "1.11.3";
