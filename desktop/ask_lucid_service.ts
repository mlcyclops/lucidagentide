// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/ask_lucid_service.ts - P-ASKLUCID.1 (ADR-0581): answer one Ask Lucid question.
//
// Gathers the three views (fleet lanes, Fleet Orbit, knowledge graph), scans each one, builds the prompt
// (ask_lucid.ts) and asks the model through the side completion channel. Everything it touches is injected,
// so the whole path is tested with fakes: what reaches the model, what is withheld, and what happens when a
// reader, the scanner or the model fails.
//
// FAIL-CLOSED, PER BLOCK (invariant 3). A block whose scan blocks, or whose scan cannot run, is withheld: its
// text never reaches the model, and the model is told in one harness-written line that the block could not
// be read. The question is still answered from whatever passed. A block that cannot be READ (the fleet
// manager threw) is reported as unreadable in plain words, which is not a security event.
//
// NO ACTIONS. The reply is text. This module calls nothing that writes.

import {
  ASK_LUCID_SYSTEM,
  askLucidUser,
  fleetContext,
  historyContext,
  knowledgeContext,
  orbitContext,
  type AskBlock,
  type AskBlockName,
  type AskTurn,
} from "./ask_lucid.ts";

export interface AskDeps {
  /** The `/api/fleet/status` payload. */
  fleetStatus(): Promise<unknown>;
  /** The `/api/fleet/goal` snapshot. */
  orbit(): unknown;
  /** Knowledge graph hits for the question (`retrieveKnowledge(...).items`). */
  knowledge(query: string): Promise<unknown>;
  /** The gate's verdict on a block of text. A scan that cannot run must come back as `block: true`. */
  scan(text: string): Promise<{ block: boolean; reason: string }>;
  /** The model the side completion may use, already clamped by CUI lockdown, or why there is none. */
  pinModel(): { ok: true; model?: string } | { ok: false; error: string };
  complete(system: string, user: string, model: string | undefined): Promise<string>;
  /** Called when lockdown leaves no allowed model, so the refusal is audited. */
  onLockdownBlock?(reason: string): void;
  now(): number;
}

export interface AskReply {
  ok: boolean;
  reply?: string;
  error?: string;
  /** The model that answered, without its provider prefix. */
  model?: string;
  /** How much Lucid was shown, so the panel can say "saw 3 lanes, 5 tasks, 2 knowledge pages". */
  seen: { lanes: number; tasks: number; hits: number };
  /** Blocks that did not pass the scan and were kept from the model. */
  withheld: AskBlockName[];
}

const UNAVAILABLE = "Lucid could not answer right now. Check that a model provider is connected in Settings, then try again.";

/** PURE: the HTTP status when `reply` is a provider's error line and not an answer, else null. The side
 *  completion has no error channel: when the provider refuses, omp hands back its error line as the text
 *  (seen live: `Bedrock HTTP 403: {"message":"The security token included in the request is invalid."}`).
 *  The match is narrow on purpose: the whole reply is one short line that STARTS with a provider name of one
 *  or two words, then `HTTP`, a 4xx or 5xx status and a colon. An answer that merely mentions an HTTP status,
 *  or runs to more than one line, is never mistaken for one. */
export function providerErrorStatus(reply: string): number | null {
  if (reply.length > 600 || reply.includes("\n")) return null;
  const m = /^[A-Za-z][\w.-]{1,30}(?: [A-Za-z][\w.-]{1,20})? HTTP ([45]\d\d):/.exec(reply);
  return m ? Number(m[1]) : null;
}

export async function answerAskLucid(question: string, history: readonly AskTurn[], deps: AskDeps): Promise<AskReply> {
  const seen = { lanes: 0, tasks: 0, hits: 0 };
  const blocks: AskBlock[] = [];

  // Read each view on its own: one that fails says so and the others still arrive.
  let fleetText: string;
  try {
    const f = fleetContext(await deps.fleetStatus(), deps.now());
    fleetText = f.text;
    seen.lanes = f.lanes;
  } catch { fleetText = "The fleet lanes could not be read just now."; }
  blocks.push({ name: "fleet", text: fleetText });

  let orbitText: string;
  try {
    const o = orbitContext(deps.orbit());
    orbitText = o.text;
    seen.tasks = o.tasks;
  } catch { orbitText = "The Fleet Orbit could not be read just now."; }
  blocks.push({ name: "orbit", text: orbitText });

  let knowledgeText: string;
  try {
    const k = knowledgeContext(await deps.knowledge(question));
    knowledgeText = k.text;
    seen.hits = k.hits;
  } catch { knowledgeText = "The knowledge graph could not be read just now."; }
  blocks.push({ name: "knowledge", text: knowledgeText });

  const past = historyContext(history);
  if (past) blocks.push({ name: "history", text: past });

  // Scan every block. A blocked or unscannable block is withheld and counted as not seen.
  const withheld: AskBlockName[] = [];
  for (const b of blocks) {
    let verdict: { block: boolean; reason: string };
    try { verdict = await deps.scan(b.text); } catch { verdict = { block: true, reason: "fail-closed: the scan could not run" }; }
    if (!verdict.block) continue;
    b.withheld = verdict.reason || "blocked";
    b.text = "";
    withheld.push(b.name);
    if (b.name === "fleet") seen.lanes = 0;
    else if (b.name === "orbit") seen.tasks = 0;
    else if (b.name === "knowledge") seen.hits = 0;
  }

  const pin = deps.pinModel();
  if (!pin.ok) {
    deps.onLockdownBlock?.(pin.error);
    return { ok: false, error: pin.error, seen, withheld };
  }
  let reply: string;
  try {
    reply = (await deps.complete(ASK_LUCID_SYSTEM, askLucidUser(question, blocks), pin.model)).trim();
  } catch {
    return { ok: false, error: UNAVAILABLE, seen, withheld };
  }
  if (!reply) return { ok: false, error: UNAVAILABLE, seen, withheld };
  const status = providerErrorStatus(reply);
  if (status !== null) {
    const why = status === 401 || status === 403 ? "it rejected the credentials" : status === 429 ? "it is rate limiting requests" : status >= 500 ? "it had a server error" : "it rejected the request";
    return { ok: false, error: `The model provider did not answer (HTTP ${status}: ${why}). Check the provider in Settings, then try again.`, seen, withheld };
  }
  return { ok: true, reply, ...(pin.model ? { model: pin.model.replace(/^[^/]*\//, "") } : {}), seen, withheld };
}
