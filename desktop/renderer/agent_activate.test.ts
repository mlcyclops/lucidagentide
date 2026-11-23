// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-RAIL.AGENTS1: the Agents rail's Activate decisions. Take over never drops Main's work: an idle Main hands its
// session to a lane, a busy one asks first, "After this turn" runs once when the turn ends, and every failure
// says what happened in the engine's own words.

import { describe, expect, test } from "bun:test";
import {
  folderKey, folderName, handoffFailure, handoffToast, pendingCopy, planTakeover, reasonText, sameFolder, startFailure,
  STOP_FAILED, switchFailure, takeoverQueue, takeoverSheetCopy, worldMissing, type MainView,
} from "./agent_activate.ts";

const main = (o: Partial<MainView> = {}): MainView => ({ folder: "C:\\code\\api", busy: false, sessionId: "s1", hasWork: true, prompt: "", ...o });
const ALL_COPY = (): string[] => [
  STOP_FAILED, startFailure("x"), worldMissing("lane"), switchFailure("web", true), handoffFailure("api", "web", "x"),
  ...Object.values(handoffToast("api", "web", "lane", false, "x")), ...Object.values(pendingCopy("web")), ...Object.values(takeoverSheetCopy("api", "web")),
];

describe("folders", () => {
  test("the same folder matches across separators, a trailing separator and drive-letter case", () => {
    expect(sameFolder("C:\\code\\api\\", "c:/code/api")).toBe(true);
    expect(sameFolder("/home/me/api/", "/home/me/api")).toBe(true);
    expect(sameFolder("/home/me/api", "/home/me/API")).toBe(false); // POSIX paths keep their case
    expect(sameFolder("C:\\code\\api", "C:\\code\\api-gateway")).toBe(false);
    expect(sameFolder(null, "C:\\code\\api")).toBe(false);
    expect(sameFolder("", "")).toBe(false);
  });

  test("a drive root and the POSIX root keep their separator", () => {
    expect(folderKey("C:\\")).toBe("c:/");
    expect(folderKey("/")).toBe("/");
  });

  test("the folder's name is its last segment", () => {
    expect(folderName("C:\\code\\api-gateway\\")).toBe("api-gateway");
    expect(folderName("/home/me/web")).toBe("web");
    expect(folderName("/")).toBe("/");
  });
});

describe("planTakeover", () => {
  test("idle Main already on the folder: just focus the composer", () => {
    expect(planTakeover(main(), "c:/code/api/", null)).toEqual({ kind: "steps", steps: ["focus"] });
  });

  test("busy Main already on the folder is this Agent's composer too: focus, never ask", () => {
    expect(planTakeover(main({ busy: true, prompt: "fix it" }), "C:\\code\\api", null)).toEqual({ kind: "steps", steps: ["focus"] });
  });

  test("idle Main elsewhere: switch Main first, then a lane resumes its old session, then focus", () => {
    expect(planTakeover(main(), "C:\\code\\web", null)).toEqual({ kind: "steps", steps: ["switch-main", "spawn-lane", "focus"] });
  });

  test("idle Main with nothing to keep (fresh chat or no session) just switches", () => {
    expect(planTakeover(main({ hasWork: false }), "C:\\code\\web", null)).toEqual({ kind: "steps", steps: ["switch-main", "focus"] });
    expect(planTakeover(main({ sessionId: null }), "C:\\code\\web", null)).toEqual({ kind: "steps", steps: ["switch-main", "focus"] });
  });

  test("busy Main elsewhere asks before anything happens", () => {
    expect(planTakeover(main({ busy: true, prompt: "fix it" }), "C:\\code\\web", null)).toEqual({ kind: "ask" });
  });

  test("Move it now: stop, switch, resume in a lane, stage the interrupted prompt there, focus", () => {
    expect(planTakeover(main({ busy: true, prompt: "fix it" }), "C:\\code\\web", "now"))
      .toEqual({ kind: "steps", steps: ["stop-main", "switch-main", "spawn-lane", "stage-prompt", "focus"] });
  });

  test("Move it now with no known prompt still moves the session, and stages nothing", () => {
    expect(planTakeover(main({ busy: true, prompt: "  " }), "C:\\code\\web", "now"))
      .toEqual({ kind: "steps", steps: ["stop-main", "switch-main", "spawn-lane", "focus"] });
  });

  test("Move it now keeps a running session even when the thread looked empty", () => {
    expect(planTakeover(main({ busy: true, hasWork: false, prompt: "go" }), "C:\\code\\web", "now"))
      .toEqual({ kind: "steps", steps: ["stop-main", "switch-main", "spawn-lane", "stage-prompt", "focus"] });
  });

  test("After this turn queues; Stay here changes nothing", () => {
    expect(planTakeover(main({ busy: true }), "C:\\code\\web", "after")).toEqual({ kind: "queue" });
    expect(planTakeover(main({ busy: true }), "C:\\code\\web", "stay")).toEqual({ kind: "none" });
  });

  test("the confirm's answer is ignored once Main is idle (the turn ended while it was open)", () => {
    expect(planTakeover(main(), "C:\\code\\web", "now")).toEqual({ kind: "steps", steps: ["switch-main", "spawn-lane", "focus"] });
  });
});

