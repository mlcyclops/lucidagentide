// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_secack_1.ts
//
// Increment P-SECACK.1 (ADR-0170) — reviewed security rows leave the view; right-click clipboard
// menu. Proves, against the REAL modules:
//   (1) an ack round-trips through the JSONL ledger and survives a reload (app restart);
//   (2) acked rows leave the ACTIVE split (the chips/badge source) but stay listed as reviewed —
//       nothing is deleted, nothing is released;
//   (3) the findings watermark counts only NEW findings and is monotone (replay can't un-see);
//   (4) a corrupted ledger line degrades safely — every parseable ack is kept, never a throw;
//   (5) the context-menu contract: password fields never offer Cut/Copy; paste splice math is
//       clamp-safe on reversed/out-of-range selections.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetAcksForTest, ackArtifact, ackFindings, ackView, foldAcks } from "../security_ack.ts";
import { freshFindings, splitReviewed } from "../renderer/sec_review.ts";
import { menuItemsFor, spliceText } from "../renderer/ctxmenu.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);

console.log("== P-SECACK.1 — actioned/seen security items leave the view; right-click clipboard ==");

const dir = mkdtempSync(join(tmpdir(), "lucid-secack-demo-"));
process.env.LUCID_SEC_ACK_PATH = join(dir, "acks.jsonl");
_resetAcksForTest();
const noEmit = () => { /* demo never touches the real audit sinks */ };

try {
  console.log("\n1) ack → persist → app restart round-trip");
  if (!ackArtifact("1523e32270ddc41f", "user", noEmit)) fail("ack should record");
  _resetAcksForTest(); // simulates the app restarting and re-reading the JSONL
  if (!ackView().artifacts["1523e32270ddc41f"]) fail("ack must survive a reload");
  ok("reviewed-state survives an app restart (append-only JSONL, like lucid-blocks)");

  console.log("\n2) acked rows leave the ACTIVE view but are never deleted");
  const rows = [{ artifact_id: "1523e32270ddc41f" }, { artifact_id: "aa11" }, { artifact_id: "bb22" }];
  const split = splitReviewed(rows, ackView().artifacts);
  if (split.active.length !== 2) fail(`2 rows should stay active, got ${split.active.length}`);
  if (split.reviewed.length !== 1) fail("the acked row must move to the reviewed shelf, not vanish");
  ok("chips/badge count only the 2 unreviewed rows; the reviewed one stays auditable");

  console.log("\n3) findings watermark — only NEW findings count, monotone");
  if (freshFindings(24, null) !== 24) fail("no watermark → all 24 are new");
  ackFindings(24);
  _resetAcksForTest();
  if (freshFindings(24, ackView().findingsSeen) !== 0) fail("after mark-seen the chip must read 0");
  if (freshFindings(30, ackView().findingsSeen) !== 6) fail("6 later findings must surface as new");
  if (ackFindings(10) !== 24) fail("a lower replay must not lower the watermark");
  ok("24 seen → 0 new; 6 arrive later → 6 new; replay can't un-see");

  console.log("\n4) corrupted ledger degrades safely");
  const s = foldAcks(['{"kind":"artifact","id":"good","at":"t"}', "{corrupt", "42", ""]);
  if (!s.artifacts["good"] || Object.keys(s.artifacts).length !== 1) fail("parseable acks must survive corruption");
  ok("corrupt line skipped, good ack kept, no throw");

  console.log("\n5) context-menu contract + splice math");
  const pw = menuItemsFor({ editable: true, hasSelection: true, secret: true });
  if (pw.find((i) => i.act === "copy")?.enabled || pw.find((i) => i.act === "cut")?.enabled) fail("password fields must never offer Cut/Copy");
  if (pw.find((i) => i.act === "paste")?.enabled !== true) fail("paste must stay available on password fields");
  if (spliceText("hello world", 6, 11, "there").value !== "hello there") fail("paste splice broken");
  if (spliceText("abc", -5, 99, "X").value !== "X") fail("out-of-range selection must clamp");
  ok("Cut/Copy blocked on secrets; paste splice clamp-safe");

  console.log("\n✓ P-SECACK.1 demo passed — reviewed items stop haunting the Security panel, and the prompt bar finally has a right-click menu.");
} finally {
  delete process.env.LUCID_SEC_ACK_PATH;
  _resetAcksForTest();
  rmSync(dir, { recursive: true, force: true });
}
