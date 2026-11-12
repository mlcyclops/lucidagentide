# Review gates: when a pass is done

Read this completely before judging any render. The deterministic gates run in `img2threejs_validate`,
`img2threejs_generate` and `img2threejs_state sync`. The visual judgment is yours, and it is recorded, never
asserted.

## The pass order and what each pass must prove

| Pass | Builds | Done when the render shows |
| --- | --- | --- |
| `blockout` | macro parts | the silhouette and the big proportions read as the subject from the fixed view |
| `structural-pass` | plus meso parts | every visible part is present, each child roots at its parent, nothing floats |
| `form-refinement` | plus micro parts | curves, tapers, bevels and small parts match; left and right pairs mirror |
| `material-pass` | same geometry | albedo zones, roughness and metal response match the photo's mid-tones |
| `surface-pass` | same geometry | seams, wear, grooves and emissive elements sit where the image shows them |
| `lighting-pass` | look-dev lights | `neutral`, `grazing` and `reference` modes all read; relief survives relighting |
| `interaction-pass` | pivots, sockets | parts rotate about their joints; sockets sit at the attachment points |
| `optimization-pass` | same | draw calls and triangles within `performanceBudget`; no visual regression |

Every pass but `optimization-pass` is a VISUAL pass: it completes only with a render screenshot, a comparison
image, and an `aiVisionScore` at or above the threshold.

## The review procedure

1. Capture the fixed review view (same camera every pass) and at least two orbit views with `preview_screenshot`.
   Non-planar forms also need a turntable look: a part that is right from the front and wrong from the side fails.
2. Build a side-by-side sheet: reference on the left, render on the right, same framing. Save it as the
   `comparisonImage`.
3. Score the whole (0 to 1): silhouette, proportion, part placement, material response, local features. Write
   the number down before reading the threshold.
4. Score each critical feature named in `featureReviewTargets` for this pass (`featureReviews`). A feature that is
   not visible in the review view is `visible: false` and counts as a failure for a critical feature.
5. List `matched` and `mismatches` in 3D words (the `terminologyProfile`), not impressions.
6. Choose exactly ONE action:
   - `continue`: the pass is done. Only when the score meets the threshold AND every critical feature passes.
   - `refine-spec`: the spec is wrong (a missing part, a wrong size, a wrong material). Fix the spec, regenerate
     with `force: true`.
   - `refine-code`: the spec is right and the generated factory needs a hand edit (a bevel, a profile point).
     Edit the existing file; do not regenerate.
   - `request-input`: the image cannot settle the question. Ask the user for a view or a decision.
   - `stop`: the fidelity asked for cannot be reached from this image. Say why.
7. Append the entry, then `img2threejs_state sync`.

## Hard rules

- Fail the pass when an identity-defining feature is wrong, even if the overall score passes.
- Never record a screenshot you did not capture, never raise the threshold to pass, never edit `reviewHistory`
  entries already recorded.
- The correction loop is limited: 3 refinements per pass and 6 in total by default. Reaching a limit is a hard stop
  the checklist records; report it and the remaining mismatches to the user. Do not re-init the checklist to get
  around it.
- A hole, socket or recess that affects the form is geometry, never a map. A flat patch faking a cavity is a
  spec failure (`refine-spec`), not a shading problem.
- Adjacent separate parts overlap by at least 0.02 units. A visible gap between a child and its parent is an
  attachment failure.
- Left and right pairs are reflections, not rotations.

## Finishing

After `optimization-pass` completes: confirm every visible part is a named node in
`root.userData.sculptRuntime.nodes` (the explodable and clickable contract), confirm the sockets, colliders and
destruction groups against the spec's `actionProfile` blocks, mark `part-coverage` and `action-ready` with the
evidence, and report what still does not match. Don't claim "done" when only "improved".
