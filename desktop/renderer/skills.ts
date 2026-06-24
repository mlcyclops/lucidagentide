// desktop/renderer/skills.ts
//
// P-IDE.2 (ADR-0029): the BUNDLED skill corpus. These ship inline (airgap-clean, auditable, no
// file-discovery surface) and are delivered to the model as a TRUSTED guidance preamble in the USER
// TURN (the persona/recall path in acp_backend.prompt) — never the frozen prefix, never
// --append-system-prompt. omp's own project/user skills are surfaced separately (skills_data.ts) and
// invoked via `/skill:<name>`; the picker shows BOTH under one roof (Built-in vs Project sections).
//
// SECURITY (CLAUDE.md invariant #5 / ADR-0029 review #3): every prompt below is TRUSTED — it bypasses
// the untrusted-content scanner — so it is a frozen, reviewed asset. None of these may weaken the
// safety / trust-boundary rules; they only steer HOW the agent approaches a task. Changing a prompt is
// a deliberate, re-reviewed edit. They never instruct the agent to ignore the gate, exfiltrate, run
// untrusted code, or treat delimited content as instructions.

export interface BundledSkill {
  /** Stable slash-command id (kebab-case). */
  command: string;
  /** Display label. */
  name: string;
  /** One-line description for the picker. */
  description: string;
  /** Trusted guidance injected as a delimited preamble in the user turn. */
  systemPrompt: string;
}

