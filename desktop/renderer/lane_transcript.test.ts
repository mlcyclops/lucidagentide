// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-FLEET.L7: the lane transcript model. Over-tests the load-bearing pieces the DOM patching depends on:
// stable ids, the DELEGATION to answer_chips/linediff (a lane chip and a master chip must agree by
// construction), the hasBody <=> laneChipBody biconditional (a chevron that opens onto nothing is a bug),
// VISIBLE truncation at both caps (a silent clip would let the card lie about what ran), and copy text that
// is plain UTF-8 with no markup.

import { describe, expect, it } from "bun:test";
import { toolChip } from "./answer_chips.ts";
import {
  LANE_DIFF_ROWS_CAP,
  LANE_INPUT_CAP,
  laneChip,
  laneChipBody,
  mintId,
  transcriptCopyText,
  turnCopyText,
  type LaneToolRow,
  type LaneTurnRow,
} from "./lane_transcript.ts";

function row(p: Partial<LaneToolRow> = {}): LaneToolRow {
  return { id: p.id ?? "c1", name: p.name ?? "", detail: p.detail ?? "", code: p.code, input: p.input, open: p.open ?? false };
}

function turn(p: Partial<LaneTurnRow> = {}): LaneTurnRow {
  return { id: p.id ?? "t1", role: p.role ?? "assistant", text: p.text ?? "", thinking: p.thinking, tools: p.tools ?? [], error: p.error, images: p.images };
}

describe("mintId", () => {
  it("is monotone and never collides across 1000 calls", () => {
    const ids: string[] = [];
    for (let i = 0; i < 1000; i++) ids.push(mintId("t", i));
    expect(new Set(ids).size).toBe(1000);
    expect(ids[0]).toBe("t0");
    expect(ids[4]).toBe("t4");
    expect(ids[999]).toBe("t999");
    // Monotone in the sequence: the id's numeric tail tracks the seq, so a later node never reuses an
    // earlier node's key.
    for (let i = 1; i < ids.length; i++) expect(Number(ids[i]!.slice(1))).toBeGreaterThan(Number(ids[i - 1]!.slice(1)));
  });

  it("keeps prefixes separate and never mints a garbage key", () => {
    expect(mintId("tool", 4)).toBe("tool4");
    expect(mintId("t", 4)).not.toBe(mintId("tool", 4));
    expect(mintId("", 7)).toBe("id7"); // a blank prefix still yields a usable DOM key
    expect(mintId("t", Number.NaN)).toBe("t0"); // never "tNaN" in the document
    expect(mintId("t", Number.POSITIVE_INFINITY)).toBe("t0");
    expect(mintId("t", 3.7)).toBe("t3");
  });
});

describe("laneChip delegates to answer_chips", () => {
  it("a write with content yields kind write and an add-count diffstat", () => {
    const c = laneChip(row({ name: "write", detail: "new.ts", code: { path: "new.ts", content: "l1\nl2\nl3\n" } }));
    expect(c.kind).toBe("write");
    expect(c.k).toBe("write");
    expect(c.diffstat).toEqual({ add: 3, del: 0 }); // trailing newline is not a phantom 4th line
    expect(c.failed).toBe(false);
    expect(c.hasBody).toBe(true);
  });

  it("a bash call yields kind run and no diffstat", () => {
    const c = laneChip(row({ name: "bash", detail: "bun test x", input: "bun test x" }));
    expect(c.kind).toBe("run");
    expect(c.diffstat).toBeNull();
  });

  it("agrees field-for-field with the master composer's chip for the same call", () => {
    // The point of the delegation: a lane chip and a master chip cannot drift on kind or diffstat.
    const t = row({ name: "edit", detail: "  app.ts   line 4 ", code: { path: "app.ts", oldText: "a\nb\nc", newText: "a\nB\nc\nd" } });
    const { hasBody, ...chip } = laneChip(t);
    expect(chip).toEqual(toolChip(t.name, t.detail, t.code));
    expect(hasBody).toBe(true);
    expect(chip.detail).toBe("app.ts line 4"); // whitespace collapsed by the shared helper
    expect(chip.diffstat).toEqual({ add: 2, del: 1 });
  });
});

