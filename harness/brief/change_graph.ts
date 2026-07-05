// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/brief/change_graph.ts
//
// P-REPORT.8: a change-annotated APPLICATION DEPENDENCY GRAPH + DATA-SCHEMA CHANGE map for the
// engineering report. From `git diff --numstat` + `--name-status` over a range, it groups changed
// files into the architecture's layers (renderer / desktop / harness / scanner / tools / extensions),
// colours each by whether it net-GREW (green) or net-SHRANK (red) with the +added/-removed line counts,
// and draws the dependency edges between them. It emits BOTH a hand-built SVG (rendered image, styled by
// the renderer) AND Mermaid `flowchart` code (copyable, and importable into draw.io) - plus a schema
// change map keyed to the data stores each touched file backs.
//
// PURE: the caller runs git and passes the raw output; this module only parses + renders. No I/O, no Date.

export interface ModuleChange {
  id: string; label: string;
  added: number; removed: number; files: number;
  status: "added" | "removed" | "changed"; // net direction (added files, deleted files, or edited)
}
export interface GraphEdge { from: string; to: string }
export interface ChangeGraph { modules: ModuleChange[]; edges: GraphEdge[]; range: string; totalAdded: number; totalRemoved: number; totalFiles: number }

// Architecture layers (order matters - a renderer path must match before the broader desktop path).
const LAYERS: { id: string; label: string; match: RegExp }[] = [
  { id: "renderer", label: "Renderer (UI)", match: /^desktop\/renderer\// },
  { id: "desktop", label: "Desktop / Electron", match: /^desktop\// },
  { id: "harness", label: "Harness", match: /^harness\// },
  { id: "scanner", label: "Scanner sidecar", match: /^scanner-sidecar\// },
  { id: "tools", label: "Tools / data", match: /^tools\// },
  { id: "extensions", label: "IDE extensions", match: /^extensions\// },
];
const OTHER = { id: "core", label: "Core / root" };
// Dependency direction (who imports whom) - the edges we draw when both endpoints have changes.
const LAYER_EDGES: [string, string][] = [
  ["renderer", "desktop"], ["desktop", "harness"], ["desktop", "tools"], ["desktop", "core"],
  ["harness", "scanner"], ["harness", "core"], ["extensions", "desktop"], ["tools", "core"],
];

interface FileChange { added: number; removed: number; status: string }

/** Parse `git diff --numstat` (+ optional `--name-status` for A/M/D/R) into per-file changes. */
export function parseGitChanges(numstat: string, nameStatus = ""): Map<string, FileChange> {
  const files = new Map<string, FileChange>();
  for (const line of (numstat || "").split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === "-" && m[2] === "-") continue; // binary file (no line info) - not a line-change node
    const path = m[3]!.includes("=>") ? m[3]!.replace(/.*=>\s*/, "").replace(/[{}]/g, "") : m[3]!; // rename → new path
    files.set(path, { added: m[1] === "-" ? 0 : Number(m[1]), removed: m[2] === "-" ? 0 : Number(m[2]), status: "M" });
  }
  for (const line of (nameStatus || "").split("\n")) {
    const m = /^([AMDR])\d*\t(.+)$/.exec(line.trim());
    if (!m) continue;
    const path = m[2]!.split("\t").pop()!; // rename lists old\tnew → take new
    const e = files.get(path);
    if (e) e.status = m[1]!;
    else if (m[1] === "D") files.set(path, { added: 0, removed: 0, status: "D" });
  }
  return files;
}

const layerOf = (path: string): { id: string; label: string } => LAYERS.find((l) => l.match.test(path)) ?? OTHER;

/** Build the change-annotated dependency graph from git output over `range`. */
export function buildChangeGraph(numstat: string, nameStatus: string, range: string): ChangeGraph {
  const files = parseGitChanges(numstat, nameStatus);
  const agg = new Map<string, { label: string; added: number; removed: number; files: number; anyAdd: boolean; anyDel: boolean }>();
  for (const [path, f] of files) {
    const { id, label } = layerOf(path);
    const a = agg.get(id) ?? { label, added: 0, removed: 0, files: 0, anyAdd: false, anyDel: false };
    a.added += f.added; a.removed += f.removed; a.files += 1;
    if (f.status === "A") a.anyAdd = true;
    if (f.status === "D") a.anyDel = true;
    agg.set(id, a);
  }
  const modules: ModuleChange[] = [...agg.entries()].map(([id, a]): ModuleChange => ({
    id, label: a.label, added: a.added, removed: a.removed, files: a.files,
    status: a.anyAdd && a.added >= a.removed ? "added" : a.anyDel && a.removed > a.added ? "removed" : "changed",
  })).sort((x, y) => (y.added + y.removed) - (x.added + x.removed));
  const present = new Set(modules.map((m) => m.id));
  const edges = LAYER_EDGES.filter(([f, t]) => present.has(f) && present.has(t)).map(([from, to]) => ({ from, to }));
  const totalAdded = modules.reduce((s, m) => s + m.added, 0);
  const totalRemoved = modules.reduce((s, m) => s + m.removed, 0);
  const totalFiles = modules.reduce((s, m) => s + m.files, 0);
  return { modules, edges, range, totalAdded, totalRemoved, totalFiles };
}

// ── Mermaid (copyable + draw.io importable) ──────────────────────────────────────
const mmLabel = (m: ModuleChange) => `${m.label} +${m.added}/-${m.removed} (${m.files}f)`.replace(/"/g, "'");

/** A Mermaid `flowchart` of the change graph, green/red by net direction. Paste into draw.io (Arrange →
 *  Insert → Advanced → Mermaid) or any Mermaid renderer. Leading `%% lucid:changegraph` marks it so the
 *  in-app viewer swaps in the styled SVG while keeping this exact code copyable. */
export function changeGraphMermaid(g: ChangeGraph): string {
  const out: string[] = ["%% lucid:changegraph", "flowchart TD"];
  out.push("  classDef added fill:#0e2a17,stroke:#46d27e,color:#cfeeda,stroke-width:2px;");
  out.push("  classDef removed fill:#2a1315,stroke:#e05a5a,color:#f3c9c9,stroke-width:2px;");
  out.push("  classDef changed fill:#12203a,stroke:#5e8df2,color:#cfe0ff,stroke-width:2px;");
  for (const m of g.modules) out.push(`  ${m.id}["${mmLabel(m)}"]:::${m.status}`);
  for (const e of g.edges) out.push(`  ${e.from} --> ${e.to}`);
  return out.join("\n");
}

// ── styled SVG (the "image") ─────────────────────────────────────────────────────
// Layered layout: depth from the dependency edges (sources at top), nodes spread per row. Colours match
// the Mermaid classDefs. Self-contained (uses CSS vars with hex fallbacks so it also renders on white/print).
const ADDED = "#46d27e", REMOVED = "#e05a5a", CHANGED = "#5e8df2";
const nodeColor = (s: ModuleChange["status"]) => (s === "added" ? ADDED : s === "removed" ? REMOVED : CHANGED);

function depths(g: ChangeGraph): Map<string, number> {
  const d = new Map<string, number>(g.modules.map((m) => [m.id, 0]));
  // relax edges a few times (small graph): a node sits one below the deepest thing that points TO it.
  for (let i = 0; i < g.modules.length; i++) {
    for (const e of g.edges) d.set(e.to, Math.max(d.get(e.to) ?? 0, (d.get(e.from) ?? 0) + 1));
  }
  return d;
}

export function changeGraphSvg(g: ChangeGraph): string {
  if (!g.modules.length) return "";
  const d = depths(g);
  const rows = new Map<number, string[]>();
  for (const m of g.modules) { const k = d.get(m.id) ?? 0; (rows.get(k) ?? rows.set(k, []).get(k)!).push(m.id); }
  const NW = 210, NH = 62, GX = 40, GY = 54, PAD = 26;
  const maxRow = Math.max(...[...rows.values()].map((r) => r.length));
  const W = PAD * 2 + maxRow * NW + (maxRow - 1) * GX;
  const nLevels = Math.max(...[...rows.keys()]) + 1;
  const H = PAD * 2 + nLevels * NH + (nLevels - 1) * GY;
  const pos = new Map<string, { x: number; y: number }>();
  for (const [lvl, ids] of rows) {
    const rowW = ids.length * NW + (ids.length - 1) * GX;
    const startX = (W - rowW) / 2;
    ids.forEach((id, i) => pos.set(id, { x: startX + i * (NW + GX), y: PAD + lvl * (NH + GY) }));
  }
  const byId = new Map(g.modules.map((m) => [m.id, m]));
  const parts: string[] = [];
  parts.push(`<svg class="cg-svg" viewBox="0 0 ${W} ${H}" width="100%" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif">`);
  parts.push(`<defs><marker id="cg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#6b7480"/></marker></defs>`);
  // edges first (behind nodes)
  for (const e of g.edges) {
    const a = pos.get(e.from), b = pos.get(e.to); if (!a || !b) continue;
    const x1 = a.x + NW / 2, y1 = a.y + NH, x2 = b.x + NW / 2, y2 = b.y;
    const my = (y1 + y2) / 2;
    parts.push(`<path d="M${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}" fill="none" stroke="#5b636f" stroke-width="1.6" marker-end="url(#cg-arrow)" opacity=".8"/>`);
  }
  for (const m of g.modules) {
    const p = pos.get(m.id)!; const c = nodeColor(m.status);
    const total = Math.max(1, m.added + m.removed);
    const gw = (NW - 24) * (m.added / total); // green portion of the add/remove bar
    parts.push(`<g>`);
    parts.push(`<rect x="${p.x}" y="${p.y}" width="${NW}" height="${NH}" rx="11" fill="#12151c" stroke="${c}" stroke-width="1.8"/>`);
    parts.push(`<rect x="${p.x}" y="${p.y}" width="5" height="${NH}" rx="2.5" fill="${c}"/>`);
    parts.push(`<text x="${p.x + 14}" y="${p.y + 21}" fill="#e7ecf4" font-size="13" font-weight="600">${esc(m.label)}</text>`);
    parts.push(`<text x="${p.x + 14}" y="${p.y + 38}" font-size="11.5" font-weight="700"><tspan fill="${ADDED}">+${m.added}</tspan><tspan fill="#8b929c"> / </tspan><tspan fill="${REMOVED}">-${m.removed}</tspan><tspan fill="#8b929c" font-weight="400">  ·  ${m.files} file${m.files === 1 ? "" : "s"}</tspan></text>`);
    // add/remove magnitude bar
    parts.push(`<rect x="${p.x + 12}" y="${p.y + NH - 9}" width="${NW - 24}" height="4" rx="2" fill="${REMOVED}" opacity=".55"/>`);
    parts.push(`<rect x="${p.x + 12}" y="${p.y + NH - 9}" width="${gw.toFixed(1)}" height="4" rx="2" fill="${ADDED}"/>`);
    parts.push(`</g>`);
  }
  parts.push(`</svg>`);
  return parts.join("");
}
function esc(s: string): string { return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// ── data-schema change map ───────────────────────────────────────────────────────
// Known data stores + the file patterns that back their schema. A changed file matching a pattern is a
// candidate SCHEMA touch (frozen-schema contract, CLAUDE.md invariant 10) - flagged for review.
export interface StoreChange { store: string; files: { path: string; added: number; removed: number; status: string }[]; added: number; removed: number }
const STORES: { store: string; match: RegExp }[] = [
  { store: "DuckDB (obs / agent / usage)", match: /(migration|schema|_data\.ts|duckdb|contracts\.ts)/i },
  { store: "Personalization KG (encrypted)", match: /personal(\/store)?\.ts|kg_/i },
  { store: "Settings store", match: /settings_store\.ts/i },
  { store: "Credential vault / whitelist", match: /cred_vault\.ts|network_whitelist\.ts|auth_vault\.ts/i },
  { store: "Chat sessions", match: /sessions\.ts|session_/i },
  { store: "Report store", match: /report_store\.ts|goal_memory\.ts|loop_report\.ts/i },
];

/** Detect data-store schema touches among the changed files. Only stores WITH a changed file appear. */
export function buildSchemaChanges(numstat: string, nameStatus = ""): StoreChange[] {
  const files = parseGitChanges(numstat, nameStatus);
  const out = new Map<string, StoreChange>();
  for (const [path, f] of files) {
    for (const s of STORES) {
      if (!s.match.test(path)) continue;
      const sc = out.get(s.store) ?? { store: s.store, files: [], added: 0, removed: 0 };
      sc.files.push({ path, added: f.added, removed: f.removed, status: f.status });
      sc.added += f.added; sc.removed += f.removed;
      out.set(s.store, sc);
    }
  }
  return [...out.values()].sort((a, b) => (b.added + b.removed) - (a.added + a.removed));
}

/** Mermaid graph: each changed schema file → the data store it backs, green/red by net direction. */
export function schemaMermaid(changes: StoreChange[]): string {
  if (!changes.length) return "";
  const out: string[] = ["%% lucid:schema", "flowchart LR"];
  out.push("  classDef store fill:#1a1030,stroke:#9350d6,color:#e6d6ff,stroke-width:2px;");
  out.push("  classDef grew fill:#0e2a17,stroke:#46d27e,color:#cfeeda;");
  out.push("  classDef shrank fill:#2a1315,stroke:#e05a5a,color:#f3c9c9;");
  let n = 0;
  for (const c of changes) {
    const sid = `s${n++}`;
    out.push(`  ${sid}[("${c.store.replace(/"/g, "'")}")]:::store`);
    for (const f of c.files) {
      const fid = `f${n++}`; const cls = f.added >= f.removed ? "grew" : "shrank";
      out.push(`  ${fid}["${f.path.split("/").pop()} +${f.added}/-${f.removed}"]:::${cls}`);
      out.push(`  ${fid} --> ${sid}`);
    }
  }
  return out.join("\n");
}

/** Styled SVG for the schema map: store pills on the right, changed files on the left, colored links. */
export function schemaSvg(changes: StoreChange[]): string {
  if (!changes.length) return "";
  const files = changes.flatMap((c) => c.files.map((f) => ({ ...f, store: c.store })));
  const FW = 240, SW = 220, NH = 34, GY = 12, PAD = 22, COLGAP = 120;
  const storeIdx = new Map(changes.map((c, i) => [c.store, i]));
  const H = PAD * 2 + Math.max(files.length, changes.length) * (NH + GY);
  const W = PAD * 2 + FW + COLGAP + SW;
  const p: string[] = [`<svg class="cg-svg" viewBox="0 0 ${W} ${H}" width="100%" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif">`];
  p.push(`<defs><marker id="sc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#8a5bd0"/></marker></defs>`);
  const fileY = (i: number) => PAD + i * (NH + GY);
  const storeY = (i: number) => PAD + i * (NH + GY) + (files.length - changes.length) * (NH + GY) / 2;
  const sx = PAD + FW + COLGAP;
  // links
  files.forEach((f, i) => {
    const si = storeIdx.get(f.store)!; const y1 = fileY(i) + NH / 2, y2 = storeY(si) + NH / 2;
    const c = f.added >= f.removed ? ADDED : REMOVED;
    p.push(`<path d="M${PAD + FW} ${y1} C ${PAD + FW + COLGAP / 2} ${y1}, ${sx - COLGAP / 2} ${y2}, ${sx} ${y2}" fill="none" stroke="${c}" stroke-width="1.6" opacity=".7" marker-end="url(#sc-arrow)"/>`);
  });
  // file nodes
  files.forEach((f, i) => {
    const y = fileY(i); const c = f.added >= f.removed ? ADDED : REMOVED;
    p.push(`<rect x="${PAD}" y="${y}" width="${FW}" height="${NH}" rx="8" fill="#12151c" stroke="${c}" stroke-width="1.5"/>`);
    p.push(`<text x="${PAD + 11}" y="${y + 15}" fill="#e7ecf4" font-size="11.5" font-weight="600">${esc(f.path.split("/").pop() ?? f.path)}</text>`);
    p.push(`<text x="${PAD + 11}" y="${y + 28}" font-size="10.5" font-weight="700"><tspan fill="${ADDED}">+${f.added}</tspan><tspan fill="#8b929c"> / </tspan><tspan fill="${REMOVED}">-${f.removed}</tspan></text>`);
  });
  // store pills
  changes.forEach((c, i) => {
    const y = storeY(i);
    p.push(`<rect x="${sx}" y="${y}" width="${SW}" height="${NH}" rx="17" fill="#1a1030" stroke="#9350d6" stroke-width="1.8"/>`);
    p.push(`<text x="${sx + SW / 2}" y="${y + NH / 2 + 4}" text-anchor="middle" fill="#e6d6ff" font-size="11.5" font-weight="600">${esc(c.store)}</text>`);
  });
  p.push(`</svg>`);
  return p.join("");
}

// ── report annexes (markdown: heading + table + copyable Mermaid; page-broken in print) ──────────────
/** Annex A + B markdown: the change table + Mermaid (marked for the styled SVG swap), then the schema map.
 *  Each annex is prefixed with an HTML page-break marker the print CSS honours. */
export function renderAnnexes(g: ChangeGraph, schema: StoreChange[]): string {
  const out: string[] = [];
  out.push("## Annex A - Application dependency graph", "");
  out.push(`_Change-annotated module graph over ${g.range}. Green = net lines added, red = net removed. Total **+${g.totalAdded} / -${g.totalRemoved}** across **${g.totalFiles}** files. The Mermaid below is copyable (importable into draw.io)._`, "");
  if (g.modules.length) {
    out.push("| Module | Added | Removed | Files | Change |", "|---|--:|--:|--:|---|");
    for (const m of g.modules) out.push(`| ${m.label} | +${m.added} | -${m.removed} | ${m.files} | ${m.status} |`);
    out.push("");
    out.push("```mermaid", changeGraphMermaid(g), "```", "");
  } else {
    out.push("_No code changes detected in the selected range._", "");
  }
  out.push("## Annex B - Data schema changes", "");
  if (schema.length) {
    out.push("_Files touching a data store's schema (frozen-schema contract - review before release). Green = grew, red = shrank._", "");
    out.push("| Data store | Files | Added | Removed |", "|---|---|--:|--:|");
    for (const c of schema) out.push(`| ${c.store} | ${c.files.map((f) => f.path.split("/").pop()).join(", ")} | +${c.added} | -${c.removed} |`);
    out.push("");
    out.push("```mermaid", schemaMermaid(schema), "```", "");
  } else {
    out.push("_No data-schema / migration files changed in the selected range._", "");
  }
  return out.join("\n");
}

