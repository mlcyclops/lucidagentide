// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-VAULT-ENV.1 (ADR-0477): the pure `.env` half. Parser edge cases (quotes, `export`, comments, multi-line
// values, escapes, duplicates, malformed lines), blanking that keeps every name and touches nothing else,
// and the slot mapping (git host slots, provider key slots, workspace refs).

import { describe, expect, test } from "bun:test";
import { blankDotEnv, guessKind, mapEnvName, parseDotEnv } from "./env_file.ts";

const values = (text: string): Record<string, string> => Object.fromEntries(parseDotEnv(text).entries.map((e) => [e.name, e.value]));

describe("parseDotEnv", () => {
  test("plain, spaced, exported and empty assignments", () => {
    expect(values("A=1\nB = two\nexport C=three\n  export   D=four\nE=\nF=  \n")).toEqual({ A: "1", B: "two", C: "three", D: "four", E: "", F: "" });
    const c = parseDotEnv("export C=x").entries[0]!;
    expect(c.exported).toBe(true);
  });

  test("comments: full-line, inline after whitespace, and a # inside a value stays", () => {
    expect(values("# header\n   # indented\nA=abc # trailing\nB=abc#def\nC=\"q # not a comment\" # real\nD=#x\n")).toEqual({
      A: "abc", B: "abc#def", C: "q # not a comment", D: "",
    });
  });

  test("quotes: single is literal, double decodes escapes, backtick is literal", () => {
    const v = values(String.raw`S='a\nb $X'` + "\n" + String.raw`D="a\nb\t\"c\" \\ \$"` + "\n" + "B=`x 'y' \"z\"`\n");
    expect(v.S).toBe(String.raw`a\nb $X`);
    expect(v.D).toBe("a\nb\t\"c\" \\ $");
    expect(v.B).toBe(`x 'y' "z"`);
  });

  test("multi-line quoted values span lines and record their span", () => {
    const text = "KEY=\"-----BEGIN KEY-----\nline2\n-----END KEY-----\"\nNEXT=1\nSQ='a\nb'\n";
    const p = parseDotEnv(text);
    const key = p.entries.find((e) => e.name === "KEY")!;
    expect(key.value).toBe("-----BEGIN KEY-----\nline2\n-----END KEY-----");
    expect([key.startLine, key.endLine]).toEqual([1, 3]);
    expect(values(text)).toMatchObject({ NEXT: "1", SQ: "a\nb" });
    expect(p.problems).toEqual([]);
  });

  test("CRLF files and a UTF-8 BOM parse the same as LF", () => {
    expect(values("\uFEFFA=1\r\nB=\"x\r\ny\"\r\n")).toEqual({ A: "1", B: "x\ny" });
  });

  test("duplicates: the last assignment wins, every occurrence is kept", () => {
    const p = parseDotEnv("A=1\nB=2\nA=3\n");
    expect(p.entries.map((e) => [e.name, e.value])).toEqual([["A", "3"], ["B", "2"]]);
    expect(p.assignments.filter((a) => a.name === "A")).toHaveLength(2);
  });

  test("malformed lines are reported by line number only and do not stop the parse", () => {
    const p = parseDotEnv("GOOD=1\nnot an assignment sk-SECRET-VALUE\n1BAD=x\nT=\"x\" junk\nZ=3\nU=\"never closed\nAFTER=2\n");
    expect(p.entries.map((e) => e.name)).toEqual(["GOOD", "Z", "AFTER"]);
    // 2: no `=`; 3: a name cannot start with a digit; 4: text after the closing quote; 6: never closed
    // (the parse resumes on the next line, so AFTER is still read).
    expect(p.problems.map((x) => x.line)).toEqual([2, 3, 4, 6]);
    expect(JSON.stringify(p.problems)).not.toContain("SECRET");
  });
});

describe("blankDotEnv", () => {
  const src = [
    "# comment stays",
    "export TOKEN=\"abc",
    "def\"",
    "  INDENTED=xyz # note",
    "KEEP=me",
    "",
    "TOKEN=again",
    "OTHER='o'",
  ].join("\r\n");

  test("blanks every occurrence of the chosen names, keeps names, prefixes, indentation and line endings", () => {
    const out = blankDotEnv(src, new Set(["TOKEN", "INDENTED"]));
    expect(out).toBe(["# comment stays", "export TOKEN=", "  INDENTED=", "KEEP=me", "", "TOKEN=", "OTHER='o'"].join("\r\n"));
    expect(out).not.toContain("abc");
    expect(out).not.toContain("xyz");
    expect(values(out)).toMatchObject({ TOKEN: "", INDENTED: "", KEEP: "me", OTHER: "o" });
  });

  test("without a name set it blanks every assignment; a blanked file re-blanks to itself", () => {
    const out = blankDotEnv(src);
    expect(Object.values(values(out)).every((v) => v === "")).toBe(true);
    expect(parseDotEnv(out).entries.map((e) => e.name)).toEqual(["TOKEN", "INDENTED", "KEEP", "OTHER"]);
    expect(blankDotEnv(out)).toBe(out);
  });

  test("a trailing newline and a BOM survive", () => {
    expect(blankDotEnv("\uFEFFA=1\n", new Set(["A"]))).toBe("\uFEFFA=\n");
  });
});

describe("mapEnvName", () => {
  const providers = new Set(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
  const wsRef = (n: string): string => `ws:0123456789abcdef:${n}`;

  test("git host names fill the per-host git token slots", () => {
    expect(mapEnvName("GITHUB_TOKEN", "v", providers, wsRef)).toEqual({ slot: "git-host", ref: "git_pat_github_com", envName: "LUCID_GIT_PAT_GITHUB_COM", kind: "pat", host: "github.com" });
    expect(mapEnvName("GH_TOKEN", "v", providers, wsRef).ref).toBe("git_pat_github_com");
    expect(mapEnvName("GITLAB_TOKEN", "v", providers, wsRef)).toMatchObject({ ref: "git_pat_gitlab_com", envName: "LUCID_GIT_PAT_GITLAB_COM" });
    expect(mapEnvName("AZURE_DEVOPS_EXT_PAT", "v", providers, wsRef)).toMatchObject({ ref: "git_pat_dev_azure_com", envName: "LUCID_GIT_PAT_DEV_AZURE_COM" });
  });

  test("provider keys fill key:<ENV>; everything else is workspace-scoped", () => {
    expect(mapEnvName("OPENAI_API_KEY", "v", providers, wsRef)).toEqual({ slot: "provider-key", ref: "key:OPENAI_API_KEY", envName: "OPENAI_API_KEY", kind: "apikey" });
    expect(mapEnvName("STRIPE_SECRET_KEY", "v", providers, wsRef)).toEqual({ slot: "workspace", ref: "ws:0123456789abcdef:STRIPE_SECRET_KEY", envName: "STRIPE_SECRET_KEY", kind: "apikey" });
    expect(mapEnvName("github_token", "v", providers, wsRef).slot).toBe("workspace"); // names are case-sensitive
  });

  test("guessKind reads the value shape first, then the name", () => {
    expect(guessKind("ANY", "-----BEGIN PRIVATE KEY-----\nx")).toBe("pem");
    expect(guessKind("ANY", "eyJhbGciOi.eyJzdWIiOi.sig")).toBe("jwt");
    expect(guessKind("DB_PASSWORD", "x")).toBe("password");
    expect(guessKind("SLACK_BOT_TOKEN", "x")).toBe("token");
    expect(guessKind("MY_PAT", "x")).toBe("pat");
    expect(guessKind("PORT", "3000")).toBe("other");
  });
});
