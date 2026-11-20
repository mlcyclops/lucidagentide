// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-SETUX.1 (ADR-0617): the UX PR gate decision. Pure inputs only: no git, no network.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UX_CHECKLIST, checkboxes, evaluateUxGate, isUiPath, naReason, parseAddedLines, uxSection } from "./ux_pr_gate.ts";

const EM = "\u2014";
const TEMPLATE = readFileSync(join(import.meta.dir, "..", ".github", "pull_request_template.md"), "utf8");

function body(checked: (key: string) => boolean): string {
  const boxes = UX_CHECKLIST.map((i) => `- [${checked(i.key) ? "x" : " "}] **${i.key}**: ${i.text}`);
  return ["## Summary", "Rework settings.", "", "## UX review", ...boxes, "", "## Tests", "- [ ] unrelated box"].join("\n");
}
const allChecked = body(() => true);

describe("isUiPath", () => {
  test("renderer sources, top-level desktop html and mockups are UI", () => {
    for (const p of ["desktop/renderer/app.ts", "desktop/renderer/styles.css", "desktop/renderer/scenes/torch.ts",
      "desktop/renderer/index.html", "desktop/index.html", "mockups/provider_hub.html", ".\\desktop\\renderer\\ui.ts"]) {
      expect(isUiPath(p)).toBe(true);
    }
  });
  test("tests, generated bundles, vendor and non-UI trees are not", () => {
    for (const p of ["desktop/renderer/app.test.ts", "desktop/renderer/app.bundle.js", "desktop/renderer/vendor/katex/katex.js",
      "desktop/dev.ts", "desktop/sub/page.html", "harness/contracts.ts", "tools/ux_pr_gate.ts", "docs/UX-REVIEW.md"]) {
      expect(isUiPath(p)).toBe(false);
    }
  });
});

describe("evaluateUxGate: checklist", () => {
  test("no UI file changed: skipped, passes with an empty body", () => {
    const r = evaluateUxGate({ changedFiles: ["harness/x.ts", "desktop/renderer/x.test.ts"], prBody: "", addedLines: [] });
    expect(r).toMatchObject({ ok: true, mode: "skip", uiFiles: [] });
  });
  test("UI change with no section and no N/A fails", () => {
    const r = evaluateUxGate({ changedFiles: ["desktop/renderer/app.ts"], prBody: "## Summary\nstuff", addedLines: [] });
    expect(r.ok).toBe(false);
    expect(r.mode).toBe("checklist");
    expect(r.errors[0]).toContain("no \"## UX review\" section");
  });
  test("every box checked passes; boxes outside the section are ignored", () => {
    const r = evaluateUxGate({ changedFiles: ["desktop/renderer/app.ts"], prBody: allChecked, addedLines: [] });
    expect(r).toMatchObject({ ok: true, mode: "checklist", uiFiles: ["desktop/renderer/app.ts"] });
  });
  test("one unchecked box fails and names it", () => {
    const r = evaluateUxGate({ changedFiles: ["mockups/a.html"], prBody: body((k) => k !== "Z-order"), addedLines: [] });
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(["UX review: \"Z-order\" is not checked."]);
  });
  test("a deleted item is reported missing (cannot pass by trimming the list)", () => {
    const trimmed = allChecked.split("\n").filter((l) => !l.includes("**Served bytes**")).join("\n");
    const r = evaluateUxGate({ changedFiles: ["desktop/index.html"], prBody: trimmed, addedLines: [] });
    expect(r.errors).toEqual(["UX review: the \"Served bytes\" checkbox is missing."]);
  });
  test("boxes inside an HTML comment do not count", () => {
    const hidden = allChecked.replace("## UX review\n", "## UX review\n<!--\n") + "\n-->";
    expect(evaluateUxGate({ changedFiles: ["desktop/renderer/ui.ts"], prBody: hidden, addedLines: [] }).ok).toBe(false);
  });
  test("CRLF bodies (GitHub web editor) parse", () => {
    const r = evaluateUxGate({ changedFiles: ["desktop/renderer/ui.ts"], prBody: allChecked.replace(/\n/g, "\r\n"), addedLines: [] });
    expect(r.ok).toBe(true);
  });
});

