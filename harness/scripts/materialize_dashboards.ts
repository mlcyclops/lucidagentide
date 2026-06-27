// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/materialize_dashboards.ts
//
// CLI: materialize the dashboard views from a DuckDB file into an output dir.
//   bun run harness/scripts/materialize_dashboards.ts <db.duckdb> <outDir>
// Default outDir is observable/docs/data.

import { Db } from "../memory/db.ts";
import { materializeDashboards } from "../dashboards/materialize.ts";

const dbPath = process.argv[2];
const outDir = process.argv[3] ?? "observable/docs/data";
if (!dbPath) {
  console.error("usage: materialize_dashboards <db.duckdb> [outDir]");
  process.exit(1);
}

const db = await Db.open(dbPath);
try {
  const result = await materializeDashboards(db, outDir);
  for (const f of result.files) console.log(`${f.name.padEnd(22)} ${f.rows} rows -> ${f.path}`);
  console.log(`materialized ${result.files.length} views into ${result.outDir}`);
} finally {
  db.close();
}
process.exit(0);