describe("hasBody and laneChipBody are the same decision", () => {
  // `kind: null` IS the "no body" expectation: the table cannot describe a case where hasBody and the body
  // object disagree, which is the invariant under test.
  const cases: { why: string; t: LaneToolRow; kind: "diff" | "input" | "detail" | null }[] = [
    { why: "authored content", t: row({ name: "write", code: { path: "a.ts", content: "x" } }), kind: "diff" },
    { why: "authored patch", t: row({ name: "edit", code: { path: "a.ts", patch: "+x" } }), kind: "diff" },
    { why: "authored old/new pair", t: row({ name: "edit", code: { path: "a.ts", oldText: "x", newText: "y" } }), kind: "diff" },
    { why: "input only", t: row({ input: "ls -la" }), kind: "input" },
    { why: "detail only", t: row({ detail: "app.ts" }), kind: "detail" },
    { why: "name only", t: row({ name: "bash" }), kind: "detail" },
    { why: "all empty", t: row(), kind: null },
    { why: "all whitespace", t: row({ name: "  ", detail: "\t", input: "   " }), kind: null },
    { why: "whitespace input alone", t: row({ input: "   " }), kind: null },
    { why: "code with a path but nothing authored", t: row({ code: { path: "a.ts" } }), kind: null },
    { why: "code fields present but blank", t: row({ code: { path: "a.ts", content: "  ", patch: "" } }), kind: null },
    { why: "blank code, real input", t: row({ code: { path: "a.ts", content: "   " }, input: "cat a.ts" }), kind: "input" },
  ];

  for (const c of cases) {
    it(`${c.why}: hasBody ${c.kind !== null} and a body ${c.kind === null ? "of null" : `of kind ${c.kind}`}`, () => {
      const hasBody = laneChip(c.t).hasBody;
      const body = laneChipBody(c.t);
      expect(hasBody).toBe(c.kind !== null);
      expect(body?.kind ?? null).toBe(c.kind);
      // The biconditional, asserted in both directions: null exactly when there is nothing to reveal.
      expect(body === null).toBe(!hasBody);
      expect(body !== null).toBe(hasBody);
      if (body) {
        // Never an empty panel: whatever the kind, there is something to read.
        if (body.kind === "diff") expect(body.rows.length).toBeGreaterThan(0);
        else expect(body.text.length).toBeGreaterThan(0);
      }
    });
  }

  it("a name-only row reveals the tool name, so the chevron is never dead", () => {
    expect(laneChipBody(row({ name: "bash" }))).toEqual({ kind: "detail", text: "bash" });
  });
});

describe("laneChipBody precedence: code beats input beats detail", () => {
  it("code and input together yields a diff", () => {
    const b = laneChipBody(row({ name: "write", detail: "a.ts", code: { path: "a.ts", content: "hello" }, input: '{"path":"a.ts"}' }));
    expect(b?.kind).toBe("diff");
    expect(b).toEqual({ kind: "diff", rows: [{ type: "add", text: "hello" }] });
  });

  it("input and detail together yields the input", () => {
    expect(laneChipBody(row({ name: "bash", detail: "make demo", input: "make demo && echo ok" }))).toEqual({
      kind: "input",
      text: "make demo && echo ok",
    });
  });

  it("an input is shown verbatim apart from its edges", () => {
    const b = laneChipBody(row({ name: "bash", input: "  line1\n    line2  " }));
    expect(b).toEqual({ kind: "input", text: "line1\n    line2" }); // interior indentation survives
  });

  it("an old/new pair diffs through linediff, keeping context rows", () => {
    expect(laneChipBody(row({ name: "edit", code: { path: "a.ts", oldText: "a\nb", newText: "a\nB" } }))).toEqual({
      kind: "diff",
      rows: [{ type: "ctx", text: "a" }, { type: "del", text: "b" }, { type: "add", text: "B" }],
    });
  });
});

