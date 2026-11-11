# HANDOFF - Lucid Agent IDE

Cold-start context for a fresh or **remote** Claude session (see
`.github/workflows/claude.yml`). Read this, then `AGENTS.md` / `CLAUDE.md`
(the invariants, byte-identical below their title lines), before touching code.

## What this is

A security / provenance / memory layer built **around** oh-my-pi (omp), not a
fork. TypeScript on Bun, in-process with omp; the only Python is
`scanner-sidecar/` (the pure Unicode scanner). It ships as **LUCID Agent IDE**,
an Electron desktop app (Windows NSIS + portable, macOS .pkg/.zip, Linux
AppImage/deb/rpm), with the same gated agent available headless (`lucid`,
`lucid tui`, `lucid acp`). See `README.md` and `BUILD PLAN omp.md`.

## Current state (2026-11-10, v2.5.3 stable)

**v2.5.3** (2026-11-10, branch `release/v2.5.3-cut`) is the stable release:
2.5.3-beta.4 promoted unchanged, i.e. 2.5.2 plus the four 2.5.3 betas.
P-SEASON.1 (ADR-0525, #580): special themes for U.S. holidays and event
months. #586: P-MODEL.10 (ADR-0526, omp 18.18.6 on bundled Bun 1.4.4, Claude
Fable/Mythos 5.2), P-BOOTPERF.1 (ADR-0527, Windows boot), P-FLEET.FIT1
(ADR-0528, lane autofit), P-PUSH.PAR1 (ADR-0529, Push now in a parallel
lane). P-PRIVAI.1 (ADR-0530, #588): the DGX Loader is the Private AI
Platform, identifiers kept. #600: P-GAME.11, 11b, 12 (holiday arcade). #597:
a promoted lane keeps its whole answer. Tagged `v2.5.3` and marked Latest;
the add-on's Tahiti `core.lock` pins this tag. Held for 2.6.0: #599
(fetch-runtimes stale Bun, #598; local builds only, CI fetches fresh), #596,
#595, #594, #593, #592, #591, #590, #585, #583, #573, #571 and the older held
PRs.

**v2.5.2** (2026-11-07, branch `release/v2.5.2-cut`) was the previous stable release:
2.5.1 plus bug fixes only. P-MODEL.9 (ADR-0498, #570): cloud-only automatic
model default, local models restored only from an explicit pick, embedding
models never chat or check, a provider refresh on the "No response" card.
P-ASK.1 (ADR-0523, #572): omp's `ask` tool off in every ACP session,
`lucid acp` included. P-GLOW.1 (ADR-0524, #574): compositor-only
needs-approval pulse. #576: the Fleet Orbit ring drawn from the layout's
radii (#575). Docs: the P-HERD design ADRs (ADR-0489 to ADR-0497, #560).
Tagged `v2.5.2` and marked Latest. Held for 2.6.0: #573 (remote spokes,
which carries #571 and the sessions stack as ADR-0515 to 0521, P-CTRL-REMOTE.1
now ADR-0531), #571 (canvas orbit, must take `ringRx`/`ringRy`), #524/#525,
#512, #457, #351.

**v2.5.1** (2026-11-05, branch `release/v2.5.1-cut`) was the previous stable release:
2.5.1-beta.1 (owner-tested on Windows) promoted with the #555 upgrade review
fixes, plus P-QUEUE-IMG.1 (ADR-0469, staged prompts own their pasted
images), P-KG-ORBIT.1 / P-KG-FLAT.1 / P-KG-POLISH.1 (ADR-0470, ADR-0471, the
Knowledge canvas Orbit view and a readable flat graph) and the P-WAKE /
P-SCHED.5-6 design ADRs (ADR-0482 to ADR-0488, docs only). Tagged `v2.5.1`
and marked Latest. What beta.1 brought: the engine OS vault (ADR-0472),
FIPS 140 at-rest crypto (ADR-0473), one v2 vault (ADR-0474), the vault list
and `.lucidvault` backup (ADR-0475), request_secret (ADR-0476), `.env` import
(ADR-0477), enterprise vault destinations (ADR-0478), the NIST SP 800-171
Rev 3 evidence package (ADR-0479) and the renderer watchdog (ADR-0481).
Installing over 2.5.0 migrates keys into the OS vault with no re-entry;
downgrading to 2.5.0 shows them as unset. Left out as not low risk: the
emertins sessions/hub stack (#551 to #553, ADR numbers collide with master's
0469 to 0475), #524/#525 (biometric and passphrase vault unlock, needs its
own security review), #512 and #457 (frozen `contracts.ts` changes,
conflicting), #351 (Windows gate fails). The add-on repo's Tahiti distro
(ADR-A032, ADR-A043) pins this tag.

**v2.5.0** (2026-11-01, branch `release/v2.5.0-cut`) was the previous stable release:
2.5.0-beta.1 through beta.4 promoted plus everything merged to master since
beta.4, tagged `v2.5.0` and marked Latest, so the download buttons, the
electron-updater feed and the Homebrew cask (after its `chore/cask-v2.5.0`
PR merges) all move to it. It carries the `lucid hub` control plane and
terminal train (beta.1), the AOS-1 fleet goal with heartbeat and verified
tasks (beta.2), the headed-browser fix and the beta.3 fixes, and the Plugins
drawer in the Preview panel with the premium plugin marketplace (P-PLUGINS,
ADR-0461 to ADR-0466, beta.4). Since beta.4: the Creator-only curriculum and
explainer built-ins (CREATOR-CURRICULUM, ADR-0467; CREATOR-EXPLAINER,
ADR-0460), which do not appear in the Agent build, and P-RELEASE.9
(ADR-0468): the air-gap gate compares Authenticode image digests, so the two
separately signed copies of one bun (`bun-win32-x64.exe` and its `bun.exe`
alias) pass; proven by signed test run 41381896437, all four legs green, with
Windows printing "plain bun alias OK - same image as bun-win32-x64.exe".
Installing 2.5.0 over 2.4.1 or any 2.5.0 beta keeps settings, sessions and
keys. The beta paragraphs below describe what each prerelease added.

**v2.5.0-beta.4** (#541) is beta.3 plus P-PLUGINS (ADR-0461 to
ADR-0466, #537 to #540): the Plugins drawer in the Preview panel (Premium and
Free, Civilian and Government), signed `.lplugin` install with manifest,
hash, signature and scanner gates, $29.99 Stripe checkout through the LUCID
account, the Government access gate, and the owner Marketplace Dashboard.
The Linux x64 release leg is pinned to ubuntu-24.04 (ADR-0459).

**v2.5.0-beta.3** (2026-10-23, branch `release/v2.5.0-beta.3`) is beta.2 plus
#523 and #526, fixes only: the agent's headed browser no longer comes up as a
white, frameless box (P-BROWSER.5, ADR-0456: omp 18.8 spawns its broker
without a console, so the shared headed Chromium was born hidden again and
the engine now shows its window on Windows); Creator jobs are recorded in the
Creator ledger again (a shadowed `createJob` import); the Jobs sheet shows
each target's repo; subagent rows show the agent's intent; the `lucid hub`
demos run on Windows; stale engine-discovery files are pruned. Same beta rules
as beta.1. Gate: 528 files / 7135 tests.

**v2.5.0-beta.2** (2026-10-20, branch `release/v2.5.0-beta.2`) is the next
GitHub prerelease: beta.1 plus #521. It brings the fleet goal (P-AOS.1,
ADR-0452): LUCID's own binding of AOS-1, one standing goal with success
criteria and a mandatory spend + time budget, a 10 s engine heartbeat the
orbit reads as alive / late / dead, and stalled spokes reaped; and tasks
under it (P-AOS.2, ADR-0453): an output contract and acceptance checks per
task, one task per idle spoke in dependency order, command checks verified in
a separate fail-closed turn, human review in the orbit, retries with the
reason up to the limit. Also: the Timeline dock no longer opens blank on a
large corpus (P-TL.4), the first turn no longer reads "Reconnected", a turn's
tool steps read as separate paragraphs (P-STEPTEXT.1), the Preview zoom moves
in whole 10% steps, and session files are read through one handle (CodeQL).
Same beta rules as beta.1. Gate: 527 files / 7128 tests.

**v2.5.0-beta.1** (2026-10-17, branch `release/v2.5.0-beta.1`) is a GitHub
prerelease on top of 2.4.1 carrying the `lucid hub` terminal train integrated
in #515: the hub control plane with named spaces, stable ids and a loopback,
token + nonce gated control server driven by `lucid hub <cmd>` (P-TUI.3,
ADR-0436); the Agents and Spaces decks (P-TUI.4); tabs inside spaces (tmux
window = tab, session = space) behind a persistent left rail with SGR mouse
clicks (P-TUI.5, ADR-0433); the rail's Agents panel with a per-lane display
priority 1-9 (P-TUI.5 E2, ADR-0434); the deck strip and the `ctrl+k` palette
(P-TUI.6, ADR-0435); and the `lucid-hub` agent skill (contract v2). Beta
rules: never marked Latest, the Homebrew cask and stable installs stay on
2.4.1, a beta install updates to the next beta; installing it over 2.4.1
keeps settings, sessions and keys, and going back is installing 2.4.1 over
it. The hub's end-to-end demos are proven on macOS; on Windows the hub works
but its demos do not run yet (a stderr line from the managed-config registry
probe). Scoped gate: 522 files / 7060 tests.

The original build plan (Increment 0-2 + Phases 2-7) closed long ago; work is
now product increments, each with its own ADR. **v2.4.1** (2026-10-17) was the
previous stable release: 2.4.0 plus the bug fixes merged to master the same
day via #514 and #516, tagged `v2.4.1` and marked Latest at the time. No new
product surface beyond a launcher convenience. SWITCHING (#460, cases 1-5):
#507 makes "Stop it and switch" stop a running /goal loop and wait for it to
unwind before the session changes (the maker turn used to be cancelled while
the loop lived on inside the newly loaded session); #509 limits the "an
automation is running" blocker to goal-kind automations that own Main's
session, agent-kind ones run in their own child pipeline and no longer refuse
a switch; #510 makes the engine's answer to a load/new the authority for what
the thread shows (a busy 409 between turns reloads the holder's transcript, a
held 409 attaches to the holding spoke per the ADR-0404 registry, no answer
is never a completed switch); #511 gives openSession a generation number
taken before any await so a superseded plan (click A then B quickly) is
discarded. AI-LOC: #489 keeps xd:// device calls and other internal URIs
(local://, agent://, skill://) out of the AI-LOC ledger and the inline
diff/preview (#483); #492 (P-LOC.5, ADR-0451) counts only successfully
completed edits and writes from the tool's actual result diff (per-file
results when present), blocked, failed and duplicate completions add nothing,
and chat + fleet edit previews share one canonical extractor. HOMEBREW: #453
makes the cask an app cask over the release .zip (no pkg, no deprecated
allow_untrusted), pinned per release, the .pkg assets still shipped for MDM,
with a `make demo-P-BREW.1` naming-contract check; #468 puts `lucid` on PATH
and adds a `lucid-hub` wrapper. CI: #513 gives explicit budgets to the four
tests the Windows gate was killing under load. The scoped test gate measures
518 files / 6958 tests at v2.4.1. **v2.4.0** (2026-10-17) was the previous
stable release: beta.1 and beta.2 promoted plus everything merged to master
since beta.2, tagged `v2.4.0` and marked Latest at the time (the update-cask
job pins stable tags). It is the first release whose Windows installers are
Authenticode-signed: P-RELEASE.6 (ADR-0447) + P-RELEASE.7 (ADR-0450) sign the
NSIS Setup, portable, MSI, AppX, the app exe and every bundled exe through
Azure Artifact Signing with `CN=TECHLEAD 187 LLC`, RFC 3161 timestamped; the
UAC prompt, Explorer's Details tab, Programs and Features, the AppX listing
and the About dialog all name TECHLEAD 187 LLC (one string); the in-app
updater refuses an update not signed by that publisher, and a release run
that cannot sign fails instead of shipping unsigned. SmartScreen's "Windows
protected your PC" is reputation-based and fades as signed downloads
accumulate. macOS is still unsigned (no Apple certificate yet), so mac
auto-update still goes through Homebrew. Also in 2.4.0: P-MODEL.8 (ADR-0448:
Gemini 4 Argon is the Gemini flagship with 1M context, Gemini 3.8 Flash the
Gemini default, and a Gemini session runs omp's thinking/plan/subagent roles
on Argon) and P-CTRL.2 (ADR-0438: a paired external controller gets its own
token scope in an argon2id-hashed pairing store and `/api/controller/*` on
loopback only, supervised lanes only, prompts through the fail-closed scanner
first). P-CTRL-RO.1 (ADR-0449) is spec only, no code. The scoped test gate
measures 517 files / 6936 tests at the tag (locally 6932 pass, 4 skip). The
2.4.0 beta channel stopped here. **v2.4.0-beta.2** (2026-10-09)
is beta.1 plus six reviewed PRs: #494 (P-SETTINGS.1, ADR-0439: atomic settings
save with a last-good backup, a corrupt file restored from it, and a file that
exists but cannot be read reported instead of served as an empty profile),
#471 (P-SANDBOX.19, ADR-0445: plain-HTTP model servers get the same egress
decision as CONNECT), #493 (P-MARKET.1c, ADR-0446: catalog titles on one
line), #486 (the symbol graph skips a TypeScript 7 stub), #455 (Windows delete
verbs named destructive) and #461 (ADR-0437: the Defender / Agent 365 runbook
corrected). **v2.4.0-beta.1** (2026-10-09) opened the 2.4.0 train: omp 18.8.6
with Claude Haiku 5.5, OpenAI device-code sign-in, MXC behind the Windows
sandbox, scheduled jobs and Fleet grid fixes. Both betas were GitHub
prereleases: never offered to stable installs, with the cask and `latest`
links on 2.3.1 until 2.4.0 promoted them. Of the PRs that waited on review
fixes at the 2.4.0 cut, #468, #489, #492 and #453 landed in 2.4.1; the hub
stack (#466-#480, #463, #473), #488 and #457 still wait, and the review
recommends closing #351 (TypeScript 7 drops the compiler API).
**v2.3.1** (2026-10-01) is
v2.3.0 plus #442: four arcade games (P-GAME.7-10: Chroma Cadence, Gravity
Gambit, Silent Fathom, Skyhook), sound off by default in the action games, and
Silent Fathom's stored best written as text (CodeQL js/xss-through-dom), a
plain stable tag. **v2.3.0** (2026-10-01) is the
stable release: beta.15 promoted with no code change on top, tagged `v2.3.0`
and marked Latest, so the download buttons, the electron-updater feed and the
Homebrew cask all move to it. The cask was pinned by PR #445: the update-cask
job built the pin, but master's ruleset refuses its direct push (GH013), so
until that job opens a PR, every stable tag needs that manual PR. The beta
channel stopped here.
**v2.3.0-beta.15** (2026-10-01)
is beta.14 plus #441: Linux bubblewrap binds the packaged install root (a Mint
.deb died at `bwrap: execvp /opt/LucidAgentIDE/.../omp`), fleet menus and the
picker name a model offered twice by its login (`X sign-in` / `API key`), a new
spoke follows Main's provider, and the New lane card stays 360 px.
**v2.3.0-beta.14** (2026-09-30)
adds #437 (P-HEALTH.3 a long write is not a stall, P-FLEET.WT1 lanes in their
own worktree, P-TUI.2 `lucid hub` from Fleet/launcher/PATH, P-RECOVER.3 incident
reports quote real omp stderr and engine git finds MinGit) and #438 (P-MODEL.6,
ADR-0422: omp 18.2.10 -> 18.4.4, Claude Sonnet 5.5, StepFun behind the
China-origin gate and out of lockdown, Apple on-device on macOS only), #434
(P-NETSTAT.1 network indicator and stand-by card, ADR-0423; P-SANDBOX.18 the
AppContainer helper skips a grant already on disk, ADR-0424; P-JEV.7) and #435
(arcade: Brick Brigade, Deck Guard, Signal Garden: Heartbloom).
**v2.3.0-beta.13** (2026-09-29)
merges the surgery train and the judge fixes on top of beta.12: #421
(P-BROWSER.4 the visible agent browser, P-JEV.5 the Judge off by default with
a local-model breaker, ADR-0415/0416), #424 P-WAIT.1 same-file waits
(ADR-0417), #425 P-LIVENESS.1 + P-ASYNCJOBS.1 (ADR-0418), #426 `lucid hub`
the terminal pane multiplexer (P-TUI.0/.1, ADR-0419/0420), #427 the UNC test
harness made injection-safe, #428 P-RECOVER.2 (no reconnect button in the
first minute), #429 lane pickers use the curated model list, #432 P-JEV.6 a
judge whose account has no such model is not asked again (ADR-0421). #431
audited every hub-and-spoke branch against master (nothing missing) and 17
stale origin branches were deleted; #351 (dependabot) is still held.
**v2.3.0-beta.12** (2026-09-28)
merges six reviewed branches (#407 P-PROGRESS.3, #409 P-PROGRESS.4, #410
P-INTERJECT.5, #411 orbit closes the grid, #412 P-SWITCH.3, #414 P-FLEET.L8)
plus two operator fixes: session titles no longer show the checkout-peers
briefing, and Bedrock / Vertex models appear only behind a key saved in LUCID
with each picker family listing what you run first. Each branch was reviewed
against a headless engine on a separate port (master vs head) before merge; #408
(UNC test harness) was sent back for a cmd argument-injection fix and #351
(dependabot) is held (TypeScript 7 empties the symbol graph).
**v2.3.0-beta.11** (2026-09-27)
fixes Stop (it no longer starts the staged prompt), opens Fleet on the grid,
shows the branch pill only for a hosted repo, drops the Processes pill, and
makes the launcher open the installed app (#403/#404/#405).
**v2.3.0-beta.10** (2026-09-27)
is beta.9 made quieter on operator request: no ETAs or estimates, only the
dead-process Restart line, the subdued Beta 8 palette, a tipping Jev scale, and
opt-in repo discovery for new lanes (ADR-0409/0408/0406 amendments).
**v2.3.0-beta.9** (2026-09-27)
integrates nine branches on top of beta.8: P-PROGRESS.1/.2 (ADR-0409/0408,
what every worker is doing and its ETA), P-SWITCH.1/.2 (ADR-0403/0404, one
session one owner), P-OWN.1 (ADR-0407, known writers per checkout), P-REPO.1
(ADR-0406, repo chip and picker), P-SCROLL.1 (ADR-0405), P-GAME.1/.2/.3 and
P-PREVIEW.20/.21 (offline games, a two-row Preview header, a Browser
pop-out), the Knowledge Item envelope spec, and the root dependabot bump.
Integration note: #396 and #397 both claimed ADR-0404; P-PROGRESS.1 was
renumbered to ADR-0409 (the `adr_numbering` test is the alarm). The desktop
dependabot bump (#351) was left out: its Windows test gate failed.

The stretch before it, the **Windows AppContainer sandbox arc** (ADR-0386 to
ADR-0395), shipped as **v2.3.0-beta.8** on 2026-09-24 (never marked latest,
cask untouched):

- **P-SANDBOX.9 to .11** (ADR-0386/0387/0389): chat actually works inside the
  AppContainer. The helper hands its std handles to omp, the container can
  read its runtime and write `~/.omp`, inference goes through `PI_PROXY`, the
  bundled bun is 1.4.2 (1.3.14 cannot start a script in the container), and
  the pill lights only after the real runtime boots through the same wrap.
- **P-SANDBOX.12 / .13 / .13b** (ADR-0390/0391/0393): the Security panel's
  sandbox switch, Add folder via a dialog the ENGINE opens (never a caller
  path), the full reach list, and a helper Browse For Folder fallback when
  Smart App Control puts PowerShell in Constrained Language Mode.
- **P-SANDBOX.14** (ADR-0394): enterprise policy `security.sandbox`
  (`SandboxAllowUserOff`, `SandboxReadFolders`, `SandboxReadWriteFolders`,
  `SandboxLockFolders`). ADMX/ADML templates for them are still owed in the
  private add-on repo.
- **P-NORESP.2** (ADR-0388): agent errors reach the chat as words.
  **P-MODEL.5** (ADR-0392): Grok 4.7 and an xAI Grok picker family.
- **P-REL.1** (ADR-0395): `build-desktop.yml` can cut a beta prerelease from a
  `beta_release` dispatch (agent sessions cannot push tags).

Measured 2026-09-24 with **bun 1.4.2** (`desktop/release/**` excluded per
ADR-0303):

- **1,725 harness tests** across 147 files (1,721 pass / 0 fail / 4 skip).
- **3,756 desktop tests** across 258 files (3,756 pass / 0 fail).
- **57 sidecar tests** (pytest, all pass). **259 `demo-*` targets** in the `Makefile`.
- `tsc --noEmit` clean at the root and in `desktop/`; BUSL-1.1 headers complete.

Both correctness keystones are in and over-tested: the **Unicode scanner**
(`scanner-sidecar/`) and the **semantic-promotion gate**
(`harness/memory/promotion_gate.ts`). The end-to-end guarantee holds: untrusted
text -> scanned -> trust-labeled -> sanitized -> persisted -> blocked at the
tool / promotion / dispatch boundaries -> human-reviewed -> exits only as safe,
audited evidence.

**Bun version matters.** Under bun 1.3.x, 6 harness tests that start a real omp
session (including the fail-closed dead-scanner test in
`harness/hooks/quarantine_hook.test.ts`) die before their bodies run, because
omp's browser prelude will not link ("Missing 'default' export in
.../tools/browser/prelude.js"; seen on omp 18.2.10, not re-checked under bun 1.3.x
at the current 18.4.4 pin). They pass under bun 1.4.2 and in CI (which uses
`bun-version: latest`). Use bun >= 1.4.2 locally; if the machine's bun is older,
`npm i bun@1.4.2` into a scratch dir and run its binary. A bare `bun test
harness` also picks up the generated `desktop/release/win-unpacked/.../harness`
copy and roughly doubles every count: always pass
`--path-ignore-patterns='desktop/release/**'`.

## How to run

```bash
bun install
(cd scanner-sidecar && uv sync)

bun test harness                                    # harness suite (what CI gates)
bun test --path-ignore-patterns='desktop/release/**' desktop   # desktop suite
(cd scanner-sidecar && uv run pytest -q tests)      # scanner suite
bun x tsc --noEmit && (cd desktop && bun x tsc --noEmit)
bun run tools/license_headers.ts --check
```

`make` is the canonical task spec (`make test`, `make demo-<increment>`) but is
not installed on the Windows origin host, and `package.json` mirrors only the
early demos. Run any demo directly instead, e.g.
`bun run harness/scripts/demo_pfleetl2.ts` or
`bun run desktop/scripts/demo_p_sandbox_5.ts`; the target's recipe in the
`Makefile` names the script.

The desktop app runs from source with `cd desktop && bun run start` (builds
`dist/main.js` + preload, then launches Electron) or headless-in-browser with
`bun run web` (the `dev.ts` backend alone); installers are built by CI, never
locally.

## Session ritual (from AGENTS.md - follow it)

1. Read `AGENTS.md`. Confirm a green baseline (`bun test harness` + the previous
   `demo-*`) before changing anything.
2. Build **exactly one** increment. Keep every invariant (fail-closed; extend
   omp, never fork; untrusted content delimited + late; byte-stable prompt
   prefix; closed trust-label/event sets; stable IDs; DuckDB schema only via
   numbered migrations; UI labels never word-wrap in narrow columns).
3. Do **not** edit frozen contracts (`harness/contracts.ts`,
   `harness/tools/result_adapter.ts`, the frozen prompt prefix, applied
   migrations) as a side effect. A real contract change is its own increment
   plus an ADR (ADR-0273 changed `FleetStatusData.resources`; every consumer
   moved in the same increment).
4. Append a 3-line `PROGRESS.md` entry: shipped / stubbed / next. `/ship-docs`
   does that review + update.

## Cutting a release

1. Bump the four version sites: `desktop/package.json`, `desktop/version.ts`
   (`APP_VERSION` + a changelog comment line for the version being superseded),
   and the two pins in `desktop/about.test.ts`.
2. README: rewrite the **Newest (vX.Y.Z)** paragraph, demote the previous
   version into the history chain, add a `vX.Y.Z batch` row to *Recent updates*,
   and refresh the test badge + status counts only with measured numbers.
3. `PROGRESS.md`: a `## Release cut: vX.Y.Z` entry at the top.
4. Commit, push `master`, then push the `vX.Y.Z` tag. **Betas without a tag
   push** (e.g. from an agent session, which cannot push tags): dispatch
   `build-desktop.yml` on `master` with `beta_release` ON. It builds the
   committed prerelease version and creates tag `v<version>` plus the GitHub
   prerelease through the API (ADR-0395); it refuses a non-prerelease version,
   a non-master ref, or `publish_latest` alongside it. The tag build
   (`.github/workflows/build-desktop.yml`) packages all three OSes, re-runs the
   air-gap gate and the strict Program Files boot gate on the release bytes,
   attaches the installers + the electron-updater feed to that tag's Release,
   and auto-pins `Casks/lucidagentide.rb` on master (brew is the macOS update
   channel, ADR-0258). GitHub marks the newest tag Release "Latest", so the
   README `releases/latest/download/...` buttons follow it.
5. The rolling `latest` **tag** release is a separate, opt-in surface: a manual
   `workflow_dispatch` with `publish_latest` ON, from `master` only. It pushes at
   already-installed users, so never flip it as part of a routine tag cut.

## Next increment

**P-SIGN.1** (code signing): needs the owner's choice of Azure Artifact
Signing or a traditional certificate. Signing also lifts the Smart App Control
block on install.

Queued alongside it:
- ADMX/ADML templates for the four P-SANDBOX.14 values (private add-on repo).
- Verify P-SANDBOX.15 (ADR-0396) in a packaged build: the window must still
  authenticate (preload `lucid.token()` over IPC) with no token in the HTML.

## Lessons learned (2026-09-24, the AppContainer arc)

- **Prove what the feature depends on, not a proxy for it.** A helper that
  exited 0 lit a green pill while every chat turn died. The probe now
  round-trips stdio and boots the REAL runtime through the SAME wrap before
  committing (ADR-0386/0387). Apply this to any "available" indicator.
- **Windows hosts with Smart App Control or WDAC run PowerShell in Constrained
  Language Mode.** `Add-Type` is refused, so any PowerShell-built UI silently
  fails. Keep a non-script fallback (the helper's FFI dialog, ADR-0393) and
  make failures say why.
- **A test must never open real UI on a CI runner.** A test that expected the
  off-Windows refusal opened a real modal dialog on `windows-latest` and hung
  the Full test gate (no `timeout-minutes`) until it was cancelled. Gate
  platform-specific calls on `process.platform`, and when a job hangs, read the
  last test line of its log before re-running anything.
- **A green check suite on an OLD head is not a pass.** Each push cancelled the
  previous CI run, so the Windows gate had never completed on the PR until the
  merge head. Before merging, confirm every check completed on the exact head
  SHA being merged.
- **Agent sessions can push only their own branch** (tags get HTTP 403 from the
  git proxy). Cut betas with the `beta_release` dispatch (ADR-0395) instead of
  asking for a local tag push.
- **The loopback token is shared with the agent.** Any route that widens access
  must not accept a caller-supplied target: the engine opens the picker itself
  (ADR-0391). P-SANDBOX.15 (ADR-0396) gave the agent its own narrower token and took the
  UI token out of the served HTML under Electron.
- **JSON-RPC errors are objects.** Wrap them with `rpcError` before they reach
  a string context, or the chat shows `[object Object]` (ADR-0388).

## Map

- `harness/security/` - scanner client, fail-closed gate.
- `harness/hooks/` - omp quarantine pre-hook (blocks poisoned tool calls).
- `harness/memory/` - DuckDB, ingest, sanitize, compaction, promotion gate,
  resume, migrations.
- `harness/runs/` - run lineage, sandbox profiles, security-review, remote gate,
  replay.
- `harness/omp/` - omp extensions (gate, theme, welcome, fleet status).
- `harness/launcher/` - the `lucid` CLI (tui / acp / kb / stats / check /
  agent-firewall).
- `harness/{prompt,telemetry,verification,export,dashboards,bench,kb,trainer,voice,mcp,agent,commands}/`
  - the rest of the harness.
- `desktop/` - Electron main + `dev.ts` backend + `renderer/` (the IDE UI,
  dashboards, fleet grid, preview, KG); `desktop/scripts/` holds its demos.
- `tools/` - CLIs and build/ops helpers (license headers, KB, metrics, relay,
  remote PWA, AppContainer sandbox helper).
- `extensions/` - VS Code, Neovim, JetBrains clients.
- `scanner-sidecar/` - the only Python; the Unicode scanner + fixtures.

## Cross-repo briefs

- `DGX-FLEET-INTEGRATION.md` (repo root) - what the TL187 Private AI Platform (formerly DGX Loader) fleet
  ships for LUCID (OpenAI-compatible serving, A2A agent card registry, model
  provenance and trust states, LoRA candidates, corpus lake), how to
  build-and-test against it today over SSH tunnels with zero hardcoded box
  names, and five proposed ADRs (fleet endpoints as configuration, A2A card
  consumption with a trust gate, local-first routing, provenance in the
  selection UX, single-endpoint readiness). Written 2026-09-05 by the DGX
  Loader's agent; source of truth for wire contracts lives in that repo's
  ADRs 0001 to 0014 and `docs/LUCID-INTEGRATION.md`.
