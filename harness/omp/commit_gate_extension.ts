// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/commit_gate_extension.ts - P-OWN.1 "one checkout, known writers": the commit gate.
//
// THE PROBLEM: with a hub session and several lanes writing into one git checkout, `git add -A` from one
// agent swept another agent's uncommitted work into its commit (PR #395). The engine keeps an ownership
// ledger (which session wrote which file) and decides, per bash command, whether it is a SWEEP (`git add
// -A`, `git add .`, `git add -u`, `git commit -a`, a bare `git stash`) landing on dirty files another
// session owns. This extension is the agent-side hook: before omp runs a bash tool call it asks the engine
// and, on a block, returns the engine's reason (which names the owner and tells the model to stage the
// explicit paths it owns) so the model can do the right thing on its next step.
//
// HOOK SEAM: `pi.on("tool_call", ...)`, the same seam security_extension.ts uses. A handler returning
// `{ block: true, reason }` stops the tool and hands the reason to the model as the tool error.
//
// FAIL-OPEN, ON PURPOSE: this gate is a coordination guard between cooperating agents, not a trust
// boundary. The security gate stays authoritative and fails closed; this one, on a dead or slow engine or
// a torn payload, writes one stderr line and lets the command through. A stalled engine must never freeze
// every git command in every lane. Commands without a `git` token never touch the network at all.
//
// HOW IT REACHES THE ENGINE: dev.ts convention. LUCID_CHECKOUT_GATE_URL is one complete token'd URL
// (`/api/checkout/gate?t=<TOKEN>`); `&target=<me>&cwd=<abs>&command=<text>` are appended. Identity is
// LUCID_INTERJECT_TARGET ("master" or the laneId). Registers nothing unless both are set.

import type { createAgentSession } from "@oh-my-pi/pi-coding-agent";
import { writeStderrNotice } from "./stderr_notice.ts";

type SessionOpts = NonNullable<Parameters<typeof createAgentSession>[0]>;
type ExtensionFactory = NonNullable<SessionOpts["extensions"]>[number];

/** Per-command budget: the gate runs in front of EVERY git command, so a hung engine must cost little. */
const FETCH_TIMEOUT_MS = 1_500;

/** The prefix the model reads in front of the engine's verbatim reason. */
export const REFUSAL_PREFIX = "Refused by the LUCID checkout gate: ";

/** The gate URL for this child (token'd, with identity appended), or null when not LUCID-spawned. */
export function checkoutGateUrl(env: Record<string, string | undefined> = process.env): string | null {
  const target = (env.LUCID_INTERJECT_TARGET ?? "").trim();
  const base = (env.LUCID_CHECKOUT_GATE_URL ?? "").trim();
  if (!target || !base) return null;
  return `${base}${base.includes("?") ? "&" : "?"}target=${encodeURIComponent(target)}`;
}

/** Whether a bash command line names git at all; anything else skips the gate without a network call. */
export function mentionsGit(command: string): boolean {
  return /\bgit\b/.test(command);
}

/** The engine's verdict, or null when the body isn't gate-shaped (treated as a failure: fail-open). */
export function parseGateVerdict(raw: unknown): { block: boolean; reason: string } | null {
  if (!raw || typeof raw !== "object" || !("data" in raw)) return null;
  const data = raw.data;
  if (!data || typeof data !== "object" || !("block" in data) || typeof data.block !== "boolean") return null;
  const reason = "reason" in data && typeof data.reason === "string" ? data.reason : "";
  return { block: data.block, reason };
}

const commitGateExtension: ExtensionFactory = (pi) => {
  try {
    const url = checkoutGateUrl();
    if (!url) return;
    pi.on("tool_call", async (event) => {
      try {
        if (event.toolName !== "bash") return undefined;
        const input = event.input;
        const command = input.command;
        if (typeof command !== "string" || !mentionsGit(command)) return undefined;
        const cwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd : process.cwd();
        const res = await fetch(`${url}&cwd=${encodeURIComponent(cwd)}&command=${encodeURIComponent(command)}`, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`the engine responded ${res.status}`);
        const verdict = parseGateVerdict(await res.json());
        if (!verdict) throw new Error("malformed gate response");
        if (!verdict.block) return undefined;
        return { block: true, reason: `${REFUSAL_PREFIX}${verdict.reason}` };
      } catch (e) {
        const msg = e && typeof e === "object" && "message" in e ? String(e.message) : String(e);
        writeStderrNotice(`\n[LucidAgentIDE] checkout gate unreachable, command allowed (fail-open): ${msg}\n`);
        return undefined;
      }
    });
  } catch {
    /* a registration failure never breaks omp launch */
  }
};

export default commitGateExtension;
