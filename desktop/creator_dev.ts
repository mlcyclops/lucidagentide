// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Creator browser-development entry. The native build bakes the same flavor into dist/main.js.
process.env.LUCID_BUILD_FLAVOR = "creator";
await import("./dev.ts");
