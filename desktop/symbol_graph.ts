// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/symbol_graph.ts
//
// P-KG-SYM.1: the SYMBOL-level code graph. Where code_graph.ts is file → file (imports), this parses each
// source file with the real TypeScript compiler AST and builds a symbol → symbol reference/call graph:
// nodes are the top-level declarations (functions, classes, methods, types/interfaces, consts) and edges
// are "symbol A references symbol B", resolved across files through named imports and within a file through
// its own top-level names.
//
// HONESTY: it's AST-accurate for identifier usage + cross-file import resolution, which is far better than a
// regex heuristic - but it is NOT a full type-checked call graph. It doesn't resolve method calls on values
// whose type it would need to infer (`obj.foo()`), overloads, or dynamic dispatch. It's a precise
// symbol-DEPENDENCY graph, labeled as such. Fail-soft per file: a file that won't parse is skipped.
//
// The TypeScript compiler is a HEAVY, LAZY dependency: we import it for types only (erased at load) and
// resolve the runtime module on first build via `loadTs()`. If the compiler can't be loaded (missing /
// broken package), the symbol-graph feature degrades to an empty graph - it must NEVER crash the module at
// import time, because dev.ts imports this file on the engine's boot path (a top-level throw here bricks the
// whole engine and the app never binds its port). This mirrors the existing fail-soft-per-file behavior.

import type * as TS from "typescript";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { listSourceFiles, resolveImport } from "./code_graph.ts";

export interface SymNode { id: string; name: string; kind: string; trust: "trusted"; count: number }
export interface SymEdge { from: string; to: string; relation: string }
export interface SymbolGraph { level: "symbol"; nodes: SymNode[]; edges: SymEdge[]; root: string; fileCount: number; symbolCount: number; edgeCount: number; updatedAt: number }

const symbolPath = (root: string) => join(root, ".omp", "codegraph-symbol.json");

/** Lazily resolve the TypeScript compiler at runtime. Returns null (never throws) if the package is missing
 *  or broken, so a bad `typescript` install degrades ONLY the symbol graph rather than the whole engine. */
let tsHandle: typeof TS | null | undefined; // undefined = not tried yet; null = tried and unavailable
export function loadTs(): typeof TS | null {
  if (tsHandle !== undefined) return tsHandle;
  try { tsHandle = createRequire(import.meta.url)("typescript") as typeof TS; }
  catch { tsHandle = null; }
  return tsHandle;
}

/** The fail-soft result when the compiler can't be loaded: a valid, empty symbol graph. */
const emptyGraph = (root: string): SymbolGraph =>
  ({ level: "symbol", nodes: [], edges: [], root, fileCount: 0, symbolCount: 0, edgeCount: 0, updatedAt: Date.now() });

const scriptKind = (ts: typeof TS, rel: string): TS.ScriptKind =>
  rel.endsWith(".tsx") ? ts.ScriptKind.TSX : rel.endsWith(".jsx") ? ts.ScriptKind.JSX
    : rel.endsWith(".js") || rel.endsWith(".mjs") || rel.endsWith(".cjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS;

interface Decl { name: string; kind: string; node: TS.Node; refs: Set<string> }
interface ParsedFile { decls: Decl[]; imports: Map<string, { module: string; imported: string }> } // localName → source

/** Extract this file's top-level declarations + import bindings + each declaration's referenced identifiers. */
function parseFile(ts: typeof TS, rel: string, content: string): ParsedFile {
  const sf = ts.createSourceFile(rel, content, ts.ScriptTarget.Latest, /*setParentNodes*/ true, scriptKind(ts, rel));
  const imports = new Map<string, { module: string; imported: string }>();
  const decls: Decl[] = [];

  for (const st of sf.statements) {
    // import bindings: named ({a, b as c}), default, and namespace (* as ns)
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const mod = st.moduleSpecifier.text;
      const b = st.importClause;
      if (b?.name) imports.set(b.name.text, { module: mod, imported: "default" });
      const nb = b?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) imports.set(nb.name.text, { module: mod, imported: "*" });
      if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) imports.set(e.name.text, { module: mod, imported: (e.propertyName ?? e.name).text });
      continue;
    }
    const add = (name: string, kind: string, node: TS.Node) => decls.push({ name, kind, node, refs: refsOf(ts, node, name) });
    if (ts.isFunctionDeclaration(st) && st.name) add(st.name.text, "function", st);
    else if (ts.isClassDeclaration(st) && st.name) {
      add(st.name.text, "class", st);
      for (const m of st.members) if ((ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)) && m.name && ts.isIdentifier(m.name)) add(`${st.name.text}.${m.name.text}`, "method", m);
    } else if (ts.isInterfaceDeclaration(st)) add(st.name.text, "type", st);
    else if (ts.isTypeAliasDeclaration(st)) add(st.name.text, "type", st);
    else if (ts.isEnumDeclaration(st)) add(st.name.text, "enum", st);
    else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        const isFn = d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer));
        add(d.name.text, isFn ? "function" : "const", st);
      }
    }
  }
  return { decls, imports };
}

