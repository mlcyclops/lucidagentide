// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("preview extension tests never contact inherited desktop endpoints", async () => {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      // Keep only the local address and path, never query parameters or credentials.
      requests.push(`http://127.0.0.1:${url.port}${url.pathname}`);
      return Response.json({
        ok: true,
        data: {
          opened: true,
          png: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
          result: { ok: true, text: "Local isolation sentinel", elements: [] },
        },
      });
    },
  });

  try {
    const endpoint = `http://127.0.0.1:${server.port}/api/preview`;
    const child = Bun.spawn([process.execPath, "test", "./harness/omp/preview_extension.test.ts"], {
      cwd: resolve(import.meta.dir, "../.."),
      env: {
        ...process.env,
        LUCID_PREVIEW_OPEN_URL: `${endpoint}/open`,
        LUCID_PREVIEW_SHOT_URL: `${endpoint}/shot`,
        LUCID_PREVIEW_INSPECT_URL: `${endpoint}/inspect`,
        LUCID_PREVIEW_ACT_URL: `${endpoint}/act`,
      },
      stdout: "pipe",
      stderr: "pipe",
      // Bound the real child process, not a guessed delay before checking results.
      timeout: 25_000,
      killSignal: "SIGKILL",
    });

    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const failureContext = `Nested preview test suite: exit=${exitCode}, signal=${child.signalCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
      expect(exitCode, failureContext).toBe(0);
      expect(requests, `Inherited endpoints received requests.\n${failureContext}`).toHaveLength(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
  } finally {
    server.stop(true);
  }
}, 30_000);
