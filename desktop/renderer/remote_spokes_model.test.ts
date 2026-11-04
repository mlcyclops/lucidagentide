// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-IDE-SPOKES.1 (ADR-0487): the remote-spokes view model. What the orbit and the hub picker show for a spoke
// (state, lanes, model, tasks) from the hub plugin's summary, what a hub's certificate lets the IDE offer, and
// the plugin's two-click rule.

import { describe, expect, test } from "bun:test";
import {
  approvalButtons, armClick, ARM_MS, hubActions, mapHubSnapshot, mapSpokeRow, REMOTE_TONE, remoteGlance, spokeState, taskButtons,
  type RemoteApprovalView, type RemoteTaskView,
} from "./remote_spokes_model.ts";

const NODE = `n_${"1".repeat(32)}`;
const HUB = `n_${"f".repeat(32)}`;
const task = (over: Record<string, unknown> = {}) => ({ id: "t_0123456789abcdef", name: "triage", state: "idle", turns: 3, updatedAt: 100, createdAt: 1, origin: HUB, ...over });
const caps = { maxLanes: 2, liveLanes: 1, freeLanes: 1, busyTasks: 1, models: { default: "azure-openai/gpt-5.1", signedIn: [], local: [] } };

describe("mapSpokeRow: one spoke as the orbit shows it", () => {
  test("label, lanes, model and tasks come from the spoke's own capabilities and status", () => {
    const v = mapSpokeRow({ node: NODE, label: "azure-eastus", checkedAt: 5, reachable: true, caps, tasks: [task({ state: "working", updatedAt: 200 }), task({ id: "t_fedcba9876543210", name: "old", updatedAt: 50 })] });
    expect(v).toEqual({
      node: NODE, label: "azure-eastus", state: "busy", lanes: { live: 1, max: 2, free: 1 }, model: "azure-openai/gpt-5.1", checkedAt: 5,
      tasks: [
        { id: "t_0123456789abcdef", name: "triage", state: "working", turns: 3, updatedAt: 200 },
        { id: "t_fedcba9876543210", name: "old", state: "idle", turns: 3, updatedAt: 50 },
      ],
    });
    expect(remoteGlance(v!)).toBe("online, busy \u00b7 1/2 lanes \u00b7 1 open");
  });

  test("online / idle / busy / parked-approval / offline / checking, by reachability and task states", () => {
    const at = (tasks: Record<string, unknown>[], reachable: boolean | null = true) => mapSpokeRow({ node: NODE, label: "x", checkedAt: 1, reachable, tasks })?.state;
    expect(at([task()])).toBe("idle");
    expect(at([])).toBe("idle");
    expect(at([task({ state: "closed" }), task({ id: "t_1111111111111111", state: "stopped" })])).toBe("idle");
    expect(at([task({ state: "working" })])).toBe("busy");
    expect(at([task({ state: "working" }), task({ id: "t_1111111111111111", state: "awaiting_approval", awaiting: "bash" })])).toBe("approval");
    expect(at([task({ state: "error" })])).toBe("error");
    expect(at([task()], false)).toBe("offline");
    expect(at([task()], null)).toBe("checking");
    // Reachable, but its status read was refused (no tasks at all): an error, never a quiet "idle".
    expect(mapSpokeRow({ node: NODE, label: "x", reachable: true, error: "this hub's certificate does not carry the recall scope" })).toMatchObject({ state: "error", error: "this hub's certificate does not carry the recall scope", tasks: [], lanes: null });
  });

  test("the closed-lane fields from the spoke's close op survive: review branch, restart interruption", () => {
    const v = mapSpokeRow({ node: NODE, label: "x", reachable: true, tasks: [task({ state: "closed", reviewBranch: "remote/lane-1a2b3c4d" }), task({ id: "t_2222222222222222", interrupted: 1700 })] });
    expect(v?.tasks).toContainEqual(expect.objectContaining({ state: "closed", reviewBranch: "remote/lane-1a2b3c4d" }));
    expect(v?.tasks).toContainEqual(expect.objectContaining({ id: "t_2222222222222222", interrupted: 1700 }));
  });

  test("spoke-written fields are validated and clipped: bad ids and unknown states are dropped, never coerced", () => {
    const v = mapSpokeRow({
      node: NODE, label: "L".repeat(500), reachable: true, caps: { maxLanes: "2", liveLanes: 1, freeLanes: 1, models: { default: 42 } },
      tasks: [task({ id: "t_bad" }), task({ state: "hacked" }), task({ name: "" }), task({ turns: -1 }), task({ name: "N".repeat(200) }), "nope"],
    });
    expect(v?.label).toHaveLength(64);
    expect(v?.lanes).toBeNull();
    expect(v?.model).toBeNull();
    expect(v?.tasks).toHaveLength(1);
    expect(v?.tasks[0]?.name).toHaveLength(48);
    expect(mapSpokeRow({ node: "n_short", label: "x" })).toBeNull();
    expect(mapSpokeRow(null)).toBeNull();
  });
});

