// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-IDE-SPOKES.1 (ADR-0506): the remote-spokes view model. What the orbit and the hub picker show for a spoke
// (state, lanes, model, tasks) from the hub plugin's summary, what a hub's certificate lets the IDE offer, and
// the plugin's two-click rule. ADR-0508: answer time, route, certificate region and classification, the spoke's
// models, and the Start-a-task selector's eligibility and order. ADR-0509: the spoke's machine and lane policy, the
// silent rule, alert lines and Resume.

import { describe, expect, test } from "bun:test";
import {
  ALERTS_MAX, approvalButtons, armClick, ARM_MS, clockLabel, deployChoices, hostLabel, hubActions, lanePolicyLabel, latencyLabel, mapHubSnapshot, mapSpokeRow, mibLabel,
  MODEL_LIST_MAX, modelCount, onOrbit, REMOTE_TONE, remoteGlance, RESUME_TEXT, spokeActions, spokeAlerts, spokeState, stateLabel, taskButtons, taskModelChoices,
  type RemoteApprovalView, type RemoteSpokeView, type RemoteTaskView,
} from "./remote_spokes_model.ts";

const NODE = `n_${"1".repeat(32)}`;
const HUB = `n_${"f".repeat(32)}`;
const task = (over: Record<string, unknown> = {}) => ({ id: "t_0123456789abcdef", name: "triage", state: "idle", turns: 3, updatedAt: 100, createdAt: 1, origin: HUB, ...over });
const caps = { maxLanes: 2, liveLanes: 1, freeLanes: 1, busyTasks: 1, models: { default: "azure-openai/gpt-5.1", signedIn: [], local: [] } };
/** ADR-0508's, ADR-0509's and ADR-0512's optional fields as an older hub plugin leaves them: every one unknown. */
const UNKNOWN = {
  latencyMs: null, via: null, region: null, classification: null, certExpires: null, engineVersion: null,
  host: null, lanePolicy: null, lastSeen: null, silentSince: null, alerts: [], deactivated: null,
};

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

