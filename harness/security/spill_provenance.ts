// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/security/spill_provenance.ts
//
// P-CTX.2a (ADR-0578): provenance for tool results that omp spilled to a session artifact.
//
// WHAT OMP DOES (confirmed against omp 18.18.6, tools/output-meta.ts `spillLargeResultToArtifact`). A tool
// result over `tools.artifactSpillThreshold` (default 50 KB) is saved whole as `<artifactsDir>/<n>.<tool>.log`
// and replaced inline by a head and tail view; `details.meta.truncation.artifactId` names the artifact and
// the model reads the rest back with `read artifact://<n>:<from>-<to>`. This happens for every tool
// (built-in, MCP, extension) and BEFORE any `tool_result` hook runs.
//
// WHY THIS MODULE EXISTS. A hook therefore sees only the inline view. For a result from an MCP server that
// left the elided middle unscanned and readable back through a local tool the gate does not touch. This
// module is the shared state that closes it: it reads omp's spill metadata, gives the gate access to the
// whole artifact, and keeps a ledger of which artifacts came from an external source and with what trust
// label, so a later read of one can be recognised and fenced.
//
// THE LEDGER. One JSON line per external artifact in `<artifactsDir>/lucid-provenance.jsonl`, beside the
// artifacts it describes (omp's id scan only matches `<n>.*.log`, so the file is ignored by omp and is
// removed with the session). It is also held in memory, shared by every extension in the omp process. A
// non-persistent session has no artifacts directory and keeps the ledger in memory only.
//
// FAIL-CLOSED (invariant 3). A ledger file that exists but cannot be read or parsed makes every artifact
// id it cannot vouch for `unreadable`, which callers treat as untrusted, never as local.

import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { isTrustLabel, type TrustLabel } from "../contracts.ts";

export const LEDGER_FILE = "lucid-provenance.jsonl";

/** What replaces a quarantined artifact's content on disk, so `artifact://<n>` returns this and not the payload. */
export const PURGED_NOTICE =
  "[WITHHELD by Lucid: this artifact held a quarantined tool result and its content was removed.]\n";

/** One external (non-local) spilled artifact. `artifact_id` is stable for the life of the session files. */
export interface SpillRecord {
  /** `<session_id>/<omp_artifact_id>`. omp's own id is only unique inside one session. */
  artifact_id: string;
  session_id: string;
  omp_artifact_id: string;
  tool_name: string;
  /** Where the content came from, for example `mcp:github`. */
  source: string;
  /** Never `trusted`: a record exists only for content from outside the workspace. */
  trust_label: TrustLabel;
  /** Size and hash of the whole artifact as scanned; null when it was blocked before it could be read. */
  total_chars: number | null;
  content_sha256: string | null;
  /** True when the artifact's content was replaced by PURGED_NOTICE. */
  purged: boolean;
  created_at: string;
}

const SEVERITY: Record<TrustLabel, number> = { trusted: 0, untrusted: 1, suspicious: 2, quarantined: 3 };

/** The more severe of two labels (quarantined over suspicious over untrusted over trusted). */
export function worseLabel(a: TrustLabel, b: TrustLabel): TrustLabel {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

const OMP_ARTIFACT_ID = /^\d+$/;

/** The artifact ids omp attached to a tool result: the spill artifact and, for stream tools, the artifact
 *  holding lines cut by the column limit. Empty when the result was not spilled. */
export function spillArtifactIds(details: unknown): string[] {
  if (!isRecord(details) || !isRecord(details.meta)) return [];
  const meta = details.meta;
  const ids: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && OMP_ARTIFACT_ID.test(v) && !ids.includes(v)) ids.push(v);
  };
  if (isRecord(meta.truncation)) push(meta.truncation.artifactId);
  if (isRecord(meta.limits) && isRecord(meta.limits.columnTruncated)) push(meta.limits.columnTruncated.artifactId);
  return ids;
}

function parseRecord(v: unknown): SpillRecord | null {
  if (!isRecord(v)) return null;
  const { artifact_id, session_id, omp_artifact_id, tool_name, source, trust_label, total_chars, content_sha256, purged, created_at } = v;
  if (typeof artifact_id !== "string" || typeof session_id !== "string") return null;
  if (typeof omp_artifact_id !== "string" || !OMP_ARTIFACT_ID.test(omp_artifact_id)) return null;
  if (typeof tool_name !== "string" || typeof source !== "string" || typeof created_at !== "string") return null;
  if (!isTrustLabel(trust_label) || trust_label === "trusted") return null;
  if (total_chars !== null && typeof total_chars !== "number") return null;
  if (content_sha256 !== null && typeof content_sha256 !== "string") return null;
  if (typeof purged !== "boolean") return null;
  return { artifact_id, session_id, omp_artifact_id, tool_name, source, trust_label, total_chars, content_sha256, purged, created_at };
}

