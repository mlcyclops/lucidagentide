// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/pwa_view.ts - P-REMOTE.3 (ADR-0226/0227): the phone guest's PURE, DOM-free viewer core.
//
// The phone PWA (tools/remote-pwa/) drives CollabGuest exactly like the desktop, but renders on a small
// screen without the desktop renderer. This is the compact viewer: a PURE reducer that folds the host's
// ChatEvent stream into a list of view items, plus HTML renderers for each. No DOM, no globals, so the phone
// UI stays testable headless and the same logic the desktop guest shows (thinking + tool chips + subagents,
// ADR-0222) renders faithfully on mobile.
//
// SECURITY: every host-authored string (answer text, tool detail, subagent title, block reason) is ESCAPED
// before it becomes HTML. The frames are E2E from the host, but the host's session can echo untrusted content,
// so the phone treats all of it as text, never markup.
//
// P-REMOTE.16 (ADR-0431): the phone keeps ONE item list per conversation. A replayed transcript turn (welcome
// or lane-sync) EXPANDS into the same items a live fold produces (`expandTurns`), a reconnect `welcome` is
// MERGED by journal seq (`mergeWelcome`), and a tool chip opens into the same code/diff drilldown a fleet lane
// card shows - so what the phone shows after a reconnect is exactly what it would have shown live.

import type { ChatEvent, FleetLaneStatus } from "../renderer/chat_events.ts";
import { toolChip } from "../renderer/answer_chips.ts"; // P-REMOTE.9: reuse the desktop's +/- diffstat convention
import { laneChipBody } from "../renderer/lane_transcript.ts"; // P-REMOTE.16: the SAME drilldown rows a fleet lane card shows (linediff + 400-row cap)
import type { CollabSessionHeader, CollabTranscriptTurn, WelcomeFrame } from "./frames.ts";
import type { GuestPhase, GuestView } from "./guest.ts";
import type { ProcessView } from "../process_view.ts"; // P-PWA-FLEET.1: pure process rows (type-only)

/** Escape the five HTML-significant characters. The only text→markup boundary in the PWA. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"));
}

/** P-REMOTE.16 (ADR-0431): the authored code behind a tool chip, for the drilldown. Same shape as the live
 *  `tool` event's `code` and the replayed `CollabToolRecord.code`; `path` is the tool's own relative path. */
export type ViewToolCode = { path: string; content?: string; oldText?: string; newText?: string; patch?: string };

/** One rendered block in the phone transcript. Token deltas accrete into the trailing `answer`; thinking,
 *  tools, subagents, and blocks are their own items so the reader sees what the agent is doing.
 *  P-REMOTE.16 (ADR-0431): every variant may carry `seq`, the host's master-journal turn it belongs to, so a
 *  reconnect welcome can replace exactly the turns the host re-sends. Absent on a local fold (own echo,
 *  local note) and on anything from an older host. */
export type ViewItem =
  | { kind: "user"; seq?: number; text: string; from?: string } // P-REMOTE.9/P-COLLAB.15: a user turn (own echo, or another participant's, labelled by `from`)
  | { kind: "answer"; seq?: number; text: string; streaming: boolean }
  | { kind: "thinking"; seq?: number; text: string }
  // P-REMOTE.9: `path` + `add`/`del` present for edit/write/patch tools (the +/- diffstat), else absent.
  // P-REMOTE.16: the live event's own `code` (clipped) / `input` / `intent` ride along for the chip drilldown,
  // and `tool-meta` settles `ok` + `elapsedMs` in place by `id` - the same detail a fleet lane card shows.
  | { kind: "tool"; seq?: number; id?: string; name: string; detail: string; path?: string; add?: number; del?: number; code?: ViewToolCode; input?: string; intent?: string; ok?: boolean; elapsedMs?: number }
  | { kind: "subagent"; seq?: number; agent: string; title: string; count: number }
  | { kind: "block"; seq?: number; reason: string; severity: string }
  // P-PREVIEW-PWA.1: a preview snapshot the host sent. `image` is a data URL, hydrated as an <img> property by
  // the PWA (never inlined into the transcript HTML); `id` is stable across re-renders for that hydration.
  | { kind: "preview"; seq?: number; image: string; label?: string; id: string }
  // P-PWA-FLEET.1: the LATEST fleet + process snapshots. REPLACE-in-place fold semantics: at most ONE of
  // each ever exists in the list (a poll updates it in position, never appends), so the transcript cannot
  // fill up with stale status blocks.
  | { kind: "fleet-lanes"; seq?: number; lanes: FleetLaneStatus[] }
  | { kind: "processes"; seq?: number; processes: ProcessView[] }
  // P-PWA-FOCUS.1: a fleet lane's turn failed. Its own kind, NOT `block`: `block` means the security gate
  // refused something, and a lane crash wearing the gate's clothing would teach the user to misread the one
  // signal that must stay unambiguous. Rendered red, but visibly a different thing.
  | { kind: "lane-error"; seq?: number; message: string }
  | { kind: "note"; seq?: number; text: string };

// P-REMOTE.16: the per-field caps the host applies before a code body or an input rides a frame. Applied
// here too, so a live event from an older (uncapped) host cannot park a megabyte in the phone's item list
// or its on-device history.
export const TOOL_CODE_FIELD_CAP = 16 * 1024;
export const TOOL_INPUT_CAP = 4 * 1024;

