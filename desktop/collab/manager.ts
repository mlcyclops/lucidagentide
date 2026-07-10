// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/manager.ts — P-COLLAB.3 (ADR-0192): the backend host lifecycle owner.
//
// One `CollabManager` per LUCID backend owns the CURRENT share: it mints the room + invite links, stands up
// a `CollabHost` over a relay transport, taps the live session's ChatEvents into it, and exposes a small
// status the Share panel renders. It is transport- and policy-injectable (`CollabManagerDeps`) so the whole
// lifecycle is unit-testable headless - the real deps (in dev.ts) build a `CollabSocket` and resolve the
// authorized relay from settings; a test passes a mock transport + a fake relay.
//
// Fail-closed (invariant #3): `start` REFUSES when no relay is authorized (no self-hosted URL and the public
// relay not opted in) - sharing never silently falls back to a default egress target. Phase 1 is view-only:
// the room still mints a write token (so P-COLLAB.3 guest-write can light up later) but the host is created
// with guest-write OFF, so every guest - even one holding the full link - is read-only.

import { CollabHost, type HostTransport } from "./host.ts";
import { generateRoomId, formatShareLink, formatBrowserLink, formatRelayLink } from "./link.ts";
import { generateRoomKey, generateWriteToken, importRoomKey } from "./crypto.ts";
import type { ChatEvent } from "../renderer/chat_events.ts";
import type { CollabParticipant } from "./frames.ts";

/** An authorized relay endpoint: `wsBase` is the origin (no path); `httpBase` its http(s) form for links. */
export interface RelayTarget { wsBase: string; httpBase: string; label: string; source: string }

export interface CollabManagerDeps {
  /** Resolve + authorize the relay, or null to REFUSE the share (fail-closed). */
  resolveRelay(): RelayTarget | null;
  /** Session metadata for the welcome header (never credentials or file paths). */
  sessionInfo(): { sessionId: string; title: string; model: string; hostName: string };
  /** Build the host's relay transport for a room. Real = a `CollabSocket`; test = a mock. */
  makeTransport(opts: { wsUrl: string; key: CryptoKey }): HostTransport;
  /** Injected clock (the workflow/test host forbids Date.now()); UNIX ms. */
  now(): number;
  /** P-COLLAB.12: run an EDIT guest's prompt in the host's session (through the host's fail-closed gate). */
  onGuestPrompt?: (text: string, guest: CollabParticipant) => void;
  /** P-COLLAB.12: an EDIT guest asked to stop the in-flight turn. */
  onGuestAbort?: (guest: CollabParticipant) => void;
}

export interface ShareStatus {
  active: boolean;
  roomId?: string;
  /** The full (edit-capable) link — held back in Phase 1 UI, but returned for when guest-write lights up. */
  fullLink?: string;
  /** The view (read-only) link — the default thing to share in Phase 1. */
  viewLink?: string;
  /** The browser deep link wrapping the VIEW link (secret rides the fragment). */
  browserLink?: string;
  relayLabel?: string;
  relaySource?: string;
  startedAt?: number;
  /** P-COLLAB.12: true when this share was started with EDIT allowed (a full-link guest can drive the host). */
  allowEdit?: boolean;
  participantCount: number;
  participants: CollabParticipant[];
}

const IDLE: ShareStatus = { active: false, participantCount: 0, participants: [] };

export class CollabManager {
  readonly #deps: CollabManagerDeps;
  #host: CollabHost | null = null;
  #allowEdit = false;
  #room: { roomId: string; fullLink: string; viewLink: string; browserLink: string; label: string; source: string; startedAt: number } | null = null;

  constructor(deps: CollabManagerDeps) {
    this.#deps = deps;
  }

  get active(): boolean {
    return this.#host !== null;
  }

  /** Begin sharing. Throws (fail-closed) if no relay is authorized. Restarts cleanly if already active.
   *  `allowEdit` grants a FULL-link guest the ability to drive the host (P-COLLAB.12); default view-only. */
  async start(opts: { allowEdit?: boolean } = {}): Promise<ShareStatus> {
    const relay = this.#deps.resolveRelay();
    if (!relay) {
      throw new Error("no collaboration relay is configured — set a self-hosted relay URL in Settings, or opt into the public relay");
    }
    if (this.#host) this.stop("restarting the share");
    const allowEdit = !!opts.allowEdit;

    const roomId = generateRoomId();
    const rawKey = generateRoomKey();
    const token = generateWriteToken();
    const key = await importRoomKey(rawKey);

    const wsUrl = `${relay.wsBase.replace(/\/+$/, "")}/r/${roomId}`;
    const transport = this.#deps.makeTransport({ wsUrl, key });

    const info = this.#deps.sessionInfo();
    const startedAt = this.#deps.now();
    this.#host = new CollabHost(transport, {
      header: { sessionId: info.sessionId, title: info.title, model: info.model, hostName: info.hostName, startedAt },
      writeToken: token,        // proven by a full-link guest to unlock EDIT
      allowGuestWrite: allowEdit, // P-COLLAB.12: only when the host shares an EDIT link
      // A guest prompt/abort reaches the host's session ONLY through these - and there, the host's fail-closed
      // scan gate + exec/egress approvals still apply to every tool call (the guest bypasses nothing).
      onGuestPrompt: this.#deps.onGuestPrompt,
      onGuestAbort: this.#deps.onGuestAbort,
    });
    this.#host.start();
    this.#allowEdit = allowEdit;

    // P-COLLAB.10: the shared links CARRY the relay endpoint (`<wss://relay>/r/roomId.secret`), so a guest who
    // pastes one knows WHERE to connect without any extra config.
    const fullLink = formatRelayLink(relay.wsBase, roomId, rawKey, token);
    const viewLink = formatRelayLink(relay.wsBase, roomId, rawKey);
    const browserLink = formatBrowserLink(relay.httpBase, formatShareLink(roomId, rawKey));
    this.#room = { roomId, fullLink, viewLink, browserLink, label: relay.label, source: relay.source, startedAt };
    return this.status();
  }

  /** End the current share (idempotent). */
  stop(reason = "host ended the session"): ShareStatus {
    this.#host?.stop(reason);
    this.#host = null;
    this.#room = null;
    this.#allowEdit = false;
    return IDLE;
  }

  /** Forward one live session event to the share, if active. */
  tapEvent(event: ChatEvent): void {
    this.#host?.pushEvent(event);
  }

  /** Record a local user prompt into the replay transcript, if active. */
  tapUserTurn(text: string): void {
    this.#host?.pushUserTurn(text);
  }

  status(): ShareStatus {
    if (!this.#host || !this.#room) return IDLE;
    return {
      active: true,
      roomId: this.#room.roomId,
      fullLink: this.#room.fullLink,
      viewLink: this.#room.viewLink,
      browserLink: this.#room.browserLink,
      relayLabel: this.#room.label,
      relaySource: this.#room.source,
      startedAt: this.#room.startedAt,
      allowEdit: this.#allowEdit,
      participantCount: this.#host.participantCount,
      participants: this.#host.participants(),
    };
  }
}