describe("patch bodies are classified by patchLineType and kept raw", () => {
  it("a header row is ctx, not an add", () => {
    const patch = "[app.ts#1A2B]\nSWAP 4.=4:\n+  const next = 1;\n-  const next = 0;\n context line\n";
    const b = laneChipBody(row({ name: "edit", detail: "app.ts", code: { path: "app.ts", patch } }));
    expect(b).toEqual({
      kind: "diff",
      rows: [
        { type: "ctx", text: "[app.ts#1A2B]" }, // the hashline header is metadata, never a green add
        { type: "ctx", text: "SWAP 4.=4:" },
        { type: "add", text: "+  const next = 1;" },
        { type: "del", text: "-  const next = 0;" },
        { type: "ctx", text: " context line" },
      ],
    });
  });

  it("a trailing newline does not add a phantom blank row", () => {
    const b = laneChipBody(row({ name: "edit", code: { path: "a.ts", patch: "+one\n" } }));
    expect(b).toEqual({ kind: "diff", rows: [{ type: "add", text: "+one" }] });
  });
});

describe("truncation is visible", () => {
  it("LANE_DIFF_ROWS_CAP keeps exactly the cap and says what it dropped", () => {
    const content = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const b = laneChipBody(row({ name: "write", detail: "big.ts", code: { path: "big.ts", content } }));
    expect(b?.kind).toBe("diff");
    if (b?.kind !== "diff") throw new Error("expected a diff body");
    expect(b.rows.length).toBe(LANE_DIFF_ROWS_CAP);
    expect(b.rows[0]).toEqual({ type: "add", text: "line 0" });
    expect(b.rows[LANE_DIFF_ROWS_CAP - 2]).toEqual({ type: "add", text: `line ${LANE_DIFF_ROWS_CAP - 2}` });
    const last = b.rows[LANE_DIFF_ROWS_CAP - 1]!;
    expect(last.type).toBe("ctx");
    expect(last.text).toContain("truncated");
    expect(last.text).toContain(String(5000 - (LANE_DIFF_ROWS_CAP - 1))); // the exact hidden-row count
    expect(last.text).not.toContain("\u2014");
  });

  it("a diff exactly at the cap is not marked", () => {
    const content = Array.from({ length: LANE_DIFF_ROWS_CAP }, (_, i) => `l${i}`).join("\n");
    const b = laneChipBody(row({ name: "write", code: { path: "b.ts", content } }));
    if (b?.kind !== "diff") throw new Error("expected a diff body");
    expect(b.rows.length).toBe(LANE_DIFF_ROWS_CAP);
    expect(b.rows[LANE_DIFF_ROWS_CAP - 1]).toEqual({ type: "add", text: `l${LANE_DIFF_ROWS_CAP - 1}` });
  });

  it("LANE_INPUT_CAP clips a 10KB input and marks the clip", () => {
    const input = "x".repeat(10 * 1024);
    const b = laneChipBody(row({ name: "bash", input }));
    if (b?.kind !== "input") throw new Error("expected an input body");
    const [payload, ...rest] = b.text.split("\n");
    expect(payload!.length).toBe(LANE_INPUT_CAP); // exactly the cap survives
    expect(payload).toBe(input.slice(0, LANE_INPUT_CAP));
    expect(rest.join("\n")).toContain("truncated");
    expect(b.text).toContain(String(10 * 1024 - LANE_INPUT_CAP)); // the exact clipped count
  });

  it("an input at the cap is untouched", () => {
    const input = "y".repeat(LANE_INPUT_CAP);
    expect(laneChipBody(row({ name: "bash", input }))).toEqual({ kind: "input", text: input });
  });
});

