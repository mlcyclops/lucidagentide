// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { expect, test } from "bun:test";
import { StepTextJoiner } from "./step_text.ts";

/** Feed a scripted turn: strings are text chunks, null is a tool call. */
function joined(j: StepTextJoiner, steps: (string | null)[]): string {
  let out = "";
  for (const s of steps) if (s === null) j.tool(); else out += j.text(s);
  return out;
}

test("text resumed after a tool call starts a new paragraph, chunks within a message stay joined", () => {
  const j = new StepTextJoiner();
  expect(joined(j, ["Evaluating the ", "surfaces.", null, null, "Running the ", "server.", null, "Done."]))
    .toBe("Evaluating the surfaces.\n\nRunning the server.\n\nDone.");
});

test("a turn that opens with a tool call gets no leading break; one already on a new line gets no extra", () => {
  const j = new StepTextJoiner();
  expect(joined(j, [null, "First.", null, "\nSecond."])).toBe("First.\nSecond.");
});

test("reset starts a fresh turn: a tool call at the end of the last turn never separates the next", () => {
  const j = new StepTextJoiner();
  joined(j, ["Old answer.", null]);
  j.reset();
  expect(joined(j, ["New answer."])).toBe("New answer.");
});
