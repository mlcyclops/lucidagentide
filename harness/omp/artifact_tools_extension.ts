// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/artifact_tools_extension.ts - P-CAP.1a (ADR-0589): register artifact_find, artifact_lookup,
// artifact_count and artifact_slice, the code primitives over a stored tool result
// (../tools/artifact_primitives.ts).
//
// WHAT THIS FILE ADDS TO THE PURE PRIMITIVES
//   - the artifact: read through the session omp hands the tool (`ctx.sessionManager`), the same way the
//     result gate reads it. An id this session does not have is an ERROR, never an empty success.
//   - provenance: the ledger of ADR-0578 says which tool wrote the artifact and its trust label. A
//     QUARANTINED artifact is refused before a byte of it is read. Every result opens with the source and
//     the label, so the model always knows whose words it is reading.
//
// THE ENVELOPE IS NOT ADDED HERE. A handle must be written `artifact://<n>`, and that string in a local
// tool's input is exactly what the re-entry gate (artifact_reentry.ts, in the tool_result chain) looks for:
// when the artifact came from an external source, the gate scans this tool's output, wraps it in the
// untrusted envelope and gives it the worse of the artifact's label and the scan's. The primitives cannot
// be used to read an external artifact around that gate, and a test holds the two together.
//
// Read tier: the tools only read what the session already stored. Defensively wrapped: a registration
// failure never breaks omp launch; worst case the tools are absent and the model pages with `read`.

import { PRIM_LIMITS, parseHandle, primHeader, runPrim, type PrimName } from "../tools/artifact_primitives.ts";
import { PURGED_NOTICE, spillAccessFromContext, type SpillAccess } from "../security/spill_provenance.ts";

export interface ToolText { content: { type: "text"; text: string }[]; isError?: boolean }

const fail = (name: string, why: string): ToolText => ({ content: [{ type: "text", text: `${name}: ${why}` }], isError: true });

/** Run one primitive for a tool call. Exported so the whole path is tested without an omp session. */
export async function executeArtifactTool(name: PrimName, params: unknown, access: SpillAccess | null): Promise<ToolText> {
  const p = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
  if (access === null) return fail(name, "this session has no stored tool results to work on.");
  const id = parseHandle(p.artifact);
  if (id === null) return fail(name, 'artifact must be written as "artifact://<number>", the handle a long tool result names in its note.');

  const known = access.ledger.lookup(id);
  if (known.state === "known" && (known.record.trust_label === "quarantined" || known.record.purged)) {
    return fail(name, `artifact://${id} holds a tool result LUCID quarantined. It cannot be read or searched.`);
  }
  let text: string;
  try { text = await access.readFull(id); } catch { return fail(name, `artifact://${id} does not exist in this session. Use the handle a tool result names in its note.`); }
  if (text === PURGED_NOTICE) return fail(name, `artifact://${id} holds a tool result LUCID quarantined. It cannot be read or searched.`);

  const source = known.state === "known" ? known.record.source : known.state === "unreadable" ? "unknown (the provenance ledger could not be read)" : "a local tool";
  const trust = known.state === "known" ? known.record.trust_label : known.state === "unreadable" ? "untrusted" : "not labeled (a local tool wrote it)";
  let result;
  try { result = runPrim(name, text, p); } catch (e) { return fail(name, `it could not run: ${String((e as { message?: unknown })?.message ?? e).slice(0, 160)}`); }
  if (!result.ok) return fail(name, `${result.error}.`);
  return { content: [{ type: "text", text: `${primHeader(id, text, source, trust)}\n${result.text}` }] };
}

const HANDLE = 'The stored result, written exactly as "artifact://<number>" (the handle named in a long tool result\'s note).';

