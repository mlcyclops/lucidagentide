// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { hyperframesRenderBlock, videoRenderBlock, type CreatorVideoView } from "./creator_video.ts";

const view = (over: Partial<CreatorVideoView> = {}): CreatorVideoView => ({
  lockdown: true,
  endpoints: [{ id: "nick-dgx-avatar", label: "Avatar (Nick DGX)", cui: { posture: "enclave", allowed: true, reason: "enclave endpoint" } }],
  endpointId: "nick-dgx-avatar", engine: "musetalk", templates: [{ path: "/t/a.mp4", name: "a.mp4", sizeBytes: 1 }], templatesNote: "",
  templatePath: "/t/a.mp4", voices: [{ id: "v1", name: "Voice 1" }], voice: "v1", text: "Hello", title: "", subtitle: "", captions: false,
  busy: "", status: "", statusTone: "", jobId: "", job: null, artifactId: "",
  hyperframes: { projectDir: "C:/comp", format: "mp4", quality: "standard", jobId: "", status: "", statusTone: "" },
  jobs: [], ...over,
});

describe("avatar render gate", () => {
  test("a complete form on an allowed enclave endpoint may render", () => {
    expect(videoRenderBlock(view())).toBe("");
  });

  test("the CUI refusal outranks every missing field", () => {
    const v = view({ endpoints: [{ id: "x", label: "X", cui: { posture: "cloud", allowed: false, reason: "not a DGX enclave" } }], endpointId: "x", text: "", templatePath: "" });
    expect(videoRenderBlock(v)).toBe("Refused under CUI lockdown: not a DGX enclave");
  });

  test("each missing input names itself, in form order", () => {
    expect(videoRenderBlock(view({ endpoints: [] }))).toContain("No dgx-avatar endpoint");
    expect(videoRenderBlock(view({ endpointId: "gone" }))).toBe("Pick a dgx-avatar endpoint.");
    expect(videoRenderBlock(view({ templatePath: "" }))).toContain("Pick a template");
    expect(videoRenderBlock(view({ text: "   " }))).toContain("Write what the avatar should say");
    expect(videoRenderBlock(view({ voice: "" }))).toContain("Pick a voice");
    expect(videoRenderBlock(view({ busy: "Rendering..." }))).toBe("Rendering...");
  });
});

describe("HyperFrames render gate", () => {
  test("a refused HyperFrames provider and an empty project directory both block", () => {
    expect(hyperframesRenderBlock(view())).toBe("");
    expect(hyperframesRenderBlock(view({ hyperframes: { ...view().hyperframes, projectDir: " " } }))).toContain("project directory");
    expect(hyperframesRenderBlock(view({ hyperframes: { ...view().hyperframes, cui: { posture: "on-device", allowed: false, reason: "x" } } }))).toBe("Refused under CUI lockdown: x");
  });
});
