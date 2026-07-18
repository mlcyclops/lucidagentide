// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/host.ts — P-COLLAB.2 (ADR-0192): the view-only broadcast HOST.
//
// The host owns the room and mirrors the LIVE session out to every joined guest. It is transport-agnostic:
// it drives a `HostTransport` (the real `CollabSocket`, or a mock in tests), so the whole host protocol is
// unit-testable headless. Responsibilities:
//   - Answer a guest `hello` with a `welcome` (session header + recent transcript + current roster + the
//     guest's read-only flag), unicast to that peer.
//   - Broadcast every LUCID `ChatEvent` as an `event` frame so guests render the turn natively.
//   - Keep a rolling roster + transcript, and push a `state` frame on every join/leave.
//   - On stop, broadcast `bye` and close the transport.
//
// Security posture (invariant #3, fail-closed): Phase 1 is VIEW-ONLY. Even a guest that presents a valid write
// token is registered read-only and its (future) prompt/abort frames are refused - guest WRITE, which runs
// tools on the HOST's machine, only lands in P-COLLAB.3 behind the host's scan gate. A protocol-version
// mismatch is refused with an `error` frame, never guessed. We never broadcast credentials or file paths -
// only the session model's own `ChatEvent`s and a metadata header.

import type { ChatEvent } from "../renderer/chat_events.ts";
import type {
  CollabOptions,
  CollabParticipant,
  CollabSessionHeader,
  CollabTranscriptTurn,
  GuestFrame,
  HelloFrame,
  LucidCollabFrame,
} from "./frames.ts";
import { COLLAB_PROTOCOL_VERSION, isGuestFrame } from "./frames.ts";
import type { RelayControlMessage } from "@oh-my-pi/pi-wire";

/** The slice of {@link CollabSocket} the host needs - so a mock transport can stand in for tests. */
export interface HostTransport {
  onOpen?: () => void;
  onFrame?: (frame: LucidCollabFrame, fromPeer: number) => void;
  onControl?: (msg: RelayControlMessage) => void;
  onClose?: (reason: string, willReconnect: boolean) => void;
  connect(): void;
  send(frame: LucidCollabFrame, targetPeer?: number): void;
  close(): void;
}

export interface HostStartOpts {
  header: CollabSessionHeader;
  /** The full-link write token bytes (base64url-compared against a guest's `hello.writeToken`), or null for a
   *  view-only room. Held so P-COLLAB.3 can authorize guest writes; in Phase 1 it only sets a guest's
   *  potential access, never grants an actual write. */
  writeToken?: Uint8Array | null;
  /** Default false: no guest may drive the host, regardless of link. Set true (with a full-link write token)
   *  to grant EDIT. Even then, a guest prompt runs on the host through the fail-closed scan gate + approvals. */
  allowGuestWrite?: boolean;
  /** Cap on replayed transcript turns in `welcome` (keeps a big session's welcome bounded). */
  transcriptLimit?: number;
  /** P-COLLAB.12: an EDIT guest sent a prompt to run in the host's session. The host wires this to its own
   *  prompt path, so the turn passes the SAME scan gate + exec/egress approvals as a local prompt.
   *  P-REMOTE.8: `images` (validated data URLs) ride along as vision input, staged into the host composer. */
  onGuestPrompt?: (text: string, guest: CollabParticipant, images?: string[]) => void;
  /** P-COLLAB.12: an EDIT guest asked to stop the in-flight turn. */
  onGuestAbort?: (guest: CollabParticipant) => void;
  /** P-COLLAB.14: the pickable model + already-used-folder allowlists offered to EDIT guests (unicast on
   *  join, rebroadcast on `setOptions`). null = none offered (no pickers appear). */
  options?: CollabOptions | null;
  /** P-COLLAB.14: an EDIT guest picked a model from `options.models`. The host has already re-validated the
   *  value is in the allowlist; wire this to the host's own model-switch path (its UI + omp reconcile). */
  onGuestSetModel?: (value: string, guest: CollabParticipant) => void;
  /** P-COLLAB.14: an EDIT guest picked an already-used folder by its OPAQUE id (validated against
   *  `options.workspaces`). Wire this to the host's own workspace-switch path (resolves id->path locally +
   *  restarts the agent in the new cwd). */
  onGuestSetWorkspace?: (id: string, guest: CollabParticipant) => void;
  /** P-COLLAB.18 (ADR-0204): a guest joined ("join", on its `hello`) or left ("leave", on relay peer-left).
   *  Host-authoritative audit hook — the caller records a metadata-only telemetry event. */
  onParticipant?: (kind: "join" | "leave", guest: CollabParticipant) => void;
}

const DEFAULT_TRANSCRIPT_LIMIT = 40;
const MAX_NAME_LEN = 48;

