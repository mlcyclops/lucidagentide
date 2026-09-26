// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/trainer/store.ts - P-TRAINER.2 (ADR-0253): the trainer tables over kb_graph.duckdb.
//
// Same database file and migration set as the compiled KB (KbGraphStore), so a firm's extracted
// process knowledge lives inside its per-KG kb_graph.duckdb and rides the existing registry and
// .lkgpack machinery. APPEND-ONLY knowledge: corrections mint a successor via supersedeUnit() and
// never edit in place; rejections tombstone via the teachback id. Coverage is DERIVED (coverage.ts),
// never stored.

import { Snowflake } from "@oh-my-pi/pi-utils";
import type { TrustLabel } from "../contracts.ts";
import { Db } from "../memory/db.ts";
import { KB_MIGRATIONS_DIR } from "../kb/store.ts";
import {
  type CoverageObjective,
  type Elicitation,
  type TeachbackVerdict,
  type UnitForCoverage,
  type UnitKind,
  isUnitKind,
} from "./coverage.ts";

export interface KnowledgeUnitRow {
  unit_id: string;
  objective_id: string;
  kind: UnitKind;
  title: string;
  body_md: string;
  structure: string; // JSON
  trust_label: TrustLabel;
  completeness: number;
  source_session_id: string | null;
  source_artifact_id: string | null;
  confirmed_at: string | null;
  confirmed_by: string | null;
  superseded_by: string | null;
}

export interface AddUnitInput {
  objectiveId: string;
  kind: UnitKind;
  title: string;
  bodyMd: string;
  structure: unknown; // serialized to JSON here
  trustLabel: TrustLabel;
  completeness: number;
  sourceSessionId?: string;
  sourceArtifactId?: string;
}

function defaultElicitation(): Elicitation {
  return { scenarios: [], probes: [], edgeProbes: [] };
}

function parseElicitation(raw: unknown): Elicitation {
  try {
    const v = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
    if (!v || typeof v !== "object") return defaultElicitation();
    const o = v as Record<string, unknown>;
    const arr = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
    return { scenarios: arr(o.scenarios), probes: arr(o.probes), edgeProbes: arr(o.edgeProbes) };
  } catch {
    return defaultElicitation();
  }
}

export class TrainerStore {
  private constructor(private readonly db: Db) {}

  /** Open (or create) kb_graph.duckdb at `path`, applying the kb migration set (0011 + 0012). */
  static async open(path: string): Promise<TrainerStore> {
    return new TrainerStore(await Db.open(path, KB_MIGRATIONS_DIR));
  }

  close(): void {
    this.db.close();
  }

  // ── coverage map ──────────────────────────────────────────────────────────

  /** Install a pack's coverage objectives. Existing ids are left untouched (stable ids, invariant
   *  #9): installing a pack twice, or a newer pack over an older one, never re-mints or rewrites an
   *  objective the interview history already references. */
  async addObjectives(objectives: readonly CoverageObjective[]): Promise<number> {
    let added = 0;
    for (const o of objectives) {
      const existing = await this.db.get("SELECT 1 AS ok FROM coverage_objectives WHERE objective_id=$1", [o.objectiveId]);
      if (existing) continue;
      await this.db.run(
        "INSERT INTO coverage_objectives VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [o.objectiveId, o.packId, o.domain, o.title, o.description, o.weight, JSON.stringify(o.elicitation), new Date().toISOString()],
      );
      added++;
    }
    return added;
  }

  async listObjectives(packId?: string): Promise<CoverageObjective[]> {
    const rows = packId
      ? await this.db.all("SELECT * FROM coverage_objectives WHERE pack_id=$1 ORDER BY objective_id", [packId])
      : await this.db.all("SELECT * FROM coverage_objectives ORDER BY objective_id");
    return rows.map((r) => ({
      objectiveId: String(r.objective_id),
      packId: String(r.pack_id),
      domain: String(r.domain),
      title: String(r.title),
      description: String(r.description),
      weight: Number(r.weight),
      elicitation: parseElicitation(r.elicitation),
    }));
  }

  // ── knowledge units (append-only) ─────────────────────────────────────────

  async addUnit(u: AddUnitInput): Promise<string> {
    if (!isUnitKind(u.kind)) throw new Error(`unknown unit kind: ${String(u.kind)}`);
    const unitId = Snowflake.next();
    await this.db.run(
      `INSERT INTO knowledge_units
         (unit_id, objective_id, kind, title, body_md, structure, trust_label, completeness,
          source_session_id, source_artifact_id, confirmed_at, confirmed_by, superseded_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,NULL,NULL,$11)`,
      [
        unitId,
        u.objectiveId,
        u.kind,
        u.title,
        u.bodyMd,
        JSON.stringify(u.structure ?? null),
        u.trustLabel,
        Math.max(0, Math.min(100, Math.round(u.completeness))),
        u.sourceSessionId ?? null,
        u.sourceArtifactId ?? null,
        new Date().toISOString(),
      ],
    );
    return unitId;
  }