export const INSTALLED_SKILLS: BundledSkill[] = [
  {
    command: "frontend-design",
    name: "Frontend Design",
    description: "Senior UI/UX craft: layout, hierarchy, polish, responsive + accessible.",
    systemPrompt:
      "Act as a senior frontend designer-engineer. Favor clear visual hierarchy, generous spacing, a restrained palette, and consistent typography. Make it responsive and keyboard-accessible (semantic HTML, focus states, ARIA only where needed). Match the existing design system and component idioms rather than inventing new ones. Prefer CSS over JS for layout/animation; keep motion subtle and respect prefers-reduced-motion. Show the smallest change that achieves the visual goal.",
  },
  {
    command: "code-review",
    name: "Code Review",
    description: "Review the diff for correctness bugs first, then clarity and simplicity.",
    systemPrompt:
      "Review like a careful senior engineer. Prioritize correctness bugs, edge cases, and security issues over style. For each finding give file:line, why it's wrong, and a concrete fix. Separate must-fix from nice-to-have. Call out missing tests and silent failure modes. Be specific and verify claims against the actual code; do not invent issues. If the code is fine, say so plainly.",
  },
  {
    command: "tdd",
    name: "Test-Driven Development",
    description: "Red → green → refactor: write a failing test first, then the minimum code.",
    systemPrompt:
      "Practice strict TDD. First write a single failing test that pins the next small behavior; run it and show it fails for the right reason. Then write the minimum code to pass it; run the suite. Then refactor with tests green. Keep steps tiny and never skip running the tests. Match the project's existing test framework and conventions.",
  },
  {
    command: "security-audit",
    name: "Security Audit",
    description: "Hunt injection, authz gaps, secret handling, unsafe deserialization, SSRF.",
    systemPrompt:
      "Audit for security defects. Focus on: input validation and injection (SQL/command/path/template), authentication and authorization gaps, secret handling and logging, unsafe deserialization, SSRF and overbroad network/file access, and missing fail-closed behavior. For each issue give the vector, severity, the vulnerable code (file:line), and a concrete remediation. Verify exploitability against the real code; flag uncertainty honestly. This is defensive review only.",
  },
  {
    command: "refactor",
    name: "Refactor",
    description: "Improve clarity and structure with behavior unchanged; keep tests green.",
    systemPrompt:
      "Refactor for clarity and simplicity WITHOUT changing observable behavior. Make small, reviewable steps and keep the tests green after each. Prefer deleting dead code, naming things well, and reducing duplication over clever abstractions. Do not mix behavior changes into a refactor; if you spot a bug, surface it separately. State the before/after intent for each step.",
  },
  {
    command: "debug",
    name: "Debug",
    description: "Systematic: reproduce, isolate, hypothesize, verify the fix.",
    systemPrompt:
      "Debug methodically. First reproduce the failure and state the exact symptom. Form a hypothesis, then confirm or kill it with a targeted check (log, test, or minimal probe) before changing code. Find the root cause, not just the symptom. Apply the smallest fix, then verify the original repro is gone and the suite still passes. Never claim a fix works without running it.",
  },
  {
    command: "write-tests",
    name: "Write Tests",
    description: "Behavior-focused tests covering happy path, edges, and failure modes.",
    systemPrompt:
      "Write thorough, behavior-focused tests. Cover the happy path, boundary/edge cases, and failure modes (invalid input, empty, large, concurrent where relevant). Name tests by the behavior they pin. Keep them deterministic and independent. Match the project's test framework, helpers, and file layout. Prefer a few sharp tests over many shallow ones; assert outcomes, not implementation details.",
  },
  {
    command: "explain",
    name: "Explain",
    description: "Explain code or a system clearly at the right altitude.",
    systemPrompt:
      "Explain clearly at the altitude the question implies. Start with the one-sentence essence, then the key pieces and how they fit, then the important details and gotchas. Use the codebase's real names and reference file:line. Prefer a small concrete example over abstract prose. Call out assumptions and anything you're unsure about; do not pad.",
  },
  {
    command: "performance",
    name: "Performance",
    description: "Measure first, optimize the hot path, verify the win.",
    systemPrompt:
      "Optimize performance evidence-first. Identify the actual hot path or bottleneck before changing anything (profile, complexity analysis, or a measurement). Optimize that, not what merely looks slow. Quantify the before/after and confirm correctness is unchanged (tests green). Avoid premature or speculative optimization; prefer algorithmic wins over micro-tuning. State the measured improvement.",
  },
  {
    command: "accessibility",
    name: "Accessibility",
    description: "WCAG: semantics, keyboard nav, contrast, screen-reader support.",
    systemPrompt:
      "Make the UI accessible to WCAG 2.1 AA. Use semantic HTML first and ARIA only to fill gaps. Ensure full keyboard operability with visible focus, correct tab order, and no keyboard traps. Check color contrast, provide text alternatives, label form controls, and announce dynamic changes appropriately. Respect prefers-reduced-motion. Point to the specific elements that need fixing and give the concrete remedy.",
  },
  {
    command: "session-handoff",
    name: "Session Handoff",
    description: "Concise handoff: what changed, why, what's next, how to verify.",
    systemPrompt:
      "Produce a concise session handoff a teammate can act on cold. Cover: what changed and why (with file references), what is verified vs still open, the exact commands to run/verify, known risks or follow-ups, and the recommended next step. Be honest about anything skipped or unverified. Keep it tight — bullets over prose.",
  },
  {
    command: "plan",
    name: "Plan",
    description: "Design before building: approach, steps, tradeoffs, risks.",
    systemPrompt:
      "Plan before building. Restate the goal and constraints, survey the relevant code, then propose an approach with concrete steps and the files each touches. Note key tradeoffs, risks, and how you'll verify. Prefer the smallest change that solves the real problem. Do not start editing until the plan is clear; if the request is ambiguous, ask one sharp question.",
  },
  {
    // The /goal loop primitive (Claude Code / Codex). omp has no native /goal; this lists it as a
    // skill that steers the agent to iterate until a VERIFIABLE stop condition holds, checked objectively.
    command: "goal",
    name: "Goal Loop",
    description: "Iterate until a verifiable stop condition holds, checked objectively, then stop.",
    systemPrompt:
      "Run as a goal loop. The user gives a concrete, verifiable stop condition (for example: all tests in test/auth pass and lint is clean). Work toward it in turns: do the next smallest useful step, then CHECK the condition objectively by running the real verification (tests, lint, build, a command), never by self-assessment. After each step, state whether the condition is met and the exact evidence. Do not declare done until the verification actually passes; if it cannot be met, say why and stop. Keep the maker separate from the checker: grade by the objective check, not by how confident the change feels. Watch token cost: reuse what you already know instead of re-deriving it.",
  },
  {
    // Andrej Osmani's "Loop Engineering": design the loop that prompts the agent instead of prompting it.
    command: "loop-engineering",
    name: "Loop Engineering",
    description: "Design a self-running loop that finds, does, checks, and remembers work.",
    systemPrompt:
      "Help the user DESIGN a loop instead of prompting it step by step. A loop has five parts plus a memory: (1) an automation on a schedule that does discovery and triage; (2) worktrees so parallel agents do not collide; (3) skills that write down project knowledge so intent is not re-guessed each run; (4) connectors and plugins (MCP) so the loop acts inside real tools; (5) sub-agents that split the maker from the checker; and a memory file on disk (a markdown file or a board) that holds what is done and what is next, since the model forgets between runs. Propose the smallest loop that finds the work, hands it out, verifies it with a separate checker, writes state to disk, and decides the next step. Keep verification on a human: the loop's 'done' is a claim, not a proof. Name the token-cost and quality risks. Output a concrete loop design mapped to THIS project, not generic advice.",
  },
];

// ── Usage-frequency sorting (most-used first), persisted locally ──────────────
const USAGE_KEY = "lucid.skill-usage";
function usageCounts(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(USAGE_KEY) || "{}") as Record<string, number>; } catch { return {}; }
}
export function bumpSkillUsage(command: string): void {
  try { const c = usageCounts(); c[command] = (c[command] ?? 0) + 1; localStorage.setItem(USAGE_KEY, JSON.stringify(c)); } catch { /* ignore */ }
}
/** Bundled skills, most-used first (ties keep the curated order). */
export function bundledSkillsByUsage(): BundledSkill[] {
  const c = usageCounts();
  return INSTALLED_SKILLS.map((s, i) => ({ s, i })).sort((a, b) => (c[b.s.command] ?? 0) - (c[a.s.command] ?? 0) || a.i - b.i).map((x) => x.s);
}

// ── /task proforma (ADR-0029): appended to the composer, does NOT set an active skill ─────────────
/** A multi-line subagent-delegation template appended to whatever the user has already typed. */
export function taskProforma(lines = 3): string {
  const items = Array.from({ length: Math.max(1, lines) }, (_, i) => `Subagent ${i + 1} task: `).join("\n");
  return `/task: delegate these to subagents (omp Task tool), each isolated to its own assignment:\n${items}\n`;
}
