// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-REMOTE.13 (ADR-0251): the invisible hourly reconnect. The Cloud Run 60-minute WS cap stays (it
// backs the hourly token re-verify); presentedStatus masks a YOUNG transient flap as Live and never
// masks anything terminal.

import { describe, expect, it } from "bun:test";
import { RECONNECT_GRACE_MS, presentedStatus, statusLabel } from "./pwa_view.ts";
import type { GuestView } from "./guest.ts";

const base = {
  header: { sessionId: "s", title: "t", model: "m", hostName: "h", startedAt: 1 },
  transcript: [], participants: [], model: "m", contextPct: null, options: null,
};
const view = (phase: GuestView["phase"], over: Partial<GuestView> = {}): GuestView =>
  ({ ...base, phase, readOnly: false, note: null, ...over }) as GuestView;

describe("presentedStatus - the grace window", () => {
  it("a young flap presents as Live (drive or view wording preserved)", () => {
    const flapAt = 1000;
    const v = view("reconnecting", { note: "connection lost - retrying (idle)" });
    expect(presentedStatus(v, flapAt, flapAt + RECONNECT_GRACE_MS - 1)).toEqual({ text: "Live \u00b7 you can drive", tone: "live" });
    const ro = view("reconnecting", { readOnly: true, note: "connection lost" });
    expect(presentedStatus(ro, flapAt, flapAt + 500).text).toBe("Live \u00b7 view only");
  });
  it("a drop that outlives the grace shows the real reconnecting state", () => {
    const v = view("reconnecting", { note: "connection lost - retrying (idle)" });
    const st = presentedStatus(v, 1000, 1000 + RECONNECT_GRACE_MS);
    expect(st.tone).toBe("wait");
    expect(st).toEqual(statusLabel(v));
  });
  it("no flap timestamp = no masking (defensive: an unknown flap start is shown honestly)", () => {
    const v = view("reconnecting");
    expect(presentedStatus(v, 0, 99999).tone).toBe("wait");
  });
  it("terminal states are NEVER masked, grace or not", () => {
    const ended = view("ended", { note: "session ended" });
    expect(presentedStatus(ended, Date.now(), Date.now() + 1).tone).toBe("ended");
    const fatalNote = view("live", { note: "kicked" }); // a note without reconnecting = terminal styling
    expect(presentedStatus(fatalNote, 1000, 1001)).toEqual(statusLabel(fatalNote));
  });
  it("healthy live passes straight through", () => {
    expect(presentedStatus(view("live"), 0, 5000)).toEqual({ text: "Live \u00b7 you can drive", tone: "live" });
  });
});
