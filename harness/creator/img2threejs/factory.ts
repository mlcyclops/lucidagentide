// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/img2threejs/factory.ts - the pass-gated three.js factory generator (CREATOR-IMG2THREEJS,
// ADR-0562). TypeScript port of the core of forge/stage3_build/generate_threejs_factory.py from
// github.com/img2threejs/img2threejs (Apache-2.0).
//
// Input: a validated ObjectSculptSpec and the pass to build. Output: TypeScript SOURCE for a factory
// `create<Name>Model(options): THREE.Group` that rebuilds the subject from primitives, with a pivot Group per
// component, meshes whose dimensions are baked into the vertex data (so a non-uniform parent never distorts
// a child), attachment endpoints for limbs and handles, sockets, colliders, destruction groups, repetition
// systems as one InstancedMesh each, and `root.userData.sculptRuntime` naming all of it.
//
// FAIL-CLOSED, three ways, exactly as upstream:
//   1. strict quality: any validation error or `quality:` warning returns BLOCKED and NO source.
//   2. pass lock: a pass that is not completed or currently unlocked returns BLOCKED and NO source.
//   3. geometry: a component whose geometry this port cannot build (SDF, visual hull, subdivision cage,
//      decimation, vertex paint, bone-track rig, stand-proud march) returns BLOCKED naming the component,
//      instead of substituting a box. A wrong shape that validates is the failure this whole gate exists for.
//
// Every spec string that lands in the source goes through JSON.stringify, so a spec cannot inject code:
// names, ids and whole component records are emitted as JSON literals.
//
// Not ported (see ADR-0562): procedural and reference texture sets (materials are flat PBR from the spec's
// numbers), the look-dev environment / composer / inspect-controls exports, stand-proud, SDF polygonization,
// visual hull carving, Catmull-Clark subdivision, quadric decimation, vertex paint, the character rig.

import {
  ATTACHMENT_PRIMITIVES, PASS_LEVELS, VALID_PRIMITIVES, arrayAt, isNumber, isNumberList, isRecord, pascalCase,
  recordAt, str, type JsonRecord,
} from "./contract.ts";
import { filterComponentsForPass, passLockReason } from "./passes.ts";
import { validateSpec } from "./validate.ts";

export interface BlockedReport {
  readonly status: "BLOCKED";
  readonly gate: "strict-quality" | "pass-lock" | "geometry";
  readonly cause: readonly string[];
  readonly warnings: readonly string[];
  readonly requestedPass: string;
  readonly nextAction: string;
}

export type GenerateResult =
  | { readonly ok: true; readonly source: string; readonly passId: string; readonly functionName: string; readonly components: readonly string[]; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly report: BlockedReport };

/** Tessellation, one table per model so every primitive agrees on density. */
const SEG = { box: 2, sphereW: 48, sphereH: 32, cylRadial: 48, cylHeight: 4, coneHeight: 4, capsuleCap: 12, capsuleRadial: 32, torusRadial: 24, torusTubular: 64, planeW: 4, planeH: 4, tube: 64, lathe: 48 } as const;

const DEFAULT_EXTRUDE = { points: [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], depth: 0.1 };
const DEFAULT_LATHE = { points: [[0.3, -0.5], [0.15, 0.0], [0.3, 0.5]], segments: SEG.lathe };
const DEFAULT_TUBE = { points: [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], radius: 0.05, closed: false };
const DEFAULT_SWEEP = { path: [[0.0, -0.5, 0.0], [0.0, 0.0, 0.1], [0.0, 0.5, 0.0]], radius: 0.06 };
const DEFAULT_TAPERED = { path: [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], baseRadius: 0.12, endRadius: 0.04 };
const DEFAULT_BLADE = { profile: [[0.0, -0.5], [0.08, -0.45], [0.1, 0.2], [0.0, 0.5], [-0.02, 0.2], [-0.02, -0.45]], thickness: 0.04 };

