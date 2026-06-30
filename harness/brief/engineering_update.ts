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

function section(title: string, items: UpdateItem[], emptyNote: string): string[] {
  const out = [`## ${title}`, ""];
  if (!items.length) { out.push(`_${emptyNote}_`, ""); return out; }
  for (const it of items) out.push(`- **${it.title}** ${it.detail ? `- ${it.detail}` : ""} _(${it.source})_`.replace(/\s+-\s+$/, ""));
  out.push("");
  return out;
}

/** Render the written Executive Engineering Update (deterministic markdown). */
export function renderEngineeringBrief(u: EngineeringUpdate): string {
  const out: string[] = [];
  out.push(`# Executive Engineering Update - ${u.label}`, "");
  out.push(
    `> ${u.recentlyShipped.length} shipped · ${u.loadBearingDependencies.length} load-bearing dependencies · ` +
    `${u.techDebt.length} tech-debt items · ${u.upcomingDecisions.length} upcoming decisions · ${u.risks.length} risks`,
    "",
  );
  out.push(...section("Recently shipped", u.recentlyShipped, "Nothing recorded."));
  out.push(...section("Load-bearing dependencies", u.loadBearingDependencies, "No cross-increment dependencies recorded."));
  out.push(...section("Tech debt", u.techDebt, "No deferred/stubbed work recorded. 🎉"));
  out.push(...section("Upcoming decisions", u.upcomingDecisions, "No open decisions recorded."));
  out.push(...section("Risks", u.risks, "No risks recorded."));
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

/** Build a NotebookLM-style two-host dialogue from the update - the TTS-ready input a PodcastBackend
 *  consumes. Deterministic; reads like a briefing, leads with what shipped, lands on the decisions. */
export function buildPodcastScript(u: EngineeringUpdate): PodcastScript {
  const turns: PodcastTurn[] = [];
  const say = (speaker: string, text: string) => turns.push({ speaker, text });
  const list = (items: UpdateItem[], max = 4) => items.slice(0, max).map((i) => i.title).join("; ");

  say(ANCHOR, `Welcome to the Executive Engineering Update for ${u.label}. I'm here with our engineering lead to walk through where things stand.`);
  if (u.recentlyShipped.length) {
    say(ANALYST, `The headline is what shipped: ${list(u.recentlyShipped)}.`);
    say(ANCHOR, `Good momentum. What's holding the weight underneath all that?`);
  } else {
    say(ANALYST, `Quiet cycle on shipping, so let's focus on what's load-bearing and what's coming.`);
  }
  if (u.loadBearingDependencies.length) {
    say(ANALYST, `On load-bearing dependencies: ${list(u.loadBearingDependencies)}. If any of those move, the work stacked on them moves with it.`);
  } else {
    say(ANALYST, `No tightly-coupled cross-dependencies recorded this cycle, which keeps our options open.`);
  }
  if (u.techDebt.length) {
    say(ANCHOR, `Let's be honest about the debt.`);
    say(ANALYST, `Tech debt we're carrying forward: ${list(u.techDebt)}. None of it is on fire, but it's the interest we'll pay later.`);
  }
  if (u.upcomingDecisions.length) {
    say(ANCHOR, `So what needs a decision?`);
    say(ANALYST, `The open calls are: ${list(u.upcomingDecisions, 5)}. Those are the forks where leadership input changes the next increment.`);
  }
  if (u.risks.length) {
    say(ANCHOR, `Anything that should worry us?`);
    say(ANALYST, `Risks from the latest automated run: ${list(u.risks)}.`);
  }
  say(ANCHOR, `That's the update - shipped work is landing, the dependencies are mapped, and the decisions are queued. We'll check back next cycle.`);
  return { title: `Executive Engineering Update - ${u.label}`, turns };
}

/** Render a script as plain readable text (for the written report's appendix or a script-only export). */
export function renderScript(s: PodcastScript): string {
  return [`# ${s.title}`, "", ...s.turns.map((t) => `**${t.speaker}:** ${t.text}`)].join("\n");
}