  async getUnit(unitId: string): Promise<KnowledgeUnitRow | undefined> {
    const r = await this.db.get("SELECT * FROM knowledge_units WHERE unit_id=$1", [unitId]);
    return r as KnowledgeUnitRow | undefined;
  }

  /** Mint a successor for a corrected unit and tombstone the old row (append-only, ADR-0253).
   *  The successor starts UNCONFIRMED and untrusted-labeled from its own input: a correction is new
   *  knowledge and re-earns its confirmation. */
  async supersedeUnit(oldUnitId: string, replacement: AddUnitInput): Promise<string> {
    const old = await this.getUnit(oldUnitId);
    if (!old) throw new Error(`supersedeUnit: unknown unit ${oldUnitId}`);
    if (old.superseded_by) throw new Error(`supersedeUnit: ${oldUnitId} is already superseded`);
    const successor = await this.addUnit(replacement);
    await this.db.run("UPDATE knowledge_units SET superseded_by=$2 WHERE unit_id=$1", [oldUnitId, successor]);
    return successor;
  }

  /** Tombstone a rejected unit with the teachback id (no successor). */
  async tombstoneUnit(unitId: string, teachbackId: string): Promise<void> {
    await this.db.run("UPDATE knowledge_units SET superseded_by=$2 WHERE unit_id=$1 AND superseded_by IS NULL", [unitId, teachbackId]);
  }

  async confirmUnit(unitId: string, confirmedBy: string): Promise<void> {
    await this.db.run("UPDATE knowledge_units SET confirmed_at=$2, confirmed_by=$3 WHERE unit_id=$1", [
      unitId,
      new Date().toISOString(),
      confirmedBy,
    ]);
  }

  /** Live (non-superseded) units for an objective, oldest first. */
  async listLiveUnits(objectiveId: string): Promise<KnowledgeUnitRow[]> {
    const rows = await this.db.all(
      "SELECT * FROM knowledge_units WHERE objective_id=$1 AND superseded_by IS NULL ORDER BY created_at",
      [objectiveId],
    );
    return rows as unknown as KnowledgeUnitRow[];
  }

  /** Confirmed + live units across a pack - the ONLY inventory export and quiz generation may use. */
  async listConfirmedUnits(packId: string): Promise<KnowledgeUnitRow[]> {
    const rows = await this.db.all(
      `SELECT u.* FROM knowledge_units u
       JOIN coverage_objectives o ON o.objective_id = u.objective_id
       WHERE o.pack_id=$1 AND u.superseded_by IS NULL AND u.confirmed_at IS NOT NULL
       ORDER BY u.created_at`,
      [packId],
    );
    return rows as unknown as KnowledgeUnitRow[];
  }

  /** The rubric's view of an objective (coverage.ts input). */
  async unitsForCoverage(objectiveId: string): Promise<UnitForCoverage[]> {
    const rows = await this.listLiveUnits(objectiveId);
    return rows.map((r) => ({ kind: r.kind, completeness: Number(r.completeness), confirmed: r.confirmed_at != null }));
  }

  async coverageInputs(packId: string): Promise<Map<string, UnitForCoverage[]>> {
    const out = new Map<string, UnitForCoverage[]>();
    for (const o of await this.listObjectives(packId)) out.set(o.objectiveId, await this.unitsForCoverage(o.objectiveId));
    return out;
  }

  // ── sessions + teach-back trail ───────────────────────────────────────────

  async startSession(packId: string, expertLabel: string): Promise<string> {
    const sessionId = Snowflake.next();
    await this.db.run("INSERT INTO extraction_sessions VALUES ($1,$2,$3,$4,NULL,NULL)", [
      sessionId,
      packId,
      expertLabel,
      new Date().toISOString(),
    ]);
    return sessionId;
  }

  async endSession(sessionId: string, stats: unknown): Promise<void> {
    await this.db.run("UPDATE extraction_sessions SET ended_at=$2, stats=$3 WHERE session_id=$1", [
      sessionId,
      new Date().toISOString(),
      JSON.stringify(stats ?? null),
    ]);
  }

  async addTeachback(t: { unitId: string; verdict: TeachbackVerdict; notes?: string; approvalEventId?: string }): Promise<string> {
    const teachbackId = Snowflake.next();
    await this.db.run("INSERT INTO teachback_results VALUES ($1,$2,$3,$4,$5,$6)", [
      teachbackId,
      t.unitId,
      t.verdict,
      t.notes ?? null,
      t.approvalEventId ?? null,
      new Date().toISOString(),
    ]);
    return teachbackId;
  }
}
