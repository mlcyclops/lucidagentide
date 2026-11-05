// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-IDE-SPOKES.1 (ADR-0487): the remote-spokes view model. What the orbit and the hub picker show for a spoke
// (state, lanes, model, tasks) from the hub plugin's summary, what a hub's certificate lets the IDE offer, and
// the plugin's two-click rule. ADR-0489: answer time, route, certificate region and classification, the spoke's
// models, and the Start-a-task selector's eligibility and order.

import { describe, expect, test } from "bun:test";
import {
  approvalButtons, armClick, ARM_MS, deployChoices, hubActions, latencyLabel, mapHubSnapshot, mapSpokeRow, MODEL_LIST_MAX, modelCount, REMOTE_TONE, remoteGlance, spokeState, taskButtons,
  type RemoteApprovalView, type RemoteSpokeView, type RemoteTaskView,
} from "./remote_spokes_model.ts";

const NODE = `n_${"1".repeat(32)}`;
const HUB = `n_${"f".repeat(32)}`;
const task = (over: Record<string, unknown> = {}) => ({ id: "t_0123456789abcdef", name: "triage", state: "idle", turns: 3, updatedAt: 100, createdAt: 1, origin: HUB, ...over });
const caps = { maxLanes: 2, liveLanes: 1, freeLanes: 1, busyTasks: 1, models: { default: "azure-openai/gpt-5.1", signedIn: [], local: [] } };
/** ADR-0489's optional fields as an older hub plugin leaves them: every one unknown. */
const UNKNOWN = { latencyMs: null, via: null, region: null, classification: null, certExpires: null, engineVersion: null };

