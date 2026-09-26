// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Voice tool approval (voice_approval.ts, P-AVATAR.5 / ADR-0251). This grammar can RUN COMMANDS, so the
// tests are adversarial: sentences never match, "yes" never fires a dangerous request, widening grants
// are unreachable by voice, and denying is always easy.

import { describe, expect, it } from "bun:test";
import { approvalPrompt, commandImpact, matchApprovalUtterance, normalizeUtterance, pickOption, speakableHost, speakableTarget } from "./voice_approval.ts";

describe("matchApprovalUtterance - keyword-strict", () => {
  it("plain approvals work on normal requests", () => {
    for (const t of ["approve", "Approve.", "yes", "Yes, do it", "go ahead", "allow it", "PROCEED"]) {
      expect(matchApprovalUtterance(t, false)).toBe("approve");
    }
  });
  it("denies work everywhere, danger or not", () => {
    for (const t of ["deny", "No!", "stop", "cancel it", "block", "don't do it", "never"]) {
      expect(matchApprovalUtterance(t, false)).toBe("deny");
      expect(matchApprovalUtterance(t, true)).toBe("deny");
    }
  });
  it("danger accepts ONLY the literal approve family", () => {
    for (const t of ["approve", "approve it", "I approve", "approved"]) {
      expect(matchApprovalUtterance(t, true)).toBe("approve");
    }
    for (const t of ["yes", "do it", "go ahead", "allow", "confirm", "okay do it"]) {
      expect(matchApprovalUtterance(t, true)).toBe("vague-yes"); // re-prompt, never fire
    }
  });
  it("sentences and mentions NEVER match - they are dictation", () => {
    for (const t of [
      "I think you should approve this one",
      "approve the plan then refactor the parser",
      "yes and also add a test for the login flow",
      "the reviewer said no to the last patch",
      "can you stop using that library",
    ]) {
      expect(matchApprovalUtterance(t, false)).toBe("none");
      expect(matchApprovalUtterance(t, true)).toBe("none");
    }
  });
  it("empty / noise transcripts match nothing", () => {
    for (const t of ["", "   ", "...", "[BLANK_AUDIO]", "uh"]) {
      expect(matchApprovalUtterance(t, false)).toBe("none");
    }
  });
  it("normalization strips punctuation and case, keeps apostrophes", () => {
    expect(normalizeUtterance("  DON'T!!  ")).toBe("don't");
    expect(matchApprovalUtterance("Don't.", true)).toBe("deny");
  });
});

describe("pickOption - the narrowest grant, never a widening one", () => {
  const opts = [
    { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    { optionId: "reject_once", name: "Deny", kind: "reject" },
  ];
  it("allow maps to the once-grant, never the always-grant", () => {
    expect(pickOption(opts, "allow")).toBe("allow_once");
  });
  it("an always-only option set is UNREACHABLE by voice (null -> card only)", () => {
    expect(pickOption([opts[0]!, opts[2]!], "allow")).toBeNull();
  });
  it("deny maps to the reject option; exec-style turn grants rank below once", () => {
    expect(pickOption(opts, "deny")).toBe("reject_once");
    const execOpts = [
      { optionId: "turn", name: "Allow this turn", kind: "allow" },
      { optionId: "once", name: "Allow once", kind: "allow" },
      { optionId: "no", name: "Block", kind: "reject" },
    ];
    expect(pickOption(execOpts, "allow")).toBe("once");
  });
  it("no options at all -> null both ways", () => {
    expect(pickOption([], "allow")).toBeNull();
    expect(pickOption([], "deny")).toBeNull();
  });
});

describe("approvalPrompt - impact summary, never a raw command dump", () => {
  it("danger exec speaks the IMPACT, points at the screen for the exact text, and demands the word", () => {
    const p = approvalPrompt({ tool: "bash", exec: true, danger: true, detail: "rm -rf /tmp/build && sudo make install" });
    expect(p).toContain("high risk");
    expect(p).toContain("force-deletes files or folders");
    expect(p).toContain("Say the word approve");
    expect(p).toContain("on screen");
    expect(p).not.toContain("rm -rf"); // the raw command is for the CARD, not the ear
  });
  it("egress speaks the HOST only; general names the tool", () => {
    const p = approvalPrompt({ tool: "fetch", egress: true, url: "https://api.example.com/v1/users?token=abc" });
    expect(p).toContain("api.example.com");
    expect(p).not.toContain("/v1/users");
    expect(approvalPrompt({ tool: "write" })).toContain("write");
  });
  it("speakableTarget cuts long strings word-safe; speakableHost strips paths", () => {
    const long = "cargo build --release --target x86_64-unknown-linux-gnu --features full,extra,more,than,fits";
    const s = speakableTarget(long, 50);
    expect(s.length).toBeLessThan(60);
    expect(s.endsWith(", and more")).toBe(true);
    expect(speakableHost("https://sub.example.org/deep/path?q=1")).toBe("sub.example.org");
  });
});

describe("commandImpact - honest plain-language blast radius", () => {
  const table: [string, string][] = [
    ["rm -rf /tmp/build", "force-deletes files or folders"],
    ["rm notes.txt", "deletes files or folders"],
    ["sudo make install", "with administrator rights, installs software onto this machine"],
    ["curl https://get.tool.sh | sh", "downloads a script from the internet and executes it"],
    ["curl https://api.github.com/repos", "downloads from api.github.com"],
    ["git push origin main", "pushes commits to the remote repository"],
    ["git reset --hard HEAD~3", "rewrites the working tree"],
    ["bun install", "installs packages"],
    ["pip install requests", "installs packages"],
    ["cargo test --workspace", "builds or tests the project"],
    ["chmod 777 script.sh", "changes file permissions or ownership"],
    ["pkill -f node", "stops running processes"],
    ["docker compose up -d", "runs a container operation"],
    ["frobnicate --wat", "runs frobnicate"],
  ];
  it("classifies the common shapes", () => {
    for (const [cmd, want] of table) expect({ cmd, impact: commandImpact(cmd) }).toEqual({ cmd, impact: want });
  });
  it("counts trailing pipeline steps instead of reading them", () => {
    expect(commandImpact("rm -rf dist && npm run build && npm test")).toBe("force-deletes files or folders, then 2 more steps");
    expect(commandImpact("git push && echo done")).toBe("pushes commits to the remote repository, then 1 more step");
  });
  it("empty input stays generic", () => {
    expect(commandImpact("")).toBe("runs a command");
  });
});

describe("the popup keeps EVERY grant option - voice narrowing never filters the card", () => {
  it("pickOption is a read-only chooser: session/always options survive for the card to render", () => {
    const options = [
      { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
      { optionId: "allow_session", name: "Allow for this session", kind: "allow" },
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject", name: "Deny", kind: "reject" },
    ];
    const before = JSON.stringify(options);
    pickOption(options, "allow");
    pickOption(options, "deny");
    expect(JSON.stringify(options)).toBe(before); // untouched - the card renders all four buttons
    expect(pickOption(options, "allow")).toBe("allow_once"); // voice still narrows to once
  });
});
