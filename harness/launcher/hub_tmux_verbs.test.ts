// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-TUI.3 (ADR-0436) + P-TUI.5 (ADR-0433): one parser for the CLI, the control server and the `:`
// prompt. tmux muscle memory must land on the op a tmux user expects (split-window -h is SIDE BY SIDE,
// the default is stacked; a window is a TAB and a session is a SPACE), and anything malformed must be
// a usage error, never a silently different command.

import { describe, expect, test } from "bun:test";
import { HubOpError } from "./hub_spaces.ts";
import { parseHubCommand as p, tokenize } from "./hub_tmux_verbs.ts";

const err = (argv: string[]) => { try { p(argv); } catch (e) { return e instanceof HubOpError ? e.code : String(e); } return "parsed"; };

describe("tmux vocabulary", () => {
  test.each([
    [["split-window", "-h"], { op: "pane.split", target: undefined, dir: "right" }],
    [["split-window", "-t", "s1:p2"], { op: "pane.split", target: "s1:p2", dir: "down" }],
    [["select-pane", "-t", "s1:p2"], { op: "pane.focus", target: "s1:p2" }],
    [["kill-pane"], { op: "pane.close", target: undefined }],
    [["swap-pane", "-s", "s1:p1", "-t", "s1:p2"], { op: "pane.swap", source: "s1:p1", target: "s1:p2" }],
    [["resize-pane", "-L", "10"], { op: "pane.resize", target: undefined, dir: "L", n: 10 }],
    [["resize-pane", "-t", "s1:p1", "-D"], { op: "pane.resize", target: "s1:p1", dir: "D", n: 5 }],
    [["resize-pane", "-Z"], { op: "pane.zoom", target: undefined }],
    // window = TAB
    [["new-window", "-n", "work"], { op: "tab.create", name: "work" }],
    [["new-window"], { op: "tab.create" }],
    [["new-window", "-t", "s2"], { op: "tab.create", space: "s2" }],
    [["kill-window", "-t", "s1:t2"], { op: "tab.close", target: "s1:t2" }],
    [["rename-window", "-t", "s1:t2", "ops"], { op: "tab.rename", target: "s1:t2", name: "ops" }],
    [["select-window", "-t", "s1:t1"], { op: "tab.focus", target: "s1:t1" }],
    [["list-windows"], { op: "tab.list", space: "", all: false }],
    [["list-windows", "-a"], { op: "tab.list", all: true }],
    // session = SPACE
    [["new-session", "-s", "work"], { op: "space.create", name: "work" }],
    [["new-session"], { op: "space.create" }],
    [["kill-session", "-t", "s2"], { op: "space.close", target: "s2" }],
    [["rename-session", "-t", "s2", "ops"], { op: "space.rename", target: "s2", name: "ops" }],
    [["switch-client", "-t", "s1"], { op: "space.focus", target: "s1" }],
    [["list-sessions"], { op: "space.list" }],
    [["list-panes"], { op: "pane.list", tab: "", all: false }],
    [["list-panes", "-s"], { op: "pane.list", space: "", all: false }],
    [["list-panes", "-t", "s1:t2"], { op: "pane.list", tab: "s1:t2", all: false }],
    [["list-panes", "-a"], { op: "pane.list", all: true }],
    [["send-keys", "-t", "s1:p1", "-n", "hi", "Enter"], { op: "pane.keys", target: "s1:p1", keys: ["-n", "hi", "Enter"] }],
  ] as const)("%j", (argv, op) => expect(p(argv)).toEqual(op as never));
});

describe("grouped vocabulary", () => {
  test.each([
    [["status"], { op: "status" }],
    [["space", "focus", "work"], { op: "space.focus", target: "work" }],
    [["tab", "list"], { op: "tab.list", all: true }],
    [["tab", "create", "-t", "s2", "logs"], { op: "tab.create", space: "s2", name: "logs" }],
    [["tab", "rename", "-t", "s1:t2", "logs"], { op: "tab.rename", target: "s1:t2", name: "logs" }],
    [["tab", "focus", "s1:t2"], { op: "tab.focus", target: "s1:t2" }],
    [["tab", "close"], { op: "tab.close", target: undefined }],
    [["pane", "list"], { op: "pane.list", all: true }],
    [["pane", "rebind", "-t", "s1:p1", "agent", "lane-1"], { op: "pane.rebind", target: "s1:p1", deck: "agent", lane: "lane-1" }],
    [["pane", "read", "-n", "5000", "-w", "3"], { op: "pane.read", target: undefined, lines: 1000, width: 20 }],
    [["agent", "spawn", "--cwd", "/tmp/x", "--name", "a"], { op: "agent.spawn", cwd: "/tmp/x", name: "a" }],
    [["agent", "prompt", "lane-1", "fix", "the", "-v", "flag"], { op: "agent.prompt", lane: "lane-1", text: "fix the -v flag" }],
    [["agent", "read", "lane-1", "-n", "3"], { op: "agent.read", lane: "lane-1", turns: 3 }],
  ] as const)("%j", (argv, op) => expect(p(argv)).toEqual(op as never));
});

describe("malformed input is a usage error", () => {
  test.each([
    [[]], [["nope"]], [["split-window", "-x"]], [["split-window", "-h", "-v"]], [["select-pane"]],
    [["resize-pane", "-L", "-R"]], [["resize-pane", "-L", "abc"]], [["swap-pane", "-t", "s1:p1"]],
    [["send-keys", "-t", "s1:p1"]], [["agent", "prompt", "lane-1"]], [["pane", "read", "-n"]], [["status", "extra"]],
    [["new-window", "work"]], [["switch-client"]], [["tab", "rename", "-t", "s1:t1"]], [["tab", "nope"]], [["list-sessions", "x"]],
  ] as const)("%j", (argv) => expect(err([...argv])).toBe("usage"));
});

describe("tokenize (the : prompt)", () => {
  test("quotes group, escapes escape, whitespace separates", () => {
    expect(tokenize(`send-keys -t s1:p1 "hello world" Enter`)).toEqual(["send-keys", "-t", "s1:p1", "hello world", "Enter"]);
    expect(tokenize(`rename-window 'my space'  `)).toEqual(["rename-window", "my space"]);
    expect(tokenize(`a\\ b "" c`)).toEqual(["a b", "", "c"]);
    expect(() => tokenize(`"open`)).toThrow(HubOpError);
  });
});
