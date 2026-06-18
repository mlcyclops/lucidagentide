# Observable dashboards

Local-first security + operational dashboards over the harness's DuckDB data.

## Flow

```
agent_obs.duckdb  --(harness/dashboards/materialize.ts)-->  docs/data/*.csv  --(Observable Framework)-->  pages
```

The harness owns the DuckDB → CSV step (metadata only — no raw content reaches
this layer; cells pass through the safe-export `csvField`). Observable Framework
renders the CSVs.

## Generate the data

```bash
# materialize the six security views + operational views into docs/data/*.csv
make dashboards                 # -> bun run harness/scripts/materialize_dashboards.ts <db> observable/docs/data
```

`docs/data/` is generated and git-ignored.

## Run the dashboards

Observable Framework is not a harness dependency (keeps the Bun install lean).
Run it on demand:

```bash
cd observable
npx @observablehq/framework@latest dev      # or `preview`
```

## Pages

- `docs/index.md` — operational overview (active runs, status).
- `docs/security.md` — the six PRD security views: findings overview, Unicode
  analysis, approval queue, quarantine review, memory-promotion risk, export audit.
