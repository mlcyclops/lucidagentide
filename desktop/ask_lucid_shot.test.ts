// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-ASKLUCID.7 (ADR-0588): a picture of the screen for models that can read one.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fitSize, maskRects, normalizeShot, parseShotDataUrl, SHOT_LIMITS, SHOT_NOTE, shotDecision, shotSkipLine, type ScreenShot } from "./ask_lucid_shot.ts";
import { answerAskLucid, type AskDeps } from "./ask_lucid_service.ts";
import { askLucidUser } from "./ask_lucid.ts";
import { seenLine } from "./renderer/ask_lucid_panel.ts";
import { pictureEnabled, pictureToggleHtml, setPictureEnabled, MASKED, PICTURE_KEY } from "./renderer/screen_shot.ts";

const src = (rel: string): string => readFileSync(join(import.meta.dir, rel), "utf8");
const JPEG = `/9j/${"A".repeat(124)}`; // begins the way a JPEG does; 128 base64 characters
const PNG = `iVBORw0KGgo${"A".repeat(117)}`;
const SHOT: ScreenShot = { mime: "image/jpeg", data: JPEG, width: 1500, height: 950 };

describe("normalizeShot", () => {
  test("a well-formed picture is rebuilt from its four fields", () => {
    expect(normalizeShot({ ...SHOT, extra: "dropped", path: "/etc/passwd" })).toEqual(SHOT);
    expect(normalizeShot({ mime: "image/png", data: PNG, width: 64, height: 64 })).toEqual({ mime: "image/png", data: PNG, width: 64, height: 64 });
  });
  test("anything else is no picture", () => {
    const no = (over: Record<string, unknown>): void => expect(normalizeShot({ ...SHOT, ...over })).toBeNull();
    for (const bad of [null, undefined, "x", 7, [], {}]) expect(normalizeShot(bad)).toBeNull();
    no({ mime: "image/svg+xml" }); // script risk
    no({ mime: "image/gif" });
    no({ mime: "text/html" });
    no({ data: PNG }); // says JPEG, begins like a PNG
    no({ data: `/9j/${"A".repeat(123)}` }); // not a whole number of base64 groups
    no({ data: `/9j/${"A".repeat(120)}<b>!` }); // not base64
    no({ data: "/9j/AAAA" }); // too short to be a picture
    no({ data: `/9j/${"A".repeat(SHOT_LIMITS.maxChars)}` }); // over the size bound
    no({ data: `data:image/jpeg;base64,${JPEG}` }); // a data URL is not base64
    no({ width: 0 });
    no({ width: SHOT_LIMITS.maxEdge + 1 });
    no({ height: 12.5 });
    no({ height: "950" });
  });
});

describe("parseShotDataUrl and fitSize", () => {
  test("only a base64 JPEG or PNG data URL parses", () => {
    expect(parseShotDataUrl(`data:image/png;base64,${PNG}`)).toEqual({ mime: "image/png", data: PNG });
    expect(parseShotDataUrl(`data:image/jpeg;base64,${JPEG}`)).toEqual({ mime: "image/jpeg", data: JPEG });
    for (const bad of [null, "", "data:image/svg+xml;base64,AAAA", "data:image/png,raw", "https://example.com/a.png", `data:image/png;base64,${PNG}" onload="x`]) expect(parseShotDataUrl(bad)).toBeNull();
  });
  test("a capture keeps its shape and its longest edge is bounded", () => {
    expect(fitSize(1500, 950)).toEqual({ width: 1500, height: 950, scale: 1 });
    const big = fitSize(3000, 1900);
    expect(big.width).toBe(SHOT_LIMITS.maxEdge);
    expect(big.height).toBe(Math.round(1900 * (SHOT_LIMITS.maxEdge / 3000)));
    expect(fitSize(1000, 4000).height).toBe(SHOT_LIMITS.maxEdge);
    expect(fitSize(0, 10)).toEqual({ width: 0, height: 0, scale: 0 });
  });
});

