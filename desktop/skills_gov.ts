// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/skills_gov.ts — P-SKILL.4 (ADR-0097): the PURE governance rules for the Agent Skill directory.
//
// This is the shared, side-effect-free brain that BOTH the desktop server (skills_data.ts, which reads
// the filesystem + scan-verdict ledger) and the renderer (skills.ts, which owns the enable/disable
// toggle in localStorage) consult. It has NO node/omp/DOM imports on purpose — it must bundle into the
// browser renderer as cleanly as it runs in the server, so the enable/enforce decision is byte-identical
// on both sides (there is exactly ONE rule for "can this skill be active", per invariant #3 fail-closed).
//
// SECURITY (CLAUDE.md invariants #3 + #7, keystone #2): trust labels are the closed set from contracts.ts.
// A `suspicious`/`quarantined` skill is NEVER enableable — the toggle can't turn it on — and defaults off.
// "Invents no new trust mechanism" (ADR-0097): bundled + curated `.agents` skills are frozen `trusted`;
// project/user/plugin skills carry their scan verdict, and are shown `untrusted` until scanned. An
// unscanned skill stays enableable + on (this is the status quo — omp already loads project skills — so
// the directory adds governance WITHOUT regressing existing skills); only a scan that FLAGS a skill
// locks it off.

import type { TrustLabel } from "../harness/contracts.ts";

// ── The source roots a skill can come from (invariant #7-adjacent: a small closed set). ─────────────
//   bundled — the inline INSTALLED_SKILLS corpus (renderer/skills.ts): frozen, reviewed, trusted.
//   project — <workspace>/.omp/skills/<slug>/SKILL.md: where scan-gated imports land (removable).
//   user    — <home>/.omp/agent/skills (or <home>/.omp/skills): the per-user skill dir (removable).
//   agents  — .agents/skills: operator-curated, vendor-trusted, provenance in SOURCES.md (immutable).
//   plugin  — a third-party CLI provider's skills (claude/codex/…): not ours, not removable.
//   registry— reserved for ADR-0098's enterprise registry reader (a remote source that installs locally).
export const SKILL_ROOTS = ["bundled", "project", "user", "agents", "plugin", "registry"] as const;
export type SkillRoot = (typeof SKILL_ROOTS)[number];

/** Display + grouping order for the directory view. */
export const ROOT_ORDER: readonly SkillRoot[] = ["bundled", "project", "user", "agents", "plugin", "registry"];

// P-SKILLREG.1 (ADR-0098): a registry-installed skill lands in the project skills dir (so omp discovers
// it natively) but carries this provenance marker file, which the directory uses to re-classify it as the
// `registry` root. The filename is shared here (pure, no node) so the writer (skills_registry.ts) and the
// reader (skills_data.ts) agree on exactly one name.
export const REGISTRY_MARKER = ".lucid-registry.json";

export const ROOT_LABEL: Record<SkillRoot, string> = {
  bundled: "Built-in",
  project: "Project · .omp/skills",
  user: "User · ~/.omp/agent/skills",
  agents: "Curated · .agents/skills",
  plugin: "Plugin",
  registry: "Registry",
};

export function isSkillRoot(v: unknown): v is SkillRoot {
  return typeof v === "string" && (SKILL_ROOTS as readonly string[]).includes(v);
}

/** Stable per-skill governance key: `<root>:<name>`. Names are unique within a root (omp dedupes
 *  discovered skills by name), so this identifies a skill for the enable/disable ledger + directory. */
export function skillKey(root: SkillRoot, name: string): string {
  return `${root}:${name}`;
}

/**
 * A skill's trust from its root + optional scan verdict. Bundled + `.agents` are frozen `trusted`
 * (reviewed vendor/first-party assets). project/user/plugin carry their recorded scan verdict; unscanned
 * ⇒ `untrusted`. A registry skill only appears AFTER a scan-gated install, so it too rides its verdict.
 * PURE — invents no trust; just maps root + verdict onto the closed set.
 */
export function rootTrust(root: SkillRoot, scanned?: TrustLabel | null): TrustLabel {
  if (root === "bundled" || root === "agents") return "trusted";
  return scanned ?? "untrusted";
}

/**
 * Can this trust level EVER be enabled? Fail-closed (invariant #3, keystone #2): a `suspicious` or
 * `quarantined` skill is never enableable — no toggle turns it on, so flagged content can never become
 * active guidance. `trusted`/`untrusted` are enableable.
 */
export function trustEnableable(trust: TrustLabel): boolean {
  return trust === "trusted" || trust === "untrusted";
}

/**
 * The single authoritative "is this skill active" decision, consulted identically by the bundled-skill
 * delivery path AND the `/skill:` picker. `override` is the user's explicit toggle (from localStorage);
 * `undefined` means "no override → use the default". A non-enableable trust FORCES off regardless of any
 * stale override (so a skill that was enabled then re-scanned to `suspicious` goes dark immediately).
 * Every enableable trust (trusted + unscanned/untrusted) defaults ON — unscanned project skills already
 * load in omp today, so default-off would silently break them (a regression, not a security win); only a
 * scan that FLAGS a skill (→ non-enableable) turns it off.
 */
export function effectiveEnabled(override: boolean | undefined, trust: TrustLabel): boolean {
  if (!trustEnableable(trust)) return false;
  return override ?? true;
}

/** Only project + user skills live in dirs WE own and may delete; bundled/agents/plugin/registry are
 *  immutable from the directory (invariant: remove is confined to the import write's own roots). */
export function rootRemovable(root: SkillRoot): boolean {
  return root === "project" || root === "user" || root === "registry";
}

// ── Readiness checklist (ADR-0097): the whitepaper's deployment bar, ADVISORY (never blocking). ─────
export interface ReadyItem {
  label: string;
  ok: boolean;
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Obvious hard-coded-secret shapes to warn on (advisory only — the real gate is the scanner). Kept
// deliberately narrow to avoid noise: private-key headers, AWS access keys, and `secret/token/password:`
// assignments with a non-placeholder value.
const SECRET_HINTS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9/+_-]{16,}/i,
];

/**
 * The advisory readiness checklist for a skill. `body` (the SKILL.md content) enables the deeper checks
 * (secret scan); without it only the metadata checks run. PURE — no I/O, deterministic.
 */
export function readinessChecklist(input: {
  name: string;
  description: string;
  trust: TrustLabel;
  body?: string;
}): ReadyItem[] {
  const items: ReadyItem[] = [
    { label: "Name is a valid kebab-case id", ok: KEBAB.test(input.name) },
    { label: "Description says what it does & when to use it", ok: input.description.trim().length >= 20 },
    { label: "Security scan is clean", ok: input.trust === "trusted" },
  ];
  if (typeof input.body === "string") {
    items.push({ label: "No hard-coded secrets in the body", ok: !SECRET_HINTS.some((re) => re.test(input.body!)) });
  }
  return items;
}