describe("mapHubSnapshot: the hub, its scopes and every spoke", () => {
  test("a set-up hub lists its spokes with the actions its certificate's scopes allow", () => {
    const v = mapHubSnapshot({ hub: { node: HUB, label: "workstation", scopes: ["recall", "drive", "root-ish"] }, spokes: [{ node: NODE, label: "vm-218", reachable: true, tasks: [] }, { node: "bad" }] });
    expect(v).toEqual({
      available: true, hub: { node: HUB, label: "workstation", scopes: ["recall", "drive"] },
      actions: { recall: true, drive: true, approve: false, deny: true },
      spokes: [{ node: NODE, label: "vm-218", state: "idle", lanes: null, model: null, tasks: [], checkedAt: null }],
    });
  });

  test("no hub yet is the setup state, with the plugin's own error when the hub failed to open", () => {
    expect(mapHubSnapshot({ hub: null, spokes: [] })).toEqual({ available: false, plugin: "running", reason: "This hub is not set up yet. Finish setup in the Remote Spokes panel." });
    expect(mapHubSnapshot({ hub: null, error: "certificate expired", spokes: [] })).toMatchObject({ available: false, reason: "The Remote Spokes hub did not open: certificate expired" });
    expect(mapHubSnapshot("garbage")).toMatchObject({ available: false });
  });
});

describe("scope gating: the IDE offers only what the hub certificate allows", () => {
  const a = (scopes: string[]) => hubActions(scopes);
  const t = (state: RemoteTaskView["state"]): RemoteTaskView => ({ id: "t_0123456789abcdef", name: "x", state, turns: 1, updatedAt: 1 });

  test("recall only: read buttons, no drive, no approve, no deny", () => {
    expect(a(["recall"])).toEqual({ recall: true, drive: false, approve: false, deny: false });
    expect(taskButtons(t("idle"), a(["recall"]))).toEqual({ recall: true, followup: false, cancel: false, close: false });
    expect(taskButtons(t("working"), a(["recall"]))).toEqual({ recall: true, followup: false, cancel: false, close: false });
  });

  test("drive: follow-up when the turn is over, cancel while it runs, close while it holds a lane", () => {
    const d = a(["recall", "drive"]);
    expect(taskButtons(t("idle"), d)).toEqual({ recall: true, followup: true, cancel: false, close: true });
    expect(taskButtons(t("working"), d)).toEqual({ recall: true, followup: false, cancel: true, close: true });
    expect(taskButtons(t("awaiting_approval"), d)).toEqual({ recall: true, followup: false, cancel: true, close: true });
    expect(taskButtons(t("closed"), d)).toEqual({ recall: true, followup: false, cancel: false, close: false });
    expect(taskButtons(t("stopped"), d)).toEqual({ recall: true, followup: false, cancel: false, close: false });
  });

  test("parked actions: approve needs the approve scope and a scanner-clean action; deny needs drive or approve", () => {
    const ask: RemoteApprovalView = { task: "t_0123456789abcdef", name: "x", ask: { id: "a1", digest: "0".repeat(64), kind: "bash", title: "run", input: "ls", tier: "T2", reason: "", expiresAt: 0 } };
    expect(approvalButtons(ask, a(["recall"]))).toEqual({ approve: false, deny: false });
    expect(approvalButtons(ask, a(["recall", "drive"]))).toEqual({ approve: false, deny: true });
    expect(approvalButtons(ask, a(["recall", "approve"]))).toEqual({ approve: true, deny: true });
    expect(approvalButtons({ ...ask, quarantined: "quarantined: 1 finding(s)" }, a(["recall", "drive", "approve"]))).toEqual({ approve: false, deny: true });
  });
});

describe("display rules", () => {
  test("the shared hues: red stuck, amber might be stuck, cyan working, blue ready", () => {
    expect(REMOTE_TONE).toEqual({ approval: "approval", error: "stuck", offline: "maybe", busy: "busy", idle: "ready", checking: "checking" });
    expect(spokeState(true, [])).toBe("idle");
  });

  test("two clicks inside 8 seconds act; a lone click only arms; a late second click arms again", () => {
    const first = armClick(null, 1_000);
    expect(first).toEqual({ act: "arm", armedAt: 1_000 });
    expect(armClick(first.armedAt, 1_000 + ARM_MS)).toEqual({ act: "go", armedAt: null });
    expect(armClick(first.armedAt, 1_001 + ARM_MS)).toEqual({ act: "arm", armedAt: 1_001 + ARM_MS });
  });
});
