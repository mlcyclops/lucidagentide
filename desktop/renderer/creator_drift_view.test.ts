// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import {
  DRIFT_ENABLE_STEPS, creatorDriftHtml, driftConnectBlock, driftExportBlock, driftExportTarget, driftInspectFromPayload, newestUndoableIsAgent,
  type CreatorDriftView, type DriftActivityView,
} from "./creator_drift_view.ts";

const entry = (over: Partial<DriftActivityView> = {}): DriftActivityView => ({
  seq: 1, at: 1_700_000_000_000, source: "agent", tool: "apply", ok: true, summary: "apply: 2 ops (place_clip, set_duration)", undoable: true, revision: 4, ...over,
});

const view = (over: Partial<CreatorDriftView> = {}): CreatorDriftView => ({
  installed: true, exePath: "C:\\Program Files\\Drift\\drift.exe",
  session: { path: "C:/Users/me/drift/mcp-session.json", present: true, port: 4731, pid: 5152, error: "" },
  endpoint: { id: "drift-session", label: "Drift (Agent access session)", baseUrl: "http://127.0.0.1:4731", source: "session", cui: { posture: "on-device", allowed: true, reason: "runs on this machine" } },
  lockdown: false, probe: null, version: "0.7.2", activity: [], lastSeq: 0,
  inspect: null, inspectNote: "", captureAt: "", captureSrc: "", sheetSrc: "",
  exportPath: "C:\\Videos\\cut.mp4", exportFormat: "mp4", exportProgress: null, exportState: "", exportedPath: "", artifactId: "",
  busy: "", status: "", statusTone: "", ...over,
});

describe("Drift connect gate", () => {
  test("a live session on an allowed endpoint may be used", () => {
    expect(driftConnectBlock(view())).toBe("");
  });

  test("each unreachable state names itself and how to fix it", () => {
    expect(driftConnectBlock(view({ busy: "Capturing..." }))).toBe("Capturing...");
    const off = driftConnectBlock(view({ endpoint: null, session: { ...view().session, present: false, port: 0, pid: 0 } }));
    expect(off).toContain("Agent access is off");
    expect(off).toContain(DRIFT_ENABLE_STEPS);
    const missing = driftConnectBlock(view({ endpoint: null, installed: false, exePath: "", session: { ...view().session, present: false } }));
    expect(missing).toContain("not installed");
    expect(missing).toContain("headless");
    const stale = driftConnectBlock(view({ endpoint: null, session: { ...view().session, present: true, error: "port is not a number" } }));
    expect(stale).toContain("port is not a number");
    expect(stale).toContain(DRIFT_ENABLE_STEPS);
  });

  test("the CUI refusal is stated with the server's reason", () => {
    const v = view({ endpoint: { ...view().endpoint!, cui: { posture: "cloud", allowed: false, reason: "declared endpoint is off this machine" } } });
    expect(driftConnectBlock(v)).toBe("Refused under CUI lockdown: declared endpoint is off this machine");
  });
});

describe("Drift export gate", () => {
  test("needs a reachable Drift, then an absolute output path, and never a second export at once", () => {
    expect(driftExportBlock(view())).toBe("");
    expect(driftExportBlock(view({ exportPath: "/tmp/cut.webm", exportFormat: "webm" }))).toBe("");
    expect(driftExportBlock(view({ exportPath: "cut.mp4" }))).toContain("absolute output path");
    expect(driftExportBlock(view({ exportPath: "   " }))).toContain("absolute output path");
    expect(driftExportBlock(view({ exportState: "running", exportProgress: 42.4 }))).toBe("Export in progress (42%)...");
    expect(driftExportBlock(view({ endpoint: null }))).toContain("Agent access is off");
  });
});

describe("Drift export target", () => {
  test("the extension wins over the select, a bare path gets the selected one, and gif sets the flag", () => {
    // Codecs follow the container: Drift otherwise reuses the last export's codec and a .webm fails its file header.
    expect(driftExportTarget("C:\\Videos\\cut", "webm")).toEqual({ path: "C:\\Videos\\cut.webm", format: "webm", gif: false, args: { path: "C:\\Videos\\cut.webm", wait: false, video: "vp9", audio: "opus" } });
    expect(driftExportTarget("C:\\Videos\\cut.GIF", "mp4")).toEqual({ path: "C:\\Videos\\cut.GIF", format: "gif", gif: true, args: { path: "C:\\Videos\\cut.GIF", wait: false, gif: true } });
    expect(driftExportTarget("/out/final.mp4 ", "gif")).toEqual({ path: "/out/final.mp4", format: "mp4", gif: false, args: { path: "/out/final.mp4", wait: false, video: "h264", audio: "aac" } });
    expect(driftExportTarget("/out.dir/final", "mp4").path).toBe("/out.dir/final.mp4");
    expect(driftExportTarget("/out/final.mov", "webm")).toMatchObject({ path: "/out/final.mov", format: "webm", gif: false, args: { video: "h264", audio: "aac" } });
  });
});

