// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import {
  creatorIntegrationsHtml, creatorJobsHtml, creatorLibraryHtml, creatorStudioHtml, fmtAgo, fmtBytes,
  isCreatorStudio, type CreatorStudioView, type JobView, type ProbeResultView, type ProviderStatusView,
  type TrackView,
} from "./creator_studio.ts";

const provider = (over: Partial<ProviderStatusView> = {}): ProviderStatusView => ({
  id: "suno",
  name: "Suno",
  group: "audio",
  state: "needs-endpoint",
  transports: ["https"],
  consentRequired: false,
  docsUrl: "https://suno.com",
  note: "No endpoint is hardcoded. LUCID never automates the Suno web product.",
  endpointCount: 0,
  usable: ["library-manage", "remix"],
  capabilities: [
    { id: "library-manage", status: "available", surface: "local", detail: "Import, tag, review, and re-listen locally." },
    { id: "music", status: "unverified-endpoint", surface: "api", detail: "No public self-serve API in 2026, so you supply the endpoint." },
    { id: "audio-mix", status: "planned", surface: "local", detail: "Stem mixing lands with the mixer increment." },
  ],
  ...over,
});

const track = (over: Partial<TrackView> = {}): TrackView => ({
  id: "trk1",
  title: "Neon Skyline",
  origin: "suno",
  mime: "audio/mpeg",
  bytes: 5 * 1024 * 1024,
  createdAt: 10,
  updatedAt: 20,
  prompt: "synthwave, 100 bpm, wide chorus",
  lyrics: "",
  tags: ["synthwave", "demo"],
  rating: 4,
  review: "chorus is too loud",
  parentId: null,
  kind: "original",
  ...over,
});

const view = (over: Partial<CreatorStudioView> = {}): CreatorStudioView => ({
  providers: [provider()],
  tracks: [track()],
  stats: { tracks: 1, remixes: 0, reviewed: 1, bytes: 5 * 1024 * 1024, origins: { suno: 1 } },
  ...over,
});

