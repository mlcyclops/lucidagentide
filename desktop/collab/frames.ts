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
/** The share ended (host stopped, or the session closed). */
export interface ByeFrame { t: "bye"; reason: string }
/** A host-side refusal (e.g. a view-only guest attempted a mutating action). */
export interface ErrorFrame { t: "error"; message: string }

// ── guest -> host ────────────────────────────────────────────────────────────
/** A joining guest introduces itself; `writeToken` (base64url) is present only from a FULL link. */
export interface HelloFrame { t: "hello"; protocol: number; name: string; writeToken?: string }

// ── either direction (P-COLLAB.11) ────────────────────────────────────────────
/** WebRTC signaling carried over the collab transport: the relay brokers the SDP/ICE handshake, then the
 *  peers go DIRECT P2P (ADR-0194). Flows both ways (host<->guest), so it belongs to neither sub-union. */
export interface SignalFrame { t: "signal"; signal: SignalMessage }

export type HostFrame = WelcomeFrame | EventFrame | StateFrame | ByeFrame | ErrorFrame;
export type GuestFrame = HelloFrame;
export type LucidCollabFrame = HostFrame | GuestFrame | SignalFrame;

/** Narrowing helpers (kept tiny + pure so the host/guest logic in P-COLLAB.2/.3 reads cleanly). A `signal`
 *  frame is neither a host nor a guest session frame - the demux routes it to WebRTC signaling instead. */
export const isSignalFrame = (f: LucidCollabFrame): f is SignalFrame => f.t === "signal";
export const isHostFrame = (f: LucidCollabFrame): f is HostFrame => f.t !== "hello" && f.t !== "signal";
export const isGuestFrame = (f: LucidCollabFrame): f is GuestFrame => f.t === "hello";
