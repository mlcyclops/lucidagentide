// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/codegraph_extension.ts — P-KG-SYM.1: register an agent-callable `codegraph_query` tool so the
// agent can ask the pre-built workspace code graph "what imports/uses X?" or "what's the neighborhood of Y?"
// and get a precise, compact answer — instead of grepping + reading many whole files. This is the token-
// saving payoff of the code graph: a small structured response replaces thousands of tokens of file reads.
//
// The tool runs in omp's SUBPROCESS (cwd = the workspace), so it reads the graphs the desktop already
// ingested at `<cwd>/.omp/codegraph.json` (file graph) and `<cwd>/.omp/codegraph-symbol.json` (symbol graph).
// Read-only (approval "read" → never trips the exec gate). Registration is fully wrapped: any failure just
// means the tool is absent — omp launch, the gate, and chat all keep working.

import { readFileSync } from "node:fs";
import { join } from "node:path";

interface GNode { id: string; name: string; kind: string; count: number }
interface GEdge { from: string; to: string; relation: string }
interface Graph { nodes: GNode[]; edges: GEdge[]; fileCount?: number; symbolCount?: number; edgeCount?: number }

function loadGraph(level: "file" | "symbol"): Graph | null {
  try {
    const file = level === "symbol" ? "codegraph-symbol.json" : "codegraph.json";
    return JSON.parse(readFileSync(join(process.cwd(), ".omp", file), "utf8")) as Graph;
  } catch { return null; }
}

/** Resolve a query target to matching node ids: exact id, exact file/symbol name, then case-insensitive substring. */
export function matchNodes(g: Graph, q: string): GNode[] {
  const t = (q || "").trim();
  if (!t) return [];
  const byId = g.nodes.find((n) => n.id === t);
  if (byId) return [byId];
  const exact = g.nodes.filter((n) => n.name === t || n.id.split("#")[0] === t || n.id.endsWith(`/${t}`));
  if (exact.length) return exact;
  const lc = t.toLowerCase();
  return g.nodes.filter((n) => n.id.toLowerCase().includes(lc) || n.name.toLowerCase().includes(lc)).slice(0, 25);
}

/** Build the answer text for one matched node: its out-edges (imports/uses) and in-edges (importers/users). */
export function describeNode(g: Graph, n: GNode, level: "file" | "symbol"): string {
  const outs = g.edges.filter((e) => e.from === n.id).map((e) => e.to);
  const ins = g.edges.filter((e) => e.to === n.id).map((e) => e.from);
  const outLbl = level === "symbol" ? "uses" : "imports";
  const inLbl = level === "symbol" ? "used by" : "imported by";
  const list = (xs: string[]) => (xs.length ? xs.slice(0, 60).map((x) => `  - ${x}`).join("\n") + (xs.length > 60 ? `\n  …(${xs.length - 60} more)` : "") : "  (none)");
  const head = level === "symbol" ? `${n.id}  [${n.kind}]` : n.id;
  return `${head}\n${outLbl} (${outs.length}):\n${list(outs)}\n${inLbl} (${ins.length}):\n${list(ins)}`;
}

export default function codegraphExtension(pi: any): void {
  try {
    if (!pi || typeof pi.registerTool !== "function") return;
    const T = pi.typebox?.Type;
    if (!T) return;
    pi.registerTool({
      name: "codegraph_query",
      label: "Query the code graph",
      description:
        "Query the workspace's pre-built code graph instead of grepping + reading many whole files. " +
        "level 'file' = the file→import dependency graph; level 'symbol' = the AST symbol reference/call graph " +
        "(functions/classes/methods/types). Pass `target` = a file path, a symbol name, or a file#symbol id to " +
        "get what it imports/uses and what imports/uses it (blast radius). Omit `target` for a summary of the " +
        "graph's biggest hubs. Read-only.",
      approval: "read",
      parameters: T.Object({
        target: T.Optional(T.String({ description: "A file path, symbol name, or file#symbol id. Omit for a hubs summary." })),
        level: T.Optional(T.String({ description: "'file' (imports) or 'symbol' (AST references). Default 'file'." })),
      }),
      async execute(_id: string, params: any) {
        const text = (t: string) => ({ content: [{ type: "text", text: t }] });
        const level: "file" | "symbol" = params?.level === "symbol" ? "symbol" : "file";
        const g = loadGraph(level);
        if (!g || !g.nodes?.length) {
          return text(`No ${level} code graph is available for this workspace yet. Ask the user to build it in the Knowledge-graph panel (Code graph → ${level === "symbol" ? "Symbol" : "File"} graph), then retry.`);
        }
        const target = String(params?.target ?? "").trim();
        if (!target) {
          const hubs = [...g.nodes].sort((a, b) => b.count - a.count).slice(0, 20).map((n) => `  - ${n.id} (${n.count} links${level === "symbol" ? `, ${n.kind}` : ""})`).join("\n");
          return text(`Workspace ${level} graph: ${g.nodes.length} nodes, ${g.edges.length} edges. Most-connected:\n${hubs}`);
        }
        const hits = matchNodes(g, target);
        if (!hits.length) return text(`No node matches "${target}" in the ${level} graph. Try a bare filename or symbol name, or omit target for a hubs summary.`);
        if (hits.length > 1 && !g.nodes.some((n) => n.id === target)) {
          return text(`"${target}" matches ${hits.length} nodes in the ${level} graph:\n${hits.map((n) => `  - ${n.id}`).join("\n")}\nRe-query with a specific id for its edges.`);
        }
        return text(hits.map((n) => describeNode(g, n, level)).join("\n\n"));
      },
    });
  } catch (e) {
    try { process.stderr.write(`\n[LucidAgentIDE] codegraph_query tool not registered: ${String((e as { message?: unknown })?.message ?? e)}\n`); } catch { /* ignore */ }
  }
}
