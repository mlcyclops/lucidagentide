// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/fleet_extension.ts - P-FLEET.L1: register an agent-callable `fleet_status` tool so the
// MASTER agent's model can see the local LUCID fleet lanes (the headless mini engine sessions running
// on this machine) without leaving chat.
//
// HOW IT REACHES THE ENGINE: same mechanism as preview_screenshot / preview_inspect / knowledge_search.
// This runs in omp's SUBPROCESS, which inherits a ready token'd URL via the LUCID_FLEET_STATUS_URL env
// var the desktop sets before spawn (dev.ts convention, cf. LUCID_PREVIEW_SHOT_URL at dev.ts:2788):
//   http://127.0.0.1:<port>/api/fleet/status?t=<TOKEN>
// The tool just GETs it and formats the result. Metadata only - lane replies stream to the user in the
// fleet dashboard, never through this tool.
//
// Defensively wrapped: a registration failure NEVER breaks omp launch - worst case the tool is absent
// and the user still sees every lane in the fleet dashboard.

// omp's plugin API is a library boundary whose type isn't exported to us; type the minimal surface we use.
interface TypeBoxType {
  Object: (props: Record<string, unknown>) => unknown;
  String: (opts?: { description?: string }) => unknown;
  Array: (items: unknown, opts?: { description?: string }) => unknown;
  Optional: (schema: unknown) => unknown;
}
interface ToolResultShape {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}
interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  approval: string;
  parameters: unknown;
  execute: (toolCallId: string, params: unknown) => Promise<ToolResultShape>;
}
interface OmpPluginApi {
  registerTool?: (def: ToolDefinition) => void;
  typebox?: { Type?: TypeBoxType };
}

/** One lane row, already validated + derived from the untrusted endpoint payload. */
interface LaneRow {
  id: string;
  name: string;
  cwd: string;
  model: string;
  status: string;
  turns: number;
  idleSeconds: number;
  pending: string | null;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Narrow an unknown payload's property without asserting a shape (ts-no-inline-cast-access). */
function prop(v: unknown, key: string): unknown {
  if (!v || typeof v !== "object" || !(key in v)) return undefined;
  return Reflect.get(v, key); // runtime-checked above; cast-free dynamic-key read
}

/** Validate one raw lane object into a display row; null when it isn't lane-shaped. */
function laneRow(raw: unknown, now: number): LaneRow | null {
  const id = str(prop(raw, "id"));
  if (!id) return null;
  const last = num(prop(raw, "lastActivityAt"));
  const pendingSummary = str(prop(prop(raw, "pendingApproval"), "summary")).trim();
  return {
    id,
    name: str(prop(raw, "name")) || id,
    cwd: str(prop(raw, "cwd")),
    model: str(prop(raw, "model")),
    status: str(prop(raw, "status")) || "starting",
    turns: num(prop(raw, "turns")),
    idleSeconds: last > 0 ? Math.max(0, Math.round((now - last) / 1000)) : 0,
    pending: pendingSummary ? pendingSummary.slice(0, 200) : null,
  };
}

/** Human phrase per lane status, in summary-line display order. */
const STATUS_PHRASE: ReadonlyArray<readonly [string, string]> = [
  ["working", "working"],
  ["needs-approval", "needs approval"],
  ["awaiting-input", "awaiting input"],
  ["starting", "starting"],
  ["done", "done"],
  ["error", "error"],
  ["stopped", "stopped"],
];

/** '3 lanes: 2 working, 1 needs approval' */
export function fleetSummaryLine(rows: ReadonlyArray<Pick<LaneRow, "status">>): string {
  const parts: string[] = [];
  for (const [status, phrase] of STATUS_PHRASE) {
    const n = rows.filter((r) => r.status === status).length;
    if (n > 0) parts.push(`${n} ${phrase}`);
  }
  const unknown = rows.filter((r) => !STATUS_PHRASE.some(([s]) => s === r.status)).length;
  if (unknown > 0) parts.push(`${unknown} unknown`);
  return `${rows.length} lane${rows.length === 1 ? "" : "s"}: ${parts.join(", ") || "none"}`;
}

/** Compact aligned text table of the lanes; pending approvals as an indented follow-up line. */
export function fleetTable(rows: ReadonlyArray<LaneRow>): string {
  const header = ["ID", "NAME", "STATUS", "MODEL", "TURNS", "IDLE", "CWD"];
  const cells = rows.map((r) => [r.id, r.name, r.status, r.model, String(r.turns), `${r.idleSeconds}s`, r.cwd]);
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => (c[i] ?? "").length)));
  const line = (c: string[]) => c.map((v, i) => v.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  const out = [line(header)];
  rows.forEach((r, i) => {
    out.push(line(cells[i] ?? []));
    if (r.pending) out.push(`    pending approval: ${r.pending}`);
  });
  return out.join("\n");
}

