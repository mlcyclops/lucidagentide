// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/managed_config.test.ts — the pure update-channel policy resolver (ADR-A009, #74). Fail-safe by
// design: unmanaged/unknown ⇒ github (never silently disable), feed-without-url ⇒ managed (never hit a
// wrong/empty feed), managed ⇒ disabled.

import { describe, expect, test } from "bun:test";
import {
  clampToManaged, dangerModeAllowed, managedAsksageOnly, managedLocks, mergeManaged,
  modelAllowed, parseRegistryPolicy, resolveUpdatePolicy, type ManagedConfig,
} from "./managed_config.ts";

describe("resolveUpdatePolicy (ADR-A009 #74)", () => {
  test("unmanaged (null) defaults to the github channel", () => {
    expect(resolveUpdatePolicy(null)).toEqual({ channel: "github" });
  });

  test("a managed config with no updateChannel defaults to github", () => {
    expect(resolveUpdatePolicy({ orgName: "Acme" })).toEqual({ channel: "github" });
  });

  test("an unknown channel value fails safe to github (never silently disables updates)", () => {
    expect(resolveUpdatePolicy({ updateChannel: "nonsense" as never })).toEqual({ channel: "github" });
  });

  test("github channel is explicit github", () => {
    expect(resolveUpdatePolicy({ updateChannel: "github" })).toEqual({ channel: "github" });
  });

  test("feed channel with a URL uses that internal mirror", () => {
    const mc: ManagedConfig = { updateChannel: "feed", updateFeedUrl: "https://feed.acme.com/lucid/" };
    expect(resolveUpdatePolicy(mc)).toEqual({ channel: "feed", feedUrl: "https://feed.acme.com/lucid/" });
  });

  test("feed URL is trimmed", () => {
    const mc: ManagedConfig = { updateChannel: "feed", updateFeedUrl: "  https://feed.acme.com/  " };
    expect(resolveUpdatePolicy(mc)).toEqual({ channel: "feed", feedUrl: "https://feed.acme.com/" });
  });

  test("feed channel with NO usable URL fails safe to managed (no wrong/empty feed)", () => {
    expect(resolveUpdatePolicy({ updateChannel: "feed" })).toEqual({ channel: "managed" });
    expect(resolveUpdatePolicy({ updateChannel: "feed", updateFeedUrl: "   " })).toEqual({ channel: "managed" });
  });

  test("managed channel disables the in-app check (no feedUrl)", () => {
    expect(resolveUpdatePolicy({ updateChannel: "managed" })).toEqual({ channel: "managed" });
    expect(resolveUpdatePolicy({ updateChannel: "managed", updateFeedUrl: "https://ignored/" })).toEqual({ channel: "managed" });
  });
});

// ── ADR-0068 (P-ENT.1): managed security-knob governance — clamp/lock/registry matrix ────────────

describe("clampToManaged (tier ceiling — user may go safer, never riskier)", () => {
  test("a user choice riskier than the ceiling is clamped DOWN to the ceiling", () => {
    expect(clampToManaged("T4", "T1")).toBe("T1");
    expect(clampToManaged("T3", "T2")).toBe("T2");
  });
  test("a user choice safer than the ceiling is kept (never raised)", () => {
    expect(clampToManaged("T0", "T3")).toBe("T0");
    expect(clampToManaged("T1", "T4")).toBe("T1");
  });
  test("equal tiers pass through", () => {
    expect(clampToManaged("T2", "T2")).toBe("T2");
  });
  test("no ceiling (unmanaged) ⇒ the user's choice stands", () => {
    expect(clampToManaged("T3", undefined)).toBe("T3");
  });
  test("unset/garbage user choice fails closed to the safest tier (T0)", () => {
    expect(clampToManaged(undefined, "T3")).toBe("T0");
    expect(clampToManaged("nope" as never, "T3")).toBe("T0");
    expect(clampToManaged(undefined, undefined)).toBe("T0");
  });
  test("a garbage ceiling is treated as no ceiling (user's valid choice stands)", () => {
    expect(clampToManaged("T3", "T9" as never)).toBe("T3");
  });
});

describe("modelAllowed (deny overrides; a non-empty allow-list restricts)", () => {
  test("no policy ⇒ everything routes", () => {
    expect(modelAllowed("anthropic/claude-opus", undefined)).toBe(true);
    expect(modelAllowed("gpt-5", {})).toBe(true);
  });
  test("a denied substring always blocks", () => {
    expect(modelAllowed("openai/gpt-5", { denied: ["gpt"] })).toBe(false);
  });
  test("a non-empty allow-list restricts routing to matching ids", () => {
    const m = { allowed: ["claude", "gemini"] };
    expect(modelAllowed("anthropic/claude-opus", m)).toBe(true);
    expect(modelAllowed("openai/gpt-5", m)).toBe(false);
  });
  test("deny wins even when also allow-listed", () => {
    expect(modelAllowed("anthropic/claude-opus", { allowed: ["claude"], denied: ["opus"] })).toBe(false);
  });
});