/** The four tool definitions, built with omp's TypeBox (`pi.typebox.Type`). */
export function artifactTools(T: any): { name: PrimName; label: string; description: string; approval: "read"; parameters: unknown; execute(id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown): Promise<ToolText> }[] {
  const run = (name: PrimName) => async (_id: string, params: unknown, _signal: unknown, _onUpdate: unknown, ctx: unknown): Promise<ToolText> => executeArtifactTool(name, params, spillAccessFromContext(ctx));
  return [
    {
      name: "artifact_find",
      label: "Find in a stored result",
      description:
        "Search a long tool result that was stored as an artifact, WITHOUT reading it into your context. Returns the matching lines with their line numbers. " +
        "Use this instead of paging through the artifact with read. The pattern is literal text unless regex is true. " +
        `At most ${PRIM_LIMITS.matches} matches a call; use offset for more. It says NOT FOUND when nothing matches.`,
      approval: "read",
      parameters: T.Object({
        artifact: T.String({ description: HANDLE }),
        pattern: T.String({ description: "Text to find on a line. Literal unless regex is true." }),
        regex: T.Optional(T.Boolean({ description: "Treat the pattern as a regular expression." })),
        ignoreCase: T.Optional(T.Boolean({ description: "Match upper and lower case alike." })),
        context: T.Optional(T.Number({ description: `Lines to show before and after each match, 0 to ${PRIM_LIMITS.context}.` })),
        limit: T.Optional(T.Number({ description: `Matches to show, 1 to ${PRIM_LIMITS.matches}.` })),
        offset: T.Optional(T.Number({ description: "Matches to skip, for the next page." })),
      }),
      execute: run("artifact_find"),
    },
    {
      name: "artifact_lookup",
      label: "Look up keys in a stored result",
      description:
        "Look up one or several exact keys (an id, a name, a code) in a stored tool result in ONE pass, without reading it into your context. " +
        "A key matches only as a whole token, so alpha-7 does not match alpha-77. Returns each key's records with their line numbers, and says NOT FOUND for a key that is absent. " +
        `Up to ${PRIM_LIMITS.keys} keys a call.`,
      approval: "read",
      parameters: T.Object({
        artifact: T.String({ description: HANDLE }),
        keys: T.Array(T.String(), { description: "The exact keys to look up." }),
      }),
      execute: run("artifact_lookup"),
    },
    {
      name: "artifact_count",
      label: "Count in a stored result",
      description:
        "Count how many times a pattern occurs in a stored tool result and on how many lines, without reading it into your context. " +
        "With distinct true it lists the values that matched (the first capture group of a regex, else the whole match), most frequent first. Never count by reading.",
      approval: "read",
      parameters: T.Object({
        artifact: T.String({ description: HANDLE }),
        pattern: T.String({ description: "Text to count. Literal unless regex is true." }),
        regex: T.Optional(T.Boolean({ description: "Treat the pattern as a regular expression." })),
        ignoreCase: T.Optional(T.Boolean({ description: "Match upper and lower case alike." })),
        distinct: T.Optional(T.Boolean({ description: "Also list the distinct values that matched, with how often each occurs." })),
      }),
      execute: run("artifact_count"),
    },
    {
      name: "artifact_slice",
      label: "Read lines of a stored result",
      description:
        "Return an exact range of lines from a stored tool result, each with its line number. Use it to read the records around a line that artifact_find or artifact_lookup returned. " +
        `At most ${PRIM_LIMITS.slice} lines a call.`,
      approval: "read",
      parameters: T.Object({
        artifact: T.String({ description: HANDLE }),
        from: T.Number({ description: "The first line to return, counting from 1." }),
        to: T.Optional(T.Number({ description: "The last line to return. Defaults to 40 lines from the first." })),
      }),
      execute: run("artifact_slice"),
    },
  ];
}

export default function artifactToolsExtension(pi: any): void {
  try {
    if (!pi || typeof pi.registerTool !== "function") return;
    const T = pi.typebox?.Type;
    if (!T) return;
    for (const tool of artifactTools(T)) pi.registerTool(tool);
  } catch (e) {
    try { process.stderr.write(`\n[LucidAgentIDE] artifact tools not registered: ${String((e as { message?: unknown })?.message ?? e)}\n`); } catch { /* ignore */ }
  }
}
