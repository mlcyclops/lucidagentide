// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/guest.ts - P-COLLAB.4 (ADR-0192): the read-only GUEST.
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
  CollabOptions,
  CollabParticipant,
  CollabSessionHeader,
  CollabTranscriptTurn,
  HostFrame,
  LucidCollabFrame,
  WelcomeFrame,
} from "./frames.ts";
import { COLLAB_PROTOCOL_VERSION, isHostFrame, validPromptAudio, validSttSource } from "./frames.ts";
import type { PromptAudio, SttSource } from "./frames.ts";

/** P-REMOTE.14: the strictest posture, and the DEFAULT until a host frame says otherwise. Shared + frozen:
 *  every fail-closed path returns this exact object, so no caller can loosen it by mutation. */
const STRICT_POSTURE: { cui: boolean; lockdown: boolean } = Object.freeze({ cui: true, lockdown: true });

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
  /** P-COLLAB.14: the pickable model + already-used-folder allowlists an EDIT guest may switch to, or null
   *  (view guest, or a host that offered none). The PWA renders model/folder pickers only when this is set. */
  options: CollabOptions | null;
  /** A terminal note for the UI (bye reason / host error / bad link), or null while healthy. */
  note: string | null;
}

export interface GuestCallbacks {
  /** The initial sync landed (safe to render the header + transcript). */
  onWelcome?: (w: WelcomeFrame) => void;
  /** A live session event to render read-only, in order. */
  onEvent?: (e: ChatEvent) => void;
  /** P-PWA-FOCUS.1: a live event belonging to a FLEET LANE's conversation, arriving only for the lane this
   *  guest asked to watch. Separate from `onEvent` so an app cannot accidentally fold a lane's tokens into
   *  the master transcript: the lane id is not optional here. */
  onLaneEvent?: (laneId: string, e: ChatEvent) => void;
  /** P-PWA-FOCUS.1: the replay for a lane the guest just started watching, so switching to a lane that has
   *  been working for a while shows what it already said rather than an empty conversation. */
  onLaneSync?: (laneId: string, transcript: CollabTranscriptTurn[]) => void;
  /** Roster / model / context changed. */
  onState?: (participants: CollabParticipant[], model: string, contextPct: number | null) => void;
  /** The share ended (host stopped, room closed, or a fatal socket close). */
  onEnd?: (reason: string) => void;
  /** A host-side refusal (protocol mismatch, etc.) - terminal for this join. */
  onError?: (message: string) => void;
  /** P-COLLAB.14: the pickable model + already-used-folder allowlists arrived/changed (EDIT guest only). */
  onOptions?: (options: CollabOptions) => void;
  /** P-COLLAB.15: a user turn was submitted on the host (by the host or any guest), for live mirroring. */
  onUserTurn?: (text: string, from: string) => void;
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
  // P-REMOTE.14: the host's CUI + lockdown stance, learned from `welcome`/`state`. Starts STRICT so a phone
  // never offers cloud speech-to-text in the window before the first frame lands (fail-closed).
  #posture: { cui: boolean; lockdown: boolean } = STRICT_POSTURE;
  #options: CollabOptions | null = null;
  #note: string | null = null;
  #reconnecting = false; // P-REMOTE.8: a transient "connection lost - retrying" note is in #note; cleared on recovery
  #ended = false;
  // P-PWA-FOCUS.1: the conversation this guest is looking at. "master" is the default and the pre-focus
  // behaviour; a lane id means the host is also streaming that lane to us.
  #watching = "master";

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

