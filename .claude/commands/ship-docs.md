---
description: Review what happened this session and ship the docs (PROGRESS / HANDOFF / README)
argument-hint: "[optional focus note]"
allowed-tools: Bash(git status:*), Bash(git log:*), Bash(git diff:*), Bash(git rev-list:*), Bash(bun test:*), Bash(bun run:*), Read, Edit, Write
---

You are wrapping up a work session on the Lucid Agent IDE harness. Review what
happened and ship the documentation. Be accurate — never claim something passed
that you did not just run.

## 1. Review the session
- `git log --oneline -15` and `git diff --stat HEAD~1` (or the session's first
  commit) to see what shipped.
- `git status` for anything uncommitted.
- Read the latest entry in `PROGRESS.md` to see where the last increment left off.
- Optional focus from the user: $ARGUMENTS

## 2. Verify green before documenting
- Run `bun test harness` and report the real pass/fail count.
- Run the latest `demo-*` (the increment just built) and confirm it passes.
- If anything is red, STOP and report it — do not write "green" docs over a
  failing tree.

## 3. Ship the docs
- **PROGRESS.md**: append exactly one dated entry with three lines —
  `shipped:` / `stubbed:` / `next:` (the session ritual). Convert relative dates
  to absolute.
- **HANDOFF.md**: refresh "current state", "how to run", and "next increment" so a
  fresh or remote agent can pick up cold.
- **README.md**: update the Status block only if the demo/test counts changed.
- Respect the frozen contracts (CLAUDE.md): do not edit `contracts.ts`,
  `result_adapter.ts`, the frozen prompt prefix, or applied migrations as a side
  effect of doc work.

## 4. Summarize
Report: what shipped, the verified test/demo counts, what's stubbed, and the
single next increment. Do NOT commit or push unless the user explicitly asks.
