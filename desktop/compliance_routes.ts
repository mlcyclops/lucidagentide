// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/compliance_routes.ts
//
// P-COMPLY.1 (ADR-0479): GET /api/compliance/report, the Contract D ComplianceReport for this host.
// UI token only: the path is in neither QUERY_TOKEN_ROUTES nor AGENT_ROUTES in dev.ts, so an omp child
// cannot read the host posture. Read-only; the report carries no secret value (compliance_report.ts).

import { complianceReport } from "./compliance_report.ts";

/** Handle the compliance routes; null when `p` is not one of them (dev.ts falls through). */
export async function handleComplianceRoutes(req: Request, p: string): Promise<Response | null> {
  if (p !== "/api/compliance/report") return null;
  if (req.method !== "GET") return new Response("method not allowed", { status: 405, headers: { allow: "GET" } });
  const report = await complianceReport();
  return new Response(JSON.stringify({ ok: true, data: report }), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
