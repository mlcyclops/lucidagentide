// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/build_kg_packs_queue.ts — run `build_kg_pack.ts` over several packs and RECORD what each build cost.
//
// The 2026-07-18 hand-rolled bash queue (`KG Packs/_build-logs/run_queue.sh`) shipped three defects that this
// replaces, all of them measurement defects rather than build defects:
//   1. It reported 11,884-minute builds. The four packs it finished were written ~2h15m after the queue
//      started; `build_one` was timing until the shell harvested the job, not until the build ended, because
//      the builder DOES NOT EXIT on win32 (an omp backend handle stays open after the pack is written).
//      Here a build is DONE when its completion marker prints and the artifact exists, and the child is then
//      killed on purpose, so wall time means what it says.
//   2. It recorded `FAIL` for a pack that had actually succeeded (govcon), because a non-exiting child looks
//      exactly like a hung one. Outcome here is decided by the marker + artifact, never by the exit code
//      alone, and a real failure keeps its log.
//   3. It captured no cost or quality signal at all, so nothing could be compared across models. Every run
//      now appends a row to metrics.json + metrics.csv: model, wall seconds, seconds per conversation,
//      pages, quarantined, errored, artifact bytes, bytes per page, and the signature the verify saw.
//
// Signing is REQUIRED here, unlike the builder itself, which fail-softs to an unsigned pack. These artifacts
// are sold and the storefront promises a signed bundle, so a missing key is a hard stop, not a warning.
//
// Usage:
//   bun tools/build_kg_packs_queue.ts <key…> [--model M] [--slots N] [--timeout-min N] [--plan]
//   bun tools/build_kg_packs_queue.ts --unbuilt --model anthropic/claude-sonnet-5
//
//   --unbuilt        every catalog pack with no artifact next to its source (the default target set)
//   --plan           print the resolved plan + parsed environment, run nothing
//   --slots N        concurrent builds (default 3)
//   --timeout-min N  per-pack ceiling (default 360)

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { PACK_CATALOG, defaultRoot, predictSlug, resolveTarget, type PackCatalogEntry } from "./build_kg_pack.ts";

const SIGNING_FILE = join(homedir(), ".omp", "lucid-pack-signing.json");
const DONE_MARKER = /pack\(s\) built\./;

interface QueueArgs { keys: string[]; model?: string; slots: number; timeoutMin: number; plan: boolean; root: string }

/** Pure argument parser. Unknown flags throw rather than silently building the wrong set. */
export function parseQueueArgs(argv: string[], cwd = "."): QueueArgs {
  const a: QueueArgs = { keys: [], slots: 3, timeoutMin: 360, plan: false, root: defaultRoot(cwd) };
  const next = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (!v) throw new Error(`${flag} needs a value`);
    return v;
  };
  let unbuilt = false;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i] ?? "";
    if (t === "--model") { a.model = next(i, t); i++; }
    else if (t === "--slots") { a.slots = Number(next(i, t)); i++; }
    else if (t === "--timeout-min") { a.timeoutMin = Number(next(i, t)); i++; }
    else if (t === "--root") { a.root = resolve(cwd, next(i, t)); i++; }
    else if (t === "--plan") a.plan = true;
    else if (t === "--unbuilt") unbuilt = true;
    else if (t.startsWith("--")) throw new Error(`unknown flag: ${t}`);
    else a.keys.push(t);
  }
  if (!Number.isFinite(a.slots) || a.slots < 1) throw new Error("--slots must be >= 1");
  if (!Number.isFinite(a.timeoutMin) || a.timeoutMin < 1) throw new Error("--timeout-min must be >= 1");
  if (unbuilt) a.keys.push(...PACK_CATALOG.filter((e) => !artifactOf(e, a.root).exists).map((e) => e.key));
  if (!a.keys.length) throw new Error("no targets: pass catalog keys or --unbuilt");
  return a;
}

