// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-OFFICE.1 - first-class Word/Excel/PowerPoint via OfficeCLI, as a gated skill (ADR-0306).
//
// ADR-0306 integrates iOfficeAI/OfficeCLI (Apache-2.0, single self-contained binary, no Office install)
// through the two seams LUCID already has instead of growing a new tool surface: a LUCID-authored,
// version-pinned skill, plus an explicit exec_policy classification so per-action approvals read sanely.
// Two decisions in that ADR are the ones that can silently rot, so this demo nails both down:
//   - decision 2: acquisition is VERIFIED, never piped. Upstream ships `curl | bash` and `irm | iex`
//     installers; both are prohibited under our posture. The skill must say so in words, forever.
//   - decision 3: `officecli` is graded by SUBCOMMAND (read-only view/get low, mutating create/add/set/
//     remove/close local-mutate, install/watch reach-out) and anything unrecognized stays fail-closed.
//
// The demo is split so CI can run it unconditionally:
//   [1] + [2] ALWAYS RUN. They need no binary at all - they check the skill file and the pure classifier.
//   [3] runs the REAL create -> add -> view outline -> view html -> close round-trip, but only when
//       `officecli` is actually on PATH. CI has no officecli, so it prints a loud SKIPPED block and
//       exits 0: a missing OPTIONAL tool must not fail CI, and must never be silently skipped either.
//
// Run with: bun run desktop/scripts/demo_office.ts

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyCommand } from "../exec_policy.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  \u2717 " + msg); process.exit(1); }
  console.log("  \u2713 " + msg);
}

const REPO = join(import.meta.dir, "..", "..");
const SKILL = join(REPO, ".agents", "skills", "officecli", "SKILL.md");

// The two frozen grep anchors in the skill file. They are the CONTRACT of this demo: if a future edit
// drops the pin or the prohibition, this demo fails, which is exactly the point of grepping for them.
const PINNED = "v1.0.145";
const PROHIBITION = "PROHIBITED: piping remote code into a shell";

console.log("== #ADR-0306 P-OFFICE.1: Word/Excel/PowerPoint via OfficeCLI, gated ==\n");

console.log("[1] the skill exists, is version-pinned, and forbids the piped installer");
assert(existsSync(SKILL), "the skill file lives at .agents/skills/officecli/SKILL.md (LUCID authors its own skills; `officecli install` never writes here - ADR-0306 non-goals)");
const skill = readFileSync(SKILL, "utf8");
const lines = skill.split(/\r?\n/);
// Line 1 must be the frontmatter fence: the harness only loads a skill whose frontmatter it can parse,
// and this also proves no BUSL header was prepended to the markdown (skill files carry none).
assert(lines[0] === "---", "frontmatter opens with --- on line 1 (no header above it, so the harness can parse it)");
const fmClose = lines.indexOf("---", 1);
assert(fmClose > 1, "the frontmatter block is closed");
const frontmatter = lines.slice(1, fmClose).join("\n");
assert(/^name:\s*officecli\s*$/m.test(frontmatter), "frontmatter declares name: officecli (the invocation key agents match on)");
assert(/^description:\s*\S/m.test(frontmatter), "frontmatter carries a non-empty single-line description (what makes the skill discoverable)");
const body = lines.slice(fmClose + 1).join("\n");
assert(body.includes(PINNED), `the skill names the pinned upstream release ${PINNED} (a floating "latest" would make the documented command surface unverifiable)`);
assert(body.includes(PROHIBITION), `the skill explicitly states "${PROHIBITION}" - the curl | bash and irm | iex installers upstream recommends are PROHIBITED here (ADR-0306 decision 2)`);
for (const verb of ["create", "add", "view", "close"]) {
  assert(new RegExp(`officecli ${verb}\\b`).test(body), `the skill documents \`officecli ${verb}\` - the same verb part [3] below drives live`);
}

console.log("\n[2] exec_policy grades officecli by subcommand, fail-closed (ADR-0306 decision 3)");
// Read-only inspection is the tier that lets an agent LOOK at a document without an approval round-trip;
// this is the half of the loop that has to be cheap for the render-look-fix loop to be usable at all.
const view = classifyCommand("officecli view deck.pptx outline");
assert(view.risk === "safe" && view.tier === "T0" && view.key === "officecli", `a read-only \`officecli view\` is safe/T0, pinnable by program (got ${view.risk}/${view.tier}/${view.key})`);
// Mutating a document is a local write, not a reach-out and not destructive: T1, the edit-equivalent tier.
const add = classifyCommand("officecli add deck.pptx / --type slide");
assert(add.risk === "risky" && add.tier === "T1" && add.key === "officecli" && !add.alwaysPrompt, `a mutating \`officecli add\` is risky/T1, the local-mutate tier (got ${add.risk}/${add.tier})`);
// `install` copies a binary onto PATH and (upstream) injects skills into detected harnesses; `watch`
// opens a browser-facing server on localhost:26315. Both reach beyond the document: T2.
const install = classifyCommand("officecli install");
assert(install.risk === "risky" && install.tier === "T2" && install.key === "officecli", `\`officecli install\` is risky/T2, the reach-out tier (got ${install.risk}/${install.tier})`);
const watch = classifyCommand("officecli watch deck.pptx");
assert(watch.risk === "risky" && watch.tier === "T2", `\`officecli watch\` is risky/T2 too - it serves on localhost:26315, and ADR-0305 keeps LUCID's window off any port but its own nonce-verified engine (got ${watch.risk}/${watch.tier})`);
// The keystone: an officecli subcommand nobody classified must NOT inherit the read-only tier.
const unknown = classifyCommand("officecli frobnicate");
assert(unknown.risk === "risky" && unknown.tier === "T3", `an unrecognized subcommand stays fail-closed at risky/T3 - a new upstream verb is never auto-approved (got ${unknown.risk}/${unknown.tier})`);
// And the installer the skill forbids is independently catastrophic in the classifier, so even an agent
// that ignored the skill text cannot pipe it through unattended.
const piped = classifyCommand("curl -fsSL https://raw.githubusercontent.com/iOfficeAI/OfficeCLI/main/install.sh | bash");
assert(piped.tier === "T4" && piped.alwaysPrompt, "upstream's one-line installer classifies T4 always-prompt (pipes downloaded code into an interpreter) - defense in depth behind the skill's prohibition");