describe("Drift pane markup", () => {
  test("shows the enable steps when the session is absent and the refusal when CUI says no", () => {
    const off = creatorDriftHtml(view({ endpoint: null, session: { ...view().session, present: false } }), 0);
    expect(off).toContain("Agent access to On");
    expect(off).toContain("data-cdr-connect");
    const refused = creatorDriftHtml(view({ endpoint: { ...view().endpoint!, cui: { posture: "cloud", allowed: false, reason: "off this machine" } } }), 0);
    expect(refused).toContain("Refused under CUI lockdown: off this machine");
    expect(refused).toContain("data-cdr-capture disabled");
    expect(refused).toContain("data-cdr-export disabled");
  });

  test("the license note is one block paragraph naming both licenses", () => {
    const html = creatorDriftHtml(view(), 0);
    const notes = html.match(/<p class="set-note cdr-note">[\s\S]*?<\/p>/g) ?? [];
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("CC BY-NC-SA 4.0");
    expect(notes[0]).toContain("GPL-3.0");
    expect(notes[0]).toContain("Drift Assets");
    expect(notes[0]).not.toContain("<span");
    expect(html).not.toContain("display:flex");
  });

  test("Undo last agent batch appears only when the newest undoable entry is the agent's", () => {
    const agentNewest = [entry({ seq: 3, source: "agent" }), entry({ seq: 2, source: "ui", tool: "split_clip" })];
    const userNewest = [entry({ seq: 3, source: "ui", tool: "split_clip" }), entry({ seq: 2, source: "agent" })];
    const readOnlyOnTop = [entry({ seq: 4, source: "ui", tool: "inspect", undoable: false }), entry({ seq: 3, source: "agent" })];
    expect(newestUndoableIsAgent(agentNewest)).toBe(true);
    expect(newestUndoableIsAgent(userNewest)).toBe(false);
    expect(newestUndoableIsAgent(readOnlyOnTop)).toBe(true);
    expect(newestUndoableIsAgent([])).toBe(false);
    expect(creatorDriftHtml(view({ activity: agentNewest }), 0)).toContain("data-cdr-undo-agent");
    expect(creatorDriftHtml(view({ activity: userNewest }), 0)).not.toContain("data-cdr-undo-agent");
  });

  test("feed rows carry the source chip, and the Save to library button waits for a finished export", () => {
    const html = creatorDriftHtml(view({ activity: [entry({ source: "ui", tool: "split_clip", summary: "split_clip at 2.5s" })] }), 0);
    expect(html).toContain('class="cdr-src cdr-src-ui"');
    expect(html).toContain("split_clip at 2.5s");
    expect(creatorDriftHtml(view(), 0)).not.toContain("data-cdr-save");
    expect(creatorDriftHtml(view({ exportState: "done", exportedPath: "C:\\Videos\\cut.mp4" }), 0)).toContain("data-cdr-save");
    expect(creatorDriftHtml(view({ exportState: "done", exportedPath: "C:\\Videos\\cut.mp4", artifactId: "art-1" }), 0)).toContain('data-cdr-video="art-1"');
  });
});

describe("inspect summary", () => {
  test("reads the summary form Drift 0.7 actually returns (w/h/dur, clip count, one selected clip ref)", () => {
    // Observed from a live `inspect()` against Drift 0.7.0 through the engine route.
    const s = driftInspectFromPayload({
      ok: true, assets: [], clips: 1, dirty: true, dur: 5, export: { active: false, progress: 1 }, fps: 30, h: 360, name: "Untitled Project",
      overlap: false, path: "", playhead: 0, playing: false, revision: 3, selection: { clip: "d12075e9", index: 0, track: 0 },
      tracks: [{ clips: 1, hidden: false, i: 0, muted: false, type: "text" }, { clips: 0, hidden: false, i: 1, muted: false, type: "video" }],
      undo: { can: true, canRedo: false, depth: 1, hash: "c0c97af34603", index: 1 }, w: 640,
    });
    expect(s).toEqual({ name: "Untitled Project", width: 640, height: 360, fps: 30, duration: 5, tracks: 2, clips: 1, selection: 1, revision: 3, playhead: 0 });
  });

  test("the detail form (clips:true) counts the rows; no selection is 0; per-track counts are summed when no total is given", () => {
    const detail = driftInspectFromPayload({ ok: true, w: 1920, h: 1080, fps: 29.97, dur: 61.5, clips: [{ id: "a" }, { id: "b" }, { id: "c" }], tracks: [{ i: 0 }, { i: 1 }], revision: 12, playhead: 4.25 });
    expect(detail).toMatchObject({ width: 1920, height: 1080, duration: 61.5, tracks: 2, clips: 3, selection: 0, revision: 12, playhead: 4.25 });
    expect(driftInspectFromPayload({ tracks: [{ clips: 2 }, { clips: 3 }] }).clips).toBe(5);
  });

  test("an empty or malformed payload becomes zeros, never a throw", () => {
    expect(driftInspectFromPayload(null)).toEqual({ name: "Untitled Project", width: 0, height: 0, fps: 0, duration: 0, tracks: 0, clips: 0, selection: 0, revision: null, playhead: null });
    expect(driftInspectFromPayload("text").clips).toBe(0);
  });
});