/** Clip a string to `max` chars (a clipped body stays renderable; the diffstat on the chip was already
 *  sized from the full text by `toolChip`, so the +/- never lies). */
function clipText(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** The tool's authored code, with every body field clipped to TOOL_CODE_FIELD_CAP. `undefined` when the
 *  event carried no code at all; a bare `{ path }` survives (it is provenance, and the diffstat's key). */
function clipCode(c: ViewToolCode | undefined): ViewToolCode | undefined {
  if (!c || typeof c.path !== "string") return undefined;
  const out: ViewToolCode = { path: c.path };
  if (typeof c.content === "string") out.content = clipText(c.content, TOOL_CODE_FIELD_CAP);
  if (typeof c.oldText === "string") out.oldText = clipText(c.oldText, TOOL_CODE_FIELD_CAP);
  if (typeof c.newText === "string") out.newText = clipText(c.newText, TOOL_CODE_FIELD_CAP);
  if (typeof c.patch === "string") out.patch = clipText(c.patch, TOOL_CODE_FIELD_CAP);
  return out;
}

/** omp's coarse ACP kinds (mirrors the desktop's rule, ADR-0318): a `tool-meta` whose name is one of these
 *  never replaces a real tool name already on the chip. */
const COARSE_KINDS: Record<string, true> = { edit: true, execute: true, read: true, search: true, fetch: true, think: true, other: true, tool: true, run: true, delete: true, move: true };

/** Build the tool item the chip + drilldown render from, for a live `tool` event and a replayed
 *  `CollabToolRecord` alike (the same fields, so a replay renders exactly like the live call did). The +/-
 *  diffstat is sized by `toolChip` from the (unclipped) code when present, else taken from the record's
 *  precomputed `add`/`del` (a replay that shed its code to fit the frame still shows +/-). */
function toolItem(t: { id?: string; name: string; detail: string; code?: ViewToolCode; input?: string; intent?: string; ok?: boolean; elapsedMs?: number; add?: number; del?: number }, seq?: number): ViewItem {
  const chip = toolChip(t.name, t.detail, t.code);
  const code = clipCode(t.code);
  const stat = chip.diffstat ?? (typeof t.add === "number" || typeof t.del === "number" ? { add: t.add ?? 0, del: t.del ?? 0 } : null);
  return {
    kind: "tool", name: t.name, detail: chip.detail,
    ...(seq !== undefined ? { seq } : {}),
    ...(typeof t.id === "string" && t.id ? { id: t.id } : {}),
    ...(t.code?.path ? { path: t.code.path } : {}),
    ...(stat ? { add: stat.add, del: stat.del } : {}),
    ...(code ? { code } : {}),
    ...(typeof t.input === "string" && t.input.trim() ? { input: clipText(t.input, TOOL_INPUT_CAP) } : {}),
    ...(typeof t.intent === "string" && t.intent.trim() ? { intent: t.intent } : {}),
    ...(typeof t.ok === "boolean" ? { ok: t.ok } : {}),
    ...(typeof t.elapsedMs === "number" && Number.isFinite(t.elapsedMs) && t.elapsedMs >= 0 ? { elapsedMs: t.elapsedMs } : {}),
  };
}

/** Fold one host ChatEvent into the item list (PURE - returns a new list). Token/thinking deltas coalesce
 *  into the trailing item of their kind; `done` finalizes the streaming answer with its authoritative text.
 *  P-REMOTE.16: `seq` (the master-journal turn the event belongs to) tags every item it pushes or updates,
 *  so `mergeWelcome` can later tell a locally folded turn from one the host re-sent. */
export function foldEvent(items: ViewItem[], e: ChatEvent, seq?: number): ViewItem[] {
  const out = items.slice();
  const last = out[out.length - 1];
  const tag = seq !== undefined ? { seq } : {};
  switch (e.type) {
    case "token": {
      if (last && last.kind === "answer" && last.streaming) out[out.length - 1] = { ...last, ...tag, text: last.text + e.text };
      else out.push({ kind: "answer", ...tag, text: e.text, streaming: true });
      return out;
    }
    case "thinking": {
      if (last && last.kind === "thinking") out[out.length - 1] = { ...last, ...tag, text: last.text + e.text };
      else out.push({ kind: "thinking", ...tag, text: e.text });
      return out;
    }
    case "tool": {
      // P-REMOTE.9: size the +/- diffstat from the tool's authored code (edit/write/patch) using the SAME
      // convention as the desktop chips; a read/search/bash tool has no code -> no diffstat.
      out.push(toolItem(e, seq));
      return out;
    }
    case "tool-meta": {
      // P-REMOTE.16: settle the chip the call opened, IN PLACE, by id (the latest one, if a call id ever
      // repeats). Nothing is appended when no chip carries that id: a settle for a call this list never saw
      // is not a chip. A coarse kind never replaces a real name (desktop rule, ADR-0318).
      if (!e.id) return out;
      for (let i = out.length - 1; i >= 0; i--) {
        const it = out[i]!;
        if (it.kind !== "tool" || it.id !== e.id) continue;
        const coarse = COARSE_KINDS[(e.name ?? "").toLowerCase()] === true;
        const name = e.name && (!coarse || COARSE_KINDS[it.name.toLowerCase()]) ? e.name : it.name;
        out[i] = {
          ...it, ...tag, name,
          ...(typeof e.ok === "boolean" ? { ok: e.ok } : {}),
          ...(typeof e.elapsedMs === "number" && Number.isFinite(e.elapsedMs) && e.elapsedMs >= 0 ? { elapsedMs: e.elapsedMs } : {}),
        };
        break;
      }
      return out;
    }
    case "subagent":
      out.push({ kind: "subagent", ...tag, agent: e.agent, title: e.title, count: e.assignments.length });
      return out;
    case "block":
      out.push({ kind: "block", ...tag, reason: e.reason, severity: e.severity });
      return out;
    case "done": {
      // Reconcile the (lossy) streamed answer with the authoritative full text, and stop streaming.
      const text = typeof e.text === "string" && e.text ? e.text : last && last.kind === "answer" ? last.text : "";
      if (last && last.kind === "answer" && last.streaming) out[out.length - 1] = { kind: "answer", ...(last.seq !== undefined ? { seq: last.seq } : {}), ...tag, text, streaming: false };
      else if (text) out.push({ kind: "answer", ...tag, text, streaming: false });
      return out;
    }
    case "no-response":
      out.push({ kind: "note", ...tag, text: `The model (${e.model}) returned nothing.` });
      return out;
    case "preview-snapshot": {
      // P-PREVIEW-PWA.1: a preview capture from the host. Stable id = its index among previews (they only
      // append), so the PWA can re-hydrate its <img> src on every transcript re-render.
      const n = out.reduce((c, i) => c + (i.kind === "preview" ? 1 : 0), 0);
      out.push({ kind: "preview", ...tag, image: e.image, ...(e.label ? { label: e.label } : {}), id: `shot-${n}` });
      return out;
    }
    // P-PWA-FLEET.1: fleet/process snapshots REPLACE the prior one in place (stable position, never one
    // item per poll) - the transcript keeps only the LATEST of each. A FIRST insert lands BEFORE a
    // trailing live stream (streaming answer / thinking), so the next token delta still coalesces into
    // its bubble instead of starting a new one every broadcast tick.
    case "fleet-status":
      return upsertSnapshot(out, "fleet-lanes", { kind: "fleet-lanes", lanes: e.lanes });
    case "process-list":
      return upsertSnapshot(out, "processes", { kind: "processes", processes: e.processes });
    // P-PWA-FOCUS.1: a watched lane's turn failed. Appended like any other block so it lands in the lane's
    // conversation in order, at the point the failure happened.
    case "lane-error":
      out.push({ kind: "lane-error", message: e.message });
      return out;
    // Desktop-only / non-viewer events (preview, design, goal, usage, slow, …) are ignored on the phone.
    default:
      return out;
  }
}

/** Replace-in-place upsert for the fleet/process snapshot items (at most ONE of `kind` ever exists).
 *  A first insert slips in BEFORE a trailing live stream so token/thinking deltas keep coalescing. */
function upsertSnapshot(out: ViewItem[], kind: "fleet-lanes" | "processes", item: ViewItem): ViewItem[] {
  const i = out.findIndex((it) => it.kind === kind);
  if (i !== -1) { out[i] = item; return out; }
  const last = out[out.length - 1];
  if (last && ((last.kind === "answer" && last.streaming) || last.kind === "thinking")) out.splice(out.length - 1, 0, item);
  else out.push(item);
  return out;
}

// P-REMOTE.16: a lane transcript's answer text carries its tool trail as leading `[ran: <name>] ...` lines
// (lane_transcript's copy text convention). When the turn ALSO carries structured `tools`, those lines are
// the same calls twice, so they are stripped; a text-only turn keeps them (they are its only record).
const RAN_LINE = /^\[ran: [^\]\n]*\][^\n]*\n?/;

/** P-REMOTE.16 (ADR-0431): expand replayed transcript turns (welcome / lane-sync) into the SAME items a live
 *  fold produces, so a reconnect replay renders exactly like the live stream did: user bubble; thinking,
 *  tool chips (with code/input for the drilldown, ok/elapsed on the chip), gate blocks, then the answer; a
 *  lane turn that ended in error adds a red lane-fail chip. The trailing `live` turn renders its answer as
 *  streaming (it is partial and will be superseded). An empty, settled answer is omitted (nothing to show),
 *  but an empty LIVE one still renders so the stream's cursor is visible. Every item inherits the turn's
 *  `seq`. Pure. */
export function expandTurns(turns: CollabTranscriptTurn[]): ViewItem[] {
  const out: ViewItem[] = [];
  for (const t of Array.isArray(turns) ? turns : []) {
    if (!t || typeof t !== "object") continue;
    const seq = typeof t.seq === "number" && Number.isFinite(t.seq) ? t.seq : undefined;
    const tag = seq !== undefined ? { seq } : {};
    const text = typeof t.text === "string" ? t.text : "";
    if (t.role === "user") {
      out.push({ kind: "user", ...tag, text, ...(typeof t.from === "string" && t.from ? { from: t.from } : {}) });
      continue;
    }
    if (typeof t.thinking === "string" && t.thinking.trim()) out.push({ kind: "thinking", ...tag, text: t.thinking });
    const tools = Array.isArray(t.tools) ? t.tools : null;
    if (tools) for (const r of tools) if (r && typeof r === "object" && typeof r.name === "string") out.push(toolItem({ ...r, detail: typeof r.detail === "string" ? r.detail : "" }, seq));
    if (Array.isArray(t.blocks)) for (const b of t.blocks) if (b && typeof b === "object") out.push({ kind: "block", ...tag, reason: String(b.reason ?? ""), severity: String(b.severity ?? "medium") });
    let answer = text;
    if (tools) while (RAN_LINE.test(answer)) answer = answer.replace(RAN_LINE, "");
    if (answer || t.live) out.push({ kind: "answer", ...tag, text: answer, streaming: t.live === true });
    if (typeof t.error === "string" && t.error) out.push({ kind: "lane-error", ...tag, message: t.error });
  }
  return out;
}

/** P-REMOTE.16: the gap note `mergeWelcome` inserts when the host could not replay everything after `since`. */
export const GAP_NOTE = "some history while you were away is no longer available";

/** P-REMOTE.16 (ADR-0431): fold a `welcome` into the master item list. A welcome that ECHOES `since` is a
 *  RECONNECT replay: keep every item settled at or before `since`, drop the rest (items with a newer seq
 *  were folded live from a turn the host is now re-sending in full; items with NO seq were local folds -
 *  own echoes, local notes - that the host's journal has either absorbed or never saw), then append the
 *  replayed turns. `complete === false` means the host's bounded journal no longer covers the whole gap, so
 *  a note marks where history is missing. A welcome WITHOUT `since` (fresh join, or an older host) is the
 *  whole window and REPLACES the list. The fleet/process snapshots are status, not history: they survive a
 *  reconnect merge in place rather than blanking the strips until the next poll. Pure. */
export function mergeWelcome(items: ViewItem[], w: WelcomeFrame): ViewItem[] {
  const replay = expandTurns(Array.isArray(w.transcript) ? w.transcript : []);
  if (typeof w.since !== "number" || !Number.isFinite(w.since)) return replay;
  const since = w.since;
  const kept = items.filter((it) => it.kind === "fleet-lanes" || it.kind === "processes" || (typeof it.seq === "number" && it.seq <= since));
  const gap: ViewItem[] = w.complete === false ? [{ kind: "note", text: GAP_NOTE }] : [];
  return kept.concat(gap, replay);
}

const SEV_CLASS: Record<string, string> = { high: "sev-high", medium: "sev-med", low: "sev-low" };

/** One-line gist of a thinking block for its collapsed summary: the LAST non-empty line (the freshest
 *  thought while the stream grows), whitespace-collapsed and clipped. Pure; "" for blank text. */
export function thinkingGist(text: string, max = 64): string {
  const lines = text.split(/\n+/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  return last.length > max ? `${last.slice(0, max - 1).trimEnd()}…` : last;
}

/** The last path segment of a lane cwd. The broadcaster already sends a basename (the "no file paths"
 *  wire invariant); this is belt-and-braces for any slash that slips through. Pure. */
export function laneCwdName(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

/**
 * P-PWA-FLEET.2: one fleet lane card - a lane you can actually DRIVE, in its own lane rather than through
 * the master composer. All host strings escaped, including data attributes.
 *
 * The card carries `lane-<status>` so the phone's CSS can reuse the DESKTOP fleet colour mapping verbatim
 * (cyan working, amber waiting, red needs-approval, green done, dim starting/stopped) instead of inventing
 * a second palette; `data-status` stays for the dot.
 *
 * Its composer offers EXACTLY what `CollabGuest` can do for a lane and nothing more (a dead control is
 * worse than no control): Send/Queue (`fleetPrompt`, text only - images stay master-bound because the
 * lane wire has no image field), Push now + Check in (`interject` with the lane id), Stop (`fleetStop`),
 * and the three approval answers (`fleetAnswer`). No spawn, no model picker, no queue reorder: the guest
 * protocol has none of those, so the phone must not pretend.
 *
 * The whole `.lane-drive` block is hidden for view guests by CSS (`#fleet[data-readonly]`); guest.ts
 * refuses their sends anyway and the host re-refuses, fail-closed.
 * Invariant #11: every flex row holds controls or spans-with-one-text-child; labels nowrap+ellipsis.
 */
export function renderLaneCard(lane: FleetLaneStatus): string {
  const id = escapeHtml(lane.id);
  const status = escapeHtml(lane.status);
  const pend = lane.pendingApproval
    ? `<div class="lane-pend"><span class="lane-pend-sum">${escapeHtml(lane.pendingApproval.kind)}: ${escapeHtml(lane.pendingApproval.summary)}</span></div>` +
      `<div class="lane-approve">` +
      `<button type="button" class="lane-btn allow" data-lane="${id}" data-fleet-answer="once">Allow once</button>` +
      `<button type="button" class="lane-btn allow" data-lane="${id}" data-fleet-answer="session">Allow session</button>` +
      `<button type="button" class="lane-btn deny" data-lane="${id}" data-fleet-answer="deny">Deny</button>` +
      `</div>`
    : "";
  // The lane's own composer, mirroring the master composer's shipped shape: one input, small icon controls,
  // and a single send button whose label flips while the lane is busy (the host stages a mid-turn prompt).
  const busy = lane.status === "working" || lane.status === "starting";
  const drive = `<div class="lane-drive">` +
    `<textarea class="lane-input" rows="1" data-lane-input="${id}" placeholder="Message ${escapeHtml(lane.name)}\u2026" aria-label="Message lane ${escapeHtml(lane.name)}"></textarea>` +
    `<div class="lane-acts">` +
    `<button type="button" class="lane-btn" data-lane="${id}" data-fleet-act="checkin" aria-label="Ask lane ${escapeHtml(lane.name)} for a brief status">Check in</button>` +
    `<span class="lane-spacer"></span>` +
    `<button type="button" class="lane-ico stop" data-lane="${id}" data-fleet-act="stop" title="Stop this lane" aria-label="Stop lane ${escapeHtml(lane.name)}">\u25a0</button>` +
    `<button type="button" class="lane-send" data-lane="${id}" data-fleet-act="send">${busy ? "Queue" : "Send"}</button>` +
    `<button type="button" class="lane-send push" data-lane="${id}" data-fleet-act="push" title="Interject the running turn"${busy ? "" : " hidden"}>Push</button>` +
    `</div></div>`;
  return `<div class="lane-card lane-${status}" data-lane="${id}">` +
    // P-PWA-FOCUS.1: the header row IS the focus control - tap the lane's name to watch its conversation.
    // role/tabindex ship in the markup rather than being hydrated afterwards, so the row is reachable by
    // keyboard on the very first paint.
    `<div class="lane-row" role="button" tabindex="0" data-focus-lane="${id}" aria-label="Watch lane ${escapeHtml(lane.name)}"><span class="lane-dot" data-status="${status}"></span><span class="lane-name">${escapeHtml(lane.name)}</span><span class="lane-status">${status}</span></div>` +
    `<div class="lane-meta"><span class="lane-cwd">${escapeHtml(laneCwdName(lane.cwd))}</span><span class="lane-turns">${lane.turns} turn${lane.turns === 1 ? "" : "s"}</span></div>` +
    pend +
    drive +
    `</div>`;
}

/** P-PWA-FLEET.1: one process row (kind badge + label + status; the detail rides as a title tooltip).
 *  All host strings escaped. Invariant #11: three label spans, each a single text child. */
export function renderProcessRow(p: ProcessView): string {
  // P-PWA-FOCUS.1: `data-proc-id`/`data-proc-kind` let the PWA turn a row into a focus target WITHOUT
  // index-matching it back against the snapshot array. A kind of "lane" means the id IS a lane id; the PWA
  // decides what is focusable, so this renderer stays presentation-only.
  return `<div class="proc-row" data-proc-id="${escapeHtml(p.id)}" data-proc-kind="${escapeHtml(p.kind)}" title="${escapeHtml(p.detail)}">` +
    `<span class="proc-kind">${escapeHtml(p.kind)}</span>` +
    `<span class="proc-label">${escapeHtml(p.label)}</span>` +
    `<span class="proc-status">${escapeHtml(p.status)}</span>` +
    `</div>`;
}

/** P-REMOTE.16: a call's duration for the chip: "0.8s" / "12s" / "1m 05s". Pure. */
export function elapsedLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms - m * 60_000) / 1000);
  return `${m}m ${s < 10 ? "0" : ""}${s}s`;
}

