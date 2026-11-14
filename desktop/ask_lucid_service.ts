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
// NO ACTIONS ARE RUN. The reply is text plus a list of PROPOSED actions (ask_lucid_actions.ts). This module
// calls nothing that writes; a proposal runs only when the user presses Confirm in the panel.

import {
  ASK_BLOCK_MAX,
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
import { actionText, knownFrom, parseActions, settingsContext, type AskAction } from "./ask_lucid_actions.ts";
import { unusedFeaturesContext } from "./ask_lucid_features.ts"; // P-ASKLUCID.6 (ADR-0587)
import { splitFollowups } from "./ask_lucid_followups.ts"; // P-ASKLUCID.5 (ADR-0586)
import { laneActivityContext, sessionsContext, type BriefMode } from "./ask_lucid_briefing.ts"; // P-ASKLUCID.4 (ADR-0585)
import { normalizeScreen, screenContext } from "./ask_lucid_screen.ts"; // P-ASKLUCID.3 (ADR-0584)

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
  /** P-ASKLUCID.4 (ADR-0585): one lane's conversation (`fleet.laneTranscript`). Absent = no activity view. */
  laneTranscript?(laneId: string): unknown;
  /** P-ASKLUCID.4: the sessions in this workspace, spoke sessions included. Absent = no sessions view. */
  sessions?(): Promise<unknown>;
  /** P-ASKLUCID.4: the last few messages of one session (`sessionMessages(id, n)`). */
  sessionTail?(id: string): unknown;
  /** P-ASKLUCID.4: the session open in the main chat. */
  currentSessionId?(): string | null;
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
  seen: AskSeen;
  /** Blocks that did not pass the scan and were kept from the model. */
  withheld: AskBlockName[];
  /** P-ASKLUCID.2 (ADR-0582): what Lucid proposes. Validated, scanned, and never run here. */
  actions: AskAction[];
  /** Proposals that were invalid, over the limit, or failed their scan, and so are not shown. */
  actionsDropped: number;
  /** P-ASKLUCID.5 (ADR-0586): questions Lucid thinks come next. Validated and scanned; shown as chips. */
  followups?: string[];
}

/** How much of each view Lucid was shown. `screen` counts surfaces (P-ASKLUCID.3); `activity` counts lanes
 *  whose conversation was shown and `sessions` counts sessions listed (P-ASKLUCID.4). */
export interface AskSeen { lanes: number; tasks: number; hits: number; screen: number; activity: number; sessions: number }
export const NOTHING_SEEN: AskSeen = { lanes: 0, tasks: 0, hits: 0, screen: 0, activity: 0, sessions: 0 };

/** What arrives with a question besides its text. */
export interface AskExtras {
  /** P-ASKLUCID.3 (ADR-0584): the renderer's reading of the screen. Untrusted: parsed again here. */
  screen?: unknown;
  /** P-ASKLUCID.4 (ADR-0585): the user pressed Brief me: the activity and sessions views get the long size. */
  brief?: boolean;
  /** P-ASKLUCID.6 (ADR-0587): the current value of each setting Lucid may propose changing. Untrusted. */
  settings?: unknown;
  /** P-ASKLUCID.6: ids of the features this user has not used. Untrusted: only catalog ids count. */
  unusedFeatures?: unknown;
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

export async function answerAskLucid(question: string, history: readonly AskTurn[], deps: AskDeps, extras: AskExtras = {}): Promise<AskReply> {
  const seen: AskSeen = { ...NOTHING_SEEN };
  const blocks: AskBlock[] = [];

  // P-ASKLUCID.3 (ADR-0584): the screen goes first, because "this" in a question means what is on it. The
  // posted digest is rebuilt from its named fields (bounded and redacted again), then scanned below like
  // every other view. No digest (an older renderer, or nothing readable) means no block.
  if (extras.screen !== undefined && extras.screen !== null) {
    const s = screenContext(normalizeScreen(extras.screen));
    seen.screen = s.surfaces;
    blocks.push({ name: "screen", text: s.text.length > ASK_BLOCK_MAX.screen ? s.text.slice(0, ASK_BLOCK_MAX.screen) : s.text });
  }
  // The raw views, kept so a proposed action can be checked against the ids Lucid was actually shown.
  let fleetRaw: unknown = null;
  let orbitRaw: unknown = null;

  // Read each view on its own: one that fails says so and the others still arrive.
  let fleetText: string;
  try {
    fleetRaw = await deps.fleetStatus();
    const f = fleetContext(fleetRaw, deps.now());
    fleetText = f.text;
    seen.lanes = f.lanes;
  } catch { fleetText = "The fleet lanes could not be read just now."; }
  blocks.push({ name: "fleet", text: fleetText });

  // P-ASKLUCID.4 (ADR-0585): what each lane was last asked and last answered. Agent-written, so it is its
  // own view with its own scan: a poisoned lane conversation is withheld without taking the lane list with it.
  const mode: BriefMode = extras.brief === true ? "brief" : "normal";
  if (deps.laneTranscript && fleetRaw) {
    try {
      const a = laneActivityContext(fleetRaw, (id) => deps.laneTranscript!(id), mode);
      if (a.text) { blocks.push({ name: "activity", text: a.text }); seen.activity = a.lanes; }
    } catch { /* the lane list above still stands */ }
  }

  let orbitText: string;
  try {
    orbitRaw = deps.orbit();
    const o = orbitContext(orbitRaw);
    orbitText = o.text;
    seen.tasks = o.tasks;
  } catch { orbitText = "The Fleet Orbit could not be read just now."; }
  blocks.push({ name: "orbit", text: orbitText });

  // P-ASKLUCID.4 (ADR-0585): the sessions in this workspace and the last exchange of the most recent ones.
  if (deps.sessions) {
    try {
      const s = sessionsContext(await deps.sessions(), (id) => deps.sessionTail?.(id), { currentId: deps.currentSessionId?.() ?? null, now: deps.now(), mode });
      if (s.text) { blocks.push({ name: "sessions", text: s.text }); seen.sessions = s.sessions; }
    } catch { /* a briefing without the sessions view is still a briefing */ }
  }

  let knowledgeText: string;
  try {
    const k = knowledgeContext(await deps.knowledge(question));
    knowledgeText = k.text;
    seen.hits = k.hits;
  } catch { knowledgeText = "The knowledge graph could not be read just now."; }
  blocks.push({ name: "knowledge", text: knowledgeText });

  // P-ASKLUCID.6 (ADR-0587): the settings Lucid may propose changing, with their current values, and the
  // features this user has not used. Both are rebuilt here from closed lists: the post contributes keys,
  // accepted values and ids, never a sentence.
  const settings = settingsContext(extras.settings);
  if (settings.text) blocks.push({ name: "settings", text: settings.text });
  const features = unusedFeaturesContext(extras.unusedFeatures);
  if (features.text) blocks.push({ name: "features", text: features.text });

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
    if (b.name === "screen") seen.screen = 0;
    else if (b.name === "fleet") seen.lanes = 0;
    else if (b.name === "activity") seen.activity = 0;
    else if (b.name === "sessions") seen.sessions = 0;
    else if (b.name === "orbit") seen.tasks = 0;
    else if (b.name === "knowledge") seen.hits = 0;
  }

