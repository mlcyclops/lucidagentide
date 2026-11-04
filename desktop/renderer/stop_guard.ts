// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/stop_guard.ts - P-STOP-GUARD.1 (ADR-0472): a click on the composer button stops a turn
// only when the user aimed it at Stop.
//
// The composer's one button is Send while idle and Stop while a turn runs (P-ACP.4), and it changes face
// the instant a turn starts. Some turns start without a click at that moment: a held "next turn" prompt
// releasing when the previous turn ends, a voice send, a resumed run. A press aimed at Send (a double
// click on Send, or a click that landed just as one of those turns began) arrived on the Stop face and
// cancelled the new turn, which then read exactly like the user had pressed Stop. Pure: time arrives as
// arguments.

/** How long Stop must have been on screen before a press on it counts as a Stop. Long enough to cover a
 *  double click and a press already on its way when the face changed; short enough that a deliberate
 *  Stop right after sending still works. */
export const STOP_ARM_MS = 600;

export interface StopClick {
  /** A turn is running now (the button shows Stop). */
  streaming: boolean;
  /** When the button last changed from Send to Stop, epoch ms (0 = never). */
  stopShownAt: number;
  /** When the pointer went down on the button, epoch ms; null for a keyboard press (no pointer). */
  pressedAt: number | null;
  now: number;
}

/** What a click on the composer button means: "stop" the running turn, or "send" (which, mid-turn, is the
 *  hold-or-push choice and does nothing with an empty composer). A Stop needs the Stop face to have been
 *  showing for STOP_ARM_MS when the press began, so a press that began on Send never stops anything. */
export function stopClickIntent(c: StopClick): "stop" | "send" {
  if (!c.streaming) return "send";
  const pressed = c.pressedAt ?? c.now;
  if (!Number.isFinite(pressed) || !Number.isFinite(c.stopShownAt)) return "send";
  return pressed - c.stopShownAt >= STOP_ARM_MS ? "stop" : "send";
}
