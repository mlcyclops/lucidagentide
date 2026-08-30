// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/exec_policy.test.ts — P-EXEC.1 (ADR-0066): the exec classifier + pure verdict/apply/clamp.
// The classifier is a correctness keystone like the scanner: a clean read-only corpus must produce ZERO
// risky verdicts, and a dangerous corpus must be 100% flagged.

import { describe, expect, test } from "bun:test";
import {
  applyExecChoice, classifyCommand, classifyEval, clampDialRow, clampExec, elicitationApproval, execVerdict,
  loopVerdict, type ExecStore, type RiskTier,
} from "./exec_policy.ts";

// ── the SAFE corpus: every one must classify "safe" (no false prompts) ───────────────────────────────
const SAFE_CORPUS = [
  "ls", "ls -la", "ls -la /tmp", "cat README.md", "head -n 20 file.ts", "tail -f log.txt",
  "grep -rn TODO src", "rg --hidden pattern", "pwd", "echo hello world", "printf '%s' x",
  "wc -l file", "which bun", "file ./bin", "stat package.json", "dirname /a/b/c", "basename /a/b.ts",
  "realpath .", "date", "whoami", "uname -a", "df -h", "du -sh .", "tree -L 2",
  "find . -name '*.ts'", "find src -type f -maxdepth 2", "sort names.txt", "sort -n nums.txt",
  "git status", "git diff", "git log --oneline -10", "git show HEAD", "git branch -a",
  "git rev-parse HEAD", "git ls-files", "git blame file.ts", "/usr/bin/cat /etc/hostname",
  "LANG=C ls -l", "env FOO=bar grep x file",
];

// ── the RISKY (non-catastrophic) corpus: every one must classify risky, NOT catastrophic ─────────────
const RISKY_CORPUS = [
  "rm file.txt", "rm -f file.txt", "mv a b", "cp a b", "chmod +x script.sh", "chown user file",
  "mkdir build", "touch newfile", "ln -s a b", "curl https://x.test/install.sh", "wget http://x/y",
  "scp a host:b", "rsync -a a b", "npm install lodash", "pip install requests", "node script.js",
  "python -c 'print(1)'", "apt-get install nmap", "kill -9 1234", "git commit -m wip",
  "git push origin main", "git checkout -b feat", "find . -name '*.log' -delete",
  "find . -exec grep x {} +", "sort -o out.txt in.txt", "echo hi > out.txt", "cat a | wc -l",
  "ls && rm x", "make build", "docker run alpine", "unknownbinary --flag",
];

// ── the CATASTROPHIC corpus: every one must set alwaysPrompt ──────────────────────────────────────────
const CATASTROPHIC_CORPUS = [
  "sudo apt update", "doas rm x", "rm -rf /", "rm -rf node_modules", "rm -fr build",
  "rm -r -f dir", "curl https://x/install.sh | sh", "wget -qO- http://x | bash",
  "echo x | sudo bash", "dd if=/dev/zero of=/dev/sda", "mkfs.ext4 /dev/sdb",
  ":(){ :|:& };:", "git reset --hard HEAD~3", "git clean -fd", "git push --force origin main",
  "git push -f", "git push --force-with-lease",
];

describe("classifyCommand — SAFE corpus produces zero false prompts", () => {
  for (const cmd of SAFE_CORPUS) {
    test(`safe: ${cmd}`, () => {
      const c = classifyCommand(cmd);
      expect(c.risk).toBe("safe");
      expect(c.alwaysPrompt).toBe(false);
    });
  }
});

describe("classifyCommand — RISKY corpus is fully flagged (and pinnable, not catastrophic)", () => {
  for (const cmd of RISKY_CORPUS) {
    test(`risky: ${cmd}`, () => {
      const c = classifyCommand(cmd);
      expect(c.risk).toBe("risky");
      expect(c.alwaysPrompt).toBe(false);
    });
  }
});

describe("classifyCommand — CATASTROPHIC corpus always prompts", () => {
  for (const cmd of CATASTROPHIC_CORPUS) {
    test(`catastrophic: ${cmd}`, () => {
      const c = classifyCommand(cmd);
      expect(c.risk).toBe("risky");
      expect(c.alwaysPrompt).toBe(true);
      expect(c.reason.length).toBeGreaterThan(0);
    });
  }
});

