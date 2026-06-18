// harness/memory/db.ts
//
// DuckDB access via the Node binding (@duckdb/node-api), per DECISIONS.md
// ADR-0001. The schema is a FROZEN CONTRACT (invariant #10): it changes ONLY by
// adding numbered migration files under ./migrations — never by editing applied
// SQL in place. This runner tracks applied versions in `schema_migrations` and
// applies only the pending ones, in order.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

export type Row = Record<string, unknown>;
export type Params = unknown[] | Record<string, unknown>;

interface Migration {
  version: number;
  name: string;
  sql: string;
}

function loadMigrations(): Migration[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files.map((f) => {
    const m = /^(\d+)_(.+)\.sql$/.exec(f);
    if (!m) throw new Error(`bad migration filename: ${f} (expected NNNN_name.sql)`);
    return { version: Number(m[1]), name: m[2]!, sql: readFileSync(join(MIGRATIONS_DIR, f), "utf8") };
  });
}

/** Split a migration file into individual statements. Line comments are stripped
 *  FIRST so a semicolon inside a comment can't split a statement; our DDL has no
 *  string literals containing ';' or '--', so this is safe (ADR-0005). */
function splitStatements(sql: string): string[] {
  const withoutLineComments = sql.replace(/--[^\n]*/g, "");
  return withoutLineComments
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export class Db {
  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly conn: DuckDBConnection,
  ) {}

  /** Open (or create) the database at `path` and apply pending migrations. */
  static async open(path: string): Promise<Db> {
    const instance = await DuckDBInstance.create(path);
    const conn = await instance.connect();
    const db = new Db(instance, conn);
    await db.migrate();
    return db;
  }

  private async migrate(): Promise<void> {
    await this.conn.run(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version INTEGER PRIMARY KEY,
         name VARCHAR NOT NULL,
         applied_at TIMESTAMP NOT NULL
       )`,
    );
    const appliedRows = await this.all("SELECT version FROM schema_migrations");
    const applied = new Set(appliedRows.map((r) => Number(r.version)));

    for (const mig of loadMigrations()) {
      if (applied.has(mig.version)) continue;
      for (const stmt of splitStatements(mig.sql)) {
        await this.conn.run(stmt);
      }
      await this.conn.run("INSERT INTO schema_migrations VALUES ($1, $2, $3)", [
        mig.version,
        mig.name,
        new Date().toISOString(),
      ]);
    }
  }

  /** Applied migration versions, ascending. */
  async appliedVersions(): Promise<number[]> {
    const rows = await this.all("SELECT version FROM schema_migrations ORDER BY version");
    return rows.map((r) => Number(r.version));
  }

  async run(sql: string, params?: Params): Promise<void> {
    await (params === undefined ? this.conn.run(sql) : this.conn.run(sql, params as never));
  }

  async all(sql: string, params?: Params): Promise<Row[]> {
    const reader =
      params === undefined
        ? await this.conn.runAndReadAll(sql)
        : await this.conn.runAndReadAll(sql, params as never);
    return reader.getRowObjects() as Row[];
  }

  async get(sql: string, params?: Params): Promise<Row | undefined> {
    const rows = await this.all(sql, params);
    return rows[0];
  }

  close(): void {
    this.conn.closeSync();
    this.instance.closeSync();
  }
}
