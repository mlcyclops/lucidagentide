// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/model_folder_select.test.ts — P-COLLAB.14 (ADR-0228): edit-guest MODEL + already-used-FOLDER
// selection. Drives CollabHost + CollabGuest through MOCK transports (no relay, no sockets) so the whole
// slice is proven headless:
//   - the host OFFERS its model + folder allowlists to an EDIT guest only (a view guest never learns them),
//   - a guest's set-model / set-workspace is edit-gated AND allowlist-validated fail-closed (an unknown
//     model/id is refused, never handed to the callback),
//   - setOptions rebroadcasts state + fresh options to edit guests only, and updates the reported model,
//   - the guest stores options + guards its own setModel/setWorkspace,
//   - renderControls emits escaped pickers for an edit guest only.

import { describe, expect, it } from "bun:test";
import { CollabHost, type HostTransport } from "./host.ts";
import { CollabGuest, type GuestTransport, type GuestView } from "./guest.ts";
import { COLLAB_PROTOCOL_VERSION } from "./frames.ts";
import type { CollabOptions, LucidCollabFrame, OptionsFrame } from "./frames.ts";
import { renderControls } from "./pwa_view.ts";
import { generateWriteToken } from "./crypto.ts";

function b64url(b: Uint8Array): string { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }

const HEADER = { sessionId: "s1", title: "Pair on the guard", model: "claude-haiku-4-5", hostName: "alice", startedAt: 1000 };
const OPTIONS: CollabOptions = {
  models: [{ value: "claude-haiku-4-5", name: "Haiku 4.5" }, { value: "claude-opus-4-8", name: "Opus 4.8" }],
  activeModel: "claude-haiku-4-5",
  workspaces: [{ id: "w-cur", name: "project-alpha", isGit: true }, { id: "w-old", name: "sandbox", isGit: false }],
  activeWorkspaceId: "w-cur",
};

/** Captures every frame the host sends + lets a test inject guest frames (a hello, then write frames). */
class HostMock implements HostTransport {
  onOpen?: () => void;
  onFrame?: (frame: LucidCollabFrame, fromPeer: number) => void;
  onControl?: (msg: { t: "peer-joined" | "peer-left"; peer: number }) => void;
  onClose?: (reason: string, willReconnect: boolean) => void;
  sent: { frame: LucidCollabFrame; targetPeer: number }[] = [];
  connect(): void { this.onOpen?.(); }
  send(frame: LucidCollabFrame, targetPeer = 0): void { this.sent.push({ frame, targetPeer }); }
  close(): void {}
  hello(peer: number, name: string, token?: string): void { this.onFrame?.({ t: "hello", protocol: COLLAB_PROTOCOL_VERSION, name, ...(token ? { writeToken: token } : {}) }, peer); }
  guest(peer: number, frame: LucidCollabFrame): void { this.onFrame?.(frame, peer); }
  framesTo(peer: number): LucidCollabFrame[] { return this.sent.filter((s) => s.targetPeer === peer).map((s) => s.frame); }
  optionsTo(peer: number): OptionsFrame[] { return this.framesTo(peer).filter((f): f is OptionsFrame => f.t === "options"); }
  reset(): void { this.sent = []; }
}

function newHost(t: HostMock, token: Uint8Array, sets: { models: string[]; workspaces: string[] }) {
  const host = new CollabHost(t, {
    header: HEADER,
    writeToken: token,
    allowGuestWrite: true,
    options: OPTIONS,
    onGuestSetModel: (value) => sets.models.push(value),
    onGuestSetWorkspace: (id) => sets.workspaces.push(id),
  });
  host.start();
  return host;
}