const lit = (v: unknown): string => JSON.stringify(v ?? null);
const num = (v: unknown, fallback: number): string => String(isNumber(v) ? v : fallback);
const vec = (v: unknown, fallback: readonly [number, number, number]): string => (isNumberList(v, 3) ? v : fallback).map((n) => String(n)).join(", ");
const ident = (prefix: string, value: string, index: number): string => `${prefix}_${value.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "x"}_${index}`;

function scaleVector(component: JsonRecord, transform: JsonRecord): string {
  if ("scale" in transform) return vec(transform.scale, [1, 1, 1]);
  const d = component.dimensions;
  if (isRecord(d)) {
    const r = isNumber(d.radius) ? d.radius * 2 : 1;
    const width = d.width ?? r;
    const height = d.height ?? d.length ?? 1;
    const depth = d.depth ?? r;
    if (isNumber(width) && isNumber(height) && isNumber(depth)) return vec([width, height, depth], [1, 1, 1]);
  }
  return "1, 1, 1";
}

/** What this port cannot build for a component, or "" when it can. */
export function unsupportedGeometryReason(component: JsonRecord): string {
  const id = str(component.id, "(unnamed)");
  const d = recordAt(component, "geometryDescriptor");
  if ("sdf" in d || component.topologyClass === "implicit") return `component ${JSON.stringify(id)}: implicit SDF geometry is not ported; model the part with a primitive, a lathe or a sweep`;
  if ("visualHull" in d) return `component ${JSON.stringify(id)}: visual hull carving is not ported`;
  if ("subdivide" in d) return `component ${JSON.stringify(id)}: subdivision cages are not ported; raise the tessellation by choosing a smoother primitive instead`;
  if ("decimate" in d) return `component ${JSON.stringify(id)}: decimation is not ported`;
  if (component.vertexPaint !== undefined) return `component ${JSON.stringify(id)}: vertexPaint is not ported; split the part into components with their own materials`;
  if (component.rootTipGradient !== undefined) return `component ${JSON.stringify(id)}: rootTipGradient is not ported`;
  if (component.standProud !== undefined) return `component ${JSON.stringify(id)}: standProud is not ported; offset the part in its transform instead`;
  return "";
}

/** The geometry expression for a unit-sized primitive. Records the helpers it needs in `helpers`. */
function geometryFor(primitive: string, component: JsonRecord, helpers: Set<string>): string {
  const d = recordAt(component, "geometryDescriptor");
  switch (primitive) {
    case "box": return `new THREE.BoxGeometry(1, 1, 1, ${SEG.box}, ${SEG.box}, ${SEG.box})`;
    case "sphere":
    case "ellipsoid": return `new THREE.SphereGeometry(0.5, ${SEG.sphereW}, ${SEG.sphereH})`;
    case "cylinder": return `new THREE.CylinderGeometry(0.5, 0.5, 1, ${SEG.cylRadial}, ${SEG.cylHeight})`;
    case "cone": return `new THREE.ConeGeometry(0.5, 1, ${SEG.cylRadial}, ${SEG.coneHeight})`;
    case "capsule": return `new THREE.CapsuleGeometry(0.35, 0.3, ${SEG.capsuleCap}, ${SEG.capsuleRadial})`;
    case "torus": {
      const ratio = d.torusTubeRatio;
      const tube = isNumber(ratio) && ratio > 0 ? Math.round(0.45 * ratio * 10000) / 10000 : 0.08;
      return `new THREE.TorusGeometry(0.45, ${tube}, ${SEG.torusRadial}, ${SEG.torusTubular})`;
    }
    case "plane-card": return `new THREE.PlaneGeometry(1, 1, ${SEG.planeW}, ${SEG.planeH})`;
    case "extrude": helpers.add("extrude"); return `buildExtrudeGeometry(${lit(isRecord(d.profile2D) ? d.profile2D : DEFAULT_EXTRUDE)})`;
    case "lathe": helpers.add("lathe"); return `buildLatheGeometry(${lit(isRecord(d.latheProfile) ? d.latheProfile : DEFAULT_LATHE)})`;
    case "tube": helpers.add("tube"); return `buildTubeGeometry(${lit(isRecord(d.tubePath) ? d.tubePath : DEFAULT_TUBE)})`;
    case "curve-sweep": helpers.add("sweep"); return `buildCurveSweepGeometry(${lit(isRecord(d.curveSweep) ? d.curveSweep : DEFAULT_SWEEP)})`;
    case "tapered-sweep": helpers.add("tapered"); return `buildTaperedSweepGeometry(${lit(isRecord(d.taperedSweep) ? d.taperedSweep : DEFAULT_TAPERED)})`;
    case "ground-blade": helpers.add("blade"); return `buildGroundBladeGeometry(${lit(isRecord(d.bladeSpec) ? d.bladeSpec : DEFAULT_BLADE)})`;
    case "instanced-cluster": {
      const base = typeof d.basePrimitive === "string" && (VALID_PRIMITIVES as readonly string[]).includes(d.basePrimitive) && d.basePrimitive !== "instanced-cluster" ? d.basePrimitive : "box";
      return geometryFor(base, { ...component, geometryDescriptor: { ...d, basePrimitive: undefined } }, helpers);
    }
    default: throw new Error(`geometry not implemented for primitive ${JSON.stringify(primitive)}`);
  }
}

