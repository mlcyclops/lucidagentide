# UX PR checklist

The standing check for every pull request that touches a UI or UX surface of LUCID Agent IDE
(AGENTS.md invariant #12, ADR-0617). The baseline it protects is `docs/UX-REVIEW.md`.

## When it applies

Any changed path under `desktop/renderer/**` (except `*.test.ts`, `*.bundle.js`, `vendor/`),
`desktop/*.html`, or `mockups/**`. CI (`tools/ux_pr_gate.ts`, job "UX review gate (PR)" in
`.github/workflows/ci.yml`) then requires the "UX review" section of
`.github/pull_request_template.md` in the PR body with every box ticked, or one line:

```
UX: N/A (the concrete reason)
```

N/A is for changes with no user-visible effect (comments, a refactor with identical output, a test
helper). A placeholder reason (`reason`, `why`, empty) does not count. Independently of the checklist,
the gate scans every ADDED line of a UI file for an em dash (U+2014) and fails with `file:line`.

Run it locally before pushing:

```
gh pr view --json body --jq .body > pr_body.md
bun run tools/ux_pr_gate.ts --base origin/master --head HEAD --body-file pr_body.md
```

After editing the PR body, re-run the CI job: it fetches the current body from the API.

## The checklist

Tick a box only when it is true. Each item names what a reviewer should be able to verify.

1. **Complexity budget.** A PR that adds a control, settings card, rail button, title-bar chip,
   inspector tab or overlay type must remove, merge, or justify one, and state the new count in the
   "Complexity count" line (for example `left rail: 15 -> 15 (merged Jobs into Fleet)`). Baseline counts
   live in `docs/UX-REVIEW.md` section 2; update them in the same PR. "Justify" means a sentence naming
   the user task that cannot be done without it. New settings go into an existing category, never a
   new top-level card, unless the category list itself is reviewed.
2. **Discoverability.** Every button, chip or link that opens a surface lands on the relevant
   section, expanded and scrolled into view, in FRONT of whatever is open (Fleet dock, Creator Studio,
   Ask Lucid). A button labelled "Workspace" that opens Settings at the top, or behind the Fleet dock,
   is a bug. Name the deep-link target in the PR (`openSettings("workspace")` or equivalent).
3. **Z-order.** A new overlay (flyout, modal, popover, drawer, toast, full-screen dock) declares its
   layer against the stack in `docs/UX-REVIEW.md` "Overlay stack" and uses a token from that stack,
   not a fresh magic number. State which surfaces it covers and which cover it.
4. **Text layout (invariant #11).** Row labels stay on one line and ellipsize, grid tracks are
   `minmax(220px, 1fr)` or wider, chips are `white-space: nowrap`, and no flex row holds raw text plus
   inline tags as siblings. Mockups reuse the real component CSS.
5. **No em dashes.** No U+2014 in any added string, comment, doc or commit message. Use a comma,
   colon, period or hyphen. (Enforced by the gate on UI files.)
6. **Honest states.** Empty, loading and error states say what is true: "No sessions yet" beats a
   grid of zeros; "Not connected" beats a silent blank; a failed action says what failed and what to do.
   Never show fake success, a spinner with no timeout, or metrics that read 0 because nothing loaded.
7. **Keyboard and focus.** Esc closes the topmost overlay only. Opening an overlay moves focus into
   it; closing returns focus to the opener. Every icon-only button has an accessible name
   (`aria-label`) and a tooltip that says what it opens, not just a noun. Tab order follows reading order.
8. **Light and dark themes.** Checked in both. No hard-coded colors outside the theme variables;
   contrast holds for text, focus rings and disabled states.
9. **New-user path.** A first-run user (no provider, no workspace, Community edition) can reach the
   change and understand it without docs. Jargon (ACP, KG, SWR, lanes, spokes) is either avoided or
   explained in the surface itself. Advanced controls hide behind a disclosure, not on the first screen.
10. **Served bytes.** Renderer edits are invisible until the bundle is rebuilt (AGENTS.md END step 4):
    run `cd desktop && bun run build-renderer`, boot the engine, fetch `/app.js` and `/styles.css`, grep a
    marker the change introduced (and one retired marker that must be absent). Attach a screenshot or
    short recording of the running app, both themes when color changed.
11. **Real-UI check.** Unit tests cannot see layering. Drive the changed control with real input
    (puppeteer-core over CDP against an isolated QA engine or a second instance) in every layout it
    lives in: Ask Lucid docked right, docked bottom and floating; the Fleet window docked and free; a
    narrow and a wide window. Assert what the user sees: `document.elementFromPoint` at each control's
    center hits that control, menus stay inside the window, Esc closes only the topmost overlay. Keep the
    check as a re-runnable `desktop/scripts/demo_<id>.mjs` (pattern: `demo_p_askplus_1.mjs`) and run it
    once against the old behavior to prove it fails. ADR-0632: the Ask Lucid "+" menu opened behind its
    own panel while every unit test passed.

## Reviewer notes

- A checked box is a claim. Reviewers spot-check items 1, 2, 10 and 11 on every UI PR.
- If a PR cannot meet an item, say so in the PR body and link the follow-up; do not tick it.
- When the complexity count goes up with no removal, the justification goes in the PR body and the
  new number goes into `docs/UX-REVIEW.md`.
