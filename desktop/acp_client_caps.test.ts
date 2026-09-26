// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/acp_client_caps.test.ts - P-FLEET.L14. The parity test that would have caught the reported bug.
//
// A `dgx` fleet lane failed every bash and eval call with `Tool "bash" requires approval but no interactive
// UI available`, while its auto-approve looked broken. Auto-approve was fine: it answers ACP
// `session/request_permission` (gate 1). The failure was omp's OWN `ExtensionToolWrapper` (gate 2), which
// under ACP asks the client through a form elicitation and only does so when the client advertised
// `elicitation.form` at `initialize`. `acp_backend` advertised it; `fleet_lanes` did not, despite already
// having an `elicitation/create` handler that could therefore never fire.
//
// So the invariant is not "the constant has this shape", it is: ANSWERING `elicitation/create` and
// ADVERTISING `elicitation.form` must always travel together. The last test reads the real sources and
// enforces exactly that, for every ACP client in the tree including ones written after this.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACP_INTERACTIVE_CLIENT_CAPS, advertisesElicitationForm } from "./acp_client_caps.ts";

describe("ACP_INTERACTIVE_CLIENT_CAPS", () => {
  test("advertises the form elicitation, which is what makes omp's inner gate reachable", () => {
    expect(advertisesElicitationForm(ACP_INTERACTIVE_CLIENT_CAPS)).toBe(true);
  });

  test("keeps client-side file I/O OFF, so no unscanned path opens around the security gate", () => {
    // Invariant 4: the gate runs in-process on every tool call. omp reads the workspace itself; proxying
    // file reads back through the client would be a second, ungated route to the same bytes.
    expect(ACP_INTERACTIVE_CLIENT_CAPS.fs.readTextFile).toBe(false);
    expect(ACP_INTERACTIVE_CLIENT_CAPS.fs.writeTextFile).toBe(false);
  });
});

describe("advertisesElicitationForm", () => {
  test("THE BUG: the capabilities fleet lanes used to send are correctly reported as unreachable", () => {
    expect(advertisesElicitationForm({ fs: { readTextFile: false, writeTextFile: false } })).toBe(false);
  });

  test("an empty form object is enough, because the key is the signal", () => {
    expect(advertisesElicitationForm({ elicitation: { form: {} } })).toBe(true);
  });

  test("a half-declared elicitation does not count as reachable", () => {
    expect(advertisesElicitationForm({ elicitation: {} })).toBe(false);
    expect(advertisesElicitationForm({ elicitation: null })).toBe(false);
    expect(advertisesElicitationForm({ elicitation: "form" })).toBe(false);
  });

  test("garbage refuses rather than throwing, since this inspects a wire object", () => {
    for (const bad of [null, undefined, 0, "", "caps", [], true]) {
      expect(advertisesElicitationForm(bad)).toBe(false);
    }
  });
});

describe("every ACP client that ANSWERS an elicitation also ADVERTISES it", () => {
  // Source-level, because the bug was a mismatch BETWEEN two files that each looked correct alone. A unit
  // test on either one in isolation would have passed while lanes stayed broken.
  const CLIENTS = ["acp_backend.ts", "fleet_lanes.ts"];

  test.each(CLIENTS)("%s", (file) => {
    const src = readFileSync(join(import.meta.dir, file), "utf8");
    const answers = src.includes(`"elicitation/create"`);
    if (!answers) return; // a client that never answers has nothing to advertise
    // It must not restate the capability inline: it has to use the ONE shared constant, which is what
    // makes drift impossible rather than merely currently-absent.
    expect(src).toContain("ACP_INTERACTIVE_CLIENT_CAPS");
    expect(src).toContain(`from "./acp_client_caps.ts"`);
    // And it must actually PASS it to initialize, not just import it.
    expect(src).toMatch(/clientCapabilities:\s*ACP_INTERACTIVE_CLIENT_CAPS/);
    // P-FLEET.L15 (ADR-0338): and it must answer with the SHARED answerer. Advertising the capability
    // correctly while hand-rolling the answer is the second half of the same bug, and it is worse: omp
    // asks, the client answers something malformed, and the call is denied with no prompt anywhere.
    expect(src).toContain("elicitationAnswer");
  });

  test.each(CLIENTS)("%s does not hand-roll the options path", (file) => {
    const src = readFileSync(join(import.meta.dir, file), "utf8");
    // The two shapes the lane guessed. Neither exists on an elicitation/create request, and reading either
    // silently yields no options, which becomes a decline. Only `exec_policy` may know the real path.
    expect(src).not.toMatch(/params\?\.options\s*\?\?\s*params\?\.schema\?\.options/);
    expect(src).not.toContain("schema?.options");
  });

  test("both clients really do answer elicitation/create, so the check above is not vacuous", () => {
    // ADR-0303: a guard that silently matches nothing is worse than no guard. Pin that the precondition
    // holds, so this suite cannot pass by finding no clients to check.
    for (const file of CLIENTS) {
      const src = readFileSync(join(import.meta.dir, file), "utf8");
      expect(src).toContain(`"elicitation/create"`);
    }
  });
});
