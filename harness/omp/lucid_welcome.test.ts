// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/lucid_welcome.test.ts — P-BRAND.1 (#314): pure-core unit tests for the LUCID TUI welcome
// banner (layout, copy, fail-open apply). Zero omp runtime imports; exercises the headless surface only.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  applyWelcome,
  LSP_MAX,
  lucidVersion,
  renderWelcomeLines,
  SESSION_MAX,
  TAGLINE,
  TIP_HINTS,
  welcomeEnabled,
  WIDGET_KEY,
  type WelcomeLsp,
  type WelcomePaint,
  type WelcomeSession,
  type WidgetSetter,
} from "./lucid_welcome.ts";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Identity paint — passes through unchanged. */
const idPaint: WelcomePaint = {
  accent: (s: string) => s,
  muted: (s: string) => s,
  bold: (s: string) => s,
};

/** Wrapping paint that tags accent regions for assertion. */
const tagPaint: WelcomePaint = {
  accent: (s: string) => `[A]${s}[/A]`,
  muted: (s: string) => `[M]${s}[/M]`,
  bold: (s: string) => `[B]${s}[/B]`,
};

/** Typed spy call record for setWidget. */
interface SpyCall {
  key: string;
  content: string[] | undefined;
  opts?: { placement?: "aboveEditor" | "belowEditor" };
}

