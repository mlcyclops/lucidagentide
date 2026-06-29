# LUCID Manager Guide

> For the person accountable for spend and delivery: cross-model cost showback, an
> AI-authorship ledger, loop success metrics, and a hard budget kill switch.

When you pick **Manager** at onboarding, LUCID leads with the **cost / delivery
ledger** and keeps the loop's After-Action reports close. Security appears as a quiet
**count rollup**, not the full findings table.

## Who this is for / What you'll see

You're tracking what AI costs and what it produces. The Manager view foregrounds the
cost ledger, the AI-authorship ledger, and loop delivery metrics.

- **Lands on:** the cost / delivery ledger.
- **Default rails:** Chat, Memory → Ledger, Loop / After-Action Report.
- **Security:** a count-rollup chip (posture at a glance), not the triage queue.

> [!NOTE]
> A role changes **what is foregrounded**, never what is enforced.[1] The fail-closed
> security gate protects a Manager session exactly as it protects a Security
> engineer's; you simply see posture as a rollup instead of a queue. Anything hidden
> is one `⌘K` / `Ctrl+K` away, and a real block surfaces Security for every role.

## Getting started

1. On first run, pick **Manager** (Step 1), enter your email (Step 2), and take the
   guided tour (Step 3) — it spotlights the cost ledger, the loop / AAR view, and the
   spend + budget pills.
2. Your landing surface is the ledger; the Memory rail is re-pointed at it.
3. Switch roles any time in **Settings → Profile**.

![The Manager landing view on the cost / delivery ledger](images/manager-onboarding.png)
*Figure 1 — The Manager landing view. Capture the cost / delivery ledger as the
landing surface, with the spend and budget pills in the status bar.*

> [!TIP]
> Treat the ledger like any other cloud bill: the goal is **showback** — attributing
> AI cost to projects and people — not surprise at month's end.

## Read the Cost & Savings Ledger

LUCID gives you real-time cost visibility across every model and session.[2][3]

1. Open the **Cost & Savings Ledger**.
2. Read the headline rollups: **total spend** (all models), **estimated cache
   savings** (with % off full price), **cache hit-rate**, **tokens processed**, and
   **models used**.
3. Drill into the **per-model breakdown** — turns, tokens, cost, saved, and cache %
   per model.
4. Drill further **per session** by model, turn count, and token volume.

![The Cost & Savings Ledger with per-model breakdown](images/manager-cost-ledger.png)
*Figure 2 — The Cost & Savings Ledger. Capture the headline rollups (spend, est. cache
savings, hit-rate) above the per-model breakdown table.*

> [!TIP]
> "Estimated cache savings" is real money the cache-stable prompt prefix saves you.
> If a model's cache % is low, its prompts are churning — a candidate for review.

## Attribute output: the AI-authorship LOC ledger

Beyond cost, LUCID keeps a tamper-evident ledger of **which model wrote which
lines**.[4]

1. Open the **AI-authored Code Ledger**.
2. See lines of code attributed **per model, per repo, and per identity** — counted at
   the gate, not inferred from git activity alone.
3. Use it for showback of AI *productivity* alongside AI *spend*.

![The AI-authored code ledger by model and repo](images/manager-ai-loc-ledger.png)
*Figure 3 — The AI-authorship ledger. Capture LOC attributed per model and repo, with
the identity dimension visible.*

> [!NOTE]
> This is **authorship attribution**, not a productivity quota. Lines-of-code is a
> volume signal; pair it with the loop success metrics below before drawing
> conclusions about delivery.

## Track delivery: `/goal` loop metrics and After-Action Reports

The `/goal` loop turns "run the agent" into measurable delivery.[5][6]

1. Open the **loop / cross-run evaluation** view.
2. Read **success rate** and **average iterations-to-win** across runs, plus a failure
   breakdown.
3. Open a single run's **After-Action Report** — Mermaid graphs of tool calls by type,
   lines of code ±, errors, and sites visited, plus the blocks tally.

![A /goal After-Action Report with Mermaid graphs](images/manager-loop-aar.png)
*Figure 4 — A `/goal` After-Action Report. Capture the run's metrics with the Mermaid
graphs (tool calls by type, LOC ±, errors) and the blocks section.*