/** A live view-only share. Construct with a wired transport, `start()`, then feed it the session's events. */
export class CollabHost {
  readonly #transport: HostTransport;
  #header: CollabSessionHeader;
  #writeTokenB64: string | null;
  #allowGuestWrite: boolean;
  #transcriptLimit: number;
  #onGuestPrompt?: (text: string, guest: CollabParticipant, images?: string[]) => void;
  #onGuestAbort?: (guest: CollabParticipant) => void;
  #onParticipant?: (kind: "join" | "leave", guest: CollabParticipant) => void;
  #onGuestSetModel?: (value: string, guest: CollabParticipant) => void;
  #onGuestSetWorkspace?: (id: string, guest: CollabParticipant) => void;
  #options: CollabOptions | null;

  #participants = new Map<number, CollabParticipant>();
  #transcript: CollabTranscriptTurn[] = [];
  #model: string;
  #contextPct: number | null = null;
  #stopped = false;

  constructor(transport: HostTransport, opts: HostStartOpts) {
    this.#transport = transport;
    this.#header = opts.header;
    this.#model = opts.header.model;
    this.#writeTokenB64 = opts.writeToken ? b64url(opts.writeToken) : null;
    this.#allowGuestWrite = opts.allowGuestWrite ?? false;
    this.#transcriptLimit = opts.transcriptLimit ?? DEFAULT_TRANSCRIPT_LIMIT;
    this.#onGuestPrompt = opts.onGuestPrompt;
    this.#onGuestAbort = opts.onGuestAbort;
    this.#onParticipant = opts.onParticipant;
    this.#onGuestSetModel = opts.onGuestSetModel;
    this.#onGuestSetWorkspace = opts.onGuestSetWorkspace;
    this.#options = opts.options ?? null;
  }

  /** Wire the transport callbacks and open the relay connection. */
  start(): void {
    this.#transport.onFrame = (frame, fromPeer) => this.#onFrame(frame, fromPeer);
    this.#transport.onControl = (msg) => this.#onControl(msg);
    this.#transport.connect();
  }

