# Task: add a `/r/*` LUCID Remote forwarder to the COVERT site (aiworkshopapps.com)

## Context (verified live 2026-07-18, from the LucidAgentIDE session)

LUCID Remote collaboration invites exist in two forms:

- Phone-safe: `https://lucid-agent.web.app/remote/#<roomId>.<secret>` (secret in the FRAGMENT, never
  sent to any server).
- LUCID-to-LUCID: `wss://relay.aiworkshopapps.com/r/<roomId>.<secret>` (bare link in the PATH; meant
  to be pasted into another LUCID desktop app, which parses it locally and never fetches it).

When a user texts the second form to a phone, messengers/cameras drop the `wss://` scheme and the
`relay.` subdomain and open `https://aiworkshopapps.com/r/<roomId>.<secret>`. Today the COVERT SPA's
catch-all swallows that path and renders the consortium homepage (observed live: a real invited user
landed there). The LUCID side has already shipped its half: `https://lucid-agent.web.app/r/*` now
serves a forwarder, and the desktop Share panel now hands out the phone-safe form first. The APEX is
the remaining hole, and it is served by this (COVERT) site's hosting, so the fix belongs in this repo.

## Security constraints (important)

- The path segment after `/r/` IS A LIVE ROOM SECRET (E2E room key material). Never log it, never
  send it to analytics, never echo it into rendered HTML. The forwarder must move it into a URL
  fragment CLIENT-SIDE only (fragments never leave the browser).
- The forwarder page must be `noindex` and must not run the site's analytics or service worker.

## The change

Serve a tiny static page for `GET /r/*` (it must win over the SPA catch-all):

1. Match the path client-side with `^/r/([A-Za-z0-9._-]+)$`.
2. On match: `location.replace("https://lucid-agent.web.app/remote/#" + captured)`.
   NOTE the absolute origin - this site is NOT the PWA origin, so a relative `/remote` is wrong here.
3. No match: `location.replace("https://lucid-agent.web.app/remote")`.
4. Include a visible fallback anchor ("Tap here if it doesn't open automatically") whose `href` is set
   by the same script, plus `<meta name="robots" content="noindex">`.

Reference implementation (same-origin variant, adapt the destination to absolute):
`https://lucid-agent.web.app/r/anything` (view source), authored in the LucidAgentIDE repo at
`tools/remote-pwa/r.html`.

## Watch-outs specific to this site

- The SPA registers `./_service-worker.js` on load. Make sure `/r/*` navigations are NOT served from
  the SW's cached app shell (exclude `/r/` from any navigation-fallback route), or a returning
  visitor's cached SPA will swallow the path again even after the hosting fix.
- Whatever hosting/router serves the apex (the deploy layer of this repo) must route `/r/*` to the
  static forwarder BEFORE the SPA catch-all/rewrite.
- Keep `_websocket-interceptor.js` and analytics OFF this page - it should be a bare static HTML file.

## Acceptance

- `curl -s https://aiworkshopapps.com/r/test.abc-123` returns the forwarder HTML (contains "Opening
  LUCID Remote"), not the COVERT SPA shell.
- Opening `https://aiworkshopapps.com/r/test.abc-123` in a phone browser lands on
  `https://lucid-agent.web.app/remote/#test.abc-123` (PWA sign-in screen).
- A hard-refresh AND a repeat visit (service worker warm) both behave the same.
- The room-secret path segment appears in no client-side logging/analytics calls.
