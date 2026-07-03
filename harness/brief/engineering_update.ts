// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/brief/engineering_update.ts
//
// P-BRIEF.1 (ADR-0070): the "Executive Engineering Update" generator. Turns a repo's own structured
// change logs - PROGRESS.md (shipped/stubbed/next), DECISIONS.md (ADR status + DEPENDS ON / Relates to),
// and the goal-loop After-Action Report (loop_report.ts `LoopMetrics`) - into a typed `EngineeringUpdate`
// with the three sections an exec audience cares about: LOAD-BEARING DEPENDENCIES, TECH DEBT, and UPCOMING
// DECISIONS (plus recently-shipped + risks). It then renders a written brief AND a TTS-ready two-host
// podcast SCRIPT.
//
// PURE + air-gap by construction: no I/O, no Date.now(), no network. The caller passes the file contents
// and an optional AAR; audio is produced by a separate `PodcastBackend` (the seam below) so the default
// path emits a script and NO cloud vendor is required. The NotebookLM-Enterprise / ElevenLabs / Podcastfy
// adapters are follow-on slices that implement this same interface (ADR-0070).

// Minimal structural view of the goal-loop After-Action Report (desktop/loop_report.ts `LoopMetrics`),
// declared locally so this harness module never imports the desktop layer (clean layering). The desktop
// caller passes its real LoopMetrics, which structurally satisfies this.
import { renderComplianceSection } from "./compliance.ts"; // P-REPORT.6: Security-brief control crosswalk

export interface AarLike {
  outcome?: string;
  outcomeReason?: string;
  iterations?: number;
  toolCalls?: Record<string, number>;
  loc?: { added: number; removed: number } | null;
  errors?: { iter: number; detail: string }[];
  blocks?: { reason?: string }[];
}

export interface UpdateItem {
  title: string;
  detail?: string;
  /** Where the signal came from (e.g. "PROGRESS.md", "ADR-0066"). */
  source: string;
}

export interface EngineeringUpdate {
  /** A caller-supplied label (repo/branch/date) - never minted here, to keep this module pure. */
  label: string;
  recentlyShipped: UpdateItem[];
  loadBearingDependencies: UpdateItem[];
  techDebt: UpdateItem[];
  upcomingDecisions: UpdateItem[];
  risks: UpdateItem[];
}

// ── parsing inputs ────────────────────────────────────────────────────────────

interface ProgressEntry { title: string; shipped?: string; stubbed?: string; next?: string }

/** Parse PROGRESS.md: blocks separated by a `---` rule, each a bold title + shipped/stubbed/next bullets.
 *  Tolerant - a block missing any field still parses. Returns entries in file order. */
export function parseProgress(md: string): ProgressEntry[] {
  const out: ProgressEntry[] = [];
  for (const block of (md || "").split(/^\s*---\s*$/m)) {
    const titleM = block.match(/\*\*(.+?)\*\*/);
    if (!titleM) continue;
    const field = (name: string) => {
      const m = block.match(new RegExp(`\\*\\*${name}:\\*\\*\\s*([\\s\\S]*?)(?:\\n\\s*-\\s*\\*\\*|\\n\\s*$|$)`, "i"));
      return m ? m[1]!.replace(/\s+/g, " ").trim() : undefined;
    };
    const title = titleM[1]!.replace(/\s+/g, " ").trim();
    const e: ProgressEntry = { title, shipped: field("shipped"), stubbed: field("stubbed"), next: field("next") };
    if (e.shipped || e.stubbed || e.next) out.push(e);
  }
  return out;
}

interface AdrEntry { id: string; title: string; status: string; dependsOn: string[]; body: string }

