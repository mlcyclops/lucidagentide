// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/model_manifest.ts - CREATOR-3 (ADR-0287): local models are declarations, not discoveries.
//
// LUCID does not scan disks and does not scrape model hubs. A person (or an install script) writes down what
// a given ComfyUI endpoint can do, and that written-down claim is a MANIFEST. This module does two jobs and
// keeps them visibly apart:
//
//   1. PARSE the declaration. A manifest arrives as untrusted JSON: from a config file, a paste box, or a
//      remote endpoint. Every string in it is inert DATA, capped in length and never interpreted. Every
//      closed set is closed: an unknown model kind is a named refusal, never a coerced default.
//   2. RECONCILE the declaration against what a live probe actually reported. THE PROBE IS THE TRUTH AND THE
//      MANIFEST IS ONLY A CLAIM. A model that is declared but not probed is absent and is never usable. A
//      model the probe listed but the manifest forgot is usable anyway, because the server demonstrably has
//      it and the paperwork is merely stale. A probe that is not ready, or is stale, blesses NOTHING.
//
// The sharpest rule here is the smallest one: a model id that looks like a filesystem path is REFUSED. A
// manifest names models, it does not point at disks. Accepting `/home/me/models/sd.safetensors` is exactly
// how "declaration" quietly becomes "discovery", and how a manifest becomes a path-traversal primitive.
//
// Pure: no node builtins, no fetch, no DOM, no clock, no randomness, no filesystem. It runs identically in
// the renderer bundle, in the desktop seam, and in a unit test.

// ── the declaration ─────────────────────────────────────────────────────────

/** The kinds a manifest may declare. CLOSED: anything else is a refusal that names the offender. */
const DECLARED_KINDS = ["checkpoint", "diffusion", "vae", "lora", "video", "model-3d"] as const;
export type DeclaredKind = (typeof DECLARED_KINDS)[number];

const DECLARED_KIND_SET: ReadonlySet<string> = new Set<string>(DECLARED_KINDS);
const isDeclaredKind = (v: string): v is DeclaredKind => DECLARED_KIND_SET.has(v);

/** What the media pipelines are keyed by. Structurally the media subset of `ArtifactKind` in
 *  `desktop/creator_image.ts`, declared here rather than imported because a harness module never imports
 *  from desktop. The three strings must stay byte-identical to that union's media members. */
export type MediaKind = "image" | "video" | "model-3d";

export interface DeclaredModel {
  /** The name the endpoint knows this model by. Never a path: see `pathShape`. */
  readonly id: string;
  readonly kind: DeclaredKind;
  /** Human text. Untrusted, capped, inert. Defaults to the id when the declaration omits it. */
  readonly label: string;
  /** Claimed VRAM cost, or null when the declaration does not say. Never zero, never negative. */
  readonly vramMB: number | null;
}

export interface ModelManifest {
  readonly endpointId: string;
  readonly declaredAt: number;
  /** Free text from whoever wrote the manifest. Untrusted, capped, inert. */
  readonly note: string;
  readonly models: readonly DeclaredModel[];
  /** Custom node names the endpoint claims to have. Names only, never interpreted. */
  readonly nodes: readonly string[];
}

/** A manifest may declare at most this many models. A picker with more is not a picker, and an unbounded
 *  list is an unbounded parse. */
export const MAX_DECLARED_MODELS = 200;
/** A manifest may declare at most this many custom nodes. Same reasoning. */
export const MAX_DECLARED_NODES = 500;

// Per-string caps. A manifest is untrusted input, so no single field may grow without limit.
const MAX_ENDPOINT_CHARS = 120;
const MAX_ID_CHARS = 160;
const MAX_LABEL_CHARS = 200;
const MAX_NODE_CHARS = 120;
const MAX_NOTE_CHARS = 600;
// Mirrors PROBE_STALE_MS in `desktop/creator_probe.ts`, which a harness module may not import. A probe at or
// past this age is expired there, and expired here too: the two must not drift.
const PROBE_STALE_MS = 900_000;

export type ParsedManifest =
  | { ok: true; manifest: ModelManifest; warnings: readonly string[] }
  | { ok: false; error: string };

