// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/interject_extension.ts - P-INTERJECT.1: deliver mid-turn operator interjections.
//
// The user can type a note in LUCID while the agent is mid-turn. The desktop holds those notes in
// desktop/interject_store.ts; this extension is the delivery leg inside the omp child: on EVERY
// tool_result it does ONE loopback GET to the dev server's drain endpoint (250ms budget) and, when
// notes are pending, appends them to the tool result so the model sees them at its next step.
//
// HOOK SEAM: the same `pi.on("tool_result", ...)` seam the MCP result gate uses (mcp_result_gate.ts).
// omp's ExtensionRunner CHAINS tool_result handlers - each handler receives the accumulated event
// (a prior handler's `content` replacement is visible to the next), and returned fields merge onto
// the result. So this extension loads via its own `-e` flag AFTER the security/MCP gates in the argv
// (acp_backend.ts), sees the ALREADY-WRAPPED content, and appends OUTSIDE the envelope.
//
// TRUST BOUNDARY (AGENTS.md #5): the interjection is appended as its OWN text block at the END of
// the content array - after any UNTRUSTED_CONTENT_END delimiter living inside earlier text blocks -
// and is explicitly marked as operator-origin. Untrusted-content rules stay intact.
//
// FAIL-QUIET, ALWAYS: no env vars -> the handler is never registered (non-LUCID omp runs are
// unaffected). Network error / timeout / bad payload -> no notes, the tool result passes untouched.
// This path NEVER throws and NEVER blocks or fails a tool result.

import type { createAgentSession } from "@oh-my-pi/pi-coding-agent";

type SessionOpts = NonNullable<Parameters<typeof createAgentSession>[0]>;
type ExtensionFactory = NonNullable<SessionOpts["extensions"]>[number];

/** Per-poll budget: a hung dev server must never stall the agent's turn. */
const FETCH_TIMEOUT_MS = 250;

/** The exact contract block prepended to each note (one block per note, joined). */
const MARKER = "[LUCID OPERATOR INTERJECTION - typed mid-turn by the user; weigh it and either adjust course or finish the current step first]";

/** The drain URL for this child, or null when this omp run is not LUCID-spawned.
 *  Prefers LUCID_INTERJECT_URL (a ready token'd URL, same pattern as LUCID_FLEET_STATUS_URL - the
 *  dev server's /api surface requires the per-launch token, which a child can only carry via `?t=`);
 *  falls back to the bare LUCID_DEV_URL form from the shared contract. */
export function interjectDrainUrl(env: Record<string, string | undefined> = process.env): string | null {
  const target = (env.LUCID_INTERJECT_TARGET ?? "").trim();
  if (!target) return null;
  const ready = (env.LUCID_INTERJECT_URL ?? "").trim();
  if (ready) return `${ready}${ready.includes("?") ? "&" : "?"}target=${encodeURIComponent(target)}`;
  const dev = (env.LUCID_DEV_URL ?? "").trim();
  if (dev) return `${dev.replace(/\/+$/, "")}/api/interject/pending?target=${encodeURIComponent(target)}`;
  return null;
}

/** Parse the drain response `{ ok, data: { notes: string[] } }` defensively - anything torn is []. */
export function parseDrainedNotes(raw: unknown): string[] {
  if (!raw || typeof raw !== "object" || !("data" in raw)) return [];
  const data = raw.data;
  if (!data || typeof data !== "object" || !("notes" in data) || !Array.isArray(data.notes)) return [];
  return data.notes.filter((n): n is string => typeof n === "string" && n.trim().length > 0);
}

/** The appended operator block(s), in the exact shared-contract format. */
export function formatInterjections(notes: string[]): string {
  return notes.map((n) => `\n\n${MARKER}\n${n}`).join("");
}

/** ONE drain poll, bounded and fail-quiet: [] on timeout, network error, non-200, or a bad body. */
async function drainPending(url: string): Promise<string[]> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return [];
    return parseDrainedNotes(await res.json());
  } catch {
    return []; // offline / slow / torn response - no notes this time; nothing lost (they stay queued only if undrained)
  }
}

// Default export: the live extension omp loads via `-e`. Registers nothing when the LUCID env vars
// are absent, so a plain `omp` run never pays the hook cost.
const interjectExtension: ExtensionFactory = (pi) => {
  try {
    const url = interjectDrainUrl();
    if (!url) return;
    pi.on("tool_result", async (event) => {
      try {
        const notes = await drainPending(url);
        if (notes.length === 0) return undefined; // leave the result untouched
        const prior = Array.isArray(event.content) ? event.content : [];
        // Append as a NEW trailing text block: it lands after every earlier block, hence after any
        // UNTRUSTED_CONTENT_END delimiter a gate wrapped around external content (AGENTS.md #5).
        return { content: [...prior, { type: "text", text: formatInterjections(notes) }] };
      } catch {
        return undefined; // never block or fail a tool result over an interjection
      }
    });
  } catch {
    /* a registration failure never breaks omp launch */
  }
};

export default interjectExtension;