/** Create a typed setWidget spy that records every invocation. */
function createSpy(): { fn: WidgetSetter; calls: SpyCall[] } {
  const calls: SpyCall[] = [];
  const fn: WidgetSetter = (
    key: string,
    content: string[] | undefined,
    opts?: { placement?: "aboveEditor" | "belowEditor" },
  ): void => {
    calls.push({ key, content, opts });
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// welcomeEnabled
// ---------------------------------------------------------------------------

describe("welcomeEnabled", () => {
  test("empty env → true", () => {
    expect(welcomeEnabled({})).toBe(true);
  });

  test.each([
    ["off", false],
    ["0", false],
    ["false", false],
    ["OFF", false],
    [" off ", false],
    ["on", true],
    ["1", true],
    ["", true],
  ] as const)("LUCID_WELCOME=%j → %p", (value: string, expected: boolean) => {
    expect(welcomeEnabled({ LUCID_WELCOME: value })).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// renderWelcomeLines — core
// ---------------------------------------------------------------------------

describe("renderWelcomeLines", () => {
  test("returns non-empty string[]", () => {
    const lines = renderWelcomeLines();
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });

  test("joined output contains LUCID", () => {
    const joined = renderWelcomeLines().join("\n");
    expect(joined).toContain("LUCID");
  });

  test("contains TAGLINE", () => {
    const joined = renderWelcomeLines().join("\n");
    expect(joined).toContain(TAGLINE);
  });

  test("Tips section is always present", () => {
    const joined = renderWelcomeLines().join("\n");
    expect(joined).toContain(TIP_HINTS);
  });

  test("version renders as 'LUCID v1.2.3'", () => {
    const joined = renderWelcomeLines({ version: "1.2.3" }).join("\n");
    expect(joined).toContain("LUCID v1.2.3");
  });

  test("model renders in output", () => {
    const joined = renderWelcomeLines({ model: "Claude Opus 4.8" }).join("\n");
    expect(joined).toContain("Claude Opus 4.8");
  });

  // ---------------------------------------------------------------------------
  // NO-OMP branding — word-boundary check (/\bomp\b/i, NOT /omp/i)
  // ---------------------------------------------------------------------------

  describe("no omp branding", () => {
    test("brand-only render does not contain the word omp", () => {
      const joined = renderWelcomeLines({ version: "1.2.3" }).join("\n");
      expect(joined).not.toMatch(/\bomp\b/i);
    });

    test("fully-populated render does not contain the word omp", () => {
      const joined = renderWelcomeLines({
        paint: idPaint,
        version: "1.2.3",
        model: "Claude Opus 4.8",
        lsp: [{ name: "clangd", fileTypes: [".c", ".cpp", ".cc"] }],
        recent: [{ name: "Implement extension UI theme setter", timeAgo: "7/5/2026" }],
      }).join("\n");
      expect(joined).not.toMatch(/\bomp\b/i);
    });
  });

  // ---------------------------------------------------------------------------
  // LSP section
  // ---------------------------------------------------------------------------

  describe("LSP section", () => {
    test("renders server name and file types", () => {
      const joined = renderWelcomeLines({
        lsp: [{ name: "clangd", fileTypes: [".c", ".cpp", ".cc"] }],
      }).join("\n");
      expect(joined).toContain("clangd");
      expect(joined).toContain(".cpp");
    });

    test("caps at LSP_MAX servers", () => {
      const servers: WelcomeLsp[] = Array.from({ length: LSP_MAX + 3 }, (_: unknown, i: number) => ({
        name: `server-${i}`,
        fileTypes: [".ts"],
      }));
      const joined = renderWelcomeLines({ lsp: servers }).join("\n");

      // First LSP_MAX names are present
      for (let i = 0; i < LSP_MAX; i++) {
        expect(joined).toContain(`server-${i}`);
      }
      // Names beyond LSP_MAX are absent
      for (let i = LSP_MAX; i < LSP_MAX + 3; i++) {
        expect(joined).not.toContain(`server-${i}`);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Recent sessions section
  // ---------------------------------------------------------------------------

  describe("Recent section", () => {
    test("renders session name and timeAgo", () => {
      const joined = renderWelcomeLines({
        recent: [{ name: "Implement extension UI theme setter", timeAgo: "7/5/2026" }],
      }).join("\n");
      expect(joined).toContain("Implement extension UI theme setter");
      expect(joined).toContain("7/5/2026");
    });

    test("caps at SESSION_MAX sessions", () => {
      const sessions: WelcomeSession[] = Array.from(
        { length: SESSION_MAX + 3 },
        (_: unknown, i: number) => ({
          name: `session-${i}`,
          timeAgo: `${i}d ago`,
        }),
      );
      const joined = renderWelcomeLines({ recent: sessions }).join("\n");

      for (let i = 0; i < SESSION_MAX; i++) {
        expect(joined).toContain(`session-${i}`);
      }
      for (let i = SESSION_MAX; i < SESSION_MAX + 3; i++) {
        expect(joined).not.toContain(`session-${i}`);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Paint wrapping
  // ---------------------------------------------------------------------------

  test("paint wrapping appears in output", () => {
    const joined = renderWelcomeLines({ paint: tagPaint, version: "1.0.0" }).join("\n");
    expect(joined).toContain("[A]");
    expect(joined).toContain("[/A]");
  });
});

// ---------------------------------------------------------------------------
// lucidVersion
// ---------------------------------------------------------------------------

describe("lucidVersion", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  test("reads version from a valid package.json", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "lucid-welcome-"));
    const pkg = join(tmpDir, "package.json");
    writeFileSync(pkg, JSON.stringify({ version: "9.9.9" }));
    expect(lucidVersion(pkg)).toBe("9.9.9");
  });

  test("nonexistent path → empty string", () => {
    expect(lucidVersion("/tmp/__does_not_exist_lucid_test__.json")).toBe("");
  });

  test("malformed JSON → empty string", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "lucid-welcome-"));
    const pkg = join(tmpDir, "package.json");
    writeFileSync(pkg, "NOT JSON{{{");
    expect(lucidVersion(pkg)).toBe("");
  });

  test("JSON without version field → empty string", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "lucid-welcome-"));
    const pkg = join(tmpDir, "package.json");
    writeFileSync(pkg, JSON.stringify({ name: "x" }));
    expect(lucidVersion(pkg)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// applyWelcome — fail-open
// ---------------------------------------------------------------------------

describe("applyWelcome", () => {
  test("hasUI:false → not applied, spy not called", () => {
    const spy = createSpy();
    const result = applyWelcome({
      hasUI: false,
      paint: idPaint,
      setWidget: spy.fn,
    });
    expect(result.applied).toBe(false);
    expect(spy.calls).toHaveLength(0);
  });

  test("disabled via LUCID_WELCOME → not applied, spy not called", () => {
    const spy = createSpy();
    const result = applyWelcome({
      hasUI: true,
      env: { LUCID_WELCOME: "off" },
      paint: idPaint,
      setWidget: spy.fn,
    });
    expect(result.applied).toBe(false);
    expect(spy.calls).toHaveLength(0);
  });

  test("throwing setWidget → not applied, does not throw", () => {
    const throwingSetter: WidgetSetter = (
      _key: string,
      _content: string[] | undefined,
      _opts?: { placement?: "aboveEditor" | "belowEditor" },
    ): void => {
      throw new Error("setWidget boom");
    };

    const result = applyWelcome({
      hasUI: true,
      env: {},
      paint: idPaint,
      setWidget: throwingSetter,
    });
    expect(result.applied).toBe(false);
    // The call must NOT propagate the throw
  });

  test("happy path → applied:true, spy called once with correct args", () => {
    const spy = createSpy();
    const lsp: readonly WelcomeLsp[] = [{ name: "clangd", fileTypes: [".c", ".cpp"] }];
    const recent: readonly WelcomeSession[] = [
      { name: "Implement extension UI theme setter", timeAgo: "7/5/2026" },
    ];
    const result = applyWelcome({
      hasUI: true,
      env: {},
      paint: idPaint,
      version: "2.0.0",
      model: "Claude Opus 4.8",
      lsp,
      recent,
      setWidget: spy.fn,
    });

    expect(result.applied).toBe(true);
    expect(spy.calls).toHaveLength(1);

    const call = spy.calls[0];
    if (!call) throw new Error("expected exactly one setWidget call");
    expect(call.key).toBe(WIDGET_KEY);
    expect(Array.isArray(call.content)).toBe(true);

    const joined = (call.content ?? []).join("\n");
    expect(joined).toContain("LUCID");
    expect(joined).toContain("clangd");
    expect(joined).toContain("Implement extension UI theme setter");

    expect(call.opts).toEqual({ placement: "aboveEditor" });
  });
});
