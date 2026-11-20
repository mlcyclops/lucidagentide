## Summary

<!-- What changed and why. Increment ID and ADR number if any. -->

## Tests

<!-- The scoped tests you ran and the demo target, if any. -->

## UX review

<!--
Required when this PR touches desktop/renderer/** (not *.test.ts), desktop/*.html or mockups/**.
CI (tools/ux_pr_gate.ts) fails a UI PR until EVERY box below is checked. Full rules: docs/UX-PR-CHECKLIST.md.
Not a user-visible change (comments, refactor with identical output)? Delete the boxes and write one line,
outside this comment, of the form:  UX: N/A (the concrete reason)
Added lines in UI files must never contain an em dash (U+2014); the gate fails with file:line either way.
-->

- [ ] **Complexity budget**: a new control, card, rail button or overlay removes, merges or justifies one; new count stated below
- [ ] **Discoverability**: every button that opens a surface lands on the relevant section, in front of the current view
- [ ] **Z-order**: any new overlay declares its layer in the documented stack (docs/UX-REVIEW.md, "Overlay stack")
- [ ] **Text layout**: invariant #11 holds (one-line ellipsized labels, minmax(220px,1fr) or wider, no raw prose in a flex row)
- [ ] **No em dashes**: no U+2014 in any added string, comment or doc
- [ ] **Honest states**: empty, loading and error states say what is true (no wall of zeros, no fake success)
- [ ] **Keyboard and focus**: Esc closes, focus moves in and returns, every icon-only button has an accessible name
- [ ] **Light and dark themes**: checked in both
- [ ] **New-user path**: a first-run user can find and understand the change without reading docs
- [ ] **Served bytes**: ran `cd desktop && bun run build-renderer`, grepped a new marker in the served `/app.js` or `/styles.css`; screenshot or recording attached
- [ ] **Real-UI check**: drove the changed control with real input in every layout it lives in (docked, floating, narrow, wide); `elementFromPoint` proves it is on top; the check is kept as `desktop/scripts/demo_<id>.mjs`

Complexity count after this PR (surface: before -> after):
