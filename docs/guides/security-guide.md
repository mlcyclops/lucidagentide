# LUCID Security Engineer Guide

> For the person who has to trust the agent: the gate that can't fail open, the
> quarantine queue, the exec/egress approvals, and the metadata-only audit export.

When you pick **Security engineer** at onboarding, LUCID leads with the **Security
inspector**, keeps the gate **badge always on**, and turns **Dev-logs** on by default.

## Who this is for / What you'll see

You own the trust boundary. The Security view foregrounds the gate badge, the
quarantine/approvals queue, and the audit trail.

- **Lands on:** the Security inspector.
- **Default rails:** Chat, Security, Dev-logs, Memory.
- **Badge:** the Security badge is **always on** (green "0 / gate active", never hidden).

> [!IMPORTANT]
> Roles change **defaults and chrome, never enforcement**.[1][2] A Developer who never
> opens the Security panel is exactly as protected as you are: the fail-closed gate
> still blocks, the event is still emitted to the audit sink, and a real block
> **force-reveals** the Security surface for *every* role. Your job is visibility and
> triage, not a separate enforcement path.

## Getting started

1. On first run, pick **Security engineer** in the role picker (Step 1), then email
   (Step 2), then a guided tour (Step 3) that spotlights the Security rail + badge,
   the quarantine/approvals queue, Dev-logs, and the audit export.
2. The Security inspector is your landing surface; the badge sits in the status bar.
3. A managed GPO/MDM policy can **pin** your role and force-show the audit surface; it
   may only *tighten* the security knobs, never loosen them.

![The Security inspector as the landing surface with the always-on gate badge](images/security-onboarding.png)
*Figure 1 — The Security engineer landing view. Capture the Security inspector with
the green "gate active" badge in the status bar and the Dev-logs rail visible.*

> [!TIP]
> Keep the badge in your peripheral vision. It is green and quiet until something
> fires — the moment it lights, the Security panel reveals itself for you (and for
> everyone else on that build).

## The fail-closed gate and the Unicode scanner

LUCID's defense is a pure-Unicode scanner behind a gate that runs **in-process on
every tool call** and **cannot fail open**.[3]

1. Untrusted text flows through six stages: **Scan** (the `scanner-sidecar`) →
   **Decide** (`scanAndDecide`) → **Gate** (an omp pre-hook, in-process, every tool
   call) → **Label** (a closed set) → **Promote** (the promotion gate) → **Export**
   (`safe_export`, invisibles escaped).
2. The scanner finds **zero-width, bidi, tag-block, homoglyph, PUA, and `Cf`** control
   characters.[4]
3. If the scanner dies or returns garbage, the gate **blocks / quarantines** — never
   "safe."
4. Read a verdict in the Security panel; a blocked call looks like:
   `🛡️ [BLOCKED tool_call:bash] source=bash trust=quarantined severity=high findings=zero-width`.

![The Security panel showing a blocked tool call with findings](images/security-gate-scanner.png)
*Figure 2 — A live block. Capture the Security inspector showing a blocked `bash` call
with trust=quarantined, severity, and the finding type (e.g. zero-width).*

> [!WARNING]
> "Scan unavailable" is treated as "block," by design and by test — a permanent test
> kills the scanner mid-run and asserts the gate still blocks. Never wire any path that
> treats a missing scan result as a pass.[2]

> [!TIP]
> Homoglyph/confusable detection is precision-tuned and source-scoped — review the
> *source* on a finding, not just the character, when triaging a false-positive
> report.[4]

## Triage the quarantine and approvals queue

1. Open the **Security** rail to the quarantine / approvals queue.
2. Each entry shows the **source**, **trust label** (`trusted · untrusted ·
   suspicious · quarantined` — the only four values that exist), **severity**, and the
   **finding**.
3. Review the offending content (invisibles are rendered visibly), then **approve** or
   **dismiss**.
4. Every decision is recorded with a stable id for the audit trail.

![The quarantine / approvals queue with a finding selected](images/security-quarantine-queue.png)
*Figure 3 — The quarantine queue. Capture a selected finding showing source, trust
label, severity, and the human approve/dismiss controls.*

