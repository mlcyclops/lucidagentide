// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { DRIFT_HOMEPAGE_TOOLS, driftOpPolicy, isDriftMutation, isDriftReadTool, summarizeDriftCall } from "./drift_policy.ts";

describe("Drift read-only tool classification", () => {
  test("homepage read tools and status-style ops are read-only; apply, undo, export, import never are", () => {
    for (const t of ["catalog", "search", "toolbox", "inspect", "activity", "frames", "capture"]) expect(isDriftReadTool(t)).toBe(true);
    for (const t of ["list_clips", "get_job", "inspect_clip", "describe_track", "find_clips", "export_status", "market_status", "list_history", "ai_capabilities", "sample_depth"]) {
      expect(isDriftReadTool(t)).toBe(true);
    }
    for (const t of ["apply", "undo", "redo", "undo_to", "export_video", "import_media", "place_clip", "transcribe", "", "   "]) expect(isDriftReadTool(t)).toBe(false);
    expect(DRIFT_HOMEPAGE_TOOLS).toContain("apply");
  });
});

describe("CUI lockdown policy for Drift ops", () => {
  test("unlocked allows everything, even cloud voices", () => {
    expect(driftOpPolicy("tts_generate", { text: "hi" }, false)).toEqual({ allowed: true });
    expect(driftOpPolicy("market_search", { q: "lottie" }, false)).toEqual({ allowed: true });
  });

  test("locked refuses every voice op, every market op, and ElevenLabs transcription by name", () => {
    for (const t of ["tts_generate", "sfx_generate", "list_voices", "cloud_provider_status"]) {
      const v = driftOpPolicy(t, {}, true);
      expect(v.allowed).toBe(false);
      if (!v.allowed) { expect(v.tool).toBe(t); expect(v.reason).toContain("cloud voice"); }
    }
    for (const t of ["market_status", "market_search", "market_download"]) {
      const v = driftOpPolicy(t, {}, true);
      expect(v.allowed).toBe(false);
      if (!v.allowed) expect(v.reason).toContain("marketplace");
    }
    for (const t of ["transcribe", "diarize", "generate_subtitles"]) {
      expect(driftOpPolicy(t, { engine: "elevenlabs" }, true).allowed).toBe(false);
      expect(driftOpPolicy(t, { engine: "ElevenLabs" }, true).allowed).toBe(false);
      expect(driftOpPolicy(t, { engine: "local" }, true)).toEqual({ allowed: true });
      expect(driftOpPolicy(t, {}, true)).toEqual({ allowed: true });
    }
    expect(driftOpPolicy("place_clip", { clip: "u1" }, true)).toEqual({ allowed: true });
    expect(driftOpPolicy("install_addon", { id: "x" }, true)).toEqual({ allowed: true });
  });

  test("apply is checked op by op, and the refusal names the op and its index", () => {
    const ops = [{ tool: "place_clip", args: {} }, { tool: "transcribe", args: { engine: "elevenlabs" } }, { tool: "tts_generate" }];
    const v = driftOpPolicy("apply", { ops }, true);
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.tool).toBe("transcribe");
      expect(v.index).toBe(1);
      expect(v.reason).toContain("apply op 1 (transcribe)");
    }
    expect(driftOpPolicy("apply", { ops: [{ tool: "place_clip" }, { tool: "set_duration", args: { seconds: 3 } }] }, true)).toEqual({ allowed: true });
    expect(driftOpPolicy("apply", { ops: "nope" }, true)).toEqual({ allowed: true });
    expect(driftOpPolicy("apply", null, true)).toEqual({ allowed: true });
  });
});

describe("Drift mutation classification", () => {
  test("edits and apply are undoable; reads, playback, and undo itself are not", () => {
    // set_volume is a per-clip edit (Drift has no track volume), so it is undoable like any other clip op.
    for (const t of ["apply", "place_clip", "set_duration", "add_text", "export_video", "import_media", "delete_clip", "set_volume", "set_track"]) expect(isDriftMutation(t)).toBe(true);
    for (const t of ["inspect", "capture", "frames", "list_clips", "get_job", "play", "pause", "seek", "undo", "redo", "undo_to", "set_playhead", "select_clip", "set_overlap", ""]) {
      expect(isDriftMutation(t)).toBe(false);
    }
  });
});

describe("Drift activity summaries", () => {
  test("apply, export, capture, and plain ops each read as one line", () => {
    expect(summarizeDriftCall("apply", { ops: [{ tool: "place_clip" }, { tool: "set_duration" }, { tool: "add_text" }] }, { ok: true }, false))
      .toBe("apply: 3 ops (place_clip, set_duration, add_text)");
    expect(summarizeDriftCall("export_video", { path: "C:\\out\\cut.mp4" }, { ok: true, started: true, path: "C:\\out\\cut.mp4" }, false)).toBe("export_video -> C:\\out\\cut.mp4");
    expect(summarizeDriftCall("capture", { at: 2.5 }, { ok: true }, false)).toBe("capture at 2.5s");
    expect(summarizeDriftCall("capture", {}, { ok: true }, false)).toBe("capture at playhead");
    expect(summarizeDriftCall("inspect", {}, { ok: true, revision: 12 }, false)).toBe("inspect (revision 12)");
    expect(summarizeDriftCall("set_duration", { clip: "u1", seconds: 3 }, { ok: true }, false)).toBe("set_duration: clip=u1, seconds=3");
  });

  test("errors quote Drift's code, and apply_failed names where it stopped", () => {
    expect(summarizeDriftCall("place_clip", {}, { ok: false, error: "not_found", detail: "no clip u9" }, true)).toBe("place_clip failed: not_found (no clip u9)");
    expect(summarizeDriftCall("apply", {}, { ok: false, error: "apply_failed", stopped: 2, tool: "add_text", failed: { error: "bad_args" } }, true))
      .toBe("apply failed at op 2 (add_text): bad_args");
  });

  test("the summary is bounded to 160 chars and strips control characters", () => {
    const s = summarizeDriftCall("export_video", {}, { ok: true, path: `C:\\${"x".repeat(400)}\u0007\n.mp4` }, false);
    expect(s.length).toBeLessThanOrEqual(160);
    expect(s).not.toMatch(/[\u0000-\u001f]/);
    expect(summarizeDriftCall("a\u001b[31mb", {}, {}, false)).toBe("a [31mb");
  });
});
