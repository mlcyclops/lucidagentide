# LUCID Agent IDE: UI/UX review (complexity and usability)

Increment P-SETUX.1, ADR-0617. Baseline date 2026-11-20 (master). This document is the baseline the
UX PR gate protects (`docs/UX-PR-CHECKLIST.md`, `tools/ux_pr_gate.ts`, AGENTS.md invariant #12).
Update section 2 counts in any PR that changes them.

Settings is being reworked concurrently (ADR-0615: a categorized Settings window with an Overview page;
ADR-0616: a Quick-connect MCP catalog limited to official vendor endpoints). Findings below describe
Settings as it exists on master and say which ones the rework closes.

## 1. Method

- Code read of the served surfaces, not a linear read of `desktop/renderer/app.ts` (21,369 lines): the
  shell markup in `buildShell()` (`app.ts:434-760`), `settingsShell()` (`app.ts:6809-6842`), the rail
  dispatcher (`app.ts:17800-17830`), `renderMetricsRail()` (`app.ts:4226-4290`), `openSettings()`
  (`app.ts:7241-7262`), the onboarding chain (`app.ts:4724-4990`, `5729`), and the module surfaces
  (`fleet_grid.ts`, `ask_lucid_panel.ts`, `plugins_flyout.ts`, `skills_dir.ts`, `kg_header.ts`,
  `creator_studio.ts`, `ui.ts`, `tour.ts`).
- Every `z-index` on a fixed or overlay selector in `desktop/renderer/styles.css`.
- The user's reports: Workspace opens Settings behind the Fleet window; Settings is a 540px flyout of
  about 30 collapsed cards including a headerless "Semantic search" blob; the right rail shows 8 tiles of
  zeros; composer placeholder "Ask the agent...  every tool call is scanned before it runs".
- Line numbers are from master at the start of P-SETUX.1. The concurrent Settings rework shifts
  `app.ts` lines, so every citation also names its function, id or selector: that name is the stable
  anchor; the line is where it was on master.
- Lens: a new Community-edition user with no provider and no workspace. Each finding has surface,
  evidence, impact and a concrete recommendation. P0 = blocks or misleads a core task; P1 = adds load
  or hides function for most users; P2 = polish, consistency, hygiene.

## 2. Complexity inventory (baseline counts)

| Surface | Count | Evidence |
|---|---|---|
| Title bar controls in markup | 17 (model, repo, Persona, Skills, Datasets/Knowledge, More, CUI, Search, zoom out, zoom level, zoom in, Agent tier, Ask Lucid, Stage, 3 window) | `app.ts:438-470` |
| Title bar controls visible on a fresh install | 9 at baseline; 6 after ADR-0620 (model, zoom magnifier, Ask Lucid, 3 window). Skills shows only while a skill is active, Datasets only for AskSage | `app.ts:438-470`, `13939-13980` |
| Left rail buttons in markup | 19 | `app.ts:475-496` |
| Left rail buttons visible by default | 16 (17 in a Creator build) | `#railRemote`, `#railStudio`, `#railLogs` hidden |
| Left rail buttons with a visible text label | 0 | all `data-tip` only, no `aria-label` |
| Sessions sidebar controls | 6 (workspace bar, new, collapse, search, agent-sessions toggle, resizer) | `app.ts:500-511` |
| Composer toolbar buttons | 5 at baseline; 6 after ADR-0622 (Add, Dictate, Voice, Fleet, Timeline, Visualize; the titlebar gave up 3 visible controls in the same change); 5 when policy hides Add; plus 3 conditional | `app.ts:555-575` |
| Inspector tabs | 2 (Security, Memory) + Resources in Creator builds + collapse | `app.ts:585-592` |
| Metrics rail tiles | 6 always (savings, avg/turn, context, turns, findings, quarantd) + up to 3 conditional | `renderMetricsRail()`, `app.ts:4246-4276` |
| Settings cards in `settingsShell()` | 25 titled cards always, 27 when both conditional cards render, + 1 headerless note = 28 entries | `app.ts:6809-6842` |
| Settings cards expanded by default | 0 (`SET_OPEN` starts empty) | `app.ts` `SET_OPEN` |
| Settings deep-link helpers | 6 separate functions (`openSettingsToAsksage`, `...LocalProviders`, `...Providers`, `...Voice`, `...Mcp`, `openPersonalizationSettings`); no Workspace target | `app.ts:4913-4970`, `9203` |
| Right-edge surfaces competing for the same edge | 9 (Settings, IDE panel, Skills, Knowledge, Meetings, Remote, Preview, Agent Builder, Trainer) + Ask Lucid + Fleet dock | `app.ts:17811-17818` |
| Distinct overlay types | 8 (scrim modal, side panel, floating panel, dock, full-screen view, popover/menu, toast, tooltip) | section 3 |
| Distinct overlay z-index values | 18 (55 to 1200) | section 3 |
| Icon-only controls in the primary shell | 35 (19 rail, 4 composer + Add, 3 window, 2 zoom, send, new session, collapse, agent toggle, inspector collapse, rail expand); 2 carry an `aria-label` (`#ctPlus`, `#sessSpokes`) | `app.ts:434-600` |
| First-run gates before the first prompt | up to 4 modals (role, email, gov/CUI, provider) + a 4 to 7 step tour | `app.ts:4774-4780`, `tour.ts` |
| Fleet dock header controls | 5 + headroom readout at baseline; 4 after ADR-0634 (Ask, Agent, More, Minimize, plus Next only when an agent needs you: Close removed, it hid the panel like Minimize but left no pill); 9 more behind "More" | `fleet_grid.ts:311-321`, `251-262` |
| Plugins flyout tabs | 3 (Premium, Free, Installed) | `plugins_flyout.ts:293` |
| Creator Studio sections | 3 (Integrations in 6 groups, Recent jobs, Track library) | `creator_studio.ts:83-90`, `288-319` |
| Knowledge graph header controls | 4 + close (search, Auto, Personal views menu, Data menu) | `app.ts:632-644` |
| Toast durations in use | 16 distinct values (1800 to 10000 ms) + never-dismiss | `app.ts` `showToast` calls |

Complexity budget for future PRs: these numbers only go down unless a PR justifies the increase
(checklist item 1).

## 3. Overlay stack

Every overlay a PR adds names its tier here. Settings currently has no tier: it is a layout column
(`.settings`, `styles.css:3689`, no `position`, no `z-index`), which is the root of finding P0-1.

| Tier | z-index | Selectors (styles.css line) |
|---|---|---|
| Content | auto, 26 | Skills/Knowledge/Meetings asides, inspector; `#prevCurtain` composer preview chip at 26 inside `main.center` (ADR-0621). P-PREVIEW.CHIP1: the same chip (`.pchip`) floats in a fleet lane's transcript corner (`.pchip-host`, 4 inside `.fleet-out-wrap`, under the lane's jump pair at 5), just above an orbit spoke card (inside the card), and beside agent nodes in Visualize (3 inside `.viz-stage`, hover card `.pchip-pop` at 6) |
| Dock | 55 | `.share-dock` / `#fleetDock.fleet-dock` (5471) |
| Side panel | 90 | `.ide-panel` (5052); `#preview` Preview fly-out (3801), above a floating Fleet dock (ADR-0645) |
| Full-screen view | 92, 93 | `.orbit-view` Fleet Orbit (7005); `#vizView` Visualize (93, ADR-0622) |
| Panel over Visualize | 94 | `#preview.over-viz`: the Preview fly-out opened while Visualize is up (an Agent Worlds preview chip, P-PREVIEW.CHIP1). Same column, resize edge and `lucid.preview-w` width; Visualize keeps running behind it and is not modal meanwhile. Its X, Esc (focus in the panel, or a first Esc anywhere in Visualize) or a press on the world slide it back to the chip. Shares 94 with the titlebar callout, which comes later in the DOM and stays on top |
| Titlebar callout | 94 | `.relogin-notice` re-login callout under the model pill (ADR-0640); one below Popover so an opened picker covers it |
| Popover | 95, 96 | `.popover` (2918), `.vdock` voice panel (3202) |
| Settings | 97, 98 | `#setScrim`, `#settings` window or panel (ADR-0615); popovers opened from Settings lift to 99 |
| Palette | 100, 101 | `#scrim` (2885), `.palette` (2889) |
| Sheet | 110, 111, 115, 120, 121 | `.fb-scrim`/`.fb` (4935-4939), `.plg-layer` (1975), `.dod-scrim`/`.fb.dod` (5657) |
| Coach | 142 | `.coach-card` tour (3572) |
| Modal | 200 | `.modal-ov` (4130), `.figma-scrim` (1853), `.mkt-scrim` (1937), `.goal-scrim` (2127) |
| Ask Lucid | 250 | `.ald`, `.ald-pill` (7999, 8050); popovers opened from inside it lift to 251 (`popoverLayer`, ADR-0632); when docked, `.viz-view` and `.orbit-view` end at its edge |
| Cinematic | 300 | `.boot-cine` (3539), `.about-ov` (4177) |
| Toast | 310 | `#toasts` (3044): above every scrim, so a toast a dialog raises (the Provider Hub's "Nothing to save") is read, not dimmed behind its own backdrop (P-OVERLAP.1, ADR-0693); below context menus and `#tip` |
| Context menu | 400 | `.ctx-menu` (5299) |
| Tooltip | 1200 | `#tip` (2865) |

Target: replace the literals with named tokens (`--z-dock`, `--z-panel`, `--z-fullscreen`, `--z-popover`,
`--z-sheet`, `--z-modal`, `--z-ask`, `--z-cinematic`, `--z-menu`, `--z-tip`). Settings, once a window,
sits at the modal tier: above Fleet (dock 55, orbit 92) and below Ask Lucid (250), so Ask Lucid can
still be summoned to explain a setting.

## 4. Findings

### P0

**P0-1. Workspace opens Settings at the top, behind the Fleet window.**
- Surface: sessions sidebar workspace bar (`#wsBar`), Settings, Fleet Orbit.
- Evidence: `app.ts:19739` binds `#wsBar` to `openSettings()` with no section. `openSettings()`
  (`app.ts:7241-7252`) closes Knowledge, IDE, Skills, Meetings and Remote but not the Fleet Orbit
  (`.orbit-view`, `position:fixed; z-index:92`, `styles.css:7005`), the Fleet dock (z 55, `5471`) or Ask
  Lucid. `.settings` has no z-index (`styles.css:3689`), so it paints under both. No
  `openSettingsToWorkspace` exists among the deep-link helpers (`app.ts:4913-4970`). `openSettings()`
  also collapses the sessions sidebar (`app.ts:7248`), so the bar the user just clicked disappears.
- Impact: the click appears to do nothing; the user cannot change the workspace while Fleet is up.
- Recommendation: one API `openSettings(section?: SettingsSection)` that raises Settings above every
  dock and full-screen view (modal tier, section 3), expands and scrolls to `section`, and is used by
  every caller (`#wsBar` -> `"workspace"`). Delete the six per-section helpers. Closed by ADR-0615 if it
  lands with this API; verify with Fleet Orbit open.

**P0-2. Settings is a 540px scroll of 25 to 27 collapsed cards with no structure.**
- Surface: Settings.
- Evidence: `settingsShell()` `app.ts:6809-6842`; width `min(540px,46vw)` `styles.css:3689`; every card
  collapsed (`SET_OPEN` empty); no search box, no category, no status summary.
- Impact: a new user cannot tell what is configured or where a setting lives; related cards are far
  apart (titled-card positions: Providers 4, Local providers 6, More providers 15; Theme 19 sits after
  Credential vault 12 and Voice 16; the AskSage gateway, a government-only card, is 5 of 25 for everyone).
- Recommendation: a full Settings window with a left category list and an Overview page (ADR-0615).
  Proposed categories (each card lands in exactly one): Overview; Workspace (workspace, profile);
  Models (providers, more providers, local providers, AskSage gateway + quota, restricted-origin
  models, subagents, judgment); Connectors (MCP + Quick connect, remote agents); Knowledge (semantic
  search, token compression, personalization); Security (network whitelist, credential vault, vault
  destinations, import from .env); Appearance (theme, chat background, chat scrolling, working status,
  Mini Lucid, trivia); Voice; Advanced (developer). 9 categories, each 1 to 7 cards. Keep a search
  field over card titles and subtitles. Flyout mode stays as an opt-in preference that still overlays.

**P0-3. No view of what is connected; MCP connection is a blank form.**
- Surface: Settings "MCP connectors" (`app.ts:6825`, subtitle "model context protocol"), entry
  `openSettingsToMcp` (`app.ts:4968`), callers `openConnectors` (`app.ts:18555`).
- Impact: users find MCP servers by web search, where look-alike servers imitate vendor names; nothing
  tells them which providers, connectors and vault entries are live.
- Recommendation: Overview page listing every connected provider, MCP server and remote agent with a
  status dot; Quick-connect catalog of official vendor endpoints only, each verified against the
  vendor's own docs domain, replaced by the organization's authorized list when managed (ADR-0616).

### P1

**P1-1. Left rail: 16 to 19 unlabeled icons, no grouping, no accessible names.**
- Evidence: `app.ts:475-496`; every button is `data-tip` only, none has `aria-label`; one spacer before
  About/Commands/Settings.
- Impact: hover-to-learn on 16 icons; screen readers announce "button" 19 times.
- Recommendation: cap visible rail at 10. Group with separators (Work: chat, preview, share; Knowledge:
  memory, knowledge, skills, meetings; Build: agent builder, trainer, reports, plugins). Move About into
  Settings/Help and Commands into the title bar search affordance. Add `aria-label` from the tip title.
  Offer a labelled expanded rail (icon + text) as the new-user default.

**P1-2. Duplicate entry points with different names.**
- Evidence: rail Security and Memory call `focusInspector()` (`app.ts:17818`), the same as the inspector
  tabs (`app.ts:588-589`). Ask Lucid: title bar (`app.ts:464`), Fleet "Ask" (`fleet_grid.ts:317`),
  Ctrl+Shift+L. Plugins: rail says "Free plugins" (`app.ts:487`), the drawer opens with "Premium" first
  (`plugins_flyout.ts:293`). Fleet lives in the composer toolbar as a 15px bolt icon (`app.ts:565`), not
  on the rail.
- Impact: users learn two names for one thing and cannot find the headline Fleet feature.
- Recommendation: drop rail Security/Memory (inspector already shows them) or drop the tabs; rename
  rail plugins to "Plugins"; put Fleet on the rail with a label; keep one visible Ask Lucid entry plus
  the shortcut.

**P1-3. Metrics rail shows a wall of zeros on every fresh session.**
- Evidence: `renderMetricsRail()` renders 6 unconditional tiles (`app.ts:4246-4252`): "0%", "0", "0",
  "0", "0", "0"; label `quarantd` (`app.ts:4252`); the savings tip is about 50 words (`app.ts:4246`).
  The user saw 8 zero tiles.
- Impact: reads as a broken app or a dashboard with no data; abbreviations cost a hover each.
- Recommendation: until the first turn, render one line ("Metrics appear after the first reply")
  instead of tiles; spell `quarantined`; one-sentence tips. Same rule already used for LUCID points and
  Jobs ("no dead zero tile", `app.ts:4254`, `4263`).

**P1-4. Headerless and placeholder Settings cards.**
- Evidence: `secEmbeddings()` (`app.ts:6735-6748`) returns a bare `set-sec` with no header, so the
  "Semantic search" title from the skeleton (`app.ts:6822`) vanishes on hydrate; trailing headerless
  `set-note` (`app.ts:6842`); empty `data-sec` nodes for `asksageQuota` and `sovereignty`
  (`app.ts:6820`, `6823`); "More providers" with an empty subtitle (`app.ts:6831`).
- Recommendation: every card renders through `setCard()` with a title; placeholders render nothing,
  not an empty slot; the privacy note moves into the Overview or Security category.

**P1-5. Settings ignores Esc and focus.**
- Evidence: no Settings Esc handler; `immersiveEsc` returns early while `state.settingsOpen`
  (`app.ts:5061-5062`). Focus is not moved into Settings or returned to the opener. Only
  `plugins_flyout.ts:299` sets `aria-modal`.
- Recommendation: Esc closes the topmost overlay; open moves focus to the category list; close returns
  it to the opener.

**P1-6. Four modal gates and a tour before the first prompt.**
- Evidence: `runOnboarding()` `app.ts:4774-4780`: role picker (`4982`), email (`4724`), gov/CUI
  (`4818`), provider (`4789`), then `startTour` (`5729`, 4 to 7 steps per role, `tour.ts`). No progress
  indicator. User copy cites internal ADR numbers: the Profile card note "(ADR-0030)" (`secProfile`)
  and the code-attribution tooltip "ADR-0030/0031" (`.ailoc-attr`).
- Impact: a Community user can meet "CUI" and "AskSage gov gateway" before typing a first prompt.
- Recommendation: one welcome sheet with role (defaulted) and provider; email and gov/CUI move to
  Settings unless managed policy requires them; the tour starts on demand from the empty state. Remove
  ADR references from user copy.

**P1-7. Jargon in first-screen and Settings copy.**
- Evidence: Settings subtitles "hermes · openclaw · ACP firewall" (`app.ts:6826`), "headroom ·
  on-device · opt-in" (`6824`), "accredited proxy" (`6819`), "Restricted-origin models" (`5855`);
  KG title "KG" (`app.ts:630`); Creator Studio "posture", "Probe", "DGX enclave", "CUI lockdown"
  (`creator_studio.ts:163-194`); Skills "governance", "Codify" (`app.ts:610`, `skills_dir.ts:150`).
- Recommendation: subtitles say what the card does in plain words ("Agents on other machines",
  "Shrink long prompts on this computer"); acronyms expanded on first use; product codenames only in
  Advanced.

**P1-8. Toasts: unbounded, sometimes permanent, green on failure, announced as alerts.**
- Evidence: `showToast()` `ui.ts:261-288`: no stack cap; `if (o.timeout)` (`ui.ts:286`) means no
  `timeout` or `timeout: 0` never dismisses (e.g. `app.ts:972`, `1034`, `1104`); an omitted `tone`
  renders the green check (`TONE_ICON`, `ui.ts:250-253`, and the `ico` fallback in `showToast`), so a
  failure without `tone` looks like success; every toast is `role="alert"`, including confirmations;
  "OK" actions that only dismiss (`app.ts:907`, `1029`, `1164`).
- Recommendation: cap at 3 visible (oldest collapses); default timeout by tone (ok/info 4s,
  warn/danger sticky); require `tone`; `role="status"` for ok/info; drop no-op OK buttons.

**P1-9. Composer and empty state lead with a security claim, not a next step.**
- Evidence: placeholder "Ask the agent...  every tool call is scanned before it runs" with a double
  space (`app.ts:546`); empty state "Ask the agent anything" / "Secure prompting and code generation"
  (`app.ts:1040-1044`) with no starter actions and no "connect a provider" path when none is set.
- Recommendation: placeholder "Ask the agent to build, fix or explain something"; move the scanning
  promise to the security badge tooltip; empty state offers 3 starter tasks plus "Open a folder" and
  "Connect a model" when missing.

**P1-10. Settings evicts context when it opens.**
- Evidence: `openSettings()` hides the inspector and collapses the sessions sidebar
  (`app.ts:7248-7250`); closing restores the inspector but not the sidebar.
- Recommendation: a Settings window overlays instead of reflowing; the layout underneath is untouched.

**P1-11. Title bar copy disagrees with itself.**
- Evidence: `#tbMore` tip "Persona, Skills and Knowledge" (`app.ts:449`) while the folded chip is
  labelled "Datasets" (`app.ts:448`) and switches to "Knowledge" outside AskSage (`13939-13980`);
  `#tbRepo` has no tooltip (`app.ts:443`); zoom takes 3 title bar slots (`app.ts:456-460`).
- Recommendation: one name per chip per edition; move zoom to Settings > Appearance and keep the
  shortcuts.

**P1-12. Fleet dock hides its layout controls.**
- Evidence: 9 items behind "More" (`fleet_grid.ts:251-262`): Orbit view, 4 layouts, Group by repo,
  New board, Open the grid first, Classic hub in a terminal. The add button reads "Agent"
  (`fleet_grid.ts:318`).
- Recommendation: a visible view switcher (Orbit / Grid) and "+ Agent"; keep boards and terminal in More.

**P1-13. Icon-only controls without accessible names.**
- Evidence: 35 icon-only controls in the primary shell, 2 with `aria-label` (`#ctPlus`, `#sessSpokes`);
  window controls (`app.ts:466-468`), send (`548`), rail (`475-496`),
  Skills/KG/Studio close buttons (`612`, `644`, `622`).
- Recommendation: every icon-only button gets `aria-label` equal to its tooltip title.

### P2

**P2-1. Em dashes (U+2014) in mockups and source comments.** AGENTS.md "Writing style" forbids them.
- Shipped renderer UI strings: 0 found (good).
- Mockups, user-visible text: `agent_turn_redesign.html:298`, `314`, `338`, `416`, `488`;
  `engineering_reports_module.html:182`, `185`, `250`, `274`, `309`, `310`, `330`;
  `eval_latency_rollup.html:102`, `108`; `report_evals_section.html:7`, `88`, `91`, `129`, `130`, `155`,
  `162`; `share_dock_preview.html:115`, `156`. Plus header comments in 4 mockups.
- Renderer comments: `app.ts:10798`, `11827`, `18398`, `20115`; `speech_queue.ts:92`, `113`, `121`;
  `voice_eq.ts:94`, `99`; `market_stub_provider.ts:60`; `skills.ts:457`; `kg_packs.ts:4`, `26`, `141`;
  `skills_dir.ts:4`, `12`; `kg_header.ts:4`.
- Recommendation: replace when the file is next touched; the gate now blocks new ones in added lines.

**P2-2. Ask Lucid copy.** The idle status line and the welcome paragraph refer to Lucid as "He"
(`ask_lucid_panel.ts:122`, `225`); the welcome is a 50-word paragraph; the send button repeats "Ask"
under the "Ask Lucid" title (`sendBtn`, `ask_lucid_panel.ts:371`). Recommendation: neutral voice, one
sentence; send icon with `aria-label="Send"`.

**P2-3. Knowledge graph header.** "Auto" cycles four perf modes on click with no visible state name
(`app.ts:639`); the views menu is labelled with the current graph name "Personal" (`kg_header.ts:17-19`);
tooltips say "· dropdown" (`app.ts:640`, `642`); Upstream/Downstream/Both has no group label
(`graph_orbit.ts:74`). Recommendation: "Quality: Auto" select; "View" label on the menu.

**P2-4. Skills empty state.** "No skills discovered." (`skills_dir.ts:101`) offers no next step.
Recommendation: link to "Draft skills from recent work" and to the skills folder.

**P2-5. Settings title casing and names.** "Network Whitelist" vs sentence case elsewhere
(`app.ts:6827`); "Trivia Wire" and "Mini Lucid" sit beside security settings. Recommendation: sentence
case; fun settings under Appearance.

**P2-6. Toast title row breaks invariant #11.** `showToast()` puts the raw title text and the dismiss
button as siblings in `.h` (`ui.ts:270`), and `.toast .h` is `display:flex; justify-content:space-between`
(`styles.css:3023`). A long title becomes its own flex item and wraps beside the button. Recommendation:
wrap the title in one `<span>` with the ellipsis rule.

**P2-7. Creator Studio failure copy points at a missing control.** "Creator Studio could not read its
registry ... try Refresh." (`creator_studio.ts:316`), but the Studio header has only Close
(`#studioClose`) and the body has no Refresh button. Also "Probe everything" plus "A probe reports what
a provider PROVED" (`creator_studio.ts:214-215`) is engineering voice. Recommendation: render a Retry
button in the error state; "Check all connections".

## 5. New-user path today (Community edition, no provider)

Role picker -> email prompt -> provider nudge -> 7-step tour -> an empty chat framed by 9 title bar
controls, 16 unlabeled rail icons, 5 composer icons, 2 inspector tabs and 6 zero tiles. To connect an
MCP server the user must find the sliders icon (rail 19 of 19), scroll to card 9 of 25, expand it and
type a URL from memory. Target after P0-1 to P0-3 and P1-1, P1-3, P1-6: one welcome sheet -> chat with a
labelled rail of at most 10 -> Settings Overview showing "Nothing connected yet" with one-click official
connectors.

## 6. Keeping this current

- The UX PR gate requires the checklist on every UI PR (`docs/UX-PR-CHECKLIST.md`).
- A PR that changes a count in section 2 or a tier in section 3 updates this file in the same PR.
- Re-run this review when any section 2 count grows by more than 20 percent since the baseline.