// ── parsing ─────────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Name a value's shape for an error message without ever printing the value itself. */
function typeName(v: unknown): string {
  if (v === undefined) return "nothing";
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  const t = typeof v;
  return t === "object" ? "an object" : `a ${t}`;
}

/** Name a value for an error message. Strings are quoted and clipped so a hostile field cannot flood a log
 *  line; everything else is described by type. */
function showValue(v: unknown): string {
  if (typeof v === "string") return `"${v.length > 60 ? `${v.slice(0, 60)}...` : v}"`;
  if (typeof v === "number") return String(v);
  return typeName(v);
}

/** Why this id looks like a path, or null when it names a model. Ordered most specific first so a Windows
 *  absolute path is reported as a drive letter rather than as a stray backslash.
 *
 *  The id is not a path HERE (this module never touches a disk), but it does not stay here: it is sent to a
 *  ComfyUI loader that resolves the name against that host's model directory. So the rules are written for
 *  the OS that resolves it, not for the OS that parsed it:
 *    * A backslash separates paths everywhere a forward slash does on Windows, and `\\share\...` is a UNC
 *      path, which the backslash rule covers.
 *    * A COLON anywhere is an NTFS stream qualifier: `sd.ckpt:evil` names a hidden alternate data stream on
 *      the real file, and it carries no slash, no drive prefix, and no `..`, so nothing else here catches it.
 *    * A control character (a NUL above all) truncates or mangles a name inside the C APIs underneath.
 *  Reserved device names (CON, NUL, COM1) are deliberately NOT refused: they resolve to a device rather than
 *  escaping anywhere, and refusing them would reject a legitimately named file for no attacker gain. */
function pathShape(id: string): string | null {
  if (/^[A-Za-z]:/.test(id)) return "a drive letter";
  if (id.includes("/")) return "a forward slash";
  if (id.includes("\\")) return "a backslash";
  if (id.includes("..")) return "a parent-directory segment";
  if (id.includes(":")) return "a colon, which names an alternate data stream on Windows";
  // eslint-disable-next-line no-control-regex -- refusing control characters is the entire point.
  if (/[\u0000-\u001F\u007F]/.test(id)) return "a control character";
  return null;
}

const clip = (s: string, max: number): string => (s.length <= max ? s : s.slice(0, max));

function clipInto(warnings: string[], what: string, s: string, max: number): string {
  if (s.length <= max) return s;
  warnings.push(`${what} was ${s.length} characters and was truncated to ${max}`);
  return s.slice(0, max);
}

/**
 * Parse an untrusted manifest declaration. Refusals are values: a caller never has to catch.
 *
 * Refusals (each names what was wrong): a non-object root, a missing or empty `endpointId`, a `models` or
 * `nodes` field that is present but not an array, more than `MAX_DECLARED_MODELS` models or
 * `MAX_DECLARED_NODES` nodes, a model entry that is not an object, a model with no id, a path-shaped id, an
 * unknown kind, and a `vramMB` that is present but is not a positive finite number.
 *
 * Warnings (parsing continues): duplicate model ids collapse to the first declaration, unusable node entries
 * are dropped, a missing or malformed `declaredAt` records 0, a non-text `note` is ignored, and any string
 * past its cap is truncated.
 */
