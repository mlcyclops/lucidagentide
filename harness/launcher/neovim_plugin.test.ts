// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/launcher/neovim_plugin.test.ts
//
// P-NVIM.1 (ADR-0150) — drives the Neovim plugin's PURE helper assertions (extensions/neovim/
// test/helpers_spec.lua) through a real headless `nvim -l`, so `bun test harness` covers the Lua
// logic wherever nvim is installed. Skipped (never failed) when nvim is absent — CI hosts without
// Neovim stay green; the demo (make demo-P-NVIM.1) runs the same spec.

import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pluginDir = join(repo, "extensions", "neovim");
const spec = join(pluginDir, "test", "helpers_spec.lua");

const hasNvim = spawnSync("nvim", ["--version"], { stdio: "ignore" }).status === 0;

test.if(hasNvim)("neovim plugin pure helpers pass headless nvim assertions", () => {
  expect(existsSync(spec)).toBe(true);
  const r = spawnSync(
    "nvim",
    ["--headless", "--clean", "--cmd", `set rtp^=${pluginDir}`, "-l", spec],
    { encoding: "utf8" },
  );
  // Exit 0 ⟺ all assertions passed (os.exit in the spec). `print` lands on stdout or stderr depending on
  // the headless routing, so check the combined stream for the OK marker.
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0) throw new Error(`headless nvim spec failed:\n${out}`);
  expect(out).toContain("LUCID_NVIM_OK");
});

test.if(!hasNvim)("neovim plugin helper test skipped (nvim not installed)", () => {
  expect(hasNvim).toBe(false);
});
