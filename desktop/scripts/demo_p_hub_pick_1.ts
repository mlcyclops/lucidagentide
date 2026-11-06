// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_hub_pick_1.ts
//
// Increment P-HUB-PICK.1 (ADR-0470): a hub picker, a codebase on every spoke, and "spoke" in every agent note.
//   1. Two hubs, five spokes over three codebases: the picker lists the hub on screen first, then the other,
//      each with the codebases its spokes work on and how many wait on you.
//   2. Two clones of one GitHub repo read and color as the same codebase; two folders named alike do not.
//   3. The attach/release notes the agent reads say "spoke", never "lane".

import { hubEntries } from "../renderer/orbit_layout.ts";
import { repoSections, spokeRepo } from "../renderer/spoke_repo.ts";
import { demoteAgentNote, promoteAgentNote } from "../renderer/composer_target.ts";
import type { RepoContext } from "../renderer/bridge.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} \u2713`);

const hosted = (root: string, owner: string, repo: string): RepoContext => ({
  cwd: root, source: "folder", others: [],
  repo: { root, name: root.split(/[\\/]/).pop()!, branch: "main", head: "abc1234", worktree: false, remotes: 1,
    push: { remote: "origin", branch: "main", host: "github.com", provider: "github", owner, repo, webUrl: "" } },
});
const lucidA = hosted("\\\\nas\\lucidagentide", "mlcyclops", "lucidagentide");
const lucidB = hosted("C:\\wt\\lucid-search-wt", "mlcyclops", "lucidagentide");
const seo = hosted("\\\\nas\\JanelleSEO", "emertins", "JanelleSEO");
const lane = (id: string, name: string, status: "working" | "awaiting-input" | "needs-approval" | "done", hub: string, cwd: string, repo: RepoContext | null, at: number) =>
  ({ id, name, status, hubSessionId: hub, cwd, lastActivityAt: at, ...(repo ? { repo } : {}) });
const lanes = [
  lane("l1", "sidebar search", "working", "hub-a", lucidA.cwd, lucidA, 10),
  lane("l2", "seo audit", "awaiting-input", "hub-a", seo.cwd, seo, 20),
  lane("l3", "notes", "done", "hub-a", "C:\\notes", null, 5),
  lane("l4", "deploy fix", "needs-approval", "hub-b", seo.cwd, seo, 40),
  lane("l5", "release notes", "working", "hub-b", lucidB.cwd, lucidB, 30),
];

console.log("== P-HUB-PICK.1: the hub picker and per-spoke codebases ==");
const hubs = hubEntries(lanes, "hub-a");
if (hubs.map((h) => h.sessionId).join() !== "hub-a,hub-b" || !hubs[0]!.current) fail(`picker order: ${hubs.map((h) => h.sessionId)}`);
for (const h of hubs) ok(`${h.current ? "this hub " : "other hub"} ${h.sessionId}: ${h.lanes.length} spokes, ${h.waiting} waiting, codebases ${h.repos.map((r) => r.name).join(" + ")}`);
if (hubs[1]!.repos.length !== 2 || hubs[1]!.waiting !== 1) fail("hub-b must name 2 codebases and 1 waiting spoke");

const a = spokeRepo(lanes[0]!), b = spokeRepo(lanes[4]!);
if (a.key !== b.key || a.hue !== b.hue) fail("two clones of one GitHub repo must be one codebase");
if (spokeRepo({ cwd: "/x/notes" }).key === spokeRepo({ cwd: "/y/notes" }).key) fail("same-named folders must not merge");
ok(`a worktree and the main checkout of mlcyclops/lucidagentide share one codebase and hue ${a.hue}; same-named folders stay apart`);

const secs = repoSections(lanes.map((l) => l.id), (id) => { const l = lanes.find((x) => x.id === id); return l ? spokeRepo(l) : null; });
ok(`By repo: ${secs.map((s) => `${s.repo.name} (${s.ids.length})`).join(", ")}`);

const t = { kind: "lane" as const, laneId: "l1", name: "sidebar search", cwd: lucidA.cwd, model: "anthropic/claude-opus-5-5" };
for (const note of [promoteAgentNote(t), demoteAgentNote(t)]) if (/\blanes?\b/i.test(note) || !/spoke/.test(note)) fail(`agent note still says lane: ${note}`);
ok(`the agent reads: "${demoteAgentNote(t).slice(0, 118)}..."`);

console.log("SMOKE OK");
