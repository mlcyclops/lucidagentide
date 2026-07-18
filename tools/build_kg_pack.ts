// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/build_kg_pack.ts — ADR-0207: headless KG-pack builder.
//
// Authoring a role KG Pack is normally an in-app operation: Knowledge -> "seed from export" compiles every
// conversation into KG pages with a model call each (P-KGPACK.3/.6), then "export pack" writes the signed
// `.lkgpack`. This tool runs that EXACT pipeline from the command line so the whole product line
// (LucidAgentDesigns/KG Packs/<Role>/) can be built repeatably and sequentially, one `make kg-pack` at a time,
// instead of clicking through the app N times.
//
// It reuses the shipped, tested pieces with ZERO new trust path:
//   readKbSources (the app's export loader) -> createKg -> ingestSourcesIntoKg (fail-closed scan + compile,
//   the model injected as backend.complete — the SAME backend the LUCID session uses) -> exportKgPack (Ed25519
//   sign if a key is configured) -> importKgPack (verify + re-scan round-trip, proving the pack installs).
//
// It builds into an ISOLATED KB workspace (a temp dir, never the user's ~/.omp working graphs) and emits the
// pack next to its source dataset by default. Pure helpers (catalog + arg parsing) are unit-tested; the heavy
// KB/model modules load dynamically inside main() so the tests + --dry-run never spawn omp.

import { join, resolve, isAbsolute } from "node:path";
import { existsSync } from "node:fs";

// ── The build catalog: one entry per role folder under the KG Packs root ─────────────────────────────
// `id` is the stable pack/product id (invariant #9) and lines up with the storefront (desktop/renderer/
// kg_packs.ts) + the marketplace catalog where a row already exists. `folder` is relative to --root. Every
// field is overridable per-run (--name/--role/--desc/--licensing/--id) so naming can be corrected without a
// code change. Licensing follows the storefront (subscription for the maintained control-catalog packs).
export interface PackCatalogEntry {
  key: string;          // short CLI selector, e.g. "bd"
  folder: string;       // path relative to --root
  name: string;         // becomes the KG name -> the .lkgpack slug/filename
  role: string;         // the Position Description the pack embodies
  desc: string;
  licensing: "one-time" | "subscription";
  id: string;           // stable product id
}

export const PACK_CATALOG: PackCatalogEntry[] = [
  { key: "bd",          folder: "DoW Business Dev/AI TECH BD",            name: "Business Development Capture Manager", role: "Business Development / Capture Manager (DoW/DoD)", desc: "DoW/DoD business development and capture: pipeline shaping, teaming, gate reviews, and bid decisions.", licensing: "one-time", id: "dow-dod-business-development" },
  { key: "proposal",    folder: "DoW Business Dev/PROPOSAL MGR",          name: "Senior Proposal Manager",              role: "Proposal Manager / DoD RFP Compliance Lead",     desc: "DoD RFP proposal management: Section L/M/K response patterns, compliance matrices, color-team reviews, and proposal production.", licensing: "subscription", id: "senior-proposal-manager" },
  { key: "sbir",        folder: "DoW Business Dev/SBIR STTR NSF GRANT",   name: "SBIR/STTR & NSF Grants PI",            role: "Principal Investigator / Grants Lead",           desc: "SBIR/STTR and NSF grant strategy: solicitations, technical volumes, and Phase I/II execution.", licensing: "one-time", id: "sbir-sttr-grants-pi" },
  { key: "govcon",      folder: "GOVCON Contracts Officer",               name: "GovCon Contracts Officer",             role: "Contracting Officer / Specialist",               desc: "FAR/DFARS-grounded contracting: source selection, negotiation, and administration.", licensing: "one-time", id: "govcon-contracts-officer" },
  { key: "cmmc",        folder: "CMMC and RMF",                           name: "CMMC & RMF Security Lead",             role: "ISSO / Security Control Assessor",               desc: "CMMC 2.0 and NIST SP 800-171/800-53 RMF: controls, POA&Ms, and assessment objectives.", licensing: "subscription", id: "cmmc-rmf-security-lead" },
  { key: "pm-evm",      folder: "Program Manager",                        name: "Program Manager (EVM)",                role: "Program / Project Manager",                      desc: "CMMI and Earned Value Management: IMS, EAC, variance analysis, and program controls.", licensing: "subscription", id: "program-manager-evm" },
  { key: "cleared-swe", folder: "Cleared Software Engineer",              name: "Cleared Software Engineer",            role: "Software Engineer (cleared)",                    desc: "Secure SDLC for classified/air-gapped work: STIGs, secure coding, and ATO evidence.", licensing: "subscription", id: "cleared-software-engineer" },
  { key: "backend",     folder: "Backend Engineer",                       name: "Senior Backend Engineer",              role: "Backend / Platform Engineer",                    desc: "Backend systems and RAG: services, data pipelines, retrieval, and reliability.", licensing: "one-time", id: "senior-backend-engineer" },
  { key: "frontend",    folder: "Frontend Engineer",                      name: "Senior Frontend Engineer (UI/UX)",     role: "Frontend / UI-UX Engineer",                      desc: "Frontend and UI/UX: design systems, accessibility, and product interaction.", licensing: "one-time", id: "senior-frontend-uiux-engineer" },
  { key: "ml",          folder: "ML Engineer",                            name: "Machine Learning Engineer",            role: "Machine Learning Engineer",                      desc: "ML engineering: training, evaluation, deployment, and MLOps.", licensing: "one-time", id: "ml-engineer" },
  { key: "ste",         folder: "STE Engineer",                           name: "STE / Digital Engineering",            role: "Systems / Digital Engineer",                     desc: "Digital engineering and STE: model-based systems engineering and the digital thread.", licensing: "one-time", id: "ste-digital-engineering" },
];