describe("managedAsksageOnly + managedLocks", () => {
  test("asksageOnly is OR'd from the legacy top-level flag and the models block", () => {
    expect(managedAsksageOnly({ asksageOnly: true })).toBe(true);
    expect(managedAsksageOnly({ models: { asksageOnly: true } })).toBe(true);
    expect(managedAsksageOnly({})).toBe(false);
    expect(managedAsksageOnly(null)).toBe(false);
  });
  test("each lock flag surfaces; forcing AskSage-only implies a models lock", () => {
    expect(managedLocks({ security: { exec: { lock: true } } })).toEqual({ exec: true, egress: false, loop: false, models: false });
    expect(managedLocks({ security: { egress: { lock: true } } }).egress).toBe(true);
    expect(managedLocks({ security: { loop: { lock: true } } }).loop).toBe(true);
    expect(managedLocks({ models: { lock: true } }).models).toBe(true);
    expect(managedLocks({ asksageOnly: true }).models).toBe(true); // implied
    expect(managedLocks(null)).toEqual({ exec: false, egress: false, loop: false, models: false });
  });
});

describe("dangerModeAllowed (a managed disableDangerMode forbids allow-all)", () => {
  test("forbidden per knob, independently", () => {
    expect(dangerModeAllowed("exec", { security: { exec: { disableDangerMode: true } } })).toBe(false);
    expect(dangerModeAllowed("egress", { security: { exec: { disableDangerMode: true } } })).toBe(true); // exec ban doesn't touch egress
    expect(dangerModeAllowed("egress", { security: { egress: { disableDangerMode: true } } })).toBe(false);
  });
  test("unmanaged ⇒ allowed", () => {
    expect(dangerModeAllowed("exec", null)).toBe(true);
    expect(dangerModeAllowed("egress", {})).toBe(true);
  });
});

describe("parseRegistryPolicy (Windows GPO channel)", () => {
  const SAMPLE = [
    "",
    "HKEY_LOCAL_MACHINE\\Software\\Policies\\LucidAgentIDE",
    "    OrgName    REG_SZ    Acme Corp",
    "    AsksageOnly    REG_DWORD    0x1",
    "    ExecMaxAutoTier    REG_SZ    T2",
    "    ExecDisableDangerMode    REG_DWORD    0x1",
    "    ExecDenylist    REG_SZ    rm,sudo,dd",
    "    EgressDeniedHosts    REG_MULTI_SZ    bank.example\\0evil.test",
    "    LoopMaxAutoTier    REG_SZ    T1",
    "    ModelsLock    REG_DWORD    0x1",
    "",
  ].join("\r\n");

  test("maps scalars, tiers, dwords, csv + multi-sz lists, and the JSON shape", () => {
    const cfg = parseRegistryPolicy(SAMPLE)!;
    expect(cfg.orgName).toBe("Acme Corp");
    expect(cfg.asksageOnly).toBe(true);
    expect(cfg.security?.exec).toEqual({ maxAutoTier: "T2", disableDangerMode: true, denylist: ["rm", "sudo", "dd"] });
    expect(cfg.security?.egress?.deniedHosts).toEqual(["bank.example", "evil.test"]);
    expect(cfg.security?.loop?.maxAutoTier).toBe("T1");
    expect(cfg.models?.lock).toBe(true);
  });
  test("0x0 dword is false; an invalid tier is dropped (fail-closed, not adopted)", () => {
    const out = "k\r\n    AsksageOnly    REG_DWORD    0x0\r\n    ExecMaxAutoTier    REG_SZ    T9\r\n";
    const cfg = parseRegistryPolicy(out)!;
    expect(cfg.asksageOnly).toBe(false);
    expect(cfg.security?.exec?.maxAutoTier).toBeUndefined();
  });
  test("a `Json` blob is the base; flat values overlay it", () => {
    const out = [
      "k",
      `    Json    REG_SZ    {"orgName":"FromJson","models":{"denied":["x"]}}`,
      "    OrgName    REG_SZ    Override",
      "",
    ].join("\r\n");
    const cfg = parseRegistryPolicy(out)!;
    expect(cfg.orgName).toBe("Override");        // flat overlays the JSON base
    expect(cfg.models?.denied).toEqual(["x"]);   // JSON base preserved
  });
  test("empty / value-less output ⇒ null (fail-safe to unmanaged)", () => {
    expect(parseRegistryPolicy("")).toBeNull();
    expect(parseRegistryPolicy("HKEY_LOCAL_MACHINE\\Software\\Policies\\LucidAgentIDE\r\n")).toBeNull();
  });
});

describe("mergeManaged (registry UNDER the file — the file wins per leaf)", () => {
  test("file overrides one security sub-knob without wiping the registry's other sub-policies", () => {
    const reg: ManagedConfig = { orgName: "Reg", security: { exec: { maxAutoTier: "T3" }, egress: { disableDangerMode: true } } };
    const file: ManagedConfig = { orgName: "File", security: { exec: { maxAutoTier: "T1" } } };
    const merged = mergeManaged(reg, file)!;
    expect(merged.orgName).toBe("File");                       // file wins
    expect(merged.security?.exec?.maxAutoTier).toBe("T1");     // file overrides the exec ceiling
    expect(merged.security?.egress?.disableDangerMode).toBe(true); // registry egress preserved
  });
  test("null handling: either side missing returns the other", () => {
    expect(mergeManaged(null, { orgName: "F" })).toEqual({ orgName: "F" });
    expect(mergeManaged({ orgName: "R" }, null)).toEqual({ orgName: "R" });
    expect(mergeManaged(null, null)).toBeNull();
  });
});
