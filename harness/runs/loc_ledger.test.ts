// harness/runs/loc_ledger.test.ts
//
// P-LOC.1 (ADR-0031): the ledger writer + roll-up over the frozen 0007 table. Verifies the
// migration applies, edits persist with their attribution context, multi-file edits fan out to
// one row per file (summing back to the total), and the roll-up groups by (model, repo, identity).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../memory/db.ts";
import { aiLocRollup, recordAiEdit, type AttributionContext } from "./loc_ledger.ts";
import type { EditResultLike } from "./loc_count.ts";

let dir: string;
let db: Db;
const CTX: AttributionContext = {
  model: "claude-opus-4-8",
  identity: "dev@acme.com",
  identitySource: "email",
  repo: "/work/acme-app",
  runId: "run-1",
  sessionId: "sess-1",
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "loc-ledger-"));
  db = await Db.open(join(dir, "obs.duckdb"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("migration 0007", () => {
  it("applies and creates ai_loc_ledger", async () => {
    expect(await db.appliedVersions()).toContain(7);
    const rows = await db.all("SELECT count(*)::INT AS n FROM ai_loc_ledger");
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

describe("recordAiEdit", () => {
  it("records a write with its attribution context", async () => {
    const ev: EditResultLike = { toolName: "write", input: { path: "a.ts", content: "x\ny\nz\n" } };
    const r = await recordAiEdit(db, ev, CTX);
    expect(r.recorded).toBe(true);
    expect(r.added).toBe(3);
    const row = await db.get("SELECT * FROM ai_loc_ledger");
    expect(row!.model).toBe("claude-opus-4-8");
    expect(row!.identity).toBe("dev@acme.com");
    expect(row!.identity_source).toBe("email");
    expect(row!.repo).toBe("/work/acme-app");
    expect(row!.tool).toBe("write");
    expect(Number(row!.added_lines)).toBe(3);
    expect(Number(row!.removed_lines)).toBe(0);
  });

  it("does not record non-countable results", async () => {
    const r = await recordAiEdit(db, { toolName: "bash", input: { command: "ls" } }, CTX);
    expect(r.recorded).toBe(false);
    expect((await db.all("SELECT * FROM ai_loc_ledger")).length).toBe(0);
  });

  it("empty model is recorded as 'unknown'", async () => {
    await recordAiEdit(db, { toolName: "write", input: { path: "a", content: "l\n" } }, { ...CTX, model: "" });
    const row = await db.get("SELECT model FROM ai_loc_ledger");
    expect(row!.model).toBe("unknown");
  });

  it("multi-file edit fans out to one row per file, summing to the total", async () => {
    const ev: EditResultLike = {
      toolName: "edit",
      details: {
        perFileResults: [
          { path: "a.ts", diff: ["+1|a", "+2|b", "+3|c"].join("\n") }, // +3
          { path: "b.ts", diff: ["-4|x", "+5|y"].join("\n") }, // +1 -1
        ],
      },
    };
    const r = await recordAiEdit(db, ev, CTX);
    expect(r.rows).toBe(2);
    const totals = await db.get("SELECT sum(added_lines)::INT a, sum(removed_lines)::INT d, count(*)::INT n FROM ai_loc_ledger");
    expect(Number(totals!.a)).toBe(4); // matches countEdit total
    expect(Number(totals!.d)).toBe(1);
    expect(Number(totals!.n)).toBe(2);
  });
});

describe("aiLocRollup", () => {
  it("groups by (model, repo, identity)", async () => {
    await recordAiEdit(db, { toolName: "write", input: { path: "a", content: "a\nb\n" } }, CTX); // opus +2
    await recordAiEdit(db, { toolName: "write", input: { path: "b", content: "c\n" } }, CTX); // opus +1, same group
    await recordAiEdit(db, { toolName: "write", input: { path: "c", content: "d\ne\nf\n" } }, { ...CTX, model: "claude-sonnet-4-6" }); // sonnet +3

    const roll = await aiLocRollup(db);
    expect(roll.length).toBe(2);
    const opus = roll.find((r) => r.model === "claude-opus-4-8")!;
    expect(opus.added).toBe(3);
    expect(opus.edits).toBe(2);
    expect(opus.identity).toBe("dev@acme.com");
    expect(opus.identitySource).toBe("email");
    const sonnet = roll.find((r) => r.model === "claude-sonnet-4-6")!;
    expect(sonnet.added).toBe(3);
    expect(sonnet.edits).toBe(1);
  });

  it("separates the same model across different repos and identities", async () => {
    await recordAiEdit(db, { toolName: "write", input: { content: "a\n" } }, CTX);
    await recordAiEdit(db, { toolName: "write", input: { content: "a\n" } }, { ...CTX, repo: "/work/other" });
    await recordAiEdit(db, { toolName: "write", input: { content: "a\n" } }, { ...CTX, identity: "BUILDBOX", identitySource: "workstation" });
    const roll = await aiLocRollup(db);
    expect(roll.length).toBe(3);
  });
});
