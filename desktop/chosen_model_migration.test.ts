// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Cloud-only default (fix/v2.5.1-provider-default-models): the explicit-choice marker on chosenModel and
// its read-time migration. A pick made through setChosenModel is explicit (local or cloud) and survives
// relaunch; a LOCAL value stored before the marker existed is treated as not explicit and never restored.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chosenModel, load, save, setChosenModel } from "./settings_store.ts";

const dirs: string[] = [];
const prevEnv = process.env.LUCID_GUI_SETTINGS_FILE;
function scratch(): void {
  const dir = mkdtempSync(join(tmpdir(), "lucid-chosen-"));
  dirs.push(dir);
  process.env.LUCID_GUI_SETTINGS_FILE = join(dir, "lucid-gui.json");
}
afterEach(() => {
  if (prevEnv === undefined) delete process.env.LUCID_GUI_SETTINGS_FILE;
  else process.env.LUCID_GUI_SETTINGS_FILE = prevEnv;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// The fields isLocalModel reads; the rest of a real LocalProviderDef is irrelevant here.
const DGX = { id: "dgx", name: "DGX", ompProvider: "dgx-spark", baseUrl: "http://10.0.0.5:8000/v1", api: "openai-completions", authKind: "none", models: [], enabled: true } as never;

describe("chosenModel explicit-choice marker", () => {
  test("an explicit LOCAL pick is remembered and honored", () => {
    scratch();
    setChosenModel("ollama/llama3.1:8b");
    expect(load().chosenModelSource).toBe("user");
    expect(chosenModel()).toBe("ollama/llama3.1:8b");
  });
  test("an explicit pick of a configured Local Provider model is honored", () => {
    scratch();
    save({ localProviders: [DGX] });
    setChosenModel("dgx-spark/glm-5.3-flash");
    expect(chosenModel()).toBe("dgx-spark/glm-5.3-flash");
  });
  test("MIGRATION: a legacy local value without the marker is NOT honored after upgrade", () => {
    scratch();
    save({ chosenModel: "ollama/nomic-embed-text:latest" });
    expect(chosenModel()).toBe("");
    save({ chosenModel: "dgx-spark/glm-5.3-flash", localProviders: [DGX] });
    expect(chosenModel()).toBe("");
    // read-time only: the stored value is untouched
    expect(load().chosenModel).toBe("dgx-spark/glm-5.3-flash");
  });
  test("a legacy CLOUD value without the marker is still honored (it can only be a cloud default)", () => {
    scratch();
    save({ chosenModel: "anthropic/claude-opus-5-5" });
    expect(chosenModel()).toBe("anthropic/claude-opus-5-5");
  });
  test("clearing removes the value and the marker", () => {
    scratch();
    setChosenModel("ollama/llama3.1:8b");
    setChosenModel("");
    expect(load().chosenModel).toBeUndefined();
    expect(load().chosenModelSource).toBeUndefined();
  });
});