describe("maskRects", () => {
  const view = { width: 1500, height: 950 };
  test("a field's rectangle is scaled to the picture and grown by the pad", () => {
    // A retina capture scaled to 1568 wide: 1568 / 1500 picture pixels per CSS pixel.
    const pic = { width: 1568, height: 993 };
    const [m] = maskRects([{ x: 500, y: 880, width: 600, height: 40 }], view, pic);
    const sx = 1568 / 1500, sy = 993 / 950;
    expect(m).toEqual({ x: Math.floor(500 * sx) - 2, y: Math.floor(880 * sy) - 2, width: Math.ceil(1100 * sx) + 2 - (Math.floor(500 * sx) - 2), height: Math.ceil(920 * sy) + 2 - (Math.floor(880 * sy) - 2) });
  });
  test("a mask always covers its field: never smaller than the scaled rectangle", () => {
    for (const scale of [0.5, 0.52, 1, 1.045, 2]) {
      const pic = { width: Math.round(1500 * scale), height: Math.round(950 * scale) };
      const r = { x: 333.3, y: 41.7, width: 211.4, height: 19.9 };
      const [m] = maskRects([r], view, pic);
      expect(m!.x).toBeLessThanOrEqual(r.x * (pic.width / view.width));
      expect(m!.y).toBeLessThanOrEqual(r.y * (pic.height / view.height));
      expect(m!.x + m!.width).toBeGreaterThanOrEqual(Math.min(pic.width, (r.x + r.width) * (pic.width / view.width)));
      expect(m!.y + m!.height).toBeGreaterThanOrEqual(Math.min(pic.height, (r.y + r.height) * (pic.height / view.height)));
    }
  });
  test("masks are clamped to the picture, and one that is wholly outside or empty is dropped", () => {
    const pic = { width: 1500, height: 950 };
    expect(maskRects([{ x: -50, y: -50, width: 100, height: 100 }], view, pic)).toEqual([{ x: 0, y: 0, width: 52, height: 52 }]);
    expect(maskRects([{ x: 1450, y: 900, width: 500, height: 500 }], view, pic)).toEqual([{ x: 1448, y: 898, width: 52, height: 52 }]);
    expect(maskRects([{ x: 5000, y: 10, width: 10, height: 10 }, { x: 10, y: 10, width: 0, height: 10 }, { x: Number.NaN, y: 1, width: 5, height: 5 }], view, pic)).toEqual([]);
    expect(maskRects([{ x: 1, y: 1, width: 5, height: 5 }], { width: 0, height: 0 }, pic)).toEqual([]);
  });
});

describe("shotDecision", () => {
  const base = { shot: SHOT, screenSent: true, screenWithheld: false, screenRedacted: false, modelRefused: false };
  test("a picture goes only when every condition holds", () => {
    expect(shotDecision(base)).toEqual({ attach: true, skip: null });
  });
  test("each reason not to wins, and says why", () => {
    expect(shotDecision({ ...base, shot: null })).toEqual({ attach: false, skip: "none" });
    expect(shotDecision({ ...base, screenSent: false })).toEqual({ attach: false, skip: "screen-not-sent" });
    expect(shotDecision({ ...base, screenWithheld: true })).toEqual({ attach: false, skip: "screen-withheld" });
    expect(shotDecision({ ...base, screenRedacted: true })).toEqual({ attach: false, skip: "secret-on-screen" });
    expect(shotDecision({ ...base, modelRefused: true })).toEqual({ attach: false, skip: "model-refused" });
    expect(shotDecision({ ...base, screenWithheld: true, screenRedacted: true, modelRefused: true }).skip).toBe("screen-withheld"); // the scan comes first
  });
  test("the user is told when a picture was held back for a reason worth knowing", () => {
    expect(shotSkipLine("secret-on-screen")).toContain("shaped like a key");
    expect(shotSkipLine("screen-withheld")).toContain("security scan");
    expect(shotSkipLine("model-refused")).toContain("did not accept one");
    for (const quiet of ["none", "off", "screen-not-sent", null, undefined] as const) expect(shotSkipLine(quiet)).toBe("");
  });
});

// ── the service ──────────────────────────────────────────────────────────────────
interface Call { user: string; images: number }
function deps(reply: (call: Call, n: number) => string, over: Partial<AskDeps> = {}): { d: AskDeps; calls: Call[]; refused: string[] } {
  const calls: Call[] = [];
  const refused: string[] = [];
  const d: AskDeps = {
    fleetStatus: async () => ({ lanes: [] }),
    orbit: () => ({}),
    knowledge: async () => [],
    scan: async () => ({ block: false, reason: "clean" }),
    pinModel: () => ({ ok: true, model: "p/vision-model" }),
    complete: async (_s, user, _m, images) => { const c = { user, images: images?.length ?? 0 }; calls.push(c); return reply(c, calls.length); },
    visionRefused: (m) => refused.includes(m ?? ""),
    noteVisionRefused: (m) => { refused.push(m ?? ""); },
    now: () => 1_800_000_000_000,
    ...over,
  };
  return { d, calls, refused };
}
const SCREEN = { surfaces: [{ kind: "Preview panel", title: "page.html", text: "Revenue by region" }] };

