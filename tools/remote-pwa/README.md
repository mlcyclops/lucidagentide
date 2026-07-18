<!-- Copyright (c) 2026 TechLead 187 LLC / SPDX-License-Identifier: BUSL-1.1 -->

# tools/remote-pwa — the phone guest PWA (P-REMOTE.3, ADR-0226/0227)

Reach a running desktop LUCID from your phone's browser. A standalone static app built from the SAME
`desktop/collab` modules the desktop uses — the E2E collab protocol is single-sourced, never reimplemented.

## How it works

1. **Sign in with Google** (`firebase_auth.js`, loaded from Google's CDN — never bundled) → a Firebase ID token.
2. **Open the invite** — the room + E2E secret ride the URL **fragment** (`#<roomId>.<secret>`), so the key
   never touches a server. Get it from the desktop Share panel (copy or scan the P-REMOTE.4a QR).
3. **Connect** to the hosted Cloud Run relay (`config.js` → `relayWsBase`), presenting the token as the first
   frame (the P-REMOTE.1 gate). The relay only ever sees ciphertext.
4. **Watch + drive** — the phone renders the host's live turn (thinking, tool chips, subagents, answer) via the
   pure `pwa_view` reducer; with a full link it can send prompts, which run on the desktop through its own
   fail-closed gate.

## Files

| File | What |
|---|---|
| `app.ts` | The bundled entry (thin wiring over `desktop/collab` + `pwa_view`); typechecked via `tsconfig.json` (DOM) |
| `firebase_auth.js` | Google sign-in bridge — CDN Firebase → `window.__lucidAuth` (kept out of the bundle) |
| `index.html` | Mobile-first shell (self-contained CSS; sign-in / session / fatal views) |
| `pwa_view` (in `desktop/collab/`) | The pure, tested ChatEvent→HTML reducer + renderers |
| `manifest.webmanifest`, `sw.js`, `icon.svg` | PWA install + offline shell (shell only — never session data) |
| `config.example.js` | PUBLIC deploy config (relay wss base + Firebase web config); copy to `config.js` |
| `build.ts` | `bun build` → `dist/` (browser bundle + static shell) |

## Build

```bash
bun run tools/remote-pwa/build.ts   # or: make pwa-build
```

Deploy config + Firebase Hosting live in the add-on mirror: `lucidaddon_audit/iac/remote-pwa/`.

## Security

The whole app trusts nothing it can avoid: the room key is fragment-only (never sent), Firebase config +
relay URL are public, the service worker caches only the static shell (no tokens, no session), and every host
string is escaped before it renders (the phone never turns host/echoed content into markup). Admission (Google
OAuth) is only the first of four gates — room key, write token, and the desktop's own gate still apply.
