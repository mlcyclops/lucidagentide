// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1
//
// tools/remote-pwa/firebase_auth.js — P-REMOTE.3 (ADR-0226/0227): the Firebase Auth bridge for the phone PWA.
//
// Loaded as an ES module by index.html DIRECTLY from Google's CDN, so the Firebase SDK never enters app.js's
// bundle (and an air-gapped desktop build never ships it — the PWA is inherently online). It exchanges a
// Google sign-in for a FIREBASE ID token (iss=securetoken.google.com/<project>, the exact token the relay
// verifies in P-REMOTE.1) and publishes a tiny, typed surface on window.__lucidAuth that app.ts consumes.
// The Firebase web config is PUBLIC by design (it identifies the project; it is not a secret); it comes from
// config.js (window.__LUCID_REMOTE__.firebase), which the deploy fills with the project's public values.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut,
  setPersistence, browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const cfg = window.__LUCID_REMOTE__ && window.__LUCID_REMOTE__.firebase;
if (!cfg) {
  console.error("[lucid-remote] config.js did not set window.__LUCID_REMOTE__.firebase");
} else {
  const auth = getAuth(initializeApp(cfg));
  // Keep the session across an iOS tab suspend / relaunch so a reconnect re-presents a fresh token silently.
  await setPersistence(auth, browserLocalPersistence).catch(() => {});
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  // Returning from a redirect sign-in: Google's OAuth round-trip DROPS the URL fragment (the room + E2E
  // secret), so restore it WITHOUT reloading (history.replaceState) BEFORE app.ts reads location.hash, then
  // finish the sign-in. sessionStorage survives the same-tab redirect; a same-domain authDomain keeps
  // getRedirectResult working on iOS Safari, where signInWithPopup is blocked/lost after ITP.
  const HASH_KEY = "lucid.remote.hash";
  // P-REMOTE.10c: out-of-band reconnect. A drive.file OAuth access token (Drive-scoped) lets the phone read the
  // host's shared `lucid_relay_codes` file to recover the freshest invite link. It is a SEPARATE incremental
  // consent (a viewer is never asked for Drive), captured from the redirect credential and stashed with a
  // conservative expiry; the RECONNECT flag distinguishes a drive consent from a plain (scope-less) sign-in.
  const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
  const DRIVE_TOK_KEY = "lucid.remote.driveTok";     // { token, exp } in localStorage
  const RECONNECT_KEY = "lucid.remote.reconnecting"; // sessionStorage flag across the drive-consent redirect
  try {
    const saved = sessionStorage.getItem(HASH_KEY);
    if (saved && !location.hash) history.replaceState(null, "", location.pathname + location.search + saved);
  } catch { /* storage unavailable */ }
  let redirectResult = null;
  try { redirectResult = await getRedirectResult(auth); } catch (e) { console.error("[lucid-remote] redirect sign-in did not complete", e); }
  try {
    if (redirectResult && sessionStorage.getItem(RECONNECT_KEY) === "1") {
      const cred = GoogleAuthProvider.credentialFromResult(redirectResult);
      if (cred && cred.accessToken) localStorage.setItem(DRIVE_TOK_KEY, JSON.stringify({ token: cred.accessToken, exp: Date.now() + 55 * 60 * 1000 }));
    }
  } catch { /* credential/storage unavailable - the reconnect flow just re-consents */ }
  try { sessionStorage.removeItem(HASH_KEY); } catch { /* storage unavailable */ }
  try { sessionStorage.removeItem(RECONNECT_KEY); } catch { /* storage unavailable */ }

  window.__lucidAuth = {
    // A FRESH ID token per call (Firebase refreshes it under the hood near expiry) — the relay re-verifies on
    // every reconnect, so the hourly Cloud-Run cap just re-presents a valid token. Pass force=true after a
    // checkout so the webhook-set `premium` custom claim is pulled immediately (P-REMOTE.6), not up to 1h later.
    async getIdToken(force) { return auth.currentUser ? await auth.currentUser.getIdToken(!!force) : null; },
    async signIn() {
      // A full-page redirect is the reliable sign-in on iOS Safari (popups get blocked / lost after ITP).
      // Stash the room fragment first (the OAuth round-trip drops it) so it can be restored on return.
      try { if (location.hash) sessionStorage.setItem(HASH_KEY, location.hash); } catch { /* storage unavailable */ }
      await signInWithRedirect(auth, provider);
    },
    async signOut() { try { sessionStorage.removeItem(HASH_KEY); localStorage.removeItem(DRIVE_TOK_KEY); } catch { /* storage unavailable */ } await signOut(auth); },
    onChange(cb) { onAuthStateChanged(auth, (u) => cb(u ? (u.email || u.uid) : null)); },
    // P-REMOTE.10c: the stashed drive.file access token while it is still live, else null (-> re-consent).
    getDriveToken() {
      try { const r = JSON.parse(localStorage.getItem(DRIVE_TOK_KEY) || "null"); return r && typeof r.token === "string" && r.exp > Date.now() ? r.token : null; } catch { return null; }
    },
    // Incremental consent for drive.file ONLY. A full-page redirect is the reliable path on iOS Safari; the
    // RECONNECT flag makes the return capture the drive-scoped access token (above).
    async signInForDrive() {
      try { sessionStorage.setItem(RECONNECT_KEY, "1"); } catch { /* storage unavailable */ }
      const driveProvider = new GoogleAuthProvider();
      driveProvider.addScope(DRIVE_SCOPE);
      driveProvider.setCustomParameters({ prompt: "consent" });
      await signInWithRedirect(auth, driveProvider);
    },
  };
}
// Module scripts containing top-level await do not guarantee that the following app module observes the
// bridge synchronously. Signal completion explicitly; app.ts also checks the bridge first to avoid a lost event.
window.dispatchEvent(new Event("lucid-auth-ready"));