/** Geometry sized from a measured attachment endpoint (limbs, handles, tubes): exact length and radii. */
function endpointGeometry(primitive: string, endpointVar: string): string {
  switch (primitive) {
    case "cone": return `new THREE.ConeGeometry(${endpointVar}.baseRadius, ${endpointVar}.length, ${SEG.cylRadial}, ${SEG.coneHeight})`;
    case "capsule": return `new THREE.CapsuleGeometry(${endpointVar}.baseRadius, Math.max(0.001, ${endpointVar}.length - 2 * ${endpointVar}.baseRadius), ${SEG.capsuleCap}, ${SEG.capsuleRadial})`;
    default: return `new THREE.CylinderGeometry(${endpointVar}.endRadius, ${endpointVar}.baseRadius, ${endpointVar}.length, ${SEG.cylRadial}, ${SEG.cylHeight})`;
  }
}

const HELPER_SOURCES: Readonly<Record<string, string>> = {
  extrude: [
    "function buildExtrudeGeometry(profile: { points: number[][]; depth?: number }): THREE.BufferGeometry {",
    "  const shape = new THREE.Shape();",
    "  profile.points.forEach(([x, y], i) => (i === 0 ? shape.moveTo(x ?? 0, y ?? 0) : shape.lineTo(x ?? 0, y ?? 0)));",
    "  shape.closePath();",
    "  const depth = profile.depth ?? 0.1;",
    "  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 24 });",
    "  geometry.translate(0, 0, -depth / 2);",
    "  return geometry;",
    "}",
  ].join("\n"),
  lathe: [
    "function buildLatheGeometry(profile: { points: number[][]; segments?: number }): THREE.BufferGeometry {",
    "  const points = profile.points.map(([r, y]) => new THREE.Vector2(Math.max(0, r ?? 0), y ?? 0));",
    `  return new THREE.LatheGeometry(points, Math.max(3, Math.round(profile.segments ?? ${SEG.lathe})));`,
    "}",
  ].join("\n"),
  tube: [
    "function buildTubeGeometry(path: { points: number[][]; radius?: number; closed?: boolean }): THREE.BufferGeometry {",
    "  const curve = new THREE.CatmullRomCurve3(path.points.map(([x, y, z]) => new THREE.Vector3(x ?? 0, y ?? 0, z ?? 0)), path.closed === true);",
    `  return new THREE.TubeGeometry(curve, ${SEG.tube}, Math.max(0.001, path.radius ?? 0.05), 16, path.closed === true);`,
    "}",
  ].join("\n"),
  sweep: [
    "function buildCurveSweepGeometry(sweep: { path: number[][]; radius?: number }): THREE.BufferGeometry {",
    "  const curve = new THREE.CatmullRomCurve3(sweep.path.map(([x, y, z]) => new THREE.Vector3(x ?? 0, y ?? 0, z ?? 0)));",
    `  return new THREE.TubeGeometry(curve, ${SEG.tube}, Math.max(0.001, sweep.radius ?? 0.06), 16, false);`,
    "}",
  ].join("\n"),
  tapered: [
    "function buildTaperedSweepGeometry(sweep: { path: number[][]; baseRadius?: number; endRadius?: number }): THREE.BufferGeometry {",
    "  // A ring stack along the path whose radius runs from baseRadius to endRadius, capped at both ends.",
    "  const curve = new THREE.CatmullRomCurve3(sweep.path.map(([x, y, z]) => new THREE.Vector3(x ?? 0, y ?? 0, z ?? 0)));",
    `  const rings = ${SEG.tube}; const sides = 24;`,
    "  const base = Math.max(0.001, sweep.baseRadius ?? 0.12); const tip = Math.max(0.0005, sweep.endRadius ?? 0.04);",
    "  const frames = curve.computeFrenetFrames(rings, false);",
    "  const positions: number[] = []; const indices: number[] = [];",
    "  for (let i = 0; i <= rings; i++) {",
    "    const t = i / rings; const p = curve.getPointAt(t); const r = base + (tip - base) * t;",
    "    const n = frames.normals[i]!; const b = frames.binormals[i]!;",
    "    for (let j = 0; j < sides; j++) {",
    "      const a = (j / sides) * Math.PI * 2; const cx = Math.cos(a) * r; const cy = Math.sin(a) * r;",
    "      positions.push(p.x + n.x * cx + b.x * cy, p.y + n.y * cx + b.y * cy, p.z + n.z * cx + b.z * cy);",
    "    }",
    "  }",
    "  for (let i = 0; i < rings; i++) for (let j = 0; j < sides; j++) {",
    "    const a = i * sides + j; const bI = i * sides + ((j + 1) % sides); const c = (i + 1) * sides + ((j + 1) % sides); const d = (i + 1) * sides + j;",
    "    indices.push(a, bI, d, bI, c, d);",
    "  }",
    "  const startCenter = positions.length / 3; const s0 = curve.getPointAt(0); positions.push(s0.x, s0.y, s0.z);",
    "  const endCenter = positions.length / 3; const s1 = curve.getPointAt(1); positions.push(s1.x, s1.y, s1.z);",
    "  for (let j = 0; j < sides; j++) { indices.push(startCenter, (j + 1) % sides, j); indices.push(endCenter, rings * sides + j, rings * sides + ((j + 1) % sides)); }",
    "  const geometry = new THREE.BufferGeometry();",
    "  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));",
    "  geometry.setIndex(indices);",
    "  geometry.computeVertexNormals();",
    "  return geometry;",
    "}",
  ].join("\n"),
  blade: [
    "function buildGroundBladeGeometry(blade: { profile: number[][]; thickness?: number }): THREE.BufferGeometry {",
    "  // A blade is its silhouette extruded thin, with a bevel so the edge reads as ground rather than stamped.",
    "  const shape = new THREE.Shape();",
    "  blade.profile.forEach(([x, y], i) => (i === 0 ? shape.moveTo(x ?? 0, y ?? 0) : shape.lineTo(x ?? 0, y ?? 0)));",
    "  shape.closePath();",
    "  const thickness = Math.max(0.002, blade.thickness ?? 0.04);",
    "  const bevel = thickness * 0.45;",
    "  const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.6, bevelSegments: 3, curveSegments: 32 });",
    "  geometry.translate(0, 0, -(thickness - 2 * bevel) / 2);",
    "  return geometry;",
    "}",
  ].join("\n"),
};

