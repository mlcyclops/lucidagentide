// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/creator_cad.ts - the Studio CAD pane (pure builders + fail-closed shape gates).
//
// The pane talks to a dgx-cad service on a DGX enclave box through the engine:
//   * Inspect: a local .dxf / .dwg / .ifc / .step file is read in the renderer and sent as raw bytes to
//     POST /api/creator/cad/inspect. The result is shown as tables; the returned SVG never reaches the DOM
//     unsanitized (app.ts runs it through svg_sanitize.ts, DOMPurify's SVG profile, no scripts and no
//     foreignObject), and it is never interpolated into this module's HTML.
//   * Model: a CadQuery / build123d script runs in a sandboxed subprocess on the box, only after the
//     engine's exec-approval gate says yes.
// A payload whose shape this build cannot read is refused (`isCadInspect`), never half-painted.

import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import type { VideoEndpointView } from "./creator_video.ts";

type Vec2 = [number, number];
type Vec3 = [number, number, number];

export interface CadDxfInspect {
  kind: "dxf"; version: string; units: string;
  layers: { name: string; color: number; entityCount: number }[];
  entityCounts: Record<string, number>;
  extents: { min: Vec2; max: Vec2 } | null;
  svg: string;
  convertedFrom?: "dwg";
  dxfArtifactId?: string;
}
export interface CadIfcInspect {
  kind: "ifc"; schema: string; projectName: string; counts: Record<string, number>;
  storeys: { name: string; elevation: number }[];
}
export interface CadStepInspect { kind: "step"; solids: number; bbox: { min: Vec3; max: Vec3 }; svg: string }
export type CadInspectView = CadDxfInspect | CadIfcInspect | CadStepInspect;

export interface CadArtifactView { id: string; name: string; kind: string; bytes: number }
export interface CadModelResultView { ok: boolean; artifacts: CadArtifactView[]; svg?: string; log: string; error?: string }

export type CadOutput = "step" | "stl" | "svg" | "dxf";
export const CAD_OUTPUTS: readonly CadOutput[] = ["step", "stl", "svg", "dxf"];
export const CAD_ACCEPT = ".dxf,.dwg,.ifc,.step,.stp";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isCounts = (v: unknown): v is Record<string, number> => isObj(v) && Object.values(v).every((n) => typeof n === "number");
const isVec = (v: unknown, n: number): boolean => Array.isArray(v) && v.length === n && v.every((x) => typeof x === "number");

/** Fail-closed gate for an inspect result: each kind must carry every field the pane paints. */
export function isCadInspect(v: unknown): v is CadInspectView {
  if (!isObj(v)) return false;
  if (v.kind === "dxf") {
    const ext = v.extents;
    return typeof v.version === "string" && typeof v.units === "string" && typeof v.svg === "string" && isCounts(v.entityCounts)
      && Array.isArray(v.layers) && v.layers.every((l) => isObj(l) && typeof l.name === "string" && typeof l.entityCount === "number")
      && (ext === null || (isObj(ext) && isVec(ext.min, 2) && isVec(ext.max, 2)));
  }
  if (v.kind === "ifc") {
    return typeof v.schema === "string" && typeof v.projectName === "string" && isCounts(v.counts)
      && Array.isArray(v.storeys) && v.storeys.every((s) => isObj(s) && typeof s.name === "string" && typeof s.elevation === "number");
  }
  if (v.kind === "step") {
    return typeof v.solids === "number" && typeof v.svg === "string" && isObj(v.bbox) && isVec(v.bbox.min, 3) && isVec(v.bbox.max, 3);
  }
  return false;
}

export function isCadModelResult(v: unknown): v is CadModelResultView {
  return isObj(v) && typeof v.ok === "boolean" && typeof v.log === "string" && Array.isArray(v.artifacts)
    && v.artifacts.every((a) => isObj(a) && typeof a.id === "string" && typeof a.name === "string" && typeof a.bytes === "number");
}

