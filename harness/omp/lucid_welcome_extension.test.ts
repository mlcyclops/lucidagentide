// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyWelcome,
  lucidVersion,
  renderWelcomeLines,
  TAGLINE,
  welcomeEnabled,
  WIDGET_KEY,
  type WelcomePaint,
  type WidgetSetter,
} from "./lucid_welcome_extension.ts";

const idPaint: WelcomePaint = { accent: (s) => s, muted: (s) => s, bold: (s) => s };

// ── welcomeEnabled matrix ───────────────────────────────────────────────────

test("welcomeEnabled: empty env → true", () => {
  expect(welcomeEnabled({})).toBe(true);
});

test("welcomeEnabled: 'off' → false", () => {
  expect(welcomeEnabled({ LUCID_WELCOME: "off" })).toBe(false);
});

test("welcomeEnabled: '0' → false", () => {
  expect(welcomeEnabled({ LUCID_WELCOME: "0" })).toBe(false);
});

test("welcomeEnabled: 'false' → false", () => {
  expect(welcomeEnabled({ LUCID_WELCOME: "false" })).toBe(false);
});

test("welcomeEnabled: 'OFF' (case-insensitive) → false", () => {
  expect(welcomeEnabled({ LUCID_WELCOME: "OFF" })).toBe(false);
});

test("welcomeEnabled: ' off ' (whitespace-padded) → false", () => {
  expect(welcomeEnabled({ LUCID_WELCOME: " off " })).toBe(false);
});

test("welcomeEnabled: 'on' → true", () => {
  expect(welcomeEnabled({ LUCID_WELCOME: "on" })).toBe(true);
});

test("welcomeEnabled: '1' → true", () => {
  expect(welcomeEnabled({ LUCID_WELCOME: "1" })).toBe(true);
});

test("welcomeEnabled: '' (empty string) → true", () => {
  expect(welcomeEnabled({ LUCID_WELCOME: "" })).toBe(true);
});

// ── renderWelcomeLines ──────────────────────────────────────────────────────

test("renderWelcomeLines returns a non-empty string[]", () => {
  const lines = renderWelcomeLines();
  expect(Array.isArray(lines)).toBe(true);
  expect(lines.length).toBeGreaterThan(0);
});

test("renderWelcomeLines joined output contains 'LUCID'", () => {
  expect(renderWelcomeLines().join("\n")).toContain("LUCID");
});

test("renderWelcomeLines joined output contains TAGLINE", () => {
  expect(renderWelcomeLines().join("\n")).toContain(TAGLINE);
});

test("renderWelcomeLines with version includes 'LUCID v1.2.3'", () => {
  expect(renderWelcomeLines({ version: "1.2.3" }).join("\n")).toContain("LUCID v1.2.3");
});

test("renderWelcomeLines with model includes the model name", () => {
  expect(renderWelcomeLines({ model: "Claude Opus 4.8" }).join("\n")).toContain("Claude Opus 4.8");
});

test("renderWelcomeLines brand-only render (version, no model) never matches /omp/i", () => {
  expect(renderWelcomeLines({ version: "1.2.3" }).join("\n")).not.toMatch(/omp/i);
});

test("renderWelcomeLines applies a wrapping paint", () => {
  const wrapping: WelcomePaint = {
    accent: (s) => "[A]" + s + "[/A]",
    muted: (s) => "[M]" + s + "[/M]",
    bold: (s) => "[B]" + s + "[/B]",
  };
  const joined = renderWelcomeLines({ paint: wrapping }).join("\n");
  expect(joined).toContain("[A]");
  expect(joined).toContain("[/A]");
});

// ── lucidVersion ────────────────────────────────────────────────────────────

let tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true });
    } catch {
      /* cleanup best-effort */
    }
  }
  tmpDirs = [];
});

function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "lucid-welcome-"));
  tmpDirs.push(d);
  return d;
}

test("lucidVersion: valid package.json → version string", () => {
  const d = makeTmpDir();
  const p = join(d, "package.json");
  writeFileSync(p, JSON.stringify({ version: "9.9.9" }));
  expect(lucidVersion(p)).toBe("9.9.9");
});

test("lucidVersion: nonexistent path → ''", () => {
  expect(lucidVersion("/nonexistent/does-not-exist/package.json")).toBe("");
});

test("lucidVersion: malformed JSON → ''", () => {
  const d = makeTmpDir();
  const p = join(d, "package.json");
  writeFileSync(p, "{{not json");
  expect(lucidVersion(p)).toBe("");
});

test("lucidVersion: JSON with no version field → ''", () => {
  const d = makeTmpDir();
  const p = join(d, "package.json");
  writeFileSync(p, JSON.stringify({ name: "x" }));
  expect(lucidVersion(p)).toBe("");
});

// ── applyWelcome (FAIL-OPEN) ────────────────────────────────────────────────

interface SetWidgetCall {
  key: string;
  content: string[] | undefined;
  opts: { placement?: "aboveEditor" | "belowEditor" } | undefined;
}

function widgetSpy(): { fn: WidgetSetter; calls: SetWidgetCall[] } {
  const calls: SetWidgetCall[] = [];
  const fn: WidgetSetter = (key, content, opts) => {
    calls.push({ key, content, opts });
  };
  return { fn, calls };
}

test("applyWelcome: hasUI=false → not applied, setWidget NOT called", () => {
  const spy = widgetSpy();
  const r = applyWelcome({ hasUI: false, paint: idPaint, setWidget: spy.fn });
  expect(r.applied).toBe(false);
  expect(spy.calls).toHaveLength(0);
});

test("applyWelcome: LUCID_WELCOME=off → not applied, setWidget NOT called", () => {
  const spy = widgetSpy();
  const r = applyWelcome({ hasUI: true, env: { LUCID_WELCOME: "off" }, paint: idPaint, setWidget: spy.fn });
  expect(r.applied).toBe(false);
  expect(spy.calls).toHaveLength(0);
});

test("applyWelcome: throwing setWidget → not applied, does NOT throw (FAIL-OPEN)", () => {
  const throwing: WidgetSetter = () => {
    throw new Error("widget exploded");
  };
  const r = applyWelcome({ hasUI: true, paint: idPaint, setWidget: throwing });
  expect(r.applied).toBe(false);
  // reaching here proves it didn't throw
});

test("applyWelcome: happy path → applied, setWidget called once with correct shape", () => {
  const spy = widgetSpy();
  const r = applyWelcome({
    hasUI: true,
    paint: idPaint,
    version: "2.0.0",
    model: "Claude Opus",
    setWidget: spy.fn,
  });
  expect(r.applied).toBe(true);
  expect(spy.calls).toHaveLength(1);
  const call = spy.calls[0]!;
  expect(call.key).toBe(WIDGET_KEY);
  expect(Array.isArray(call.content)).toBe(true);
  expect(call.content!.join("\n")).toContain("LUCID");
  expect(call.opts).toEqual({ placement: "aboveEditor" });
});
