# The ObjectSculptSpec contract

The spec is one JSON file (default `object-sculpt-spec.json`). `img2threejs_validate` checks it; this page says
what each block is for and what the strict gate demands. Field names match the upstream img2threejs schema, so a
spec authored here reads the same way anywhere else the format is used.

## Required top level

| Field | Type | Notes |
| --- | --- | --- |
| `targetName` | string | Short human name. The factory becomes `create<PascalCase>Model`. |
| `suitability` | `pass`, `conditional`, `reject` | From your image analysis. |
| `coordinateFrame` | object | `{ "up": "+y", "forward": "-z", "units": "meters" }` is the convention. |
| `silhouette` | object | Your words for the outline plus an aspect number. |
| `componentTree` | array | The parts. At least one; one alone is "blockout quality". |
| `materials` | array | At least one. |
| `proceduralStrategy` | array of strings | How you intend to build it. |

## Blocks the strict gate needs filled

- `preSpecAssessment` (from `img2threejs_assess`): `objectClass.primaryType` not `unassessed`, every list
  non-empty, `complexity.tier` and `specDepthDecision.requiredDepth` a real tier, `unknownsToResolveBeforeImplementation`
  empty (resolve them or move them to `risks`), `detailInventory.details` at or above `targetMinDetails`, each mapped.
- `qualityContract`: `qualityBar` a tier, `definitionOfDone`, 3 or more `featureGroups` (required groups need
  `qualityCriteria`), `visualDeltaChecks`, `antiShallowSpecRules` non-empty, and `minimumSpecDepth` that the spec
  actually meets (macro and meso component counts, `localFeatures` total, material count, repetition systems,
  `qualityTargets.reviewViewpoints` count).
- `buildPasses`: the eight ids in order, `blockout` first, with `structural-pass` and a material or surface pass
  present. Each may carry `goal`, `componentRefs` and `acceptance`.
- `sculptPipeline`: `passGateMode: "locked-sequential"`; `img2threejs_state sync` keeps `passOrder`,
  `completedPasses`, `currentPass` and `nextRequiredEvidence` in step with `reviewHistory`.
- `selfCorrectLoop.visualAcceptance`: a `threshold` (0.7 is the convention) and a `featureReviewPolicy`
  (`enabled`, `maxCriticalFeaturesPerPass`, `maxImportantFeaturesPerPass`, `criticalDefaultThreshold`,
  `importantAverageThreshold`).
- Every child whose role, name or primitive says it hangs off its parent (appendage, branch, limb, arm, leg,
  handle, connector, tube, cable, horn, wing, tail, root, fork, rib, support, hinge, socket, pipe, or a
  cylinder, cone, capsule, tube or curve-sweep primitive) needs a complete `attachment`.

Advisory warnings (not strict) still matter: a missing `actionProfile`, `terminologyProfile`, `scores`,
`qualityTargets`, `actionReadiness` or `viewEvidence` weakens the review but does not block.

## A component

```json
{
  "id": "handle", "name": "Bail handle", "primitive": "tube", "level": "meso", "parent": "body",
  "material": "brass", "role": "handle", "importance": 0.8, "confidence": 0.9,
  "dimensions": { "radius": 0.006, "length": 0.4 },
  "transform": { "position": [0, 0.08, 0], "rotation": [0, 0, 0] },
  "attachment": { "parentId": "body", "parentSocket": "bail-left", "localStart": [-0.09, 0.08, 0], "localEnd": [0.09, 0.08, 0], "contactType": "pinned", "embedDepth": 0.03, "gapTolerance": 0.005, "baseRadius": 0.006 },
  "geometryDescriptor": { "tubePath": { "points": [[-0.09, 0.08, 0], [-0.06, 0.26, 0], [0.06, 0.26, 0], [0.09, 0.08, 0]], "radius": 0.006 } },
  "localFeatures": ["bail-eye-left", "bail-eye-right"],
  "actionProfile": {
    "animationRole": "hinge",
    "pivot": { "mode": "socket", "localPosition": [-0.09, 0.08, 0], "axis": [1, 0, 0], "confidence": 0.7 },
    "transformChannels": { "position": false, "rotation": true, "scale": false },
    "sockets": [{ "id": "hook", "localPosition": [0, 0.26, 0] }],
    "collider": { "type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false },
    "destruction": { "breakable": false, "fractureGroup": "hardware" }
  },
  "evidenceRefs": ["full-object"]
}
```

