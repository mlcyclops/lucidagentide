// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/acp_client_caps.ts - P-FLEET.L14 (ADR-0337): the capabilities LUCID advertises when it acts as
// an ACP CLIENT, in ONE place, because having them in two places is what broke fleet lanes.
//
// THE BUG THIS EXISTS FOR, reported from a running `dgx` lane: every bash and eval call failed with
//
//     Tool "bash" requires approval but no interactive UI available.
//       1. Set tools.approvalMode: yolo in /settings
//       2. Add tools.approval.bash: allow to config
//       3. Use an interactive UI that actually shows the approval prompt
//
// while the lane's auto-approve appeared to do nothing. Auto-approve was working the entire time. It was
// answering the WRONG GATE, because there are two:
//
//   GATE 1, ours: ACP `session/request_permission`. Both the main chat (`acp_backend`) and each fleet lane
//     (`fleet_lanes`) answer it, and P-FLEET.L6 auto-approve / session grants resolve it with no human.
//     This is the gate whose "session-approved" chip the user could see in the transcript.
//
//   GATE 2, omp's: `ExtensionToolWrapper`. `harness/omp/acp_config.yml` sets `tools.approval.bash: prompt`
//     (P-EXEC.1, ADR-0066) and omp honors per-tool overrides in EVERY approval mode including its default
//     `yolo`, so bash and eval ALWAYS reach gate 2. Under ACP there is no TUI to prompt in, so omp asks the
//     CLIENT via a form elicitation (`elicitation/create`) - but only if the client advertised
//     `elicitation.form` at `initialize`. Otherwise omp concludes no interactive UI exists and hard-fails.
//
// `acp_backend` advertised it. `fleet_lanes` did not, though it had already been written an
// `elicitation/create` handler. That handler was DEAD CODE: omp never sends the request to a client that
// did not advertise the capability. So the fix is not just "add the line", it is to remove the ability for
// the two clients to disagree, which is why this constant exists and why both now import it.

/** Advertised by an INTERACTIVE ACP client: one that answers `session/request_permission` AND
 *  `elicitation/create`. Answering those two without advertising `elicitation.form` is the P-FLEET.L14
 *  bug; advertising it without answering `elicitation/create` hangs every gated call until it times out.
 *  The two go together, so they live together.
 *
 *  `fs.readTextFile` / `writeTextFile` stay FALSE deliberately: omp runs in-process with the workspace and
 *  reads files itself. Proxying file I/O back through the client would put an unscanned path around the
 *  security gate, which invariant 4 exists to prevent. */
export const ACP_INTERACTIVE_CLIENT_CAPS = {
  fs: { readTextFile: false, writeTextFile: false },
  elicitation: { form: {} },
} as const;

/** True when these capabilities let omp reach a client-side approval UI for gate 2.
 *
 *  Exported so the parity test can assert the property rather than the literal shape: a future capability
 *  rename in omp should fail this ONE predicate, not silently make every gated tool call unreachable
 *  again. Takes `unknown` because it is checking a wire object, not a trusted local. */
export function advertisesElicitationForm(caps: unknown): boolean {
  if (!caps || typeof caps !== "object") return false;
  if (!("elicitation" in caps)) return false;
  const e = caps.elicitation;
  if (!e || typeof e !== "object") return false;
  return "form" in e;
}
