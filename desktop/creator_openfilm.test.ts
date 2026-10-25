// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import {
  OPENFILM_LOCKED_DOWNLOAD_HOST, OPENFILM_SCAN_LIMITS, checkOpenfilmLauncher, findOpenfilmExternalRefs, isLookSheetPath,
  openfilmEnv, openfilmVersionArgv, parseOpenfilmLook, planOpenfilmLook, planOpenfilmRender, preflightOpenfilm,
  runOpenfilmLook, runOpenfilmRender,
  type OpenfilmDeps, type OpenfilmDirEntry, type OpenfilmLookPlan, type OpenfilmLookPlanInput, type OpenfilmRenderPlan,
  type OpenfilmRenderPlanInput,
} from "./creator_openfilm.ts";
import { createJob, foldJobs, jobsLedger, startJob, type JobIo } from "./creator_jobs.ts";
import { artifactLedger, foldArtifacts, type ArtifactIo } from "./creator_image.ts";
import type { SpawnResult } from "./creator_blender.ts";

const NODE = "C:/node/node.exe";
const CLI = "C:/of/node_modules/openfilm/bin/openfilm.mjs";
const PROJECT = "C:/work/teaser";
const OUT = "C:/creator/openfilm/of_1/render.mp4";
const HOME = "C:/creator/openfilm/home";

const look = (over: Partial<OpenfilmLookPlanInput> = {}): OpenfilmLookPlan => {
  const r = planOpenfilmLook({ exe: NODE, prefixArgs: [CLI], projectDir: PROJECT, ...over });
  if (!r.ok) throw new Error(r.error);
  return r.plan;
};
const lookRefusal = (over: Partial<OpenfilmLookPlanInput>): string => {
  const r = planOpenfilmLook({ exe: NODE, prefixArgs: [CLI], projectDir: PROJECT, ...over });
  if (r.ok) throw new Error("expected a refusal");
  return r.error;
};
const render = (over: Partial<OpenfilmRenderPlanInput> = {}): OpenfilmRenderPlan => {
  const r = planOpenfilmRender({ exe: NODE, prefixArgs: [CLI], projectDir: PROJECT, outPath: OUT, ...over });
  if (!r.ok) throw new Error(r.error);
  return r.plan;
};
const renderRefusal = (over: Partial<OpenfilmRenderPlanInput>): string => {
  const r = planOpenfilmRender({ exe: NODE, prefixArgs: [CLI], projectDir: PROJECT, outPath: OUT, ...over });
  if (r.ok) throw new Error("expected a refusal");
  return r.error;
};

describe("the launcher", () => {
  test("shell shims, package runners, and refused subcommands are refused before anything runs", () => {
    for (const exe of ["C:/of/node_modules/.bin/openfilm.cmd", "C:/x/run.BAT", "C:/x/of.ps1", "C:/x/of.vbs", "/usr/local/bin/of.sh"]) {
      expect(lookRefusal({ exe })).toContain("shell launcher");
    }
    for (const exe of ["C:/node/npx.cmd", "C:/node/npx.exe", "/usr/bin/npx", "C:/x/pnpm.exe", "/usr/bin/pnpx", "/usr/bin/bunx", "C:/x/YARN.exe", "/usr/bin/dlx", "/usr/bin/npm"]) {
      const r = checkOpenfilmLauncher({ exe });
      expect(r.ok).toBe(false);
    }
    expect(checkOpenfilmLauncher({ exe: "/usr/bin/npx" })).toMatchObject({ ok: false, error: expect.stringContaining("package runner") });
    for (const word of ["get", "open", "update", "skill", "skills", "doctor", "GET", " Open "]) {
      expect(lookRefusal({ prefixArgs: [CLI, word] })).toContain("never runs");
    }
    expect(lookRefusal({ exe: "" })).toContain("No OpenFilm executable");
    expect(lookRefusal({ exe: "C:/node/node.exe\u0007" })).toContain("control characters");
    expect(lookRefusal({ prefixArgs: [`${CLI}\n`] })).toContain("control characters");
    expect(openfilmVersionArgv({ exe: NODE, prefixArgs: [CLI] })).toEqual({ ok: true, argv: [NODE, CLI, "--version"] });
    expect(openfilmVersionArgv({ exe: "C:/node/npx.exe", prefixArgs: ["openfilm"] }).ok).toBe(false);
  });
});

