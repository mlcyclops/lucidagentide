// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0535): `bun plugins/herd/stage.ts <outDir>` writes exactly what the packer needs, and
// both bundles load. server.js holds no npm package (it runs under Electron's Node); client.js keeps
// its npm packages external (the IDE's own copies, through NODE_PATH).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePluginManifest } from "../../../harness/plugins/package.ts";
import { stageHerd } from "../stage.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
let out: string;

beforeAll(async () => {
  out = join(mkdtempSync(join(tmpdir(), "herd-stage-")), "stage");
  await stageHerd(out);
}, 60_000);
afterAll(() => rmSync(join(out, ".."), { recursive: true, force: true }));

describe("stage", () => {
  test("four files: server.js, client.js, the manifest without files, the license", () => {
    expect(readdirSync(out).sort()).toEqual(["LICENSE", "client.js", "lucid-plugin.json", "server.js"]);
    const m = JSON.parse(readFileSync(join(out, "lucid-plugin.json"), "utf8"));
    expect(m).toMatchObject({
      schema: 1, id: "herd", name: "Herd", version: "0.1.0", publisher: "TECHLEAD 187 LLC", tier: "free", section: "civilian", kind: "server",
      entry: { main: "server.js", healthPath: "/healthz" }, permissions: ["network:loopback", "fs:plugin-data"],
    });
    expect("files" in m).toBe(false);
    expect(validatePluginManifest(m, { requireFiles: false }).ok).toBe(true);
    expect(readFileSync(join(out, "LICENSE"), "utf8")).toContain("Business Source License 1.1");
  });

  test("server.js is CommonJS with no npm package; client.js imports pi-tui by name", () => {
    const server = readFileSync(join(out, "server.js"), "utf8");
    expect(server).not.toContain("@oh-my-pi/");
    expect(server).not.toMatch(/^import /m);
    expect(readFileSync(join(out, "client.js"), "utf8")).toContain("@oh-my-pi/pi-tui");
  });

  test("server.js loads and refuses to run outside the plugin runtime", () => {
    const r = Bun.spawnSync([process.execPath, join(out, "server.js")], {
      env: { ...process.env, PORT: "", LUCID_PLUGIN_DATA: "", LUCID_PLUGIN_ROOT: "" },
      stdout: "pipe", stderr: "pipe",
    });
    expect({ code: r.exitCode, stderr: r.stderr.toString() }).toMatchObject({ code: 2, stderr: expect.stringContaining("lucid herd") });
  });

  test("client.js loads against the IDE's node_modules and prints its help", () => {
    const r = Bun.spawnSync([process.execPath, join(out, "client.js"), "--help"], {
      env: { ...process.env, NODE_PATH: join(REPO, "node_modules"), LUCID_PLUGIN_DATA: join(out, "..", "data") },
      stdout: "pipe", stderr: "pipe",
    });
    expect({ code: r.exitCode, stderr: r.stderr.toString() }).toMatchObject({ code: 0 });
    expect(r.stdout.toString()).toContain("lucid herd server start|stop");
  });
});