describe("answerAskLucid with a picture", () => {
  test("it rides beside the scanned screen text, with a harness note outside any envelope", async () => {
    const { d, calls } = deps(() => "The chart's legend overlaps the title.");
    const r = await answerAskLucid("does this chart look right?", [], d, { screen: SCREEN, shot: SHOT });
    expect(r.ok).toBe(true);
    expect(r.picture).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.images).toBe(1);
    const u = calls[0]!.user;
    expect(u).toContain(`## Picture of the screen\n${SHOT_NOTE}`);
    expect(u.lastIndexOf("UNTRUSTED_CONTENT_END")).toBeLessThan(u.indexOf("## Picture of the screen")); // the note is the harness speaking
    expect(seenLine(r)).toStartWith("Saw your screen (1 surface, with a picture), ");
  });
  test("no picture posted: a text-only call, and nothing about pictures in the prompt or the reply", async () => {
    const { d, calls } = deps(() => "ok");
    const r = await answerAskLucid("hi", [], d, { screen: SCREEN });
    expect(calls[0]!.images).toBe(0);
    expect(calls[0]!.user).not.toContain("Picture of the screen");
    expect(r.picture).toBeUndefined();
    expect(askLucidUser("q", [])).not.toContain("Picture");
  });
  test("FAIL-CLOSED: the screen text fails its scan, so no picture goes either", async () => {
    const { d, calls } = deps(() => "ok", { scan: async (t) => ({ block: t.includes("Revenue by region"), reason: "quarantined" }) });
    const r = await answerAskLucid("what is this?", [], d, { screen: SCREEN, shot: SHOT });
    expect(calls[0]!.images).toBe(0);
    expect(r.picture).toBe("screen-withheld");
    expect(calls[0]!.user).not.toContain("Picture of the screen");
  });
  test("FAIL-CLOSED: a scanner that cannot run sends no picture", async () => {
    const { d, calls } = deps(() => "ok", { scan: async () => { throw new Error("dead"); } });
    const r = await answerAskLucid("what is this?", [], d, { screen: SCREEN, shot: SHOT });
    expect(calls[0]!.images).toBe(0);
    expect(r.picture).toBe("screen-withheld");
  });
  test("a key on screen: the text is redacted and the picture, which cannot be, is not sent", async () => {
    const { d, calls } = deps(() => "ok");
    const r = await answerAskLucid("what is this?", [], d, { screen: { surfaces: [{ kind: "Settings", title: "Keys", text: "stored sk-abcdefghijklmnopqrstuvwxyz123456" }] }, shot: SHOT });
    expect(calls[0]!.images).toBe(0);
    expect(r.picture).toBe("secret-on-screen");
    expect(calls[0]!.user).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
  });
  test("a picture never goes without the screen text", async () => {
    const { d, calls } = deps(() => "ok");
    const r = await answerAskLucid("what is this?", [], d, { shot: SHOT });
    expect(calls[0]!.images).toBe(0);
    expect(r.picture).toBe("screen-not-sent");
  });
  test("a malformed picture is treated as none", async () => {
    const { d, calls } = deps(() => "ok");
    const r = await answerAskLucid("what is this?", [], d, { screen: SCREEN, shot: { mime: "image/svg+xml", data: "PHN2Zz4=", width: 100, height: 100 } });
    expect(calls[0]!.images).toBe(0);
    expect(r.picture).toBeUndefined();
  });
  test("a model that cannot read pictures: asked again with text alone, remembered, and not sent another", async () => {
    const { d, calls, refused } = deps((c) => (c.images > 0 ? 'Provider HTTP 400: {"message":"image input is not supported"}' : "It is a revenue chart."));
    const r = await answerAskLucid("what is this?", [], d, { screen: SCREEN, shot: SHOT });
    expect(calls.map((c) => c.images)).toEqual([1, 0]);
    expect(calls[1]!.user).not.toContain("Picture of the screen");
    expect(r.ok).toBe(true);
    expect(r.reply).toBe("It is a revenue chart.");
    expect(r.picture).toBe("model-refused");
    expect(refused).toEqual(["p/vision-model"]);
    const again = await answerAskLucid("and now?", [], d, { screen: SCREEN, shot: SHOT });
    expect(calls.slice(2).map((c) => c.images)).toEqual([0]); // one call, no picture
    expect(again.picture).toBe("model-refused");
  });
  test("a model that returns nothing, or throws, with a picture is retried the same way", async () => {
    const empty = deps((c) => (c.images > 0 ? "" : "Text answer."));
    expect((await answerAskLucid("q", [], empty.d, { screen: SCREEN, shot: SHOT })).reply).toBe("Text answer.");
    const thrown = deps(() => "Text answer.", { complete: async (_s, _u, _m, images) => { if (images?.length) throw new Error("boom"); return "Text answer."; } });
    const r = await answerAskLucid("q", [], thrown.d, { screen: SCREEN, shot: SHOT });
    expect(r.reply).toBe("Text answer.");
    expect(thrown.refused).toEqual(["p/vision-model"]);
  });
  test("a provider that fails both ways is reported as the provider's failure, and the model is not blamed", async () => {
    const { d, calls, refused } = deps(() => 'Bedrock HTTP 403: {"message":"The security token included in the request is invalid."}');
    const r = await answerAskLucid("q", [], d, { screen: SCREEN, shot: SHOT });
    expect(calls.map((c) => c.images)).toEqual([1, 0]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("HTTP 403");
    expect(refused).toEqual([]);
  });
});