/** Where a pack's artifact lands, and whether it is already there. Uses the builder's own slug rule. */
export function artifactOf(entry: PackCatalogEntry, root: string): { path: string; exists: boolean; bytes: number } {
  const path = join(root, entry.folder, `${predictSlug(entry.name)}.lkgpack.zip`);
  const exists = existsSync(path);
  return { path, exists, bytes: exists ? statSync(path).size : 0 };
}

export interface BuildMetrics {
  key: string; packId: string; name: string; model: string;
  startedAt: string; finishedAt: string; wallSec: number;
  conversations: number | null; pages: number | null; quarantined: number | null; errored: number | null; skipped: number | null;
  compiledSec: number | null; secPerConversation: number | null;
  artifact: string | null; bytes: number | null; bytesPerPage: number | null;
  signature: string | null; verify: string | null;
  outcome: "built" | "failed" | "timeout"; log: string;
}

/** Pull every number the builder prints out of its own log. PURE, so the parsing is unit-testable. */
export function parseBuildLog(log: string): Omit<BuildMetrics, "key" | "packId" | "name" | "model" | "startedAt" | "finishedAt" | "wallSec" | "outcome" | "log" | "secPerConversation" | "bytesPerPage" | "bytes"> {
  const num = (re: RegExp): number | null => {
    const m = log.match(re);
    return m ? Number(m[1]) : null;
  };
  const exported = log.match(/exported\s+\d+\s+pages\s+->\s+(.+?)\s{2}\((signed|UNSIGNED)\)/);
  const verify = log.match(/verify import:\s+(.+)$/m);
  return {
    conversations: num(/loaded\s+(\d+)\s+conversations/),
    pages: num(/compiled in\s+\d+s.*?pages\s+(\d+)/),
    quarantined: num(/quarantined\s+(\d+),/),
    errored: num(/docs errored\s+(\d+)/),
    skipped: num(/skipped\s+(\d+)/),
    compiledSec: num(/compiled in\s+(\d+)s/),
    artifact: exported?.[1]?.trim() ?? null,
    signature: exported?.[2] ?? null,
    verify: verify?.[1]?.trim() ?? null,
  };
}

/** Run ONE build. Resolves when the completion marker prints (then kills the lingering child) or on timeout. */
async function buildOne(entry: PackCatalogEntry, a: QueueArgs, env: Record<string, string>, logDir: string): Promise<BuildMetrics> {
  const logPath = join(logDir, `${entry.key}.${Date.now()}.log`);
  const args = ["tools/build_kg_pack.ts", entry.key, "--root", a.root, ...(a.model ? ["--model", a.model] : [])];
  // Stream to disk as it arrives rather than writing once at the end: a 3-hour build with no readable log
  // until it finishes cannot be monitored, which is half of why the July run's failures were undiagnosable.
  const sink = createWriteStream(logPath, { flags: "a" });
  const startedAt = new Date();
  const child = spawn("bun", args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });

  const { promise, resolve: settle } = Promise.withResolvers<"built" | "failed" | "timeout">();
  let out = "";
  let done = false;
  const finish = (outcome: "built" | "failed" | "timeout") => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (!child.killed) child.kill();
    sink.end();
    settle(outcome);
  };
  const timer = setTimeout(() => finish("timeout"), a.timeoutMin * 60_000);

  const onChunk = (b: Buffer): void => {
    const s = b.toString();
    out += s;
    sink.write(s);
    // The builder does not exit on win32, so the marker plus a real artifact IS the completion signal.
    if (DONE_MARKER.test(out) && artifactOf(entry, a.root).exists) finish("built");
  };
  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);
  child.on("error", () => finish("failed"));
  child.on("exit", () => finish(DONE_MARKER.test(out) ? "built" : "failed"));

  const outcome = await promise;
  const finishedAt = new Date();
  writeFileSync(logPath.replace(/\.log$/, ".final.log"), out);
  const art = artifactOf(entry, a.root);
  const parsed = parseBuildLog(out);
  const wallSec = Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000);
  return {
    key: entry.key, packId: entry.id, name: entry.name, model: a.model ?? "(default)",
    startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), wallSec,
    ...parsed,
    secPerConversation: parsed.conversations && parsed.conversations > 0 ? Math.round((wallSec / parsed.conversations) * 10) / 10 : null,
    bytes: art.exists ? art.bytes : parsed.artifact && existsSync(parsed.artifact) ? statSync(parsed.artifact).size : null,
    bytesPerPage: null,
    outcome, log: logPath,
  };
}