/** Count tables, largest first, ties by name, so the eye lands on what dominates the drawing. */
export function sortedCounts(counts: Record<string, number>): [string, number][] {
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export interface CreatorCadView {
  endpoints: VideoEndpointView[];
  endpointId: string;
  fileName: string;
  busy: string;
  status: string;
  statusTone: "" | "ok" | "error";
  inspect: CadInspectView | null;
  script: string;
  outputs: CadOutput[];
  modelBusy: string;
  modelStatus: string;
  modelTone: "" | "ok" | "error";
  model: CadModelResultView | null;
}

export const SAMPLE_CADQUERY = `import cadquery as cq

# The script must assign \`result\`.
result = cq.Workplane("XY").box(40, 30, 10).faces(">Z").workplane().hole(8)
`;

/** Why the pane cannot send to the selected endpoint, or "". */
export function cadEndpointBlock(v: CreatorCadView): string {
  if (!v.endpoints.length) return "No dgx-cad endpoint is declared. Import one from the DGX Loader or connect one under Integrations.";
  const ep = v.endpoints.find((e) => e.id === v.endpointId);
  if (!ep) return "Pick a dgx-cad endpoint.";
  if (ep.cui && !ep.cui.allowed) return `Refused under CUI lockdown: ${ep.cui.reason}`;
  return "";
}

/** Why Run is disabled, or "". */
export function cadRunBlock(v: CreatorCadView): string {
  const block = cadEndpointBlock(v) || v.modelBusy;
  if (block) return block;
  if (!v.script.trim()) return "Write a script that assigns result.";
  return v.outputs.length ? "" : "Pick at least one output.";
}

const fmtN = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(3));

function countTable(title: string, counts: Record<string, number>): string {
  const rows = sortedCounts(counts);
  if (!rows.length) return `<p class="cim-hint">${esc(`${title}: none.`)}</p>`;
  return `<table class="ccad-table"><thead><tr><th>${esc(title)}</th><th class="ccad-num">Count</th></tr></thead><tbody>${
    rows.map(([k, n]) => `<tr><td class="ccad-cell">${esc(k)}</td><td class="ccad-num">${esc(String(n))}</td></tr>`).join("")
  }</tbody></table>`;
}

function inspectHtml(r: CadInspectView): string {
  if (r.kind === "dxf") {
    const ext = r.extents ? `${fmtN(r.extents.min[0])}, ${fmtN(r.extents.min[1])} to ${fmtN(r.extents.max[0])}, ${fmtN(r.extents.max[1])}` : "empty drawing";
    const layers = r.layers.length
      ? `<table class="ccad-table"><thead><tr><th>Layer</th><th class="ccad-num">Color</th><th class="ccad-num">Entities</th></tr></thead><tbody>${
        [...r.layers].sort((a, b) => b.entityCount - a.entityCount || a.name.localeCompare(b.name)).map((l) =>
          `<tr><td class="ccad-cell">${esc(l.name)}</td><td class="ccad-num">${esc(String(l.color))}</td><td class="ccad-num">${esc(String(l.entityCount))}</td></tr>`).join("")
      }</tbody></table>`
      : `<p class="cim-hint">No layers.</p>`;
    return `<div class="ccad-meta">
        <span class="cim-kind">DXF ${esc(r.version)}</span><span class="cim-kind">${esc(`units: ${r.units}`)}</span>
        ${r.convertedFrom ? `<span class="cim-kind">converted from DWG</span>` : ""}
        ${r.dxfArtifactId ? `<button type="button" class="btn-mini" data-ccad-artifact="${esc(r.dxfArtifactId)}" data-ccad-name="converted.dxf">${icon("download", 12)} DXF</button>` : ""}
      </div>
      <p class="cim-hint">${esc(`Extents: ${ext}`)}</p>
      ${layers}${countTable("Entity type", r.entityCounts)}
      ${r.svg ? `<img class="ccad-svg" data-ccad-svg="inspect" alt="Drawing preview (sanitized SVG)" />` : ""}`;
  }
  if (r.kind === "ifc") {
    const storeys = r.storeys.length
      ? `<table class="ccad-table"><thead><tr><th>Storey</th><th class="ccad-num">Elevation</th></tr></thead><tbody>${
        [...r.storeys].sort((a, b) => a.elevation - b.elevation).map((s) =>
          `<tr><td class="ccad-cell">${esc(s.name)}</td><td class="ccad-num">${esc(fmtN(s.elevation))}</td></tr>`).join("")
      }</tbody></table>`
      : `<p class="cim-hint">No building storeys.</p>`;
    return `<div class="ccad-meta"><span class="cim-kind">${esc(r.schema)}</span><span class="ccad-proj" title="${esc(r.projectName)}">${esc(r.projectName || "unnamed project")}</span></div>
      ${storeys}${countTable("IFC type", r.counts)}`;
  }
  const b = r.bbox;
  return `<div class="ccad-meta"><span class="cim-kind">STEP</span><span class="cim-kind">${esc(`${r.solids} solid${r.solids === 1 ? "" : "s"}`)}</span></div>
    <p class="cim-hint">${esc(`Bounding box: ${b.min.map(fmtN).join(", ")} to ${b.max.map(fmtN).join(", ")}`)}</p>
    ${r.svg ? `<img class="ccad-svg" data-ccad-svg="inspect" alt="Drawing preview (sanitized SVG)" />` : ""}`;
}