describe("the renderer half, by its source and its pure parts", () => {
  const shotSrc = src("renderer/screen_shot.ts");
  test("everything typed and the panel itself are in the mask list", () => {
    for (const sel of ["input", "textarea", "select", "[contenteditable]", ".ald", ".ald-pill"]) expect(MASKED).toContain(sel);
  });
  test("masks are measured before and after the capture, and both sets are painted", () => {
    const body = shotSrc.slice(shotSrc.indexOf("export async function captureScreen"));
    expect(body.indexOf("const before = collectMaskRects(doc);")).toBeGreaterThan(0);
    expect(body.indexOf("const before = collectMaskRects(doc);")).toBeLessThan(body.indexOf("await capture("));
    expect(body.indexOf("const after = collectMaskRects(doc);")).toBeGreaterThan(body.indexOf("await capture("));
    expect(body).toContain("maskRects([...before, ...after],");
  });
  test("any failure is no picture, and what leaves went through normalizeShot", () => {
    const body = shotSrc.slice(shotSrc.indexOf("export async function captureScreen"));
    expect(body).toContain("} catch { return null; }");
    expect(body).toContain("return out ? normalizeShot(");
    expect(shotSrc).not.toContain("innerHTML");
  });
  test("the preference is on by default, and off is remembered", () => {
    const data: Record<string, string> = {};
    const store = { getItem: (k: string) => (k in data ? data[k]! : null), setItem: (k: string, v: string) => { data[k] = v; }, removeItem: (k: string) => { delete data[k]; } };
    expect(pictureEnabled(store)).toBe(true);
    setPictureEnabled(store, false);
    expect(data[PICTURE_KEY]).toBe("0");
    expect(pictureEnabled(store)).toBe(false);
    setPictureEnabled(store, true);
    expect(pictureEnabled(store)).toBe(true);
    expect(pictureEnabled(null)).toBe(true);
    expect(pictureToggleHtml(false)).not.toContain(" checked");
    expect(pictureToggleHtml(true)).toContain('id="lucidPicture" checked');
  });
  test("the app takes no picture when the preference is off, and the engine keeps the model memory in memory only", () => {
    const app = src("renderer/app.ts");
    const at = app.indexOf("async function shotForLucid()");
    const body = app.slice(at, app.indexOf("\n}\n", at));
    expect(body).toContain("if (!pictureEnabled(miniStore())) return null;");
    const dev = src("dev.ts");
    expect(dev).toContain("const askLucidNoPictures = new Set<string>();");
    expect(dev).not.toMatch(/askLucidNoPictures[^\n]*(writeFileSync|saveSettings)/);
  });
  test("the side completion sends pictures as blocks after the text, and none by default", () => {
    const be = src("acp_backend.ts");
    expect(be).toContain('return [{ type: "text" as const, text: `${system}\\n\\n${user}` }, ...images];');
    expect(be.split("prompt: completionPrompt(system, user, opts) }").length - 1).toBe(2); // the util path and the shared path
  });
});
