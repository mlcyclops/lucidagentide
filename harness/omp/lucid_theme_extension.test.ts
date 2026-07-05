// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/lucid_theme_extension.test.ts
//
// P-THEME.1 (ADR-0160) — the LUCID skin is COSMETIC and FAIL-OPEN (the deliberate inverse of the
// security gate): every failure path must degrade to "not applied" on omp's default theme, never
// throw, never block a session. These tests pin that, the idempotent provisioning (omp's theme
// file-watcher must not be poked on every launch), the LUCID_THEME escape hatch, and the theme
// asset itself (all 66 required omp color tokens, every value paintable).

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lucidThemeExtension, {
  applyLucidTheme,
  provisionTheme,
  requestedTheme,
  THEME_NAME,
  THEME_SOURCE,
  themesDir,
} from "./lucid_theme_extension.ts";

const SOURCE_JSON = readFileSync(THEME_SOURCE, "utf8");

// ── themesDir: mirrors omp's getCustomThemesDir resolution ───────────────────
test("themesDir honors PI_CODING_AGENT_DIR and falls back to ~/.omp/agent/themes", () => {
  expect(themesDir({ PI_CODING_AGENT_DIR: "/custom/agent" })).toBe(join("/custom/agent", "themes"));
  expect(themesDir({}, "/home/u")).toBe(join("/home/u", ".omp", "agent", "themes"));
  expect(themesDir({ PI_CODING_AGENT_DIR: "" }, "/home/u")).toBe(join("/home/u", ".omp", "agent", "themes"));
});

// ── requestedTheme: the LUCID_THEME escape hatch ─────────────────────────────
test("requestedTheme defaults to lucid, honors off/0/false (any case, trimmed), passes names through", () => {
  expect(requestedTheme({})).toBe(THEME_NAME);
  expect(requestedTheme({ LUCID_THEME: "" })).toBe(THEME_NAME);
  for (const off of ["off", "OFF", "0", "false", "FALSE", " off "]) {
    expect(requestedTheme({ LUCID_THEME: off })).toBeNull();
  }
  expect(requestedTheme({ LUCID_THEME: "titanium" })).toBe("titanium");
});

