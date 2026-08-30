// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/creator_pipeline.test.ts - CREATOR-3 (ADR-0287).
//
// The claims this file defends, all of them about what a human is allowed to believe from the pane:
//
//   * A MALFORMED PAYLOAD IS NOT A RENDER. `isPipelineRunView` is fail-closed, so a half-shaped result
//     paints nothing instead of a report with a missing verdict or cards for records that are not records.
//   * A REMOTE STRING IS NEVER MARKUP (invariant 5). A filename carrying an <img onerror> and a model name
//     carrying a close tag both come out as text, and the tag balance proves the injected tag never landed.
//   * AN UNKNOWN PERCENT SAYS SO. No branch of `progressLine` invents a number or a bar.
//   * A REFUSED OUTPUT IS SHOWN, with its reason, always.
//   * INVARIANT 11 IS ASSERTED ON THE EMITTED MARKUP, not promised in a comment: every `cpl-*-row` holds
//     only element children, and every `cpl-*` paragraph is one text run.
//
// Pure builders, so there is nothing to inject: no DOM, no fetch, no clock.

import { describe, expect, test } from "bun:test";
import {
  creatorRenderHtml, escapeHtml, isPipelineRunView, mediaCardHtml, progressLine, refusalListHtml, runReportHtml,
  type CreatorRenderView, type PipelineMediaView, type PipelineProgressView, type PipelineRunView,
} from "./creator_pipeline.ts";

// ── fixtures ────────────────────────────────────────────────────────────────

const media = (over: Partial<PipelineMediaView> = {}): PipelineMediaView => ({
  id: "art_1",
  file: "ComfyUI_00007_.webm",
  mime: "video/webm",
  bytes: 2_400_000,
  sha256: "9f2c4b1a8e7d6c5b4a3928170feedbeef0011223344556677889900aabbccddee",
  kind: "video",
  prompt: "a neon skyline at night, slow dolly in",
  model: "svd_xt.safetensors",
  scanned: "clean",
  ...over,
});

const run = (over: Partial<PipelineRunView> = {}): PipelineRunView => ({
  ok: true,
  error: "",
  jobId: "job_1",
  promptId: "p-abc123",
  stage: "done",
  kind: "video",
  media: [media()],
  refused: [],
  unresolved: [],
  note: "Stored 1 output from 1 output the server produced.",
  ...over,
});

const prog = (over: Partial<PipelineProgressView> = {}): PipelineProgressView => ({
  status: "running",
  node: "KSampler",
  pct: 42,
  previewCount: 0,
  error: "",
  ...over,
});

// A row is a flex container: its children must all be ELEMENTS (invariant 11).
const ROW = /<div class="(cpl-[a-z-]*row)"[^>]*>([\s\S]*?)<\/div>/g;
const ELEMENT_CHILD = /<(span|button|svg)\b[^>]*>[\s\S]*?<\/\1>/g;
// Prose is a block paragraph: at most one leading (absolutely positioned) icon, then ONE text node.
const PROSE = /<p class="cpl-[a-z-]+">([\s\S]*?)<\/p>/g;

// ── the shape gate ──────────────────────────────────────────────────────────

describe("the payload gate paints nothing rather than half a report", () => {
  test("a full run payload is accepted", () => {
    expect(isPipelineRunView(run())).toBe(true);
    expect(isPipelineRunView(run({ ok: false, error: "refused", stage: "capability", media: [] }))).toBe(true);
  });

  test("null, a primitive, and a non-object are not runs", () => {
    expect(isPipelineRunView(null)).toBe(false);
    expect(isPipelineRunView(undefined)).toBe(false);
    expect(isPipelineRunView("the render finished")).toBe(false);
    expect(isPipelineRunView(42)).toBe(false);
    expect(isPipelineRunView(true)).toBe(false);
  });

  test("a run with no media ARRAY is malformed, not a run with no media", () => {
    const noMedia: Record<string, unknown> = { ...run() };
    delete noMedia.media;
    expect(isPipelineRunView(noMedia)).toBe(false);
    expect(isPipelineRunView({ ...run(), media: null })).toBe(false);
    expect(isPipelineRunView({ ...run(), media: "ComfyUI_00007_.webm" })).toBe(false);
    expect(isPipelineRunView({ ...run(), media: 1 })).toBe(false);
  });

  test("a media entry that is not a record blocks the WHOLE payload", () => {
    expect(isPipelineRunView({ ...run(), media: [null] })).toBe(false);
    expect(isPipelineRunView({ ...run(), media: ["ComfyUI_00007_.webm"] })).toBe(false);
    expect(isPipelineRunView({ ...run(), media: [{ id: "art_1" }] })).toBe(false);
    expect(isPipelineRunView({ ...run(), media: [media(), 7] })).toBe(false);
    expect(isPipelineRunView({ ...run(), media: [{ ...media(), bytes: "2.4 MB" }] })).toBe(false);
  });

  test("a refusal without its reason, and a non-string placeholder, are both malformed", () => {
    expect(isPipelineRunView({ ...run(), refused: [{ filename: "x.png" }] })).toBe(false);
    expect(isPipelineRunView({ ...run(), refused: [null] })).toBe(false);
    expect(isPipelineRunView({ ...run(), unresolved: [7] })).toBe(false);
    expect(isPipelineRunView({ ...run(), ok: "yes" })).toBe(false);
    expect(isPipelineRunView({ ...run(), stage: 3 })).toBe(false);
  });
});

