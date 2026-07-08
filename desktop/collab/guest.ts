// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/guest.ts — P-COLLAB.4 (ADR-0192): the read-only GUEST.
//
// The guest joins a shared room and renders the host's live session. It is the mirror of CollabHost and, like
// it, transport-agnostic: it drives a `GuestTransport` (the real `CollabSocket`, or a mock in tests), so the
// whole guest protocol is unit-testable headless. On connect it announces itself with a `hello` (carrying its
// name and, if it holds a full link, the base64url write token for a future edit request), then dispatches the
// host frames it receives - `welcome` (the initial sync: header + replayed transcript + roster + read-only
// flag), `event` (a live ChatEvent), `state` (roster/model/context refresh), `bye` (the share ended), and
// `error` (a host-side refusal, e.g. a protocol mismatch).
//
// Phase 1 is VIEW-ONLY (invariant #3): the guest only ever SENDS a `hello`. It never sends a prompt/abort -
// guest WRITE, which would run tools on the host behind the host's fail-closed scan gate, is a later slice.
// A protocol-version mismatch is refused by surfacing the host's `error`, never by guessing a wire shape.

import type { ChatEvent } from "../renderer/chat_events.ts";
import type {
  CollabParticipant,
  CollabSessionHeader,
  CollabTranscriptTurn,
  HostFrame,
  LucidCollabFrame,
  WelcomeFrame,
} from "./frames.ts";
import { COLLAB_PROTOCOL_VERSION, isHostFrame } from "./frames.ts";

/** The slice of {@link CollabSocket} the guest needs - so a mock transport can stand in for tests. */
export interface GuestTransport {
  onOpen?: () => void;
  onFrame?: (frame: LucidCollabFrame, fromPeer: number) => void;
  onClose?: (reason: string, willReconnect: boolean) => void;
  connect(): void;
  send(frame: LucidCollabFrame, targetPeer?: number): void;
  close(): void;
}

export type GuestPhase = "connecting" | "live" | "reconnecting" | "ended";

export interface GuestView {
  phase: GuestPhase;
  header: CollabSessionHeader | null;
  transcript: CollabTranscriptTurn[];
  participants: CollabParticipant[];
  model: string;
  contextPct: number | null;
  readOnly: boolean;
  /** A terminal note for the UI (bye reason / host error / bad link), or null while healthy. */
  note: string | null;
}

export interface GuestCallbacks {
  /** The initial sync landed (safe to render the header + transcript). */
  onWelcome?: (w: WelcomeFrame) => void;
  /** A live session event to render read-only, in order. */
  onEvent?: (e: ChatEvent) => void;
  /** Roster / model / context changed. */
  onState?: (participants: CollabParticipant[], model: string, contextPct: number | null) => void;
  /** The share ended (host stopped, room closed, or a fatal socket close). */
  onEnd?: (reason: string) => void;
  /** A host-side refusal (protocol mismatch, etc.) - terminal for this join. */
  onError?: (message: string) => void;
  /** Any view change - a single sink the UI can re-render from. */
  onView?: (view: GuestView) => void;
}

export interface GuestStartOpts {
  name: string;
  /** Present only from a FULL link; sent in `hello` so a future guest-write can be authorized host-side. */
  writeToken?: Uint8Array | null;
}

export class CollabGuest {
  readonly #transport: GuestTransport;
  readonly #name: string;
  readonly #writeTokenB64: string | null;
  readonly #cb: GuestCallbacks;

  #phase: GuestPhase = "connecting";
  #header: CollabSessionHeader | null = null;
  #transcript: CollabTranscriptTurn[] = [];
  #participants: CollabParticipant[] = [];
  #model = "";
  #contextPct: number | null = null;
  #readOnly = true;
  #note: string | null = null;
  #ended = false;

  constructor(transport: GuestTransport, opts: GuestStartOpts, cb: GuestCallbacks = {}) {
    this.#transport = transport;
    this.#name = opts.name;
    this.#writeTokenB64 = opts.writeToken ? b64url(opts.writeToken) : null;
    this.#cb = cb;
  }

  /** Wire the transport, connect, and announce ourselves on open. */
  start(): void {
    this.#transport.onOpen = () => this.#sayHello();
    this.#transport.onFrame = (frame) => this.#onFrame(frame);
    this.#transport.onClose = (reason, willReconnect) => this.#onClose(reason, willReconnect);
    this.#transport.connect();
  }

  /** Leave the room (idempotent). */
  leave(reason = "you left the session"): void {
    if (this.#ended) return;
    this.#end(reason);
    this.#transport.close();
  }

  view(): GuestView {
    return {
      phase: this.#phase,
      header: this.#header,
      transcript: this.#transcript,
      participants: this.#participants,
      model: this.#model,
      contextPct: this.#contextPct,
      readOnly: this.#readOnly,
      note: this.#note,
    };
  }

  // ── internals ────────────────────────────────────────────────────────────

  #sayHello(): void {
    if (this.#ended) return;
    if (this.#phase === "reconnecting") this.#phase = "connecting";
    this.#transport.send(
      { t: "hello", protocol: COLLAB_PROTOCOL_VERSION, name: this.#name, ...(this.#writeTokenB64 ? { writeToken: this.#writeTokenB64 } : {}) },
      0, // to the host
    );
  }

  #onFrame(frame: LucidCollabFrame): void {
    if (this.#ended) return;
    if (!isHostFrame(frame)) return; // a guest must never receive a guest frame; ignore
    const f = frame as HostFrame;
    switch (f.t) {
      case "welcome":
        this.#header = f.header;
        this.#transcript = f.transcript;
        this.#participants = f.participants;
        this.#model = f.header.model;
        this.#readOnly = f.readOnly;
        this.#phase = "live";
        this.#cb.onWelcome?.(f);
        this.#emit();
        break;
      case "event":
        this.#cb.onEvent?.(f.event);
        // fold done/usage so a late view() reflects the current state, mirroring the host
        if (f.event.type === "done" && typeof f.event.text === "string" && f.event.text.trim()) {
          this.#transcript = [...this.#transcript, { role: "assistant", text: f.event.text }];
          this.#emit();
        } else if (f.event.type === "usage" && f.event.size > 0) {
          this.#contextPct = Math.min(100, Math.round((f.event.used / f.event.size) * 100));
          this.#emit();
        }
        break;
      case "state":
        this.#participants = f.participants;
        this.#model = f.model;
        this.#contextPct = f.contextPct;
        this.#cb.onState?.(f.participants, f.model, f.contextPct);
        this.#emit();
        break;
      case "bye":
        this.#end(f.reason || "the host ended the session");
        break;
      case "error":
        this.#note = f.message;
        this.#cb.onError?.(f.message);
        this.#emit();
        break;
    }
  }

  #onClose(reason: string, willReconnect: boolean): void {
    if (this.#ended) return;
    if (willReconnect) {
      this.#phase = "reconnecting";
      this.#note = `connection lost - retrying (${reason})`;
      this.#emit();
      return;
    }
    this.#end(reason || "disconnected");
  }

  #end(reason: string): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#phase = "ended";
    this.#note = reason;
    this.#cb.onEnd?.(reason);
    this.#emit();
  }

  #emit(): void {
    this.#cb.onView?.(this.view());
  }
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
