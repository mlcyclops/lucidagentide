// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-VOICE.5 (ADR-0248): the "answer for the ear" guidance. The behaviour that matters is WHEN it applies -
// only hands-free conversation mode, never plain auto-speak (where the user is reading along) and never a
// silent turn - and that it constrains the reply's SHAPE without telling the agent to do less work.

import { expect, test } from "bun:test";
import { replyMedium, spokenReplyGuidance } from "./spoken_reply.ts";

test("only hands-free conversation mode changes how the agent answers", () => {
  expect(spokenReplyGuidance("screen")).toBeNull();
  expect(spokenReplyGuidance("narrated")).toBeNull(); // auto-speak alone: the user is watching it stream
  expect(spokenReplyGuidance("conversation")).not.toBeNull();
});

test("the medium follows the two toggles, and conversation never outranks a silent turn", () => {
  expect(replyMedium(false, false)).toBe("screen");
  expect(replyMedium(true, false)).toBe("narrated");
  expect(replyMedium(true, true)).toBe("conversation");
  // Defensive: a stale "conversation" flag with auto-speak OFF must not put the agent in eyes-off mode
  // while the reply is only being displayed.
  expect(replyMedium(false, true)).toBe("screen");
});

test("the block is a delimited, trusted element the transcript stripper can recognise", () => {
  const b = spokenReplyGuidance("conversation")!;
  expect(b.startsWith("<spoken-reply")).toBe(true);
  expect(b.trimEnd().endsWith("</spoken-reply>")).toBe(true);
  expect(b).toContain(`mode="conversation"`);
});

test("it bans exactly the shapes that are unlistenable, and says why it is doing it", () => {
  const b = spokenReplyGuidance("conversation")!.toLowerCase();
  for (const banned of ["heading", "list", "table", "emoji", "code block", "file path"]) {
    expect(b).toContain(banned);
  }
  expect(b).toContain("hands-free");
  expect(b).toMatch(/two or three short sentences|two-sentence/);
});

test("it constrains the ANSWER, never the work behind it", () => {
  // The failure mode of a naive \"be brief\" instruction is an agent that also stops investigating. The block
  // must say so explicitly, or short answers come at the cost of correctness.
  const b = spokenReplyGuidance("conversation")!;
  expect(b).toMatch(/thoroughly as usual|not the effort/i);
});

test("guidance is stable — the same mode always yields byte-identical text", () => {
  // It rides the user-turn tail on EVERY turn; text that wobbled would churn the model's context for nothing.
  expect(spokenReplyGuidance("conversation")).toBe(spokenReplyGuidance("conversation"));
});
