# LUCID Developer Guide

> For engineers writing code with LUCID: chat to a model, edit and save through a
> security gate that can't fail open, and keep your context (and your bill) under control.

Developer is LUCID's **default role**. When you pick it at onboarding, the IDE leads
with the surface you live in: **Chat** plus the **Memory** inspector (context fill,
cache %, and session cost), with the **Knowledge** rail close at hand.

## Who this is for / What you'll see

You're here to build. The Developer view foregrounds the composer, the model picker,
the Memory inspector, and the read-write code editor; Dev-logs are available when you
enable developer mode.

- **Lands on:** Chat + Memory (context / cache / cost).
- **Default rails:** Chat, Memory, Knowledge.

> [!NOTE]
> A role only changes **what is foregrounded** — never what is enforced. The
> fail-closed security gate is identical for every role, nothing is ever hidden for
> good (any panel is one `⌘K` / `Ctrl+K` away, or **Settings → Show all panels**),
> and a real security block surfaces the Security panel even for a Developer.[1][2]

## Getting started

1. Launch LUCID. On first run, **Step 1** is the role picker — choose **Developer**.
2. **Step 2** captures your email (or skips to workstation attribution).
3. **Step 3** runs a one-time guided tour that spotlights your composer, the model
   picker, the Memory inspector, the Knowledge rail, and the Command palette. Press
   **Skip** any time; replay it later from **About → Take the tour**.
4. Change your mind later? Switch roles in **Settings → Profile**.

![The four-card role picker with Developer selected](images/developer-onboarding.png)
*Figure 1 — The first-run role picker. Capture the four animated role cards with
**Developer** highlighted, showing its "lands on Chat + Memory" one-liner.*

> [!TIP]
> Developer is the safe, full-surface default. If you're not sure which role fits,
> start here — you can see everything and re-shape later from Settings → Profile.

## Sign in and pick a model

LUCID doesn't lock you to one vendor — it exposes the model catalog from the
underlying runtime (oh-my-pi) and lets you authenticate either way.[3]

1. Open the **model picker** from the composer.
2. **Sign in with a subscription (OAuth)** — use your existing Claude Pro/Max,
   ChatGPT Plus/Pro, or Google Gemini login. No API key, no per-token bill; the
   runtime's secure credential vault owns the tokens.
3. **Or paste an API key (metered)** for pay-as-you-go, with the real remaining rate
   limit read from response headers.
4. Hover any model to read its **cost + intelligence card** — token expense,
   capability stars, best-use, and context window — then pick by capability and price.

