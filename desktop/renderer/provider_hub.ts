// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/provider_hub.ts - P-PROV.2: the pure grouping + gating for the Provider Hub.
//
// The Providers UI used to be a collapsed card buried in Settings. The hub is a dedicated, discoverable popup
// that lists EVERY provider omp offers as same-size, logo'd tiles, grouped into sections; clicking a tile drops
// its config (OAuth connect / API key) into an inline panel. This module is PURE (no DOM, no fetch) so the
// grouping and the DATA-SOVEREIGNTY GATE are unit-testable; app.ts owns the tiles, the logos, and the wiring.
//
// The load-bearing rule (mirrors the existing "More providers" reveal, invariant #5 sits ABOVE it in the
// trust stack): the open-weight / non-U.S. section is LOCKED until the user types ACKNOWLEDGE. While locked
// its providers are NOT emitted for rendering (`providers: []` + `locked: true`), so a China-origin provider
// never even appears until the user opts in. The frontier (U.S.) section and the gov gateway are always shown.

import type { AuthStatus, ProviderAuth } from "./bridge.ts";

/** ElevenLabs is a VOICE provider, configured in the Voice card; never a chat model provider, so the hub
 *  excludes it from the open-weight section (matches secOthers). */
export const HUB_VOICE_EXCLUDE: readonly string[] = ["elevenlabs"];

export type HubSectionKey = "gateway" | "frontier" | "open";

export interface HubProvider {
  id: string;
  name: string;
  /** True once a usable credential exists: an active OAuth session, a saved primary key, or any config field set. */
  configured: boolean;
  /** Whether an OAuth "Connect" button should be offered (vs. key-only). */
  canOauth: boolean;
}

export interface HubSection {
  key: HubSectionKey;
  title: string;
  subtitle: string;
  /** Gated behind the typed acknowledgement. When true, `providers` is empty (nothing rendered until unlocked). */
  locked: boolean;
  providers: HubProvider[];
}

/** A provider is "configured" if it has an active OAuth login, a saved primary key, or any extra field set. */
export function providerConfigured(p: ProviderAuth): boolean {
  return !!(p.oauthActive || p.keySet || (p.fields ?? []).some((f) => f.set));
}

function toHub(p: ProviderAuth): HubProvider {
  return { id: p.id, name: p.name, configured: providerConfigured(p), canOauth: p.canOauth };
}

export interface HubOpts {
  /** The user typed ACKNOWLEDGE to unlock third-party / non-U.S. providers. */
  thirdPartyAck: boolean;
}

/**
 * Build the hub's sections from live auth status. Order: gov gateway (if present) → frontier (U.S.) →
 * open-weight & regional (locked behind the acknowledgement). A section with no providers is dropped, EXCEPT
 * the locked open section, which is kept (so the UI can render its acknowledgement gate).
 */
export function buildHubSections(auth: AuthStatus | null, opts: HubOpts): HubSection[] {
  const gateway = (auth?.gateway ?? []).map(toHub);
  const frontier = (auth?.majors ?? []).map(toHub);
  const open = (auth?.others ?? []).filter((p) => !HUB_VOICE_EXCLUDE.includes(p.id)).map(toHub);

  const sections: HubSection[] = [];
  if (gateway.length) {
    sections.push({ key: "gateway", title: "Government gateway", subtitle: "accredited gov proxy · AskSage", locked: false, providers: gateway });
  }
  if (frontier.length) {
    sections.push({ key: "frontier", title: "Frontier providers", subtitle: "U.S. labs · sign in or paste a key", locked: false, providers: frontier });
  }
  // Open-weight / regional: locked behind the typed acknowledgement (data-sovereignty). While locked we emit
  // NO providers, so nothing about them renders until the user opts in.
  sections.push({
    key: "open",
    title: "Open-weight & regional",
    subtitle: "third-party · non-U.S. / custom",
    locked: !opts.thirdPartyAck,
    providers: opts.thirdPartyAck ? open : [],
  });
  return sections;
}

/** How many chat-model providers are configured (gov gateway + frontier + open). Drives the onboarding nudge
 *  and the hub header count. Excludes the voice-only provider. */
export function configuredProviderCount(auth: AuthStatus | null): number {
  const all = [...(auth?.gateway ?? []), ...(auth?.majors ?? []), ...(auth?.others ?? [])]
    .filter((p) => !HUB_VOICE_EXCLUDE.includes(p.id));
  return all.filter(providerConfigured).length;
}
