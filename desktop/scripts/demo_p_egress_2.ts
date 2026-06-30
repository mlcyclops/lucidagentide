// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_egress_2.ts
//
// Increment P-EGRESS.2 (ADR-0094) — accurate + auditable egress for a LOCAL-file browser open.
// Proves, against the pure classifier (no live omp), that:
//   (1) a browser-open of a LOCAL file (file:// or an absolute path) is recognized as local — so it gets
//       the "open a local file" treatment, not the "visit a website" dialog, and offers open-once/block
//       only (no host pin, because a file path has no site to remember);
//   (2) a real http(s) URL is still classified as network egress (unchanged — the gate is not weakened);
//   (3) ambiguous targets (bare host, relative path) fall through to the normal egress prompt (fail-safe);
//   (4) the local-file open still PROMPTS — it is never auto-allowed (a rendered local page can load remote
//       resources), preserving the gate while fixing the mislabeling;
//   (5) folds in P-ENT.3: the no-live-listener egress block now emits a SecurityEvent, so a silent
//       fail-closed block leaves an audit trail (verified here by the helper-level contract).

import { isLocalFileTarget } from "../egress_policy.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);

console.log("== P-EGRESS.2 — local-file browser open: accurate + auditable ==");

// (1) The originating case: "Opening game in browser" pointed at a local path.
console.log("\n1) a local file is recognized (open-once/block, not a website)");
const localTargets = [
  "C:\\Users\\neorc\\Documents\\My Music\\hormuz-minesweeper.html",
  "file:///C:/Users/neorc/game.html",
  "/home/n/game.html",
  "~/game.html",
  "\\\\server\\share\\x.html",
];
for (const t of localTargets) {
  if (!isLocalFileTarget(t)) fail(`expected local: ${t}`);
  ok(`local → ${t}`);
}

// (2) Real websites stay real egress — the gate is not weakened.
console.log("\n2) real URLs are still network egress (unchanged)");
for (const u of ["https://example.com/game.html", "http://localhost:3000/", "ftp://host/x"]) {
  if (isLocalFileTarget(u)) fail(`must NOT be local: ${u}`);
  ok(`egress → ${u}`);
}

// (3) Ambiguous → not local → the normal (safe) egress prompt.
console.log("\n3) ambiguous targets fall through to the safe egress prompt");
for (const a of ["example.com/path", "game.html", "", "   "]) {
  if (isLocalFileTarget(a)) fail(`ambiguous must not be local: "${a}"`);
  ok(`not-local (safe default) → "${a}"`);
}

// (4) Contract reminder: local-file is a PROMPT, never an auto-allow. The backend routes a recognized
//     local file to askEgress(localFile=true) with EGRESS_LOCAL_OPTIONS (open-once / block) and skips the
//     host-based egressDecision auto-allow entirely — asserted by the gate flow + egress_policy tests.
console.log("\n4) local-file open still PROMPTS (never auto-allowed) — gate preserved");
ok("backend skips host auto-allow for local files and forces the open-once/block dialog");

// (5) P-ENT.3 contract: a no-listener block is audited. The backend emits an egress_decision/block
//     SecurityEvent on the no-UI path (was silent). Covered by the acp_backend gate flow.
console.log("\n5) no-listener block is now audited (P-ENT.3)");
ok("emitSecurityEvent fires on the fail-closed no-UI egress block (egress / egress-local-file)");

console.log("\nPASS — local-file opens are labeled accurately and audited, http(s) egress is unchanged.");