![The model picker with a model's hover card open](images/developer-model-picker.png)
*Figure 2 — The model picker. Capture the searchable model list with one model's
premium hover card open, showing token expense, intelligence stars, best-use, and
context size.*

> [!TIP]
> The security gate scans every turn the same way regardless of which model you pick,
> so choose purely on capability and cost — drop to a cheaper tier for routine edits
> and save the frontier model for hard reasoning.

> [!NOTE]
> Non-U.S. / restricted-origin models stay behind a data-sovereignty acknowledgement,
> and an enterprise policy can pin your org to the gov gateway only.[3]

## Choose an edit mode: Plan, Ask, or Agent

LUCID exposes three edit modes plus live thought streaming so you control how much
autonomy the agent has.[4]

1. In the composer, pick the **mode** control:
   - **Plan** — the agent proposes a plan and waits; nothing is changed yet.
   - **Ask** — the agent answers and asks before acting.
   - **Agent** — the agent edits and runs tools to carry the task through.
2. Watch the **live thought stream** as the agent reasons and calls tools.
3. Switch modes mid-session as the task changes — scope a plan first, then flip to
   Agent to execute it.

![The composer mode selector with the live thought stream](images/developer-edit-modes.png)
*Figure 3 — The composer's Plan / Ask / Agent selector with the live thought stream
visible below. Capture mid-task with a tool call streaming.*

> [!TIP]
> Start a risky or large change in **Plan** mode to review the approach before a
> single file changes, then switch to **Agent** once the plan looks right.

## Watch your context, cache, and cost

The Memory inspector is your dashboard for the conversation itself — how full the
context window is, how well the prompt cache is hitting, and what the session costs.

1. Open the **Memory** rail.
2. Read **context-fill** (how much of the window is used), **cache %** (how much of
   the prompt is being reused), and **session cost**.
3. When context-fill climbs, compact or start a fresh session to keep latency and
   cost down.

![The Memory inspector showing context, cache, and cost](images/developer-memory-inspector.png)
*Figure 4 — The Memory inspector. Capture the context-fill ring, cache-% readout, and
session-cost figure for an in-progress session.*

> [!TIP]
> LUCID keeps the safety layers of the prompt **byte-identical on every request** and
> places anything volatile *after* the cache breakpoint. That cache-stable prefix is
> why your cache-% stays high and your bill stays low — don't fight it by pasting huge
> volatile blobs into the system area.[5]

## Edit code — where *Save* is scanned

LUCID's editor is read-write, and **every Save runs through the same security gate**
as everything else.[6]

1. Open a file in the editor and make your changes.
2. Press **Save**. The content is scanned before a byte lands on disk.
3. If the scanner finds a high-severity issue (for example a hidden-Unicode payload)
   or the scanner is unavailable, the **write is blocked** and you're told why.
4. Use **Save-As**, the **conflict banner** (on concurrent edits), or **Send to chat**
   to hand a file back to the agent.

![A blocked Save with the gate's finding banner](images/developer-gated-save.png)
*Figure 5 — A gated Save. Capture the editor showing a blocked write with the finding
("hidden Unicode" / severity high) and the explanation.*

> [!WARNING]
> A blocked Save is the gate doing its job, not a bug. If a paste carried an invisible
> payload, LUCID stops it **before** it reaches disk — review the finding rather than
> forcing the write.

## Bring documents in: Knowledge & RAG

Add your own PDFs and images to the agent's context — parsed, embedded, and indexed
**entirely on your machine**.[7]

1. Open the **Knowledge** rail and drag in a PDF or image.
2. A guided popup shows a **parse-and-scan preview**: what text was extracted and the
   gate's verdict — *before* anything is stored.
3. Approve, and the content is embedded into an **air-gapped vector store** for
   semantic recall. No document leaves the host.

![The Knowledge ingest parse-and-scan preview](images/developer-knowledge-rag.png)
*Figure 6 — The Knowledge ingest walkthrough. Capture the parse-and-scan preview of a
dropped PDF, showing extracted text and the gate's verdict before storage.*

> [!TIP]
> Embeddings run as WASM with bundled weights — no GPU, no native binaries — so
> Knowledge works fully offline on a standard laptop.[7]

> [!NOTE]
> Every ingested chunk runs the same lifecycle as everything else: scanned,
> trust-labeled, and quarantined if poisoned, *before* it can be embedded or recalled.

## Run a task to a verified finish: the `/goal` loop

`/goal` runs an agent to a **verified** stop condition — not just a loop, but loop
engineering with guards and a report.[8]

1. Type `/goal` and describe the objective and how "done" is checked.
2. LUCID iterates with a **maker** model and a separate, cheaper **checker** model
   that grades against your stop condition.
3. A **budget kill switch** caps spend; **stall guards** stop a loop that isn't
   converging; an **after-action report** summarizes what happened.

![The /goal launcher with stop condition and budget](images/developer-goal-loop.png)
*Figure 7 — The `/goal` launcher. Capture the objective, the checker-model choice, and
the budget cap before a run starts.*

> [!TIP]
> Spend a sentence on the **stop condition** — "tests pass and `tsc` is clean" beats
> "make it work." The checker is only as good as the criterion you give it.

## Move fast with the Command palette

1. Press `⌘K` (macOS) or `Ctrl+K` (Windows/Linux) to open the palette.
2. Jump to any panel, command, or setting — including surfaces your role doesn't
   foreground by default.
3. To seed your context from elsewhere, run a **one-command import** of your
   ChatGPT / Claude / Gemini history (every message scanned, then distilled).

![The Command palette open over the IDE](images/developer-command-palette.png)
*Figure 8 — The Command palette. Capture it open with a search query resolving to a
panel and a command.*

> [!TIP]
> The palette reaches **everything**, including hidden panels. It's the fastest way to
> open the Security or Knowledge view without changing your role.

## Notes and References

1. "ADR-0088 — Role-based onboarding + opinionated, progressively-disclosed views (Dev / Sec / Mgr / Exec)." *LucidAgentIDE DECISIONS.md*, 2026, github.com/mlcyclops/lucidagentide/blob/master/DECISIONS.md. Accessed 29 June 2026. — Why roles change defaults and chrome, never enforcement.
2. "Invariants." *LucidAgentIDE CLAUDE.md*, 2026, github.com/mlcyclops/lucidagentide/blob/master/CLAUDE.md. Accessed 29 June 2026. — The fail-closed gate and byte-stable prefix that hold for every role.
3. "Any model, any provider." *LucidAgentIDE README.md*, 2026, github.com/mlcyclops/lucidagentide/blob/master/README.md. Accessed 29 June 2026. — OAuth-or-API-key sign-in, the cost + intelligence card, and the sovereignty acknowledgement.
4. "ADR-0027 — ACP edit modes (Plan / Ask / Agent) + live thought streaming." *LucidAgentIDE DECISIONS.md*, 2026, github.com/mlcyclops/lucidagentide/blob/master/DECISIONS.md. Accessed 29 June 2026. — The three edit modes and the live thought stream.
5. "Architecture." *LucidAgentIDE README.md*, 2026, github.com/mlcyclops/lucidagentide/blob/master/README.md. Accessed 29 June 2026. — The frozen, cache-stable prefix and the volatile post-cache tail that keep cache-% high.
6. "ADR-0036 / ADR-0037 — Read-write IDE with a gated Save." *LucidAgentIDE DECISIONS.md*, 2026, github.com/mlcyclops/lucidagentide/blob/master/DECISIONS.md. Accessed 29 June 2026. — Save routed through the scanner gate; a high finding or dead scanner blocks the write.
7. "ADR-0058 / ADR-0063 / ADR-0064 — Local RAG knowledge spine." *LucidAgentIDE DECISIONS.md*, 2026, github.com/mlcyclops/lucidagentide/blob/master/DECISIONS.md. Accessed 29 June 2026. — Scan-gated PDF ingest into an air-gapped, on-device vector store with WASM embeddings.
8. "ADR-0046 through ADR-0050 — The `/goal` loop, checker model, and launcher." *LucidAgentIDE DECISIONS.md*, 2026, github.com/mlcyclops/lucidagentide/blob/master/DECISIONS.md. Accessed 29 June 2026. — Maker/checker iteration with a verified stop condition, budget kill switch, and after-action report.
9. "Day-to-day commands." *LucidAgentIDE CHEATSHEET.md*, 2026, github.com/mlcyclops/lucidagentide/blob/master/CHEATSHEET.md. Accessed 29 June 2026. — The command and slash-command reference.
10. Nielsen, Jakob. "10 Usability Heuristics for User Interface Design." *Nielsen Norman Group*, 24 Apr. 1994, updated 30 Jan. 2024, www.nngroup.com/articles/ten-usability-heuristics/. Accessed 29 June 2026. — "Recognition rather than recall" and progressive disclosure: why the role view foregrounds a few surfaces and keeps the rest one palette command away.
11. Greyling, Cobus. *Loop-Engineering*. GitHub, 2024, github.com/cobusgreyling/loop-engineering. Accessed 29 June 2026. — The loop-engineering playbook that informs the `/goal` maker/checker design.
