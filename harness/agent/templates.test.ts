// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/agent/templates.test.ts — P-AGENT.17 (ADR-0143): the in-repo starter templates MUST stay valid
// portable agents (parse + digest + validator + secret-free). A rotted template silently vanishes from the
// gallery at run time; this test makes the rot loud at CI time instead.

import { test, expect, describe } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePortableAgentJson } from "./portable.ts";

const TEMPLATES_DIR = join(import.meta.dir, "..", "..", "templates", "agents");

describe("starter templates (P-AGENT.17)", () => {
  const files = readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".lucid-agent.json"));

  test("the gallery ships at least one template", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const f of files) {
    test(`${f} is a valid, digest-intact, secret-free portable agent`, () => {
      const r = parsePortableAgentJson(readFileSync(join(TEMPLATES_DIR, f), "utf8"));
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
      const s = r.spec!;
      expect(s.nodes.length).toBeGreaterThan(0);
      // template hygiene: no secrets, no egress surprises — starters must be frictionless AND safe
      expect(s.secrets ?? []).toEqual([]);
      expect(s.egress).toEqual([]);
      // every tool step's tool is allow-listed (validator guarantees it; assert the list is minimal too)
      expect(s.tools.length).toBeLessThanOrEqual(3);
    });
  }
});
