// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/sessions_delete.test.ts
//
// Issue #53: deleting a chat from the session menu removes the omp .jsonl transcript
// from disk. It is scoped to the current workspace (defense in depth) and matched by
// session id; the append-only DuckDB audit/provenance is a separate store and untouched.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteSession } from "./sessions.ts";

let root: string;
const CWD = "C:/work/proj-a";

// Write a minimal omp-style session .jsonl: a `session` record (id + cwd) then one message.
function seedSession(id: string, cwd: string): string {
  const dir = join(root, encodeURIComponent(cwd));
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${id}.jsonl`);
  writeFileSync(
    p,
    `${JSON.stringify({ type: "session", id, cwd })}\n${JSON.stringify({ type: "message", message: { role: "user", content: "hi" } })}\n`,
  );
  return p;
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "sess-del-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

test("deletes the matching session file in the current workspace", () => {
  const p = seedSession("sess-1", CWD);
  expect(existsSync(p)).toBe(true);
  const r = deleteSession("sess-1", CWD, root);
  expect(r.ok).toBe(true);
  expect(existsSync(p)).toBe(false);
});

test("refuses to delete a session that belongs to another workspace", () => {
  const p = seedSession("sess-2", "C:/work/proj-b");
  const r = deleteSession("sess-2", CWD, root); // ask as proj-a
  expect(r.ok).toBe(false);
  expect(r.error).toContain("another workspace");
  expect(existsSync(p)).toBe(true); // untouched
});

test("returns not-found for an unknown id and leaves other sessions intact", () => {
  const keep = seedSession("sess-keep", CWD);
  const r = deleteSession("does-not-exist", CWD, root);
  expect(r.ok).toBe(false);
  expect(r.error).toContain("not found");
  expect(existsSync(keep)).toBe(true);
});

test("matches by filename when the session record lacks an id", () => {
  const dir = join(root, encodeURIComponent(CWD));
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "raw-id.jsonl");
  writeFileSync(p, `${JSON.stringify({ type: "session", cwd: CWD })}\n`);
  const r = deleteSession("raw-id.jsonl", CWD, root);
  expect(r.ok).toBe(true);
  expect(existsSync(p)).toBe(false);
});