/** 'resources: cpu 34%, mem 51% (lanes unlimited; refused only above 90% held 30s); master model: gpt-5'
 *  When a metric IS currently over the line, the line says how long it has held, because that duration is
 *  the whole verdict: 8s is a burst, 34s is a refusal. */
export function fleetResourcesLine(resources: unknown, masterModel: string): string {
  const cpu = Math.round(num(prop(resources, "cpuPct")));
  const mem = Math.round(num(prop(resources, "memPct")));
  const line = Math.round(num(prop(resources, "pressurePct")));
  const sustainS = Math.round(num(prop(resources, "sustainMs")) / 1000);
  const hot = (label: string, ms: number): string => (ms > 0 ? `; ${label} has held the line ${Math.round(ms / 1000)}s of ${sustainS}s` : "");
  const pressure =
    hot("cpu", num(prop(resources, "cpuHotMs"))) + hot("mem", num(prop(resources, "memHotMs")));
  const master = masterModel ? `; master model: ${masterModel}` : "";
  return `resources: cpu ${cpu}%, mem ${mem}% (lanes unlimited; a lane is refused only above ${line}% held ${sustainS}s)${pressure}${master}`;
}

export default function fleetExtension(piRaw: unknown): void {
  try {
    // Assert the minimal omp plugin shape (unexpressible library type; narrowed by the guards below).
    const pi = piRaw as OmpPluginApi;
    if (typeof pi?.registerTool !== "function") return;
    const T = pi.typebox?.Type;
    if (!T) return;
    pi.registerTool({
      name: "fleet_status",
      label: "Fleet lane status",
      description:
        "Status of the local LUCID fleet lanes (the mini agent sessions running on this machine). Returns " +
        "per-lane metadata: id, name, working directory, model, status " +
        "(starting|working|needs-approval|awaiting-input|done|error|stopped), turns completed, seconds since " +
        "last activity, and any pending approval summary. Metadata only - lane replies are shown to the user " +
        "in the fleet dashboard, not here.",
      approval: "read", // metadata-only lookup; never trips the exec gate (same tier as preview_inspect)
      parameters: T.Object({
        ids: T.Optional(T.Array(T.String({ description: "A lane id" }), { description: "Optional lane id filter; omit for all lanes" })),
      }),
      async execute(_toolCallId: string, params: unknown): Promise<ToolResultShape> {
        const unavailable = (why: string): ToolResultShape => ({
          content: [{ type: "text", text: `fleet status unavailable: ${why}` }],
          isError: true,
        });
        const url = process.env.LUCID_FLEET_STATUS_URL;
        if (!url) return unavailable("the LUCID desktop engine isn't running (no LUCID_FLEET_STATUS_URL).");
        let body: unknown;
        try {
          const r = await fetch(url, { signal: AbortSignal.timeout(5_000) });
          if (!r.ok) return unavailable(`the engine responded ${r.status}.`);
          body = await r.json().catch(() => null);
        } catch (e) {
          const msg = e && typeof e === "object" && "message" in e ? String(e.message) : String(e);
          return unavailable(msg || "the engine could not be reached.");
        }
        // The dev server wraps responses as { ok, data: {...} }; tolerate a bare body too (preview pattern).
        const view = prop(body, "data") ?? body;
        const rawLanes = prop(view, "lanes");
        if (!Array.isArray(rawLanes)) return unavailable("malformed response from the engine.");
        const now = Date.now();
        let rows = rawLanes.map((l) => laneRow(l, now)).filter((r): r is LaneRow => r !== null);
        let idFilter: string[] = [];
        if (params && typeof params === "object" && "ids" in params) {
          const v = params.ids; // unknown after `in` narrowing - validate before use
          if (Array.isArray(v)) idFilter = v.filter((x): x is string => typeof x === "string");
        }
        if (idFilter.length > 0) rows = rows.filter((r) => idFilter.includes(r.id));
        const resourcesLine = fleetResourcesLine(prop(view, "resources"), str(prop(view, "masterModel")));
        if (rows.length === 0) {
          const scope = idFilter.length > 0 ? `No fleet lanes match ids [${idFilter.join(", ")}].` : "No fleet lanes are running.";
          return { content: [{ type: "text", text: `${scope}\n${resourcesLine}` }] };
        }
        return { content: [{ type: "text", text: `${fleetSummaryLine(rows)}\n${resourcesLine}\n\n${fleetTable(rows)}` }] };
      },
    });
  } catch (e) {
    // Never break omp launch: skip the tool if registration throws (e.g. a schema-format mismatch on this
    // omp version). The gate, chat, and the fleet dashboard all keep working.
    try {
      const msg = e && typeof e === "object" && "message" in e ? String(e.message) : String(e);
      process.stderr.write(`\n[LucidAgentIDE] fleet_status tool not registered: ${msg}\n`);
    } catch {
      /* ignore */
    }
  }
}
