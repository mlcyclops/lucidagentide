// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// A throwaway vLLM-shaped endpoint used to verify the P-LOCAL.6 discovery ROUTE against a booted
// engine. vLLM's `--api-key` middleware answers `401 {"error":"Unauthorized"}`, which is exactly what
// the user's DGX Spark returns, so an unauthenticated probe here reproduces the real case.
//
// Run: bun run desktop/scripts/fake_vllm.ts [port]

const port = Number(process.argv[2] ?? 8111);
const TOKEN = process.env.FAKE_VLLM_TOKEN ?? "spark-token";

Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
    }
    if (path === "/v1/models") {
      return Response.json({
        object: "list",
        data: [
          { id: "zai-org/GLM-5.3-Flash-FP8", object: "model", owned_by: "vllm", root: "zai-org/GLM-5.3-Flash", parent: null, max_model_len: 65536, permission: [] },
          { id: "Qwen/Qwen3-Coder-30B-A3B-Instruct", object: "model", owned_by: "vllm", max_model_len: 262144 },
        ],
      });
    }
    return new Response("not found", { status: 404 });
  },
});
console.log(`fake vLLM listening on http://127.0.0.1:${port}/v1 (bearer ${TOKEN})`);
