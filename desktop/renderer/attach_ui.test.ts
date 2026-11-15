// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/attach_ui.test.ts - P-ATTACH.1 (ADR-0598): the file-type icons, the chip tooltip text and
// the tray's limits and image routing, against an injected fake bridge.

import { describe, expect, test } from "bun:test";
import { ATTACH_EXT, ATTACH_LIMITS, type AttachPolicyView, type StagedAttachment, type StageResult } from "../attach_kinds.ts";
import { chipTip, createTrayModel, effectivePolicy, fileIconSvg, ICON_KINDS, isAttachShortcut, isHiddenPath, isRoutedImage, viewOfName, viewOfStaged, type AttachBridge } from "./attach_ui.ts";
import { parseTip } from "./tip_text.ts";

const ON: AttachPolicyView = { enabled: true, files: 10, bytes: 25 * 1024 * 1024, retentionDays: 7 };

function staged(name: string, id: string): StagedAttachment {
  return { id, name, ext: name.split(".").pop() ?? "", kind: "markdown", label: "Markdown document", bytes: 5, stagedPath: `C:\\LUCID\\attachments\\${id}\\${name}`, chars: 5, truncated: false };
}

function fake(opts: { policy?: AttachPolicyView | null; stage?: (name: string) => StageResult | null | Promise<StageResult | null> } = {}) {
  const stagedNames: string[] = [];
  const removed: string[] = [];
  let n = 0;
  const bridge: AttachBridge = {
    attachmentPolicy: async () => (opts.policy === undefined ? ON : opts.policy),
    attachmentStage: async (f) => { stagedNames.push(f.name); return opts.stage ? opts.stage(f.name) : { ok: true, attachment: staged(f.name, `a${++n}`) }; },
    attachmentRemove: async (id) => { removed.push(id); return true; },
    pathForFile: () => null,
  };
  return { bridge, stagedNames, removed };
}

const file = (name: string, body = "hello", type = ""): File => new File([body], name, { type });
const readBase64 = async (f: File): Promise<string> => Buffer.from(await f.arrayBuffer()).toString("base64");

describe("file-type icons", () => {
  test("every kind in ATTACH_EXT, plus other, has its own icon", () => {
    const kinds = new Set(Object.values(ATTACH_EXT).map((i) => i.kind));
    for (const k of kinds) expect(ICON_KINDS).toContain(k);
    expect(ICON_KINDS).toContain("other");
    const svgs = ICON_KINDS.map((k) => fileIconSvg(k, "zz"));
    expect(new Set(svgs).size).toBe(ICON_KINDS.length);
    for (const k of ICON_KINDS) expect(fileIconSvg(k, "zz")).toContain(`fi-${k}`);
  });

  test("a known kind ignores the extension; the catch-all shows it", () => {
    expect(fileIconSvg("pdf", "a")).toBe(fileIconSvg("pdf", "b"));
    expect(fileIconSvg("other", "dwg")).toContain(">DWG</text>");
    expect(fileIconSvg("other", "dwg")).not.toBe(fileIconSvg("other", "stl"));
  });

  test("the catch-all escapes the extension and keeps at most four characters", () => {
    const svg = fileIconSvg("other", `<b>"x`);
    expect(svg).toContain("&lt;B&gt;");
    expect(svg).not.toContain("<B>");
    expect(fileIconSvg("other", "abcdefg")).toContain(">ABCD</text>");
  });

  test("no extension draws dots, and an unknown kind is the catch-all", () => {
    expect(fileIconSvg("other", "")).not.toContain("<text");
    expect(fileIconSvg("nonsense", "q")).toContain("fi-other");
  });
});

describe("chip tooltip", () => {
  test("names the source path, the type, the size and the managed copy", () => {
    const a = { ...staged("plan.md", "a1"), sourcePath: "C:\\Users\\me\\plan.md", chars: 1234 };
    const t = parseTip(chipTip(viewOfStaged(a)));
    expect(t.title).toBe("plan.md");
    expect(t.desc.split("\n")).toEqual([
      "Source: C:\\Users\\me\\plan.md",
      "Type: .md (Markdown document)",
      "Size: 5 B",
      `Copy: ${a.stagedPath} (kept 7 days)`,
      "Text: 1,234 characters",
    ]);
  });

  test("without a source path it says the browser hides it", () => {
    const t = parseTip(chipTip(viewOfStaged(staged("x.md", "a1"))));
    expect(t.desc).toContain("Source: Not available in the browser");
  });

  test("a blocked file shows why, and no copy line", () => {
    const v = { ...viewOfName("setup.exe", 2048), state: "blocked" as const, reason: "Programs cannot be attached." };
    const t = parseTip(chipTip(v));
    expect(t.desc).toContain("Blocked: Programs cannot be attached.");
    expect(t.desc).not.toContain("Copy:");
    expect(t.desc).toContain("Type: .exe (.exe file)");
  });

  test("a pipe in the file name stays in the title", () => {
    const t = parseTip(chipTip(viewOfStaged(staged("a|b.md", "a1"))));
    expect(t.title).toBe("a|b.md");
    expect(t.desc.startsWith("Source:")).toBe(true);
  });

  test("a truncated file says the agent can read the rest", () => {
    const t = parseTip(chipTip(viewOfStaged({ ...staged("big.md", "a1"), truncated: true, chars: 1 })));
    expect(t.desc).toContain("Text: 1 character (the prompt carries the first part");
  });
});