describe("the fixed argv", () => {
  test("look: bare, one time, a range, and a count", () => {
    expect(look().argv).toEqual([NODE, CLI, "look"]);
    expect(look({ at: 4.5 }).argv).toEqual([NODE, CLI, "look", "4.5"]);
    expect(look({ range: [1, 3.25], count: 6 }).argv).toEqual([NODE, CLI, "look", "1-3.25", "--count", "6"]);
    expect(look({ at: 0 }).argv).toEqual([NODE, CLI, "look", "0"]);
    expect(look().projectDir).toBe(PROJECT);
  });

  test("look refuses a bad time, range, or count instead of passing it on", () => {
    expect(lookRefusal({ at: -1 })).toContain("at must");
    expect(lookRefusal({ at: Number.NaN })).toContain("at must");
    expect(lookRefusal({ at: Number.POSITIVE_INFINITY })).toContain("at must");
    expect(lookRefusal({ range: [3, 1] })).toContain("end after");
    expect(lookRefusal({ range: [2, 2] })).toContain("end after");
    expect(lookRefusal({ range: [0, Number.NaN] })).toContain("range must");
    expect(lookRefusal({ at: 1, range: [0, 2] })).toContain("not both");
    for (const count of [0, 201, 2.5, Number.NaN]) expect(lookRefusal({ count })).toContain("count");
    expect(look({ count: 200 }).argv).toContain("200");
  });

  test("render: one worker, LUCID's own output path, --alpha only for webm and mov, flags only when asked", () => {
    expect(render().argv).toEqual([NODE, CLI, "render", "--out", OUT, "--fps", "30", "--workers", "1"]);
    expect(render().mime).toBe("video/mp4");
    const webm = render({ format: "webm", outPath: "C:/creator/openfilm/of_1/render.webm", fps: 24, fourK: true, blur: true });
    expect(webm.argv).toEqual([NODE, CLI, "render", "--out", "C:/creator/openfilm/of_1/render.webm", "--fps", "24", "--workers", "1", "--alpha", "--4k", "--blur"]);
    expect(render({ format: "mov", outPath: "C:/o/r.mov" })).toMatchObject({ mime: "video/quicktime", format: "mov" });
    expect(render({ format: "mov", outPath: "C:/o/r.mov" }).argv).toContain("--alpha");
    expect(render({ fps: 29.97 }).argv).toContain("29.97");
  });

  test("render refuses a bad format, fps, or output path", () => {
    expect(renderRefusal({ format: "gif" as never })).toContain("format");
    for (const fps of [0, 241, Number.NaN]) expect(renderRefusal({ fps })).toContain("fps");
    expect(renderRefusal({ outPath: "render.mp4" })).toContain("absolute");
    expect(renderRefusal({ outPath: "C:/o/../r.mp4" })).toContain("absolute");
    expect(renderRefusal({ format: "webm" })).toContain(".webm");
  });

  test("the project folder is absolute, never climbs, has no leading dash, and stays inside managed roots", () => {
    expect(lookRefusal({ projectDir: "teaser" })).toContain("absolute");
    expect(lookRefusal({ projectDir: "C:/work/../Windows" })).toContain("..");
    expect(lookRefusal({ projectDir: "" })).toContain("film.html");
    expect(lookRefusal({ projectDir: "C:/work/t\nrm" })).toContain("control characters");
    expect(lookRefusal({ roots: ["D:/approved"] })).toContain("workspace roots");
    expect(look({ roots: ["c:\\work"] }).projectDir).toBe(PROJECT);
    expect(look({ projectDir: "/home/nick/film", roots: ["/home/nick"] }).projectDir).toBe("/home/nick/film");
    expect(renderRefusal({ projectDir: "/home/nickel/film", roots: ["/home/nick"] })).toContain("workspace roots");
  });
});