describe("ADR-0508: answer time, route, certificate and models", () => {
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

describe("ADR-0508: the Start-a-task selector's rows", () => {
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

describe("ADR-0509: the spoke's machine, its lane policy, silence, alerts and Resume", () => {
  const host = {
    os: "linux", arch: "x64", cpus: 8, memMiB: 32_768, diskFreeMiB: 512_000,
    gpus: [{ name: "NVIDIA A10", vramMiB: 24_576 }, { name: "iGPU" }], localModel: { host: "127.0.0.1:11434", reachable: true },
  };
  const lanePolicy = { max: 4, limitedBy: "memory", why: "32 GiB fits 4 engines with room for the model" };
  /** Local wall-clock times on one day, so the clock labels do not depend on the test machine's time zone. */
  const at = (h: number, m: number) => new Date(2026, 10, 5, h, m).getTime();
  const NOW = at(14, 30);

  test("host and lane policy come through from capabilities; caps.maxLanes stays the lane count", () => {
    const v = mapSpokeRow({ node: NODE, label: "gpu-box", reachable: true, tasks: [], caps: { ...caps, maxLanes: 4, freeLanes: 3, host, lanePolicy }, lastSeen: 1_000 });
    expect(v?.host).toEqual({
      os: "linux", arch: "x64", cpus: 8, memMiB: 32_768, diskFreeMiB: 512_000,
      gpus: [{ name: "NVIDIA A10", vramMiB: 24_576 }, { name: "iGPU", vramMiB: null }], localModel: { host: "127.0.0.1:11434", reachable: true },
    });
    expect(v?.lanePolicy).toEqual(lanePolicy);
    expect(v?.lanes).toEqual({ live: 1, max: 4, free: 3 });
    expect([v?.lastSeen, v?.silentSince, v?.state]).toEqual([1_000, null, "idle"]);
    expect(hostLabel(v!.host)).toBe("8 CPUs \u00b7 32 GiB memory \u00b7 NVIDIA A10 24 GiB \u00b7 iGPU");
    expect(lanePolicyLabel(v!.lanePolicy!)).toBe("up to 4 lanes, limited by memory: 32 GiB fits 4 engines with room for the model");
    expect([mibLabel(512), mibLabel(15_872), mibLabel(1024)]).toEqual(["512 MiB", "15.5 GiB", "1 GiB"]);
    expect(hostLabel(null)).toBe("");
  });

  test("malformed host, policy, presence and alert fields read as unknown or are dropped, never coerced", () => {
    const v = mapSpokeRow({
      node: NODE, label: "x", reachable: true, tasks: [], lastSeen: -1, silentSince: "soon",
      caps: {
        host: { os: 7, cpus: 0, memMiB: 1.5, diskFreeMiB: -3, gpus: [{ vramMiB: 8 }, { name: "G".repeat(200), vramMiB: "big" }, "nope"], localModel: { host: "h", reachable: "yes" } },
        lanePolicy: { max: 0, limitedBy: "memory", why: "x" },
      },
      alerts: [
        { kind: "exploded", at: 5 }, { kind: "crashed" }, "nope",
        { kind: "crashed", at: 9, detail: "D".repeat(900), tasks: [{ id: "t_bad", name: "x" }, { id: "t_0123456789abcdef", name: "" }, { id: "t_0123456789abcdef", name: "ok" }] },
      ],
    });
    expect(v?.host).toEqual({ os: null, arch: null, cpus: null, memMiB: null, diskFreeMiB: null, gpus: [{ name: "G".repeat(64), vramMiB: null }], localModel: null });
    expect(v?.lanePolicy).toBeNull();
    expect(mapSpokeRow({ node: NODE, label: "x", caps: { lanePolicy: { max: 2, limitedBy: "vibes" } } })?.lanePolicy).toBeNull();
    expect(mapSpokeRow({ node: NODE, label: "x", caps: { lanePolicy: { max: 2, limitedBy: "target" } } })?.lanePolicy).toEqual({ max: 2, limitedBy: "target", why: null });
    expect([v?.lastSeen, v?.silentSince, v?.state]).toEqual([null, null, "idle"]);
    expect(v?.alerts).toEqual([{ kind: "crashed", at: 9, detail: "D".repeat(300), tasks: [{ id: "t_0123456789abcdef", name: "ok" }] }]);
    expect(mapSpokeRow({ node: NODE, label: "x", alerts: "nope", caps: { host: "linux" } })).toMatchObject({ alerts: [], host: null });
  });

  test("alerts are newest first and at most 20", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ kind: "engine-restarted", at: i + 1, detail: `n${i}` }));
    const v = mapSpokeRow({ node: NODE, label: "x", alerts: many });
    expect(v?.alerts).toHaveLength(ALERTS_MAX);
    expect([v?.alerts[0]?.at, v?.alerts.at(-1)?.at]).toEqual([30, 11]);
  });

  test("the silent rule: a spoke the hub reports silent reads 'silent since', never idle, and cannot take a task", () => {
    const since = at(14, 5);
    const v = mapSpokeRow({ node: NODE, label: "vm", reachable: true, tasks: [task()], caps, silentSince: since, lastSeen: since })!;
    expect(v.state).toBe("silent");
    expect(REMOTE_TONE[v.state]).toBe("stuck");
    expect(stateLabel(v, NOW)).toBe("silent since 14:05");
    expect(remoteGlance(v, NOW)).toBe("silent since 14:05 \u00b7 1/2 lanes");
    // the same row without silentSince is the plain idle spoke (an older plugin, or a spoke that polls)
    expect(mapSpokeRow({ node: NODE, label: "vm", reachable: true, tasks: [task()], caps, lastSeen: since })?.state).toBe("idle");
    // silence wins over whatever the spoke said last: it is stale
    for (const reachable of [true, false, null]) {
      expect(mapSpokeRow({ node: NODE, label: "vm", reachable, tasks: [task({ state: "working" })], silentSince: since })?.state).toBe("silent");
    }
    expect(mapSpokeRow({ node: NODE, label: "vm", silentSince: 0 })?.state).toBe("checking");
    expect(deployChoices([v], hubActions(["drive"]))[0]).toMatchObject({ eligible: false, why: "silent: it has not polled its relay for over 2 minutes" });
    // a silence from another day carries its date in front of the time
    const nextDay = clockLabel(since, NOW + 86_400_000);
    expect(nextDay).toEndWith(" 14:05");
    expect(nextDay.length).toBeGreaterThan("14:05".length);
  });

  test("alert lines: the silence first, then each kept alert; an interrupted turn names its tasks and where to resume", () => {
    const v = mapSpokeRow({
      node: NODE, label: "vm", silentSince: at(14, 5),
      alerts: [
        { kind: "crashed", at: at(14, 4), detail: "the engine exited with code 137." },
        { kind: "turn-interrupted", at: at(14, 6), detail: "", tasks: [{ id: "t_0123456789abcdef", name: "triage" }] },
      ],
    })!;
    expect(spokeAlerts(v, NOW).map((a) => [a.key, a.kind, a.text])).toEqual([
      [`${NODE}|silent|${at(14, 5)}`, "silent", "silent since 14:05: no word from it for 25 min while its relay answers"],
      [`${NODE}|turn-interrupted|${at(14, 6)}`, "turn-interrupted", "turn interrupted at 14:06 (triage). Resume it from the spoke's panel"],
      [`${NODE}|crashed|${at(14, 4)}`, "crashed", "crashed at 14:04: the engine exited with code 137"],
    ]);
    expect(spokeAlerts({ ...v, silentSince: null, alerts: [] }, NOW)).toEqual([]);
  });

  test("Resume sends exactly the contract text, and only a human click sends it", () => {
    expect(RESUME_TEXT).toBe("Continue this task. The previous turn was interrupted when the spoke restarted: check what was already done before you repeat anything.");
    // the first click only arms (the same two-click rule as Approve and Close)
    expect(armClick(null, 5).act).toBe("arm");
  });
});