export function parseModelManifest(raw: unknown): ParsedManifest {
  if (!isRecord(raw)) return { ok: false, error: `a model manifest must be an object, got ${typeName(raw)}` };
  const warnings: string[] = [];

  const endpointRaw = raw.endpointId;
  if (typeof endpointRaw !== "string" || endpointRaw.trim().length === 0) {
    return { ok: false, error: "a model manifest must name the endpointId it describes, and that field is missing or empty" };
  }
  const endpointId = clipInto(warnings, "endpointId", endpointRaw.trim(), MAX_ENDPOINT_CHARS);

  const modelsRaw = raw.models;
  let modelEntries: readonly unknown[] = [];
  if (modelsRaw === undefined || modelsRaw === null) {
    warnings.push("the manifest declares no models");
  } else if (!Array.isArray(modelsRaw)) {
    return { ok: false, error: `manifest.models must be an array, got ${typeName(modelsRaw)}` };
  } else {
    modelEntries = modelsRaw;
  }
  if (modelEntries.length > MAX_DECLARED_MODELS) {
    return { ok: false, error: `a manifest may declare at most ${MAX_DECLARED_MODELS} models, and this one declares ${modelEntries.length}` };
  }

  const models: DeclaredModel[] = [];
  const firstSeenAt = new Map<string, number>();
  for (let i = 0; i < modelEntries.length; i++) {
    const entry = modelEntries[i];
    if (!isRecord(entry)) return { ok: false, error: `manifest.models[${i}] must be an object, got ${typeName(entry)}` };

    const idRaw = entry.id;
    if (typeof idRaw !== "string" || idRaw.trim().length === 0) {
      return { ok: false, error: `manifest.models[${i}] has no id, and a declared model must be named` };
    }
    // The path check runs on the WHOLE id, before the length cap: clipping first would let a long path lose
    // its slash to the truncation and slip through as an innocent name.
    const wholeId = idRaw.trim();
    const pathy = pathShape(wholeId);
    if (pathy !== null) {
      return {
        ok: false,
        error: `manifest.models[${i}] id "${clip(wholeId, MAX_ID_CHARS)}" looks like a filesystem path (${pathy}), and a manifest names models, it does not point at disks`,
      };
    }
    const id = clipInto(warnings, `manifest.models[${i}].id`, wholeId, MAX_ID_CHARS);

    // Three distinct faults, three distinct refusals. A missing kind, a kind that is not text, and a kind
    // that is text but outside the closed set are different mistakes, and telling a caller "3 is not one of
    // six strings" when they sent a NUMBER reads as "pick another value" instead of "kind must be text".
    const kindRaw = entry.kind;
    if (kindRaw === undefined || kindRaw === null) {
      return {
        ok: false,
        error: `manifest.models[${i}] ("${id}") declares no kind, and it must be one of: ${DECLARED_KINDS.join(", ")}`,
      };
    }
    if (typeof kindRaw !== "string") {
      return {
        ok: false,
        error: `manifest.models[${i}] ("${id}") declares kind as ${typeName(kindRaw)}, which is not text; kind must be one of: ${DECLARED_KINDS.join(", ")}`,
      };
    }
    if (!isDeclaredKind(kindRaw)) {
      return {
        ok: false,
        error: `manifest.models[${i}] ("${id}") declares kind ${showValue(kindRaw)}, which is not one of: ${DECLARED_KINDS.join(", ")}`,
      };
    }

    const vramRaw = entry.vramMB;
    let vramMB: number | null = null;
    if (vramRaw !== undefined && vramRaw !== null) {
      if (typeof vramRaw !== "number" || !Number.isFinite(vramRaw) || vramRaw <= 0) {
        return {
          ok: false,
          error: `manifest.models[${i}] ("${id}") declares vramMB ${showValue(vramRaw)}, and when present it must be a positive finite number`,
        };
      }
      vramMB = vramRaw;
    }

    const labelRaw = entry.label;
    const label = typeof labelRaw === "string" && labelRaw.length > 0
      ? clipInto(warnings, `manifest.models[${i}].label`, labelRaw, MAX_LABEL_CHARS)
      : id;

    const already = firstSeenAt.get(id);
    if (already !== undefined) {
      warnings.push(`model "${id}" is declared more than once, keeping the declaration at index ${already} and dropping index ${i}`);
      continue;
    }
    firstSeenAt.set(id, i);
    models.push({ id, kind: kindRaw, label, vramMB });
  }

  const nodesRaw = raw.nodes;
  let nodeEntries: readonly unknown[] = [];
  if (nodesRaw !== undefined && nodesRaw !== null) {
    if (!Array.isArray(nodesRaw)) {
      return { ok: false, error: `manifest.nodes must be an array of node names, got ${typeName(nodesRaw)}` };
    }
    nodeEntries = nodesRaw;
  }
  if (nodeEntries.length > MAX_DECLARED_NODES) {
    return { ok: false, error: `a manifest may declare at most ${MAX_DECLARED_NODES} nodes, and this one declares ${nodeEntries.length}` };
  }
  const nodes: string[] = [];
  const nodeSeen = new Set<string>();
  let droppedNodes = 0;
  let duplicateNodes = 0;
  for (const candidate of nodeEntries) {
    if (typeof candidate !== "string" || candidate.trim().length === 0) {
      droppedNodes++;
      continue;
    }
    const name = clipInto(warnings, "a node name", candidate.trim(), MAX_NODE_CHARS);
    if (nodeSeen.has(name)) {
      duplicateNodes++;
      continue;
    }
    nodeSeen.add(name);
    nodes.push(name);
  }
  if (droppedNodes > 0) warnings.push(`dropped ${droppedNodes} node entries that were not non-empty text`);
  if (duplicateNodes > 0) warnings.push(`collapsed ${duplicateNodes} duplicate node names`);

  const atRaw = raw.declaredAt;
  let declaredAt = 0;
  if (typeof atRaw === "number" && Number.isFinite(atRaw) && atRaw >= 0) {
    declaredAt = Math.trunc(atRaw);
  } else if (atRaw === undefined || atRaw === null) {
    warnings.push("the manifest carries no declaredAt timestamp, recording 0");
  } else {
    warnings.push(`declaredAt ${showValue(atRaw)} is not a timestamp, recording 0 instead`);
  }

  const noteRaw = raw.note;
  let note = "";
  if (typeof noteRaw === "string") {
    // Kept verbatim apart from the length cap. This text is DATA: it is never parsed, never executed, and
    // never treated as an instruction, so there is nothing to sanitize away at this layer.
    note = clipInto(warnings, "note", noteRaw, MAX_NOTE_CHARS);
  } else if (noteRaw !== undefined && noteRaw !== null) {
    warnings.push(`note ${showValue(noteRaw)} is not text, ignoring it`);
  }

  return { ok: true, manifest: { endpointId, declaredAt, note, models, nodes }, warnings };
}