/** P-REMOTE.16: the body of a tool chip's drilldown, built by lane_transcript's `laneChipBody` so a phone
 *  diff and a lane-card diff classify, count, and truncate lines identically. Rows render as
 *  `<div class="dr dr-add|dr-del|dr-ctx">` (host text escaped); an input as a wrapped `<pre>`. Returns ""
 *  when the item has nothing to reveal (a bare `{ path }` is provenance, not a body). */
function toolDrill(item: Extract<ViewItem, { kind: "tool" }>): string {
  const body = laneChipBody({ id: item.id ?? "", name: item.name, detail: item.detail, code: item.code, input: item.input, intent: item.intent, open: false });
  if (!body) return "";
  if (body.kind === "diff") return `<div class="drill-diff">${body.rows.map((r) => `<div class="dr dr-${r.type}">${escapeHtml(r.text)}</div>`).join("")}</div>`;
  if (body.kind === "input") return `<pre class="drill-input">${escapeHtml(body.text)}</pre>`;
  return ""; // "detail" would only repeat the chip's own line
}

/** Render one view item to a mobile HTML fragment (all host text escaped).
 *  `i` keys a thinking block's `data-think` so the PWA can preserve the user's open/closed choice across
 *  the per-event innerHTML repaints (which otherwise reset every <details> to collapsed - the "can't open
 *  Thinking while the agent streams" bug). `activeThinking` renders the block OPEN by default: desktop
 *  parity, where the live reasoning streams visibly and collapses once the answer starts. */