describe("ADR-0510: a stale revocation list, an expiring certificate and a laptop's lane cap", () => {
  const at = (h: number, m: number) => new Date(2026, 10, 5, h, m).getTime();
  const NOW = at(14, 30);

  test("crl-stale and cert-expiring are kept alert kinds, each line says what to run", () => {
    const v = mapSpokeRow({
      node: NODE, label: "vm",
      alerts: [
        { kind: "crl-stale", at: at(9, 0), detail: "the revocation list v4 passed its next update 3 days ago." },
        { kind: "cert-expiring", at: at(10, 0), detail: "12 days left" },
      ],
    })!;
    expect(v.alerts.map((a) => a.kind)).toEqual(["cert-expiring", "crl-stale"]);
    expect(spokeAlerts(v, NOW).map((a) => [a.key, a.text])).toEqual([
      [`${NODE}|cert-expiring|${at(10, 0)}`, "certificate expiring at 10:00: 12 days left. Renew it (root renew, then hub renew-spoke)"],
      [`${NODE}|crl-stale|${at(9, 0)}`, "revocation list out of date at 09:00: the revocation list v4 passed its next update 3 days ago. Publish a fresh one from the root (root crl-refresh); until then the spoke refuses drive and approve"],
    ]);
  });

  test("limitedBy laptop is a known limit with its own words", () => {
    const why = "laptop: 2 lanes so the owner's own apps keep their memory";
    const p = mapSpokeRow({ node: NODE, label: "mac", caps: { lanePolicy: { max: 2, limitedBy: "laptop", why } } })?.lanePolicy;
    expect(p).toEqual({ max: 2, limitedBy: "laptop", why });
    expect(lanePolicyLabel(p!)).toBe(`up to 2 lanes, limited by a laptop: ${why}`);
  });
});

