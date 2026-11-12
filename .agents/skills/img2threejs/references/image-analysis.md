# Image analysis before any spec

Read this at step 1 and again whenever a review says "refine-spec". The spec can only be as good as this reading.

## 1. Suitability verdict

Decide `pass`, `conditional` or `reject` and write the reasons down. They go into the spec's `suitability`,
`risks` and `scores` (each score an integer 0 to 3).

| Score | 3 | 2 | 1 | 0 |
| --- | --- | --- | --- | --- |
| subjectClarity | one object, isolated, in focus | one object, some clutter | object partly hidden | several subjects or no clear subject |
| resolution | the smallest identity detail is 20 px or more | 10 to 20 px | under 10 px | thumbnail |
| occlusion | every major part visible | one part partly hidden | a major part hidden | the form cannot be read |
| viewpoint | a three-quarter view showing depth | a pure front or side view | an odd angle | a view that hides the silhouette |
| lighting | soft, material readable | hard shadows but readable | blown highlights or crushed blacks | silhouette only |

Reject when two or more scores are 0, or when the subject is a person whose likeness the user has no right to
reproduce. Conditional when the hidden sides must be guessed: say so in `risks` and plan symmetric or
inferred parts with `confidence` below 0.6.

## 2. What to write down

Work from the whole to the detail, in this order, and keep the terminology 3D (the spec's `terminologyProfile`
holds the words you allow yourself):

1. **Silhouette and proportion.** The bounding shape, the dominant curves, the negative spaces, the ratios between
   the big parts (write them as numbers: body height to width, cap height to body height).
2. **Macro parts.** The two to five masses that make the silhouette. Each becomes a `macro` component with a
   primitive, a size and a position in meters.
3. **Meso parts.** Handles, rims, chimneys, legs, arms, guards, grips, knobs. Each is a `meso` component with a
   parent. Anything that hangs off its parent (limb, handle, tube, branch, cable, horn, wing, tail, hinge) gets an
   `attachment` block: where it roots (`localStart`), where it ends (`localEnd`), the contact type, the embed or
   overlap, the gap tolerance.
4. **Micro parts and repetition.** Fasteners, slots, teeth, spokes, stitches. Count them. A regular set is a
   `repetitionSystems` entry (mode `radial`, `linear` or `grid`, with a count); a one-off is a `micro` component.
5. **Materials.** One entry per visibly different surface: hex base color read from a lit mid-tone (never the
   highlight or the shadow), roughness from the highlight shape (tight and bright is low, broad and dull is high),
   metalness 1 only for bare metal, transmission for glass, emissive for lit elements.
6. **Lighting in the photo.** Key direction, softness, fill, rim. It goes into `lightingFromPhoto` and decides
   which look-dev mode (`neutral`, `grazing`, `reference`) you review under.
7. **Hidden sides.** Name each assumption: mirrored, continued, or unknown. Lower the `confidence` on those parts.

## 3. The detail inventory

Divide the image into a 3x3 grid and scan each cell for identity-defining small details. The tier sets the
minimum count (simple 3, moderate 6, complex 10, ultra-complex 16). Each detail needs a `kind` from the closed
set (gloss, bevel, fastener, linework, contour, seam, stitch, stain, scratch, chip, decal, emissive, hole,
groove, ridge) and a `mapsTo.ref` that names a component id, a `component/localFeature` id or a
`material/localOverride` id. A detail that lives only in prose fails the strict gate.

Two consistency rules the validator checks: a `gloss` detail needs a material with roughness under 0.35 or a
clearcoat; a `fastener` detail needs a repetition system or a `micro` component that builds it.

## 4. Characters and likenesses

A character spec sets `objectClass.primaryDomain` to `character` or `hybrid` and fills `anatomy` (style heads,
proportions, pose, face landmarks). This build keeps characters on the pivot track (no bone rig), so plan limbs as
attached capsules and tapered sweeps that pivot at their joints. Left and right pairs are reflections, not
rotations. A real person's likeness needs their consent; a child's face is never reconstructed.
