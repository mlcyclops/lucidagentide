# LUCID Agent IDE - ADR & Version Status since v1.11.3

_Snapshot: 2026-07-15. Local `master` is 8 commits ahead of `origin/master`; nothing new pushed to remote; the public release channel is rolled back to v1.11.3._

---

## TL;DR

- **Live release channel: v1.11.3.** Everything past it (v1.11.4/.5/.6) was pulled back to pre-release after the model-picker froze and the installer shipped broken on clean systems.
- **Root cause of the clean-system breakage is fixed** (bundled `bun` name mismatch). That fix plus the OAuth and no-response work is committed to **local master only**, not yet versioned or pushed.
- **A second agent is actively building P-REMOTE** (phone-to-desktop remote access) under **ADR-0226 + ADR-0227**. Their work is **uncommitted in the working tree** and must not be disturbed.

---

## Version timeline

| Version | State | What it was | ADRs |
|---|---|---|---|
| **v1.11.3** | **Live (rollback baseline)** | Last release kept on the public update channel | - |
| v1.11.4 | Rolled back to pre-release | AskSage hardening + RAG for non-AskSage users + collab viewer + KG-pack marketplace groundwork | ADR-0208 through ADR-0222 (#307, #308) |
| v1.11.5 | Rolled back to pre-release | "Lucid Agent" rename + air-gap-capable installer (bundles omp + relocatable Python) | ADR-0223, ADR-0224, ADR-0225 (#309, #310, #311) |
| v1.11.6 | Rolled back to pre-release | Fix v1.11.5 rename regressions (Linux rpm `/opt` space + userData path move) | - (#312) |
| v1.11.7 | **Branch only** (`hotfix/v1.11.7-linux-python`), not tagged, not on master | Fix Linux air-gap Python (`bin/python3` symlink dropped in packaging) | - |
| _next_ | **Unversioned, on local master** | The 8 session fixes below. `desktop/version.ts` still reads `1.11.6`. | - (mostly un-ADR'd hotfixes) |

### Why the rollback

v1.11.6 froze the model picker on "updating..." and, on a clean machine with no global `bun`, the installer produced "bun is not installed", no AskSage models, and no OAuth browser. You asked to **roll releases back to v1.11.3 and remove everything beyond it** until these were fixed. That is the current public state.

---

## The 8 fixes now on local master (unreleased)

These are committed to `master` (ahead of `origin/master`) and were verified on a fresh install. They are the actual fixes for the rollback issues:

| Commit | Fix |
|---|---|
| `db22839` | **The real clean-system fix.** Air-gap installer now bundles a plain `bun[.exe]` alias so omp's shim resolves it with no global bun. This was behind "bun is not installed" + missing models + no OAuth. |
| `979f522` | OAuth Disconnect authoritatively clears stored logins, plus "Sign out of all". |
| `f988d88` | `tools/clear-lucid-oauth-logins.bat` - wipe stuck OAuth logins on any Windows box. |
| `7565393` | OAuth sign-in page opens reliably and always shows the URL. |
| `c2d8cf9` | OAuth broker uses `LUCID_OMP_BIN` (same omp as the model list) - the root cause of the no-popup connect. |
| `0a86cbd` | **P-NORESP.1** - surface silent overloaded-model failures + recommend a fallback (lower same-family model or another provider). |
| `6b2046c` | **P-NORESP.1** - no-response fallback also covers errored models (e.g. Claude Fable 5 -> 4.8 Opus). |
| `2749810` | `tools/collect-lucid-logs.bat` - one-click redacted diagnostics bundle. |

Note: the no-response UX (P-NORESP.1) shipped as a hotfix increment and does **not** yet have its own ADR. If it's worth formalizing, that's a small follow-up.

**Held back on purpose:** `fix/model-picker-freeze` (`6854275`) - a picker "can't freeze on updating..." safety-net. It is **not** on master because merging it would collide with the other agent's uncommitted `PROGRESS.md`. Bun was the real freeze cause (already fixed), so this is defense-in-depth. Merge it cleanly once the other agent commits.

---

## ADRs since v1.11.3

### Shipped (in the rolled-back v1.11.4-v1.11.6 builds)

| ADR | Title |
|---|---|
| ADR-0217 | AskSage lockdown enforced server-side, fail-closed (was renderer-only) |
| ADR-0218 | AskSage lockdown covers egress + agent runs; RAG on GPT-5.6 Luna; real 5.6 ids |
| ADR-0219 | Per-session CUI/Search mode, violet CUI banner, DoD/STIG consent banner, titlebar Datasets picker |
| ADR-0220 | `knowledge_search`: RAG grounding for non-AskSage users (increment 1) |
| ADR-0221 | Bring-your-own-embeddings `ApiEmbedder` (non-AskSage semantic RAG) |
| ADR-0222 | Shared-session viewer: show thinking + tools, use the whole window |
| ADR-0223 | Turn ON the KG-pack marketplace in the client (completes P-KGMARKET) |
| ADR-0224 | Fix AskSage model-picker hang; center CUI banner; DoD banner + lockdown opt-in |
| ADR-0225 | "Lucid Agent" rename + air-gap-capable installer (bundle omp + relocatable Python) |

_(ADR-0208 through ADR-0216 predate this window slightly but landed in the same #307 batch: AskSage hardening, non-AskSage RAG spine, vault-backed git PAT, collab viewer.)_

### In flight - the other agent's active work (UNCOMMITTED, do not touch)

| ADR | Title | Status |
|---|---|---|
| **ADR-0226** | P-REMOTE: drive the running desktop LUCID from a phone browser - E2E collab room over a GCP-hosted rendezvous (Cloud Run relay + Firebase-Auth gate + hosted guest PWA) | Accepted (scope/plan) |
| **ADR-0227** | P-REMOTE goes multi-tenant: the ~$9.99/mo Remote Access tier, claims-gated relay admission, admin dashboard (amends ADR-0226) | Accepted (scope/plan) |

**Increments already built in the working tree** (uncommitted): 

- **P-REMOTE.1** - relay identity gate (`relay_auth.ts`, Firebase RS256 ID-token verifier, `admissionDecision`, per-uid quotas). +30 tests, `make demo-P-REMOTE.1` green.
- **P-REMOTE.2** - hosted-rendezvous transport hardening (`relay_client.ts` auth-frame-first + hold-until-auth, host re-claim with grace window). +11 tests, demo green. Cloud Run bundle in `lucidaddon_audit/iac/remote-relay/`.
- **P-REMOTE.4a** - invite link as a scannable QR (`desktop/collab/qr.ts`, dependency-free Reed-Solomon encoder). 12 tests, demo green.

**Still planned in P-REMOTE:** .2b (token-refresh custody + `collab.allowedRelays`), .3 (phone guest PWA on Firebase Hosting), .5 (remote approvals, deferred), .6 (Stripe paid tier + claims), .7 (metadata-only admin dashboard).

These live in modified `DECISIONS.md`, `PROGRESS.md`, `Makefile`, `desktop/collab/*`, `desktop/renderer/*`, plus new untracked `qr.ts`, `relay_auth*.ts`, `relay_client_auth.test.ts`, and `harness/scripts/demo_premote*.ts`. **I have left all of it untouched.**

---

## Recommended path to the next release

1. Let the other agent commit their ADR-0226/0227 P-REMOTE increments.
2. Merge `fix/model-picker-freeze` into master (clean once their `PROGRESS.md` is committed).
3. Bump `desktop/version.ts` (single source of truth) for a **v1.11.7** that carries: the bun air-gap fix, OAuth disconnect/connect, no-response fallback, and the Linux Python hotfix.
4. Fold in the `hotfix/v1.11.7-linux-python` Linux fix so all three OS installers are self-contained.
5. Re-cut installers, run the air-gap smoke (scrubs global bun), then restore the public update channel from v1.11.3 to the new build.

_No version bump happens automatically - only when you say so, one bump per release._
