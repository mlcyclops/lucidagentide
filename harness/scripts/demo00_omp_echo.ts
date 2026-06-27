// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo00_omp_echo.ts
//
// Increment 0, part 1/3: headless omp round-trip through the no-network echo
// model. Proves we can drive the omp SDK programmatically with zero API keys.

import { createEchoSession } from "../testing/echo.ts";

const { session, cleanup } = await createEchoSession();

let out = "";
session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    out += event.assistantMessageEvent.delta;
  }
});

const prompt = "hello omp, please echo this back";
console.log(`> prompt: ${prompt}`);
await session.prompt(prompt);
console.log(`< reply : ${out.trim()}`);

cleanup();

if (!out.includes(prompt)) {
  console.error("FAIL: echo model did not return the prompt text");
  process.exit(1);
}
console.log("demo00_omp_echo OK");
process.exit(0);