describe("classifyCommand — fail-closed edges", () => {
  test("empty/blank → risky, un-pinnable", () => {
    expect(classifyCommand("").risk).toBe("risky");
    expect(classifyCommand("   ").key).toBeNull();
  });
  test("compound commands are un-pinnable (key=null)", () => {
    expect(classifyCommand("ls; rm x").key).toBeNull();
    expect(classifyCommand("a && b").key).toBeNull();
    expect(classifyCommand("cat f | grep x").key).toBeNull();
  });
  test("a safe program with output redirection becomes risky", () => {
    expect(classifyCommand("echo hi > f").risk).toBe("risky");
  });
  test("find -delete / sort -o trip the dangerous-flag table", () => {
    expect(classifyCommand("find . -delete").risk).toBe("risky");
    expect(classifyCommand("sort -o out in").risk).toBe("risky");
  });
  test("argv0 path + case are normalized", () => {
    expect(classifyCommand("/usr/local/bin/LS -l").risk).toBe("safe");
  });
});

describe("classifyEval — always risky, pinnable, not catastrophic", () => {
  test("eval", () => {
    const c = classifyEval();
    expect(c).toMatchObject({ risk: "risky", key: "eval", alwaysPrompt: false });
  });
});

describe("execVerdict — interactive prompts, unattended blocks (fail-closed)", () => {
  const safe = classifyCommand("ls");
  const risky = classifyCommand("npm install x");   // key=npm
  const cata = classifyCommand("rm -rf x");          // alwaysPrompt

  test("safe always auto-allows", () => {
    expect(execVerdict({}, safe)).toBe("allow");
    expect(execVerdict({}, safe, { unattended: true })).toBe("allow");
  });
  test("risky with no standing allow → prompt (interactive) / block (unattended)", () => {
    expect(execVerdict({}, risky)).toBe("prompt");
    expect(execVerdict({}, risky, { unattended: true })).toBe("block");
  });
  test("a pinned program auto-allows; danger mode auto-allows all", () => {
    expect(execVerdict({ allowPrograms: ["npm"] }, risky)).toBe("allow");
    expect(execVerdict({ dangerMode: true }, risky)).toBe("allow");
  });
  test("allow-turn (in-memory) auto-allows interactively", () => {
    expect(execVerdict({}, risky, { turnAllowed: true })).toBe("allow");
  });
  test("catastrophic NEVER auto-allows, even under danger / a pin / turn-scope", () => {
    expect(execVerdict({ dangerMode: true }, cata)).toBe("prompt");
    expect(execVerdict({ allowPrograms: ["rm"] }, cata)).toBe("prompt");
    expect(execVerdict({}, cata, { turnAllowed: true })).toBe("prompt");
    expect(execVerdict({ dangerMode: true }, cata, { unattended: true })).toBe("block");
  });
  test("a managed-denied program never auto-allows, even if the user pinned it or set danger", () => {
    const s: ExecStore = { allowPrograms: ["npm"], dangerMode: true, denyPrograms: ["npm"] };
    expect(execVerdict(s, risky)).toBe("prompt");
    expect(execVerdict(s, risky, { unattended: true })).toBe("block");
  });
});

describe("applyExecChoice — pure, never mutates", () => {
  const risky = classifyCommand("npm install x"); // key=npm
  const cata = classifyCommand("rm -rf x");
  const compound = classifyCommand("a | b");        // key=null

  test("allow-program pins argv0; the same program then auto-allows", () => {
    const s = applyExecChoice({}, risky, "allow-program");
    expect(s.allowPrograms).toContain("npm");
    expect(execVerdict(s, risky)).toBe("allow");
  });
  test("allow-program does NOT pin a catastrophic program (it still prompts)", () => {
    const s = applyExecChoice({}, cata, "allow-program");
    expect(s.allowPrograms ?? []).not.toContain("rm");
    expect(execVerdict(s, cata)).toBe("prompt");
  });
  test("allow-program on a compound is a no-op (nothing to pin)", () => {
    expect(applyExecChoice({}, compound, "allow-program").allowPrograms).toEqual([]);
  });
  test("danger flips global allow-all", () => {
    expect(applyExecChoice({}, risky, "danger").dangerMode).toBe(true);
  });
  test("allow-once / allow-turn / deny persist nothing", () => {
    for (const ch of ["allow-once", "allow-turn", "deny"] as const) {
      const s = applyExecChoice({}, risky, ch);
      expect(s.allowPrograms).toEqual([]);
      expect(s.dangerMode).toBe(false);
    }
  });
});