/** The kb_pack.ts slug rule, mirrored so the tool can PREDICT the output filenames. Keep in sync with
 *  desktop/kb_pack.ts:slugify (the export uses its own copy on the KG name). */
export function predictSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "kg";
}

export interface BuildArgs {
  target?: string;      // a catalog key, a folder name, or a direct path
  root: string;         // the KG Packs root
  dest?: string;        // where to write the pack (default: the source folder)
  name?: string; role?: string; desc?: string; id?: string;
  licensing?: "one-time" | "subscription";
  version: string;
  author: string;
  limit?: number;       // maxDocuments — cap the model cost (smoke tests)
  model?: string;       // override the compile model (default: the app's most-used, else omp default)
  kbDir?: string;       // isolated build workspace (default: a temp dir)
  dryRun: boolean;      // parse + count docs, NO model calls
  keep: boolean;        // keep the isolated build workspace
  all: boolean;         // build every catalog entry
  help: boolean;
}

/** The default KG Packs root: a sibling of the repo (…/LucidAgentDesigns/KG Packs), overridable via --root. */
export function defaultRoot(cwd: string): string {
  return resolve(cwd, "..", "LucidAgentDesigns", "KG Packs");
}

/** Pure argument parser. Unknown flags throw (fail loud rather than silently mis-build). */
export function parseArgs(argv: string[], cwd = "."): BuildArgs {
  const a: BuildArgs = { root: defaultRoot(cwd), version: "1.0.0", author: "TechLead 187 LLC", dryRun: false, keep: false, all: false, help: false };
  const next = (i: number, flag: string): string => { const v = argv[i + 1]; if (v == null) throw new Error(`${flag} needs a value`); return v; };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--dry-run") a.dryRun = true;
    else if (t === "--keep") a.keep = true;
    else if (t === "--all") a.all = true;
    else if (t === "--root") { a.root = resolve(cwd, next(i, t)); i++; }
    else if (t === "--dest") { a.dest = next(i, t); i++; }
    else if (t === "--name") { a.name = next(i, t); i++; }
    else if (t === "--role") { a.role = next(i, t); i++; }
    else if (t === "--desc") { a.desc = next(i, t); i++; }
    else if (t === "--id") { a.id = next(i, t); i++; }
    else if (t === "--licensing") { const v = next(i, t); if (v !== "one-time" && v !== "subscription") throw new Error(`--licensing must be one-time|subscription`); a.licensing = v; i++; }
    else if (t === "--version") { a.version = next(i, t); i++; }
    else if (t === "--author") { a.author = next(i, t); i++; }
    else if (t === "--limit") { a.limit = Number(next(i, t)); if (!Number.isFinite(a.limit) || a.limit <= 0) throw new Error(`--limit must be a positive number`); i++; }
    else if (t === "--model") { a.model = next(i, t); i++; }
    else if (t === "--kb-dir") { a.kbDir = resolve(cwd, next(i, t)); i++; }
    else if (t.startsWith("-")) throw new Error(`unknown flag: ${t}`);
    else if (a.target == null) a.target = t;
    else throw new Error(`unexpected extra argument: ${t}`);
  }
  return a;
}

