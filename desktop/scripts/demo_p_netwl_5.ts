// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_netwl_5.ts — P-NETWL.5 (ADR-0108): the egress POSTURE. Two pre-checked personal-mode
// toggles: "allow web search" and "allow all websites + local LAN". The curated whitelist ENFORCES only when
// allow-all is OFF; with it ON the agent reaches the internet freely EXCEPT it still prompts for a public IP or
// a foreign-country-TLD site. An enterprise-managed policy clamps allow-all OFF. Hermetic: drives the REAL pure
// code (egressAllowAllVerdict + clampPosture + egressWhitelistEntry), reproducing egressDecisionDetailed's order.

import { clampPosture, egressAllowAllVerdict, egressWhitelistEntry, isForeignTld, isPrivateOrLanHost } from "../egress_policy.ts";
import { DEFAULT_POSTURE, emptyStore, upsertEntry, type WhitelistEntry, type WhitelistStore } from "../network_whitelist.ts";
import type { ManagedEgressPolicy } from "../managed_config.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);

// Reproduce egressDecisionDetailed's decision ORDER purely (no disk): whitelist wins → allow-all → prompt.
function decide(store: WhitelistStore, url: string, managed?: ManagedEgressPolicy): "allow(whitelist)" | "allow(all)" | "prompt" {
  if (egressWhitelistEntry(store, url, managed)) return "allow(whitelist)";
  const posture = clampPosture(store.posture ?? DEFAULT_POSTURE, managed);
  if (posture.allowAll && egressAllowAllVerdict(url) === "allow") return "allow(all)";
  return "prompt";
}

console.log("== P-NETWL.5 — egress posture: allow-all + web-search, whitelist enforces only when allow-all is off ==");

console.log("\n1) allow-all classifier: LAN allows, public IP prompts, foreign TLD prompts, US/generic allows");
for (const h of ["http://10.1.2.3", "http://192.168.0.9", "http://127.0.0.1", "http://localhost:3000", "http://nas.local"]) if (egressAllowAllVerdict(h) !== "allow") fail(`LAN host should allow: ${h}`);
for (const h of ["http://8.8.8.8", "https://1.1.1.1/x"]) if (egressAllowAllVerdict(h) !== "prompt") fail(`public IP should prompt: ${h}`);
for (const u of ["https://baidu.cn", "https://x.ru", "https://shop.co.uk", "https://a.de"]) if (egressAllowAllVerdict(u) !== "prompt") fail(`foreign ccTLD should prompt: ${u}`);
for (const u of ["https://github.com", "https://claude.ai", "https://x.io", "https://y.co", "https://z.us", "https://a.dev"]) if (egressAllowAllVerdict(u) !== "allow") fail(`US/generic should allow: ${u}`);
if (!isPrivateOrLanHost("192.168.1.1") || isPrivateOrLanHost("8.8.8.8")) fail("private-IP detection");
if (!isForeignTld("news.bbc.co.uk") || isForeignTld("claude.ai")) fail("foreign-TLD detection (claude.ai is a generic-use ccTLD)");
ok("LAN/private/localhost → allow · public IP + foreign ccTLD → prompt · US/generic (.com/.ai/.io/.co) → allow");

console.log("\n2) the default posture is permissive (both pre-checked) — the agent works out of the box");
if (!(DEFAULT_POSTURE.allowAll && DEFAULT_POSTURE.allowWebSearch)) fail("default posture should be both ON");
ok("DEFAULT_POSTURE = allow-all ON + web-search ON");

console.log("\n3) with ALLOW-ALL on: normal sites auto-allow, but public IP / foreign sites still prompt");
let store: WhitelistStore = emptyStore(); // posture defaults permissive
if (decide(store, "https://github.com/x") !== "allow(all)") fail("github.com should allow via allow-all");
if (decide(store, "http://10.0.0.5:8080") !== "allow(all)") fail("LAN should allow via allow-all");
if (decide(store, "https://baidu.cn") !== "prompt") fail("foreign site should still prompt under allow-all");
if (decide(store, "http://8.8.8.8") !== "prompt") fail("public IP should still prompt under allow-all");
ok("github.com + LAN → allow(all); baidu.cn + 8.8.8.8 → still prompt");

console.log("\n4) an explicit whitelist entry WINS over the allow-all prompt (so you can approve a foreign site)");
const entry = (o: Partial<WhitelistEntry> & Pick<WhitelistEntry, "id" | "pattern">): WhitelistEntry => ({ kind: "domain", zone: "external", scope: "always", ...o });
store = upsertEntry(store, entry({ id: "cn", pattern: "baidu.cn", zone: "external", scope: "always" }));
if (decide(store, "https://baidu.cn/s") !== "allow(whitelist)") fail("a whitelisted foreign site should auto-allow");
ok("whitelisted baidu.cn → allow(whitelist), beating the foreign-TLD prompt");

console.log("\n5) turning ALLOW-ALL OFF enforces the whitelist; a managed policy forces it off too");
store.posture = { allowAll: false, allowWebSearch: true };
if (decide(store, "https://github.com") !== "prompt") fail("with allow-all off, an unlisted site must prompt (whitelist-enforced)");
if (decide(store, "https://baidu.cn") !== "allow(whitelist)") fail("the whitelisted site still auto-allows");
// managed restrictive policy clamps allow-all off even if the user left it on:
store.posture = { allowAll: true, allowWebSearch: true };
const managed: ManagedEgressPolicy = { disableDangerMode: true };
if (decide(store, "https://github.com", managed) !== "prompt") fail("a managed restrictive policy must force allow-all OFF");
ok("allow-all off → whitelist-only; managed policy clamps allow-all off (the Support-Desk case)");

console.log("\nPASS — allow-all lets the agent work out of the box, still prompting for public IPs / foreign sites; the whitelist enforces when it's off; enterprise policy clamps it.");
