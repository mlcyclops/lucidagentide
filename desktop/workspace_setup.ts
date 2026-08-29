// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/workspace_setup.ts
//
// P-WSSETUP: the workspace-initialization offer. Pure filesystem module (NO settings imports):
// profileWorkspace() answers "what kind of folder is this?" from ONE top-level readdir (plus a
// bounded one-level peek into src/lib/app), and scaffoldAgentsFramework() lays down the .agents
// framework - a portable, plain-markdown context layer (AGENTS.md + .agents/{CONTEXT,PROGRESS,
// DECISIONS,skills/SOURCES}.md) that any agent on any machine, and any future developer, can
// inherit instead of starting cold. Creation is TOCTOU-safe: every file is written with the "wx"
// flag, so nothing existing is ever overwritten (EEXIST is reported as skipped).

import { mkdirSync, readdirSync, readFileSync, writeFileSync, type Dirent } from "node:fs";
import { extname, join } from "node:path";

export type WorkspacePurpose = "app" | "docs" | "analysis" | "other";

export interface WorkspaceProfile {
  path: string;
  isGit: boolean;
  isEmpty: boolean;
  hasAgentsFramework: boolean;
  hasCode: boolean;
  stack: string[];
  fileCount: number;
}

export interface AgentsInitResult { ok: boolean; created: string[]; skipped: string[]; error?: string }

// OS droppings that must not make a folder count as "in use".
const JUNK = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java", ".cs", ".rb", ".php", ".c", ".cpp", ".h"]);
// Frameworks surfaced from package.json dependencies/devDependencies, in stable output order.
const NODE_FRAMEWORKS = ["react", "next", "vue", "svelte", "express", "electron", "fastify"];

function readPackageJson(path: string): { deps: Record<string, unknown>; scripts: Record<string, unknown> } | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const o = parsed as Record<string, unknown>;
    const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
    return { deps: { ...rec(o.dependencies), ...rec(o.devDependencies) }, scripts: rec(o.scripts) };
  } catch {
    return null; // missing or malformed manifest: not fatal, just no node insight
  }
}

export function profileWorkspace(path: string): WorkspaceProfile {
  let entries: Dirent[];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    // Unreadable directory: report it as empty-ish rather than crashing the caller.
    return { path, isGit: false, isEmpty: true, hasAgentsFramework: false, hasCode: false, stack: [], fileCount: 0 };
  }
  const meaningful = entries.filter((e) => !JUNK.has(e.name));
  const names = new Set(meaningful.map((e) => e.name));
  const isGit = meaningful.some((e) => e.name === ".git");
  const hasAgentsFramework = meaningful.some((e) => (e.name === "AGENTS.md" && e.isFile()) || (e.name === ".agents" && e.isDirectory()));

  // Stack detection from top-level manifests, in a FIXED order so `stack` is stable.
  const stack: string[] = [];
  const add = (s: string): void => { if (!stack.includes(s)) stack.push(s); };
  if (names.has("package.json")) {
    add("node");
    const pkg = readPackageJson(path);
    if (pkg) for (const fw of NODE_FRAMEWORKS) if (fw in pkg.deps) add(fw);
  }
  if (names.has("pyproject.toml") || names.has("requirements.txt") || names.has("setup.py")) add("python");
  if (names.has("Cargo.toml")) add("rust");
  if (names.has("go.mod")) add("go");
  if (names.has("pom.xml") || names.has("build.gradle") || names.has("build.gradle.kts")) add("jvm");
  if (meaningful.some((e) => e.isFile() && (e.name.endsWith(".csproj") || e.name.endsWith(".sln")))) add("dotnet");
  if (names.has("Gemfile")) add("ruby");
  if (names.has("composer.json")) add("php");

  let hasCode = stack.length > 0;
  if (!hasCode) {
    // No manifest: peek ONE level into conventional source dirs (bounded to 200 entries each).
    for (const dir of ["src", "lib", "app"]) {
      if (!meaningful.some((e) => e.name === dir && e.isDirectory())) continue;
      try {
        const inner = readdirSync(join(path, dir), { withFileTypes: true }).slice(0, 200);
        if (inner.some((e) => e.isFile() && CODE_EXT.has(extname(e.name).toLowerCase()))) { hasCode = true; break; }
      } catch { /* unreadable subdir: ignore */ }
    }
  }

  return { path, isGit, isEmpty: meaningful.length === 0, hasAgentsFramework, hasCode, stack, fileCount: meaningful.length };
}

// ── generated content ─────────────────────────────────────────────────────────────────────────

const PURPOSE_LINE: Record<WorkspacePurpose, string> = {
  app: "build an application",
  docs: "analyze and organize documents",
  analysis: "research and data analysis",
  other: "general work",
};