export function renderItem(item: ViewItem, i = 0, activeThinking = false): string {
  switch (item.kind) {
    case "user": {
      // P-COLLAB.15: label a turn from ANOTHER participant with its author; the guest's own echo has no `from`.
      const who = item.from ? `<span class="msg-from">${escapeHtml(item.from)}</span>` : "";
      return `<div class="msg user">${who}${escapeHtml(item.text)}</div>`;
    }
    case "answer":
      return `<div class="msg answer${item.streaming ? " streaming" : ""}">${escapeHtml(item.text)}</div>`;
    case "thinking": {
      const gist = thinkingGist(item.text);
      const g = gist ? ` <span class="gist">${escapeHtml(gist)}</span>` : "";
      return `<details class="msg thinking"${activeThinking ? " open" : ""} data-think="${i}"><summary>Thinking${g}</summary><div>${escapeHtml(item.text)}</div></details>`;
    }
    case "tool": {
      // For an edit/write, show the file path + a +/- diffstat; for other tools, the compact detail.
      const label = item.path ? escapeHtml(item.path) : escapeHtml(item.detail);
      const body = label ? `<span class="chip-detail">${label}</span>` : "";
      const stat = (item.add != null || item.del != null)
        ? `<span class="chip-stat"><span class="add">+${item.add ?? 0}</span> <span class="del">\u2212${item.del ?? 0}</span></span>`
        : "";
      // P-REMOTE.16: a settled call shows how long it took; a failed one reads red (`failed`).
      const took = typeof item.elapsedMs === "number" ? `<span class="chip-took">\u00b7 ${elapsedLabel(item.elapsedMs)}</span>` : "";
      const chip = `<span class="chip-name">${escapeHtml(item.name)}</span>${body}${stat}${took}`;
      const cls = `chip tool${item.ok === false ? " failed" : ""}`;
      // P-REMOTE.16: the drilldown - the SAME rows a fleet lane card's chevron shows (linediff, raw patch
      // lines, 400-row cap with a visible truncation line), or the command/input for a tool that authored
      // no code. Only a chip with something to reveal becomes a <details>; the rest stay a flat chip.
      const drill = (item.code || item.input) ? toolDrill(item) : "";
      if (!drill) return `<div class="${cls}">${chip}</div>`;
      const intent = item.intent ? `<div class="drill-intent">${escapeHtml(item.intent)}</div>` : "";
      return `<details class="${cls} tool-drill"><summary>${chip}</summary><div class="drill">${intent}${drill}</div></details>`;
    }
    case "subagent":
      return `<div class="chip subagent"><span class="chip-name">${escapeHtml(item.agent)}</span><span class="chip-detail">${escapeHtml(item.title)} · ${item.count} task${item.count === 1 ? "" : "s"}</span></div>`;
    case "block":
      return `<div class="chip block ${SEV_CLASS[item.severity] ?? "sev-med"}">Blocked: ${escapeHtml(item.reason)}</div>`;
    case "preview": {
      // The image data URL is set as an <img> PROPERTY by the PWA after render (never inlined here). The
      // button opens the fullscreen viewer (save / mark-up); `data-shot` keys both the hydration + the tap.
      const cap = item.label ? `<div class="cu-shot-cap">${escapeHtml(item.label)}</div>` : "";
      return `<div class="msg shot"><button class="cu-shot-btn" type="button" data-shot="${escapeHtml(item.id)}" aria-label="Open preview snapshot"><img class="cu-shot-img" alt="preview snapshot" /></button>${cap}</div>`;
    }
    case "fleet-lanes":
      // P-PWA-FLEET.1: the fleet snapshot. The PWA renders this item into its FLEET section (filtered out
      // of the transcript flow); inline rendering here keeps the item printable + fully escape-tested.
      return `<div class="fleet-lanes">${item.lanes.map(renderLaneCard).join("")}</div>`;
    case "processes":
      return `<div class="proc-list">${item.processes.map(renderProcessRow).join("")}</div>`;
    case "lane-error":
      // Its own class, never `.chip.block`: the phone must not show a lane crash in the security gate's
      // clothing. Labelled in words too, so the distinction survives someone restyling the CSS.
      return `<div class="chip lane-fail"><span class="chip-name">lane failed</span><span class="chip-detail">${escapeHtml(item.message)}</span></div>`;
    case "note":
      return `<div class="msg note">${escapeHtml(item.text)}</div>`;
  }
}