describe("the child env", () => {
  const base = {
    PATH: "C:/Windows", LOCALAPPDATA: "C:/Users/n/AppData/Local", PLAYWRIGHT_BROWSERS_PATH: "D:/pw",
    ELEVENLABS_API_KEY: "sk-secret", LUCID_AGENT_TOKEN: "t", HTTPS_PROXY: "http://proxy:8080", npm_config_registry: "https://r",
    OPENFILM_NO_BROWSER: "0", OPENFILM_HOME: "C:/elsewhere", OPENFILM_RUN: "evil", PLAYWRIGHT_DOWNLOAD_HOST: "https://mirror.example",
  };
  test("secrets and proxies are stripped and the opt-outs are forced", () => {
    expect(openfilmEnv(base, { home: HOME, locked: false })).toEqual({
      PATH: "C:/Windows", LOCALAPPDATA: "C:/Users/n/AppData/Local", PLAYWRIGHT_BROWSERS_PATH: "D:/pw",
      OPENFILM_NO_BROWSER: "1", OPENFILM_NO_UPDATE_CHECK: "1", DO_NOT_TRACK: "1", OPENFILM_HOME: HOME,
    });
  });
  test("under lockdown the browser download host is a dead loopback port", () => {
    const env = openfilmEnv(base, { home: HOME, locked: true });
    expect(env.PLAYWRIGHT_DOWNLOAD_HOST).toBe(OPENFILM_LOCKED_DOWNLOAD_HOST);
    expect(env.PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST).toBe(OPENFILM_LOCKED_DOWNLOAD_HOST);
    expect(OPENFILM_LOCKED_DOWNLOAD_HOST).toBe("http://127.0.0.1:9");
  });
});

/** A fake project tree: path -> file text, plus folders implied by paths. */
function tree(files: Record<string, string>, others: string[] = []) {
  const listDir = (dir: string): OpenfilmDirEntry[] => {
    const seen = new Map<string, OpenfilmDirEntry>();
    for (const p of [...Object.keys(files), ...others]) {
      if (!p.startsWith(`${dir}/`)) continue;
      const rest = p.slice(dir.length + 1).split("/");
      const kind = rest.length > 1 ? "dir" : others.includes(p) ? "other" : "file";
      seen.set(rest[0]!, { name: rest[0]!, kind });
    }
    return [...seen.values()];
  };
  return {
    exists: (p: string) => p === NODE || p in files,
    readText: (p: string) => { const t = files[p]; if (t === undefined) throw new Error("ENOENT"); return t; },
    fileSize: (p: string) => (files[p] ?? "").length,
    listDir,
  };
}

describe("external references", () => {
  test("pages, stylesheets, and scripts are scanned; namespaces, data, and relative URLs are not reported", () => {
    expect(findOpenfilmExternalRefs("film.html", `<iframe src="title.html#t=0,2"></iframe><img src="https://cdn.example/a.png">`)).toEqual(["https://cdn.example/a.png"]);
    expect(findOpenfilmExternalRefs("p.html", `<svg xmlns="http://www.w3.org/2000/svg"></svg><script>fetch("https://api.example/x")</script>`)).toEqual(["https://api.example/x"]);
    expect(findOpenfilmExternalRefs("a.css", `body{background:url(//img.example/b.jpg)}`)).toEqual(["//img.example/b.jpg"]);
    expect(findOpenfilmExternalRefs("a.js", `const ns = "http://www.w3.org/2000/svg"; load('https://x.example/m.js'); const r = "./local.png";`)).toEqual(["https://x.example/m.js"]);
    expect(findOpenfilmExternalRefs("a.mjs", "import x from `//esm.example/x.js`")).toEqual(["//esm.example/x.js"]);
  });

  test("locked: an external URL in a page deep in the project refuses; unlocked it is a note", () => {
    const t = tree({ [`${PROJECT}/film.html`]: `<iframe src="pages/a.html"></iframe>`, [`${PROJECT}/pages/a.html`]: `<link href="https://fonts.example/x.css">` });
    const locked = preflightOpenfilm(t, look(), NODE, true);
    expect(locked).toMatchObject({ ok: false, stage: "external-refs" });
    if (!locked.ok) expect(locked.error.startsWith("CUI lockdown:")).toBe(true);
    const open = preflightOpenfilm(t, look(), NODE, false);
    expect(open.ok && open.note).toContain("not offline and not deterministic until");
  });

  test("dot folders and node_modules are not scanned; a clean project passes with no note", () => {
    const t = tree({
      [`${PROJECT}/film.html`]: `<iframe src="a.html"></iframe>`, [`${PROJECT}/a.html`]: `<script>window.film = { frame(t) {} }</script>`,
      [`${PROJECT}/.film/cache/x.html`]: `<img src="https://cdn.example/a.png">`, [`${PROJECT}/node_modules/m/i.js`]: `"https://x.example"`,
    });
    expect(preflightOpenfilm(t, look(), NODE, true)).toEqual({ ok: true, note: "" });
  });

  test("locked: an oversized, unreadable, or linked file refuses (fail-closed); unlocked it is a note", () => {
    const base = { [`${PROJECT}/film.html`]: "<p>x</p>", [`${PROJECT}/big.js`]: "x" };
    const big = { ...tree(base), fileSize: (p: string) => (p.endsWith("big.js") ? OPENFILM_SCAN_LIMITS.maxFileBytes + 1 : 1) };
    expect(preflightOpenfilm(big, look(), NODE, true)).toMatchObject({ ok: false, stage: "external-refs", error: expect.stringContaining("could not be scanned") });
    expect(preflightOpenfilm(big, look(), NODE, false)).toMatchObject({ ok: true, note: expect.stringContaining("could not be scanned") });
    const unreadable = { ...tree(base), readText: (p: string) => { if (p.endsWith("big.js")) throw new Error("EACCES"); return "<p>x</p>"; } };
    expect(preflightOpenfilm(unreadable, look(), NODE, true).ok).toBe(false);
    const linked = tree(base, [`${PROJECT}/linked.html`]);
    expect(preflightOpenfilm(linked, look(), NODE, true).ok).toBe(false);
    const noList = { ...tree(base), listDir: () => { throw new Error("EPERM"); } };
    expect(preflightOpenfilm(noList, look(), NODE, true).ok).toBe(false);
  });

  test("missing executable or film.html refuses before any job exists", () => {
    const t = tree({ [`${PROJECT}/film.html`]: "" });
    expect(preflightOpenfilm({ ...t, exists: () => false }, look(), NODE, false)).toMatchObject({ ok: false, stage: "missing-exe" });
    expect(preflightOpenfilm({ ...t, exists: (p) => p === NODE }, render(), NODE, false)).toMatchObject({ ok: false, stage: "missing-project" });
  });
});