  /** Current roster snapshot (host is implicit; these are the joined guests). */
  participants(): CollabParticipant[] {
    return [...this.#participants.values()];
  }

  get participantCount(): number {
    return this.#participants.size;
  }

  /** Record a user prompt into the replay transcript AND broadcast it LIVE (P-COLLAB.15) so every joined guest
   *  sees who typed what, in order. `from` is the author's display name (default: the host's own name). */
  pushUserTurn(text: string, from?: string): void {
    const clipped = clip(text);
    this.#appendTranscript({ role: "user", text: clipped });
    if (this.#stopped) return;
    this.#broadcast({ t: "user-turn", text: clipped, from: (from || this.#header.hostName || "host") });
  }

  /** P-COLLAB.14: refresh the pickable model + already-used-folder allowlists (call when the host switches
   *  either, by a guest or locally). Updates the reported model + header, then rebroadcasts `state` to everyone
   *  and unicasts the fresh `options` to each EDIT guest (a view guest never receives folder/model lists).
   *  No-op once stopped. */
  setOptions(options: CollabOptions | null): void {
    if (this.#stopped) return;
    this.#options = options;
    if (options?.activeModel) {
      this.#model = options.activeModel;
      this.#header = { ...this.#header, model: options.activeModel };
    }
    this.#broadcastState();
    if (!options) return;
    for (const g of this.#participants.values()) {
      if (g.access === "edit") this.#transport.send({ t: "options", options }, g.peerId);
    }
  }

  /**
   * Feed one LUCID session event to the share: broadcast it to guests, and fold `done`/`usage` into the
   * host's transcript + status so a later joiner's `welcome` reflects the current state.
   */
  pushEvent(event: ChatEvent): void {
    if (this.#stopped) return;
    // Fold state BEFORE broadcasting so a race-y join still gets a consistent welcome.
    if (event.type === "done" && typeof event.text === "string" && event.text.trim()) {
      this.#appendTranscript({ role: "assistant", text: clip(event.text) });
    } else if (event.type === "usage" && event.size > 0) {
      this.#contextPct = Math.min(100, Math.round((event.used / event.size) * 100));
    }
    this.#broadcast({ t: "event", event });
  }

  /** End the share: tell guests, drop the roster, close the socket. Idempotent. */
  stop(reason = "host ended the session"): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#broadcast({ t: "bye", reason });
    this.#participants.clear();
    this.#transport.close();
  }

  // ── internals ────────────────────────────────────────────────────────────

  #onFrame(frame: LucidCollabFrame, fromPeer: number): void {
    if (this.#stopped) return;
    if (!isGuestFrame(frame)) return; // a host must never receive a host frame; ignore
    const guest = frame as GuestFrame;
    if (guest.t === "hello") { this.#onHello(guest, fromPeer); return; }
    this.#onGuestWrite(guest, fromPeer); // prompt / abort / set-model / set-workspace (edit-gated + validated)
  }

  /** P-COLLAB.12: a guest prompt/abort. Fail-closed: only a registered EDIT guest may drive the host; anyone
   *  else (view-only, or an unknown peer) is refused with an `error` frame and never reaches the host session. */
  #onGuestWrite(frame: Exclude<GuestFrame, HelloFrame>, fromPeer: number): void {
    const guest = this.#participants.get(fromPeer);
    if (!guest || guest.access !== "edit") {
      this.#transport.send({ t: "error", message: "you are watching read-only - the host shared a view link" }, fromPeer);
      return;
    }
    switch (frame.t) {
      case "prompt": {
        const text = (frame.text ?? "").toString();
        // P-REMOTE.8: pass through any attached image data URLs; the host re-validates them fail-closed.
        const images = Array.isArray(frame.images) ? frame.images.filter((s): s is string => typeof s === "string") : undefined;
        if (text.trim() || (images && images.length)) this.#onGuestPrompt?.(text, guest, images);
        return;
      }
      case "abort":
        this.#onGuestAbort?.(guest);
        return;
      case "set-model": {
        // P-COLLAB.14 fail-closed: only a model the host actually offered may be applied - never an arbitrary id.
        const value = (frame.value ?? "").toString();
        if (this.#options?.models.some((m) => m.value === value)) this.#onGuestSetModel?.(value, guest);
        else this.#transport.send({ t: "error", message: "that model isn't available in this session" }, fromPeer);
        return;
      }
      case "set-workspace": {
        // P-COLLAB.14 fail-closed: only a folder id the host offered may be applied; it resolves id->path locally.
        const id = (frame.id ?? "").toString();
        if (this.#options?.workspaces.some((w) => w.id === id)) this.#onGuestSetWorkspace?.(id, guest);
        else this.#transport.send({ t: "error", message: "that folder isn't available in this session" }, fromPeer);
        return;
      }
    }
  }

  #onHello(hello: HelloFrame, fromPeer: number): void {
    if (hello.protocol !== COLLAB_PROTOCOL_VERSION) {
      // Refuse a mismatched guest explicitly - do not guess a wire shape (fail-closed).
      this.#transport.send(
        { t: "error", message: `protocol mismatch: host speaks v${COLLAB_PROTOCOL_VERSION}, guest sent v${hello.protocol}` },
        fromPeer,
      );
      return;
    }
    // Phase 1 is view-only: a guest is read-only unless writes are explicitly enabled AND it proves the token.
    const canWrite = this.#allowGuestWrite && this.#writeTokenValid(hello.writeToken);
    const participant: CollabParticipant = {
      peerId: fromPeer,
      name: cleanName(hello.name) || `guest-${fromPeer}`,
      role: "guest",
      access: canWrite ? "edit" : "view",
    };
    this.#participants.set(fromPeer, participant);
    this.#onParticipant?.("join", participant); // P-COLLAB.18: host-authoritative join audit

    // Unicast the welcome to the joiner, then refresh everyone's roster.
    this.#transport.send(
      {
        t: "welcome",
        protocol: COLLAB_PROTOCOL_VERSION,
        header: this.#header,
        transcript: this.#transcript.slice(-this.#transcriptLimit),
        participants: this.participants(),
        readOnly: !canWrite,
      },
      fromPeer,
    );
    this.#broadcastState();
    // P-COLLAB.14: an EDIT guest also gets the pickable model + already-used-folder allowlists (unicast). A
    // view guest never does, so it never learns the host's other project names.
    if (canWrite && this.#options) this.#transport.send({ t: "options", options: this.#options }, fromPeer);
  }

  #onControl(msg: RelayControlMessage): void {
    if (this.#stopped) return;
    if (msg.t === "peer-left") {
      const gone = this.#participants.get(msg.peer);
      if (this.#participants.delete(msg.peer)) {
        if (gone) this.#onParticipant?.("leave", gone); // P-COLLAB.18: host-authoritative leave audit
        this.#broadcastState();
      }
    }
    // `peer-joined` is informational; the guest's own `hello` is what registers it (with its name + token).
  }

  #writeTokenValid(presented: string | undefined): boolean {
    if (!this.#writeTokenB64 || !presented) return false;
    return timingSafeEqualStr(presented, this.#writeTokenB64);
  }

  #appendTranscript(turn: CollabTranscriptTurn): void {
    this.#transcript.push(turn);
    // Keep a little more than we replay, so folding recent state stays cheap.
    const cap = this.#transcriptLimit * 2;
    if (this.#transcript.length > cap) this.#transcript.splice(0, this.#transcript.length - cap);
  }

  #broadcast(frame: LucidCollabFrame): void {
    this.#transport.send(frame, 0);
  }

  #broadcastState(): void {
    this.#broadcast({ t: "state", participants: this.participants(), model: this.#model, contextPct: this.#contextPct });
  }
}

// ── helpers (pure) ───────────────────────────────────────────────────────────

const TRANSCRIPT_CLIP = 4_000; // per-turn text cap in the replay (keeps welcome bounded)

function clip(text: string): string {
  const t = text ?? "";
  return t.length > TRANSCRIPT_CLIP ? `${t.slice(0, TRANSCRIPT_CLIP)}…` : t;
}

/** Sanitize a guest-supplied display name: strip control chars, collapse whitespace, cap length. */
function cleanName(name: string | undefined): string {
  return (name ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LEN);
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Length-independent string compare - avoids leaking the write token via early-exit timing. */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