// P-PWA-FOCUS.2: the "you were away" divider. Not styled here (that is the PWA's index.html); `data-sync-mark`
// is the hook the phone scrolls to after a cross-screen-lock sync.
const SYNC_MARK = `<div class="sync-mark" data-sync-mark><span class="sync-mark-l">new since you looked away</span></div>`;

/** Render the whole transcript: ONE item list per conversation (P-REMOTE.16 - replayed turns are expanded
 *  into items by `expandTurns`/`mergeWelcome`, so there is no separate "prior" stream any more).
 *  P-PWA-FOCUS.2: `newFrom` is a position in `items` - the first entry the user had not seen when the
 *  screen locked. When it lands strictly inside the list, ONE divider is drawn immediately before that entry. */
export function renderTranscript(items: ViewItem[], newFrom?: number): string {
  const total = items.length;
  // Only an in-range INTEGER boundary draws a divider, because out of range there is no boundary to draw:
  // `<= 0` means everything is new, which reads exactly like arriving fresh, and a rule above the very first
  // line is noise; `>= total` means the user is already caught up. A non-integer or non-finite value is
  // rejected outright rather than rounded or clamped, because the phone SCROLLS to this element - a divider
  // in the WRONG place is worse than no divider at all. `mark` stays -1 (matching no index) otherwise, which
  // is also what guarantees at most ONE marker per render: it is a single position, not a predicate.
  const mark = typeof newFrom === "number" && Number.isInteger(newFrom) && newFrom > 0 && newFrom < total ? newFrom : -1;
  // A thinking block that is still the TRAILING item is the live reasoning - render it open (it collapses
  // naturally when the first answer token / tool chip lands after it). data-think = the item index.
  return items
    .map((it, i) => (i === mark ? SYNC_MARK : "") + renderItem(it, i, it.kind === "thinking" && i === items.length - 1))
    .join("");
}

