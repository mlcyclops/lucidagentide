// harness/tools/result_adapter.test.ts
//
// The frozen boundary (ADR-0003): omp AgentToolResult <-> PRD ToolResult.

import { test, expect } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolResult } from "../contracts.ts";
import { fromOmpResult, toOmpResult } from "./result_adapter.ts";

test("PRD -> omp -> PRD preserves the load-bearing fields", () => {
  const prd: ToolResult = {
    tool_name: "read",
    success: true,
    summary: "hello\nworld",
    payload: { lines: 2 },
    duration_ms: 7,
  };
  const back = fromOmpResult(prd.tool_name, toOmpResult(prd), prd.duration_ms);
  expect(back.tool_name).toBe(prd.tool_name);
  expect(back.success).toBe(prd.success);
  expect(back.summary).toBe(prd.summary);
  expect(back.duration_ms).toBe(prd.duration_ms);
});

test("omp -> PRD -> omp preserves text content and isError", () => {
  const omp: AgentToolResult = {
    content: [{ type: "text", text: "boom" }],
    isError: true,
  };
  const out = toOmpResult(fromOmpResult("bash", omp, 5));
  const text = out.content.find((c) => c.type === "text");
  expect(text && "text" in text ? text.text : undefined).toBe("boom");
  expect(out.isError).toBe(true);
});

test("omp isError absent means success true on the PRD side", () => {
  const omp: AgentToolResult = { content: [{ type: "text", text: "ok" }] };
  expect(fromOmpResult("read", omp, 1).success).toBe(true);
});

test("multiple text parts are joined with newlines in summary", () => {
  const omp: AgentToolResult = {
    content: [
      { type: "text", text: "line1" },
      { type: "text", text: "line2" },
    ],
  };
  expect(fromOmpResult("x", omp, 0).summary).toBe("line1\nline2");
});

test("non-text content is preserved in payload, not dropped", () => {
  const omp: AgentToolResult = {
    content: [
      { type: "text", text: "see image" },
      { type: "image", data: "BASE64==", mimeType: "image/png" },
    ],
  };
  const prd = fromOmpResult("screenshot", omp, 3);
  expect(prd.summary).toBe("see image");
  const payload = prd.payload as { nonTextParts: unknown[]; content: unknown[] };
  expect(payload.nonTextParts).toHaveLength(1);
  expect(payload.content).toHaveLength(2);
});