describe("the look verdict", () => {
  const STDOUT = [
    "film  1920×1080 · 6s · 1 sound",
    "♪ 0       music.mp3  6s  -14 LUFS",
    "✗ title.html draws a different picture at 2.5 s the second time",
    "        (the page reads Date.now; use t)",
    "! text cut off: \u202eevil\u200b caption",
    "✓ every frame draws the same picture",
    "→ .film/cache/look/sheet.png",
    "→ C:/elsewhere/x.png",
  ].join("\n");

  test("lines are sorted by mark, continuation lines join their entry, and paths resolve against the project", () => {
    const v = parseOpenfilmLook(STDOUT, 1, PROJECT);
    expect(v.head).toBe("film 1920×1080 · 6s · 1 sound");
    expect(v.ok).toBe(false);
    expect(v.exitCode).toBe(1);
    expect(v.errors).toEqual(["title.html draws a different picture at 2.5 s the second time (the page reads Date.now; use t)"]);
    expect(v.warnings).toEqual(["text cut off: evil caption"]);
    expect(v.passed).toEqual(["every frame draws the same picture"]);
    expect(v.notes).toEqual(["♪ 0 music.mp3 6s -14 LUFS"]);
    expect(v.files).toEqual([`${PROJECT}/.film/cache/look/sheet.png`, "C:/elsewhere/x.png"]);
  });

  test("no head line means no verdict; exit 0 with no errors is ok", () => {
    expect(parseOpenfilmLook("✗ title.html: no window.film", 1, PROJECT).head).toBe("");
    expect(parseOpenfilmLook("film  640×360 · 2s · 0 sounds\n✓ all good", 0, PROJECT).ok).toBe(true);
  });

  test("a look PNG is stored only from inside .film/cache/look", () => {
    expect(isLookSheetPath(PROJECT, `${PROJECT}/.film/cache/look/a.png`)).toBe(true);
    expect(isLookSheetPath(PROJECT, `${PROJECT}/.film/cache/look/sub/a.PNG`)).toBe(true);
    expect(isLookSheetPath(PROJECT, `${PROJECT}/.film/cache/look/a.jpg`)).toBe(false);
    expect(isLookSheetPath(PROJECT, `${PROJECT}/.film/cache/look/../../../x.png`)).toBe(false);
    expect(isLookSheetPath(PROJECT, `${PROJECT}/a.png`)).toBe(false);
    expect(isLookSheetPath(PROJECT, "C:/elsewhere/.film/cache/look/a.png")).toBe(false);
  });
});

