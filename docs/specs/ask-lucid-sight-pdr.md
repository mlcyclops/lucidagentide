# PDR: Ask Lucid sees the app, briefs you, and recommends

Status: all four sessions shipped 2026-11-14. Follows `docs/specs/mini-lucid-ask-lucid-pdr.md` (ADR-0580 to 0583).

## 1. What was asked

1. Ask Lucid flies out **over** the Fleet popup and every other popup.
2. Lucid sees **the actual UI** the user is looking at, so a question about something on screen can be
   answered. That includes the Preview panel.
3. Lucid can **review other sessions, lanes and orbit work** and give a briefing.
4. Lucid offers **recommendations seeded from what is going on**: the screen, the work, the knowledge graph.
5. If the user does not know what to ask, the recommendations failed. Lucid should then **follow the
   work and the screen more closely** and try again.
6. At a complete loss, Lucid brings up **a feature the user has not used**, or offers to **configure
   something in the harness** for them.

## 2. What exists (ADR-0581, ADR-0582)

- The fly-out is a dock at `z-index: 100`. The Fleet grid (55) and the Orbit map (92) are already below
  it, but every modal (200) is above it, and the Orbit map covers the title-bar chip that opens it.
  Orbit also closes on Escape from a window-level listener, so Escape typed in Ask Lucid would close
  the map underneath.
- Lucid is shown three views built by the harness: fleet lanes (names and states), the Fleet Orbit
  goal and tasks, and matching knowledge pages. He does not see the screen, a lane's conversation, or
  any other session.
- The suggestions in an empty panel are four fixed questions.
- Lucid can propose four kinds of action. None of them changes a setting.

## 3. Decisions the design rests on

- **The screen is read as text, not pixels.** The renderer builds a digest of what is drawn: which
  surfaces are open, top one first, and the visible text of each. Reasons: every byte Lucid reads must
  pass the scanner and be fenced as untrusted (invariants 3 and 5), and the scanner reads text; the
  side completion is text-only and most local models have no vision; and text is what Lucid can
  quote back. A pixel capture for vision models is left for a later ADR.
- **Nothing typed is read.** Input, textarea and password values are never collected. A redaction pass
  removes anything shaped like a key or token before the digest leaves the renderer, and the engine
  repeats it.
- **Every new view is one more untrusted block.** Screen, preview, lane conversations and other
  sessions are bounded, scanned, and fenced after the brief. A view that fails its scan is withheld
  and the reply says so.
- **Lucid still has no tools and runs nothing.** Configuration is a new proposal kind behind Confirm,
  limited to an allowlist of settings that cannot weaken the security path.
- **Recommendations are computed first, generated second.** Rules over signals the app already has
  give chips with no model call. A reply may add up to three follow-up questions, which are validated
  and scanned like proposals.
- **A miss is measured.** A recommendation set the user leaves unused, or rejects, lowers the weight
  of its kinds and makes the next set follow the screen more closely.

## 4. Increments

### Session 1: P-ASKLUCID.3, above every popup, and sees the screen

**Shipped 2026-11-14, ADR-0584.**

- The dock and its pill sit above modals. Escape inside the dock closes only the dock.
- Two more ways in: a keyboard shortcut that works from any popup, and an Ask Lucid button in the
  Fleet grid and Orbit headers.
- `desktop/renderer/screen_digest.ts`: the surfaces on screen, top first, with their visible text;
  the visible Preview tab's title, address, text and errors through the existing inspect bridge.
- The engine bounds, redacts, scans and fences the digest as a fourth view.
- `make demo-P-ASKLUCID.3`.

### Session 2: P-ASKLUCID.4, a briefing across sessions, lanes and the orbit

**Shipped 2026-11-14, ADR-0585.**

- The engine adds two views: each lane's last request and last answer, and the recent sessions in
  this workspace with the last exchange of the most recent ones.
- A **Brief me** button asks for a status briefing with larger budgets for those views.
- `make demo-P-ASKLUCID.4`.

### Session 3: P-ASKLUCID.5, recommendations that follow the work

**Shipped 2026-11-14, ADR-0586.**

- `desktop/renderer/lucid_recs.ts`: candidates from the screen, the fleet, the orbit, the session
  and the knowledge graph, ranked by learned weights.
- A reply may end with up to three follow-up questions, shown as chips.
- **Something else** and an unused set count as a miss: those kinds lose weight and the next set is
  taken from a fresh reading of the screen.
- `make demo-P-ASKLUCID.5`.

### Session 4: P-ASKLUCID.6, features you have not used, and Lucid configures on Confirm

**Shipped 2026-11-14, ADR-0587.**

- `desktop/renderer/feature_catalog.ts`: what LUCID can do, and which of it this user has not touched.
  When the contextual recommendations run dry, Lucid recommends one.
- A new proposal kind, `set_setting`, over an allowlist of non-security settings, applied through the
  routes Settings uses, after Confirm.
- More views Lucid can open.
- `make demo-P-ASKLUCID.6`.

### Session 5: P-ASKLUCID.7, a picture of the screen (added after the first four)

**Shipped 2026-11-14, ADR-0588.**

- The window capture the Preview panel uses, scaled down, with typed fields and the panel painted over.
- Sent only beside a screen text view that passed its scan and needed no redaction, and only to a
  model that takes one. Everything else falls back to the text view.
- `make demo-P-ASKLUCID.7`.

## 5. What not to do

- No tool access for Lucid, and no action without Confirm.
- No setting that touches approvals, the sandbox, lockdown, providers, keys, MCP servers or
  attribution in the allowlist.
- No reading of what the user types, and no screen capture sent anywhere but the model the user
  already chats with.
- No change to the frozen prompt prefix, `contracts.ts`, the scanner contract or the schema.
