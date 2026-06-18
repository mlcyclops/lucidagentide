# Operational overview

Live run inventory and sandbox posture. Data is materialized from DuckDB by
`make dashboards` (metadata only — no raw content reaches this layer).

```js
const activeRuns = FileAttachment("data/active_runs.csv").csv({ typed: true });
```

## Active runs

```js
Inputs.table(activeRuns, {
  columns: ["run_id", "parent_run_id", "kind", "mode", "sandbox_profile", "status"],
})
```

## Runs by status

```js
Plot.plot({
  marginLeft: 90,
  x: { label: "runs" },
  y: { label: null },
  marks: [Plot.barX(activeRuns, Plot.groupY({ x: "count" }, { y: "status", sort: { y: "x", reverse: true } }))],
})
```
