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
// P-WAIT.1: the same hook also fronts every `write` / `edit` call. The engine claims the call's file(s)
// for this session's running turn and, only when ANOTHER worker's running turn is editing one of them, holds
// the call for up to WRITE_WAIT_MS (the worker's card or HUD says whom it waits for). Still held after that:
// a refusal that names the holder, so the model does other work first or checks in. Workers in one folder
// never wait for each other otherwise; that replaced a whole-turn folder lease.
//
// HOOK SEAM: `pi.on("tool_call", ...)`, the same seam security_extension.ts uses. A handler returning
// `{ block: true, reason }` stops the tool and hands the reason to the model as the tool error. omp gives
// a handler 30 s and then fails the call closed, which is why the write wait is bounded well under that.
//
// FAIL-OPEN, ON PURPOSE: this gate is a coordination guard between cooperating agents, not a trust
// boundary. The security gate stays authoritative and fails closed; this one, on a dead or slow engine or
// a torn payload, writes one stderr line and lets the command through. A stalled engine must never freeze
// every git command in every lane. Commands without a `git` token never touch the network at all.
//
// HOW IT REACHES THE ENGINE: dev.ts convention. LUCID_CHECKOUT_GATE_URL is one complete token'd URL
// (`/api/checkout/gate?t=<TOKEN>`); `&target=<me>&cwd=<abs>&command=<text>` are appended. The write claim
// is LUCID_CHECKOUT_WRITE_URL (`/api/checkout/write?t=<TOKEN>`) with `&target&cwd&path=<p>...&waitMs`.
// Identity is LUCID_INTERJECT_TARGET ("master" or the laneId). Each half is live only when its URL and the
// identity are set; with neither, nothing registers.

import type { createAgentSession } from "@oh-my-pi/pi-coding-agent";
import { writeStderrNotice } from "./stderr_notice.ts";

type SessionOpts = NonNullable<Parameters<typeof createAgentSession>[0]>;
type ExtensionFactory = NonNullable<SessionOpts["extensions"]>[number];

/** Per-command budget: the gate runs in front of EVERY git command, so a hung engine must cost little. */
const FETCH_TIMEOUT_MS = 1_500;

/** The prefix the model reads in front of the engine's verbatim reason. */
export const REFUSAL_PREFIX = "Refused by the LUCID checkout gate: ";

/** How long one write may wait for another worker's turn to finish with its file. The engine caps it at
 *  25 s; the fetch gets WRITE_FETCH_SLACK_MS on top, and both stay under omp's 30 s hook limit. */
export const WRITE_WAIT_MS = 20_000;
const WRITE_FETCH_SLACK_MS = 4_000;

/** The gate URL for this child (token'd, with identity appended), or null when not LUCID-spawned. `key`
 *  picks the commit gate (default) or the write claim. */
export function checkoutGateUrl(env: Record<string, string | undefined> = process.env, key: "LUCID_CHECKOUT_GATE_URL" | "LUCID_CHECKOUT_WRITE_URL" = "LUCID_CHECKOUT_GATE_URL"): string | null {
  const target = (env.LUCID_INTERJECT_TARGET ?? "").trim();
  const base = (env[key] ?? "").trim();
  if (!target || !base) return null;
  return `${base}${base.includes("?") ? "&" : "?"}target=${encodeURIComponent(target)}`;
}

/** The file(s) a write/edit call names: omp's `path`, plus the `paths` it derives for a multi-file edit. */
export function writeTargets(toolName: string, input: object): string[] {
  if (toolName !== "write" && toolName !== "edit") return [];
  const { path, paths } = input as { path?: unknown; paths?: unknown };
  const out = typeof path === "string" && path.trim() ? [path.trim()] : [];
  if (Array.isArray(paths)) for (const p of paths) if (typeof p === "string" && p.trim() && !out.includes(p.trim())) out.push(p.trim());
  return out;
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
    const gateUrl = checkoutGateUrl();
    const writeUrl = checkoutGateUrl(process.env, "LUCID_CHECKOUT_WRITE_URL");
    if (!gateUrl && !writeUrl) return;
    // ONE handler for both halves: omp runs every registered handler, and one dispatch keeps a tool call
    // to at most one engine round trip.
    pi.on("tool_call", async (event) => {
      let ask: string;
      let timeoutMs: number;
      let what: string;
      const paths = writeUrl ? writeTargets(event.toolName, event.input) : [];
      if (paths.length > 0) {
        ask = `${writeUrl}&cwd=${encodeURIComponent(process.cwd())}${paths.map((p) => `&path=${encodeURIComponent(p)}`).join("")}&waitMs=${WRITE_WAIT_MS}`;
        timeoutMs = WRITE_WAIT_MS + WRITE_FETCH_SLACK_MS;
        what = "write";
      } else {
        if (!gateUrl || event.toolName !== "bash") return undefined;
        const input = event.input;
        const command = input.command;
        if (typeof command !== "string" || !mentionsGit(command)) return undefined;
        const cwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd : process.cwd();
        ask = `${gateUrl}&cwd=${encodeURIComponent(cwd)}&command=${encodeURIComponent(command)}`;
        timeoutMs = FETCH_TIMEOUT_MS;
        what = "command";
      }
      try {
        const res = await fetch(ask, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`the engine responded ${res.status}`);
        const verdict = parseGateVerdict(await res.json());
        if (!verdict) throw new Error("malformed gate response");
        if (!verdict.block) return undefined;
        return { block: true, reason: `${REFUSAL_PREFIX}${verdict.reason}` };
      } catch (e) {
        const msg = e && typeof e === "object" && "message" in e ? String(e.message) : String(e);
        writeStderrNotice(`\n[LucidAgentIDE] checkout gate unreachable, ${what} allowed (fail-open): ${msg}\n`);
        return undefined;
      }
    });
  } catch {
    /* a registration failure never breaks omp launch */
  }
};

export default commitGateExtension;