describe("tray", () => {
  test("stages files and returns their ids", async () => {
    const f = fake();
    const tray = createTrayModel({ bridge: f.bridge, onImages: () => {}, readBase64 });
    await tray.add([file("a.md"), file("b.ts")]);
    expect(f.stagedNames).toEqual(["a.md", "b.ts"]);
    expect(tray.ids()).toEqual(["a1", "a2"]);
    expect(tray.items().every((i) => i.state === "ready")).toBe(true);
  });

  test("enforces the file count, images on the bar included", async () => {
    const f = fake({ policy: { ...ON, files: 3 } });
    const tray = createTrayModel({ bridge: f.bridge, onImages: () => {}, imageCount: () => 1, readBase64 });
    await tray.add([file("a.md"), file("b.md"), file("c.md")]);
    expect(f.stagedNames).toEqual(["a.md", "b.md"]);
    const c = tray.items().find((i) => i.name === "c.md")!;
    expect(c.state).toBe("blocked");
    expect(c.reason).toContain("Up to 3 files per message");
  });

  test("enforces the size limit before anything is sent to the engine", async () => {
    const f = fake({ policy: { ...ON, bytes: 10 } });
    const tray = createTrayModel({ bridge: f.bridge, onImages: () => {}, readBase64 });
    await tray.add([file("big.txt", "x".repeat(11)), file("ok.txt", "x".repeat(10))]);
    expect(f.stagedNames).toEqual(["ok.txt"]);
    expect(tray.items().find((i) => i.name === "big.txt")?.reason).toContain("larger than the 10 B limit");
  });

  test("a policy above the hard limits is clamped to them", () => {
    expect(effectivePolicy({ enabled: true, files: 500, bytes: 1e12, retentionDays: 30 })).toEqual({ enabled: true, files: ATTACH_LIMITS.files, bytes: ATTACH_LIMITS.bytes, retentionDays: 30 });
    expect(effectivePolicy(null).enabled).toBe(false);
  });

  test("routes images to the bar's image path and counts them toward the limit", async () => {
    const f = fake({ policy: { ...ON, files: 2 } });
    const routed: string[] = [];
    const tray = createTrayModel({ bridge: f.bridge, onImages: (files) => routed.push(...files.map((x) => x.name)), readBase64 });
    await tray.add([file("shot.png", "png", "image/png"), file("a.md"), file("b.md")]);
    expect(routed).toEqual(["shot.png"]);
    expect(f.stagedNames).toEqual(["a.md"]);
    expect(tray.items().find((i) => i.name === "b.md")?.state).toBe("blocked");
  });

  test("an SVG or HEIC is staged as a file, not sent down the image path", () => {
    expect(isRoutedImage("logo.svg", "image/svg+xml")).toBe(false);
    expect(isRoutedImage("photo.heic", "image/heic")).toBe(false);
    expect(isRoutedImage("photo.jpg", "image/jpeg")).toBe(true);
    expect(isRoutedImage("", "image/png")).toBe(true);
    expect(isRoutedImage("notes.md", "image/png")).toBe(false);
  });

  test("refused formats and an off policy block without staging; images still route", async () => {
    const off = fake({ policy: { ...ON, enabled: false } });
    const routed: string[] = [];
    const tray = createTrayModel({ bridge: off.bridge, onImages: (files) => routed.push(...files.map((x) => x.name)), readBase64 });
    await tray.add([file("a.md"), file("setup.exe"), file("p.gif", "g", "image/gif")]);
    expect(off.stagedNames).toEqual([]);
    expect(routed).toEqual(["p.gif"]);
    expect(tray.items().map((i) => i.state)).toEqual(["blocked", "blocked"]);
    expect(tray.items()[1]!.reason).toBe("Programs cannot be attached.");
  });

  test("an unreachable engine reads as attachments off (fail-closed)", async () => {
    const f = fake({ policy: null });
    const tray = createTrayModel({ bridge: f.bridge, onImages: () => {}, readBase64 });
    await tray.add([file("a.md")]);
    expect(f.stagedNames).toEqual([]);
    expect(tray.items()[0]!.state).toBe("blocked");
  });

  test("the engine's refusal and its silence both block the file", async () => {
    const f = fake({ stage: (name) => (name === "bad.md" ? { ok: false, error: "Hidden instructions were found.", blocked: true } : null) });
    const tray = createTrayModel({ bridge: f.bridge, onImages: () => {}, readBase64 });
    await tray.add([file("bad.md"), file("lost.md")]);
    expect(tray.items().map((i) => [i.state, i.reason])).toEqual([
      ["blocked", "Hidden instructions were found."],
      ["blocked", "LUCID's engine did not answer. Remove the file and add it again."],
    ]);
    expect(tray.ids()).toEqual([]);
  });

  test("an unreadable file is blocked", async () => {
    const f = fake();
    const tray = createTrayModel({ bridge: f.bridge, onImages: () => {}, readBase64: async () => { throw new Error("gone"); } });
    await tray.add([file("a.md")]);
    expect(f.stagedNames).toEqual([]);
    expect(tray.items()[0]!.reason).toBe("The file could not be read.");
  });

  test("a held send keeps the files until it is accepted", async () => {
    const f = fake();
    const tray = createTrayModel({ bridge: f.bridge, onImages: () => {}, readBase64 });
    await tray.add([file("a.md"), file("b.md")]);
    const held = tray.hold().map((a) => a.id);
    expect(held).toEqual(["a1", "a2"]);
    expect(tray.ids()).toEqual([]);
    expect(tray.items().map((i) => i.state)).toEqual(["sending", "sending"]);
    tray.settle(held, false);
    expect(tray.ids()).toEqual(["a1", "a2"]);
    tray.settle(tray.hold().map((a) => a.id), true);
    expect(tray.items()).toEqual([]);
    expect(f.removed).toEqual([]); // an accepted send's copies stay for the agent
  });

  test("remove drops the engine copy, also for a file removed while it was staging", async () => {
    const slow = Promise.withResolvers<StageResult>();
    const called = Promise.withResolvers<void>();
    const f = fake({ stage: (name) => { if (name !== "slow.md") return { ok: true, attachment: staged(name, "fast") }; called.resolve(); return slow.promise; } });
    const tray = createTrayModel({ bridge: f.bridge, onImages: () => {}, readBase64 });
    const done = tray.add([file("slow.md")]);
    await called.promise; // the engine has the file; the user removes it before the answer
    tray.remove(tray.items()[0]!.key);
    slow.resolve({ ok: true, attachment: staged("slow.md", "late") });
    await done;
    expect(tray.items()).toEqual([]);
    expect(f.removed).toEqual(["late"]);
    await tray.add([file("x.md")]);
    tray.remove(tray.items()[0]!.key);
    expect(f.removed).toEqual(["late", "fast"]);
  });

  test("take and restore move ready files off the bar and back", async () => {
    const f = fake({ stage: (name) => (name === "bad.md" ? { ok: false, error: "no" } : { ok: true, attachment: staged(name, name) }) });
    const tray = createTrayModel({ bridge: f.bridge, onImages: () => {}, readBase64 });
    await tray.add([file("a.md"), file("bad.md")]);
    const taken = tray.take();
    expect(taken.map((a) => a.id)).toEqual(["a.md"]);
    expect(tray.items()).toEqual([]);
    tray.restore(taken);
    tray.restore(taken); // twice is once
    expect(tray.ids()).toEqual(["a.md"]);
  });
});

describe("small rules", () => {
  test("Ctrl+U and Cmd+U open the picker; with Shift or Alt they do not", () => {
    const k = (o: Partial<KeyboardEvent>) => ({ key: "u", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });
    expect(isAttachShortcut(k({ ctrlKey: true }))).toBe(true);
    expect(isAttachShortcut(k({ metaKey: true, key: "U" }))).toBe(true);
    expect(isAttachShortcut(k({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isAttachShortcut(k({}))).toBe(false);
  });

  test("hidden folders and dotfiles are skipped by a folder add", () => {
    expect(isHiddenPath("proj/.git/config")).toBe(true);
    expect(isHiddenPath("proj/.env")).toBe(true);
    expect(isHiddenPath("proj/src/index.ts")).toBe(false);
  });
});