// ── what the declaration claims ─────────────────────────────────────────────

/** Total over the closed kind set, so adding a kind without deciding its capability will not compile. */
const KIND_CAPABILITY: Readonly<Record<DeclaredKind, MediaKind>> = {
  checkpoint: "image",
  diffusion: "image",
  vae: "image",
  lora: "image",
  video: "video",
  "model-3d": "model-3d",
};

const CAPABILITY_ORDER: readonly MediaKind[] = ["image", "video", "model-3d"];

/**
 * What the DECLARATION claims this endpoint can make, derived only from the declared kinds.
 *
 * This is deliberately not the same thing as what a probe attested: attestation is about NODES (can this
 * server actually save a webm), a declaration is about WEIGHTS. The seam shows the two side by side, so they
 * stay separate here and are never quietly merged.
 */
export function manifestCapabilities(manifest: ModelManifest): readonly MediaKind[] {
  const claimed = new Set<MediaKind>();
  for (const m of manifest.models) claimed.add(KIND_CAPABILITY[m.kind]);
  return CAPABILITY_ORDER.filter((c) => claimed.has(c));
}

// ── reconciliation against the probe ────────────────────────────────────────

/** What a live probe reported. Structural on purpose: the real value is assembled in the desktop seam from
 *  `ProbeResult` plus `parseObjectInfoModels`, and a harness module never imports from desktop. */
export interface ProbedTruth {
  readonly models: readonly { readonly id: string; readonly kind: string; readonly node: string }[];
  /** Capabilities the probe attested from the node list. Carried for the seam to display beside
   *  `manifestCapabilities`, and deliberately NOT used to gate `usable`: nodes and weights are different
   *  claims, and silently intersecting them would hide which one was missing. */
  readonly attested: readonly string[];
  readonly probeState: string;
  readonly ageMs: number;
}

export interface Reconciliation {
  readonly usable: readonly DeclaredModel[];
  readonly declaredButAbsent: readonly string[];
  readonly presentButUndeclared: readonly string[];
  readonly note: string;
  readonly trustworthy: boolean;
}

/** Why the probe cannot bless anything, or null when it can. */
function untrustworthyReason(probed: ProbedTruth): string | null {
  const state = typeof probed.probeState === "string" ? probed.probeState.slice(0, 40) : "";
  if (state !== "ready") return `the probe state is "${state}" and not "ready"`;
  const age = probed.ageMs;
  if (typeof age !== "number" || !Number.isFinite(age) || age < 0) {
    return `the probe age ${showValue(age)} is not a real duration`;
  }
  if (age >= PROBE_STALE_MS) return `the probe is ${age}ms old, at or past the ${PROBE_STALE_MS}ms staleness limit`;
  return null;
}