> [!TIP]
> Trust comes from the **source**, not the caller's word. A "please ignore previous
> instructions" string from a retrieved document is exactly what the delimiter +
> trust-label model is built to neutralize.

## Keep poison out of memory: the promotion gate

LUCID has two memories, and the **promotion gate** is the keystone that protects the
durable one.[2]

1. Working state and a semantic graph live in the store; only **promotion-gated**
   facts become durable semantic memory.
2. Content from a **suspicious or quarantined** source can **never auto-promote** into
   semantic memory — regardless of who asked.
3. Inspect what was promoted (and what was blocked from promotion) in the Memory rail.

![The promotion gate blocking a suspicious-source fact](images/security-promotion-gate.png)
*Figure 4 — The promotion gate. Capture a suspicious-source item being denied
promotion into semantic memory, with its trust label shown.*

> [!WARNING]
> This is over-tested for a reason (keystone #2). If you are extending memory, treat a
> failing promotion-gate test as a stop-the-line event — never relax it to make a
> feature pass.[2]

## Approve risky commands: per-action exec gating

The agent's `bash` and `eval` tools are gated per action, graded by risk tier.[5]

1. When the agent wants to run a command, LUCID classifies it into an ordered tier:
   **T0** read-only · **T1** local-mutate · **T2** reach-out · **T3** destructive ·
   **T4** catastrophic.
2. Read-only (T0) auto-runs; risky tiers **prompt you**; the **catastrophic (T4) set
   always prompts or blocks**.
3. Unknown or compound commands fail closed to a high tier (T3).
4. Approve or deny in the prompt; the decision is recorded.

![An exec-approval prompt showing the command's risk tier](images/security-exec-approval.png)
*Figure 5 — A per-action exec prompt. Capture a command with its classified tier
(e.g. T3 destructive) and the approve/deny controls.*

> [!TIP]
> The tier is the fast signal. If a "simple" command is graded T3, look again before
> approving — compound shell and unknown binaries are deliberately graded up.

## Govern the unattended loop: the Speed↔Risk dial

For the `/goal` loop running unattended, the **Speed↔Risk dial** decides which tiers
auto-run without a human prompt.[5]

1. Open the loop's advanced settings and set the per-command **dial** (a matrix from
   green → amber → red, one row per command type).
2. A command auto-runs only if its tier is **≤ the dial**; **T4 always blocks**; an
   unset dial is the safest (T0-only).
3. A managed policy can clamp the dial ceiling fleet-wide.
4. Every block is tallied in the loop's After-Action Report (risk-dial / catastrophic /
   security-gate counts, by tier).

![The Speed↔Risk dial matrix in the goal loop settings](images/security-speed-risk-dial.png)
*Figure 6 — The Speed↔Risk dial. Capture the per-command-type slider matrix
(green→amber→red) with the dial posture shown in the header.*

> [!WARNING]
> The dial governs **unattended** automation. Raising it trades human review for
> speed — set it conservatively for anything that can reach out or mutate, and let T4
> stay blocked always.

## Control where the agent reaches: per-website egress approval

1. When a tool tries to reach a website, LUCID prompts for **per-site approval**.
2. Approve a host once, or deny it; the decision composes with the content gate.
3. Egress blocks are recorded and surfaced alongside other findings.

![A per-website egress approval prompt](images/security-egress-approval.png)
*Figure 7 — A per-website egress prompt. Capture the requested host and the
approve/deny choice for an agent network-reaching tool.*

> [!TIP]
> Approvals are per **host** — approving one site does not open the rest. Treat each
> new host as a fresh decision.

## Ship the evidence: OCSF audit export

LUCID emits a metadata-only, **OCSF-aligned** security-audit feed designed to land in
your SIEM.[6]

1. Open the **Security event export (SIEM)** card in the Logs view.
2. Every scanner block, approve/dismiss, exec/egress decision, and loop block becomes
   a canonical `SecurityEvent`, mapped to OCSF (Detection Finding, class 2004).
3. The default **FileSink** appends to `~/.omp/lucid-audit.jsonl`; per-sink delivery
   status (✓/✕) is shown.