/** The header line (title + model + host) for the top bar. Metadata only: no credentials, no paths. */
export function renderHeader(header: CollabSessionHeader | null): string {
  if (!header) return `<span class="hdr-title">Connecting…</span>`;
  return `<span class="hdr-title">${escapeHtml(header.title || "LUCID session")}</span>` +
    `<span class="hdr-sub">${escapeHtml(header.model)} · ${escapeHtml(header.hostName)}</span>`;
}

/** P-COLLAB.14: the EDIT guest's model + already-used-folder pickers. Renders two `<select>`s (data-role
 *  `model` / `workspace`) ONLY for a live, writable guest that the host offered `options`; otherwise "" (a
 *  view guest never sees them). Every model/folder NAME is escaped (host-authored). Values are the model id
 *  and the OPAQUE folder id - no filesystem path is ever present. The PWA wires `change` to guest.setModel/
 *  setWorkspace. */
export function renderControls(view: GuestView): string {
  if (view.readOnly || view.phase === "ended" || !view.options) return "";
  const o = view.options;
  const modelOpts = o.models
    .map((m) => `<option value="${escapeHtml(m.value)}"${m.value === o.activeModel ? " selected" : ""}>${escapeHtml(m.name || m.value)}</option>`)
    .join("");
  const wsOpts = o.workspaces
    .map((w) => `<option value="${escapeHtml(w.id)}"${w.id === o.activeWorkspaceId ? " selected" : ""}>${escapeHtml(w.name)}${w.isGit ? " \u00b7 git" : ""}</option>`)
    .join("");
  const model = o.models.length
    ? `<label class="ctl"><span class="ctl-l">Model</span><select class="ctl-sel" data-role="model" aria-label="Model">${modelOpts}</select></label>`
    : "";
  const workspace = o.workspaces.length
    ? `<label class="ctl"><span class="ctl-l">Folder</span><select class="ctl-sel" data-role="workspace" aria-label="Folder">${wsOpts}</select></label>`
    : "";
  return model + workspace;
}

