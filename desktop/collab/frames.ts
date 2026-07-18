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
}
/** A single live chat event (token / thinking / tool / subagent / done / ...), rendered by the guest as-is. */
export interface EventFrame { t: "event"; event: ChatEvent }
/** Footer refresh: the roster + the model + context fill, so guests mirror the host's status line. */
export interface StateFrame { t: "state"; participants: CollabParticipant[]; model: string; contextPct: number | null }
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
export interface PromptFrame { t: "prompt"; text: string; images?: string[] }
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

// ── either direction (P-COLLAB.11) ────────────────────────────────────────────
/** WebRTC signaling carried over the collab transport: the relay brokers the SDP/ICE handshake, then the
 *  peers go DIRECT P2P (ADR-0194). Flows both ways (host<->guest), so it belongs to neither sub-union. */
export interface SignalFrame { t: "signal"; signal: SignalMessage }

export type HostFrame = WelcomeFrame | EventFrame | StateFrame | OptionsFrame | UserTurnFrame | ByeFrame | ErrorFrame;
export type GuestFrame = HelloFrame | PromptFrame | AbortFrame | SetModelFrame | SetWorkspaceFrame;
export type LucidCollabFrame = HostFrame | GuestFrame | SignalFrame;

// P-COLLAB.14 additions (`options`, `set-model`, `set-workspace`) are ADDITIVE and backward-compatible, so
// COLLAB_PROTOCOL_VERSION stays 1: an older peer that lacks a case simply IGNORES the new frame (a host
// drops an unknown guest frame in #onFrame; a guest ignores an unknown host frame), which is a safe no-op
// (fail-closed - the action happens ONLY when both ends understand it), never a silent unauthorized action.
const GUEST_FRAME_TYPES: Record<string, true> = { hello: true, prompt: true, abort: true, "set-model": true, "set-workspace": true };
/** Narrowing helpers (kept tiny + pure so the host/guest logic in P-COLLAB.2/.3 reads cleanly). A `signal`
 *  frame is neither a host nor a guest session frame - the demux routes it to WebRTC signaling instead. */
export const isSignalFrame = (f: LucidCollabFrame): f is SignalFrame => f.t === "signal";
export const isGuestFrame = (f: LucidCollabFrame): f is GuestFrame => GUEST_FRAME_TYPES[f.t] === true;
export const isHostFrame = (f: LucidCollabFrame): f is HostFrame => !isSignalFrame(f) && !isGuestFrame(f);