/**
 * Reconcile a claim against a measurement.
 *
 * THE PROBE IS THE TRUTH AND THE MANIFEST IS ONLY A CLAIM:
 *   * declared and probed  -> usable, carrying the declaration's label and vramMB.
 *   * declared, not probed -> `declaredButAbsent`, and NEVER usable. The paperwork says it exists; the
 *     server says otherwise, and the server is the one that has to load it.
 *   * probed, not declared -> `presentButUndeclared`, and usable. The server has it, so refusing it would
 *     punish the user for stale paperwork. Its kind comes from the probe; a probe kind outside the closed
 *     set leaves the model listed but NOT usable, because a model nobody can type cannot be routed to a
 *     pipeline, and guessing its type is exactly the coercion this module exists to prevent.
 *   * probe not ready, or stale -> `usable` is EMPTY. A stale probe cannot bless anything.
 *
 * Probed ids are deliberately NOT path-checked, unlike declared ones. The probe reports what the server
 * actually has, and a ComfyUI install that organizes weights into subfolders reports `SDXL/base.safetensors`
 * verbatim. Refusing that would break a normal install over a rule that exists to police DECLARATIONS. The
 * consequence is intended and worth knowing: such a model can never be declared, so it always arrives as
 * `presentButUndeclared`, and it is usable because the probe saw it.
 *
 * That exemption has a HARD boundary, and it is the only place the asymmetry can bite. A probed id is a
 * value for the host that reported it, and it MUST NEVER be used to construct a local path: not a cache
 * key, not an artifact filename, not a log path, not a directory we create. It skipped the path rules on
 * the argument that ComfyUI resolves it and can only reach its own disk; the moment one is spliced into a
 * name on OUR disk, that argument is void and the id is an unvalidated path again. If you need to cache
 * probe results per model, key them by a hash or a minted id, never by the model id itself.
 */
export function reconcileManifest(manifest: ModelManifest, probed: ProbedTruth): Reconciliation {
  const probedById = new Map<string, { readonly id: string; readonly kind: string; readonly node: string }>();
  for (const m of probed.models) {
    // Defensive: this shape crosses a seam, so a torn entry is skipped rather than trusted.
    if (!m || typeof m.id !== "string" || m.id.length === 0) continue;
    if (!probedById.has(m.id)) probedById.set(m.id, m);
  }

  const declaredIds = new Set(manifest.models.map((m) => m.id));
  const declaredButAbsent = manifest.models.filter((m) => !probedById.has(m.id)).map((m) => m.id);
  const presentButUndeclared = [...probedById.keys()].filter((id) => !declaredIds.has(id));

  const reason = untrustworthyReason(probed);
  if (reason !== null) {
    return {
      usable: [],
      declaredButAbsent,
      presentButUndeclared,
      note: `Nothing is usable because ${reason}, so all ${manifest.models.length} declared model(s) stay claims and ${presentButUndeclared.length} probed model(s) stay unconfirmed.`,
      trustworthy: false,
    };
  }

  const usable: DeclaredModel[] = manifest.models.filter((m) => probedById.has(m.id));
  let untyped = 0;
  for (const id of presentButUndeclared) {
    const found = probedById.get(id);
    if (found === undefined) continue;
    const kind = typeof found.kind === "string" && isDeclaredKind(found.kind) ? found.kind : null;
    if (kind === null) {
      untyped++;
      continue;
    }
    usable.push({ id, kind, label: id, vramMB: null });
  }

  const untypedClause = untyped > 0
    ? `, ${untyped} of which the probe typed as something this build does not recognize and so cannot use`
    : "";
  return {
    usable,
    declaredButAbsent,
    presentButUndeclared,
    note: `The probe is the truth: ${usable.length} model(s) usable, ${declaredButAbsent.length} declared but absent, ${presentButUndeclared.length} present but undeclared${untypedClause}.`,
    trustworthy: true,
  };
}