// ── escaping ────────────────────────────────────────────────────────────────

describe("a remote string is data, never markup", () => {
  test("a filename carrying an onerror payload and a model name carrying a close tag come out as TEXT", () => {
    const html = mediaCardHtml(media({
      file: "<img src=x onerror=alert(1)>.webm",
      model: "</div><script>steal()</script>",
    }));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror=alert(1)>");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;.webm");
    expect(html).toContain("&lt;/div&gt;&lt;script&gt;steal()&lt;/script&gt;");
    // An injected </div> would leave more closers than openers, so the balance is the proof.
    expect((html.match(/<\/div>/g) ?? []).length).toBe((html.match(/<div\b/g) ?? []).length);
    // ...and the model label is ONE text node: [^<]* cannot span a tag.
    expect(/<p class="cpl-model">([^<]*)<\/p>/.exec(html)?.[1]).toBe("&lt;/div&gt;&lt;script&gt;steal()&lt;/script&gt;");
  });

  test("the prompt, mime, and scan verdict are escaped too, including inside the tooltip attributes", () => {
    const html = mediaCardHtml(media({
      prompt: 'a "quoted" <b>prompt</b>',
      mime: "video/<webm>",
      scanned: "blocked: <bidi> override in the subfolder",
      sha256: "",
    }));
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<bidi>");
    expect(html).toContain("&quot;quoted&quot;");
    expect(html).toContain("video/&lt;webm&gt;");
    expect(html).toContain("blocked: &lt;bidi&gt; override in the subfolder");
    expect(html).toContain("no digest"); // an absent hash is named, never printed as an empty chip
  });

  test("escapeHtml is the house escaper, not a second one", () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });

  test("a record with no scan verdict says so instead of implying it was checked", () => {
    const html = mediaCardHtml(media({ scanned: "" }));
    expect(html).toContain("No scan verdict came back with this record");
    expect(html).not.toContain(">clean<");
  });
});

// ── progress ────────────────────────────────────────────────────────────────

describe("progressLine tells one honest sentence, never a fake bar", () => {
  test("no progress at all says the socket was not open and that polling decided", () => {
    const line = progressLine(null);
    expect(line).toContain("No progress socket was open");
    expect(line).toContain("polling");
    expect(line).not.toContain("0%");
  });

  test("queued with no percent says there is no percent yet", () => {
    expect(progressLine(prog({ status: "queued", node: "", pct: null }))).toBe("Queued, no progress reported yet.");
  });

  test("a running render NAMES its node and reports its percent in one sentence", () => {
    const line = progressLine(prog({ status: "running", node: "VHS_VideoCombine", pct: 42, previewCount: 3 }));
    expect(line).toContain("VHS_VideoCombine");
    expect(line).toContain("42%");
    expect(line).toContain("3 preview frames");
    expect(line.split(". ").length).toBe(1); // ONE sentence, not a paragraph
  });

  test("a running render with an unknown percent says unknown, never 0%", () => {
    const line = progressLine(prog({ status: "running", node: "KSampler", pct: null }));
    expect(line).toContain("KSampler");
    expect(line).toContain("no percent reported yet");
    expect(line).not.toContain("0%");
    const nameless = progressLine(prog({ status: "running", node: "   ", pct: null }));
    expect(nameless).toContain("has not named a node yet");
  });

  test("an error is stated in the server's own words, whatever the status claims", () => {
    expect(progressLine(prog({ status: "error", error: "node 12 raised OutOfMemoryError" })))
      .toContain("node 12 raised OutOfMemoryError");
    expect(progressLine(prog({ status: "running", node: "KSampler", pct: 42, error: "socket closed mid-frame" })))
      .toContain("socket closed mid-frame");
    expect(progressLine(prog({ status: "error", error: "" }))).toContain("named no reason");
  });

  test("an interrupted render does not show its last stale percent", () => {
    const line = progressLine(prog({ status: "interrupted", node: "KSampler", pct: 61 }));
    expect(line).toContain("interrupted");
    expect(line).toContain("stale");
    expect(line).not.toContain("61%");
  });

  test("a status LUCID does not recognise is printed, not guessed at", () => {
    expect(progressLine(prog({ status: "reticulating", pct: null }))).toContain("reticulating");
    expect(progressLine(prog({ status: "", pct: null }))).toContain("an empty status");
  });

  test("a nonsense percent is clamped rather than painted", () => {
    expect(progressLine(prog({ status: "running", node: "n", pct: 1200 }))).toContain("100%");
    expect(progressLine(prog({ status: "running", node: "n", pct: -8 }))).toContain("0%");
    expect(progressLine(prog({ status: "running", node: "n", pct: Number.NaN }))).toContain("no percent reported yet");
  });
});

