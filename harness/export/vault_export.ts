// harness/export/vault_export.ts — P9.4: export the personalization knowledge graph
// to an Obsidian vault (ADR-0010 / ADR-0012), plus a NARA-aligned CUI archive path.
//
// PURE + DETERMINISTIC (no I/O, no clock of its own — the caller passes `now`): given a
// decrypted PersonalGraph it returns the files to write. The desktop layer (personal.ts)
// does the decrypt → write → audit. This split keeps the security-sensitive rendering
// fully unit-testable.
//
// Two guarantees carried from safe_export.ts:
//   - every emitted string is escapeMarkdown-escaped → no invisible/control/bidi codepoint
//     can ride along into a note (defense in depth — the store data is already gated).
//   - links are sanitized but kept working: only a strict http(s) URL with no dangerous
//     codepoints becomes a clickable [display](href); anything else degrades to escaped text.
//
// Scope-awareness (ADR-0012): the ordinary vault export NEVER includes CUI unless the
// caller explicitly lists "cui" in `scopes`. CUI has its own dedicated, loud, audited
// path (buildCuiArchive) with National Archives (NARA) records-management + CUI marking
// scaffolding — it is never bundled into the portable personal/work vault.

import { createHash } from "node:crypto";
import { escapeMarkdown } from "./safe_export.ts";
import type { PersonalEntity, PersonalFact, PersonalGraph, PersonalScope, UserKind } from "../personal/store.ts";

export interface VaultFile { path: string; content: string }
export interface VaultSummary {
  entities: number;
  facts: number;
  files: number;
  scopes: PersonalScope[];
  includedCui: boolean;
  payloadSha256: string;
}
export interface VaultBuild { files: VaultFile[]; summary: VaultSummary }

export interface VaultOptions {
  /** Compartments to include. CUI is included ONLY if "cui" is present here. */
  scopes: PersonalScope[];
  /** ISO timestamp for the export (caller-supplied; the module has no clock). */
  now: string;
}

// ── kind → folder + singular label ────────────────────────────────────────────
const KIND_DIR: Record<UserKind, { dir: string; label: string }> = {
  "user:preference": { dir: "Preferences", label: "Preference" },
  "user:decision": { dir: "Decisions", label: "Decision" },
  "user:goal": { dir: "Goals", label: "Goal" },
  "user:interest": { dir: "Interests", label: "Interest" },
  "user:skill": { dir: "Skills", label: "Skill" },
  "user:behavior": { dir: "Behaviors", label: "Behavior" },
  "user:personality": { dir: "Personality", label: "Trait" },
  "user:relationship": { dir: "Relationships", label: "Relationship" },
  "user:link": { dir: "Links", label: "Link" },
};
const KIND_ORDER: UserKind[] = [
  "user:preference", "user:decision", "user:goal", "user:interest",
  "user:skill", "user:behavior", "user:personality", "user:relationship", "user:link",
];
const dirFor = (k: UserKind) => KIND_DIR[k] ?? { dir: "Other", label: "Fact" };

// ── safety helpers (kept local; safe_export's frozen surface is untouched) ─────
const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x180e]);
const BIDI = new Set([0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x061c]);
function isDangerousCp(code: number): boolean {
  if (code < 0x20 && code !== 0x0a && code !== 0x09) return true;
  if (code === 0x7f) return true;
  if (ZERO_WIDTH.has(code) || BIDI.has(code)) return true;
  if (code >= 0xe0000 && code <= 0xe007f) return true;
  return false;
}
const SAFE_URL = /^https?:\/\/[^\s)>\]<"'`\\]+$/i;
/** A URL we are willing to emit as a working link: strict http(s), no dangerous codepoints. */
export function isSafeUrl(u: string): boolean {
  if (!SAFE_URL.test(u)) return false;
  for (const ch of u) if (isDangerousCp(ch.codePointAt(0)!)) return false;
  return true;
}
/** A clickable link when the URL is safe, else escaped plain text. Display is always escaped. */
function mdLink(display: string, url: string): string {
  return isSafeUrl(url) ? `[${escapeMarkdown(display)}](${url})` : escapeMarkdown(display);
}