describe("takeoverQueue", () => {
  test("a queued handoff runs once, when Main's turn has ended and Main is idle", () => {
    const q = takeoverQueue<{ folder: string }>();
    expect(q.queue({ folder: "web" })).toBeNull();
    expect(q.onTurnEnd(true)).toBeNull(); // a held prompt started the next turn: wait for that one too
    expect(q.pending()).toEqual({ folder: "web" });
    // re-planned on done with Main idle: the handoff steps follow
    const job = q.onTurnEnd(false);
    expect(job).toEqual({ folder: "web" });
    expect(planTakeover(main(), "C:\\code\\" + job!.folder, null)).toEqual({ kind: "steps", steps: ["switch-main", "spawn-lane", "focus"] });
    expect(q.onTurnEnd(false)).toBeNull(); // the done hook and the backstop check never run it twice
    expect(q.pending()).toBeNull();
  });

  test("cancel drops it; a newer handoff replaces the older one and hands it back", () => {
    const q = takeoverQueue<string>();
    q.queue("web");
    expect(q.queue("docs")).toBe("web");
    expect(q.cancel()).toBe("docs");
    expect(q.onTurnEnd(false)).toBeNull();
    expect(q.cancel()).toBeNull();
  });
});

describe("wording", () => {
  test("a refused spawn shows the engine's reason verbatim, once punctuated", () => {
    expect(startFailure("system CPU has been at 93% for 34s.")).toBe("The agent could not start: system CPU has been at 93% for 34s.");
    expect(startFailure("folder not found")).toBe("The agent could not start: folder not found.");
  });

  test("no reason (no answer at all) still says something true", () => {
    expect(startFailure(undefined)).toBe("The agent could not start: the engine did not answer.");
    expect(reasonText("   ")).toBe("the engine did not answer");
  });

  test("a lane that failed after Main switched says the session is safe", () => {
    expect(handoffFailure("api", "web", "pressure admission")).toBe("Main now works in web, but your session from api could not start in a Fleet lane: pressure admission. It is safe in Sessions history.");
  });

  test("Main that could not switch says it kept its session, and where a stopped prompt went", () => {
    expect(switchFailure("web", false)).toBe("Main could not open web, so it stayed where it was with its session.");
    expect(switchFailure("web", true)).toBe("Main could not open web, so it stayed where it was with its session. The stopped prompt is back in the composer.");
  });

  test("the handoff toast names the lane; an unstaged prompt is said, not dropped", () => {
    expect(handoffToast("api", "web", "Fix login", true)).toEqual({ title: "Main is on web", desc: "Your work on api continues in Fleet lane Fix login." });
    expect(handoffToast("api", "web", "Fix login", false, "queue full").desc).toContain("The interrupted prompt was not staged there (queue full)");
  });

  test("no copy carries an em dash", () => {
    for (const s of ALL_COPY()) expect(s.includes("\u2014")).toBe(false);
  });
});