/** Every identifier NAME referenced inside a declaration node (excluding its own name + property keys). */
function refsOf(ts: typeof TS, node: TS.Node, ownName: string): Set<string> {
  const out = new Set<string>();
  const visit = (n: TS.Node) => {
    // don't count `a` in `x.a` (property access) as a free identifier - only the base object matters
    if (ts.isPropertyAccessExpression(n)) { visit(n.expression); return; }
    if (ts.isIdentifier(n) && n.text !== ownName && n.text.split(".")[0] !== ownName) out.add(n.text);
    n.forEachChild(visit);
  };
  node.forEachChild(visit); // skip the declaration's own name node at the top
  return out;
}

/** Build the symbol graph for `root` (pure over the filesystem read; no persistence). `loadCompiler` is
 *  injectable for tests; by default it lazily resolves the real TypeScript compiler. If the compiler can't
 *  be loaded, we return an empty graph rather than throwing - fail-soft for the whole feature. */
export function buildSymbolGraph(root: string, loadCompiler: () => typeof TS | null = loadTs): SymbolGraph {
  const ts = loadCompiler();
  if (!ts) return emptyGraph(root); // TypeScript compiler unavailable: degrade to an empty graph
  const rels = listSourceFiles(root);
  const files = new Set(rels);
  const parsed = new Map<string, ParsedFile>();
  const fileSymbols = new Map<string, Set<string>>(); // rel → set of local top-level symbol names
  for (const rel of rels) {
    let content = "";
    try { content = readFileSync(join(root, rel), "utf8"); } catch { continue; }
    let pf: ParsedFile;
    try { pf = parseFile(ts, rel, content); } catch { continue; } // fail-soft on an unparseable file
    parsed.set(rel, pf);
    fileSymbols.set(rel, new Set(pf.decls.map((d) => d.name.split(".")[0]!)));
  }
  const kindOf = new Map<string, string>();
  for (const [rel, pf] of parsed) for (const d of pf.decls) kindOf.set(`${rel}#${d.name}`, d.kind);

  const edges: SymEdge[] = [];
  const degree = new Map<string, number>();
  const seen = new Set<string>();
  const link = (from: string, to: string) => {
    if (from === to) return;
    const key = `${from} ${to}`;
    if (seen.has(key)) return; seen.add(key);
    edges.push({ from, to, relation: "references" });
    degree.set(from, (degree.get(from) ?? 0) + 1);
    degree.set(to, (degree.get(to) ?? 0) + 1);
  };
  for (const [rel, pf] of parsed) {
    const localNames = fileSymbols.get(rel)!;
    for (const d of pf.decls) {
      const from = `${rel}#${d.name}`;
      for (const name of d.refs) {
        const imp = pf.imports.get(name);
        if (imp) { // cross-file: this name came from an import
          const target = resolveImport(imp.module, rel, files);
          if (!target) continue; // external package
          const sym = imp.imported === "default" || imp.imported === "*" ? name : imp.imported;
          if (kindOf.has(`${target}#${sym}`)) link(from, `${target}#${sym}`);
        } else if (localNames.has(name) && name !== d.name.split(".")[0]) { // intra-file reference
          link(from, `${rel}#${name}`);
        }
      }
    }
  }

  const nodes: SymNode[] = [];
  for (const [rel, pf] of parsed) for (const d of pf.decls) {
    const id = `${rel}#${d.name}`;
    nodes.push({ id, name: d.name, kind: d.kind, trust: "trusted", count: degree.get(id) ?? 0 });
  }
  return { level: "symbol", nodes, edges, root, fileCount: parsed.size, symbolCount: nodes.length, edgeCount: edges.length, updatedAt: Date.now() };
}

/** Build + persist the symbol graph (the ingest / re-sync action). */
export function ingestSymbolGraph(root: string, loadCompiler: () => typeof TS | null = loadTs): SymbolGraph {
  const g = buildSymbolGraph(root, loadCompiler);
  try { mkdirSync(join(root, ".omp"), { recursive: true }); writeFileSync(symbolPath(root), JSON.stringify(g)); } catch { /* best-effort */ }
  return g;
}
export function loadSymbolGraph(root: string): SymbolGraph | null {
  try { return JSON.parse(readFileSync(symbolPath(root), "utf8")) as SymbolGraph; } catch { return null; }
}
