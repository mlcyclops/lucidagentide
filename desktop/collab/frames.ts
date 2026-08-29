// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/frames.ts — P-COLLAB.1 (ADR-0192): the LUCID collaboration frame protocol.
//
// These are the payloads sealed into a collab envelope (crypto.ts). Where omp's WireFrame carries omp's
// internal session entries, LUCID shares its OWN session model - the `ChatEvent` stream the renderer already
// speaks - so a guest renders a shared turn natively. Phase 1 (view-only) needs the host->guest broadcast
// frames + the guest `hello`; guest `prompt`/`abort` (write) arrive in P-COLLAB.3.
//
// PURE: type declarations + a version constant only. No I/O.

import type { ChatEvent } from "../renderer/chat_events.ts";
import type { SignalMessage } from "./signaling.ts"; // P-COLLAB.11: WebRTC signaling carried over the relay

/** Bumped when the frame shapes change incompatibly; a `hello`/`welcome` mismatch is refused, not guessed. */
export const COLLAB_PROTOCOL_VERSION = 1;

export type CollabRole = "host" | "guest";
export type CollabAccess = "view" | "edit";

export interface CollabParticipant {
  peerId: number;
  name: string;
  role: CollabRole;
  access: CollabAccess;
}

/** The shared session's identity, sent once in `welcome`. Metadata only - never credentials or file paths. */
export interface CollabSessionHeader {
  sessionId: string;
  title: string;
  model: string;
  hostName: string;
  startedAt: number; // UNIX ms
}

/** One prior turn, replayed to a joining guest so they see the conversation so far (sanitized transcript). */
export interface CollabTranscriptTurn {
  role: "user" | "assistant";
  text: string;
}

// ── P-COLLAB.14 (ADR-0228): edit-guest model + already-used-folder selection ───
/** A model the host can switch to: the omp model-option value + its display name. Catalog metadata only —
 *  never a credential or a file path. */
export interface ModelChoice { value: string; name: string }
/** A folder LUCID has already worked in. The `id` is OPAQUE (a host-minted token, e.g. a hash of the path);
 *  the host resolves it back to a path LOCALLY. A file PATH is NEVER sent to a guest — only the display
 *  `name` (a basename) crosses the wire, preserving the frames.ts/host.ts "no file paths" invariant. */
export interface WorkspaceOption { id: string; name: string; isGit: boolean }
/** The allowlists an EDIT guest may pick from: the host's accessible models + the folders it has used, plus
 *  which of each is active. Delivered ONLY to edit guests (a view guest never receives it). Metadata only. */
export interface CollabOptions {
  models: ModelChoice[];
  activeModel: string;
  workspaces: WorkspaceOption[];
  activeWorkspaceId: string | null;
}

// ── host -> guest ────────────────────────────────────────────────────────────
/** The initial sync a joining guest receives: who/what, the recent transcript, and the current roster. */
export interface WelcomeFrame {
  t: "welcome";
  protocol: number;
  header: CollabSessionHeader;
  transcript: CollabTranscriptTurn[];
  participants: CollabParticipant[];
  readOnly: boolean; // true when THIS guest joined with a view link
  /** P-REMOTE.14: the host's CUI + lockdown stance, so a guest can decide LOCALLY whether device
   *  speech-to-text is allowed before it records anything. Absent = the guest assumes the strictest
   *  posture (fail-closed), because an older host that cannot answer must never buy a cloud transcriber. */
  posture?: { cui: boolean; lockdown: boolean };
}
/** A single live chat event (token / thinking / tool / subagent / done / ...), rendered by the guest as-is. */
export interface EventFrame { t: "event"; event: ChatEvent }
/** Footer refresh: the roster + the model + context fill, so guests mirror the host's status line.
 *  P-REMOTE.14: `posture` rides every push, so a guest re-decides whether device speech-to-text is
 *  allowed the moment the host flips CUI mode or lockdown. Absent = assume the strictest posture. */
export interface StateFrame { t: "state"; participants: CollabParticipant[]; model: string; contextPct: number | null; posture?: { cui: boolean; lockdown: boolean } }
/** P-COLLAB.14: the pickable model + already-used-folder allowlists (`CollabOptions`). Unicast to an EDIT
 *  guest on join, and rebroadcast to every edit guest when the host switches either. A view guest never
 *  receives it, so it never learns the host's other project names. */