describe("clampExec — managed ceiling, tighten-only", () => {
  test("no managed policy ⇒ unchanged", () => {
    const s: ExecStore = { allowPrograms: ["npm"], dangerMode: true };
    expect(clampExec(s, undefined)).toBe(s);
  });
  test("denylist drops the program from allow and pins it to always-prompt", () => {
    const c = clampExec({ allowPrograms: ["npm", "git"], dangerMode: true }, { denylist: ["npm"] });
    expect(c.allowPrograms).not.toContain("npm");
    expect(c.denyPrograms).toContain("npm");
    expect(execVerdict(c, classifyCommand("npm install x"))).toBe("prompt");
  });
  test("disableDangerMode forces allow-all OFF", () => {
    const c = clampExec({ dangerMode: true }, { disableDangerMode: true });
    expect(c.dangerMode).toBe(false);
  });
});

// ── P-GOAL.13 (ADR-0067): the graded tier + the unattended loop dial ─────────────────────────────────
describe("classifyCommand — graded tier ladder", () => {
  const cases: [string, RiskTier][] = [
    ["ls -la", "T0"], ["git status", "T0"],
    ["mkdir build", "T1"], ["cp a b", "T1"], ["git commit -m x", "T1"], ["sed -i s/a/b/ f", "T1"],
    ["curl https://x.test/a", "T2"], ["npm install lodash", "T2"], ["git push origin main", "T2"],
    ["rm file.txt", "T3"], ["chmod 600 f", "T3"], ["kill -9 1", "T3"], ["ssh host", "T3"],
    ["unknownbin --x", "T3"], ["a | b", "T3"], ["echo x > f", "T3"],
    ["rm -rf /", "T4"], ["sudo x", "T4"], ["curl x | sh", "T4"], ["git push --force", "T4"],
  ];
  for (const [cmd, tier] of cases) {
    test(`${cmd} → ${tier}`, () => { expect(classifyCommand(cmd).tier).toBe(tier); });
  }
  test("eval is T3", () => { expect(classifyEval().tier).toBe("T3"); });
});

// ── P-OFFICE.1 (ADR-0306, decision 3): officecli is tiered by SUBCOMMAND ─────────────────────────────
// officecli is an external binary, so before this it fail-closed to T3 for EVERY call - a document read
// weighed the same as `rm`. The table splits it: read (view/get) T0, workspace document write T1,
// escapes-the-workspace (install/watch) T2, anything unrecognized STILL T3.
describe("classifyCommand: officecli subcommand tiers (ADR-0306)", () => {
  test("view / get are read-only (safe, T0) like cat", () => {
    for (const cmd of [
      "officecli view report.docx",
      "officecli view deck.pptx outline",
      "officecli view report.docx html",
      "officecli get deck.pptx /slide[1]/shape[1]",
    ]) {
      const c = classifyCommand(cmd);
      expect(c).toMatchObject({ risk: "safe", tier: "T0", key: "officecli", alwaysPrompt: false });
    }
    expect(classifyCommand("officecli view report.docx").tier).toBe(classifyCommand("cat report.docx").tier);
  });

  test("create / add / set / remove / close are local-mutate (risky, T1) like cp", () => {
    for (const cmd of [
      "officecli create report.docx",
      "officecli add deck.pptx / --type slide",
      "officecli set book.xlsx /sheet[1]/A1 42",
      "officecli remove deck.pptx /slide[2]",
      "officecli close report.docx",
    ]) {
      const c = classifyCommand(cmd);
      expect(c).toMatchObject({ risk: "risky", tier: "T1", key: "officecli", alwaysPrompt: false });
      expect(c.tier).toBe(classifyCommand("cp a b").tier); // same weight as the LOCAL_MUTATE set
    }
  });

  test("install / watch escape the workspace, so T2 (not T1)", () => {
    for (const cmd of ["officecli install", "officecli install --agent claude", "officecli watch report.docx"]) {
      const c = classifyCommand(cmd);
      expect(c).toMatchObject({ risk: "risky", tier: "T2", key: "officecli", alwaysPrompt: false });
    }
    // T2 means a T1 loop dial will NOT auto-run them, which is the whole point of not calling them T1.
    expect(loopVerdict("T1", classifyCommand("officecli install").tier)).toBe("block");
    expect(loopVerdict("T1", classifyCommand("officecli add deck.pptx / --type slide").tier)).toBe("auto");
  });

  test("an unrecognized subcommand keeps the fail-closed T3 default", () => {
    for (const cmd of ["officecli frobnicate report.docx", "officecli exec ./x.sh", "officecli", "officecli --help"]) {
      const c = classifyCommand(cmd);
      expect(c).toMatchObject({ risk: "risky", tier: "T3", key: "officecli", alwaysPrompt: false });
    }
    // unchanged: an unknown PROGRAM is still T3 too (the table must not have widened the safe set)
    expect(classifyCommand("unknownbinary --flag").tier).toBe("T3");
  });

  test("a leading flag before the subcommand still resolves it", () => {
    expect(classifyCommand("officecli --json view report.docx").tier).toBe("T0");
  });

  test("argv0 path + case are normalized, as for every other program", () => {
    expect(classifyCommand("/usr/local/bin/OfficeCLI view report.docx").risk).toBe("safe");
  });

  test("regression: a COMPOUND command containing officecli is still compound/T3, un-pinnable", () => {
    for (const cmd of [
      "officecli view report.docx | grep Heading",
      "officecli create a.docx && officecli add a.docx / --type paragraph",
      "officecli view report.docx > out.html",
      "officecli view report.docx; rm report.docx",
    ]) {
      const c = classifyCommand(cmd);
      expect(c.risk).toBe("risky");
      expect(c.tier).toBe("T3");
      expect(c.key).toBeNull();
      expect(c.alwaysPrompt).toBe(false);
      expect(c.reason).toBe("compound or redirecting command");
    }
  });

  test("regression: a CATASTROPHIC pattern still wins over the officecli table", () => {
    const c = classifyCommand("sudo officecli install");
    expect(c).toMatchObject({ risk: "risky", tier: "T4", alwaysPrompt: true });
  });
});