/** What the ledger knows about one artifact id. `unreadable` means the ledger file could not be trusted to
 *  answer, so the caller must treat the artifact as external. `unknown` means no external tool wrote it. */
export type SpillLookup =
  | { state: "known"; record: SpillRecord }
  | { state: "unknown" }
  | { state: "unreadable" };

/** The ledger of external artifacts for one session's artifacts directory. */
export class SpillLedger {
  readonly #file: string | null;
  readonly #records = new Map<string, SpillRecord>();
  #loaded = false;
  #unreadable = false;

  /** `artifactsDir` null keeps the ledger in memory only (a non-persistent session). */
  constructor(artifactsDir: string | null) {
    this.#file = artifactsDir === null ? null : join(artifactsDir, LEDGER_FILE);
  }

  #load(): void {
    if (this.#loaded) return;
    this.#loaded = true;
    if (this.#file === null) return;
    let text: string;
    try {
      text = readFileSync(this.#file, "utf8");
    } catch (err) {
      // Absent is the normal case (no external spill yet). Anything else is a ledger we cannot read.
      if (isRecord(err) && err.code === "ENOENT") return;
      this.#unreadable = true;
      return;
    }
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let rec: SpillRecord | null = null;
      try {
        rec = parseRecord(JSON.parse(line));
      } catch {
        rec = null;
      }
      if (rec === null) {
        this.#unreadable = true; // a damaged line may have named any artifact
        continue;
      }
      this.#keep(rec);
    }
  }

  /** Keep the most severe record per artifact, so a later line can never soften an earlier verdict. */
  #keep(rec: SpillRecord): void {
    const prev = this.#records.get(rec.omp_artifact_id);
    if (prev && SEVERITY[prev.trust_label] > SEVERITY[rec.trust_label]) return;
    this.#records.set(rec.omp_artifact_id, rec);
  }

  /** Record an external artifact: in memory first, then on disk. Throws when the durable write fails, with
   *  the record still held in memory, so the caller can fail closed and this process still knows it. */
  record(rec: SpillRecord): void {
    this.#load();
    this.#keep(rec);
    if (this.#file !== null) appendFileSync(this.#file, `${JSON.stringify(rec)}\n`, "utf8");
  }

  lookup(ompArtifactId: string): SpillLookup {
    this.#load();
    const record = this.#records.get(ompArtifactId);
    if (record) return { state: "known", record };
    return this.#unreadable ? { state: "unreadable" } : { state: "unknown" };
  }

