# Runbook

NotebookLM's interface changes. Each step names what to click and what must be true on screen afterwards.
If the check fails, stop and ask the user.

## Session start

1. The user is present and their signed-in browser window is visible. Check: the account avatar is the
   user's own.
2. Read `ledger.json`. Check: fewer than 15 entries in the last 24 hours. Otherwise report `nextAllowedAt`
   and stop.

## Per unit

1. Open the grade and subject notebook. Check: the notebook title matches.
2. Sources panel: deselect all, then tick the unit's pack and the overview. Check: exactly two sources are
   selected, and their names match.
3. Studio panel: open the Audio Overview customize control. Check: the dialog shows format and length
   choices.
4. Choose Deep Dive and Shorter. Paste the filled-in kid prompt. Check: the prompt names the unit.
5. Generate. Check: a new tile shows a generating state. Wait until it finishes; do nothing else.
6. Append the ledger entry with the time and unit.
7. Open the finished tile's menu, then "View prompt and sources". Check: the prompt and the two sources are
   the unit's.
8. Download. Check: an `.m4a` file appears in the downloads folder.
9. Rename and move it at once to `<private>/podcasts/<GRADE>/<SUBJECT>/GRADE_SUBJECT_ShortTitle-Podcast_U<nn>_YYYY.m4a`.
10. Add the manifest record with sha256 and duration.

## Stop conditions

Any captcha, warning banner, unusual-activity notice, quota message, sign-out, or unexpected dialog: stop,
leave the page as it is, and tell the user.