// ── refusals ────────────────────────────────────────────────────────────────

describe("a refused output is shown, never dropped", () => {
  test("every refusal's filename AND reason reach the report", () => {
    const html = runReportHtml(run({
      refused: [
        { filename: "ComfyUI_00003_.png", reason: "a still image is not the answer to a video request" },
        { filename: "shady.webm", reason: "scan blocked this metadata: bidi override in the subfolder" },
      ],
    }), prog());
    expect(html).toContain("ComfyUI_00003_.png");
    expect(html).toContain("a still image is not the answer to a video request");
    expect(html).toContain("shady.webm");
    expect(html).toContain("scan blocked this metadata: bidi override in the subfolder");
    expect(html).toContain("2 outputs refused, none of them stored");
  });

  test("an empty list renders nothing; a non-empty list ALWAYS renders", () => {
    expect(refusalListHtml([])).toBe("");
    expect(refusalListHtml([{ filename: "a.png", reason: "wrong kind" }])).toContain("cpl-refused");
    expect(refusalListHtml([{ filename: "a.png", reason: "wrong kind" }])).toContain("1 output refused");
  });

  test("a refusal with no name or no reason still appears, with the absence named", () => {
    const html = refusalListHtml([{ filename: "", reason: "" }]);
    expect(html).toContain("unnamed output");
    expect(html).toContain("named no reason");
  });
});

// ── the run report ──────────────────────────────────────────────────────────

describe("the run report claims exactly what happened", () => {
  test("a failed run shows its stage and its error, and claims NO artifact", () => {
    const html = runReportHtml(run({
      ok: false,
      error: "the bytes claimed video/webm but sniffed image/png",
      stage: "scan",
      media: [],
      note: "",
    }), null);
    expect(html).toContain("metadata scan");
    expect(html).toContain("the bytes claimed video/webm but sniffed image/png");
    expect(html).toMatch(/<span class="cpl-run-verdict">Stopped at the metadata scan stage<\/span>/);
    expect(html).not.toContain("cpl-media");
    expect(html).not.toContain("cpl-card");
    expect(html).not.toContain("Stored ");
    expect(html).toContain("No media was stored");
    expect(html).toContain("No progress socket was open");
  });

  test("a successful run names its stored output and its provenance", () => {
    const html = runReportHtml(run(), prog({ status: "done", previewCount: 2 }));
    expect(html).toContain("Stored 1 output");
    expect(html).toContain("ComfyUI_00007_.webm");
    expect(html).toContain("video/webm");
    expect(html).toContain("9f2c4b1a8e7d"); // the digest, short form, full value in the tooltip
    expect(html).toContain("svd_xt.safetensors");
    expect(html).toContain("2 preview frames");
  });

  test("an unresolved template placeholder is reported, not swallowed", () => {
    const html = runReportHtml(run({ ok: false, stage: "template", media: [], unresolved: ["{{image:pose}}"] }), null);
    expect(html).toContain("{{image:pose}}");
    expect(html).toContain("1 placeholder");
    expect(html).toContain("never submitted");
  });

  test("a stage or kind LUCID does not know prints verbatim rather than being mistranslated", () => {
    const html = runReportHtml(run({ ok: false, stage: "upscale", kind: "point-cloud", media: [] }), null);
    expect(html).toContain("Stopped at the upscale stage");
    expect(html).toContain("point-cloud");
  });
});

// ── invariant 11, asserted on the markup ────────────────────────────────────

