// harness/testing/echo.test.ts
//
// Golden-path replay test: a headless omp session driven by the no-network echo
// model completes a prompt with no API key and no network. Fast (<5s), the
// template for future deterministic harness tests.

import { test, expect } from "bun:test";
import { createEchoSession } from "./echo.ts";

test("echo session round-trips a prompt with no network", async () => {
  const { session, cleanup } = await createEchoSession();
  try {
    let out = "";
    session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        out += event.assistantMessageEvent.delta;
      }
    });

    const prompt = "ping";
    await session.prompt(prompt);
    expect(out).toContain(prompt);
    expect(out.startsWith("echo: ")).toBe(true);
  } finally {
    cleanup();
  }
}, 20_000);
