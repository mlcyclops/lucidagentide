// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-REMOTE.12 (ADR-0251): push-to-talk voice clips on the guest prompt frame. The validator runs on
// BOTH ends fail-closed; the guest drops bad clips before they leave the phone, the host re-validates
// and never trusts the guest. Adversarial by design - this rides the same path that runs tools.

import { describe, expect, it } from "bun:test";
import { MAX_PROMPT_AUDIO_BYTES, validPromptAudio, type LucidCollabFrame, type PromptFrame } from "./frames.ts";
import { CollabGuest, type GuestTransport } from "./guest.ts";

const clip = { b64: "QUJDREVGRw==", mime: "audio/wav" };

describe("validPromptAudio - fail-closed on both ends", () => {
  it("accepts real clips: wav, webm, mp4, ogg", () => {
    for (const mime of ["audio/wav", "audio/x-wav", "audio/webm", "audio/webm;codecs=opus", "audio/mp4", "audio/ogg"]) {
      expect(validPromptAudio({ b64: clip.b64, mime })).toBe(true);
    }
  });
  it("rejects wrong shapes, empty payloads, and non-audio mimes", () => {
    for (const bad of [null, undefined, "hi", 42, {}, { b64: "", mime: "audio/wav" }, { b64: clip.b64 }, { mime: "audio/wav" },
      { b64: clip.b64, mime: "video/mp4" }, { b64: clip.b64, mime: "text/html" }, { b64: clip.b64, mime: "image/png" },
      { b64: clip.b64, mime: "audiox/wav" }]) {
      expect(validPromptAudio(bad)).toBe(false);
    }
  });
  it("rejects non-base64 payloads (no smuggling structured data in the clip field)", () => {
    expect(validPromptAudio({ b64: "<script>alert(1)</script>", mime: "audio/wav" })).toBe(false);
    expect(validPromptAudio({ b64: "abc def", mime: "audio/wav" })).toBe(false);
  });
  it("rejects clips over the hard cap", () => {
    const huge = "A".repeat(Math.ceil((MAX_PROMPT_AUDIO_BYTES * 4) / 3) + 8);
    expect(validPromptAudio({ b64: huge, mime: "audio/wav" })).toBe(false);
  });
});

class MockTransport implements GuestTransport {
  onOpen?: () => void;
  onFrame?: (frame: LucidCollabFrame, fromPeer: number) => void;
  onClose?: (reason: string, willReconnect: boolean) => void;
  sent: { frame: LucidCollabFrame; targetPeer?: number }[] = [];
  connect(): void { this.onOpen?.(); }
  send(frame: LucidCollabFrame, targetPeer?: number): void { this.sent.push({ frame, targetPeer }); }
  close(): void { /* test */ }
}

/** Drive a guest to LIVE edit state: hello, then a welcome with readOnly false. */
function liveGuest(): { g: CollabGuest; t: MockTransport } {
  const t = new MockTransport();
  const g = new CollabGuest(t, { name: "bob" });
  g.start();
  t.onFrame?.({
    t: "welcome", protocol: 1,
    header: { sessionId: "s", title: "t", model: "m", hostName: "h", startedAt: 1 },
    transcript: [], participants: [], readOnly: false,
  } as LucidCollabFrame, 0);
  t.sent = [];
  return { g, t };
}

describe("guest sendPrompt with audio", () => {
  it("an audio-only prompt sends a frame carrying the clip", () => {
    const { g, t } = liveGuest();
    expect(g.sendPrompt("", undefined, clip)).toBe(true);
    const f = t.sent[0]!.frame as PromptFrame;
    expect(f.t).toBe("prompt");
    expect(f.audio).toEqual(clip);
    expect(t.sent[0]!.targetPeer).toBe(0); // straight to the host
  });
  it("an invalid clip is dropped ON the phone - text still sends, audio-only does not", () => {
    const { g, t } = liveGuest();
    expect(g.sendPrompt("hello", undefined, { b64: clip.b64, mime: "text/html" } )).toBe(true);
    expect((t.sent[0]!.frame as PromptFrame).audio).toBeUndefined();
    expect(g.sendPrompt("", undefined, { b64: "", mime: "audio/wav" })).toBe(false); // nothing to send
  });
});
