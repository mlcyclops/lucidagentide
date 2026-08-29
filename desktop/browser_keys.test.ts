// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/browser_keys.test.ts - P-BROWSER.2: the agent-supplied key-combo parser. The load-bearing
// property is FAIL-CLOSED naming: Chromium silently swallows an unrecognised keyCode, so a typo that
// parsed "successfully" would ack, do nothing, and send the agent into a retry loop. Every rejection
// here is a named error the agent can act on.

import { describe, expect, test } from "bun:test";
import { parseKeyCombo, supportedKeyNames } from "./browser_keys.ts";

/** Narrow the union: parse results are either a combo or an { error } explanation. */
function combo(input: string): { keyCode: string; modifiers: string[] } {
  const r = parseKeyCombo(input);
  if ("error" in r) throw new Error(`expected "${input}" to parse, got: ${r.error}`);
  return r;
}
function errorOf(input: string): string {
  const r = parseKeyCombo(input);
  if (!("error" in r)) throw new Error(`expected "${input}" to be refused, got keyCode "${r.keyCode}"`);
  return r.error;
}

describe("single keys", () => {
  test("named keys normalize to their Accelerator spelling, case-insensitively", () => {
    expect(combo("Escape")).toEqual({ keyCode: "Escape", modifiers: [] });
    expect(combo("esc")).toEqual({ keyCode: "Escape", modifiers: [] });
    expect(combo("ENTER")).toEqual({ keyCode: "Return", modifiers: [] });
    expect(combo("return")).toEqual({ keyCode: "Return", modifiers: [] });
    expect(combo("pgdn")).toEqual({ keyCode: "PageDown", modifiers: [] });
    expect(combo("ArrowDown")).toEqual({ keyCode: "Down", modifiers: [] });
    expect(combo("  Tab  ")).toEqual({ keyCode: "Tab", modifiers: [] });
  });

  test("single printable characters pass through as themselves", () => {
    expect(combo("a").keyCode).toBe("a");
    expect(combo("7").keyCode).toBe("7");
    expect(combo("/").keyCode).toBe("/");
  });

  test("function keys accept F1 through F24 and reject F0 and F25", () => {
    expect(combo("F1").keyCode).toBe("F1");
    expect(combo("f12").keyCode).toBe("F12");
    expect(combo("F24").keyCode).toBe("F24");
    expect(errorOf("F0")).toContain("unknown key");
    expect(errorOf("F25")).toContain("unknown key");
  });
});

describe("modifiers", () => {
  test("aliases fold onto the Electron tokens, meta covering cmd/super/win", () => {
    expect(combo("Control+a")).toEqual({ keyCode: "a", modifiers: ["control"] });
    expect(combo("ctrl+a").modifiers).toEqual(["control"]);
    expect(combo("Cmd+c").modifiers).toEqual(["meta"]);
    expect(combo("super+c").modifiers).toEqual(["meta"]);
    expect(combo("option+f").modifiers).toEqual(["alt"]);
  });

  test("modifier order is stable regardless of how the agent spelled it", () => {
    expect(combo("Shift+Control+t").modifiers).toEqual(["control", "shift"]);
    expect(combo("Control+Shift+t").modifiers).toEqual(["control", "shift"]);
    expect(combo("meta+alt+shift+control+k").modifiers).toEqual(["control", "alt", "shift", "meta"]);
  });

  test("a repeated modifier is not sent twice", () => {
    expect(combo("Control+ctrl+a").modifiers).toEqual(["control"]);
  });

  test("modifiers combine with named keys", () => {
    expect(combo("Shift+Tab")).toEqual({ keyCode: "Tab", modifiers: ["shift"] });
    expect(combo("Control+Home")).toEqual({ keyCode: "Home", modifiers: ["control"] });
  });
});

describe("refusals name the problem", () => {
  test("empty input explains itself with examples", () => {
    expect(errorOf("")).toContain("Control+a");
    expect(errorOf("   ")).toContain("Escape");
  });

  test("an unknown modifier is named, not silently dropped", () => {
    expect(errorOf("hyper+a")).toContain('unknown modifier "hyper"');
  });

  test("an unknown key name lists what is supported", () => {
    const err = errorOf("pgdown");
    expect(err).toContain('unknown key "pgdown"');
    expect(err).toContain("PageDown");
  });

  test("a multi-character non-name is refused rather than guessed at", () => {
    expect(errorOf("abc")).toContain("unknown key");
  });

  test("an implausibly long string is refused before parsing", () => {
    expect(errorOf("Control+".repeat(20) + "a")).toContain("too long");
  });
});

describe("literal plus", () => {
  test("a trailing plus is the key itself, with modifiers still parsed", () => {
    expect(combo("+")).toEqual({ keyCode: "+", modifiers: [] });
    expect(combo("Control++")).toEqual({ keyCode: "+", modifiers: ["control"] });
  });
});

test("supportedKeyNames covers the named keys the parser accepts", () => {
  const names = supportedKeyNames();
  for (const n of ["Escape", "Return", "Tab", "PageDown", "Up", "Space"]) expect(names).toContain(n);
  expect(names).toContain("F1 to F24");
});
