// harness/dashboards/materialize.ts
//
// Materialize the dashboard views to DuckDB-exported CSVs that Observable
// Framework reads (P7.1). Cells go through csvField (from the safe-export layer),
// so the dashboard feed can never carry an invisible/control char or break the
// row grid — even though the views already select metadata only.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db, Row } from "../memory/db.ts";
import { csvField } from "../export/safe_export.ts";
import { DASHBOARD_VIEWS } from "./views.ts";

function cell(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") {
    const s = String(v);
    return s === "[object Object]" ? JSON.stringify(v) : s;
  }
  return String(v);
}

/** Render rows as safe CSV (header from the first row's keys). */
export function rowsToCsv(rows: Row[]): string {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]!);
  const header = cols.map(csvField).join(",");
  const body = rows.map((r) => cols.map((c) => csvField(cell(r[c]))).join(","));
  return [header, ...body].join("\n");
}

export interface MaterializedFile {
  name: string;
  rows: number;
  path: string;
}
export interface MaterializeResult {
  outDir: string;
  files: MaterializedFile[];
}

/** Run every dashboard view and write `<name>.csv` into `outDir`. */
export async function materializeDashboards(db: Db, outDir: string): Promise<MaterializeResult> {
  mkdirSync(outDir, { recursive: true });
  const files: MaterializedFile[] = [];
  for (const [name, view] of Object.entries(DASHBOARD_VIEWS)) {
    const rows = await view(db);
    const path = join(outDir, `${name}.csv`);
    writeFileSync(path, rowsToCsv(rows), "utf8");
    files.push({ name, rows: rows.length, path });
  }
  return { outDir, files };
}
