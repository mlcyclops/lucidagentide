// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/answer_sections.ts
//
// P-CHAT.A: the PURE keystone of the sectioned agent turn. On SETTLE (not during streaming - streaming
// stays a single live flow, unchanged), the finished answer markdown is split into collapsible sections
// on the model's OWN top-level headings (`#`..`###`) and horizontal `-` rules (the system prompt
// encourages `-` separators), so a long "wall" becomes skimmable, collapsible blocks. Fence-aware: a
// `#` inside a ``` code block is NOT a heading. PURE + DOM-free (the renderer maps sections to the
// existing collapsible `.col` primitive); this module is the tested logic the wiring depends on.

export interface AnswerSection {
  /** Heading text, or null for the pre-heading intro / an `hr`-delimited block. */
  title: string | null;
  /** Heading level 1..3, or 0 for a title-less block. */
  level: number;
  /** The section's markdown body (heading line excluded), trimmed. */
  body: string;
}

const HEADING = /^(#{1,3})\s+(.+?)\s*#*\s*$/; // ATX heading, 1-3 levels
const HR = /^(?:-{3,}|\u2500{3,}|\*{3,}|_{3,})\s*$/; // ---, box-draw rule, ***, ___
const FENCE = /^\s*(?:```|~~~)/;

/** Split finished answer markdown into ordered sections. A single section (no headings / rules) means
 *  "render as-is" - the caller should NOT wrap a trivial answer in an accordion (see `shouldSectionize`). */
export function sectionizeAnswer(md: string): AnswerSection[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: AnswerSection[] = [];
  let cur: AnswerSection = { title: null, level: 0, body: "" };
  let buf: string[] = [];
  let inFence = false;

  const flush = (): void => {
    const body = buf.join("\n").trim();
    if (body || cur.title) out.push({ ...cur, body });
    buf = [];
  };

  for (const line of lines) {
    if (FENCE.test(line)) { inFence = !inFence; buf.push(line); continue; }
    if (inFence) { buf.push(line); continue; }

    const h = HEADING.exec(line);
    if (h) { flush(); cur = { title: h[2]!.trim(), level: h[1]!.length, body: "" }; continue; }
    if (HR.test(line)) { flush(); cur = { title: null, level: 0, body: "" }; continue; }
    buf.push(line);
  }
  flush();
  return out;
}

/** True when the answer has real structure worth an accordion (more than one non-empty section, at least
 *  one of which is a heading). A single blob stays rendered inline - trivial answers are never sectioned. */
export function shouldSectionize(sections: readonly AnswerSection[]): boolean {
  return sections.length > 1 && sections.some((s) => s.title !== null);
}
