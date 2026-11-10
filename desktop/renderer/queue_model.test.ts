// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/queue_model.test.ts - P-INTERJECT.2: the staged-prompt queue's ordering rules.

import { describe, expect, test } from "bun:test";
import type { Attachment } from "./composer_attachments.ts";
import { addQueued, canSteer, editQueued, mainCheckoutCwd, nextHold, parallelPushNotice, parallelPushPrompt, parallelPushRefusal, pushLaneName, pushNowRoute, pushRecovery, type PushSource, type QueuedItem } from "./queue_model.ts";

const hold = (text: string): QueuedItem => ({ text, mode: "hold" });
const push = (text: string): QueuedItem => ({ text, mode: "push" });

describe("addQueued", () => {
  test("trims and appends; the input array is never mutated", () => {
    const items: QueuedItem[] = [];
    const r = addQueued(items, "  fix the tests  ", "hold");
    expect(r.ok).toBe(true);
    expect(r.items).toEqual([hold("fix the tests")]);
    expect(items).toEqual([]); // caller's array untouched
  });

  test("refuses empty and whitespace-only text", () => {
    for (const t of ["", "   ", "\n\t"]) {
      const r = addQueued([hold("a")], t, "hold");
      expect(r.ok).toBe(false);
      expect(r.reason).toBeDefined();
      expect(r.items).toEqual([hold("a")]); // unchanged
    }
  });

  test("refuses a duplicate of the LAST item only - an earlier repeat is allowed", () => {
    const dup = addQueued([hold("a"), hold("b")], "b", "hold");
    expect(dup.ok).toBe(false);
    expect(dup.items.length).toBe(2);
    const earlier = addQueued([hold("a"), hold("b")], "a", "hold");
    expect(earlier.ok).toBe(true);
    expect(earlier.items.length).toBe(3);
  });

  test("dedupe compares the TRIMMED text", () => {
    const r = addQueued([hold("same")], "  same  ", "push");
    expect(r.ok).toBe(false);
  });

  test("enforces the cap and reports why", () => {
    let items: QueuedItem[] = [];
    for (let i = 0; i < 8; i++) items = addQueued(items, `p${i}`, "hold").items;
    expect(items.length).toBe(8);
    const over = addQueued(items, "p8", "hold");
    expect(over.ok).toBe(false);
    expect(over.reason).toContain("full");
    expect(over.items.length).toBe(8);
    // a custom cap is respected
    const tiny = addQueued([hold("x")], "y", "hold", { cap: 1 });
    expect(tiny.ok).toBe(false);
  });
});

describe("nextHold", () => {
  test("returns the FIRST hold item and the queue without it, order preserved", () => {
    const items = [push("p1"), hold("h1"), hold("h2"), push("p2")];
    const r = nextHold(items);
    expect(r.item).toEqual(hold("h1"));
    expect(r.rest).toEqual([push("p1"), hold("h2"), push("p2")]);
  });

  test("hold ordering: repeated draining fires holds in staged order", () => {
    let items = [hold("first"), push("noise"), hold("second"), hold("third")];
    const fired: string[] = [];
    for (let r = nextHold(items); r.item; r = nextHold(items)) {
      fired.push(r.item.text);
      items = r.rest;
    }
    expect(fired).toEqual(["first", "second", "third"]);
    expect(items).toEqual([push("noise")]); // push records survive every drain
  });

  test("push items are NEVER returned - a push-only queue yields null and the same array", () => {
    const items = [push("a"), push("b")];
    const r = nextHold(items);
    expect(r.item).toBeNull();
    expect(r.rest).toBe(items);
  });

  test("empty queue yields null", () => {
    expect(nextHold([]).item).toBeNull();
  });
});

