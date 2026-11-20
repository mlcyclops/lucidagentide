// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_ledger_model.test.ts - P-VIZ.6 (ADR-0635): the session ledger's rules. Totals land on the
// agent that did the work; a write/edit counts once and a failed one is taken back; subagents sit under their own
// parent; a new session starts over; estimates say "est."; the collapsed box's two lines and the compact numbers.

import { describe, expect, test } from "bun:test";
import { createDemo } from "./viz_demo.ts";
import {
  baseName, CODE_CAP_LANE, createLedger, fmtCompact, fmtLocCell, fmtTokCell, ledgerEvent, ledgerFleet, ledgerFolder, ledgerHub, ledgerRows,
  ledgerSummary, syncLedger, type LedgerNodeMeta, type LedgerState,
} from "./viz_ledger_model.ts";
import { applyEvent, applyFleet, createVizState, HUB_ID } from "./viz_model.ts";

const T = 1_000_000;
const hub: LedgerNodeMeta = { id: HUB_ID, kind: "hub", parent: null, name: "Main", persona: "lead" };
const lane = (id: string, name = id): LedgerNodeMeta => ({ id, kind: "agent", parent: HUB_ID, name, persona: "coder" });
const sub = (id: string, parent: string): LedgerNodeMeta => ({ id, kind: "subagent", parent, name: id, persona: "scout" });
const tok = (chars: number) => ({ type: "token", text: "x".repeat(chars) });
const edit = (id: string, oldText: string, newText: string, extra: Record<string, unknown> = {}) =>
  ({ type: "tool", id, name: "edit", detail: "a.ts", code: { path: "/w/a.ts", oldText, newText }, ...extra });
const write = (id: string, lines: number, extra: Record<string, unknown> = {}) =>
  ({ type: "tool", id, name: "write", detail: "b.ts", code: { path: "/w/b.ts", content: "l\n".repeat(lines) }, ...extra });

function fleet(...metas: LedgerNodeMeta[]): LedgerState {
  const L = createLedger();
  syncLedger(L, [hub, ...metas], T);
  return L;
}
const row = (L: LedgerState, id: string) => ledgerRows(L).find((r) => r.id === id)!;

describe("per-agent totals", () => {
  test("tokens and lines land on the agent that streamed them, not its neighbour", () => {
    const L = fleet(lane("a"), lane("b"));
    ledgerEvent(L, lane("a"), tok(400), T);
    ledgerEvent(L, lane("b"), tok(40), T);
    ledgerEvent(L, lane("a"), write("w1", 12), T);
    ledgerEvent(L, lane("b"), edit("e1", "x\ny\n", "x\nz\nw\n"), T);
    ledgerEvent(L, hub, tok(8), T);
    expect(row(L, "a")).toMatchObject({ tokens: 100, added: 12, removed: 0 });
    expect(row(L, "b")).toMatchObject({ tokens: 10, added: 2, removed: 1 });
    expect(row(L, HUB_ID)).toMatchObject({ tokens: 2, added: 0, removed: 0 });
  });

  test("a call counts once (its settle and a second copy add nothing) and a failure takes its lines back", () => {
    const L = fleet(lane("a"));
    ledgerEvent(L, lane("a"), write("w1", 5, { status: "open" }), T);
    ledgerEvent(L, lane("a"), write("w1", 5, { status: "open" }), T);
    ledgerEvent(L, lane("a"), { type: "tool", id: "w1", name: "write", detail: "b.ts", status: "done" }, T);
    expect(row(L, "a")).toMatchObject({ added: 5, edits: 1 });
    ledgerEvent(L, lane("a"), write("w2", 7, { status: "open" }), T);
    ledgerEvent(L, lane("a"), { type: "tool", id: "w2", name: "write", detail: "b.ts", status: "failed" }, T);
    expect(row(L, "a")).toMatchObject({ added: 5, edits: 1 });
    // Main reports a failure through tool-meta; a late copy of the failed call does not count it again.
    ledgerEvent(L, hub, edit("m1", "", "a\nb\n"), T);
    ledgerEvent(L, hub, { type: "tool-meta", id: "m1", name: "edit", ok: false }, T);
    ledgerEvent(L, hub, edit("m1", "", "a\nb\n"), T);
    expect(row(L, HUB_ID)).toMatchObject({ added: 0, removed: 0, edits: 0 });
    // A call that arrives already failed never counts.
    ledgerEvent(L, lane("a"), write("w3", 9, { status: "failed" }), T);
    expect(row(L, "a").added).toBe(5);
  });

  test("tools without authored code (a read, a bash) add no lines", () => {
    const L = fleet(lane("a"));
    ledgerEvent(L, lane("a"), { type: "tool", id: "r", name: "read", detail: "a.ts" }, T);
    ledgerEvent(L, lane("a"), { type: "tool", id: "s", name: "bash", detail: "ls", input: "ls" }, T);
    expect(row(L, "a")).toMatchObject({ added: 0, removed: 0, edits: 0 });
  });

  test("the demo's events flow through the scene model into the ledger", () => {
    const d = createDemo(T);
    const s = createVizState(T);
    applyFleet(s, d.lanes(T), T);
    const L = createLedger();
    syncLedger(L, s.nodes.values(), T);
    for (let t = T + 100; t <= T + 30_000; t += 100) {
      for (const e of d.step(t - 100, t).events) if (applyEvent(s, e, t)) ledgerEvent(L, s.nodes.get(e.source)!, e.e, t);
    }
    for (const id of [HUB_ID, ...d.lanes(T).map((l) => l.id)]) ledgerFolder(L, id, d.cwd(id));
    const rows = ledgerRows(L);
    expect(rows.some((r) => (r.added ?? 0) > 0)).toBe(true);
    expect(rows.every((r) => r.kind !== "subagent" && r.tokens > 0)).toBe(true);
    expect(rows.every((r) => r.folderName !== "")).toBe(true);
    expect(ledgerSummary(rows).empty).toBe(false);
  });
});