export interface ResolvedTarget { entry: PackCatalogEntry; folder: string }

/** Resolve a target (catalog key, folder name, or path) to a catalog entry + an absolute source folder.
 *  A path/folder not in the catalog gets a synthesized entry from its basename (still fully buildable). */
export function resolveTarget(target: string, root: string, catalog = PACK_CATALOG): ResolvedTarget {
  const byKey = catalog.find((e) => e.key === target);
  if (byKey) return { entry: byKey, folder: join(root, byKey.folder) };
  const byFolder = catalog.find((e) => e.folder.toLowerCase() === target.toLowerCase() || e.folder.split("/").pop()!.toLowerCase() === target.toLowerCase());
  if (byFolder) return { entry: byFolder, folder: join(root, byFolder.folder) };
  // A direct path (absolute or relative to root) with no catalog entry: synthesize one from the basename.
  const folder = isAbsolute(target) ? target : join(root, target);
  const base = folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "kg-pack";
  const name = base.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return { entry: { key: base, folder: target, name, role: name, desc: `Role KG pack: ${name}.`, licensing: "one-time", id: predictSlug(name) }, folder };
}

/** Apply per-run metadata overrides onto a catalog entry. Pure. */
export function withOverrides(entry: PackCatalogEntry, a: BuildArgs): PackCatalogEntry {
  return {
    ...entry,
    name: a.name ?? entry.name,
    role: a.role ?? entry.role,
    desc: a.desc ?? entry.desc,
    id: a.id ?? entry.id,
    licensing: a.licensing ?? entry.licensing,
  };
}

const USAGE = `build_kg_pack — headless KG-pack builder (ADR-0207)

Usage:
  bun tools/build_kg_pack.ts <key|folder|path> [options]
  bun tools/build_kg_pack.ts --all [options]

Targets (catalog keys):
${PACK_CATALOG.map((e) => `  ${e.key.padEnd(12)} ${e.name}  <-  ${e.folder}`).join("\n")}

Options:
  --root DIR       KG Packs root (default: ../LucidAgentDesigns/KG Packs)
  --dest DIR       where to write the .lkgpack (default: the source folder)
  --name/--role/--desc/--id/--licensing   override the catalog metadata
  --version V      pack version (default 1.0.0)     --author A   (default TechLead 187 LLC)
  --limit N        compile only the first N conversations (smoke test)
  --model M        compile model (default: the app's most-used model, else omp's default)
  --kb-dir DIR     isolated build workspace (default: a temp dir; removed unless --keep)
  --dry-run        load + count the source conversations, then stop (NO model calls)
  --keep           keep the isolated build workspace
  -h, --help       this help

Each conversation is compiled by one model call, fail-closed-scanned, then the pack is signed (if a key is
configured) and verified by a re-scan import round-trip. A purchase grants access; the signature + scanner
still prove origin + safety.`;

