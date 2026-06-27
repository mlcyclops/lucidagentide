// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/runs/profiles.test.ts

import { test, expect } from "bun:test";
import { caps, chooseProfile, isReadOnly, PROFILE_CAPS } from "./profiles.ts";

test("clean task honors the requested profile (no downgrade)", () => {
  const d = chooseProfile({ requested: "trusted-local", trustLabel: "untrusted" });
  expect(d.profile).toBe("trusted-local");
  expect(d.downgraded).toBe(false);
});

test("suspicious content downgrades to at least container-local", () => {
  const d = chooseProfile({ requested: "trusted-local", trustLabel: "suspicious" });
  expect(d.profile).toBe("container-local");
  expect(d.downgraded).toBe(true);
});

test("quarantined content downgrades to quarantine", () => {
  const d = chooseProfile({ requested: "trusted-local", trustLabel: "quarantined" });
  expect(d.profile).toBe("quarantine");
  expect(d.downgraded).toBe(true);
});

test("approval lifts the downgrade (honors requested)", () => {
  expect(chooseProfile({ requested: "trusted-local", trustLabel: "quarantined", approved: true }).profile).toBe("trusted-local");
  expect(chooseProfile({ requested: "trusted-local", trustLabel: "suspicious", approved: true }).profile).toBe("trusted-local");
});

test("security-review and replay modes are always read-only-audit", () => {
  expect(chooseProfile({ mode: "security-review", requested: "trusted-local" }).profile).toBe("read-only-audit");
  expect(chooseProfile({ mode: "replay", requested: "trusted-local" }).profile).toBe("read-only-audit");
});

test("remote tasks default to remote-runner", () => {
  expect(chooseProfile({ remote: true, trustLabel: "untrusted" }).profile).toBe("remote-runner");
});

test("a downgrade is never an upgrade: requesting quarantine on clean stays quarantine", () => {
  const d = chooseProfile({ requested: "quarantine", trustLabel: "untrusted" });
  expect(d.profile).toBe("quarantine");
  expect(d.downgraded).toBe(false);
});

test("read-only profiles have no write or exec", () => {
  expect(isReadOnly("read-only-audit")).toBe(true);
  expect(isReadOnly("quarantine")).toBe(true);
  expect(isReadOnly("trusted-local")).toBe(false);
  expect(isReadOnly("container-local")).toBe(false);
});

test("every profile maps to an omp isolation backend", () => {
  for (const p of Object.keys(PROFILE_CAPS) as (keyof typeof PROFILE_CAPS)[]) {
    expect(["none", "worktree", "overlay"]).toContain(caps(p).isolation);
  }
});
