// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1
//
// tools/remote-pwa/config.example.js — P-REMOTE.3 (ADR-0226/0227): the PWA's PUBLIC deploy config.
//
// Copy to config.js at deploy and fill the PUBLIC values. NOTHING here is a secret:
//   - relayWsBase: the hosted Cloud Run relay's wss:// origin (P-REMOTE.2).
//   - functionsBaseUrl: the deployed Firebase functions origin (P-REMOTE.6). Drives the "Subscribe" checkout
//     for a signed-in phone with no Remote Access entitlement. Omit it and the Subscribe button explains that
//     purchase isn't available in this build (fail-closed) instead of a broken flow.
//   - firebase.*: the project's PUBLIC web config (the apiKey identifies the project; it is NOT a credential
//     and is safe to ship — access is gated by Firebase Auth + the relay's token verification + the room key).
// The real config.js is git-ignored so a fork does not accidentally publish another project's values.

window.__LUCID_REMOTE__ = {
  relayWsBase: "wss://lucid-collab-relay-REPLACE_HASH.us-central1.run.app",
  functionsBaseUrl: "https://us-central1-lucid-agent.cloudfunctions.net",
  firebase: {
    apiKey: "REPLACE_PUBLIC_WEB_API_KEY",
    authDomain: "lucid-agent.firebaseapp.com",
    projectId: "lucid-agent",
    appId: "REPLACE_PUBLIC_APP_ID",
  },
};
