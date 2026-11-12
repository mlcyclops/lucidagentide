// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/plugins/publisher_key.ts - P-PLUGINS.2 (ADR-0462): the TRUSTED premium plugin publisher key.
//
// The public half of the TECHLEAD 187 LLC plugin publisher Ed25519 key, baked into the IDE build. It is
// deliberately a source constant and NOT a user-editable file or env var: anyone who could edit a trust
// file could sign their own "premium" plugin. Tests inject their own keys through the installer's
// `trusted` option instead of overriding this.
//
// Written by `bun tools/build_plugin.ts --init-key`, which creates the private key once at
// ~/.omp/keys/lucid-plugin-publisher.key (never in this repo) and records its SPKI here. Empty means no
// publisher key has been baked yet, so every premium plugin is refused at the signature gate (fail-closed).

import { createHash, createPublicKey } from "node:crypto";
import type { TrustedPackKey } from "../kb/pack.ts";

/** base64 DER SPKI of the publisher's Ed25519 public key. */
export const PLUGIN_PUBLISHER_SPKI_B64: string = "MCowBQYDK2VwAyEArNtRnkfcASRcd/drmTVEwOmoH3cwIK7GXSRuPdf3Hpw=";

/** Stable short id of a publisher key: the first 16 hex chars of sha256(SPKI DER). */
export function pluginKeyId(spkiDer: Buffer): string {
  return `lucid-plugin-${createHash("sha256").update(spkiDer).digest("hex").slice(0, 16)}`;
}

/** The keys the installer trusts. [] until a key is baked, which refuses every premium plugin. */
export function trustedPluginKeys(): TrustedPackKey[] {
  if (!PLUGIN_PUBLISHER_SPKI_B64) return [];
  const der = Buffer.from(PLUGIN_PUBLISHER_SPKI_B64, "base64");
  return [{ id: pluginKeyId(der), key: createPublicKey({ key: der, type: "spki", format: "der" }) }];
}
