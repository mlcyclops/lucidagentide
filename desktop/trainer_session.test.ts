// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/trainer_session.test.ts - P-TRAINER.8: the trainer is role-generic by DEFAULT. A fresh install
// stores nothing and asks for a role (needsRole); the WMO pack is an optional, explicitly-activated,
// clearly-labeled sample (useDemoPack); a user-built role never inherits WMO objectives or seed units.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getState, setRole, useDemoPack } from "./trainer_session.ts";
import { WMO_OBJECTIVES, WMO_PACK_ID } from "../harness/trainer/wmo_pack.ts";

// Isolate BOTH stores the way the other trainer tests isolate theirs (mkdtemp + afterAll rmSync,
// store.test.ts): the duckdb file via LUCID_TRAINER_DB_PATH and trainer-active.json via
// LUCID_PERSONAL_DIR (settings_store.ts personalBaseDir(), ADR-0034). Both are read lazily inside
// trainer_session, so setting them here, before the first getState() call, is enough.
const dir = mkdtempSync(join(tmpdir(), "trainer-session-"));
const dbPath = join(dir, "trainer.duckdb");
const savedDb = process.env.LUCID_TRAINER_DB_PATH;
const savedPersonal = process.env.LUCID_PERSONAL_DIR;
process.env.LUCID_TRAINER_DB_PATH = dbPath;
process.env.LUCID_PERSONAL_DIR = dir;
afterAll(() => {
  if (savedDb === undefined) delete process.env.LUCID_TRAINER_DB_PATH; else process.env.LUCID_TRAINER_DB_PATH = savedDb;
  if (savedPersonal === undefined) delete process.env.LUCID_PERSONAL_DIR; else process.env.LUCID_PERSONAL_DIR = savedPersonal;
  rmSync(dir, { recursive: true, force: true });
});

const WMO_DOMAINS = new Set(WMO_OBJECTIVES.map((o) => o.domain));
const SEED_UNITS = 8; // the authored confirmed reference units in trainer_session.ts SEED

// The three tests share the temp dir and run in order: fresh -> sample activated -> custom role.
// That progression is the point - the custom role activates AFTER the WMO sample is seeded into the
// SAME trainer.duckdb, so the leak assertions exercise real cross-pack isolation.
describe("trainer_session: role-generic by default, WMO as an explicit sample", () => {
  test("fresh install: getState() is a minimal needsRole state and stores NOTHING WMO", async () => {
    const st = await getState();
    expect(st.needsRole).toBe(true);
    expect(st.needsSetup).toBe(true);
    expect(st.pack).toBe("");
    expect(st.role.label).toBe("Choose a role");
    expect(st.coverage).toBe(0);
    expect(st.domains).toEqual([]);
    expect(st.gap).toBeNull();
    expect(st.question).toBeNull();
    expect(st.units).toBe(0);
    expect(st.confirmed).toBe(0);
    // Nothing WMO (or anything else) was stored: without a role the store is never even opened,
    // so trainer.duckdb does not exist yet.
    expect(existsSync(dbPath)).toBe(false);
  });

  test("explicit demo activation seeds the labeled WMO sample, idempotently", async () => {
    const st = await useDemoPack();
    expect(st.needsRole).toBe(false);
    expect(st.pack).toBe(WMO_PACK_ID);
    expect(st.role.label).toBe("Wealth-Management Ops (sample)");
    // WMO objectives are present (domains come straight from them) and the seed units landed confirmed
    expect(st.domains.length).toBeGreaterThan(0);
    for (const d of st.domains) expect(WMO_DOMAINS.has(d.domain)).toBe(true);
    expect(st.units).toBe(SEED_UNITS);
    expect(st.confirmed).toBe(SEED_UNITS);
    expect(st.coverage).toBeGreaterThan(0);
    expect(st.question).not.toBeNull();
    expect(existsSync(dbPath)).toBe(true);
    // re-activation is a no-op on storage: same objectives, same units, nothing duplicated
    const again = await useDemoPack();
    expect(again.units).toBe(st.units);
    expect(again.confirmed).toBe(st.confirmed);
    expect(again.domains).toEqual(st.domains);
    expect(again.coverage).toBe(st.coverage);
  });

  test("a user-built role activates its own pack with zero WMO leakage", async () => {
    const res = await setRole({ role: "ER Charge Nurse", tasks: [
      "Triage incoming patients by acuity",
      "Coordinate bed assignments with the floor",
      "Escalate critical labs to the attending",
    ] });
    expect(res.ok).toBe(true);
    const st = res.state!;
    expect(st.needsRole).toBe(false);
    expect(st.pack).toBe("role-er-charge-nurse");
    expect(st.pack).not.toBe(WMO_PACK_ID);
    expect(st.role.label).toBe("ER Charge Nurse");
    // the WMO sample sits seeded in the SAME trainer.duckdb (previous test) - none of it leaks across:
    expect(st.domains.length).toBe(3); // exactly the three duties, nothing WMO appended
    for (const d of st.domains) expect(WMO_DOMAINS.has(d.domain)).toBe(false);
    expect(st.gap).not.toBeNull();
    expect(st.gap!.objectiveId.startsWith("role-er-charge-nurse-")).toBe(true);
    if (st.question) expect(st.question.objectiveId.startsWith("role-er-charge-nurse-")).toBe(true);
    expect(st.units).toBe(0); // WMO seed units never attach to a custom role
    expect(st.confirmed).toBe(0);
    // and the active role persists: a fresh getState() stays on the custom pack
    const next = await getState();
    expect(next.pack).toBe("role-er-charge-nurse");
    expect(next.needsRole).toBe(false);
  });
});