  /** Every external artifact the ledger knows. */
  records(): SpillRecord[] {
    this.#load();
    return [...this.#records.values()];
  }

  /** True when the ledger file could not be read or held a damaged line. */
  get unreadable(): boolean {
    this.#load();
    return this.#unreadable;
  }

  /** True when any read of an artifact might return external content. False is the common case and lets
   *  callers skip all further work. */
  hasExternal(): boolean {
    this.#load();
    return this.#unreadable || this.#records.size > 0;
  }
}

// One ledger per artifacts directory for the whole process, so the gate that records a spill and the gate
// that sees it read back share the in-memory state even when the durable write failed.
const ledgers = new Map<string, SpillLedger>();

/** The shared ledger for a session. `memoryKey` identifies a session that has no artifacts directory. */
export function ledgerFor(artifactsDir: string | null, memoryKey: string): SpillLedger {
  const key = artifactsDir ?? `memory:${memoryKey}`;
  let ledger = ledgers.get(key);
  if (!ledger) {
    ledger = new SpillLedger(artifactsDir);
    ledgers.set(key, ledger);
  }
  return ledger;
}

/** What a gate needs to work with a session's spilled artifacts. */
export interface SpillAccess {
  sessionId: string;
  artifactsDir: string | null;
  ledger: SpillLedger;
  /** The whole content of an artifact. Rejects when it cannot be read. */
  readFull(ompArtifactId: string): Promise<string>;
  /** Replace an artifact's content with `notice`. Resolves false when that is not possible (an in-memory
   *  artifact, or a failed write); the ledger's `quarantined` record then carries the block on its own. */
  purge(ompArtifactId: string, notice: string): Promise<boolean>;
}

function method(obj: Record<string, unknown>, name: string): ((...args: unknown[]) => unknown) | null {
  const f = obj[name];
  return typeof f === "function" ? (...args: unknown[]) => f.apply(obj, args) : null;
}

/** Build SpillAccess from the context omp hands a `tool_result` handler (`ctx.sessionManager`). Structural,
 *  because omp's types are not exported to `-e` extensions. Null when the context has no session manager,
 *  which callers treat as "a spilled result cannot be verified". */
export function spillAccessFromContext(ctx: unknown): SpillAccess | null {
  if (!isRecord(ctx) || !isRecord(ctx.sessionManager)) return null;
  const sm = ctx.sessionManager;
  const getSessionId = method(sm, "getSessionId");
  const getArtifactsDir = method(sm, "getArtifactsDir");
  const getArtifactPath = method(sm, "getArtifactPath");
  const getArtifactContent = method(sm, "getArtifactContent"); // in-memory artifacts of a non-persistent session
  if (!getSessionId || !getArtifactsDir || !getArtifactPath) return null;
  let sessionId: unknown;
  let dir: unknown;
  try {
    sessionId = getSessionId();
    dir = getArtifactsDir();
  } catch {
    return null;
  }
  if (typeof sessionId !== "string" || sessionId === "") return null;
  const artifactsDir = typeof dir === "string" && dir !== "" ? dir : null;

  const pathOf = async (id: string): Promise<string | null> => {
    const p = await getArtifactPath(id);
    return typeof p === "string" && p !== "" ? p : null;
  };
  return {
    sessionId,
    artifactsDir,
    ledger: ledgerFor(artifactsDir, sessionId),
    async readFull(id) {
      const p = await pathOf(id);
      if (p !== null) return readFile(p, "utf8");
      const inMemory = getArtifactContent ? getArtifactContent(id) : null;
      if (typeof inMemory === "string") return inMemory;
      throw new Error(`artifact ${id} has no readable content`);
    },
    async purge(id, notice) {
      try {
        const p = await pathOf(id);
        if (p === null) return false;
        await writeFile(p, notice, "utf8");
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Which artifacts a tool call's input names. */
export interface ArtifactRefs {
  /** omp artifact ids named as `artifact://<n>` or as a file inside the artifacts directory. */
  ids: string[];
  /** True when the input names the artifacts directory itself, or a directory that contains it, so the
   *  call may read any artifact. */
  wholeDir: boolean;
}

function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 8) return;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out, depth + 1);
  else if (isRecord(value)) for (const v of Object.values(value)) collectStrings(v, out, depth + 1);
}

/** Both separator spellings of a path, so a Windows path written with forward slashes still matches. */
function spellings(p: string): string[] {
  const fwd = p.replaceAll("\\", "/");
  const back = p.replaceAll("/", "\\");
  return [...new Set([p, fwd, back])];
}

function stripTrailingSeps(p: string): string {
  return p.replace(/[\\/]+$/, "");
}

/** Find the artifacts a tool call's input refers to: `artifact://<n>` anywhere in any string, a path into
 *  the artifacts directory, the directory itself, or a string that is exactly one of its ancestors. A
 *  relative path or a shell variable that resolves into the directory is not seen; ADR-0578 names that
 *  limit and why the full scan at spill time, not this match, is the primary control. */
export function artifactRefs(input: unknown, artifactsDir: string | null): ArtifactRefs {
  const strings: string[] = [];
  collectStrings(input, strings);
  const ids: string[] = [];
  const push = (id: string) => {
    if (!ids.includes(id)) ids.push(id);
  };
  let wholeDir = false;
  const foldCase = sep === "\\"; // Windows paths compare case-insensitively
  const fold = (s: string) => (foldCase ? s.toLowerCase() : s);

  for (const s of strings) {
    for (const m of s.matchAll(/artifact:\/\/(\d+)/g)) push(m[1]!);
    if (artifactsDir === null) continue;
    const hay = fold(s);
    for (const dir of spellings(stripTrailingSeps(artifactsDir))) {
      const needle = fold(dir);
      let at = hay.indexOf(needle);
      while (at >= 0) {
        const rest = s.slice(at + needle.length);
        const file = /^[\\/](\d+)\.[^\\/\s"']*\.log\b/.exec(rest);
        if (file) push(file[1]!);
        else wholeDir = true;
        at = hay.indexOf(needle, at + needle.length);
      }
      // A string that is exactly an ancestor directory (a recursive search root, a directory read).
      const whole = fold(stripTrailingSeps(s.trim()));
      if (whole.length > 1 && (needle.startsWith(`${whole}/`) || needle.startsWith(`${whole}\\`))) wholeDir = true;
    }
  }
  return { ids, wholeDir };
}