// ---- P-REMOTE.13 (ADR-0251): the INVISIBLE hourly reconnect ----
// Cloud Run hard-caps a WebSocket at 60 minutes; the hourly flap is a security FEATURE (every reconnect
// re-presents a fresh identity token - ADR-0227) and the socket already buffers outbound frames across
// it. What the user saw was the presentation: an instant amber "Reconnecting" the moment the cap hit.
// The fix is a GRACE WINDOW: while a transient drop is younger than RECONNECT_GRACE_MS the banner keeps
// saying Live - the flap is invisible unless it turns into a real outage. Fatal states are NEVER masked.
export const RECONNECT_GRACE_MS = 7000;

/** The status to PRESENT: masks a young transient reconnect as Live; everything else is statusLabel.
 *  `flapAt` = when the current reconnecting phase began (0 = not flapping). Pure. */
export function presentedStatus(view: GuestView, flapAt: number, now: number): { text: string; tone: "live" | "wait" | "ended" } {
  if (view.phase === "reconnecting" && flapAt > 0 && now - flapAt < RECONNECT_GRACE_MS) {
    return { text: view.readOnly ? "Live \u00b7 view only" : "Live \u00b7 you can drive", tone: "live" };
  }
  return statusLabel(view);
}

/** A short connection-status label + tone for the banner. */
export function statusLabel(view: GuestView): { text: string; tone: "live" | "wait" | "ended" } {
  // P-REMOTE.8: a transient reconnect is a WAIT (amber), not an ended (red) state - and once the socket
  // recovers, guest.ts clears the note + goes live, so the banner flips back to "Live" on its own.
  if (view.phase === "reconnecting") return { text: view.note ?? "Reconnecting\u2026", tone: "wait" };
  if (view.note) return { text: view.note, tone: "ended" };
  const byPhase: Record<GuestPhase, { text: string; tone: "live" | "wait" | "ended" }> = {
    connecting: { text: "Connecting…", tone: "wait" },
    reconnecting: { text: "Reconnecting…", tone: "wait" },
    live: { text: view.readOnly ? "Live · view only" : "Live · you can drive", tone: "live" },
    ended: { text: "Session ended", tone: "ended" },
  };
  return byPhase[view.phase];
}

// ── P-REMOTE.9 (ADR-0230): end-of-run mobile engineering report ───────────────────────────────────────────