// ADR-0414: the old toast guessed ("the cap may be full, or the backend is unreachable") and the text was
// already gone from the composer and the stack. Each refusal now keeps the text somewhere and quotes the
// engine's reason.
describe("pushRecovery", () => {
  const idle = { draft: false, ownTurnOpen: false };
  test("the turn ended: sent as the next prompt, unless a draft or this composer's own settling stream is in the way", () => {
    expect(pushRecovery("idle", "the turn had already ended", idle).keep).toBe("send");
    expect(pushRecovery("idle", "the turn had already ended", { draft: true, ownTurnOpen: false }).keep).toBe("stage");
    expect(pushRecovery("idle", "the turn had already ended", { draft: false, ownTurnOpen: true }).keep).toBe("stage");
  });

  test("a full cap or no engine stages it for the next turn; a note needing the user goes back to the composer, never over a draft", () => {
    expect(pushRecovery("cap", "8 earlier notes are still waiting", idle).keep).toBe("stage");
    expect(pushRecovery("unreachable", "LUCID could not reach its engine", idle).keep).toBe("stage");
    expect(pushRecovery("unknown-target", "that session is no longer running", idle).keep).toBe("composer");
    expect(pushRecovery("too-long", "note too long (4001 chars; max 4000)", idle).keep).toBe("composer");
    expect(pushRecovery("too-long", "note too long (4001 chars; max 4000)", { draft: true, ownTurnOpen: false }).keep).toBe("stage");
  });

  test("the toast carries the engine's reason", () => {
    for (const code of ["idle", "cap", "unknown-target", "too-long", "unreachable"] as const) {
      expect(pushRecovery(code, "8 earlier notes are still waiting for the agent's next tool step", idle).desc).toContain("8 earlier notes are still waiting");
    }
  });
});

// P-QUEUE-IMG.1 (ADR-0469): images pasted with a staged prompt used to stay in the composer, so they went
// out with whichever prompt the composer sent next (the first drained hold, or the user's next message).
// Each staged item now owns its images.
const img = (id: string): Attachment => ({ id, dataUrl: `data:image/png;base64,${btoa(id)}`, mimeType: "image/png", bytes: id.length });