  const pin = deps.pinModel();
  if (!pin.ok) {
    deps.onLockdownBlock?.(pin.error);
    return { ok: false, error: pin.error, seen, withheld, actions: [], actionsDropped: 0 };
  }
  let reply: string;
  try {
    reply = (await deps.complete(ASK_LUCID_SYSTEM, askLucidUser(question, blocks), pin.model)).trim();
  } catch {
    return { ok: false, error: UNAVAILABLE, seen, withheld, actions: [], actionsDropped: 0 };
  }
  if (!reply) return { ok: false, error: UNAVAILABLE, seen, withheld, actions: [], actionsDropped: 0 };
  const status = providerErrorStatus(reply);
  if (status !== null) {
    const why = status === 401 || status === 403 ? "it rejected the credentials" : status === 429 ? "it is rate limiting requests" : status >= 500 ? "it had a server error" : "it rejected the request";
    return { ok: false, error: `The model provider did not answer (HTTP ${status}: ${why}). Check the provider in Settings, then try again.`, seen, withheld, actions: [], actionsDropped: 0 };
  }

  // P-ASKLUCID.2 (ADR-0582): what Lucid proposes. The block is model output shaped by untrusted context, so
  // it is validated against the ids he was shown (a withheld view contributes none) and each surviving
  // action's text is scanned. An action that fails its scan, or whose scan cannot run, is dropped. Nothing
  // is run here: the result is a list for the user's screen.
  // P-ASKLUCID.5 (ADR-0586): the follow-up questions come off first. Same rule as an action: model output
  // shaped by untrusted context, so each is validated, then scanned, and one that fails is dropped silently
  // (a missing chip needs no explanation). They are text the user may choose to send, nothing more.
  const next = splitFollowups(reply);
  reply = next.text;
  const followups: string[] = [];
  for (const q of next.followups) {
    let verdict: { block: boolean; reason: string };
    try { verdict = await deps.scan(q); } catch { verdict = { block: true, reason: "fail-closed: the scan could not run" }; }
    if (!verdict.block) followups.push(q);
  }

  const parsed = parseActions(reply, knownFrom(fleetRaw, orbitRaw, { fleet: withheld.includes("fleet"), orbit: withheld.includes("orbit") }));
  const actions: AskAction[] = [];
  let actionsDropped = parsed.dropped;
  for (const a of parsed.actions) {
    let verdict: { block: boolean; reason: string };
    try { verdict = await deps.scan(actionText(a)); } catch { verdict = { block: true, reason: "fail-closed: the scan could not run" }; }
    if (verdict.block) actionsDropped += 1; else actions.push(a);
  }
  const text = parsed.text || (actions.length ? "Here is what I can set up. Nothing runs until you confirm it." : "");
  if (!text) return { ok: false, error: UNAVAILABLE, seen, withheld, actions: [], actionsDropped };
  return { ok: true, reply: text, ...(pin.model ? { model: pin.model.replace(/^[^/]*\//, "") } : {}), seen, withheld, actions, actionsDropped, ...(followups.length ? { followups } : {}) };
}