4. Records are **metadata only** — no code, prompts, or CUI ever leave the host.

![The SIEM audit-export card with per-sink delivery status](images/security-audit-export.png)
*Figure 8 — The audit-export card. Capture the unified event stream with per-sink
delivery status (✓/✕) and an OCSF-mapped record expanded.*

> [!NOTE]
> A dead or slow sink **never throws into a turn** — the dispatcher maps once, fans
> out, and ring-buffers. Audit export can never become a denial-of-service on the
> agent.[6]

## Notes and References

1. "ADR-0088 — Role-based onboarding + opinionated, progressively-disclosed views (Dev / Sec / Mgr / Exec)." *LucidAgentIDE DECISIONS.md*, 2026, github.com/mlcyclops/lucidagentide/blob/master/DECISIONS.md. Accessed 29 June 2026. — Roles change defaults and chrome, never enforcement; a real block force-reveals Security for every role.
2. "Invariants" and "Two correctness keystones." *LucidAgentIDE AGENTS.md / CLAUDE.md*, 2026, github.com/mlcyclops/lucidagentide/blob/master/AGENTS.md. Accessed 29 June 2026. — Fail-closed is law; the closed trust-label set; untrusted content delimited and late; the over-tested scanner and promotion gate.
3. "Security model." *LucidAgentIDE README.md*, 2026, github.com/mlcyclops/lucidagentide/blob/master/README.md. Accessed 29 June 2026. — The Scan → Decide → Gate → Label → Promote → Export stages and the in-process, fail-closed gate.
4. "ADR-0019 — Scanner homoglyph precision + source-scoped gate + block observability." *LucidAgentIDE DECISIONS.md*, 2026, github.com/mlcyclops/lucidagentide/blob/master/DECISIONS.md. Accessed 29 June 2026. — The scanner finding types and source-scoped, observable blocks.
5. "ADR-0066 / ADR-0067 — Per-action exec approval + the per-command Speed↔Risk dial." *LucidAgentIDE DECISIONS.md*, 2026, github.com/mlcyclops/lucidagentide/blob/master/DECISIONS.md. Accessed 29 June 2026. — The T0–T4 risk tiers, the always-block catastrophic set, and the unattended-loop dial.
6. "ADR-0068 / ADR-0069 — Enterprise managed policy + the OCSF-aligned, SIEM-ready security-audit export." *LucidAgentIDE DECISIONS.md*, 2026, github.com/mlcyclops/lucidagentide/blob/master/DECISIONS.md. Accessed 29 June 2026. — Managed policy that only tightens, and the metadata-only, fail-safe OCSF audit export.
7. "ADR-0062 — Per-website egress approval." *LucidAgentIDE DECISIONS.md*, 2026, github.com/mlcyclops/lucidagentide/blob/master/DECISIONS.md. Accessed 29 June 2026. — Per-host approval for the agent's network-reaching tools.
8. OWASP Foundation. "LLM01: Prompt Injection." *OWASP Top 10 for LLM Applications*, 2025, genai.owasp.org/llmrisk/llm01-prompt-injection/. Accessed 29 June 2026. — The canonical threat the delimiter + trust-label + scanner design defends against.
9. Willison, Simon. "Prompt Injection: What's the Worst That Can Happen?" *simonwillison.net*, 14 Apr. 2023, simonwillison.net/2023/Apr/14/worst-that-can-happen/. Accessed 29 June 2026. — Why untrusted content must be treated as data, never instructions.
10. The Unicode Consortium. *Unicode Technical Standard #39: Unicode Security Mechanisms*. Unicode, Inc., 2023, www.unicode.org/reports/tr39/. Accessed 29 June 2026. — The confusables / homoglyph and identifier-security basis for the scanner's homoglyph detection.
11. National Institute of Standards and Technology. *Artificial Intelligence Risk Management Framework (AI RMF 1.0)*. NIST, 26 Jan. 2023, doi.org/10.6028/NIST.AI.100-1. Accessed 29 June 2026. — Govern / Map / Measure / Manage functions that map onto the gate, audit trail, and managed policy.