describe("evaluateUxGate: N/A", () => {
  test("an explicit N/A with a reason passes", () => {
    const r = evaluateUxGate({ changedFiles: ["desktop/renderer/app.ts"], prBody: "Fix a typo in a comment.\n\nUX: N/A (comment-only change)", addedLines: [] });
    expect(r).toMatchObject({ ok: true, mode: "na" });
    expect(naReason("- **UX:** n/a (renamed a private helper)")).toBe("renamed a private helper");
  });
  test("placeholder, empty or commented-out N/A does not count", () => {
    for (const b of ["UX: N/A (reason)", "UX: N/A ()", "UX: N/A (why)", "<!-- UX: N/A (no visible change) -->"]) {
      expect(naReason(b)).toBeNull();
      expect(evaluateUxGate({ changedFiles: ["desktop/renderer/app.ts"], prBody: b, addedLines: [] }).ok).toBe(false);
    }
  });
});

describe("em dash scan", () => {
  const diff = [
    "diff --git a/desktop/renderer/app.ts b/desktop/renderer/app.ts",
    "index 111..222 100644",
    "--- a/desktop/renderer/app.ts",
    "+++ b/desktop/renderer/app.ts",
    "@@ -10,0 +11,2 @@ function x() {",
    `+  toast("Saved ${EM} done");`,
    "+  ok();",
    "@@ -40 +42 @@",
    `-  old ${EM} line`,
    "+++counter;",
    "diff --git a/desktop/renderer/app.test.ts b/desktop/renderer/app.test.ts",
    "--- a/desktop/renderer/app.test.ts",
    "+++ b/desktop/renderer/app.test.ts",
    "@@ -1 +1 @@",
    `+// ${EM} tests are not UI`,
    "diff --git a/desktop/renderer/gone.ts b/desktop/renderer/gone.ts",
    "--- a/desktop/renderer/gone.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    `-gone ${EM}`,
  ].join("\n");

  test("parseAddedLines tracks files and new-side line numbers, skips deletions", () => {
    expect(parseAddedLines(diff)).toEqual([
      { file: "desktop/renderer/app.ts", line: 11, text: `  toast("Saved ${EM} done");` },
      { file: "desktop/renderer/app.ts", line: 12, text: "  ok();" },
      { file: "desktop/renderer/app.ts", line: 42, text: "++counter;" },
      { file: "desktop/renderer/app.test.ts", line: 1, text: `// ${EM} tests are not UI` },
    ]);
  });
  test("context lines advance the counter", () => {
    const d = "diff --git a/mockups/a.html b/mockups/a.html\n+++ b/mockups/a.html\n@@ -1,3 +1,4 @@\n ctx\n+new\n ctx\n+again";
    expect(parseAddedLines(d).map((a) => a.line)).toEqual([2, 4]);
  });
  test("an added em dash in a UI file fails with file:line even when N/A is declared", () => {
    const r = evaluateUxGate({ changedFiles: ["desktop/renderer/app.ts"], prBody: "UX: N/A (string fix only)", addedLines: parseAddedLines(diff) });
    expect(r.ok).toBe(false);
    expect(r.mode).toBe("na");
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toStartWith("desktop/renderer/app.ts:11:");
  });
});

describe("pull_request_template.md stays in sync with the gate", () => {
  test("the template carries every item as an unchecked box in a UX review section", () => {
    const section = uxSection(TEMPLATE);
    expect(section).not.toBeNull();
    const boxes = checkboxes(section!);
    for (const item of UX_CHECKLIST) {
      expect(boxes.some((b) => !b.checked && b.text.replace(/^[*_`\s]+/, "").startsWith(item.key))).toBe(true);
    }
  });
  test("an untouched template fails a UI PR; the N/A hint inside it is a comment, not an answer", () => {
    expect(naReason(TEMPLATE)).toBeNull();
    expect(evaluateUxGate({ changedFiles: ["desktop/renderer/app.ts"], prBody: TEMPLATE, addedLines: [] }).ok).toBe(false);
  });
  test("the template, ticked, passes", () => {
    const ticked = TEMPLATE.replace(/^(\s*[-*]\s+)\[ \]/gm, "$1[x]");
    expect(evaluateUxGate({ changedFiles: ["desktop/renderer/app.ts"], prBody: ticked, addedLines: [] }).ok).toBe(true);
  });
  test("gate sources and docs carry no em dash", () => {
    for (const f of ["tools/ux_pr_gate.ts", "tools/ux_pr_gate.test.ts", ".github/pull_request_template.md", "docs/UX-PR-CHECKLIST.md", "docs/UX-REVIEW.md"]) {
      expect(readFileSync(join(import.meta.dir, "..", f), "utf8").includes(EM)).toBe(false);
    }
  });
});
