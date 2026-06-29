# LUCID Executive Guide

> One screen of reassurance: are we protected, what are we spending, what are we
> shipping, and is governance in order — plus a plain-language engineering brief.

When you pick **Executive** at onboarding, LUCID hides the operational machinery and
leads with a **posture + spend summary**. The **Engineering Update brief** (with an
optional podcast) is the marquee.

## Who this is for / What you'll see

You want signal, not a console. The Executive view shows four reassurance tiles and the
brief; everything operational is hidden (but reachable).

- **Lands on:** a posture + spend summary.
- **Default rails:** Chat, Brief, Spend.
- **Four tiles:** 🟢 security posture ("protected — N blocked this month") · monthly
  spend rollup · AI productivity (LOC / month) · governance posture.

> [!NOTE]
> A role changes only **what is foregrounded**, never what is enforced.[1] The same
> fail-closed security gate protects every session; you see its result as one posture
> light instead of a queue. Anything hidden is one `⌘K` / `Ctrl+K` away.

## Read the posture and spend tiles

1. Open the landing summary. Each tile answers one question:
   - **🟢 Security posture** — "protected — N blocked this month." Green is healthy;
     it turns amber when a quarantine needs attention.
   - **Monthly spend rollup** — what AI cost across all models this month.[2]
   - **AI productivity** — lines of code produced per month.
   - **Governance posture** — the compliance lights (next section).
2. Click any tile to drill into the underlying ledger or panel.

![The Executive summary with four reassurance tiles](images/executive-posture-spend.png)
*Figure 1 — The Executive summary. Capture the four tiles — security posture (green
"protected — N blocked"), monthly spend, AI productivity, and governance posture.*

> [!TIP]
> The security tile is the one to watch. Green means the gate has been doing its job
> quietly; amber is your cue to ask your Security engineer for the queue.

## The Engineering Update brief and podcast

LUCID turns repository activity into a plain-language executive brief — readable, and
optionally listenable.[3]

1. Open the **Brief** rail.
2. Generate the **Engineering Update** — a plain-language summary of what the team and
   the agent shipped, drawn from the repo logs.
3. Optionally play it as a **podcast** through the audio backend.

![The Engineering Update brief with the podcast control](images/executive-engineering-brief.png)
*Figure 2 — The Engineering Update. Capture the generated brief with the play/podcast
control visible.*

> [!TIP]
> Use the brief before a stakeholder update — it's the "what happened and why it
> matters" in language you can forward, without reading a single diff.

## The governance posture tile

One tile rolls up the assurances a regulated program cares about.[4][5]

1. Open the **governance posture** tile. It surfaces:
   - **Gov-lockdown** — every turn routed through the accredited AskSage gateway, with
     direct providers hidden.
   - **FIPS** — FIPS-*approved* algorithms with OS-keystore key custody.
   - **CUI-isolated** — controlled content held in a separate, hard-isolated encrypted
     store.
   - **Audit-export-ready** — a metadata-only, SIEM-bound security-audit feed is wired.
2. Each light tells you whether that control is active for this deployment.

![The governance posture tile expanded](images/executive-governance-posture.png)
*Figure 3 — The governance posture tile. Capture the four lights — gov-lockdown, FIPS,
CUI-isolated, audit-export-ready — with their on/off state.*

> [!TIP]
> Screenshot this tile for board and ATO packages — four green lights is a one-glance
> statement that gov-lockdown, FIPS posture, CUI isolation, and audit export are all in
> force for the deployment.

> [!NOTE]
> LUCID is **honest about FIPS**: it uses FIPS-approved algorithms plus OS-keystore key
> custody, but it does **not** claim a FIPS *mode* it cannot self-certify — true
> 140-3 validation is an operating-system concern.[6][7]

> [!WARNING]
> Controlled (CUI) content is held in a separate encrypted store and is **never**
> included in exports or sent to a civilian endpoint by design.[5] Confirm the
> CUI-isolated light is on for any regulated program.

## Notes and References

1. "ADR-0088 — Role-based onboarding + opinionated, progressively-disclosed views (Dev / Sec / Mgr / Exec)." *LucidAgentIDE DECISIONS.md*, 2026, github.com/mlcyclops/lucidagentide/blob/master/DECISIONS.md. Accessed 29 June 2026. — The Executive foregrounding (four reassurance tiles + brief) and the defaults-not-enforcement rule.
2. "Token Cost Savings & Showback." *LucidAgentIDE README.md*, 2026, github.com/mlcyclops/lucidagentide/blob/master/README.md. Accessed 29 June 2026. — The spend rollup behind the monthly-spend tile.
3. "ADR-0070 / ADR-0071 — Executive Engineering Update brief + podcast (audio backend)." *LucidAgentIDE DECISIONS.md*, 2026, github.com/mlcyclops/lucidagentide/blob/master/DECISIONS.md. Accessed 29 June 2026. — The repo-logs → brief generator and the vendor-agnostic TTS seam.
4. "ADR-0068 / ADR-0069 — Enterprise managed policy + OCSF-aligned audit export." *LucidAgentIDE DECISIONS.md*, 2026, github.com/mlcyclops/lucidagentide/blob/master/DECISIONS.md. Accessed 29 June 2026. — Centrally-governed posture and the audit-export-ready light.
5. "ADR-0012 / ADR-0014 — Personalization compartments + hard CUI isolation." *LucidAgentIDE DECISIONS.md*, 2026, github.com/mlcyclops/lucidagentide/blob/master/DECISIONS.md. Accessed 29 June 2026. — The separate, hard-isolated encrypted CUI store behind the CUI-isolated light.
6. "Memory and the personalization graph." *LucidAgentIDE README.md*, 2026, github.com/mlcyclops/lucidagentide/blob/master/README.md. Accessed 29 June 2026. — The "honest about FIPS" posture: FIPS-approved algorithms + OS-keystore custody, no self-certified FIPS mode.
7. National Institute of Standards and Technology. *Security Requirements for Cryptographic Modules (FIPS PUB 140-3)*. NIST, 22 Mar. 2019, doi.org/10.6028/NIST.FIPS.140-3. Accessed 29 June 2026. — The validation standard LUCID is deliberately careful not to over-claim.
8. National Institute of Standards and Technology. *Artificial Intelligence Risk Management Framework (AI RMF 1.0)*. NIST, 26 Jan. 2023, doi.org/10.6028/NIST.AI.100-1. Accessed 29 June 2026. — The Govern / Map / Measure / Manage framing behind the governance-posture tile.
9. National Archives and Records Administration. "Controlled Unclassified Information (CUI)." *32 CFR Part 2002*, U.S. National Archives, 2016, www.archives.gov/cui. Accessed 29 June 2026. — The CUI program the hard-isolation control is designed to honor.