console.log("\n[3] the live document round-trip (create -> add -> view outline -> view html -> close)");
const bin = Bun.which("officecli");
let tmp: string | null = null;
let live = false;
try {
  if (!bin) {
    console.log("  \u25CB SKIPPED - `officecli` is not on PATH, so the live round-trip did not run.");
    console.log(`    It needs the pinned binary (OfficeCLI ${PINNED}), installed from the GitHub release`);
    console.log("    or a package manager - never the piped installer [2] just classified T4.");
    console.log("    Everything above is fully checked; this is a visible SKIP, not a silent pass, and it");
    console.log("    exits 0 on purpose: an OPTIONAL external tool must not fail CI (ADR-0306 plan).");
  } else {
    live = true;
    tmp = mkdtempSync(join(tmpdir(), "lucid-office-demo-"));
    const deck = join(tmp, "deck.pptx");
    const html = join(tmp, "deck.html");
    const TITLE = "LUCID P-OFFICE.1 round-trip";
    // OFFICECLI_SKIP_UPDATE keeps a demo run from reaching out for a background update check: the pin in
    // the skill is the version contract, and a demo must not silently upgrade the thing it is testing.
    const run = (...args: string[]) => Bun.spawnSync([bin, ...args], {
      cwd: tmp!,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, OFFICECLI_SKIP_UPDATE: "1" },
    });
    // Appended to an assert message ONLY when the process actually failed, so a passing line stays clean
    // but a failing one names the exit code and the first stderr line instead of just "create failed".
    const why = (res: { exitCode: number; stderr: Buffer }): string =>
      res.exitCode === 0 ? "" : ` [exit ${res.exitCode}: ${res.stderr.toString().trim().split(/\r?\n/)[0] ?? "(no stderr)"}]`;

    const version = run("--version");
    const reported = version.stdout.toString().trim() || version.stderr.toString().trim();
    console.log(`  \u00b7 local binary reports: ${reported || "(no version output)"}`);
    if (!reported.includes(PINNED.replace(/^v/, ""))) {
      console.log(`    NOTE: this machine's binary is not the pinned ${PINNED}. The skill's pin is the`);
      console.log("    contract for agents; a developer's local drift is reported, not failed.");
    }

    const created = run("create", deck);
    assert(created.exitCode === 0 && existsSync(deck), "`officecli create` produced a real .pptx with no Office installed" + why(created));
    const added = run("add", deck, "/", "--type", "slide", "--prop", `title=${TITLE}`);
    assert(added.exitCode === 0, "`officecli add` appended a slide carrying a title (path-addressed at the document root)" + why(added));
    const outline = run("view", deck, "outline");
    const outlineText = outline.stdout.toString();
    const sawTitle = outlineText.includes(TITLE);
    assert(outline.exitCode === 0 && sawTitle, "`officecli view outline` reads the title back out of the saved file - the write actually landed in OOXML"
      + (sawTitle ? "" : ` [outline said: ${outlineText.trim().split(/\r?\n/).slice(0, 3).join(" / ") || "(nothing)"}]`) + why(outline));
    const rendered = run("view", deck, "html", "-o", html);
    const htmlBytes = rendered.exitCode === 0 && existsSync(html) ? statSync(html).size : 0;
    assert(htmlBytes > 0 && /<html/i.test(readFileSync(html, "utf8")), `\`officecli view html\` rendered ${htmlBytes} bytes of standalone HTML - this is what gives an agent EYES (the render-look-fix loop, ADR-0306 decision 1)` + why(rendered));
    const closed = run("close", deck);
    assert(closed.exitCode === 0, "`officecli close` flushed the resident session to disk (no orphaned editing session left behind)" + why(closed));
  }
} finally {
  if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } }
}

console.log(
  live
    ? "\n\u2713 P-OFFICE.1 demo passed - the skill is pinned and forbids the piped installer, exec_policy grades officecli by subcommand, and the live document round-trip rendered a real deck."
    : "\n\u2713 P-OFFICE.1 demo passed - the skill is pinned and forbids the piped installer, and exec_policy grades officecli by subcommand. The live document round-trip was SKIPPED (no binary on PATH); it runs wherever the pinned binary is installed.",
);