export interface OptionsFrame { t: "options"; options: CollabOptions }
/** P-COLLAB.15: a user turn was submitted to the host's session, broadcast LIVE so every participant sees who
 *  typed what, in order. `from` is the author's display name (the host's name for a local turn, the guest's
 *  name for a guest-driven turn). Metadata only - the same sanitized prompt text the replay transcript holds. */
export interface UserTurnFrame { t: "user-turn"; text: string; from: string }
/** The share ended (host stopped, or the session closed). */
export interface ByeFrame { t: "bye"; reason: string }
/** A host-side refusal (e.g. a view-only guest attempted a mutating action). */
export interface ErrorFrame { t: "error"; message: string }

// ── guest -> host ────────────────────────────────────────────────────────────
/** A joining guest introduces itself; `writeToken` (base64url) is present only from a FULL link. */
export interface HelloFrame { t: "hello"; protocol: number; name: string; writeToken?: string }
/** P-COLLAB.12: a guest with EDIT access drives the host's session. The prompt RUNS ON THE HOST, so it passes
 *  the host's fail-closed scan gate + exec/egress approvals exactly like a local prompt - the guest cannot
 *  bypass any host approval. A view-only guest's prompt is refused with an `error` frame.
 *  P-REMOTE.8 (ADR-0229): `images` (validated image data URLs, additive/optional) ride along as vision input,
 *  staged into the host's composer + sent to the model exactly like a locally pasted screenshot; the host
 *  re-validates each (type/size/count) fail-closed. Only image/(png|jpeg|webp|gif) base64 - never SVG/script. */
/** P-REMOTE.12 (ADR-0251): a push-to-talk clip riding a prompt. The PWA transcodes to 16k mono WAV
 *  when it can (raw recorder output as fallback); the HOST transcribes it and the transcript becomes
 *  ordinary guest text - through the same fail-closed scan gate as every typed prompt. */
export interface PromptAudio { b64: string; mime: string }
/** P-REMOTE.14: where the words were transcribed. "device-local" = on the phone, so the audio never left it;
 *  "device-cloud" = the browser VENDOR's servers did it, so the audio already left the phone; "host" = the
 *  desktop transcribed the attached clip offline. Provenance for the transcript + audit, and the input to the
 *  host's fail-closed CUI refusal. */
export type SttSource = "device-local" | "device-cloud" | "host";
export interface PromptFrame { t: "prompt"; text: string; images?: string[]; audio?: PromptAudio; sttSource?: SttSource }

/** Hard cap for a voice clip (a 30s 16k mono WAV is ~1MB; 4MB is generous, never abusable). */
export const MAX_PROMPT_AUDIO_BYTES = 4 * 1024 * 1024;
const AUDIO_MIME = /^audio\/(wav|x-wav|wave|webm|mp4|m4a|mpeg|ogg|aac)(;|$)/i;
const B64ISH = /^[A-Za-z0-9+/=]+$/;

/** Fail-closed shape/size/mime check, run on BOTH ends (guest before send, host before use). */
export function validPromptAudio(a: unknown): a is PromptAudio {
  if (!a || typeof a !== "object") return false;
  const { b64, mime } = a as { b64?: unknown; mime?: unknown };
  if (typeof b64 !== "string" || typeof mime !== "string") return false;
  if (!b64.length || b64.length > (MAX_PROMPT_AUDIO_BYTES * 4) / 3 + 4) return false;
  if (!B64ISH.test(b64)) return false;
  return AUDIO_MIME.test(mime);
}
/** Fail-closed provenance check, run on BOTH ends (guest before send, host before use): ONLY the three known
 *  literals survive, so junk or a future value is dropped to `undefined` (no claim) rather than trusted. */
export function validSttSource(s: unknown): s is SttSource {
  return s === "device-local" || s === "device-cloud" || s === "host";
}
/** P-COLLAB.12: an edit guest stops the in-flight turn (same effect as the host pressing Stop). */
export interface AbortFrame { t: "abort" }
/** P-COLLAB.14: an EDIT guest asks the host to switch the active model. `value` MUST be one of the models the
 *  host offered in `options`; the host re-validates membership (fail-closed) before applying, so an arbitrary
 *  model id never reaches the host session. A view-only guest's set-model is refused with an `error` frame. */
