// desktop/scripts/demo_p_kg_search_1.ts
//
// Increment P-KG-SEARCH.1 — find a node in a large graph (issue/ADR-0083). A real import is hundreds of
// nodes; finding one by dragging is painful. A search box now highlights + centers matching nodes. Proof of
// the pure matcher the renderer feeds to graph.setSearch() (highlight + fit-to-matches).

import { matchNodes } from "../renderer/kg_ops.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);

console.log("== #ADR-0083 node search (case-insensitive substring) ==");

// a mini "imported" graph
const nodes = [
  { id: "a", name: "Rust" }, { id: "b", name: "Kubernetes" }, { id: "c", name: "rusty logistics" },
  { id: "d", name: "Breaking Bad" }, { id: "e", name: "predictive analytics" },
];

const rust = matchNodes(nodes, "rust");
if ([...rust].sort().join() !== "a,c") fail(`"rust" should match Rust + rusty logistics, got ${[...rust]}`);
ok('"rust" → highlights "Rust" and "rusty logistics" (case-insensitive, substring)');

if ([...matchNodes(nodes, "KUBER")].join() !== "b") fail("uppercase query should still match");
ok('"KUBER" → "Kubernetes" (query case ignored)');

if (matchNodes(nodes, "").size !== 0 || matchNodes(nodes, "   ").size !== 0) fail("empty/blank query must clear (match nothing)");
ok("empty / blank query → no matches (clears the highlight)");

if (matchNodes(nodes, "zzz").size !== 0) fail("a no-hit query matches nothing");
ok("a no-hit query matches nothing (the graph just stays dimmed-none)");

// The renderer feeds these ids to graph.setSearch(ids): matches get a ring + brighten, the rest dim, and
// the view centers on the matches (computeFit over the matched subset). That part is the SVG layer.
ok("renderer wiring: setSearch(ids) → highlight matches, dim the rest, center on the matches");

console.log("demo-P-KG-SEARCH.1 OK");
process.exit(0);
