---
name: notebooklm-podcast-studio
description: "Make kid-friendly NotebookLM Audio Overview podcasts per curriculum unit, in the user's own signed-in, visible browser, at a human pace and within a daily budget, then download, rename, audit, and file them privately. Use this skill whenever a parent or teacher asks for NotebookLM notebooks per subject, Audio Overviews or Deep Dive podcasts for lessons, or to drive NotebookLM in their open browser, even if they only say 'make podcasts of her units'. Read it before opening NotebookLM or building any source pack."
---

# NotebookLM Podcast Studio

NotebookLM can turn a unit's material into a short two-voice audio overview. Done carefully, that gives a
child a podcast for every unit. Done carelessly, it burns the account's daily cap, mixes up units, and risks
the account. This skill is the careful way.

## Position on automation (read first)

This skill drives the **user's own signed-in browser window, visible on screen, while the user is
present**, one action at a time at a human pace. It does **not** use a headless browser, a second account,
an unofficial API, or scripted parallel runs. It does not reverse LUCID ADR-0070, which rejected headless
automation of consumer NotebookLM because of the account-suspension risk; that rejection stands. The user
owns the account and accepts the remaining risk. If the user is not present, do not start.

## Budget and ledger

- The consumer cap is about **20 Audio Overviews per account per rolling 24 hours** (a rolling window, not a
  midnight reset). Plan a budget of **15 per rolling 24 h** to keep headroom.
- Keep `ledger.json` in the private dir: one entry per generation with the time, notebook, unit, and result,
  plus a computed `nextAllowedAt` (the time the oldest of the last 15 drops out of the window).
- Read the ledger before every generation. If the budget is spent, stop and report `nextAllowedAt`.
- Order: units the child is on now, then the next units in core subjects, then the rest.

## Notebooks and sources

- **One notebook per grade and subject**, for example "G5 Math". Tailoring works per subject, and a free
  notebook holds a limited number of sources (about 50).
- **Per-unit text packs.** Build one compiled text source per unit locally (extracted text, lesson
  objectives, vocabulary), plus one short curriculum overview per notebook. A single source is capped at
  **200 MB**; full-course PDFs often exceed it, which is another reason to upload per-unit text, not the
  raw course file.
- **Select only the unit's sources.** Before each generation, deselect all sources, then select only that
  unit's pack and the overview. Check the selected count on screen.

## Generation

1. Open Audio Overview's customize dialog.
2. Format **Deep Dive**, length **Shorter**.
3. Paste the prompt from the kid prompt kit (below), filled in for the unit.
4. Generate. Wait for it to finish before anything else. One at a time, never queued in bursts.
5. Record the ledger entry.

### Kid prompt kit

Keep one file per child age in the private dir. Each prompt:

- names the listener's age (for example 8 or 10) and asks for warm, encouraging, concrete talk;
- names the unit's ideas and asks for everyday examples a child knows;
- ends with three questions for the child to think about;
- forbids brand talk, grades or scores, and any personal data;
- asks the hosts not to read source text aloud word for word.

## Download, rename, audit

- The download is an `.m4a` file, and NotebookLM cuts the file name at the **first period** in the title. Rename
  it **immediately** after it lands, before the next download, to
  `GRADE_SUBJECT_ShortTitle-Podcast_U<nn>_YYYY.m4a` under `<private>/podcasts/<GRADE>/<SUBJECT>/`.
- **Tiles reorder** as generations finish, so never trust tile position. Before downloading, open the tile's
  **"View prompt and sources"** and confirm the unit's prompt and that only that unit's sources were used.
  If they do not match, do not file it under that unit.
- Record each file in `manifest.json`: grade, subject, unit, title, duration, sha256, notebook, and prompt.

## Stop rule

Stop at once and tell the user on any captcha, warning, "unusual activity" notice, quota message, sign-out,
or unexpected dialog. Do not retry, switch accounts, or work around it.

## Privacy class

Podcasts generated from copyrighted course material are derived from it, so they are **private** like the
source: kept in the private dir outside any repo and cloud-synced folder, played only locally (for example
through a loopback-only route in the family's own app), and never committed, packaged, published, or used in
a public video.

## What you never do

- Run headless, unattended, in parallel, or on another account.
- Exceed 15 generations in a rolling 24 hours, or generate without reading the ledger.
- Generate with other units' sources selected, or file a download without the prompt-and-sources check.
- Leave a download with its cut-off default name.
- Publish or share a podcast made from copyrighted material.

## References

- `references/runbook.md`: the click-by-click runbook with the on-screen check for each step.