const PRELUDE = `export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, unknown>;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      const item = record[key];
      if (typeof item === 'number' && Number.isFinite(item)) return item;
    }
  }
  return fallback;
}

// Albedo stays inside the physically plausible band (about 30..240 of 255): no pure black, no pure white.
function clampedAlbedoColor(spec: SculptMaterialSpec): THREE.Color {
  const raw = typeof spec.baseColor === 'string' ? spec.baseColor : typeof spec.color === 'string' ? spec.color : '#8a7a5f';
  const color = new THREE.Color(raw);
  color.r = Math.min(240 / 255, Math.max(30 / 255, color.r));
  color.g = Math.min(240 / 255, Math.max(30 / 255, color.g));
  color.b = Math.min(240 / 255, Math.max(30 / 255, color.b));
  return color;
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions): THREE.MeshPhysicalMaterial {
  const metalness = clamp01(readLayerNumber(spec.metalness, ['base'], 0));
  const material = new THREE.MeshPhysicalMaterial({
    color: clampedAlbedoColor(spec),
    roughness: clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    // Metalness is binary in a physically based workflow: a part is a metal or it is not.
    metalness: metalness >= 0.5 ? 1 : 0,
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: Math.min(2.5, Math.max(1, readLayerNumber(spec.ior, ['base', 'value'], 1.5))),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
    flatShading: spec.flatShading === true,
  });
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.name = id;
  material.userData.sculptMaterial = spec;
  material.userData.pbrConstraints = { albedoRange: [30, 240], binaryMetalness: true, iorRange: [1, 2.5] };
  material.userData.pbrTextureSource = 'flat-from-spec';
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// The pivot sits at localStart (the joint); the mesh spans start..end and is rotated onto that axis, so
// rotating the pivot swings the limb about its root instead of about its middle.
function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return { start, midpoint: delta.multiplyScalar(0.5), quaternion, length, baseRadius, endRadius };
}
`;

