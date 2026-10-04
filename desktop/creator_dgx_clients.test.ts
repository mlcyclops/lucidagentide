// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { DgxAvatarClient, buildAvatarSpec, parseAvatarJob } from "./creator_dgx_avatar.ts";
import { DgxCadClient, buildCadModelRequest, checkInspectName, modelRunBody, parseCadModelResult } from "./creator_dgx_cad.ts";

const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
interface Seen { url: string; init?: RequestInit }

describe("dgx-avatar client (contract 2a)", () => {
  test("a render spec is validated fail-closed and trimmed to the contract fields", () => {
    expect(buildAvatarSpec({ engine: "wav2lip", templatePath: "t.mp4" })).toEqual({ ok: false, error: "engine must be musetalk or echomimic." });
    expect(buildAvatarSpec({ engine: "musetalk", templatePath: " " }).ok).toBe(false);
    expect(buildAvatarSpec({ engine: "musetalk", templatePath: "a\nb.mp4" }).ok).toBe(false);
    expect(buildAvatarSpec({ engine: "musetalk", templatePath: "t.mp4", tuning: { steps: "20" } }).ok).toBe(false);
    const r = buildAvatarSpec({ engine: "echomimic", templatePath: "~/avatar/templates/host.mp4", tuning: { steps: 20, guidanceScale: 2.5, junk: 1 }, compose: { title: " Q3 ", captionText: "", other: "x" } });
    expect(r).toEqual({ ok: true, spec: { engine: "echomimic", templatePath: "~/avatar/templates/host.mp4", tuning: { steps: 20, guidanceScale: 2.5 }, compose: { title: "Q3" } } });
  });

  test("submit is multipart with an `audio` WAV and a JSON `spec`, and a 409 says the queue is full", async () => {
    const seen: Seen[] = [];
    const ok = new DgxAvatarClient({ baseUrl: "http://127.0.0.1:8088/", fetchImpl: async (url, init) => { seen.push({ url, init }); return jsonRes({ jobId: "j-1" }); } });
    const spec = { engine: "musetalk" as const, templatePath: "t.mp4" };
    expect(await ok.submit(new Uint8Array([82, 73, 70, 70]), spec)).toEqual({ ok: true, data: { jobId: "j-1" } });
    expect(seen[0]!.url).toBe("http://127.0.0.1:8088/v1/jobs");
    expect(seen[0]!.init!.method).toBe("POST");
    const form = seen[0]!.init!.body as FormData;
    expect(form.get("spec")).toBe(JSON.stringify(spec));
    expect((form.get("audio") as Blob).type).toBe("audio/wav");
    const busy = new DgxAvatarClient({ baseUrl: "http://127.0.0.1:8088", fetchImpl: async () => jsonRes({ error: "queue full" }, 409) });
    const r = await busy.submit(new Uint8Array([1]), spec);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(409); expect(r.error).toContain("queue is full"); }
  });

  test("a dead box is a result, never a throw", async () => {
    const c = new DgxAvatarClient({ baseUrl: "http://127.0.0.1:8088", fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
    expect((await c.health()).ok).toBe(false);
    expect((await c.job("j")).ok).toBe(false);
    expect((await c.video("j", "composed")).ok).toBe(false);
  });

  test("job status is shape-checked and remote text is bounded", () => {
    expect(parseAvatarJob({ id: "j", state: "exploded" })).toBeNull();
    const j = parseAvatarJob({ id: "j", state: "failed", stage: "render", message: "m", error: "x".repeat(5000), outputs: { avatar: true } });
    expect(j!.error!.length).toBe(300);
    expect(j!.outputs).toEqual({ avatar: true, composed: false });
  });

  test("the job id is URL-encoded into the path and the variant is fixed", async () => {
    const seen: string[] = [];
    const c = new DgxAvatarClient({ baseUrl: "http://127.0.0.1:8088", fetchImpl: async (url) => { seen.push(url); return new Response(new Uint8Array([0, 0, 0, 24])); } });
    const v = await c.video("../x", "avatar");
    expect(seen[0]).toBe("http://127.0.0.1:8088/v1/jobs/..%2Fx/video?variant=avatar");
    expect(v.ok && v.data.mime).toBe("video/mp4");
  });
});

describe("dgx-cad client (contract 2c)", () => {
  test("inspect names are bare files with a known extension", () => {
    expect(checkInspectName("plan.DXF")).toEqual({ ok: true, name: "plan.DXF" });
    for (const n of ["../plan.dxf", "C:\\plan.dxf", "plan.pdf", "", "plan"]) expect(checkInspectName(n).ok).toBe(false);
  });

  test("a model request needs a script and known outputs; the timeout is capped at 120 s", () => {
    expect(buildCadModelRequest({ script: "", outputs: ["step"] }).ok).toBe(false);
    expect(buildCadModelRequest({ script: "result = 1", outputs: [] }).ok).toBe(false);
    expect(buildCadModelRequest({ script: "result = 1", outputs: ["obj"] }).ok).toBe(false);
    expect(buildCadModelRequest({ script: "result = 1", outputs: ["step"], timeoutSec: 121 }).ok).toBe(false);
    expect(buildCadModelRequest({ script: "result = 1", outputs: ["step", "stl", "step"], timeoutSec: 30.9 }))
      .toEqual({ ok: true, request: { script: "result = 1", outputs: ["step", "stl"], timeoutSec: 30 } });
  });

  test("the run body carries approved:true only as the approval literal, and is posted as JSON", async () => {
    const seen: Seen[] = [];
    const c = new DgxCadClient({ baseUrl: "http://127.0.0.1:8089", fetchImpl: async (url, init) => { seen.push({ url, init }); return jsonRes({ ok: true, artifacts: [{ id: "a".repeat(32), name: "part.step", kind: "step", bytes: 10 }, { id: "../../etc", name: "x", kind: "step" }], log: "ok" }); } });
    const built = buildCadModelRequest({ script: "result = 1", outputs: ["step"] });
    if (!built.ok) throw new Error(built.error);
    const r = await c.modelRun(modelRunBody(built.request, true));
    expect(seen[0]!.url).toBe("http://127.0.0.1:8089/v1/model/run");
    expect(JSON.parse(String(seen[0]!.init!.body))).toEqual({ script: "result = 1", outputs: ["step"], timeoutSec: 60, approved: true });
    expect(r.ok && r.data.artifacts.map((a) => a.id)).toEqual(["a".repeat(32)]); // a non-hex id is dropped, never fetched
  });

  test("a service refusal surfaces its own error, bounded", async () => {
    const c = new DgxCadClient({ baseUrl: "http://127.0.0.1:8089", fetchImpl: async () => jsonRes({ error: "refusing without approved: true" }, 403) });
    const r = await c.modelRun(modelRunBody({ script: "result = 1", outputs: ["svg"], timeoutSec: 5 }, true));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("refusing without approved");
    expect(parseCadModelResult({ artifacts: [] })).toBeNull();
  });

  test("an inspect over the cap or with a path name never leaves the machine", async () => {
    let calls = 0;
    const c = new DgxCadClient({ baseUrl: "http://127.0.0.1:8089", fetchImpl: async () => { calls += 1; return jsonRes({ kind: "dxf" }); } });
    expect((await c.inspect("../a.dxf", new Uint8Array([1]))).ok).toBe(false);
    expect((await c.inspect("a.dxf", new Uint8Array())).ok).toBe(false);
    expect(calls).toBe(0);
    const ok = await c.inspect("a.dxf", new Uint8Array([48]));
    expect(ok.ok && ok.data.kind).toBe("dxf");
    const odd = new DgxCadClient({ baseUrl: "http://127.0.0.1:8089", fetchImpl: async () => jsonRes({ kind: "pdf" }) });
    expect((await odd.inspect("a.dxf", new Uint8Array([48]))).ok).toBe(false);
  });

  test("artifact ids must be 32 hex and the download keeps a bare file name", async () => {
    const c = new DgxCadClient({ baseUrl: "http://127.0.0.1:8089", fetchImpl: async () => new Response(new Uint8Array([1, 2]), { headers: { "content-type": "model/stl; charset=binary", "content-disposition": "attachment; filename=\"../../evil.stl\"" } }) });
    expect((await c.artifact("not-an-id")).ok).toBe(false);
    const r = await c.artifact("0123456789abcdef0123456789abcdef");
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.data.mime).toBe("model/stl"); expect(r.data.filename).toBe("0123456789abcdef0123456789abcdef.bin"); }
  });
});