> [!TIP]
> Watch **iterations-to-win** trend, not just success rate. Rising iterations on the
> same class of task is an early signal that a prompt, model, or stop condition needs
> attention.

## Cap the bill: the budget kill switch

1. Before an unattended run, set a hard **budget cap** in dollars.
2. If a run crosses the cap, LUCID **aborts it mid-turn** — the cap is a kill switch,
   not a warning.
3. The live spend meter shows actuals against the cap during the run.

![The budget cap and live spend meter on a loop run](images/manager-budget-kill-switch.png)
*Figure 5 — The budget kill switch. Capture the per-run budget cap with the live spend
meter approaching it.*

> [!WARNING]
> The cap is enforced **mid-turn**, so an unattended loop can't blow the budget while
> you're away. Set it on every scheduled or long-running automation.

## Watch governed usage: AskSage gov-quota

1. If your org routes through the **AskSage** government gateway, the model picker shows
   a **monthly token-quota meter**.
2. Track gov-usage % against the quota so a program doesn't run out mid-month.

![The AskSage monthly token-quota meter](images/manager-asksage-usage.png)
*Figure 6 — The AskSage gov-usage meter. Capture the monthly token-quota meter with
current usage against the quota.*

> [!TIP]
> If quota is tight, the optional on-device **headroom** compression proxy can stretch
> it — coordinate with your Security engineer before enabling it.

## Notes and References

1. TechLead 187 LLC. "ADR-0088 — Role-based onboarding + opinionated, progressively-disclosed views (Dev / Sec / Mgr / Exec)." *LucidAgentIDE DECISIONS.md*, 2026, github.com/mlcyclops/lucidagentide/blob/master/DECISIONS.md. Accessed 29 June 2026. — The Manager foregrounding (ledger + count-rollup) and the defaults-not-enforcement rule.
2. TechLead 187 LLC. "Token Cost Savings & Showback." *LucidAgentIDE README.md*, 2026, github.com/mlcyclops/lucidagentide/blob/master/README.md. Accessed 29 June 2026. — The ledger's rollups, per-model breakdown, and showback framing.
3. TechLead 187 LLC. "ADR-0011 — Observability & cost intelligence." *LucidAgentIDE DECISIONS.md*, 2026, github.com/mlcyclops/lucidagentide/blob/master/DECISIONS.md. Accessed 29 June 2026. — The cross-model usage and cost ledger.
4. TechLead 187 LLC. "ADR-0031 — AI-LOC attribution: count AI-authored lines at the gate, per model/repo/identity." *LucidAgentIDE DECISIONS.md*, 2026, github.com/mlcyclops/lucidagentide/blob/master/DECISIONS.md. Accessed 29 June 2026. — The authorship ledger and how lines are attributed at the gate.
5. TechLead 187 LLC. "ADR-0054 through ADR-0056 — Loop engineering: After-Action Report, cross-run evaluation, and the budget kill switch." *LucidAgentIDE DECISIONS.md*, 2026, github.com/mlcyclops/lucidagentide/blob/master/DECISIONS.md. Accessed 29 June 2026. — Success rate, iterations-to-win, the AAR graphs, and the hard budget cap.
6. TechLead 187 LLC. "ADR-0046 through ADR-0050 — The `/goal` loop, checker model, and launcher." *LucidAgentIDE DECISIONS.md*, 2026, github.com/mlcyclops/lucidagentide/blob/master/DECISIONS.md. Accessed 29 June 2026. — The loop the delivery metrics are measured over.
7. FinOps Foundation. "What Is FinOps?" *FinOps Foundation*, The Linux Foundation, 2024, www.finops.org/introduction/what-is-finops/. Accessed 29 June 2026. — Showback / chargeback practice for attributing variable cloud (and here, AI) spend to teams and projects.
8. Forsgren, Nicole, Jez Humble, and Gene Kim. *Accelerate: The Science of Lean Software and DevOps: Building and Scaling High Performing Technology Organizations*. IT Revolution Press, 2018. — The delivery-metrics discipline (DORA) behind reading success rate and iterations-to-win as signals, not vanity numbers.