describe("CollabHost model/folder selection (P-COLLAB.14)", () => {
  it("unicasts the model + folder allowlists to an EDIT guest on join, but NOT to a view guest", () => {
    const t = new HostMock();
    const token = generateWriteToken();
    newHost(t, token, { models: [], workspaces: [] });

    t.hello(5, "editor", b64url(token)); // full-link guest -> EDIT
    t.hello(6, "watcher");               // view-only guest

    const editOptions = t.optionsTo(5);
    expect(editOptions.length).toBe(1);
    expect(editOptions[0]!.options).toEqual(OPTIONS);
    expect(t.optionsTo(6).length).toBe(0); // a view guest never receives the allowlists
  });

  it("applies a set-model / set-workspace only for an ALLOWLISTED value (fail-closed)", () => {
    const t = new HostMock();
    const token = generateWriteToken();
    const sets = { models: [] as string[], workspaces: [] as string[] };
    newHost(t, token, sets);
    t.hello(5, "editor", b64url(token));
    t.reset();

    t.guest(5, { t: "set-model", value: "claude-opus-4-8" });   // in the allowlist
    t.guest(5, { t: "set-workspace", id: "w-old" });            // in the allowlist
    expect(sets.models).toEqual(["claude-opus-4-8"]);
    expect(sets.workspaces).toEqual(["w-old"]);
    expect(t.framesTo(5).filter((f) => f.t === "error").length).toBe(0);

    t.guest(5, { t: "set-model", value: "evil/model" });        // NOT offered
    t.guest(5, { t: "set-workspace", id: "../etc" });           // NOT offered
    expect(sets.models).toEqual(["claude-opus-4-8"]); // unchanged - the bad pick never reached the callback
    expect(sets.workspaces).toEqual(["w-old"]);
    expect(t.framesTo(5).filter((f) => f.t === "error").length).toBe(2); // both refused with an error frame
  });

  it("refuses a VIEW guest's set-model / set-workspace host-side (read-only)", () => {
    const t = new HostMock();
    const token = generateWriteToken();
    const sets = { models: [] as string[], workspaces: [] as string[] };
    newHost(t, token, sets);
    t.hello(6, "watcher"); // no token -> view only
    t.reset();

    t.guest(6, { t: "set-model", value: "claude-opus-4-8" }); // even an allowlisted value
    t.guest(6, { t: "set-workspace", id: "w-old" });
    expect(sets.models).toEqual([]);
    expect(sets.workspaces).toEqual([]);
    const errs = t.framesTo(6).filter((f): f is { t: "error"; message: string } => f.t === "error");
    expect(errs.length).toBe(2);
    expect(errs[0]!.message).toContain("read-only");
  });
});

describe("CollabHost.setOptions broadcast (P-COLLAB.14)", () => {
  it("state to everyone (new model) + options only to edit guests", () => {
    const t = new HostMock();
    const token = generateWriteToken();
    const host = newHost(t, token, { models: [], workspaces: [] });
    t.hello(5, "editor", b64url(token));
    t.hello(6, "watcher");
    t.reset();

    const next: CollabOptions = { ...OPTIONS, activeModel: "claude-opus-4-8", activeWorkspaceId: "w-old" };
    host.setOptions(next);

    const bcast = t.sent.filter((s) => s.targetPeer === 0).map((s) => s.frame);
    const state = bcast.find((f): f is { t: "state"; participants: unknown[]; model: string; contextPct: number | null } => f.t === "state");
    expect(state?.model).toBe("claude-opus-4-8"); // the reported model followed the switch

    expect(t.optionsTo(5).length).toBe(1);          // edit guest gets fresh options
    expect(t.optionsTo(5)[0]!.options).toEqual(next);
    expect(t.optionsTo(6).length).toBe(0);          // view guest never does
  });
});

/** The slice of CollabSocket the guest needs; delivers host frames + records what the guest sends. */
class GuestMock implements GuestTransport {
  onOpen?: () => void;
  onFrame?: (frame: LucidCollabFrame, fromPeer: number) => void;
  onClose?: (reason: string, willReconnect: boolean) => void;
  sent: LucidCollabFrame[] = [];
  connect(): void { this.onOpen?.(); }
  send(frame: LucidCollabFrame): void { this.sent.push(frame); }
  close(): void {}
  host(frame: LucidCollabFrame): void { this.onFrame?.(frame, 0); }
}