describe("integrations pane (CREATOR-0, ADR-0282)", () => {
  test("each capability shows its honesty label, so 'planned' can never read as shipped", () => {
    const html = creatorIntegrationsHtml([provider({
      capabilities: [...provider().capabilities, { id: "library-manage", status: "product-ui-only", surface: "product-ui", detail: "Project timeline editing lives in the vendor app." }],
    })]);
    expect(html).toContain("cst-cap-available");
    expect(html).toContain("cst-cap-unverified-endpoint");
    expect(html).toContain("cst-cap-planned");
    expect(html).toContain("cst-cap-product-ui-only");
    expect(html).toContain("bring your endpoint");
    expect(html).toContain("vendor exposes this only inside its own web product");
  });

  test("only an available capability that is ALSO usable right now is marked on", () => {
    const html = creatorIntegrationsHtml([provider()]);
    expect(html).toMatch(/cst-cap cst-cap-available on/);
    expect(html).not.toMatch(/cst-cap cst-cap-unverified-endpoint on/);
  });

  test("a built-in provider offers no Connect button; a network one does", () => {
    expect(creatorIntegrationsHtml([provider({ id: "threejs", name: "three.js", group: "3d", state: "built-in" })])).not.toContain("data-creator-endpoint");
    expect(creatorIntegrationsHtml([provider()])).toContain('data-creator-endpoint="suno"');
    expect(creatorIntegrationsHtml([provider({ endpointCount: 2 })])).toContain("2 configured");
  });

  test("a consent-required provider is flagged where the user chooses it", () => {
    expect(creatorIntegrationsHtml([provider({ consentRequired: true })])).toContain("Consent required");
  });

  test("groups are labeled and empty groups are omitted", () => {
    const html = creatorIntegrationsHtml([provider(), provider({ id: "blender", name: "Blender", group: "3d" })]);
    expect(html).toContain("Audio and voice");
    expect(html).toContain("3D and scenes");
    expect(html).not.toContain("Game engines");
  });

  test("invariant 11: the provider label is its OWN one-line span and the note is a block paragraph", () => {
    const html = creatorIntegrationsHtml([provider()]);
    expect(html).toMatch(/<span class="cst-name">Suno<\/span>/);
    expect(html).toMatch(/<p class="cst-note">[^<]+<\/p>/);
  });

  test("external provider text is escaped", () => {
    const html = creatorIntegrationsHtml([provider({ name: "<script>x</script>", note: "<b>note</b>" })]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("library pane (the Suno ask, ADR-0281)", () => {
  test("a track row offers listen, review, remix, re-prompt, and remove", () => {
    const html = creatorLibraryHtml(view());
    expect(html).toContain('data-track-play="trk1"');
    expect(html).toContain('data-track-review="trk1"');
    expect(html).toContain('data-track-remix="trk1"');
    expect(html).toContain('data-track-reprompt="trk1"');
    expect(html).toContain('data-track-remove="trk1"');
    expect(html).toContain("Add audio");
  });

  test("the prompt, review, tags, rating, and size are all visible", () => {
    const html = creatorLibraryHtml(view());
    expect(html).toContain("synthwave, 100 bpm, wide chorus");
    expect(html).toContain("chorus is too loud");
    expect(html).toContain(">synthwave<");
    expect((html.match(/cst-star on/g) ?? []).length).toBe(4);
    expect(html).toContain("5 MB");
  });

  test("an unrated track shows five empty stars and says unrated to a screen reader", () => {
    const html = creatorLibraryHtml(view({ tracks: [track({ rating: null })] }));
    expect(html).not.toContain("cst-star on");
    expect(html).toContain('aria-label="unrated"');
  });

  test("lineage depth is counted from the parent chain", () => {
    const parent = track({ id: "p", title: "Take 1" });
    const child = track({ id: "c", title: "Take 2", parentId: "p", kind: "remix" });
    const html = creatorLibraryHtml(view({ tracks: [child, parent] }));
    expect(html).toContain("v2");
    expect(html).toContain(">remix<");
  });

  test("an empty library explains what it is for instead of showing a dead table", () => {
    const html = creatorLibraryHtml(view({ tracks: [], stats: { tracks: 0, remixes: 0, reviewed: 0, bytes: 0, origins: {} } }));
    expect(html).toContain("No tracks yet");
    expect(html).toContain("stored on this machine");
  });

  test("invariant 11: the title is its own one-line span; prompt and review are block paragraphs", () => {
    const html = creatorLibraryHtml(view());
    expect(html).toMatch(/<span class="cst-track-title">Neon Skyline<\/span>/);
    expect(html).toMatch(/<p class="cst-track-prompt">[^<]+<\/p>/);
  });

  test("track titles, tags, and reviews from anywhere are escaped", () => {
    const html = creatorLibraryHtml(view({ tracks: [track({ title: "<img src=x>", tags: ["<b>"], review: "<script>1</script>" })] }));
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>");
  });

  test("byte formatting stays readable at every scale", () => {
    expect(fmtBytes(0)).toBe("0 MB");
    expect(fmtBytes(3 * 1024 * 1024)).toBe("3 MB");
    expect(fmtBytes(1536 * 1024 * 1024)).toBe("1.5 GB");
  });
});

describe("probe lines (CREATOR-1, ADR-0292)", () => {
  const probe = (over: Partial<ProbeResultView> = {}): ProbeResultView => ({
    providerId: "comfyui", state: "ready", at: 1_000_000, latencyMs: 42,
    detail: "18 nodes installed; proven: image, workflow-run.", attested: ["image", "workflow-run"], version: "", ...over,
  });

  test("every provider row offers a probe, plus a probe-everything action", () => {
    const html = creatorIntegrationsHtml([provider()]);
    expect(html).toContain('data-creator-probe="suno"');
    expect(html).toContain("data-creator-probe-all");
    expect(html).toContain("only that becomes usable");
  });

  test("an unprobed provider says so instead of implying it works", () => {
    expect(creatorIntegrationsHtml([provider()])).toContain("Not probed yet");
  });

  test("a ready probe shows what it proved, when, and how long it took", () => {
    const html = creatorIntegrationsHtml([provider({ id: "comfyui", name: "ComfyUI", group: "video" })], [probe()], 1_000_000 + 5000);
    expect(html).toContain("proven");
    expect(html).toContain("5s ago");
    expect(html).toContain("42ms");
    expect(html).toContain("18 nodes installed");
  });

  test("each failure state gets its own honest label", () => {
    const state = (s: string) => creatorIntegrationsHtml([provider({ id: "comfyui", name: "ComfyUI", group: "video" })], [probe({ state: s, attested: [] })]);
    expect(state("unauthorized")).toContain("credential refused");
    expect(state("unreachable")).toContain("no answer");
    expect(state("not-installed")).toContain("not on disk");
    expect(state("no-capabilities")).toContain("nothing proven");
    expect(state("skipped")).toContain("not probed");
  });

  test("a probe detail is escaped (it quotes a remote server's own text)", () => {
    const html = creatorIntegrationsHtml([provider()], [probe({ providerId: "suno", detail: "<img src=x onerror=alert(1)>" })]);
    expect(html).not.toContain("<img src=x");
  });

  test("ages read naturally", () => {
    expect(fmtAgo(0, 5)).toBe("never");
    expect(fmtAgo(1000, 1500)).toBe("just now");
    expect(fmtAgo(1000, 31_000)).toBe("30s ago");
    expect(fmtAgo(1000, 1000 + 5 * 60_000)).toBe("5m ago");
    expect(fmtAgo(1000, 1000 + 3 * 3_600_000)).toBe("3h ago");
  });
});

describe("the job strip (CREATOR-1, ADR-0292)", () => {
  const job = (over: Partial<JobView> = {}): JobView => ({
    id: "job1", kind: "image", state: "running", label: "neon alley", provider: "comfyui",
    createdAt: 1_000_000, startedAt: 1_000_000, endedAt: null, cancelRequested: false, error: "", artifacts: [],
    admission: { ok: true, cpuPct: 22, memPct: 40, gpuPct: 15, gpuEvidenceMissing: false, reason: "" }, ...over,
  });

  test("a running job shows its duration, what the governor measured, and a Stop", () => {
    const html = creatorJobsHtml([job()], { total: 1, active: 1, done: 0, failed: 0, refused: 0 }, 1_000_000 + 3400);
    expect(html).toContain("3.4s");
    expect(html).toContain("admitted at cpu 22%, mem 40%, gpu 15%");
    expect(html).toContain('data-job-cancel="job1"');
    expect(html).toContain("1 active");
  });

  test("a stop REQUEST says stopping, and the Stop button is gone (it is not cancelled yet)", () => {
    const html = creatorJobsHtml([job({ cancelRequested: true })]);
    expect(html).toContain("(stopping)");
    expect(html).not.toContain("data-job-cancel");
  });

  test("a refused job surfaces the measured reason, not a generic failure", () => {
    const html = creatorJobsHtml([job({
      state: "refused", startedAt: null, endedAt: 1_000_100, error: "system memory has been at 94% for 42s",
      admission: { ok: false, cpuPct: 30, memPct: 94, gpuPct: null, gpuEvidenceMissing: true, reason: "system memory has been at 94% for 42s" },
    })], { total: 1, active: 0, done: 0, failed: 0, refused: 1 });
    expect(html).toContain("94% for 42s");
    expect(html).toContain("1 refused");
    expect(html).not.toContain("data-job-cancel");
  });

  test("a settled job reports its artifacts and no Stop", () => {
    const html = creatorJobsHtml([job({ state: "done", endedAt: 1_002_000, artifacts: ["a1", "a2"] })]);
    expect(html).toContain("2 artifacts");
    expect(html).toContain("2s");
    expect(html).not.toContain("data-job-cancel");
  });

  test("an empty ledger explains what will appear there", () => {
    expect(creatorJobsHtml([])).toContain("what the resource governor measured");
  });

  test("job labels and errors from anywhere are escaped", () => {
    const html = creatorJobsHtml([job({ label: "<script>1</script>", error: "<img src=x>" })]);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
  });
});

describe("the studio body", () => {
  test("all three sections render together, and a missing payload fails honest", () => {
    const html = creatorStudioHtml(view());
    expect(html).toContain("cst-integrations");
    expect(html).toContain("Recent jobs");
    expect(html).toContain("cst-lib");
    expect(creatorStudioHtml(null)).toContain("Nothing is configured behind your back");
  });

  test("the shape gate rejects junk", () => {
    expect(isCreatorStudio(view())).toBe(true);
    expect(isCreatorStudio({ providers: [] })).toBe(false);
    expect(isCreatorStudio(null)).toBe(false);
  });
});