describe("staged prompt images", () => {
  test("images ride with the item they were staged with, not the next one in order", () => {
    const composer = [img("a1"), img("a2")];
    const a = addQueued([], "look at this", "hold", { atts: composer });
    expect(a.ok).toBe(true);
    const b = addQueued(a.items, "and then this", "hold", { atts: [img("b1")] });
    const c = addQueued(b.items, "text only", "hold");
    let q = c.items;
    const first = nextHold(q); q = first.rest;
    const second = nextHold(q); q = second.rest;
    const third = nextHold(q);
    expect(first.item?.atts?.map((x) => x.id)).toEqual(["a1", "a2"]);
    expect(second.item?.atts?.map((x) => x.id)).toEqual(["b1"]);
    expect(third.item?.atts ?? []).toEqual([]);
    // The item holds its own list: clearing the composer's array afterwards does not empty it.
    composer.length = 0;
    expect(first.item?.atts?.length).toBe(2);
  });

  test("an image-only prompt can be staged; the same words WITH images are not a double-Enter duplicate", () => {
    expect(addQueued([], "", "hold", { atts: [img("x")] }).ok).toBe(true);
    expect(addQueued([], "   ", "hold").ok).toBe(false);
    expect(addQueued([hold("same")], "same", "hold", { atts: [img("x")] }).ok).toBe(true);
    expect(addQueued([hold("same")], "same", "hold").ok).toBe(false);
  });

  test("Update hands back the text AND the images, and the rest of the stack without it", () => {
    const items: QueuedItem[] = [hold("one"), { text: "two", mode: "hold", atts: [img("t1"), img("t2")] }, hold("three")];
    const r = editQueued(items, 1, { text: "", atts: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.item.text).toBe("two");
    expect(r.item.atts?.map((x) => x.id)).toEqual(["t1", "t2"]);
    expect(r.rest.map((q) => q.text)).toEqual(["one", "three"]);
    expect(items.length).toBe(3); // never mutated
  });

  test("Update never overwrites a draft - text OR images - and never edits a mid-turn record", () => {
    const items: QueuedItem[] = [hold("one"), push("sent")];
    expect(editQueued(items, 0, { text: "typing", atts: 0 })).toEqual({ ok: false, code: "draft" });
    expect(editQueued(items, 0, { text: "  ", atts: 1 })).toEqual({ ok: false, code: "draft" });
    expect(editQueued(items, 1, { text: "", atts: 0 })).toEqual({ ok: false, code: "pushed" });
    expect(editQueued(items, 5, { text: "", atts: 0 })).toEqual({ ok: false, code: "gone" });
  });

  test("an edited prompt re-staged keeps its slot, with its new images; a vanished anchor appends", () => {
    const items: QueuedItem[] = [hold("one"), hold("two"), hold("three")];
    const r = editQueued(items, 1, { text: "", atts: 0 });
    if (!r.ok) throw new Error("unreachable");
    const back = addQueued(r.rest, "two, edited", "hold", { atts: [img("n1")], before: r.before });
    expect(back.items.map((q) => q.text)).toEqual(["one", "two, edited", "three"]);
    expect(back.items[1]!.atts?.map((x) => x.id)).toEqual(["n1"]);
    // "three" drained while the user was editing: the anchor is gone, so the edit goes to the end.
    const drained = r.rest.filter((q) => q.text !== "three");
    expect(addQueued(drained, "two, edited", "hold", { before: r.before }).items.map((q) => q.text)).toEqual(["one", "two, edited"]);
    // The last item had nothing after it: re-staging appends, which is the same slot.
    const last = editQueued(items, 2, { text: "", atts: 0 });
    if (!last.ok) throw new Error("unreachable");
    expect(last.before).toBeNull();
  });
});

// P-PUSH.PAR1 (ADR-pending): Push now no longer interjects the running turn (that is Steer running turn
// now). It runs the staged prompt in parallel in a NEW lane on its own git worktree; these pin the rules.
const laneSrc: PushSource = { kind: "lane", name: "api", cwd: "C:\\work\\repo\\desktop", model: "sonnet" };
const masterSrc: PushSource = { kind: "master", name: "main", cwd: "/home/u/repo", model: "opus" };

describe("parallel push: which folder", () => {
  test("a path outside any LUCID worktree is the main checkout already", () => {
    expect(mainCheckoutCwd("C:\\work\\repo")).toBe("C:\\work\\repo");
    expect(mainCheckoutCwd("/home/u/repo/src")).toBe("/home/u/repo/src");
    expect(mainCheckoutCwd("")).toBe("");
  });

  test("a lane in a LUCID worktree maps back to the repo it belongs to, subfolder kept, separators kept", () => {
    expect(mainCheckoutCwd("C:\\work\\repo.lucid-worktrees\\api-3f2a1b")).toBe("C:\\work\\repo");
    expect(mainCheckoutCwd("C:\\work\\repo.lucid-worktrees\\api-3f2a1b\\desktop\\renderer")).toBe("C:\\work\\repo\\desktop\\renderer");
    expect(mainCheckoutCwd("/home/u/repo.lucid-worktrees/main-push-1-aa11bb/src")).toBe("/home/u/repo/src");
  });

  test("never a worktree of a worktree: nested LUCID worktree paths unwind to the root repo", () => {
    expect(mainCheckoutCwd("/w/repo.lucid-worktrees/a-1.lucid-worktrees/b-2/x")).toBe("/w/repo/x");
  });

  test("a folder merely NAMED like the suffix, with nothing under it, is left alone", () => {
    expect(mainCheckoutCwd("/w/repo.lucid-worktrees")).toBe("/w/repo.lucid-worktrees");
    expect(mainCheckoutCwd("/w/.lucid-worktrees/x")).toBe("/w/.lucid-worktrees/x");
  });
});

describe("parallel push: lane naming", () => {
  test("<source>-push-<n>, the smallest n not taken (case-insensitive)", () => {
    expect(pushLaneName(laneSrc, [])).toBe("api-push-1");
    expect(pushLaneName(laneSrc, ["api", "API-push-1", "api-push-3"])).toBe("api-push-2");
  });

  test("the main composer pushes as main-push-<n>; a push lane does not stack suffixes", () => {
    expect(pushLaneName(masterSrc, ["main-push-1"])).toBe("main-push-2");
    expect(pushLaneName({ kind: "lane", name: "api-push-2" }, ["api-push-1", "api-push-2"])).toBe("api-push-3");
    expect(pushLaneName({ kind: "lane", name: "   " }, [])).toBe("lane-push-1");
  });
});

describe("parallel push: what the new agent and the user are told", () => {
  test("the preamble names the busy agent, its folder, the branch, and the hands-off rule; the prompt follows verbatim", () => {
    const text = "add a retry to the uploader\nwith backoff";
    const out = parallelPushPrompt(laneSrc, { branch: "lucid/api-push-1-ab12cd", path: "C:\\work\\repo.lucid-worktrees\\api-push-1-ab12cd" }, text);
    expect(out.endsWith(`\n\n${text}`)).toBe(true);
    expect(out).toContain(`lane "api"`);
    expect(out).toContain("still working on its own task in C:\\work\\repo\\desktop");
    expect(out).toContain("own git worktree");
    expect(out).toContain("branch lucid/api-push-1-ab12cd");
    expect(out).toContain("independently on your branch");
    expect(out).toContain("other agent's checkout");
    expect(parallelPushPrompt(masterSrc, { branch: "b" }, "x")).toContain("the main LUCID agent");
    expect(out).not.toContain("\u2014"); // house rule: no em dashes
  });

  test("the user hears it at once, then again with the branch; a not-busy source is never called busy", () => {
    const now = parallelPushNotice(laneSrc, "api-push-1", { busy: true });
    expect(now.desc).toBe("api is still working on its current task. Your request is being actioned in parallel by a new lane, api-push-1, in its own worktree.");
    const later = parallelPushNotice(masterSrc, "main-push-1", { busy: true, branch: "lucid/main-push-1-ff" });
    expect(later.title).toBe("Running in parallel: main-push-1");
    expect(later.desc).toBe("The main agent is still working on its current task. Your request is being actioned in parallel by a new lane, main-push-1, in its own worktree (branch lucid/main-push-1-ff).");
    expect(parallelPushNotice(laneSrc, "api-push-1", { busy: false }).desc).not.toContain("still working");
  });
});

describe("parallel push: routing and fallbacks", () => {
  test("idle is the old Send now; running with a folder goes parallel, images included", () => {
    expect(pushNowRoute({ running: false, cwd: "", images: 0 })).toEqual({ kind: "send" });
    expect(pushNowRoute({ running: true, cwd: "/repo", images: 0 })).toEqual({ kind: "parallel" });
    expect(pushNowRoute({ running: true, cwd: "/repo", images: 2 })).toEqual({ kind: "parallel" }); // the lane wire carries images
  });

  test("no workspace: a text prompt steers the running turn, an image prompt stays staged, both say why", () => {
    const steer = pushNowRoute({ running: true, cwd: "  ", images: 0 });
    expect(steer.kind).toBe("steer");
    if (steer.kind === "steer") expect(steer.desc).toContain("No workspace folder is open");
    const stage = pushNowRoute({ running: true, cwd: "", images: 1 });
    expect(stage.kind).toBe("stage");
    if (stage.kind === "stage") expect(stage.desc).toContain("cannot carry images");
  });

  test("a not-a-repo refusal steers where it can; every other refusal keeps the item staged with the engine's reason", () => {
    const noRepo = { code: "no-repo", reason: "\"C:\\x\" is not inside a git repository, so it cannot have its own worktree." };
    const s = parallelPushRefusal(noRepo, { canSteer: true, images: 0 });
    expect(s.kind).toBe("steer");
    expect(s.desc).toContain("not inside a git repository");
    expect(parallelPushRefusal(noRepo, { canSteer: false, images: 0 }).kind).toBe("stage"); // lane chips never steer on their own
    expect(parallelPushRefusal(noRepo, { canSteer: true, images: 3 }).kind).toBe("stage");
    const cpu = parallelPushRefusal({ reason: "system CPU has been at 93% for 34s" }, { canSteer: true, images: 0 });
    expect(cpu).toEqual({ kind: "stage", title: "Not pushed", desc: "System CPU has been at 93% for 34s. It stays staged and runs as the next turn." });
    expect(parallelPushRefusal({}, { canSteer: true, images: 0 }).desc).toContain("The engine did not answer.");
  });

  test("Steer running turn is offered only for a text-only next-turn item while a turn runs", () => {
    expect(canSteer({ hold: true, running: true, images: 0 })).toBe(true);
    expect(canSteer({ hold: true, running: false, images: 0 })).toBe(false);
    expect(canSteer({ hold: true, running: true, images: 1 })).toBe(false);
    expect(canSteer({ hold: false, running: true, images: 0 })).toBe(false);
  });
});