export interface SetModelFrame { t: "set-model"; value: string }
/** P-COLLAB.14: an EDIT guest asks the host to switch to an already-used folder by its OPAQUE `id`. The host
 *  re-validates the id against `options` and resolves id->path LOCALLY (a guest never sends a path); an
 *  unknown id is refused (fail-closed). Switching the folder RESTARTS the host's agent in the new cwd - it
 *  is one shared session, so the local host's folder changes too. A view-only guest is refused. */
export interface SetWorkspaceFrame { t: "set-workspace"; id: string }

// ── P-PWA-FLEET.1: EDIT-guest fleet controls + mid-turn interjection ─────────
/** An EDIT guest prompts a fleet LANE (not the master session). Runs on the HOST through the lane's own
 *  fail-closed gate; the wiring queues it when the lane is mid-turn. A view guest is refused. */
export interface FleetPromptFrame { t: "fleet-prompt"; laneId: string; text: string }
/** An EDIT guest stops a fleet lane (same effect as the host's lane Stop button). */
export interface FleetStopFrame { t: "fleet-stop"; laneId: string }
/** An EDIT guest answers a lane's pending approval. `scope` "session" remembers the ask's kind for the
 *  lane's lifetime (only on an allow; the lane manager ignores scope on a deny, fail-closed). */
export interface FleetAnswerFrame { t: "fleet-answer"; laneId: string; allow: boolean; scope?: "once" | "session" }
/** An EDIT guest injects a mid-turn operator note. `target` is "master" or a laneId; the note is delivered
 *  OUTSIDE any untrusted-content delimiters, clearly marked operator-origin (AGENTS.md #5). Edit-gated:
 *  a view-only guest cannot steer the agent, so its interject is refused like any other write. */
export interface InterjectFrame { t: "interject"; target: string; text: string }

// ── either direction (P-COLLAB.11) ────────────────────────────────────────────
/** WebRTC signaling carried over the collab transport: the relay brokers the SDP/ICE handshake, then the
 *  peers go DIRECT P2P (ADR-0194). Flows both ways (host<->guest), so it belongs to neither sub-union. */
export interface SignalFrame { t: "signal"; signal: SignalMessage }

export type HostFrame = WelcomeFrame | EventFrame | StateFrame | OptionsFrame | UserTurnFrame | ByeFrame | ErrorFrame;
export type GuestFrame = HelloFrame | PromptFrame | AbortFrame | SetModelFrame | SetWorkspaceFrame | FleetPromptFrame | FleetStopFrame | FleetAnswerFrame | InterjectFrame;
export type LucidCollabFrame = HostFrame | GuestFrame | SignalFrame;

// P-COLLAB.14 additions (`options`, `set-model`, `set-workspace`) are ADDITIVE and backward-compatible, so
// COLLAB_PROTOCOL_VERSION stays 1: an older peer that lacks a case simply IGNORES the new frame (a host
// drops an unknown guest frame in #onFrame; a guest ignores an unknown host frame), which is a safe no-op
// (fail-closed - the action happens ONLY when both ends understand it), never a silent unauthorized action.
// P-PWA-FLEET.1 additions (`fleet-prompt`, `fleet-stop`, `fleet-answer`, `interject`) follow the same
// additive rule: an older host simply drops them, so the protocol version stays 1.
const GUEST_FRAME_TYPES: Record<string, true> = { hello: true, prompt: true, abort: true, "set-model": true, "set-workspace": true, "fleet-prompt": true, "fleet-stop": true, "fleet-answer": true, interject: true };
/** Narrowing helpers (kept tiny + pure so the host/guest logic in P-COLLAB.2/.3 reads cleanly). A `signal`
 *  frame is neither a host nor a guest session frame - the demux routes it to WebRTC signaling instead. */
export const isSignalFrame = (f: LucidCollabFrame): f is SignalFrame => f.t === "signal";
export const isGuestFrame = (f: LucidCollabFrame): f is GuestFrame => GUEST_FRAME_TYPES[f.t] === true;
export const isHostFrame = (f: LucidCollabFrame): f is HostFrame => !isSignalFrame(f) && !isGuestFrame(f);