- `level`: `macro` (blockout), `meso` (structural-pass and later), `micro` (form-refinement and later). The
  generator emits a pass's allowed levels plus any component a pass names in `componentRefs`, plus parents.
- `dimensions` or `transform.scale` size a unit primitive: `width`/`height`/`depth`, or `radius` and
  `height`/`length`. The size is baked into the vertices; the pivot stays at scale 1, so a child under a
  non-uniform parent is never distorted.
- `transform.position` and `rotation` (radians) place the pivot in the parent's frame. With an attachment the
  pivot sits at `localStart` instead and the mesh spans to `localEnd`.
- `geometryDescriptor` per primitive: `profile2D {points, depth}` for `extrude`; `latheProfile {points
  [[radius, y]...], segments}` for `lathe`; `tubePath {points, radius, closed}` for `tube`; `curveSweep {path,
  radius}`; `taperedSweep {path, baseRadius, endRadius}`; `bladeSpec {profile, thickness}` for `ground-blade`;
  `torusTubeRatio` for `torus`; `basePrimitive` for `instanced-cluster`.
- `topologyClass` (optional): `continuous-sculpt`, `assembled-solid`, `conforming-shell`, `surface-relief`,
  `fiber-strand`, `material-only`, `open-shell`. With it comes `topologyRationale` citing visible evidence. A
  continuous sculpt may not be a box, cylinder or cone; a fiber strand may not be a box or plane card.
  `implicit` requires an SDF, which this build refuses.

## A material

```json
{ "id": "brass", "baseColor": "#b08d57", "roughness": { "base": 0.35, "variation": 0.08 }, "metalness": 1.0,
  "clearcoat": 0, "emissive": "#000000", "doubleSided": false,
  "localOverrides": [{ "id": "wick-glow", "emissive": "#ffb347" }] }
```

Colors are `#RGB` or `#RRGGBB`. Scalars are a number or `{ "base", "variation", "min", "max" }`. Metalness is
rounded to 0 or 1 at emission. Glass is low roughness plus `transmission` and `ior`.

## A repetition system

```json
{ "id": "vent-slots", "level": "meso", "parent": "cap", "count": 8, "primitive": "box", "material": "painted-steel",
  "instanceScale": [0.012, 0.004, 0.02],
  "placement": { "mode": "radial", "axis": [0, 1, 0], "radius": 0.05, "startAngleDeg": 0 } }
```

Modes: `radial` (`axis`, `radius`, `startAngleDeg`), `linear` (`start`, `step`, `axis`), `grid` (`origin`,
`spacing`, `columns`, `axis`). `instanceScale` is absolute, in the parent pivot's units.

## A review entry

```json
{ "passId": "blockout", "action": "continue", "aiVisionScore": 0.82, "visualAcceptanceThreshold": 0.7,
  "visualEvidence": { "renderScreenshot": "shots/blockout-front.png", "comparisonImage": "shots/blockout-compare.png", "capturedBy": "preview_screenshot" },
  "featureReviews": [{ "id": "silhouette", "score": 0.8, "visible": true }],
  "matched": ["tall body", "cap proportion"], "mismatches": [], "specFixes": [], "codeFixes": [] }
```

Actions: `continue`, `refine-spec`, `refine-code`, `request-input`, `stop`. Exactly one entry per review. The
screenshot and comparison paths must be files you captured. `featureReviewTargets` at the top level names the
critical and important features per pass (`{ id, tier, passIds, minimumScore }`).
