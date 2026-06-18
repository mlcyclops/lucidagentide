# Security dashboards

The six PRD security views. Every cell is finding **metadata** — no raw content
is ever rendered here (the feed is built from sanitized derivatives via
`csvField`).

```js
const findings = FileAttachment("data/findings_overview.csv").csv({ typed: true });
const unicode = FileAttachment("data/unicode_analysis.csv").csv({ typed: true });
const approvals = FileAttachment("data/approval_queue.csv").csv({ typed: true });
const quarantine = FileAttachment("data/quarantine_review.csv").csv({ typed: true });
const promotion = FileAttachment("data/memory_promotion_risk.csv").csv({ typed: true });
const exports = FileAttachment("data/export_audit.csv").csv({ typed: true });
```

## 1. Findings overview

```js
Plot.plot({
  marginLeft: 160,
  color: { legend: true },
  marks: [Plot.barX(findings, { y: "finding_type", x: "n", fill: "severity", sort: { y: "x", reverse: true } })],
})
```

```js
Inputs.table(findings)
```

## 2. Unicode analysis (by source)

```js
Plot.plot({
  marginLeft: 120,
  color: { legend: true },
  marks: [Plot.cell(unicode, { x: "finding_type", y: "source", fill: "n" }), Plot.text(unicode, { x: "finding_type", y: "source", text: "n" })],
})
```

## 3. Approval queue (blocked, awaiting review)

```js
Inputs.table(approvals)
```

## 4. Quarantine review (isolated artifacts)

```js
Inputs.table(quarantine)
```

## 5. Memory promotion risk

```js
Plot.plot({
  marginLeft: 90,
  marks: [Plot.barX(promotion, { y: "outcome", x: "n", fill: "outcome" })],
})
```

## 6. Export audit

```js
Inputs.table(exports, { columns: ["export_type", "sanitization_status", "included_raw", "reviewer", "payload_sha256", "created_at"] })
```