describe("invariant 11 holds in the emitted markup", () => {
  const busy = () => runReportHtml(run({
    ok: false,
    error: "the render server closed the connection after 4 outputs",
    stage: "fetch",
    unresolved: ["{{seed}}"],
    media: [media(), media({ id: "art_2", file: "a filename long enough that it must ellipsize rather than wrap the row.glb", kind: "model-3d", mime: "model/gltf-binary" })],
    refused: [{ filename: "ComfyUI_00003_.png", reason: "a still image is not the answer to a video request" }],
  }), prog({ previewCount: 1 }));

  test("every cpl row holds ONLY element children, never text beside a tag", () => {
    const rows = [...busy().matchAll(ROW)];
    expect(rows.length).toBeGreaterThanOrEqual(7); // 2 run rows + 2 per card + 1 per refusal
    for (const m of rows) {
      const cls = m[1] ?? "";
      const inner = m[2] ?? "";
      expect(inner).not.toContain("<div"); // a flex row never nests a container
      const leftover = inner.replace(ELEMENT_CHILD, "").trim();
      expect(`${cls}: ${leftover}`).toBe(`${cls}: `);
    }
  });

  test("every cpl paragraph is ONE text run, after an optional leading icon", () => {
    const proses = [...busy().matchAll(PROSE)];
    expect(proses.length).toBeGreaterThanOrEqual(6);
    for (const m of proses) {
      expect((m[1] ?? "").replace(/^<svg\b[^>]*>[\s\S]*?<\/svg>/, "")).not.toContain("<");
    }
  });

  test("the refusal heading's text is its own single-text span", () => {
    expect(busy()).toMatch(/<span class="cpl-refused-h-t">[^<]+<\/span>/);
  });

  test("a long filename is one span's only child, so CSS can ellipsize it", () => {
    const long = "a filename long enough that it must ellipsize rather than wrap the row.glb";
    expect(/<span class="cpl-file"[^>]*>([^<]*)<\/span>/.exec(busy())?.[1]).toBe("ComfyUI_00007_.webm");
    expect(busy()).toContain(long);
  });
});

// ---- the pane shell: the gate is stated before the button ----

describe("creatorRenderHtml", () => {
  const view = (over: Partial<CreatorRenderView> = {}): CreatorRenderView => ({
    kind: "video",
    prompt: "",
    model: "",
    models: ["wan_video_14b.safetensors", "sdxl_base.safetensors"],
    endpoint: "http://127.0.0.1:8188",
    attested: ["image", "video"],
    note: "",
    busy: "",
    status: "",
    statusTone: "",
    run: null,
    progress: null,
    ...over,
  });

  test("no view yet says it is reading what the install can prove, and offers no form", () => {
    const html = creatorRenderHtml(null);
    expect(html).toContain("can prove");
    expect(html).not.toContain("cplRun");
  });

  test("an attested kind enables the request and lists the SERVER's own models, marking the selected one", () => {
    const html = creatorRenderHtml(view({ model: "sdxl_base.safetensors" }));
    expect(html).not.toContain("cpl-gate");
    expect(html).toContain('id="cplRun"');
    expect(html).not.toContain("disabled");
    expect(html).toContain('<option value="sdxl_base.safetensors" selected>');
  });

  test("an UNATTESTED kind disables the request and names what the probe DID prove", () => {
    const html = creatorRenderHtml(view({ kind: "model-3d" }));
    expect(html).toContain("cpl-gate");
    expect(html).toContain("has attested model-3d");
    expect(html).toContain("It proved: image, video");
    expect(html).toContain("disabled");
  });

  test("an expired or absent probe says exactly that instead of listing an empty capability set", () => {
    const html = creatorRenderHtml(view({ attested: [] }));
    expect(html).toContain("attested anything on this install yet, or the last probe expired");
    expect(html).toContain("disabled");
  });

  test("a server that published no models says so rather than offering an empty picker", () => {
    expect(creatorRenderHtml(view({ models: [] }))).toContain("no models published");
  });

  test("a busy render disables the button and shows its own label, so a second submit is impossible", () => {
    const html = creatorRenderHtml(view({ busy: "Rendering..." }));
    expect(html).toContain("Rendering...");
    expect(html).toContain("disabled");
  });

  test("a hostile model name from the server is escaped in both the value and the label", () => {
    const html = creatorRenderHtml(view({ models: ['"><script>alert(1)</script>'] }));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("the pane states that the graph is the user's own, never LUCID's", () => {
    expect(creatorRenderHtml(view())).toContain("never invents a graph");
  });
});