const INTRO: Record<WorkspacePurpose, string> = {
  app: "This workspace builds an application. The code is the primary artifact: keep it runnable, prefer small verifiable changes, and leave the build in a working state at the end of every session.",
  docs: "This workspace analyzes and organizes documents. Treat source documents as read-only inputs, keep derived notes and summaries clearly separated from them, and record where each conclusion came from.",
  analysis: "This workspace is for research and data analysis. Keep raw data immutable, make every transformation reproducible from the files in this folder, and write findings down as you go.",
  other: "This workspace is a general working folder. Keep its purpose and current state written down here so any agent or person can pick the work up cold.",
};

function agentsMd(path: string, purpose: WorkspacePurpose, scan: boolean): string {
  let md = `# AGENTS.md

${INTRO[purpose]}

## How agents work here

Any agent working in this folder, LUCID or any other tool, follows the same loop:

- Read \`.agents/CONTEXT.md\` before starting work.
- When ending a session, append a short entry to \`.agents/PROGRESS.md\`: what shipped, what is next.
- Record non-obvious choices in \`.agents/DECISIONS.md\`.
- Save reusable skills, prompts, and procedures under \`.agents/skills/\`.

This keeps context portable: any agent on any machine, and any future developer, inherits the project's record instead of starting cold.
`;
  if (scan) {
    const p = profileWorkspace(path);
    if (p.stack.length) {
      md += `\n## Detected stack\n\n${p.stack.map((s) => `- ${s}`).join("\n")}\n`;
    }
    const pkg = readPackageJson(path);
    const scripts = pkg ? Object.keys(pkg.scripts) : [];
    if (scripts.length) {
      md += `\n## Commands\n\n${scripts.map((s) => `- \`npm run ${s}\``).join("\n")}\n`;
    }
  }
  return md;
}

function readmeMd(): string {
  return `# The .agents framework

This folder is the project's portable memory for AI agents and for the people who work with them. Agents record what they know (CONTEXT.md), what they did (PROGRESS.md), why they chose what they chose (DECISIONS.md), and reusable procedures (skills/) as plain markdown files.

Because everything lives inside the workspace as text, the record travels with the project: across agents, across machines, and across time. A new agent or a new developer reads these files and starts with the project's accumulated context instead of starting cold.

Keep entries short and current. A stale record is worse than a sparse one.
`;
}

function contextMd(purpose: WorkspacePurpose, date: string): string {
  return `# Context

Purpose: ${PURPOSE_LINE[purpose]}. Initialized ${date}.

## Current focus

Replace this line with what is being worked on right now, and keep it current so the next agent starts oriented.
`;
}

function progressMd(date: string): string {
  return `# Progress

- ${date}: workspace initialized. Next: fill in the current focus in CONTEXT.md.
`;
}

function decisionsMd(purpose: WorkspacePurpose, date: string): string {
  return `# Decisions

## ADR-0001: workspace initialized with the .agents framework

Date: ${date}
Purpose: ${PURPOSE_LINE[purpose]}

The .agents framework was set up so agents and developers share one portable record of context, progress, decisions, and skills inside the workspace itself.
`;
}

function sourcesMd(): string {
  return `# Skill sources

Provenance for every skill saved under .agents/skills/: where it came from and how much to trust it.

| skill | origin | trust | added |
| --- | --- | --- | --- |
`;
}

/** Lay down the .agents framework. NEVER overwrites: each file is created with the "wx" flag,
 *  and an already-existing file is reported in `skipped` (the TOCTOU-safe pattern - no
 *  exists-then-write race). Paths in the result are workspace-relative. */
export function scaffoldAgentsFramework(path: string, opts: { purpose: WorkspacePurpose; scan: boolean }): AgentsInitResult {
  const created: string[] = [];
  const skipped: string[] = [];
  try {
    mkdirSync(join(path, ".agents", "skills"), { recursive: true });
  } catch (e) {
    return { ok: false, created, skipped, error: e instanceof Error ? e.message : String(e) };
  }
  const date = new Date().toISOString().slice(0, 10);
  const files: [string, string][] = [
    ["AGENTS.md", agentsMd(path, opts.purpose, opts.scan)],
    [".agents/README.md", readmeMd()],
    [".agents/CONTEXT.md", contextMd(opts.purpose, date)],
    [".agents/PROGRESS.md", progressMd(date)],
    [".agents/DECISIONS.md", decisionsMd(opts.purpose, date)],
    [".agents/skills/SOURCES.md", sourcesMd()],
  ];
  let error: string | undefined;
  for (const [rel, content] of files) {
    try {
      writeFileSync(join(path, ...rel.split("/")), content, { flag: "wx" });
      created.push(rel);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") skipped.push(rel);
      else error = error ?? `${rel}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return error ? { ok: false, created, skipped, error } : { ok: true, created, skipped };
}