describe("mapHubSnapshot: the hub, its scopes and every spoke", () => {
  test("a set-up hub lists its spokes with the actions its certificate's scopes allow", () => {
    const v = mapHubSnapshot({ hub: { node: HUB, label: "workstation", scopes: ["recall", "drive", "root-ish"] }, spokes: [{ node: NODE, label: "vm-218", reachable: true, tasks: [] }, { node: "bad" }] });
    expect(v).toEqual({
      available: true, hub: { node: HUB, label: "workstation", scopes: ["recall", "drive"], presence: null },
      actions: { recall: true, drive: true, approve: false, deny: true },
      spokes: [{ node: NODE, label: "vm-218", state: "idle", lanes: null, tasks: [], checkedAt: null, ...UNKNOWN, models: { default: null, local: [], frontier: [] } }],
    });
  });

  test("the hub's presence kind is passed on only when it is a known one (ADR-0507: password asks the IDE)", () => {
    const kind = (presence: unknown) => {
      const v = mapHubSnapshot({ hub: { node: HUB, label: "workstation", scopes: ["approve"], presence }, spokes: [] });
      return v.available ? v.hub.presence : "unavailable";
    };
    expect(kind("password")).toBe("password");
    expect(kind("windows-hello")).toBe("windows-hello");
    expect(kind("none")).toBe("none");
    expect(kind("retina-scan")).toBeNull();
    expect(kind(undefined)).toBeNull();
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
    expect(taskButtons(t("idle"), a(["recall"]))).toEqual({ recall: true, followup: false, cancel: false, close: false, resume: false });
    expect(taskButtons(t("working"), a(["recall"]))).toEqual({ recall: true, followup: false, cancel: false, close: false, resume: false });
    expect(taskButtons({ ...t("idle"), interrupted: 5 }, a(["recall"])).resume).toBe(false);
  });

  test("drive: follow-up when the turn is over, cancel while it runs, close while it holds a lane", () => {
    const d = a(["recall", "drive"]);
    expect(taskButtons(t("idle"), d)).toEqual({ recall: true, followup: true, cancel: false, close: true, resume: false });
    expect(taskButtons(t("working"), d)).toEqual({ recall: true, followup: false, cancel: true, close: true, resume: false });
    expect(taskButtons(t("awaiting_approval"), d)).toEqual({ recall: true, followup: false, cancel: true, close: true, resume: false });
    expect(taskButtons(t("closed"), d)).toEqual({ recall: true, followup: false, cancel: false, close: false, resume: false });
    expect(taskButtons(t("stopped"), d)).toEqual({ recall: true, followup: false, cancel: false, close: false, resume: false });
  });

  test("ADR-0509: an interrupted task offers Resume only when a follow-up could land (drive, turn over, lane held)", () => {
    const d = a(["recall", "drive"]);
    const cut = (state: RemoteTaskView["state"]): RemoteTaskView => ({ ...t(state), interrupted: 1_700 });
    expect(taskButtons(cut("idle"), d)).toEqual({ recall: true, followup: true, cancel: false, close: true, resume: true });
    expect(taskButtons(cut("error"), d).resume).toBe(true);
    for (const state of ["working", "awaiting_approval", "closed", "stopped"] as const) expect(taskButtons(cut(state), d).resume).toBe(false);
    expect(taskButtons(cut("idle"), a(["recall", "approve"])).resume).toBe(false);
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
    expect(REMOTE_TONE).toEqual({ approval: "approval", error: "stuck", offline: "maybe", busy: "busy", idle: "ready", checking: "checking", silent: "stuck", deactivated: "off" });
    expect(spokeState(true, [])).toBe("idle");
  });

  test("two clicks inside 8 seconds act; a lone click only arms; a late second click arms again", () => {
    const first = armClick(null, 1_000);
    expect(first).toEqual({ act: "arm", armedAt: 1_000 });
    expect(armClick(first.armedAt, 1_000 + ARM_MS)).toEqual({ act: "go", armedAt: null });
    expect(armClick(first.armedAt, 1_001 + ARM_MS)).toEqual({ act: "arm", armedAt: 1_001 + ARM_MS });
  });
});

describe("ADR-0511: a model chosen per task", () => {
  test("the selector offers local models, then each signed-in provider's as provider/id, never the default", () => {
    const v = mapSpokeRow({
      node: NODE, label: "vm-218", reachable: true, tasks: [], caps: { ...caps, models: { default: "anthropic/claude-sonnet-4-5", signedIn: ["anthropic"], local: [] } },
      models: {
        providers: [
          { provider: "anthropic", name: "Anthropic", signedIn: true, accounts: [], models: ["claude-opus-4-1", "anthropic/claude-sonnet-4-5"] },
          { provider: "openai", name: "OpenAI", signedIn: false, accounts: [], models: ["gpt-5"] },
        ],
        local: { spark: ["qwen3-32b"] },
        default: "anthropic/claude-sonnet-4-5",
      },
    });
    expect(taskModelChoices(v!)).toEqual(["spark/qwen3-32b", "anthropic/claude-opus-4-1"]);
  });

  test("a spoke that reported only capabilities offers its local models; a provider without a list offers none", () => {
    const v = mapSpokeRow({ node: NODE, label: "x", reachable: true, tasks: [], caps: { ...caps, models: { default: "azure-openai/gpt-5.1", signedIn: ["anthropic"], local: ["ollama/llama3"] } } });
    expect(taskModelChoices(v!)).toEqual(["ollama/llama3"]);
    expect(taskModelChoices(mapSpokeRow({ node: NODE, label: "y" })!)).toEqual([]);
  });
});

