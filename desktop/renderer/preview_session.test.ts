// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/preview_session.test.ts - P-PREVIEW.19. The reported bug was a new chat session opening
// the Preview panel on `/tmp/x.pdf`, a POSIX path on a Windows box for a file the user never opened, left
// over from a previous conversation. So the assertions that matter are: the agent lane is dropped at the
// boundary, and the user's own lane is NOT.

import { describe, expect, test } from "bun:test";
import { previewAfterNewSession, type PreviewLanes } from "./preview_session.ts";

const lanes = (over: Partial<PreviewLanes> = {}): PreviewLanes =>
  ({ yours: "", agent: "", lastPreviewable: "", ...over });

describe("previewAfterNewSession", () => {
  test("THE BUG: the stale agent target does not survive into the next conversation", () => {
    const { lanes: next, changed } = previewAfterNewSession(lanes({
      agent: "/tmp/x.pdf",
      lastPreviewable: "/tmp/x.pdf",
    }));
    expect(next.agent).toBe("");
    expect(next.lastPreviewable).toBe(""); // this is the field that re-opened the panel
    expect(changed).toBe(true);
  });

  test("the user's OWN tab is never closed, because it is not conversation-scoped", () => {
    // Someone reading a PDF they opened by hand, who then starts a new chat, keeps their PDF.
    const { lanes: next } = previewAfterNewSession(lanes({
      yours: "C:/Users/me/report.pdf",
      agent: "C:/tmp/generated.html",
      lastPreviewable: "C:/tmp/generated.html",
    }));
    expect(next.yours).toBe("C:/Users/me/report.pdf");
    expect(next.agent).toBe("");
  });

  test("an already-empty agent lane reports no change, so the caller skips the teardown", () => {
    const { changed } = previewAfterNewSession(lanes({ yours: "C:/mine.html" }));
    expect(changed).toBe(false);
  });

  test("lastPreviewable alone still counts as a change: it is what re-opens the panel", () => {
    // The lane can be empty while the remembered target is not, and that value alone is enough to make the
    // activity pill surface the panel. Missing this case would have left the reported bug half-fixed.
    const { changed, lanes: next } = previewAfterNewSession(lanes({ lastPreviewable: "/tmp/x.pdf" }));
    expect(changed).toBe(true);
    expect(next.lastPreviewable).toBe("");
  });

  test("a loaded agent lane with no remembered target still clears", () => {
    const { changed, lanes: next } = previewAfterNewSession(lanes({ agent: "C:/tmp/app.html" }));
    expect(changed).toBe(true);
    expect(next.agent).toBe("");
  });

  test("it never mutates the input, so a caller can compare before and after", () => {
    const prev = lanes({ yours: "a.html", agent: "b.html", lastPreviewable: "b.html" });
    const { lanes: next } = previewAfterNewSession(prev);
    expect(prev.agent).toBe("b.html");
    expect(prev.lastPreviewable).toBe("b.html");
    expect(next).not.toBe(prev);
  });

  test("clearing twice is stable, so a double newSession cannot resurrect anything", () => {
    const once = previewAfterNewSession(lanes({ yours: "mine.html", agent: "x.pdf", lastPreviewable: "x.pdf" }));
    const twice = previewAfterNewSession(once.lanes);
    expect(twice.changed).toBe(false);
    expect(twice.lanes).toEqual(once.lanes);
    expect(twice.lanes.yours).toBe("mine.html");
  });
});