describe("mapSpokeRow: one spoke as the orbit shows it", () => {
  test("label, lanes, model and tasks come from the spoke's own capabilities and status", () => {
    const v = mapSpokeRow({ node: NODE, label: "azure-eastus", checkedAt: 5, reachable: true, caps, tasks: [task({ state: "working", updatedAt: 200 }), task({ id: "t_fedcba9876543210", name: "old", updatedAt: 50 })] });
    expect(v).toEqual({
      node: NODE, label: "azure-eastus", state: "busy", lanes: { live: 1, max: 2, free: 1 }, checkedAt: 5, ...UNKNOWN,
      models: { default: "azure-openai/gpt-5.1", local: [], frontier: [] },
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
    expect(v?.models.default).toBeNull();
    expect(v?.tasks).toHaveLength(1);
    expect(v?.tasks[0]?.name).toHaveLength(48);
    expect(mapSpokeRow({ node: "n_short", label: "x" })).toBeNull();
    expect(mapSpokeRow(null)).toBeNull();
  });
});

describe("ADR-0489: answer time, route, certificate and models", () => {
  const models = {
    providers: [
      { provider: "anthropic", name: "Anthropic", signedIn: true, accounts: [{ label: "ops@contoso", expires: 1 }], models: ["anthropic/claude-sonnet-4-5", "anthropic/claude-opus-4-1"] },
      { provider: "openai", name: "OpenAI", signedIn: false, accounts: [], models: ["openai/gpt-5"] },
    ],
    local: { spark: ["glm-5.3-flash", "spark/qwen3-32b"] },
    default: "anthropic/claude-sonnet-4-5",
    open: [],
  };

  test("a newer plugin's row: latency, LAN route, certificate region and classification, engine version and models", () => {
    const v = mapSpokeRow({
      node: NODE, label: "vm-218", reachable: true, tasks: [], caps: { ...caps, engineVersion: "0.9.4" },
      latencyMs: 1432, via: { kind: "lan", host: "10.0.0.5:8787" }, cert: { region: "eastus", classification: "cui", expires: 1_800_000_000_000 }, models,
    });
    expect(v).toMatchObject({ latencyMs: 1432, via: "lan", region: "eastus", classification: "cui", certExpires: 1_800_000_000_000, engineVersion: "0.9.4" });
    // Only signed-in providers; local models carry their provider; the default is capabilities' (the fresher answer).
    expect(v?.models).toEqual({
      default: "azure-openai/gpt-5.1",
      local: ["spark/glm-5.3-flash", "spark/qwen3-32b"],
      frontier: [{ provider: "anthropic", name: "Anthropic", account: "ops@contoso", models: ["anthropic/claude-sonnet-4-5", "anthropic/claude-opus-4-1"] }],
    });
    expect(modelCount(v!)).toBe(5);
    expect(remoteGlance(v!)).toBe("online, idle \u00b7 1/2 lanes \u00b7 1.4 s LAN");
    // Without a capabilities answer the models answer's default stands.
    expect(mapSpokeRow({ node: NODE, label: "x", models })?.models.default).toBe("anthropic/claude-sonnet-4-5");
    expect(mapSpokeRow({ node: NODE, label: "x", reachable: true, tasks: [], latencyMs: 2000, via: { kind: "relay", host: "relay.example:443" } })?.via).toBe("relay");
  });

  test("malformed fields read as unknown or empty, never a crash and never coerced", () => {
    const v = mapSpokeRow({
      node: NODE, label: "x", reachable: true, tasks: [], latencyMs: -5, via: { kind: "satellite" }, cert: { region: 7, classification: "top-secret", expires: "soon" },
      caps: { engineVersion: {} },
      models: {
        default: "bad id with spaces",
        local: ["<script>", "ok/model", 5, "ok/model"],
        providers: [
          { provider: "x\" onerror=1", signedIn: true, models: ["a/b"] },
          { provider: "truthy", signedIn: "yes", models: ["a/b"] },
          { provider: "good", signedIn: true, accounts: "nope", models: "nope" },
          "not a record",
        ],
      },
    });
    expect(v).toMatchObject(UNKNOWN);
    expect(v?.models).toEqual({ default: null, local: ["ok/model"], frontier: [{ provider: "good", name: "good", account: null, models: [] }] });
    expect(mapSpokeRow({ node: NODE, label: "x", latencyMs: 1.5, via: "lan", cert: "root", models: "garbage" })).toMatchObject({ ...UNKNOWN, models: { default: null, local: [], frontier: [] } });
    // Lists are clipped: hundreds of ids stay within the cap.
    const many = Array.from({ length: 500 }, (_, i) => `m/${i}`);
    expect(mapSpokeRow({ node: NODE, label: "x", models: { providers: [{ provider: "p", signedIn: true, models: many }], local: { p: many } } })?.models).toMatchObject({
      local: many.slice(0, MODEL_LIST_MAX).map((m) => `p/${m}`),
      frontier: [{ models: many.slice(0, MODEL_LIST_MAX) }],
    });
    expect(mapSpokeRow({ node: NODE, label: "x", models: { local: { p: many } } })?.models.local).toHaveLength(MODEL_LIST_MAX);
  });

  test("an older plugin (no new fields, no models answer): models come from capabilities, the glance is unchanged", () => {
    const v = mapSpokeRow({ node: NODE, label: "x", reachable: true, tasks: [], caps: { ...caps, models: { default: "azure-openai/gpt-5.1", signedIn: ["anthropic", "bad id!"], local: ["ollama/llama3"] } } });
    expect(v).toMatchObject(UNKNOWN);
    expect(v?.models).toEqual({ default: "azure-openai/gpt-5.1", local: ["ollama/llama3"], frontier: [{ provider: "anthropic", name: "anthropic", account: null, models: [] }] });
    expect(modelCount(v!)).toBe(2);
    expect(remoteGlance(v!)).toBe("online, idle \u00b7 1/2 lanes");
  });

  test("latencyLabel says how fast the spoke answers, never a ping", () => {
    expect(latencyLabel(1432)).toBe("answers in 1.4 s");
    expect(latencyLabel(400)).toBe("answers in 0.4 s");
    expect(latencyLabel(12_600)).toBe("answers in 13 s");
    expect(latencyLabel(null)).toBe("answer time not measured yet");
  });
});

describe("ADR-0489: the Start-a-task selector's rows", () => {
  const drive = hubActions(["recall", "drive"]);
  const spoke = (label: string, over: Partial<RemoteSpokeView> = {}): RemoteSpokeView => ({
    node: NODE, label, state: "idle", lanes: { live: 0, max: 2, free: 2 }, tasks: [], checkedAt: 1, ...UNKNOWN, models: { default: null, local: [], frontier: [] }, ...over,
  });
  const spokes = [
    spoke("slow", { latencyMs: 3000 }),
    spoke("unmeasured"),
    spoke("full", { latencyMs: 100, lanes: { live: 2, max: 2, free: 0 } }),
    spoke("fast", { latencyMs: 1200 }),
    spoke("new", { state: "checking" }),
    spoke("gone", { state: "offline", lanes: null }),
    spoke("revoked", { state: "offline", lanes: null, error: "this hub no longer accepts the spoke's certificate: certificate revoked" }),
    spoke("alpha"),
    spoke("no-lanes", { latencyMs: 2000, lanes: null }),
    spoke("parked", { latencyMs: 2500, state: "approval", lanes: { live: 1, max: 2, free: 1 } }),
  ];

  test("eligible first, then fastest answer (unmeasured last), then label; each ineligible row says why", () => {
    expect(deployChoices(spokes, drive).map((c) => [c.spoke.label, c.eligible, c.why])).toEqual([
      ["fast", true, null],
      ["no-lanes", true, null],
      ["parked", true, null],
      ["slow", true, null],
      ["alpha", true, null],
      ["unmeasured", true, null],
      ["full", false, "no free lane: close an idle task on it to free one"],
      ["gone", false, "offline"],
      ["new", false, "still checking"],
      ["revoked", false, "offline: this hub no longer accepts the spoke's certificate: certificate revoked"],
    ]);
  });

  test("a hub without the drive scope can start nothing, and every row says so", () => {
    const rows = deployChoices(spokes, hubActions(["recall", "approve"]));
    expect(rows).toHaveLength(spokes.length);
    expect(rows.every((c) => !c.eligible && c.why === "this hub cannot start tasks (no drive scope)")).toBe(true);
    expect(rows.map((c) => c.spoke.label).slice(0, 2)).toEqual(["full", "fast"]);
    expect(deployChoices([], drive)).toEqual([]);
  });
});

describe("mapHubSnapshot: the hub, its scopes and every spoke", () => {
  test("a set-up hub lists its spokes with the actions its certificate's scopes allow", () => {
    const v = mapHubSnapshot({ hub: { node: HUB, label: "workstation", scopes: ["recall", "drive", "root-ish"] }, spokes: [{ node: NODE, label: "vm-218", reachable: true, tasks: [] }, { node: "bad" }] });
    expect(v).toEqual({
      available: true, hub: { node: HUB, label: "workstation", scopes: ["recall", "drive"] },
      actions: { recall: true, drive: true, approve: false, deny: true },
      spokes: [{ node: NODE, label: "vm-218", state: "idle", lanes: null, tasks: [], checkedAt: null, ...UNKNOWN, models: { default: null, local: [], frontier: [] } }],
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