describe("ADR-0512: a spoke deactivated on purpose", () => {
  const since = new Date(2026, 10, 5, 9, 30).getTime();
  const NOW = new Date(2026, 10, 9, 12, 0).getTime();
  const REASON = "shipped to Alex's site; back when Alex grants access";
  const row = { node: NODE, label: "dgx-spark (shared)", reachable: true, tasks: [task({ state: "working" })], caps, lastSeen: since, silentSince: since + 300_000,
    alerts: [{ kind: "crashed", at: since, detail: "the engine exited" }] };

  test("deactivated wins over silent, reads 'Deactivated since <date>: <reason>' in the dim tone and never alerts", () => {
    const v = mapSpokeRow({ ...row, deactivated: { since, reason: REASON } })!;
    expect([v.state, REMOTE_TONE[v.state], v.silentSince, v.deactivated]).toEqual(["deactivated", "off", null, { since, reason: REASON }]);
    expect(stateLabel(v, NOW)).toBe(`Deactivated since 2026-11-05: ${REASON}`);
    expect(remoteGlance(v, NOW)).toBe(`Deactivated since 2026-11-05: ${REASON}`);
    expect(spokeAlerts(v, NOW)).toEqual([]);
    // whatever the row also says, it wins: reachable or not, checking, silent
    for (const reachable of [true, false, null]) expect(mapSpokeRow({ ...row, reachable, deactivated: { since, reason: "x" } })?.state).toBe("deactivated");
    // a reason is clipped to 200 characters; a missing one still deactivates
    expect(mapSpokeRow({ node: NODE, label: "x", deactivated: { since, reason: "R".repeat(300) } })?.deactivated?.reason).toHaveLength(200);
    expect(mapSpokeRow({ node: NODE, label: "x", deactivated: { since } })?.deactivated).toEqual({ since, reason: "no reason given" });
  });

  test("it is never a target: not in the selector, and the panel offers no action at all", () => {
    const off = mapSpokeRow({ ...row, deactivated: { since, reason: REASON } })!;
    const on = mapSpokeRow({ node: `n_${"2".repeat(32)}`, label: "vm-217", reachable: true, tasks: [], caps })!;
    const all = hubActions(["recall", "drive", "approve"]);
    expect(deployChoices([off, on], all).map((c) => c.spoke.label)).toEqual(["vm-217"]);
    expect(deployChoices([off], all)).toEqual([]);
    expect(spokeActions(off, all)).toEqual({ recall: false, drive: false, approve: false, deny: false });
    expect(taskButtons(off.tasks[0]!, spokeActions(off, all))).toEqual({ recall: false, followup: false, cancel: false, close: false, resume: false });
    expect(spokeActions(on, all)).toBe(all);
  });

  test("reactivation (the mark gone) and an older plugin (no field, or a malformed one) behave exactly as before", () => {
    const back = mapSpokeRow(row)!;
    expect([back.state, back.deactivated, back.silentSince]).toEqual(["silent", null, since + 300_000]);
    expect(spokeAlerts(back, NOW).map((a) => a.kind)).toEqual(["silent", "crashed"]);
    for (const deactivated of [undefined, null, "yes", true, {}, { since: 0, reason: "x" }, { since: -5, reason: "x" }, { since: "2026-11-05", reason: "x" }]) {
      expect(mapSpokeRow({ ...row, deactivated })).toEqual(back);
    }
  });
});

describe("P-RS-VIEW.1 (ADR-0533): which remote spokes the Fleet Orbit draws", () => {
  const spoke = (tasks: Record<string, unknown>[], over: Record<string, unknown> = {}): RemoteSpokeView =>
    mapSpokeRow({ node: NODE, label: "vm-218", reachable: true, caps, tasks, ...over })!;

  test("a spoke is on the orbit while a task holds a lane on it, whatever that task is doing", () => {
    for (const state of ["working", "awaiting_approval", "idle", "error"]) expect(onOrbit(spoke([task({ state })]))).toBe(true);
    // One open task among finished ones is enough.
    expect(onOrbit(spoke([task({ state: "closed" }), task({ id: "t_fedcba9876543210", state: "idle" })]))).toBe(true);
  });

  test("an online idle machine, or one whose tasks all closed or stopped, is not", () => {
    expect(onOrbit(spoke([]))).toBe(false);
    expect(onOrbit(spoke([task({ state: "closed" }), task({ id: "t_fedcba9876543210", state: "stopped" })]))).toBe(false);
    expect(onOrbit(spoke([], { reachable: false }))).toBe(false);
  });

  test("silence keeps a spoke with open work on the orbit; deactivation takes any spoke off", () => {
    expect(onOrbit(spoke([task({ state: "working" })], { silentSince: 500 }))).toBe(true);
    expect(onOrbit(spoke([task({ state: "working" })], { deactivated: { since: 500, reason: "shipped" } }))).toBe(false);
  });
});