/** Generate the factory source for one pass, or a BLOCKED report. Never throws on a bad spec. */
export function generateFactory(input: unknown, passId: string): GenerateResult {
  const validation = validateSpec(input);
  const blocked = (gate: BlockedReport["gate"], cause: string[], nextAction: string): GenerateResult => ({
    ok: false,
    report: { status: "BLOCKED", gate, cause, warnings: validation.warnings, requestedPass: passId, nextAction },
  });
  if (validation.strictFailures.length) return blocked("strict-quality", [...validation.strictFailures], "refine-spec: author a subject-specific ObjectSculptSpec that passes img2threejs_validate with strict: true, then generate again");
  const spec = input as JsonRecord;
  const lock = passLockReason(spec, passId);
  if (lock) return blocked("pass-lock", [lock], "review the current pass (render screenshot, comparison image, aiVisionScore) and append a reviewHistory entry with action=continue before asking for a deeper pass");

  const allComponents = arrayAt(spec, "componentTree").filter(isRecord);
  const components = filterComponentsForPass(spec, allComponents, passId);
  const unsupported = components.map(unsupportedGeometryReason).filter(Boolean);
  if (isRecord(spec.rig) && Array.isArray(spec.rig.bones) && spec.rig.bones.length) unsupported.push("spec.rig: the bone-track character rig is not ported; the model stays on the pivot track");
  if (unsupported.length) return blocked("geometry", unsupported, "refine-spec: describe these parts with the primitives this build emits (box, sphere, ellipsoid, cylinder, cone, capsule, torus, tube, lathe, extrude, ground-blade, curve-sweep, tapered-sweep, plane-card, instanced-cluster)");

  const target = str(spec.targetName, "Procedural Object") || "Procedural Object";
  const typeName = pascalCase(target);
  const functionName = `create${typeName}Model`;
  const materials = new Map<string, JsonRecord>();
  arrayAt(spec, "materials").forEach((m, i) => { if (isRecord(m)) materials.set(str(m.id, `material${i}`) || `material${i}`, m); });
  const firstMaterial = materials.keys().next().value ?? "base";
  const helpers = new Set<string>();
  const body: string[] = [];
  const emittedIds: string[] = [];

  components.forEach((component, index) => {
    const id = str(component.id, `component-${index}`) || `component-${index}`;
    emittedIds.push(id);
    const meshVar = ident("mesh", id, index);
    const nodeVar = ident("node", id, index);
    const endpointVar = ident("endpoint", id, index);
    const primitive = str(component.primitive, "box");
    const transform = recordAt(component, "transform");
    const actionProfile = recordAt(component, "actionProfile");
    const sockets = arrayAt(actionProfile, "sockets").filter(isRecord);
    const fractureGroup = recordAt(actionProfile, "destruction").fractureGroup;
    const attachment = isRecord(component.attachment) ? component.attachment : null;
    const materialId = str(component.material) || firstMaterial;
    const parent = str(component.parent) || "root";
    const name = str(component.name) || id;
    const usesEndpoint = attachment !== null && ATTACHMENT_PRIMITIVES.includes(primitive);

    body.push(
      "",
      `  // component: ${lit(id)} (${primitive}, level ${lit(str(component.level, "macro"))})`,
      `  const ${endpointVar} = makeAttachmentEndpoint(${usesEndpoint ? lit(attachment) : "null"});`,
      `  const ${nodeVar} = new THREE.Group();`,
      `  ${nodeVar}.name = ${lit(`${name}__pivot`)};`,
      `  ${nodeVar}.scale.set(1, 1, 1);`,
      `  if (${endpointVar}) {`,
      `    ${nodeVar}.position.copy(${endpointVar}.start);`,
      `  } else {`,
      `    ${nodeVar}.position.set(${vec(transform.position, [0, 0, 0])});`,
      `  }`,
      `  ${nodeVar}.rotation.set(${vec(transform.rotation, [0, 0, 0])});`,
      `  ${nodeVar}.userData.sculptComponent = ${lit(component)};`,
      `  ${nodeVar}.userData.actionProfile = ${lit(actionProfile)};`,
      `  (nodes[${lit(parent)}] ?? root).add(${nodeVar});`,
      `  nodes[${lit(id)}] = ${nodeVar};`,
      `  const ${meshVar}Geometry = ${endpointVar}`,
      `    ? ${endpointGeometry(primitive, endpointVar)}`,
      `    : ${geometryFor(primitive, component, helpers)};`,
      `  if (!${endpointVar}) {`,
      `    ${meshVar}Geometry.scale(${scaleVector(component, transform)});`,
      `  }`,
      `  const ${meshVar} = new THREE.Mesh(${meshVar}Geometry, materialMap[${lit(materialId)}] ?? fallbackMaterial);`,
      `  ${meshVar}.name = ${lit(name)};`,
      `  if (${endpointVar}) {`,
      `    ${meshVar}.position.copy(${endpointVar}.midpoint);`,
      `    ${meshVar}.quaternion.copy(${endpointVar}.quaternion);`,
      `  }`,
      `  ${meshVar}.castShadow = options.castShadow ?? true;`,
      `  ${meshVar}.receiveShadow = options.receiveShadow ?? true;`,
      `  ${meshVar}.userData.sculptComponent = ${lit(component)};`,
      `  ${nodeVar}.add(${meshVar});`,
      `  meshes[${lit(id)}] = ${meshVar};`,
      `  colliders[${lit(id)}] = ${lit(actionProfile.collider ?? {})};`,
    );
    if (typeof fractureGroup === "string" && fractureGroup) {
      body.push(`  destructionGroups[${lit(fractureGroup)}] ??= [];`, `  destructionGroups[${lit(fractureGroup)}].push(${nodeVar});`);
    }
    sockets.forEach((socket, socketIndex) => {
      const socketId = str(socket.id) || `socket-${socketIndex}`;
      const socketVar = ident("socket", `${id}_${socketId}`, socketIndex);
      body.push(
        `  const ${socketVar} = new THREE.Object3D();`,
        `  ${socketVar}.name = ${lit(socketId)};`,
        `  ${socketVar}.position.set(${vec(socket.localPosition ?? socket.position, [0, 0, 0])});`,
        `  ${socketVar}.rotation.set(${vec(socket.localRotation ?? socket.rotation, [0, 0, 0])});`,
        `  ${socketVar}.userData.socket = ${lit(socket)};`,
        `  ${nodeVar}.add(${socketVar});`,
        `  sockets[${lit(`${id}:${socketId}`)}] = ${socketVar};`,
      );
    });
  });

  // Repetition systems: count + placement + instanceScale as ONE InstancedMesh each, pass-gated by level.
  const allowedLevels = PASS_LEVELS[passId] ?? ["macro"];
  const knownIds = new Set(emittedIds);
  const repetitions: string[] = [];
  arrayAt(spec, "repetitionSystems").filter(isRecord).forEach((system, repIndex) => {
    if (system.realization === "map-only" || system.buildsGeometry === false) return;
    const level = str(system.level, "meso") || "meso";
    if (!allowedLevels.includes(level)) return;
    const count = isNumber(system.count) ? Math.trunc(system.count) : 0;
    if (count <= 0) return;
    const parentId = str(system.parent, "root") || "root";
    const parent = parentId !== "root" && knownIds.has(parentId) ? parentId : "root";
    const primitive = typeof system.primitive === "string" && (VALID_PRIMITIVES as readonly string[]).includes(system.primitive) && system.primitive !== "instanced-cluster" ? system.primitive : "box";
    const materialId = str(system.material) || firstMaterial;
    const placement = recordAt(system, "placement");
    const mode = str(placement.mode, "radial") || "radial";
    const repId = str(system.id) || `rep_${repIndex}`;
    repetitions.push(
      "",
      `  // repetition system: ${lit(repId)} (InstancedMesh, ${mode}, count=${count}, level=${level})`,
      "  {",
      `    const parent = nodes[${lit(parent)}] ?? root;`,
      `    const geo = ${geometryFor(primitive, { geometryDescriptor: isRecord(system.geometryDescriptor) ? system.geometryDescriptor : {} }, helpers)};`,
      `    const mat = materialMap[${lit(materialId)}] ?? fallbackMaterial;`,
      `    const scl = new THREE.Vector3(${vec(system.instanceScale, [0.1, 0.1, 0.1])});`,
      `    const axis = new THREE.Vector3(${vec(placement.axis, [0, 0, 1])}).normalize();`,
      `    const cluster = new THREE.InstancedMesh(geo, mat, ${count});`,
      "    const m = new THREE.Matrix4();",
      "    const p = new THREE.Vector3();",
      "    const q = new THREE.Quaternion();",
    );
    if (mode === "linear") {
      repetitions.push(
        `    const start = new THREE.Vector3(${vec(placement.start, [0, 0, 0])});`,
        `    const step = new THREE.Vector3(${vec(placement.step, [0.1, 0, 0])});`,
        `    for (let i = 0; i < ${count}; i++) {`,
        "      p.copy(start).addScaledVector(step, i);",
        "      q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);",
        "      m.compose(p, q, scl);",
        "      cluster.setMatrixAt(i, m);",
        "    }",
      );
    } else if (mode === "grid") {
      const columns = isNumber(placement.columns) && placement.columns >= 1 ? Math.trunc(placement.columns) : Math.max(1, Math.ceil(Math.sqrt(count)));
      repetitions.push(
        `    const origin = new THREE.Vector3(${vec(placement.origin, [0, 0, 0])});`,
        `    const spacing = ${num(placement.spacing, 0.1)};`,
        `    for (let i = 0; i < ${count}; i++) {`,
        `      const col = i % ${columns}; const row = Math.floor(i / ${columns});`,
        "      p.copy(origin).add(new THREE.Vector3(col * spacing, 0, row * spacing));",
        "      q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);",
        "      m.compose(p, q, scl);",
        "      cluster.setMatrixAt(i, m);",
        "    }",
      );
    } else {
      repetitions.push(
        `    const radius = ${num(placement.radius, 0)};`,
        `    const startDeg = ${num(placement.startAngleDeg, 0)};`,
        "    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);",
        "    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();",
        `    for (let i = 0; i < ${count}; i++) {`,
        `      const ang = ((startDeg + (i * 360) / ${count}) * Math.PI) / 180;`,
        "      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));",
        "      p.copy(radius > 0 ? dir.clone().multiplyScalar(radius) : new THREE.Vector3());",
        "      q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);",
        "      m.compose(p, q, scl);",
        "      cluster.setMatrixAt(i, m);",
        "    }",
      );
    }
    repetitions.push(
      "    cluster.instanceMatrix.needsUpdate = true;",
      "    cluster.castShadow = options.castShadow ?? true;",
      "    cluster.receiveShadow = options.receiveShadow ?? true;",
      `    cluster.name = ${lit(repId)};`,
      `    cluster.userData.repetitionSystem = ${lit(system)};`,
      "    parent.add(cluster);",
      `    nodes[${lit(`repetition:${repId}`)}] = cluster;`,
      "  }",
    );
  });

  const materialLines: string[] = [];
  for (const [materialId, material] of materials) materialLines.push(`  materialMap[${lit(materialId)}] = createSculptMaterial(${lit(materialId)}, ${lit(material)}, options);`);

  const header = [
    "import * as THREE from 'three';",
    "",
    `// Generated by LUCID Creator (img2threejs, TypeScript port) from ObjectSculptSpec target: ${target.replace(/[\r\n]+/g, " ")}`,
    `// Sculpt build pass: ${passId}`,
    "// This factory is pass-gated. Finish the render review of this pass before asking for a deeper one.",
    "",
    PRELUDE,
    ...[...helpers].sort().map((h) => `${HELPER_SOURCES[h]}\n`),
    `export function ${functionName}(options: ProceduralModelOptions = {}): THREE.Group {`,
    "  const root = new THREE.Group();",
    `  root.name = ${lit(target)};`,
    `  root.userData.reconstructionEvidence = ${lit({ sourceImage: spec.sourceImage ?? null, suitability: spec.suitability ?? null, approximationNotes: spec.approximationNotes ?? [] })};`,
    "",
    "  const materialMap: Record<string, THREE.Material> = {};",
    "  const fallbackMaterial = new THREE.MeshStandardMaterial({ color: 0x888888 });",
    ...materialLines,
    "",
    "  const nodes: Record<string, THREE.Object3D> = { root };",
    "  const meshes: Record<string, THREE.Mesh> = {};",
    "  const sockets: Record<string, THREE.Object3D> = {};",
    "  const colliders: Record<string, unknown> = {};",
    "  const destructionGroups: Record<string, THREE.Object3D[]> = {};",
  ];

  const footer = [
    "",
    "  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;",
    `  root.userData.lookDevTargets = ${lit(spec.lookDevTargets ?? {})};`,
    "  root.userData.actionReadiness = {",
    "    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',",
    `    pass: ${lit(passId)},`,
    "  };",
    "  return root;",
    "}",
    "",
    `export function create${typeName}LookDevLights(mode: 'neutral' | 'grazing' | 'reference' = 'neutral'): THREE.Group {`,
    "  const lights = new THREE.Group();",
    `  lights.name = ${lit(`${target} look-dev lights`)};`,
    "  const hemi = new THREE.HemisphereLight(mode === 'reference' ? 0xfff0d6 : 0xf2f4ff, 0x363b42, mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85);",
    "  lights.add(hemi);",
    "  const key = new THREE.DirectionalLight(mode === 'reference' ? 0xffcf8a : 0xfff4e8, mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15);",
    "  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);",
    "  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);",
    "  else key.position.set(-4.0, 6.0, 5.5);",
    "  key.castShadow = true;",
    "  key.shadow.mapSize.set(2048, 2048);",
    "  key.shadow.bias = -0.00025;",
    "  key.shadow.normalBias = 0.018;",
    "  key.shadow.camera.near = 0.5;",
    "  key.shadow.camera.far = 30;",
    "  lights.add(key);",
    "  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);",
    "  fill.position.set(4.0, 3.0, 3.5);",
    "  lights.add(fill);",
    "  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);",
    "  rim.position.set(0.5, 4.5, -6.0);",
    "  lights.add(rim);",
    "  lights.userData.reviewMode = mode;",
    "  return lights;",
    "}",
    "",
  ];

  return { ok: true, source: [...header, ...body, ...repetitions, ...footer].join("\n"), passId, functionName, components: emittedIds, warnings: validation.warnings };
}