describe("rows", () => {
  test("Main first, then agents by tokens; subagents are a count on their parent's row, not rows", () => {
    const a = lane("a", "alpha"), b = lane("b", "beta");
    const L = fleet(a, b, sub("s1", "a"), sub("s2", "b"), sub("s0", HUB_ID));
    syncLedger(L, [hub, a, b, sub("s1", "a"), sub("s2", "b"), sub("s0", HUB_ID), sub("s3", "a")], T + 5);
    ledgerEvent(L, b, tok(4000), T);
    ledgerEvent(L, a, tok(40), T);
    expect(ledgerRows(L).map((r) => `${r.id}:${r.subs}`)).toEqual(["main:1", "b:1", "a:2"]);
  });

  test("an agent's folder is its own, and its cells format its numbers", () => {
    const L = fleet(lane("a"), sub("s1", "a"));
    ledgerFleet(L, [{ id: "a", session: "x", folder: "C:\\work\\lucid_live_demo\\" }], T);
    ledgerEvent(L, lane("a"), write("w", 3), T);
    const r = row(L, "a");
    expect(r).toMatchObject({ subs: 1, added: 3, folderName: "lucid_live_demo" });
    expect(fmtTokCell(r)).toBe("0");
    expect(fmtLocCell(r)).toBe("+3 / -0");
  });

  test("an entry whose node left stays for the session, marked gone", () => {
    const L = fleet(lane("a"));
    ledgerEvent(L, lane("a"), tok(40), T);
    syncLedger(L, [hub], T + 1);
    expect(row(L, "a")).toMatchObject({ gone: true, tokens: 10 });
  });
});

describe("sessions", () => {
  test("a lane that respawned on a new session starts over, its subagents with it", () => {
    const L = fleet(lane("a"), sub("s1", "a"), lane("b"));
    ledgerFleet(L, [{ id: "a", session: "s-1", folder: "/w/x" }, { id: "b", session: "t-1", folder: "/w/y" }], T);
    ledgerEvent(L, lane("a"), tok(400), T);
    ledgerEvent(L, lane("a"), write("w", 3), T);
    ledgerEvent(L, lane("b"), tok(400), T);
    ledgerFleet(L, [{ id: "a", session: "s-1", folder: "/w/x" }], T);
    expect(row(L, "a").tokens).toBe(100);
    ledgerFleet(L, [{ id: "a", session: "s-2", folder: "/w/x" }], T);
    expect(row(L, "a")).toMatchObject({ tokens: 0, added: 0 });
    expect(row(L, "a").subs).toBe(0);
    expect(row(L, "b").tokens).toBe(100);
  });

  test("a new hub session starts the whole ledger over; an unknown one changes nothing", () => {
    const L = fleet(lane("a"));
    expect(ledgerHub(L, "h1")).toBe(false);
    ledgerEvent(L, lane("a"), tok(400), T);
    expect(ledgerHub(L, null)).toBe(false);
    expect(ledgerHub(L, "h1")).toBe(false);
    expect(row(L, "a").tokens).toBe(100);
    expect(ledgerHub(L, "h2")).toBe(true);
    expect(ledgerRows(L)).toEqual([]);
    expect(ledgerSummary(ledgerRows(L)).line2).toBe("No activity yet this session");
  });
});

