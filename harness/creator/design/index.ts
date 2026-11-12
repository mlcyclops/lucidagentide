// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/index.ts - one import for the pure Design engine (contract section 1).
//
// Everything re-exported here is DOM-free, fs-free, and node-free: safe for the renderer main thread, Web
// Workers, the Bun server, and tests. Server code that needs only validation may import doc.ts,
// svg_check.ts, sniff.ts, and agent_view.ts directly to keep its module graph small.

export * from "./types.ts";
export * from "./limits.ts";
export * from "./util.ts";
export * from "./color.ts";
export * from "./doc.ts";
export * from "./anim.ts";
export * from "./agent_view.ts";
export * from "./tiles.ts";
export * from "./blend.ts";
export * from "./mask.ts";
export * from "./resample.ts";
export * from "./path.ts";
export * from "./fit.ts";
export * from "./freehand.ts";
export * from "./trace.ts";
export * from "./svg_import.ts";
export * from "./svg_export.ts";
export * from "./svg_check.ts";
export * from "./gif.ts";
export * from "./apng.ts";
export * from "./png_stream.ts";
export * from "./psd.ts";
export * from "./sniff.ts";