function modelHtml(m: CadModelResultView): string {
  const arts = m.artifacts.length
    ? `<div class="ccad-arts">${m.artifacts.map((a) =>
      `<button type="button" class="btn-mini" data-ccad-artifact="${esc(a.id)}" data-ccad-name="${esc(a.name)}">${icon("download", 12)} ${esc(a.name)}</button>`).join("")}</div>`
    : "";
  return `<div class="cpl-run${m.ok ? " ok" : " bad"}">
    <div class="cpl-run-row"><span class="cpl-run-verdict">${esc(m.ok ? "Model built" : "Model failed")}</span>
      <span class="cpl-run-kind">${esc(`${m.artifacts.length} artifact${m.artifacts.length === 1 ? "" : "s"}`)}</span></div>
    ${m.error ? `<p class="cpl-run-error">${icon("alertBadge", 13)}${esc(m.error)}</p>` : ""}
    ${arts}
    ${m.svg ? `<img class="ccad-svg" data-ccad-svg="model" alt="Model preview (sanitized SVG)" />` : ""}
    ${m.log ? `<pre class="ccad-log">${esc(m.log)}</pre>` : ""}
  </div>`;
}

export function creatorCadHtml(v: CreatorCadView | null): string {
  if (!v) return `<p class="cst-empty">Loading the CAD pane...</p>`;
  const block = cadEndpointBlock(v);
  const endpointRow = v.endpoints.length
    ? `<div class="cim-row"><span class="cim-lbl">Endpoint</span><select class="prov-key cvd-grow" id="ccadEndpoint">${
      v.endpoints.map((e) => `<option value="${esc(e.id)}"${e.id === v.endpointId ? " selected" : ""}>${esc(`${e.label} (${e.id})`)}</option>`).join("")
    }</select><button type="button" class="btn-mini" data-cvd-import>Import</button></div>`
    : `<div class="cim-row"><button type="button" class="btn-mini ok" data-cvd-import>Import from the DGX Loader</button></div>`;
  const outputs = CAD_OUTPUTS.map((o) =>
    `<label class="ccad-out"><input type="checkbox" data-ccad-output="${o}"${v.outputs.includes(o) ? " checked" : ""} /><span>${o.toUpperCase()}</span></label>`).join("");
  const runBlock = cadRunBlock(v);
  return `<div class="cpl-pane ccad-pane">
    <section class="cim-gen">
      <div class="cim-tools-h"><span class="cim-tools-t">${icon("scan", 14)}<span>Inspect a drawing (DGX enclave)</span></span></div>
      <p class="cim-hint">DXF, DWG (converted out of process by LibreDWG's dwg2dxf), IFC and STEP. The file goes only to the selected dgx-cad endpoint; its SVG preview is sanitized before display.</p>
      ${endpointRow}
      ${block ? `<p class="${block.startsWith("Refused") ? "cpl-run-error" : "cpl-gate"}">${icon("shield", 13)}${esc(block)}</p>` : ""}
      <div class="cpl-form-row">
        <button type="button" class="cpl-go" data-ccad-open${block || v.busy ? " disabled" : ""}>${icon("folder", 12)} Open file</button>
        <span class="ccad-file" title="${esc(v.fileName)}">${esc(v.fileName || "No file inspected")}</span>
      </div>
      <input type="file" hidden accept="${CAD_ACCEPT}" data-ccad-file />
      ${v.busy || v.status ? `<p class="cpl-status${v.busy ? "" : v.statusTone ? ` ${v.statusTone}` : ""}">${esc(v.busy || v.status)}</p>` : ""}
      ${v.inspect ? inspectHtml(v.inspect) : ""}
    </section>
    <section class="cim-gen">
      <div class="cim-tools-h"><span class="cim-tools-t">${icon("spark", 14)}<span>CadQuery model</span></span></div>
      <p class="cim-hint">Runs on the DGX box in an isolated Python subprocess (fresh temp dir, stripped environment, CPU and memory limits, 120 s cap). LUCID asks for your approval before every run.</p>
      <textarea class="cpl-prompt-in ccad-script" id="ccadScript" rows="8" spellcheck="false">${esc(v.script)}</textarea>
      <div class="cim-row cim-row-wrap"><span class="cim-lbl">Outputs</span>${outputs}</div>
      <div class="cpl-form-row">
        <span class="cpl-status${runBlock ? "" : " ok"}" data-gate="cad-run">${esc(runBlock || "Ready to run (approval required).")}</span>
        <button type="button" class="cpl-go" id="ccadRun"${runBlock ? " disabled" : ""}>${icon("bolt", 12)} Run</button>
      </div>
      ${v.modelStatus ? `<p class="cpl-status${v.modelTone ? ` ${v.modelTone}` : ""}">${esc(v.modelStatus)}</p>` : ""}
      ${v.model ? modelHtml(v.model) : ""}
    </section>
  </div>`;
}
