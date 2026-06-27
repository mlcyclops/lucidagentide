// harness/scripts/demo_pent1.ts
//
// ADR-0068 P-ENT.1: enterprise managed-policy override for the security knobs (GPO / MDM).
// Proves the Done-when end to end with the PURE governance helpers: a managed policy can SET + LOCK
// the exec/egress/model knobs, is fail-safe to unmanaged, and can ONLY EVER TIGHTEN (a user may pick
// something safer, never riskier). Run with: bun run harness/scripts/demo_pent1.ts
//
// No files are touched — everything here is the pure clamp/parse/merge surface the live decision points
// (egress_policy, the future exec_policy, the model picker) call.

import {
  clampToManaged, dangerModeAllowed, managedAsksageOnly, managedLocks,
  mergeManaged, modelAllowed, parseRegistryPolicy, type ManagedConfig,
} from "../../desktop/managed_config.ts";
import { clampEgress, egressVerdict } from "../../desktop/egress_policy.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`  ok  ${m}`); };

console.log("== [1/5] tier ceiling: managed clamps a riskier dial DOWN, keeps a safer one ==");
ok(clampToManaged("T4", "T2") === "T2", "user T4 under a T2 ceiling → T2 (tightened)");
ok(clampToManaged("T0", "T2") === "T0", "user T0 under a T2 ceiling → T0 (user may be safer)");
ok(clampToManaged("T3", undefined) === "T3", "no ceiling (unmanaged) → user's T3 stands");
ok(clampToManaged(undefined, "T3") === "T0", "unset dial fails closed to the safest tier T0");

console.log("== [2/5] egress: deny + restrictive allow-list + danger-off, tighten only ==");
const userEgress = { allowHosts: ["in.test", "out.test", "bank.example"], dangerMode: true };
const clamped = clampEgress(userEgress, { allowedHosts: ["in.test", "out.test"], deniedHosts: ["bank.example"], disableDangerMode: true });
ok(egressVerdict(clamped, "https://in.test") === "allow", "org-allow-listed + user-allowed host still auto-allows");
ok(egressVerdict(clamped, "https://bank.example/login") === "prompt", "org-denied host can never auto-allow (prompts)");
ok(egressVerdict(clamped, "https://elsewhere.test") === "prompt", "danger-mode allow-all is forced OFF");
ok(clamped.dangerMode === false, "egress danger mode disabled by policy");

console.log("== [3/5] models: gov-gateway lock + allow/deny routing ==");
ok(managedAsksageOnly({ models: { asksageOnly: true } }) === true, "models.asksageOnly forces the gov gateway");
ok(modelAllowed("openai/gpt-5", { denied: ["gpt"] }) === false, "a denied model substring blocks routing");
ok(modelAllowed("anthropic/claude-opus", { allowed: ["claude"] }) === true, "an allow-listed model routes");
ok(managedLocks({ models: { asksageOnly: true } }).models === true, "locked controls flagged for the 'Managed by <org>' UI");

console.log("== [4/5] Windows Group Policy: HKLM dump parses, file merges UNDER it ==");
const regDump = [
  "HKEY_LOCAL_MACHINE\\Software\\Policies\\LucidAgentIDE",
  "    OrgName    REG_SZ    Acme Corp",
  "    ExecMaxAutoTier    REG_SZ    T3",
  "    EgressDisableDangerMode    REG_DWORD    0x1",
  "",
].join("\r\n");
const reg = parseRegistryPolicy(regDump)!;
ok(reg.orgName === "Acme Corp" && reg.security?.exec?.maxAutoTier === "T3", "GPO registry dump → ManagedConfig");
const file: ManagedConfig = { security: { exec: { maxAutoTier: "T1" } } };
const merged = mergeManaged(reg, file)!;
ok(merged.security?.exec?.maxAutoTier === "T1", "the FILE wins per leaf (exec ceiling overridden)");
ok(merged.security?.egress?.disableDangerMode === true, "registry's other sub-policies survive the merge");

console.log("== [5/5] fail-safe: unmanaged ⇒ nothing is clamped ==");
ok(clampEgress(userEgress, undefined) === userEgress, "no managed egress policy → store returned unchanged");
ok(dangerModeAllowed("exec", null) === true && modelAllowed("anything", undefined) === true, "unmanaged knobs impose no limit");

console.log("\nP-ENT.1 OK — managed policy sets + locks the knobs, only ever tightening, fail-safe to unmanaged.");
process.exit(0);
