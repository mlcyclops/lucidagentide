// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1
//
// tools/remote-pwa/sw.js — P-REMOTE.3 (ADR-0226/0227): the PWA service worker (installability + offline shell).
//
// Caches ONLY the static app shell so "Add to Home Screen" works and a cold launch paints instantly. It NEVER
// caches session data: the relay WebSocket, Firebase auth, and Google's CDN are always network (a stale token
// or a cached session would be wrong AND a data-at-rest surface). Same-origin shell requests are NETWORK-FIRST
// so a deployed fix reaches an installed phone immediately; the cache is offline fallback only.

const CACHE = "lucid-remote-v6";
const SHELL = ["./", "./index.html", "./app.js", "./firebase_auth.js", "./config.js", "./manifest.webmanifest", "./icon.svg?v=3"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Same-origin contains only the static shell. Session/auth/checkout traffic is cross-origin and never cached.
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        e.waitUntil(caches.open(CACHE).then((cache) => cache.put(e.request, copy)));
      }
      return response;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || Response.error())),
  );
});