/** YAML scalar: quote + escape so no value can break the frontmatter or smuggle a codepoint. */
function yamlScalar(s: string): string {
  const escaped = escapeMarkdown(s)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** Stable, filesystem-safe basename for an entity; the Obsidian wikilink target. */
function slug(name: string, id: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  // Suffix a short, stable id slice so distinct entities never collide on one filename.
  return `${base || "entity"}-${id.slice(-6)}`;
}

const pct = (c: number) => `${Math.round((c ?? 0) * 100)}%`;

interface Rendered { entities: number; facts: number; files: VaultFile[] }

/** Shared note renderer for both the ordinary vault and the CUI archive. `marking`, when
 *  set, wraps every note in a banner + portion-marks each fact (the CUI path). */
function renderNotes(graph: PersonalGraph, scopes: Set<PersonalScope>, opts: { marking?: string } = {}): Rendered {
  const factsByEntity = new Map<string, PersonalFact[]>();
  for (const f of graph.facts) {
    if (f.status !== "active" || !scopes.has(f.scope)) continue;
    (factsByEntity.get(f.entity_id) ?? factsByEntity.set(f.entity_id, []).get(f.entity_id)!).push(f);
  }
  const kept = graph.entities.filter((e) => factsByEntity.has(e.id));
  const slugOf = new Map<string, string>();
  const nameOf = new Map<string, string>();
  for (const e of kept) { slugOf.set(e.id, slug(e.name, e.id)); nameOf.set(e.id, e.name); }

  const linksFrom = new Map<string, { to: string; relation: string }[]>();
  for (const l of graph.links) {
    if (!slugOf.has(l.from_entity_id) || !slugOf.has(l.to_entity_id)) continue;
    (linksFrom.get(l.from_entity_id) ?? linksFrom.set(l.from_entity_id, []).get(l.from_entity_id)!)
      .push({ to: l.to_entity_id, relation: l.relation });
  }

  const banner = opts.marking;
  const files: VaultFile[] = [];
  let factCount = 0;

  for (const e of kept) {
    const facts = factsByEntity.get(e.id)!;
    factCount += facts.length;
    const meta = dirFor(e.kind);
    const factScopes = [...new Set(facts.map((f) => f.scope))].sort();
    const lines: string[] = [];
    if (banner) lines.push(banner, "");
    lines.push(
      "---",
      `title: ${yamlScalar(e.name)}`,
      `kind: ${yamlScalar(e.kind)}`,
      `trust: ${yamlScalar(e.trust_label)}`,
      `confidence: ${e.confidence}`,
      `entity_id: ${yamlScalar(e.id)}`,
      `scopes: [${factScopes.map(yamlScalar).join(", ")}]`,
      `tags: [personal-kg, ${meta.dir.toLowerCase()}]`,
      "---",
      "",
      `# ${escapeMarkdown(e.name)}`,
      "",
      `> ${meta.label} · trust **${escapeMarkdown(e.trust_label)}**`,
      "",
      "## Facts",
      "",
    );
    for (const f of facts) {
      const isLink = e.kind === "user:link";
      const body = isLink && isSafeUrl(f.statement) ? mdLink(f.statement, f.statement) : escapeMarkdown(f.statement);
      const mark = banner ? "(CUI) " : "";
      const prov = f.source_session_id ? ` · session \`${escapeMarkdown(f.source_session_id)}\`` : "";
      lines.push(`- ${mark}${body} _(${escapeMarkdown(f.trust_label)} · ${pct(f.confidence)})_${prov}`);
    }
    // Link entities also surface the URL itself as a clickable, sanitized link.
    if (e.kind === "user:link" && isSafeUrl(e.name)) lines.push("", `**Link:** ${mdLink(e.name, e.name)}`);

    const related = linksFrom.get(e.id) ?? [];
    if (related.length) {
      lines.push("", "## Related", "");
      for (const r of related) lines.push(`- ${escapeMarkdown(r.relation)} → [[${slugOf.get(r.to)}|${escapeMarkdown(nameOf.get(r.to)!)}]]`);
    }
    if (banner) lines.push("", "---", "", banner);
    files.push({ path: `${meta.dir}/${slugOf.get(e.id)}.md`, content: lines.join("\n") + "\n" });
  }

  return { entities: kept.length, facts: factCount, files };
}

/** Build the portable Obsidian vault (note-per-entity + `_index.md` MOC). CUI excluded
 *  unless `scopes` explicitly includes it. */
export function buildVault(graph: PersonalGraph, opts: VaultOptions): VaultBuild {
  const scopeSet = new Set(opts.scopes);
  const includedCui = scopeSet.has("cui");
  const { entities, facts, files } = renderNotes(graph, scopeSet);

  // _index.md — a Map-of-Content grouped by kind.
  const kindBuckets = new Map<UserKind, { slug: string; name: string; count: number }[]>();
  const factsByEntity = new Map<string, number>();
  for (const f of graph.facts) if (f.status === "active" && scopeSet.has(f.scope)) factsByEntity.set(f.entity_id, (factsByEntity.get(f.entity_id) ?? 0) + 1);
  for (const e of graph.entities) {
    const n = factsByEntity.get(e.id);
    if (!n) continue;
    (kindBuckets.get(e.kind) ?? kindBuckets.set(e.kind, []).get(e.kind)!).push({ slug: slug(e.name, e.id), name: e.name, count: n });
  }
  const idx: string[] = [
    "---", "title: \"Personal knowledge graph\"", "tags: [personal-kg, index]", "---", "",
    "# Personal knowledge graph", "",
    `> Exported ${escapeMarkdown(opts.now)} from LucidAgentIDE · compartments: ${opts.scopes.map((s) => `\`${s}\``).join(", ")}`, "",
    includedCui
      ? "> [!warning] This vault INCLUDES CUI-compartment notes. Handle per your CUI policy."
      : "> [!note] CUI-compartment knowledge is excluded from this vault by design (ADR-0012).",
    "",
  ];
  for (const k of KIND_ORDER) {
    const items = kindBuckets.get(k);
    if (!items?.length) continue;
    idx.push(`## ${dirFor(k).dir}`, "");
    for (const it of items.sort((a, b) => a.name.localeCompare(b.name))) idx.push(`- [[${it.slug}|${escapeMarkdown(it.name)}]] · ${it.count} fact${it.count === 1 ? "" : "s"}`);
    idx.push("");
  }
  const allFiles: VaultFile[] = [{ path: "_index.md", content: idx.join("\n") + "\n" }, ...files];

  return { files: allFiles, summary: { entities, facts, files: allFiles.length, scopes: [...opts.scopes], includedCui, payloadSha256: payloadSha(allFiles) } };
}