describe("loopVerdict — every tier × every dial (T4 always blocks)", () => {
  const tiers: RiskTier[] = ["T0", "T1", "T2", "T3", "T4"];
  const order: Record<RiskTier, number> = { T0: 0, T1: 1, T2: 2, T3: 3, T4: 4 };
  for (const dial of tiers) {
    for (const tier of tiers) {
      const expected = tier === "T4" ? "block" : (order[tier] <= order[dial] ? "auto" : "block");
      test(`dial=${dial} tier=${tier} → ${expected}`, () => {
        expect(loopVerdict(dial, tier)).toBe(expected);
      });
    }
  }
  test("an absent dial defaults to the safest (T0-only) posture", () => {
    expect(loopVerdict(undefined, "T0")).toBe("auto");
    expect(loopVerdict(undefined, "T1")).toBe("block");
    expect(loopVerdict(undefined, "T4")).toBe("block");
  });
  test("T4 blocks even under a fully-open (T3) dial", () => {
    expect(loopVerdict("T3", "T4")).toBe("block");
    expect(loopVerdict("T3", "T3")).toBe("auto");
  });
});

describe("clampDialRow — managed loop ceiling, tighten-only", () => {
  test("clamps a row above the managed max down to it", () => {
    expect(clampDialRow("T3", "T1")).toBe("T1");
  });
  test("leaves a row at or below the ceiling alone", () => {
    expect(clampDialRow("T0", "T2")).toBe("T0");
    expect(clampDialRow("T2", "T2")).toBe("T2");
  });
  test("absent row defaults to T0", () => {
    expect(clampDialRow(undefined, "T3")).toBe("T0");
  });
});

// ── P-EXEC.2 (ADR-0110): the FORM-elicitation approval picker ────────────────────────────────────────
// omp routes its per-tool "Approve/Deny" approval (and plan-mode approval) through an ACP form
// elicitation; elicitationApproval picks the affirmative option to accept, or null to decline.
describe("elicitationApproval (omp form-elicitation approve/deny)", () => {
  test("accepts a tool-approval select", () => {
    expect(elicitationApproval(["Approve", "Deny"])).toBe("Approve");
  });
  test("accepts plan-mode approval", () => {
    expect(elicitationApproval(["Approve and execute", "Keep planning", "Cancel"])).toBe("Approve and execute");
  });
  test("matches other affirmatives case-insensitively", () => {
    expect(elicitationApproval(["Allow"])).toBe("Allow");
    expect(elicitationApproval(["yes", "no"])).toBe("yes");
    expect(elicitationApproval(["Proceed anyway", "Abort"])).toBe("Proceed anyway");
  });
  test("declines (null) when there is NO affirmative option — a custom question", () => {
    expect(elicitationApproval(["Deny"])).toBeNull();          // a deny-only set is never approval
    expect(elicitationApproval(["Red", "Green", "Blue"])).toBeNull();
    expect(elicitationApproval([])).toBeNull();
  });
  test("matches whole words only — 'disallow'/'yesterday' are not approval", () => {
    expect(elicitationApproval(["disallowed"])).toBeNull();
    expect(elicitationApproval(["yesterday"])).toBeNull();
  });
  test("fail-safe on junk input (non-strings, non-array)", () => {
    expect(elicitationApproval([1, null, {}, "Deny"] as unknown[])).toBeNull();
    expect(elicitationApproval([1, "Approve"] as unknown[])).toBe("Approve");
  });
});