  /** P-COLLAB.12: drive the host's session (EDIT access only - the host still gates every tool call). Returns
   *  false without sending when read-only or ended. The prompt runs on the HOST through its fail-closed gate.
   *  P-REMOTE.8: `images` (validated image data URLs) ride along as vision input; an image-only message (empty
   *  text) is allowed when at least one image is attached.
   *  P-REMOTE.12: `audio` is a push-to-talk clip the HOST transcribes; an audio-only message is allowed.
   *  Invalid/oversized audio is dropped HERE (fail-closed) - it never leaves the phone.
   *  P-REMOTE.14: `sttSource` declares where the text was transcribed (device_stt_policy.ts decides which).
   *  An unrecognized value is DROPPED rather than forwarded, so the host only ever sees a known claim. */
  sendPrompt(text: string, images?: string[], audio?: PromptAudio, sttSource?: SttSource): boolean {
    if (this.#ended || this.#readOnly) return false;
    const imgs = Array.isArray(images) ? images.filter((s) => typeof s === "string" && s) : [];
    const clip = validPromptAudio(audio) ? audio : undefined;
    const src = validSttSource(sttSource) ? sttSource : undefined;
    if (!text.trim() && imgs.length === 0 && !clip) return false;
    this.#transport.send({ t: "prompt", text, ...(imgs.length ? { images: imgs } : {}), ...(clip ? { audio: clip } : {}), ...(src ? { sttSource: src } : {}) }, 0); // 0 = the host
    return true;
  }

  /** P-PWA-FOCUS.1: declare which conversation this guest is LOOKING at, so the host streams that one and no
   *  other. `target` is "master" (or "") for the master session, else a lane id. Watching is READ-ONLY, so
   *  unlike every other method here it is NOT gated on edit access: a view guest may look at a lane, it just
   *  cannot drive it. Idempotent-safe to call on every focus change; the host answers a lane watch with a
   *  `lane-sync` replay. Returns false only when the session has ended. */
  watch(target: string): boolean {
    if (this.#ended) return false;
    this.#watching = target && target !== "master" ? target : "master";
    this.#transport.send({ t: "watch", target: this.#watching }, 0);
    return true;
  }

  /** P-PWA-FOCUS.1: the conversation this guest last asked to watch ("master" until it asks otherwise).
   *  Re-sent after a reconnect, because the host's per-peer subscription does not survive a new peer id. */
  watching(): string { return this.#watching; }

  /** P-COLLAB.12: stop the host's in-flight turn (EDIT access only). */
  abort(): boolean {
    if (this.#ended || this.#readOnly) return false;
    this.#transport.send({ t: "abort" }, 0);
    return true;
  }

  /** P-COLLAB.14: ask the host to switch the active model (EDIT access only). `value` must be one the host
   *  offered in `options.models`; the host re-validates too. Returns false without sending when read-only,
   *  ended, or the value isn't in the offered allowlist. */
  setModel(value: string): boolean {
    if (this.#ended || this.#readOnly || !value) return false;
    if (!this.#options?.models.some((m) => m.value === value)) return false;
    this.#transport.send({ t: "set-model", value }, 0);
    return true;
  }

  /** P-COLLAB.14: ask the host to switch to an already-used folder by its OPAQUE id (EDIT access only). The
   *  id must be one the host offered in `options.workspaces`; the host resolves id->path locally + restarts
   *  its agent in the new cwd. Returns false without sending when read-only, ended, or the id is unknown. */
  setWorkspace(id: string): boolean {
    if (this.#ended || this.#readOnly || !id) return false;
    if (!this.#options?.workspaces.some((w) => w.id === id)) return false;
    this.#transport.send({ t: "set-workspace", id }, 0);
    return true;
  }

  /** P-PWA-FLEET.1: prompt a fleet LANE on the host (EDIT access only - a view guest cannot steer). The
   *  host wiring runs it through the lane's own gate and queues it when the lane is mid-turn. */
  fleetPrompt(laneId: string, text: string): boolean {
    if (this.#ended || this.#readOnly || !laneId || !text.trim()) return false;
    this.#transport.send({ t: "fleet-prompt", laneId, text }, 0);
    return true;
  }

  /** P-PWA-FLEET.1: stop a fleet lane (EDIT access only). */
  fleetStop(laneId: string): boolean {
    if (this.#ended || this.#readOnly || !laneId) return false;
    this.#transport.send({ t: "fleet-stop", laneId }, 0);
    return true;
  }

  /** P-PWA-FLEET.1: answer a lane's pending approval (EDIT access only). `scope` "session" also remembers
   *  the ask's kind for the lane's lifetime; the host re-validates scope + edit rights fail-closed. */
  fleetAnswer(laneId: string, allow: boolean, scope?: "once" | "session"): boolean {
    if (this.#ended || this.#readOnly || !laneId) return false;
    this.#transport.send({ t: "fleet-answer", laneId, allow, ...(scope ? { scope } : {}) }, 0);
    return true;
  }

  /** P-PWA-FLEET.1: inject a mid-turn operator note into "master" or a laneId (EDIT access only - steering
   *  the agent is a write, so a view-only guest is refused here AND host-side). */
  interject(target: string, text: string): boolean {
    if (this.#ended || this.#readOnly || !target || !text.trim()) return false;
    this.#transport.send({ t: "interject", target, text }, 0);
    return true;
  }

  get readOnly(): boolean { return this.#readOnly; }

  /** P-REMOTE.14: the host's CUI + lockdown stance, for `decideSttMode`. Strict until a host frame proves
   *  otherwise, so the phone's first decision is always the safe one. */
  posture(): { cui: boolean; lockdown: boolean } { return this.#posture; }

  view(): GuestView {
    return {
      phase: this.#phase,
      header: this.#header,
      transcript: this.#transcript,
      participants: this.#participants,
      model: this.#model,
      contextPct: this.#contextPct,
      readOnly: this.#readOnly,
      options: this.#options,
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
    // P-PWA-FOCUS.1: the host keys its watch subscriptions by PEER ID, and a reconnect earns a new one, so a
    // lane the user was watching before the drop must be re-declared or the phone would sit on a silent lane
    // that looks alive. Cheap and idempotent, so it rides every hello rather than only the reconnecting ones.
    if (this.#watching !== "master") this.#transport.send({ t: "watch", target: this.#watching }, 0);
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
        this.#posture = readPosture(f.posture); // P-REMOTE.14: strict unless the host says otherwise
        this.#phase = "live";
        this.#reconnecting = false; // P-REMOTE.8: a fresh sync means we recovered - drop any stale retry note
        this.#note = null;
        this.#cb.onWelcome?.(f);
        this.#emit();
        break;
      case "event":
        // P-REMOTE.8: live traffic proves the socket recovered - clear the stale "reconnecting" banner.
        if (this.#clearReconnectNote()) this.#emit();
        // P-PWA-FOCUS.1: a LANE-scoped event belongs to that lane's conversation, so it is handed over with
        // its lane id and NEVER folded into the master transcript or the master's context gauge. The host
        // only sends these to a guest that asked to watch the lane, so an unrequested one is a host bug: it
        // is still routed by lane rather than silently absorbed into the master stream.
        if (f.lane) { this.#cb.onLaneEvent?.(f.lane, f.event); break; }
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
      case "lane-sync":
        // P-PWA-FOCUS.1: the replay for a lane we just started watching. Kept OUT of #transcript (that is the
        // master's) and handed to the app, which owns the per-target item lists.
        this.#cb.onLaneSync?.(f.lane, Array.isArray(f.transcript) ? f.transcript : []);
        break;
      case "state":
        this.#clearReconnectNote(); // P-REMOTE.8: recovered - the emit below repaints the status
        this.#participants = f.participants;
        this.#model = f.model;
        this.#contextPct = f.contextPct;
        this.#posture = readPosture(f.posture); // P-REMOTE.14: a mode flip re-decides device STT on the next record
        this.#cb.onState?.(f.participants, f.model, f.contextPct);
        this.#emit();
        break;
      case "options":
        // P-COLLAB.14: the model + already-used-folder allowlists (EDIT guest only). Stored for the pickers.
        this.#options = f.options;
        this.#cb.onOptions?.(f.options);
        this.#emit();
        break;
      case "user-turn":
        // P-COLLAB.15: a live user turn (host or another guest). The app folds it into the transcript.
        this.#cb.onUserTurn?.(f.text, f.from);
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
      this.#reconnecting = true; // P-REMOTE.8: mark the transient note so the next live host frame can clear it
      this.#note = `connection lost - retrying (${reason})`;
      this.#emit();
      return;
    }
    this.#end(reason || "disconnected");
  }

  /** P-REMOTE.8: a live host frame means the socket recovered - drop the transient "reconnecting" note (a
   *  terminal error/bye note is NOT touched: those set #note WITHOUT #reconnecting). Returns whether it
   *  cleared, so a caller that doesn't otherwise emit can repaint. */
  #clearReconnectNote(): boolean {
    if (!this.#reconnecting) return false;
    this.#reconnecting = false;
    if (this.#phase !== "live") this.#phase = "live";
    this.#note = null;
    return true;
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

/** P-REMOTE.14 fail-closed posture read: only an EXPLICIT `false` relaxes a half of the guarantee, so a
 *  missing field, a malformed frame, or an older host that knows nothing about posture all resolve to the
 *  strictest stance rather than to a cloud transcriber. */
function readPosture(p: unknown): { cui: boolean; lockdown: boolean } {
  if (!p || typeof p !== "object") return STRICT_POSTURE;
  const { cui, lockdown } = p as { cui?: unknown; lockdown?: unknown };
  if (cui !== false && lockdown !== false) return STRICT_POSTURE;
  return { cui: cui !== false, lockdown: lockdown !== false };
}
