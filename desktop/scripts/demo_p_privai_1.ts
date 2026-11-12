// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-PRIVAI.1: the DGX Loader is now the Private AI Platform. A display rename only: the shipped renderer
// bundle carries the new name and none of the old one, while every identifier a saved setup or the wire
// contract depends on stays put (the enclave attestation regex, the Creator provider ids).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CREATOR_INTEGRATIONS, CREATOR_PROVIDER_IDS } from "../creator_registry.ts";

const desktop = join(import.meta.dir, "..");

const bundle = readFileSync(join(desktop, "renderer", "app.bundle.js"), "utf8");
assert.ok(bundle.includes("Import from the Private AI Platform"), "the renderer bundle must carry the new import label (rebuild it: build-renderer)");
assert.ok(!/DGX Loader/i.test(bundle), "the renderer bundle must not mention the DGX Loader");
console.log("ok  renderer bundle: new name present, old name absent");

const dev = readFileSync(join(desktop, "dev.ts"), "utf8");
assert.ok(dev.includes("/^dgx-loader\\b/i"), "dev.ts must keep the /^dgx-loader\\b/i enclave attestation regex");
console.log("ok  dev.ts keeps the /^dgx-loader\\b/i attestation regex");

for (const id of ["dgx-avatar", "dgx-cad", "dgx-vision"] as const) {
  assert.ok(CREATOR_PROVIDER_IDS.includes(id), `provider id ${id} must stay in the closed set`);
  assert.ok(CREATOR_INTEGRATIONS.some((s) => s.id === id), `provider id ${id} must keep its catalog entry`);
}
console.log("ok  creator registry keeps dgx-avatar, dgx-cad, dgx-vision");
console.log("demo-P-PRIVAI.1 OK");