// ── CUI archive (National Archives / NARA records-management alignment) ────────
// HONEST POSTURE (mirrors the FIPS posture in ADR-0010): this produces a CUI-marked,
// records-management-annotated archive package with the REQUIRED fields scaffolded. It
// applies CUI banner + portion markings and a NARA records-schedule manifest, but the
// designation values (category, controlling agency, decontrol, records schedule) MUST be
// completed by an authorized CUI/records officer. The tool marks and packages; it does
// not certify a designation.

export interface CuiDesignation {
  banner?: string; // default "CUI"
  categories?: string[]; // CUI category markings (e.g. "CUI//SP-PRVCY")
  designatingAgency?: string;
  controlledBy?: string;
  poc?: string;
  disseminationControls?: string[]; // e.g. NOFORN, FEDCON
  decontrol?: string; // event or date
  // NARA records management
  recordsSchedule?: string; // GRS/agency schedule item (e.g. "GRS 4.2")
  disposition?: "TEMPORARY" | "PERMANENT" | string;
  retention?: string;
  reviewer?: string;
}
export interface CuiArchiveBuild {
  files: VaultFile[];
  summary: VaultSummary & { manifestSha256: string };
}

const PLACEHOLDER = "REQUIRED — complete per your CUI/records program";

export function buildCuiArchive(graph: PersonalGraph, opts: { now: string; designation?: CuiDesignation }): CuiArchiveBuild {
  const d = opts.designation ?? {};
  const banner = (d.banner && d.banner.trim()) || "CUI";
  const cats = d.categories?.length ? d.categories : [PLACEHOLDER];

  const { entities, facts, files: notes } = renderNotes(graph, new Set<PersonalScope>(["cui"]), { marking: banner });

  // Human-readable CUI cover sheet (concept mirrors the SF-901 CUI cover sheet).
  const cover: string[] = [
    banner, "",
    "# CONTROLLED UNCLASSIFIED INFORMATION — Archive cover sheet", "",
    "This package contains Controlled Unclassified Information (CUI). Handle, store, and",
    "transmit per 32 CFR Part 2002 and your agency CUI program. Do not post to public",
    "systems. Destroy or decontrol per the records schedule below.", "",
    "## Designation",
    `- Banner: **${escapeMarkdown(banner)}**`,
    `- Category marking(s): ${cats.map((c) => `\`${escapeMarkdown(c)}\``).join(", ")}`,
    `- Designating agency: ${escapeMarkdown(d.designatingAgency ?? PLACEHOLDER)}`,
    `- Controlled by: ${escapeMarkdown(d.controlledBy ?? PLACEHOLDER)}`,
    `- Dissemination controls: ${(d.disseminationControls?.length ? d.disseminationControls : ["NONE — set per policy"]).map((x) => escapeMarkdown(x)).join(", ")}`,
    `- Decontrol (event/date): ${escapeMarkdown(d.decontrol ?? PLACEHOLDER)}`,
    `- Point of contact: ${escapeMarkdown(d.poc ?? PLACEHOLDER)}`, "",
    "## Records management (NARA)",
    `- Records schedule: ${escapeMarkdown(d.recordsSchedule ?? PLACEHOLDER)}`,
    `- Disposition: ${escapeMarkdown(d.disposition ?? PLACEHOLDER)}`,
    `- Retention: ${escapeMarkdown(d.retention ?? PLACEHOLDER)}`,
    `- Transfer format: markdown + JSON (Obsidian-compatible vault)`, "",
    `> Exported ${escapeMarkdown(opts.now)} from LucidAgentIDE · scope: \`cui\` only · ${entities} entit${entities === 1 ? "y" : "ies"}, ${facts} fact${facts === 1 ? "" : "s"}.`, "",
    banner,
  ];

  const partial: VaultFile[] = [{ path: "_CUI_COVER_SHEET.md", content: cover.join("\n") + "\n" }, ...notes];

  // SHA-256 inventory over every content file (stable order).
  const inventory = partial
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => ({ path: f.path, sha256: sha256(f.content), bytes: Buffer.byteLength(f.content, "utf8") }));

  const manifest = {
    format: "lucid-cui-archive.v1",
    notice: "Controlled Unclassified Information. Tool-marked scaffolding; designation values must be completed and verified by an authorized CUI/records officer (32 CFR 2002; NARA records schedule).",
    cui: {
      banner,
      categories: cats,
      designating_agency: d.designatingAgency ?? PLACEHOLDER,
      controlled_by: d.controlledBy ?? PLACEHOLDER,
      poc: d.poc ?? PLACEHOLDER,
      dissemination_controls: d.disseminationControls ?? [],
      decontrol: d.decontrol ?? PLACEHOLDER,
    },
    records_management: {
      authority: "NARA",
      records_schedule: d.recordsSchedule ?? PLACEHOLDER,
      disposition: d.disposition ?? PLACEHOLDER,
      retention: d.retention ?? PLACEHOLDER,
      transfer_format: "markdown+json (Obsidian vault)",
    },
    export: { exported_at: opts.now, exported_by: d.reviewer ?? null, tool: "LucidAgentIDE P9.4", scope: "cui" },
    counts: { entities, facts, files: partial.length },
    inventory,
    integrity: { algorithm: "SHA-256", manifest_sha256: "" as string },
  };
  // manifest_sha256 is computed over the inventory (the bytes it attests to).
  const manifestSha256 = sha256(JSON.stringify(inventory));
  manifest.integrity.manifest_sha256 = manifestSha256;

  const files: VaultFile[] = [
    { path: "_CUI_MANIFEST.json", content: JSON.stringify(manifest, null, 2) + "\n" },
    ...partial,
  ];

  return {
    files,
    summary: {
      entities, facts, files: files.length, scopes: ["cui"], includedCui: true,
      payloadSha256: payloadSha(files), manifestSha256,
    },
  };
}

function sha256(s: string): string { return createHash("sha256").update(s, "utf8").digest("hex"); }
/** A single hash over the whole export (path-sorted) — the audited payload fingerprint. */
function payloadSha(files: VaultFile[]): string {
  const joined = files.slice().sort((a, b) => a.path.localeCompare(b.path)).map((f) => `${f.path}\n${f.content}`).join(" ");
  return sha256(joined);
}