// ── provisionTheme: idempotent, self-healing ─────────────────────────────────
test("provisionTheme writes once, no-ops on identical bytes, self-heals a mutated file", () => {
  const dir = mkdtempSync(join(tmpdir(), "lucid-theme-test-"));
  try {
    const dest = join(dir, "themes", `${THEME_NAME}.json`);
    expect(provisionTheme(join(dir, "themes"), SOURCE_JSON)).toBe("written");
    expect(readFileSync(dest, "utf8")).toBe(SOURCE_JSON);
    // Idempotence: a second provision must not rewrite (omp watches the file; no spurious reloads).
    expect(provisionTheme(join(dir, "themes"), SOURCE_JSON)).toBe("unchanged");
    writeFileSync(dest, "{ corrupted }", "utf8");
    expect(provisionTheme(join(dir, "themes"), SOURCE_JSON)).toBe("written");
    expect(readFileSync(dest, "utf8")).toBe(SOURCE_JSON);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── applyLucidTheme: the full session_start behavior, DI seams ───────────────
test("applies the lucid theme: provisions into the dir and calls setTheme('lucid')", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lucid-theme-test-"));
  try {
    const calls: string[] = [];
    const r = await applyLucidTheme({
      env: {},
      dir,
      setTheme: async (name) => (calls.push(name), { success: true }),
    });
    expect(r).toEqual({ applied: true, detail: THEME_NAME });
    expect(calls).toEqual([THEME_NAME]);
    expect(readFileSync(join(dir, `${THEME_NAME}.json`), "utf8")).toBe(SOURCE_JSON);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LUCID_THEME=off disables the skin: setTheme never called, nothing provisioned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lucid-theme-test-"));
  try {
    let called = false;
    const r = await applyLucidTheme({
      env: { LUCID_THEME: "off" },
      dir,
      setTheme: async () => ((called = true), { success: true }),
    });
    expect(r.applied).toBe(false);
    expect(called).toBe(false);
    expect(() => readFileSync(join(dir, `${THEME_NAME}.json`))).toThrow(); // nothing written
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LUCID_THEME=<name> wears another theme WITHOUT provisioning (the name must already resolve)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lucid-theme-test-"));
  try {
    const calls: string[] = [];
    const r = await applyLucidTheme({
      env: { LUCID_THEME: "titanium" },
      dir,
      setTheme: async (name) => (calls.push(name), { success: true }),
    });
    expect(r).toEqual({ applied: true, detail: "titanium" });
    expect(calls).toEqual(["titanium"]);
    expect(() => readFileSync(join(dir, `${THEME_NAME}.json`))).toThrow(); // no provisioning for foreign themes
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FAIL-OPEN: an unavailable UI (setTheme success:false) degrades, never throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lucid-theme-test-"));
  try {
    const r = await applyLucidTheme({
      env: {},
      dir,
      setTheme: async () => ({ success: false, error: "Theme changes are unavailable in ACP mode" }),
    });
    expect(r.applied).toBe(false);
    expect(r.detail).toMatch(/unavailable in ACP mode/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FAIL-OPEN: a REJECTING setTheme resolves applied:false (cosmetics can never kill a session)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lucid-theme-test-"));
  try {
    const r = await applyLucidTheme({
      env: {},
      dir,
      setTheme: async () => Promise.reject(new Error("UI exploded")),
    });
    expect(r).toEqual({ applied: false, detail: "UI exploded" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FAIL-OPEN: a throwing readSource (missing/unreadable asset) resolves applied:false", async () => {
  const r = await applyLucidTheme({
    env: {},
    dir: join(tmpdir(), "never-created"),
    readSource: () => {
      throw new Error("asset gone");
    },
    setTheme: async () => ({ success: true }),
  });
  expect(r).toEqual({ applied: false, detail: "asset gone" });
});

// ── the omp extension factory (default export) ───────────────────────────────
type FakeCtx = { ui: { setTheme: (n: string) => Promise<{ success: boolean; error?: string }> } };
type FakeHandler = (e: unknown, ctx: FakeCtx) => Promise<void>;

function fakePi() {
  const registered: { event: string; handler: FakeHandler }[] = [];
  const debugLines: string[] = [];
  const pi = {
    on: (event: string, handler: FakeHandler) => void registered.push({ event, handler }),
    logger: { debug: (m: string) => void debugLines.push(m) },
  };
  return { pi, registered, debugLines };
}

test("the factory registers exactly one session_start handler that provisions + applies via ctx.ui", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lucid-theme-test-"));
  const { pi, registered } = fakePi();
  const calls: string[] = [];
  (lucidThemeExtension as unknown as (p: typeof pi) => void)(pi);
  expect(registered.map((r) => r.event)).toEqual(["session_start"]);
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    await registered[0]!.handler(undefined, { ui: { setTheme: async (n) => (calls.push(n), { success: true }) } });
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
  expect(calls).toEqual([THEME_NAME]);
});

test("the handler logs at debug and RESOLVES when the UI stub declines (headless/print/ACP)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lucid-theme-test-"));
  const { pi, registered, debugLines } = fakePi();
  (lucidThemeExtension as unknown as (p: typeof pi) => void)(pi);
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    await registered[0]!.handler(undefined, { ui: { setTheme: async () => ({ success: false, error: "UI not available" }) } });
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
  expect(debugLines.length).toBe(1);
  expect(debugLines[0]).toMatch(/UI not available/);
});

// ── the theme asset: omp's required token set, every value paintable ─────────
// The 66 required color tokens from omp docs/theme.md — an omp bump that grows this set should be
// caught by re-checking the doc, but a token WE drop or fat-finger fails right here.
const REQUIRED_TOKENS = [
  "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text", "thinkingText",
  "selectedBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg", "statusLineBg",
  "userMessageText", "customMessageText", "customMessageLabel", "toolTitle", "toolOutput",
  "mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder", "mdHr", "mdListBullet",
  "toolDiffAdded", "toolDiffRemoved", "toolDiffContext",
  "syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation",
  "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "bashMode", "pythonMode",
  "statusLineSep", "statusLineModel", "statusLinePath", "statusLineGitClean", "statusLineGitDirty", "statusLineContext",
  "statusLineSpend", "statusLineStaged", "statusLineDirty", "statusLineUntracked", "statusLineOutput", "statusLineCost", "statusLineSubagents",
] as const;

test("themes/lucid.json carries every required omp token and every value resolves to a paintable color", () => {
  const theme = JSON.parse(SOURCE_JSON) as { name: string; vars: Record<string, string>; colors: Record<string, string | number> };
  expect(theme.name).toBe(THEME_NAME);
  expect(REQUIRED_TOKENS.length).toBe(66);
  const missing = REQUIRED_TOKENS.filter((t) => !(t in theme.colors));
  expect(missing).toEqual([]);
  for (const [token, value] of Object.entries(theme.colors)) {
    const paintable =
      value === "" ||
      typeof value === "number" ||
      /^#[0-9a-fA-F]{6}$/.test(value) ||
      /^#[0-9a-fA-F]{6}$/.test(theme.vars[value] ?? "");
    if (!paintable) throw new Error(`token ${token} has unpaintable value ${JSON.stringify(value)}`);
  }
});