function withDerived(m: BuildMetrics): BuildMetrics {
  return { ...m, bytesPerPage: m.bytes && m.pages ? Math.round(m.bytes / m.pages) : null };
}

const CSV_COLUMNS: (keyof BuildMetrics)[] = [
  "key", "packId", "model", "outcome", "startedAt", "wallSec", "secPerConversation",
  "conversations", "pages", "quarantined", "errored", "bytes", "bytesPerPage", "signature", "verify",
];

function appendLedger(dir: string, rows: BuildMetrics[]): void {
  const jsonPath = join(dir, "metrics.json");
  const prior: BuildMetrics[] = existsSync(jsonPath) ? JSON.parse(readFileSync(jsonPath, "utf8")) : [];
  const all = [...prior, ...rows];
  writeFileSync(jsonPath, `${JSON.stringify(all, null, 2)}\n`);
  const csv = [CSV_COLUMNS.join(","), ...all.map((r) => CSV_COLUMNS.map((c) => {
    const v = r[c];
    return v === null || v === undefined ? "" : /[",]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  }).join(","))].join("\n");
  writeFileSync(join(dir, "metrics.csv"), `${csv}\n`);
}

async function main(): Promise<void> {
  const a = parseQueueArgs(process.argv.slice(2));
  const targets = a.keys.map((k) => resolveTarget(k, a.root).entry);
  const logDir = join(a.root, "_build-logs");
  mkdirSync(logDir, { recursive: true });

  if (!existsSync(SIGNING_FILE)) {
    console.error(`\u2717 no signing key at ${SIGNING_FILE} — these packs are SOLD and the storefront promises a signed bundle, so this is a hard stop.`);
    process.exit(1);
  }
  const signing = JSON.parse(readFileSync(SIGNING_FILE, "utf8")) as { keyId?: string; pkcs8_b64?: string };
  if (!signing.pkcs8_b64 || !signing.keyId) { console.error(`\u2717 ${SIGNING_FILE} is missing keyId or pkcs8_b64.`); process.exit(1); }
  const env = { LUCID_KG_PACK_SIGNING_KEY: signing.pkcs8_b64, LUCID_KG_PACK_SIGNING_KEY_ID: signing.keyId };

  console.log(`queue: ${targets.length} pack(s) · model ${a.model ?? "(omp default)"} · ${a.slots} slot(s) · ${a.timeoutMin}min ceiling`);
  console.log(`signing: ${signing.keyId} · logs + metrics: ${logDir}`);
  for (const t of targets) console.log(`  ${t.key.padEnd(12)} ${t.name}`);
  if (a.plan) { console.log("\n--plan: nothing run."); return; }

  const queue = [...targets];
  const rows: BuildMetrics[] = [];
  const worker = async (): Promise<void> => {
    for (;;) {
      const entry = queue.shift();
      if (!entry) return;
      console.log(`[${new Date().toISOString()}] START ${entry.key}`);
      const m = withDerived(await buildOne(entry, a, env, logDir));
      rows.push(m);
      appendLedger(logDir, [m]);
      console.log(`[${new Date().toISOString()}] ${m.outcome.toUpperCase().padEnd(7)} ${entry.key} · ${Math.round(m.wallSec / 60)}min · pages ${m.pages ?? "?"} · quarantined ${m.quarantined ?? "?"} · ${m.signature ?? "no artifact"}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(a.slots, targets.length) }, worker));

  const built = rows.filter((r) => r.outcome === "built");
  console.log(`\n${built.length}/${rows.length} built. metrics -> ${join(logDir, "metrics.csv")}`);
  for (const r of rows.filter((x) => x.outcome !== "built")) console.log(`  ! ${r.key} ${r.outcome} — see ${r.log}`);
}

if (import.meta.main) { void main(); }
