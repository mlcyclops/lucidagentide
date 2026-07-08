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
    expect(managedLocks({ security: { exec: { lock: true } } })).toEqual({ exec: true, egress: false, loop: false, models: false, collab: false });
    expect(managedLocks({ security: { egress: { lock: true } } }).egress).toBe(true);
    expect(managedLocks({ security: { loop: { lock: true } } }).loop).toBe(true);
    expect(managedLocks({ models: { lock: true } }).models).toBe(true);
    expect(managedLocks({ asksageOnly: true }).models).toBe(true); // implied
    expect(managedLocks(null)).toEqual({ exec: false, egress: false, loop: false, models: false, collab: false });
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

// ── ADR-0193 (P-COLLAB.6): embedded-relay governance ──────────────────────────────────────────────
import { authorizeRelayBind, authorizeRelayConnect, collabServeAllowed } from "./managed_config.ts";

describe("collab relay governance (ADR-0193 P-COLLAB.6)", () => {
  test("serve is allowed by default (unmanaged) + when not explicitly disabled", () => {
    expect(collabServeAllowed(null)).toBe(true);
    expect(collabServeAllowed({ orgName: "Acme" })).toBe(true);
    expect(collabServeAllowed({ collab: { allowServe: true } })).toBe(true);
  });

  test("a managed allowServe:false forbids hosting entirely (tighten-only)", () => {
    expect(collabServeAllowed({ collab: { allowServe: false } })).toBe(false);
    const d = authorizeRelayBind("127.0.0.1", 8790, { orgName: "Acme", collab: { allowServe: false } });
    expect(d.ok).toBe(false);
    expect(d.reason).toContain("disabled by Acme");
  });

  test("localhost binds are always allowed (unmanaged and managed)", () => {
    for (const h of ["127.0.0.1", "::1", "localhost", "LocalHost"]) {
      expect(authorizeRelayBind(h, 8790, null).ok).toBe(true);
      expect(authorizeRelayBind(h, 8790, { orgName: "Acme", collab: {} }).ok).toBe(true);
    }
  });

  test("unmanaged: a LAN bind is the user's call (allowed)", () => {
    expect(authorizeRelayBind("10.0.0.5", 8790, null).ok).toBe(true);
    expect(authorizeRelayBind("0.0.0.0", 8790, null).ok).toBe(true); // all-interfaces, personal machine
  });

  test("managed with NO allowlist: a non-localhost bind is refused (LAN needs an admin allowlist)", () => {
    const mc: ManagedConfig = { orgName: "Acme", collab: {} };
    expect(authorizeRelayBind("10.0.0.5", 8790, mc).ok).toBe(false);
    expect(authorizeRelayBind("0.0.0.0", 8790, mc).ok).toBe(false); // all-interfaces is NOT loopback
  });

  test("allowedBinds is an ABSOLUTE whitelist: only listed host[:port] pass", () => {
    const mc: ManagedConfig = { orgName: "Acme", collab: { allowedBinds: ["10.0.0.5:8790", "relay.corp.internal"] } };
    expect(authorizeRelayBind("10.0.0.5", 8790, mc).ok).toBe(true);       // exact host+port
    expect(authorizeRelayBind("10.0.0.5", 9999, mc).ok).toBe(false);      // wrong port
    expect(authorizeRelayBind("relay.corp.internal", 443, mc).ok).toBe(true);  // host-only entry → any port
    expect(authorizeRelayBind("relay.corp.internal", 8443, mc).ok).toBe(true);
    expect(authorizeRelayBind("10.0.0.6", 8790, mc).ok).toBe(false);      // host not listed
    expect(authorizeRelayBind("127.0.0.1", 1, mc).ok).toBe(true);         // localhost still always ok
  });

  test("authorizeRelayConnect: unrestricted unless allowedRelays is set, then whitelisted", () => {
    expect(authorizeRelayConnect("wss://anything.example", null).ok).toBe(true);
    const mc: ManagedConfig = { orgName: "Acme", collab: { allowedRelays: ["relay.corp.internal:443", "my.omp.sh"] } };
    expect(authorizeRelayConnect("wss://relay.corp.internal/r/abc", mc).ok).toBe(true); // wss → 443 matches
    expect(authorizeRelayConnect("wss://my.omp.sh/r/x", mc).ok).toBe(true);              // host-only → any port
    expect(authorizeRelayConnect("wss://evil.example/r/x", mc).ok).toBe(false);
    expect(authorizeRelayConnect("ws://relay.corp.internal:8790/r/x", mc).ok).toBe(false); // wrong port for that entry
    expect(authorizeRelayConnect("not a url", mc).ok).toBe(false); // fail-closed on a malformed endpoint
  });

  test("managedLocks.collab reflects lock OR a forced allowServe:false", () => {
    expect(managedLocks({ collab: { lock: true } }).collab).toBe(true);
    expect(managedLocks({ collab: { allowServe: false } }).collab).toBe(true);
    expect(managedLocks({ collab: { allowServe: true } }).collab).toBe(false);
    expect(managedLocks(null).collab).toBe(false);
  });

  test("GPO registry channel parses the collab knobs (DWORD + list)", () => {
    const out = [
      "HKEY_LOCAL_MACHINE\Software\Policies\LucidAgentIDE",
      "    OrgName    REG_SZ    Acme",
      "    CollabAllowServe    REG_DWORD    0x1",
      "    CollabAllowedBinds    REG_SZ    10.0.0.5:8790,relay.corp.internal",
      "    CollabAllowedRelays    REG_SZ    my.omp.sh,relay.corp.internal:443",
      "    CollabLock    REG_DWORD    0x1",
    ].join("\r\n");
    const cfg = parseRegistryPolicy(out)!;
    expect(cfg.collab?.allowServe).toBe(true);
    expect(cfg.collab?.allowedBinds).toEqual(["10.0.0.5:8790", "relay.corp.internal"]);
    expect(cfg.collab?.allowedRelays).toEqual(["my.omp.sh", "relay.corp.internal:443"]);
    expect(cfg.collab?.lock).toBe(true);
  });

  test("mergeManaged deep-merges the collab block (file wins per leaf)", () => {
    const reg: ManagedConfig = { collab: { allowServe: true, allowedBinds: ["10.0.0.5:8790"] } };
    const file: ManagedConfig = { collab: { allowServe: false } };
    const merged = mergeManaged(reg, file)!;
    expect(merged.collab?.allowServe).toBe(false);                 // file overrides
    expect(merged.collab?.allowedBinds).toEqual(["10.0.0.5:8790"]); // registry preserved
  });
});