export interface ReportFile { path: string; add: number; del: number }
export interface TurnReport {
  model: string;
  contextPct: number | null;
  task: string;    // the user prompt that started the turn (empty when the host drove it)
  answer: string;  // the final assistant reply
  files: ReportFile[]; // files edited/written, +/- summed per path
  // Tool-use counts, busiest first. P-REMOTE.16: `failed` = calls whose `tool-meta` settled `ok: false`
  // (0 when none did, or when the host never reported), keyed by the REAL name tool-meta relabelled.
  tools: { name: string; n: number; failed: number }[];
  totalAdd: number;
  totalDel: number;
}

/** Build a per-turn engineering report from ONE turn's folded view items (PURE). Merges edit/write diffstats
 *  per file, counts tool uses, and captures the task prompt + final answer. */
export function buildTurnReport(items: ViewItem[], view: { header: CollabSessionHeader | null; contextPct: number | null }): TurnReport {
  const byPath = new Map<string, ReportFile>();
  const counts = new Map<string, { n: number; failed: number }>();
  let task = "", answer = "";
  for (const it of items) {
    if (it.kind === "user") task = it.text;
    else if (it.kind === "answer") answer = it.text;
    else if (it.kind === "tool") {
      const c = counts.get(it.name) ?? { n: 0, failed: 0 };
      c.n += 1;
      if (it.ok === false) c.failed += 1;
      counts.set(it.name, c);
      if (it.path && (it.add != null || it.del != null)) {
        const f = byPath.get(it.path) ?? { path: it.path, add: 0, del: 0 };
        f.add += it.add ?? 0;
        f.del += it.del ?? 0;
        byPath.set(it.path, f);
      }
    }
  }
  const files = [...byPath.values()];
  const tools = [...counts.entries()].map(([name, c]) => ({ name, n: c.n, failed: c.failed })).sort((a, b) => b.n - a.n);
  return {
    model: view.header?.model ?? "",
    contextPct: view.contextPct,
    task, answer, files, tools,
    totalAdd: files.reduce((s, f) => s + f.add, 0),
    totalDel: files.reduce((s, f) => s + f.del, 0),
  };
}

/** Render the report as mobile-friendly, screenshot-friendly CARDS (all host text escaped). */
export function renderReportHtml(r: TurnReport): string {
  const ctx = r.contextPct != null ? `${r.contextPct}%` : "-";
  const filesRows = r.files.length
    ? r.files.map((f) => `<div class="rp-row"><span class="rp-path">${escapeHtml(f.path)}</span><span class="rp-stat"><span class="add">+${f.add}</span> <span class="del">\u2212${f.del}</span></span></div>`).join("")
    : `<div class="rp-empty">No files changed this run.</div>`;
  const toolsRows = r.tools.length
    ? r.tools.map((t) => `<div class="rp-row"><span>${escapeHtml(t.name)}</span><span class="rp-n">\u00d7${t.n}${t.failed ? ` <span class="del">(${t.failed} failed)</span>` : ""}</span></div>`).join("")
    : `<div class="rp-empty">No tools used.</div>`;
  const taskCard = r.task ? `<div class="rp-card"><div class="rp-h">Task</div><div class="rp-body">${escapeHtml(r.task)}</div></div>` : "";
  const answerCard = r.answer ? `<div class="rp-card"><div class="rp-h">Summary</div><div class="rp-body">${escapeHtml(r.answer)}</div></div>` : "";
  return `<div class="rp-card rp-summary">`
    + `<div class="rp-metric"><div class="rp-k">Model</div><div class="rp-v">${escapeHtml(r.model || "-")}</div></div>`
    + `<div class="rp-metric"><div class="rp-k">Files</div><div class="rp-v">${r.files.length}</div></div>`
    + `<div class="rp-metric"><div class="rp-k">Lines</div><div class="rp-v"><span class="add">+${r.totalAdd}</span> <span class="del">\u2212${r.totalDel}</span></div></div>`
    + `<div class="rp-metric"><div class="rp-k">Context</div><div class="rp-v">${ctx}</div></div>`
    + `</div>`
    + taskCard
    + `<div class="rp-card"><div class="rp-h">Files changed</div>${filesRows}</div>`
    + `<div class="rp-card"><div class="rp-h">Tools</div>${toolsRows}</div>`
    + answerCard;
}

/** The report as copyable Markdown (plain text; the user pastes it into a doc/ticket). */
export function reportMarkdown(r: TurnReport): string {
  const lines = ["# LUCID run report", ""];
  lines.push(`- **Model:** ${r.model || "unknown"}`);
  if (r.contextPct != null) lines.push(`- **Context fill:** ${r.contextPct}%`);
  lines.push(`- **Files changed:** ${r.files.length} (+${r.totalAdd} / \u2212${r.totalDel})`);
  if (r.task) lines.push("", "## Task", r.task);
  if (r.files.length) { lines.push("", "## Files"); for (const f of r.files) lines.push(`- \`${f.path}\` +${f.add} / \u2212${f.del}`); }
  if (r.tools.length) { lines.push("", "## Tools"); for (const t of r.tools) lines.push(`- ${t.name} \u00d7${t.n}${t.failed ? ` (${t.failed} failed)` : ""}`); }
  if (r.answer) lines.push("", "## Summary", r.answer);
  return lines.join("\n");
}