describe("copy text", () => {
  const readTool = row({ id: "c1", name: "read", detail: "app.ts", input: "read app.ts:1-40" });
  const editTool = row({ id: "c2", name: "edit", detail: "app.ts", code: { path: "app.ts", oldText: "old line", newText: "new line" } });
  const bashTool = row({ id: "c3", name: "bash", detail: "bun test x", input: "bun test x" });

  it("a tool row is one header line plus its command indented two spaces", () => {
    const out = turnCopyText(turn({ tools: [readTool], text: "Read it." }));
    expect(out).toBe("[assistant]\n[ran: read] app.ts\n  read app.ts:1-40\nRead it.");
  });

  it("a diff body renders signed rows, and a raw patch is not signed twice", () => {
    expect(turnCopyText(turn({ tools: [editTool] }))).toBe("[assistant]\n[ran: edit] app.ts\n  -old line\n  +new line");
    const patched = row({ name: "edit", detail: "a.ts", code: { path: "a.ts", patch: "[a.ts#1A2B]\n+added" } });
    expect(turnCopyText(turn({ tools: [patched] }))).toBe("[assistant]\n[ran: edit] a.ts\n  [a.ts#1A2B]\n  +added");
  });

  it("a detail-only tool row does not repeat itself under its own header", () => {
    expect(turnCopyText(turn({ tools: [row({ name: "task", detail: "spawn 3 agents" })] }))).toBe("[assistant]\n[ran: task] spawn 3 agents");
  });

  it("an empty turn copies to nothing, not a lonely header", () => {
    expect(turnCopyText(turn({ role: "user" }))).toBe("");
    expect(turnCopyText(turn({ text: "   ", tools: [] }))).toBe("");
  });

  it("carries thinking, an error, and an image COUNT (never the data URLs, never a zero)", () => {
    const out = turnCopyText(turn({ role: "user", text: "Look at this", images: ["data:image/png;base64,AAAA"] }));
    expect(out).toBe("[user]\nLook at this\n[1 image attached]");
    expect(out).not.toContain("base64");
    expect(turnCopyText(turn({ role: "user", text: "Two", images: ["data:a", "data:b"] }))).toContain("[2 images attached]");
    expect(turnCopyText(turn({ text: "x" }))).not.toContain("image");
    const err = turnCopyText(turn({ thinking: "weighing\noptions", text: "Failed.", error: "provider closed the stream" }));
    expect(err).toBe("[assistant]\n[thinking]\n  weighing\n  options\nFailed.\n[error] provider closed the stream");
  });

  it("round-trips a 3-turn transcript with tools plus a live block, in order", () => {
    const turns: LaneTurnRow[] = [
      turn({ id: "t1", role: "user", text: "Refactor the loader." }),
      turn({ id: "t2", role: "assistant", text: "Done, one call site moved.", tools: [readTool, editTool] }),
      turn({ id: "t3", role: "user", text: "Now the tests." }),
    ];
    const out = transcriptCopyText(turns, { text: "Running the suite", tools: [bashTool] });

    expect(out).toBe(
      [
        "[user]",
        "Refactor the loader.",
        "",
        "[assistant]",
        "[ran: read] app.ts",
        "  read app.ts:1-40",
        "[ran: edit] app.ts",
        "  -old line",
        "  +new line",
        "Done, one call site moved.",
        "",
        "[user]",
        "Now the tests.",
        "",
        "[assistant, in progress]",
        "[ran: bash] bun test x",
        "  bun test x",
        "Running the suite",
      ].join("\n"),
    );

    // Order is the transcript's order, and the live block trails it.
    expect(out.indexOf("Refactor the loader.")).toBeLessThan(out.indexOf("Done, one call site moved."));
    expect(out.indexOf("Done, one call site moved.")).toBeLessThan(out.indexOf("Now the tests."));
    expect(out.indexOf("Now the tests.")).toBeLessThan(out.indexOf("Running the suite"));

    // Plain UTF-8: no markup, no ANSI, and no em dash anywhere.
    expect(out).not.toContain("\u2014");
    expect(out).not.toContain("\u001b[");
    expect(out).not.toContain("<");
    expect(out).not.toContain("**");
  });

  it("an empty transcript copies to the empty string", () => {
    expect(transcriptCopyText([])).toBe("");
    expect(transcriptCopyText([turn({ role: "user" })])).toBe("");
    expect(transcriptCopyText([], { text: "   ", tools: [] })).toBe("");
    expect(transcriptCopyText([], { text: "", tools: [] })).toBe("");
  });

  it("a live block with only a tool call still copies", () => {
    expect(transcriptCopyText([], { text: "", tools: [bashTool] })).toBe("[assistant, in progress]\n[ran: bash] bun test x\n  bun test x");
  });
});
