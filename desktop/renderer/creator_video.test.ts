// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { creatorVideoHtml, hyperframesRenderBlock, isOpenfilmJob, openfilmBlock, openfilmJobOutcome, openfilmLookHtml, videoRenderBlock, type CreatorVideoView, type OpenfilmJobView, type OpenfilmLookVerdictView } from "./creator_video.ts";

const view = (over: Partial<CreatorVideoView> = {}): CreatorVideoView => ({
  lockdown: true,
  endpoints: [{ id: "nick-dgx-avatar", label: "Avatar (Nick DGX)", cui: { posture: "enclave", allowed: true, reason: "enclave endpoint" } }],
  endpointId: "nick-dgx-avatar", engine: "musetalk", templates: [{ path: "/t/a.mp4", name: "a.mp4", sizeBytes: 1 }], templatesNote: "",
  templatePath: "/t/a.mp4", voices: [{ id: "v1", name: "Voice 1" }], voice: "v1", text: "Hello", title: "", subtitle: "", captions: false,
  busy: "", status: "", statusTone: "", jobId: "", job: null, artifactId: "",
  hyperframes: { projectDir: "C:/comp", format: "mp4", quality: "standard", jobId: "", status: "", statusTone: "" },
  openfilm: { projectDir: "C:/film", format: "mp4", fps: 30, fourK: false, blur: false, jobId: "", lookJobId: "", status: "", statusTone: "", look: null },
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

describe("OpenFilm gate", () => {
  const of = (over: Partial<CreatorVideoView["openfilm"]>) => view({ openfilm: { ...view().openfilm, ...over } });

  test("a complete form may look and render", () => {
    expect(openfilmBlock(view())).toBe("");
    expect(openfilmBlock(view(), "look")).toBe("");
  });

  test("the provider's CUI refusal outranks every other reason", () => {
    const v = of({ cui: { posture: "on-device", allowed: false, reason: "film.html references https://cdn.example" }, projectDir: "", fps: 0 });
    expect(openfilmBlock(v)).toBe("Refused under CUI lockdown: film.html references https://cdn.example");
    expect(openfilmBlock(v, "look")).toBe("Refused under CUI lockdown: film.html references https://cdn.example");
  });

  test("an empty project directory asks for the folder holding film.html", () => {
    expect(openfilmBlock(of({ projectDir: "  " }))).toContain("film.html");
    expect(openfilmBlock(of({ projectDir: "" }), "look")).toContain("film.html");
  });

  test("fps outside 1-240 blocks a render but not a look", () => {
    for (const fps of [0, 241, 29.5, Number.NaN]) {
      expect(openfilmBlock(of({ fps }))).toContain("1 to 240");
      expect(openfilmBlock(of({ fps }), "look")).toBe("");
    }
    expect(openfilmBlock(of({ fps: 1 }))).toBe("");
    expect(openfilmBlock(of({ fps: 240 }))).toBe("");
  });

  test("the pane disables both buttons with the refusal shown", () => {
    const html = creatorVideoHtml(of({ cui: { posture: "on-device", allowed: false, reason: "external refs" } }));
    expect(html).toContain("Refused under CUI lockdown: external refs");
    expect(html).toMatch(/id="cvdOfLook" disabled/);
    expect(html).toMatch(/id="cvdOfRender" disabled/);
  });
});

describe("OpenFilm look verdict card", () => {
  const hostile = "<img src=x onerror=1>";
  const look: OpenfilmLookVerdictView = {
    ok: false, exitCode: 1, head: "film  1920x1080 · 6s · 1 sound",
    errors: ["page error at 2.0s"], warnings: [`text cut off: ${hostile}`], passed: ["same t, same picture"], notes: ["♪ theme.mp3"],
    sheets: ["art-sheet-1"],
  };

  test("hostile film text is escaped, never live markup", () => {
    const html = openfilmLookHtml(look, "job-1");
    expect(html).not.toContain(hostile);
    expect(html).toContain("text cut off: &lt;img src=x onerror=1&gt;");
  });

  test("errors come before warnings, then passed checks and notes", () => {
    const html = openfilmLookHtml(look, "job-1");
    const at = (s: string) => html.indexOf(s);
    expect(at("page error at 2.0s")).toBeGreaterThan(-1);
    expect(at("page error at 2.0s")).toBeLessThan(at("text cut off"));
    expect(at("text cut off")).toBeLessThan(at("Passed: same t, same picture"));
    expect(at("Passed: same t, same picture")).toBeLessThan(at("♪ theme.mp3"));
  });

  test("each contact sheet is an image loaded from the library by artifact id", () => {
    expect(openfilmLookHtml(look, "job-1")).toContain(`data-cvd-sheet="art-sheet-1"`);
  });

  test("the pane shows the verdict card held in view state", () => {
    const html = creatorVideoHtml(view({ openfilm: { ...view().openfilm, look, lookJobId: "job-1" } }));
    expect(html).toContain("page error at 2.0s");
    expect(html).not.toContain(hostile);
  });
});

describe("OpenFilm job outcome", () => {
  const job = (over: Partial<OpenfilmJobView>): OpenfilmJobView => ({ jobId: "j1", kind: "render", state: "running", error: "", artifacts: [], look: null, ...over });

  test("a running job is not settled", () => {
    expect(openfilmJobOutcome(job({})).settled).toBe(false);
  });

  test("a refused or failed job renders its error in the error tone", () => {
    const refused = openfilmJobOutcome(job({ state: "refused", error: "CUI lockdown: film.html references https://cdn.example/a.js" }));
    expect(refused).toMatchObject({ settled: true, statusTone: "error" });
    expect(refused.status).toContain("CUI lockdown: film.html references https://cdn.example/a.js");
    const failed = openfilmJobOutcome(job({ kind: "look", state: "failed", error: "" }));
    expect(failed.status).toContain("failed: no reason given");
    const html = creatorVideoHtml(view({ openfilm: { ...view().openfilm, status: refused.status, statusTone: refused.statusTone } }));
    expect(html).toContain(`cpl-status error">OpenFilm render refused: CUI lockdown`);
  });

  test("a finished render hands its video to the player", () => {
    expect(openfilmJobOutcome(job({ state: "done", artifacts: ["vid-1"] }))).toMatchObject({ settled: true, statusTone: "ok", artifactId: "vid-1" });
  });

  test("a failed look still carries its verdict for the card", () => {
    const look: OpenfilmLookVerdictView = { ok: false, exitCode: 1, head: "", errors: ["x"], warnings: [], passed: [], notes: [], sheets: [] };
    expect(openfilmJobOutcome(job({ kind: "look", state: "failed", error: "film errors", look })).look).toBe(look);
  });

  test("the wire guard refuses a payload with an unknown state or a malformed verdict", () => {
    expect(isOpenfilmJob(job({}))).toBe(true);
    expect(isOpenfilmJob({ ...job({}), state: "exploded" })).toBe(false);
    expect(isOpenfilmJob({ ...job({}), look: { ok: true } })).toBe(false);
  });
});