const PNG = (w: number, h: number): Uint8Array => {
  const b = new Uint8Array(40);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};

describe("the runners", () => {
  function harness(result: SpawnResult, opts: { bins?: Record<string, Uint8Array>; writeOutput?: boolean; markerFails?: boolean } = {}) {
    const files = new Map<string, string>();
    const bins = new Map<string, Uint8Array>(Object.entries(opts.bins ?? {}));
    let n = 0, a = 0;
    const jobIo: JobIo = {
      ensureDir: () => {}, readText: (p) => files.get(p) ?? "", appendLine: (p, l) => files.set(p, (files.get(p) ?? "") + l + "\n"),
      now: () => 1000 + n, id: () => `job_${++n}`,
    };
    const artifactIo: ArtifactIo = {
      ensureDir: () => {}, writeBytes: (p, b) => { bins.set(p, b); }, writeText: (p, t) => { files.set(p, t); },
      appendLine: (p, l) => files.set(p, (files.get(p) ?? "") + l + "\n"), readText: (p) => files.get(p) ?? "", now: () => 2000, id: () => `art_${++a}`,
    };
    const calls: { argv: readonly string[]; env: Record<string, string>; cwd: string; markerAtSpawn: boolean }[] = [];
    const written: string[] = [];
    const deps: OpenfilmDeps = {
      spawn: async (argv, o) => {
        calls.push({ argv, env: o.env, cwd: o.cwd, markerAtSpawn: files.has(`${PROJECT}/.film/opened`) });
        if (argv.includes("render") && result.code === 0 && opts.writeOutput !== false) bins.set(OUT, new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]));
        return result;
      },
      exists: (p) => bins.has(p) || files.has(p), readText: (p) => files.get(p) ?? "", readBytes: (p) => bins.get(p)!,
      fileSize: () => 1, listDir: () => [],
      writeText: (p, t) => { if (opts.markerFails) throw new Error("EACCES"); written.push(p); files.set(p, t); },
      ensureDir: () => {}, jobIo, artifactIo, env: { PATH: "/usr/bin", ELEVENLABS_API_KEY: "sk-secret" }, now: () => 5000,
    };
    const job = createJob(jobIo, "/base", { kind: "test", label: "OpenFilm look: teaser", provider: "openfilm" });
    startJob(jobIo, "/base", job.id);
    const ledger = () => foldJobs(files.get(jobsLedger("/base")) ?? "").find((j) => j.id === job.id)!;
    const artifacts = () => foldArtifacts(files.get(artifactLedger("/base")) ?? "");
    return { deps, calls, written, jobId: job.id, ledger, artifacts };
  }
  const OPTS = { label: "OpenFilm look: teaser", home: HOME, locked: false };

  test("look writes .film/opened first, runs with the forced env, stores only confined PNGs, and settles done", async () => {
    const sheet = `${PROJECT}/.film/cache/look/sheet.png`;
    const h = harness({
      code: 1, stderr: "",
      stdout: `film  640×360 · 2s · 0 sounds\n✗ a.html draws differently\n→ .film/cache/look/sheet.png\n→ .film/cache/look/fake.png\n→ C:/elsewhere/x.png\n→ .film/cache/look/n.txt`,
    }, { bins: { [sheet]: PNG(640, 360), [`${PROJECT}/.film/cache/look/fake.png`]: new Uint8Array(40), "C:/elsewhere/x.png": PNG(1, 1) } });
    const r = await runOpenfilmLook(h.deps, "/base", h.jobId, look(), OPTS);
    expect(h.written).toEqual([`${PROJECT}/.film/opened`]);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.markerAtSpawn).toBe(true);
    expect(h.calls[0]!.cwd).toBe(PROJECT);
    expect(h.calls[0]!.env).toMatchObject({ OPENFILM_NO_BROWSER: "1", OPENFILM_NO_UPDATE_CHECK: "1", DO_NOT_TRACK: "1", OPENFILM_HOME: HOME });
    expect("ELEVENLABS_API_KEY" in h.calls[0]!.env).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.verdict).toMatchObject({ ok: false, exitCode: 1, errors: ["a.html draws differently"], sheets: ["art_1"] });
    expect(r.note).toContain("3 listed pictures not stored");
    expect(h.ledger()).toMatchObject({ state: "done", artifacts: ["art_1"] });
    expect(h.artifacts()).toEqual([expect.objectContaining({ kind: "image", mime: "image/png", source: "openfilm", width: 640, height: 360 })]);
  });

  test("an existing .film/opened is left alone", async () => {
    const h = harness({ code: 0, stdout: "film  640×360 · 2s · 0 sounds", stderr: "" });
    h.deps.writeText(`${PROJECT}/.film/opened`, "");
    h.written.length = 0;
    await runOpenfilmLook(h.deps, "/base", h.jobId, look(), OPTS);
    expect(h.written).toEqual([]);
  });

  test("no more than four sheets are stored", async () => {
    const bins: Record<string, Uint8Array> = {};
    const lines = ["film  640×360 · 2s · 0 sounds"];
    for (let i = 0; i < 6; i++) { bins[`${PROJECT}/.film/cache/look/s${i}.png`] = PNG(2, 2); lines.push(`→ .film/cache/look/s${i}.png`); }
    const h = harness({ code: 0, stdout: lines.join("\n"), stderr: "" }, { bins });
    const r = await runOpenfilmLook(h.deps, "/base", h.jobId, look(), OPTS);
    expect(r.verdict!.sheets).toHaveLength(4);
    expect(r.verdict!.ok).toBe(true);
  });

  test("exit 2, a crash, a kill, or no head line fails the job with the output's tail", async () => {
    for (const res of [
      { code: 2, stdout: "", stderr: "openfilm look: needs ffmpeg and ffprobe on the PATH" },
      { code: null, stdout: "", stderr: "killed" },
      { code: 1, stdout: "✗ title.html: no window.film", stderr: "" },
      { code: 3, stdout: "film  640×360 · 2s · 0 sounds", stderr: "segfault" },
    ]) {
      const h = harness(res);
      const r = await runOpenfilmLook(h.deps, "/base", h.jobId, look(), OPTS);
      expect(r).toMatchObject({ ok: false, stage: "look", verdict: null });
      expect(h.ledger().state).toBe("failed");
    }
    const h = harness({ code: 2, stdout: "", stderr: "openfilm look: needs ffmpeg" });
    expect((await runOpenfilmLook(h.deps, "/base", h.jobId, look(), OPTS)).error).toContain("needs ffmpeg");
  });

  test("a marker that cannot be written refuses before the CLI runs; so does a relative home", async () => {
    const h = harness({ code: 0, stdout: "", stderr: "" }, { markerFails: true });
    expect(await runOpenfilmLook(h.deps, "/base", h.jobId, look(), OPTS)).toMatchObject({ ok: false, stage: "marker" });
    expect(h.calls).toEqual([]);
    const g = harness({ code: 0, stdout: "", stderr: "" });
    expect(await runOpenfilmRender(g.deps, "/base", g.jobId, render(), { ...OPTS, home: "home" })).toMatchObject({ ok: false, stage: "env" });
    expect(g.calls).toEqual([]);
  });

  test("render stores the video and settles done; locked runs pin the download host", async () => {
    const h = harness({ code: 0, stdout: `→ ${OUT}`, stderr: "" });
    const r = await runOpenfilmRender(h.deps, "/base", h.jobId, render(), { ...OPTS, locked: true });
    expect(r.ok).toBe(true);
    expect(r.artifact).toMatchObject({ kind: "video", mime: "video/mp4", source: "openfilm" });
    expect(h.calls[0]!.env.PLAYWRIGHT_DOWNLOAD_HOST).toBe(OPENFILM_LOCKED_DOWNLOAD_HOST);
    expect(h.ledger()).toMatchObject({ state: "done", artifacts: ["art_1"] });
  });

  test("render exit 0 with no file, or a non-zero exit, fails the job", async () => {
    const none = harness({ code: 0, stdout: "", stderr: "" }, { writeOutput: false });
    expect(await runOpenfilmRender(none.deps, "/base", none.jobId, render(), OPTS)).toMatchObject({ ok: false, stage: "render" });
    expect(none.ledger().state).toBe("failed");
    const two = harness({ code: 2, stdout: "", stderr: "openfilm render: Unknown option '--scale'" });
    const r = await runOpenfilmRender(two.deps, "/base", two.jobId, render(), OPTS);
    expect(r.error).toContain("exit 2");
    expect(two.ledger().state).toBe("failed");
    expect(two.artifacts()).toEqual([]);
  });
});