/** Parse DECISIONS.md ADR headers + their Status line and any DEPENDS ON / Blocked by signal. */
export function parseAdrs(md: string): AdrEntry[] {
  const out: AdrEntry[] = [];
  const re = /^##\s+(ADR-\d+)\s*[-–]\s*(.+)$/gm;
  const heads: { id: string; title: string; idx: number }[] = [];
  for (const m of (md || "").matchAll(re)) heads.push({ id: m[1]!, title: m[2]!.trim(), idx: m.index! });
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i]!;
    const body = (md || "").slice(h.idx, i + 1 < heads.length ? heads[i + 1]!.idx : undefined);
    const statusM = body.match(/\*\*Status:\*\*\s*(.+)/i);
    const status = statusM ? statusM[1]!.trim() : "";
    const dependsOn: string[] = [];
    for (const dm of body.matchAll(/(?:DEPENDS ON|Blocked by|depends on)\b[^.\n]*?(ADR-\d+|#\d+)/gi)) dependsOn.push(dm[1]!);
    out.push({ id: h.id, title: h.title, status, dependsOn, body });
  }
  return out;
}

const isOpenDecision = (status: string) => /proposed|scope\/plan|deferred|finding|\(design\)/i.test(status);
const isShipped = (status: string) => /built|accepted/i.test(status) && !/deferred|finding|proposed/i.test(status);
const clip = (s: string, n = 240) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/** Build the structured update from the repo's logs. `aar` (optional) folds the latest loop run's
 *  blocks/errors into the Risks section. `label` is caller-supplied (purity). */
export function buildEngineeringUpdate(args: {
  label: string;
  progressMd?: string;
  decisionsMd?: string;
  aar?: AarLike | null;
  /** How many recent PROGRESS entries to consider (most recent last in the file). Default 6. */
  recentWindow?: number;
}): EngineeringUpdate {
  const recentWindow = args.recentWindow ?? 6;
  const progress = parseProgress(args.progressMd ?? "");
  const adrs = parseAdrs(args.decisionsMd ?? "");
  const recent = progress.slice(-recentWindow);

  const recentlyShipped: UpdateItem[] = [];
  const techDebt: UpdateItem[] = [];
  const upcomingDecisions: UpdateItem[] = [];
  const loadBearingDependencies: UpdateItem[] = [];
  const risks: UpdateItem[] = [];

  for (const e of recent) {
    if (e.shipped) recentlyShipped.push({ title: e.title, detail: clip(e.shipped), source: "PROGRESS.md" });
    if (e.stubbed) techDebt.push({ title: e.title, detail: clip(e.stubbed), source: "PROGRESS.md" });
    if (e.next) upcomingDecisions.push({ title: `Next: ${e.title}`, detail: clip(e.next), source: "PROGRESS.md" });
  }

  for (const a of adrs) {
    if (isOpenDecision(a.status)) {
      upcomingDecisions.push({ title: `${a.id} - ${clip(a.title, 90)}`, detail: clip(a.status, 120), source: a.id });
    } else if (isShipped(a.status) && recentlyShipped.length < recentWindow + adrs.length) {
      // recently-decided/built ADRs reinforce the shipped picture (deduped by title later by the caller)
    }
    if (/finding|deferred/i.test(a.status)) {
      techDebt.push({ title: `${a.id} - deferred/finding`, detail: clip(a.title, 120), source: a.id });
    }
    for (const dep of a.dependsOn) {
      loadBearingDependencies.push({ title: `${a.id} depends on ${dep}`, detail: clip(a.title, 100), source: a.id });
    }
  }

  if (args.aar) {
    const m = args.aar;
    const tools = Object.values(m.toolCalls ?? {}).reduce((x, y) => x + y, 0);
    if (m.errors?.length) risks.push({ title: `${m.errors.length} error(s) in the last loop run`, detail: clip(m.errors.map((e) => e.detail).join("; "), 200), source: "AAR" });
    if (m.blocks?.length) risks.push({ title: `${m.blocks.length} security/risk block(s) in the last loop run`, detail: clip(m.blocks.map((b) => b.reason ?? "blocked").join("; "), 200), source: "AAR" });
    if (m.outcome && m.outcome !== "met") risks.push({ title: `Last loop ended "${m.outcome}"`, detail: clip(m.outcomeReason ?? "", 160), source: "AAR" });
    recentlyShipped.push({ title: "Latest automated run", detail: `${m.iterations ?? 0} iter · ${tools} tool calls · ${m.loc ? `+${m.loc.added}/-${m.loc.removed} LOC` : "LOC n/a"}`, source: "AAR" });
  }

  return { label: args.label, recentlyShipped, loadBearingDependencies, techDebt, upcomingDecisions, risks };
}

// ── written brief ───────────────────────────────────────────────────────────

// P-REPORT.1 (ADR-0116): per-role tailoring. The extraction (buildEngineeringUpdate) stays audience-neutral;
// tailoring is a pure RENDER concern that ACTUALLY CHANGES CONTENT per audience - which sections appear, an
// item filter, a cap, and whether the ADR/increment codes + source tags show. Only the DEVELOPER view keeps
// the ADR/source detail; Security/Manager/Executive get a role-filtered, plain-language report with no ADRs.
export type BriefRole = "developer" | "security" | "manager" | "executive";
type SectionKey = "recentlyShipped" | "loadBearingDependencies" | "techDebt" | "upcomingDecisions" | "risks";
const SECTION_META: Record<SectionKey, { title: string; empty: string }> = {
  recentlyShipped: { title: "Recently shipped", empty: "Nothing recorded." },
  loadBearingDependencies: { title: "Load-bearing dependencies", empty: "No cross-increment dependencies recorded." },
  techDebt: { title: "Tech debt", empty: "No deferred/stubbed work recorded. 🎉" },
  upcomingDecisions: { title: "Upcoming decisions", empty: "No open decisions recorded." },
  risks: { title: "Risks", empty: "No risks recorded." },
};

/** Remove ADR IDs, increment codes (P-EXEC.2), issue/PR refs (#123), and version tags anywhere in a string,
 *  then tidy the leftover punctuation - so a non-developer audience never sees a code. Pure. */
function scrubCodes(s: string): string {
  return (s || "")
    .replace(/\bADR-\d+\b/gi, "")
    .replace(/\bP-[A-Z]+(?:\.[A-Za-z0-9]+)*\b/g, "")
    .replace(/\b[A-Z]{2,}-\d+\b/g, "")        // TASK-017, PR-style codes
    .replace(/#\d+\b/g, "")
    .replace(/\bv?\d+\.\d+\.\d+\b/g, "")        // version tags like 1.8.26
    .replace(/\(\s*[,·;/-]*\s*\)/g, "")          // empty parens left behind
    .replace(/^[\s,·;:/-]+/, "")                 // leading orphaned punctuation
    .replace(/\s+([,.;:·])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}
/** Strip a leading increment/ADR code + separator from a title, then scrub any remaining codes, then
 *  sentence-case, so non-developer audiences read plain English: "P-EXEC.2 - answer omp's…" → "Answer omp's…". */
function stripCode(title: string): string {
  const lead = (title || "").replace(/^\s*(?:ADR-\d+|[A-Z][A-Z0-9]*-[A-Z0-9.]+|P-[A-Z]+(?:\.[A-Za-z0-9]+)*)\s*[-–·:]\s*/i, "");
  const t = scrubCodes(lead);
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : (scrubCodes(title) || title);
}
/** Does an item touch security (for the Security view's filter)? Matches title + detail + source. */
function isSecurityItem(it: UpdateItem): boolean {
  return /secur|\bgate\b|egress|\bauth\b|vulnerab|codeql|quarantin|\bscan|credential|\bvault\b|\bcui\b|\bfips\b|sovereign|permission|sandbox|inject|isolat|encrypt|blast.?radius|whitelist|\bnetwork\b|privacy|approval|attribut|audit|trust|exfiltrat|malicious|threat/i.test(`${it.title} ${it.detail ?? ""} ${it.source}`);
}

interface RoleView { order: SectionKey[]; filter?: (it: UpdateItem) => boolean; cap: number; showSources: boolean; stripCodes: boolean; dropDetail?: boolean; label: string; intro: string }
// cap 0 = no cap. showSources/stripCodes false → hide "(ADR-XXXX)" tags + scrub codes. dropDetail = title-only.
const DEFAULT_VIEW: RoleView = { order: ["recentlyShipped", "loadBearingDependencies", "techDebt", "upcomingDecisions", "risks"], cap: 0, showSources: true, stripCodes: false, label: "", intro: "" };
const ROLE_VIEW: Record<BriefRole, RoleView> = {
  // Developer: EVERYTHING, with the ADR/increment codes + source tags - the full technical picture.
  developer: { order: ["techDebt", "loadBearingDependencies", "recentlyShipped", "upcomingDecisions", "risks"], cap: 0, showSources: true, stripCodes: false,
    label: "Developer", intro: "Engineering view - the full picture with ADR references: load-bearing work, the debt we're carrying, what shipped, and open technical decisions." },
  // Security: ONLY security-relevant items, no ADR IDs - risks + the decisions/dependencies that shape posture.
  security: { order: ["risks", "upcomingDecisions", "loadBearingDependencies", "recentlyShipped"], filter: isSecurityItem, cap: 0, showSources: false, stripCodes: true,
    label: "Security", intro: "Security view - only the security-relevant work: risks, the decisions that gate our posture, and the dependencies that widen the blast radius. No ADR IDs." },
  // Manager: delivery view - what shipped, decisions waiting on you, risks. No tech-debt/dependencies, no ADRs.
  manager: { order: ["recentlyShipped", "upcomingDecisions", "risks"], cap: 10, showSources: false, stripCodes: true,
    label: "Manager", intro: "Delivery view - what shipped, the decisions waiting on you, and the risks to the plan. Plain language, no ADR references." },
  // Executive: the headlines only - top outcomes, risks, and the calls that need leadership. Title-only, no ADRs.
  executive: { order: ["recentlyShipped", "risks", "upcomingDecisions"], cap: 4, showSources: false, stripCodes: true, dropDetail: true,
    label: "Executive", intro: "Executive view - the headline outcomes, the risks, and the decisions that need leadership. No technical detail or ADR references." },
};

function section(title: string, items: UpdateItem[], emptyNote: string, v: RoleView): string[] {
  const out = [`## ${title}`, ""];
  if (!items.length) { out.push(`_${emptyNote}_`, ""); return out; }
  for (const it of items) {
    const t = v.stripCodes ? stripCode(it.title) : it.title;
    const detail = v.dropDetail ? "" : (v.stripCodes ? scrubCodes(it.detail ?? "") : (it.detail ?? ""));
    const src = v.showSources ? ` _(${it.source})_` : "";
    out.push(`- **${t}**${detail ? ` - ${detail}` : ""}${src}`);
  }
  out.push("");
  return out;
}

/** Render the written Engineering Update (deterministic markdown), tailored to `role` - which sections show,
 *  a security/delivery filter, a cap, and whether ADR/source detail appears. Unset = the full default view. */
export function renderEngineeringBrief(u: EngineeringUpdate, role?: BriefRole): string {
  const v = role ? ROLE_VIEW[role] : DEFAULT_VIEW;
  const sel = (key: SectionKey): UpdateItem[] => {
    let items = u[key];
    if (v.filter) items = items.filter(v.filter);
    return v.cap > 0 ? items.slice(0, v.cap) : items;
  };
  const out: string[] = [];
  out.push(`# ${v.label ? `${v.label} ` : ""}Engineering Update - ${u.label}`, "");
  if (role) out.push(`_${v.intro}_`, "");
  // Scoreboard: only the categories THIS view actually shows (so an exec line never mentions tech-debt).
  const counts = v.order.map((k) => `${sel(k).length} ${SECTION_META[k].title.toLowerCase()}`).join(" · ");
  out.push(`> ${counts}`, "");
  for (const key of v.order) out.push(...section(SECTION_META[key].title, sel(key), SECTION_META[key].empty, v));
  // P-REPORT.6: the Security brief ends with a NIST 800-171/800-53 + STIG-CCI crosswalk of what changed.
  if (role === "security") out.push(renderComplianceSection(u));
  return out.join("\n");
}

// ── TTS-ready podcast script + the vendor-agnostic backend seam ───────────────

export interface PodcastTurn { speaker: string; text: string }
export interface PodcastScript { title: string; turns: PodcastTurn[] }

export interface PodcastResult {
  backendId: string;
  script: PodcastScript;
  /** Generated audio bytes (e.g. a WAV), when a real backend produced them. The caller persists/delivers
   *  them - the backend stays I/O-light and testable. */
  audio?: Uint8Array;
  /** Absolute path to generated audio, when a backend wrote one. */
  audioPath?: string;
  note: string;
}

/** The seam every audio vendor implements (NotebookLM Enterprise audioOverviews, ElevenLabs
 *  studio/podcasts, Podcastfy+Kokoro, …). Backend-agnostic so the caller only sees this interface. */
export interface PodcastBackend {
  readonly id: string;
  synthesize(script: PodcastScript): Promise<PodcastResult>;
}

/** Default backend: no audio vendor configured (or air-gapped with none chosen). Returns the script
 *  itself so the pipeline always produces SOMETHING and never hard-fails on a missing cloud key. */
export class ScriptOnlyBackend implements PodcastBackend {
  readonly id = "script-only";
  async synthesize(script: PodcastScript): Promise<PodcastResult> {
    return { backendId: this.id, script, note: "script-only: no audio backend configured (NotebookLM/ElevenLabs/Podcastfy not wired)" };
  }
}

const ANCHOR = "Host";
const ANALYST = "Engineer";

// P-REPORT.7: make text SPEAKABLE. Read aloud, technical tokens sound wrong - "ADR-0066" becomes
// "ay-dee-arr dash zero zero six six", a middot is silence, `code` keeps its backticks, "P-EXEC.2"
// is noise. This strips markdown + codes, turns symbols into words/pauses, and expands the acronyms
// that mangle worst - so both the podcast script AND the read-aloud flow like speech. Pure.
export function speakable(s: string): string {
  let t = (s || "")
    .replace(/```[\s\S]*?```/g, " ")                       // fenced code blocks - never read a code block aloud
    .replace(/`([^`]*)`/g, "$1")                            // inline code: drop the backticks, keep the word
    .replace(/\*\*?([^*]+)\*\*?/g, "$1").replace(/[_~]/g, " ") // bold/italic/underscore markers
    .replace(/^#{1,6}\s+/gm, "")                            // heading hashes
    .replace(/\bPOA&M\b/gi, "plan of action and milestones")
    .replace(/\bAAR\b/g, "after-action report")
    .replace(/\bTTS\b/g, "text to speech").replace(/\bSTT\b/g, "speech to text")
    .replace(/\bKG\b/g, "knowledge graph").replace(/\bCUI\b/g, "controlled unclassified information")
    .replace(/\bADR-\d+\b/gi, "").replace(/\bP-[A-Z]+(?:\.[A-Za-z0-9]+)*\b/g, "") // increment / decision codes
    .replace(/\b[A-Z]{2,}-\d+\b/g, "")                      // CCI-002450, TASK-017, …
    .replace(/#\d+\b/g, "").replace(/\bv?\d+\.\d+(?:\.\d+)*\b/g, "") // issue refs + version / control numbers
    .replace(/\s*[·|•]\s*/g, ", ").replace(/\s*[→➜]\s*/g, " to ") // middot/pipe → pause, arrow → "to"
    .replace(/\s*\/\s*/g, " ").replace(/&/g, " and ").replace(/\+/g, " plus ").replace(/%/g, " percent")
    .replace(/\(\s*[,;/·-]*\s*\)/g, "")                     // empty parens left after scrubbing
    .replace(/\s+([,.;:!?])/g, "$1").replace(/([,.;:])(?=\S)/g, "$1 ") // tidy punctuation spacing
    .replace(/\s{2,}/g, " ").trim();
  // guarantee it ends like a sentence so TTS lands the intonation
  if (t && !/[.!?]$/.test(t)) t += ".";
  return t;
}

/** Build a NotebookLM-style two-host dialogue from the update - the TTS-ready input a PodcastBackend
 *  consumes. Deterministic; reads like a briefing, leads with what shipped, lands on the decisions. */
export function buildPodcastScript(u: EngineeringUpdate, role?: BriefRole): PodcastScript {
  const v = role ? ROLE_VIEW[role] : null;
  const turns: PodcastTurn[] = [];
  // P-REPORT.7: every spoken line is run through speakable() so the audio never reads a code/symbol/markdown.
  const say = (speaker: string, text: string) => turns.push({ speaker, text: speakable(text) });
  // Spoken list: role-filtered + capped + plain (codes stripped) so the AUDIO matches the written brief.
  const pick = (key: SectionKey): UpdateItem[] => {
    let items = u[key];
    if (v?.filter) items = items.filter(v.filter);
    return v && v.cap > 0 ? items.slice(0, v.cap) : items;
  };
  const shows = (key: SectionKey) => !v || v.order.includes(key);
  const list = (items: UpdateItem[], max = 4) => items.slice(0, max).map((i) => (v && v.stripCodes ? stripCode(i.title) : i.title)).join("; ");
  const shipped = pick("recentlyShipped"), deps = pick("loadBearingDependencies"), debt = pick("techDebt"), decisions = pick("upcomingDecisions"), risks = pick("risks");
  const roleName = v ? v.label : "Executive";

  say(ANCHOR, `Welcome to the ${roleName} Engineering Update for ${u.label}. I'm here with our engineering lead to walk through where things stand${role ? `, from a ${roleName.toLowerCase()} angle` : ""}.`);
  if (v) say(ANALYST, v.intro);
  if (shows("recentlyShipped") && shipped.length) {
    say(ANALYST, `The headline is what shipped: ${list(shipped)}.`);
    say(ANCHOR, shows("loadBearingDependencies") ? `Good momentum. What's holding the weight underneath all that?` : `Good momentum.`);
  } else if (shows("recentlyShipped")) {
    say(ANALYST, `Quiet cycle on shipping, so let's focus on what's coming.`);
  }
  if (shows("loadBearingDependencies") && deps.length) {
    say(ANALYST, `On load-bearing dependencies: ${list(deps)}. If any of those move, the work stacked on them moves with it.`);
  }
  if (shows("techDebt") && debt.length) {
    say(ANCHOR, `Let's be honest about the debt.`);
    say(ANALYST, `Tech debt we're carrying forward: ${list(debt)}. None of it is on fire, but it's the interest we'll pay later.`);
  }
  if (shows("upcomingDecisions") && decisions.length) {
    say(ANCHOR, `So what needs a decision?`);
    say(ANALYST, `The open calls are: ${list(decisions, 5)}. Those are the forks where leadership input changes the next increment.`);
  }
  if (shows("risks") && risks.length) {
    say(ANCHOR, `Anything that should worry us?`);
    say(ANALYST, `${role === "security" ? "Security risks" : "Risks"} to flag: ${list(risks)}.`);
  }
  say(ANCHOR, `That's the ${roleName.toLowerCase()} update. We'll check back next cycle.`);
  return { title: `${roleName} Engineering Update - ${u.label}`, turns };
}

/** Render a script as plain readable text (for the written report's appendix or a script-only export). */
export function renderScript(s: PodcastScript): string {
  return [`# ${s.title}`, "", ...s.turns.map((t) => `**${t.speaker}:** ${t.text}`)].join("\n");
}
