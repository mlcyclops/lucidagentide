// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/cui_policy.ts - the CUI lockdown verdict for Creator providers.
//
// The lockdown is NOT a new toggle: it is the existing asksageLocked() semantics (the user's AskSage-only
// flag OR the org-managed one, ADR-0217/0218/0219). While it is on, no user content may reach a service that
// is neither on this workstation nor a DGX enclave host, unless that service is CUI-authorized. This module
// answers "may this provider, through this declaration, be reached right now?" and nothing else.
//
// Rules while locked, in order (the first that matches decides):
//   1. a cloud provider without a `cui.authorization` string is refused (an enclave flag cannot launder it);
//   2. a cloud provider WITH an authorization is allowed;
//   3. no network endpoint (in-renderer, a child process, or nothing declared yet) is allowed;
//   4. an endpoint attested `enclave: true` is allowed;
//   5. zone "local" AND a loopback host AND an on-device provider is allowed;
//   6. anything else is refused, with a reason that names why.
//
// Pure: no fs, no fetch, no settings read. The caller supplies `locked` and does the auditing through the
// injected sink, so every rule above is unit-tested without a running engine.

import type { CreatorEndpointDef, CreatorIntegrationSpec } from "./creator_registry.ts";

export type CuiPosture = "on-device" | "enclave" | "cloud";

export interface CuiVerdict {
  readonly allowed: boolean;
  readonly posture: CuiPosture;
  /** One line the UI shows verbatim and the audit records. Never contains a credential. */
  readonly reason: string;
}

/** Loopback hostnames as `URL.hostname` spells them. A name that merely resolves to loopback does not count:
 *  DNS is not evidence, and `localhost` is the one name the platform pins. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  if (h === "localhost" || h === "[::1]" || h === "::1") return true;
  const m = h.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}

const allow = (posture: CuiPosture, reason: string): CuiVerdict => ({ allowed: true, posture, reason });
const refuse = (posture: CuiPosture, reason: string): CuiVerdict => ({ allowed: false, posture, reason });

/** The verdict for one provider, optionally through one declaration. `locked` = asksageLocked(). */
export function cuiProviderVerdict(locked: boolean, spec: CreatorIntegrationSpec, endpoint?: CreatorEndpointDef): CuiVerdict {
  const posture = spec.cui.posture;
  if (!locked) return allow(posture, "CUI lockdown is off.");

  if (posture === "cloud") {
    const auth = (spec.cui.authorization ?? "").trim();
    if (!auth) return refuse("cloud", `${spec.name} is a cloud service with no CUI authorization, so it is refused under CUI lockdown.`);
    return allow("cloud", `${spec.name} is CUI-authorized (${auth}).`);
  }

  const baseUrl = (endpoint?.baseUrl ?? "").trim();
  if (!endpoint || !baseUrl) {
    if (spec.transports.includes("in-renderer") && spec.transports.length === 1) return allow(posture, "Runs inside the sandboxed renderer: nothing leaves this workstation.");
    if (endpoint?.command) return allow(posture, "Runs as a local child process on this workstation.");
    return allow(posture, "No network endpoint is declared, so nothing is reached.");
  }

  if (endpoint.enclave === true) return allow("enclave", `${endpoint.label} is attested as a DGX enclave host.`);

  let host = "";
  try { host = new URL(baseUrl).hostname; } catch { return refuse(posture, "That endpoint URL does not parse, so it is refused under CUI lockdown."); }
  if (endpoint.zone === "external") {
    return refuse(posture, `${host} is an external endpoint that is not CUI-authorized, so it is refused under CUI lockdown.`);
  }
  if (endpoint.zone === "internal") {
    return refuse(posture, `${host} is an internal endpoint not attested as a DGX enclave host, so it is refused under CUI lockdown. Mark it as an enclave only if it is one.`);
  }
  if (!isLoopbackHost(host)) {
    return refuse(posture, `${host} is declared local but is not a loopback address, so it is refused under CUI lockdown.`);
  }
  if (posture !== "on-device") {
    return refuse(posture, `${spec.name} must be attested as a DGX enclave host (import it from the DGX Loader or mark it as an enclave), so it is refused under CUI lockdown.`);
  }
  return allow("on-device", `${host} is a loopback service on this workstation.`);
}

/** What the gate hands the audit sink on a refusal. Metadata only: never content, never a credential. */
export interface CuiRefusalAudit {
  readonly providerId: string;
  readonly endpointId: string;
  readonly reason: string;
}

/** Check the verdict before a provider is reached, and audit a refusal. Returns the verdict either way. */
export function gateCreatorProvider(
  locked: boolean,
  spec: CreatorIntegrationSpec,
  endpoint: CreatorEndpointDef | undefined,
  audit: (ev: CuiRefusalAudit) => void,
): CuiVerdict {
  const v = cuiProviderVerdict(locked, spec, endpoint);
  if (!v.allowed) {
    try { audit({ providerId: spec.id, endpointId: endpoint?.id ?? "", reason: v.reason }); } catch { /* the refusal stands without its trail */ }
  }
  return v;
}

/** The route body for a refusal: the creator `{ ok, error, data }` envelope with the verdict attached. */
export function cuiRefusal(v: CuiVerdict): { ok: false; error: string; data: { cui: CuiVerdict } } {
  return { ok: false, error: `CUI lockdown: ${v.reason}`, data: { cui: v } };
}