describe("est. labelling", () => {
  test("streamed text alone is est.; a measured report replaces it; text after the report is est. again", () => {
    const L = fleet(lane("a"));
    ledgerEvent(L, lane("a"), tok(4000), T);
    expect(fmtTokCell(row(L, "a"))).toBe("1.0k est.");
    ledgerEvent(L, lane("a"), { type: "usage", used: 41_000, size: 200_000, cost: 0.4 }, T);
    expect(fmtTokCell(row(L, "a"))).toBe("41.0k");
    ledgerEvent(L, lane("a"), tok(4000), T);
    expect(fmtTokCell(row(L, "a"))).toBe("42.0k est.");
    // The fleet poll echoing the same report keeps the estimate since; a new figure replaces it.
    ledgerFleet(L, [{ id: "a", session: null, folder: null, usage: { used: 41_000, cost: 0.4 } }], T);
    expect(fmtTokCell(row(L, "a"))).toBe("42.0k est.");
    ledgerFleet(L, [{ id: "a", session: null, folder: null, usage: { used: 43_500, cost: 0.5 } }], T);
    expect(row(L, "a")).toMatchObject({ tokens: 43_500, tokEst: false, cost: 0.5 });
  });

  test("a preview long enough to have hit the lane's cap marks the lines est.", () => {
    const L = fleet(lane("a"));
    ledgerEvent(L, lane("a"), write("w", 3), T);
    expect(fmtLocCell(row(L, "a"))).toBe("+3 / -0");
    ledgerEvent(L, lane("a"), { type: "tool", id: "big", name: "write", detail: "c.ts", code: { path: "/w/c.ts", content: "y\n".repeat(CODE_CAP_LANE / 2) } }, T);
    expect(fmtLocCell(row(L, "a"))).toBe("+8.2k / -0 est.");
  });

  test("the summary carries est. when any part is estimated", () => {
    const L = fleet(lane("a"), lane("b"));
    ledgerEvent(L, lane("a"), { type: "usage", used: 1000, size: 2000, cost: 0 }, T);
    expect(ledgerSummary(ledgerRows(L)).line1).toBe("2 agents \u00b7 0 sub \u00b7 1.0k tok \u00b7 +0 / -0 LoC");
    ledgerEvent(L, lane("b"), tok(40), T);
    expect(ledgerSummary(ledgerRows(L)).line1).toContain("1.0k tok est.");
  });
});

describe("summary lines", () => {
  test("before any data: the honest empty line", () => {
    const s = ledgerSummary(ledgerRows(fleet(lane("a"))));
    expect(s.empty).toBe(true);
    expect(s.line2).toBe("No activity yet this session");
  });

  test("line 1 counts agents (lanes), subagents, tokens and lines; line 2 names the busiest and its folder", () => {
    const api = lane("a", "api"), tw = lane("t", "test-writer");
    const L = fleet(api, tw, sub("s1", "t"), sub("s2", HUB_ID));
    ledgerFleet(L, [{ id: "t", session: null, folder: "/w/lucid_live_demo" }], T);
    ledgerEvent(L, tw, { type: "usage", used: 48_000, size: 1, cost: 0 }, T);
    ledgerEvent(L, api, { type: "usage", used: 200, size: 1, cost: 0 }, T);
    ledgerEvent(L, tw, write("w", 312), T);
    ledgerEvent(L, api, edit("e", "a\n".repeat(40), ""), T);
    const s = ledgerSummary(ledgerRows(L));
    expect(s.line1).toBe("2 agents \u00b7 2 sub \u00b7 48.2k tok \u00b7 +312 / -40 LoC");
    expect(s.line2).toBe("Busiest: test-writer \u00b7 lucid_live_demo");
    expect(s.line1 + s.line2).not.toContain("\u2014");
  });

  test("the busiest without a known folder is just its name", () => {
    const api = lane("a", "api");
    const L = fleet(api);
    ledgerEvent(L, api, tok(40), T);
    expect(ledgerSummary(ledgerRows(L)).line2).toBe("Busiest: api");
    ledgerFolder(L, "a", "/w/repo");
    expect(ledgerSummary(ledgerRows(L)).line2).toBe("Busiest: api \u00b7 repo");
  });
});

describe("formatting", () => {
  test("compact numbers never exceed four digits and roll over cleanly", () => {
    expect([0, 7.6, 999, 1000, 12_400, 99_949, 99_950, 312_000, 999_600, 1_234_567, 48_000_000].map(fmtCompact))
      .toEqual(["0", "8", "999", "1.0k", "12.4k", "99.9k", "100k", "312k", "1.0M", "1.2M", "48.0M"]);
    expect(fmtCompact(-5)).toBe("0");
  });

  test("baseName takes either separator and ignores a trailing one", () => {
    expect(baseName("C:\\Users\\me\\repo\\")).toBe("repo");
    expect(baseName("/w/lucid")).toBe("lucid");
    expect(baseName(null)).toBe("");
  });
});
