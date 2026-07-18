// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1
//
// P-REMOTE.7: point the desktop host at the hosted relay behind the External HTTPS Load Balancer
// (wss://relay.aiworkshopapps.com). Run once on a provisioned host:
//   bun run desktop/scripts/configure_remote_relay.ts

import { collabRelayConfig, setCollabRelay } from "../settings_store.ts";

const RELAY = process.env.LUCID_RELAY_WS ?? "wss://relay.aiworkshopapps.com";
setCollabRelay({ url: RELAY, publicOptIn: false });
const configured = collabRelayConfig();
if (configured?.wsBase !== RELAY) throw new Error("hosted relay setting did not persist");
console.log(`configured ${configured.wsBase}`);