function liveEditGuest(t: GuestMock): { guest: CollabGuest; options: CollabOptions[] } {
  const options: CollabOptions[] = [];
  const guest = new CollabGuest(t, { name: "editor" }, { onOptions: (o) => options.push(o) });
  guest.start();
  // an EDIT welcome (readOnly false) makes the guest writable
  t.host({ t: "welcome", protocol: COLLAB_PROTOCOL_VERSION, header: HEADER, transcript: [], participants: [], readOnly: false });
  return { guest, options };
}

describe("CollabGuest model/folder selection (P-COLLAB.14)", () => {
  it("stores an options frame in the view + fires onOptions", () => {
    const t = new GuestMock();
    const { guest, options } = liveEditGuest(t);
    t.host({ t: "options", options: OPTIONS });
    expect(guest.view().options).toEqual(OPTIONS);
    expect(options).toEqual([OPTIONS]);
  });

  it("setModel/setWorkspace send the frame for an OFFERED value, refuse otherwise", () => {
    const t = new GuestMock();
    const { guest } = liveEditGuest(t);
    t.host({ t: "options", options: OPTIONS });
    t.sent = [];

    expect(guest.setModel("claude-opus-4-8")).toBe(true);
    expect(guest.setWorkspace("w-old")).toBe(true);
    expect(t.sent).toEqual([{ t: "set-model", value: "claude-opus-4-8" }, { t: "set-workspace", id: "w-old" }]);

    t.sent = [];
    expect(guest.setModel("not-offered")).toBe(false);   // client-side allowlist guard
    expect(guest.setWorkspace("not-offered")).toBe(false);
    expect(t.sent).toEqual([]); // nothing hit the wire
  });

  it("setModel/setWorkspace are refused (no frame) when read-only", () => {
    const t = new GuestMock();
    const options: CollabOptions[] = [];
    const guest = new CollabGuest(t, { name: "watcher" }, { onOptions: (o) => options.push(o) });
    guest.start();
    t.host({ t: "welcome", protocol: COLLAB_PROTOCOL_VERSION, header: HEADER, transcript: [], participants: [], readOnly: true });
    t.host({ t: "options", options: OPTIONS }); // a well-behaved host wouldn't send this to a viewer, but guard anyway
    t.sent = [];
    expect(guest.setModel("claude-opus-4-8")).toBe(false);
    expect(guest.setWorkspace("w-old")).toBe(false);
    expect(t.sent).toEqual([]);
  });
});

describe("renderControls (P-COLLAB.14)", () => {
  const editView: GuestView = {
    phase: "live", header: null, transcript: [], participants: [],
    model: "claude-haiku-4-5", contextPct: null, readOnly: false, options: OPTIONS, note: null,
  };

  it("returns empty for a view guest, an ended session, or no options", () => {
    expect(renderControls({ ...editView, readOnly: true })).toBe("");
    expect(renderControls({ ...editView, phase: "ended" })).toBe("");
    expect(renderControls({ ...editView, options: null })).toBe("");
  });

  it("emits model + folder selects with the active option pre-selected", () => {
    const html = renderControls(editView);
    expect(html).toContain('data-role="model"');
    expect(html).toContain('data-role="workspace"');
    // active model + active workspace id are the selected <option>s
    expect(html).toContain('<option value="claude-haiku-4-5" selected>Haiku 4.5</option>');
    expect(html).toContain('<option value="w-cur" selected>project-alpha · git</option>');
    expect(html).toContain('<option value="w-old">sandbox</option>'); // non-git, not selected
  });

  it("escapes hostile model/folder names (host-authored text is data, never markup)", () => {
    const evil: CollabOptions = {
      models: [{ value: "m1", name: "<img src=x onerror=alert(1)>" }],
      activeModel: "m1",
      workspaces: [{ id: "w1", name: "</select><script>alert(1)</script>", isGit: false }],
      activeWorkspaceId: "w1",
    };
    const html = renderControls({ ...editView, options: evil });
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;/select&gt;&lt;script&gt;");
  });
});
