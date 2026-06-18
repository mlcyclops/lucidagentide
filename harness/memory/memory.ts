// harness/memory/memory.ts
//
// Memory-layer operations (P4.1): working state, archive (raw spans), and
// semantic facts. Every semantic promotion carries provenance (source artifact
// + archived raw span) and a trust label — the metadata the P4.3 promotion gate
// enforces. P4.1 provides the raw writes; the suspicious-source GATE is P4.3.

import { createHash } from "node:crypto";
import { Snowflake } from "@oh-my-pi/pi-utils";
import type { TrustLabel } from "../contracts.ts";
import type { Db, Row } from "./db.ts";

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

// ── working memory ──────────────────────────────────────────────────────────
export interface WorkingStateInput {
  goal?: string;
  nextStep?: string;
  blockers?: string;
  trustLabel?: TrustLabel;
}

export async function upsertWorkingState(db: Db, runId: string, s: WorkingStateInput): Promise<void> {
  await db.run(
    `INSERT INTO working_state (run_id, goal, next_step, blockers, trust_label, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (run_id) DO UPDATE SET
       goal = excluded.goal,
       next_step = excluded.next_step,
       blockers = excluded.blockers,
       trust_label = excluded.trust_label,
       updated_at = excluded.updated_at`,
    [runId, s.goal ?? null, s.nextStep ?? null, s.blockers ?? null, s.trustLabel ?? "trusted", new Date().toISOString()],
  );
}

export async function getWorkingState(db: Db, runId: string): Promise<Row | undefined> {
  return db.get("SELECT * FROM working_state WHERE run_id=$1", [runId]);
}

// ── archive (raw source-of-truth) ───────────────────────────────────────────
export interface ArchiveChunkInput {
  runId?: string;
  artifactId?: string;
  content: string;
}

export async function archiveChunk(db: Db, input: ArchiveChunkInput): Promise<string> {
  const chunkId = Snowflake.next();
  await db.run(
    `INSERT INTO archive_chunks (chunk_id, run_id, artifact_id, content, content_sha256, created_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [chunkId, input.runId ?? null, input.artifactId ?? null, input.content, sha256(input.content), new Date().toISOString()],
  );
  return chunkId;
}

export async function getArchiveChunk(db: Db, chunkId: string): Promise<Row | undefined> {
  return db.get("SELECT * FROM archive_chunks WHERE chunk_id=$1", [chunkId]);
}

// ── semantic memory ─────────────────────────────────────────────────────────
export interface PromoteFactInput {
  entityName: string;
  entityKind?: string;
  statement: string;
  trustLabel: TrustLabel;
  sourceArtifactId?: string;
  sourceArchiveChunkId?: string;
}

/** Upsert the entity by name (returns its id), creating it on first use. */
async function ensureEntity(db: Db, name: string, kind: string | undefined, trust: TrustLabel): Promise<string> {
  const existing = await db.get("SELECT entity_id FROM semantic_entities WHERE name=$1", [name]);
  if (existing) return String(existing.entity_id);
  const entityId = Snowflake.next();
  await db.run(
    `INSERT INTO semantic_entities (entity_id, name, kind, trust_label, created_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [entityId, name, kind ?? null, trust, new Date().toISOString()],
  );
  return entityId;
}

/**
 * Promote a fact into semantic memory with full provenance + trust. P4.1 = raw
 * write (no gating); the suspicious-source promotion gate is P4.3.
 */
export async function promoteFact(db: Db, input: PromoteFactInput): Promise<{ factId: string; entityId: string }> {
  const entityId = await ensureEntity(db, input.entityName, input.entityKind, input.trustLabel);
  const factId = Snowflake.next();
  await db.run(
    `INSERT INTO semantic_facts
       (fact_id, entity_id, statement, source_artifact_id, source_archive_chunk_id, trust_label, promoted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      factId,
      entityId,
      input.statement,
      input.sourceArtifactId ?? null,
      input.sourceArchiveChunkId ?? null,
      input.trustLabel,
      new Date().toISOString(),
    ],
  );
  return { factId, entityId };
}

export async function getFacts(db: Db, entityName?: string): Promise<Row[]> {
  return entityName === undefined
    ? db.all("SELECT f.* FROM semantic_facts f ORDER BY f.promoted_at")
    : db.all(
        `SELECT f.* FROM semantic_facts f
         JOIN semantic_entities e ON e.entity_id = f.entity_id
         WHERE e.name = $1 ORDER BY f.promoted_at`,
        [entityName],
      );
}