// ── main (dynamic-imports the heavy KB/model modules; never loaded by the tests or --dry-run) ────────
async function buildOne(a: BuildArgs, target: string, kb: typeof import("../desktop/kb_store.ts"), pack: typeof import("../desktop/kb_pack.ts"), sources: typeof import("../desktop/kb_sources.ts"), complete: ((s: string, u: string) => Promise<string>) | null): Promise<boolean> {
  const { entry, folder } = resolveTarget(target, a.root);
  const meta = withOverrides(entry, a);
  const dest = a.dest ? resolve(a.dest) : folder;
  console.log(`\n== ${meta.name}  (${meta.id})`);
  console.log(`   source: ${folder}`);
  if (!existsSync(folder)) { console.error(`   ! source folder not found`); return false; }

  const src = sources.readKbSources(folder);
  if (!src.ok) { console.error(`   ! ${src.error}`); return false; }
  const total = src.scan.docs.length;
  const willCompile = a.limit ? Math.min(a.limit, total) : total;
  console.log(`   loaded ${total} conversations (${src.scan.kind}${src.scan.vendor ? `/${src.scan.vendor}` : ""})${a.limit ? ` — compiling first ${willCompile}` : ""}`);

  if (a.dryRun) { console.log(`   dry-run: predicted pack -> ${join(dest, predictSlug(meta.name))}.lkgpack(.zip); no model calls`); return true; }
  if (!complete) { console.error(`   ! no model backend available — cannot compile (see the note above)`); return false; }

  const kg = kb.createKg({ name: meta.name, sourceKind: src.scan.kind, provenance: src.scan.vendor ? `import:${src.scan.vendor}` : "import:obsidian" });
  const store = await kb.kbStore(kg.kg_id);
  const t0 = Date.now();
  const { ingestSourcesIntoKg } = await import("../harness/kb/batch_ingest.ts");
  const result = await ingestSourcesIntoKg({
    store, scanner: kb.kbScanner(), complete, docs: src.scan.docs, maxDocuments: a.limit,
    onProgress: (p) => process.stdout.write(`\r   compiling ${p.documents}/${p.totalDocuments} · pages ${p.pagesCompiled} · quarantined ${p.pagesQuarantined} · errored ${p.errored}   `),
  });
  process.stdout.write("\n");
  console.log(`   compiled in ${Math.round((Date.now() - t0) / 1000)}s — pages ${result.pagesCompiled}, quarantined ${result.pagesQuarantined}, docs errored ${result.errored}, skipped ${result.skipped ?? 0}`);
  if (result.pagesCompiled === 0) { console.error(`   ! nothing compiled (every doc errored or was quarantined) — not exporting`); return false; }

  const exp = await pack.exportKgPack(kg.kg_id, dest, { author: a.author, version: a.version, role: meta.role, description: meta.desc, createdAt: new Date().toISOString() });
  if (!exp.ok) { console.error(`   ! export failed: ${exp.error}`); return false; }
  console.log(`   exported ${exp.pages} pages -> ${exp.zipPath}  (${exp.signed ? "signed" : "UNSIGNED"})`);

  // Verify the pack installs through the SAME gate (verify + re-scan fail-closed).
  const check = await pack.importKgPack(exp.path!);
  console.log(`   verify import: ${check.ok ? `OK (${check.pages} pages, ${check.signed ? `signed ${check.keyId ?? ""}`.trim() : "unsigned"})` : `FAILED at ${check.stage}: ${check.error}`}`);
  return check.ok;
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2), process.cwd());
  if (a.help || (!a.target && !a.all)) { console.log(USAGE); return; }

  // Isolate the build in its own KB workspace so we never touch the user's ~/.omp working graphs.
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const kbDir = a.kbDir ?? mkdtempSync(join(tmpdir(), "kgpack-build-"));
  process.env.LUCID_KB_DB_PATH = join(kbDir, "kb_graph.duckdb");
  process.env.LUCID_KG_REGISTRY_PATH = join(kbDir, "kg_registry.json");

  const kb = await import("../desktop/kb_store.ts");
  const pack = await import("../desktop/kb_pack.ts");
  const sources = await import("../desktop/kb_sources.ts");

  // Resolve the compile model (the app's most-used, mirroring /api/kb/ingest-batch) + the model backend.
  let complete: ((s: string, u: string) => Promise<string>) | null = null;
  if (!a.dryRun) {
    let model = a.model;
    if (!model) { try { const { usageLedger } = await import("../tools/memory_data.ts"); model = usageLedger().models[0]?.model; } catch { /* no ledger — use omp default */ } }
    try {
      const { backend } = await import("../desktop/acp_backend.ts");
      complete = (system: string, user: string) => backend.complete(system, user, model ? { model } : {});
      console.log(`compile model: ${model ?? "(omp default)"}  ·  build workspace: ${kbDir}`);
    } catch (e) {
      console.error(`! could not load the model backend (${(e as Error).message}) — only --dry-run is possible here.`);
    }
  }

  const targets = a.all ? PACK_CATALOG.map((e) => e.key) : [a.target!];
  let ok = 0;
  try {
    for (const t of targets) {
      kb._resetKbStoreForTest(); // fresh registry per pack in the isolated workspace
      if (await buildOne(a, t, kb, pack, sources, complete)) ok++;
    }
  } finally {
    await kb.stopKb().catch(() => {});
    if (!a.keep && !a.kbDir) { try { rmSync(kbDir, { recursive: true, force: true }); } catch { /* best effort */ } }
    try { const { backend } = await import("../desktop/acp_backend.ts"); (backend as unknown as { dispose?: () => void }).dispose?.(); } catch { /* ignore */ }
  }
  console.log(`\n${ok}/${targets.length} pack(s) built.`);
  if (ok < targets.length) process.exitCode = 1;
}

// Run only as a script (never when imported by the test).
if (import.meta.main) { void main(); }
