# Crawl checklist

Tick each line before moving on. Stop and tell the parent at any failed check.

## Before the crawl

- [ ] The parent asked for the mirror, in this session.
- [ ] The parent's own browser window is open, signed in, and visible.
- [ ] The private dir is chosen, outside the repo and outside every cloud-synced folder.
- [ ] `endpoints.md` lists every endpoint to call, each with its method and why it is read-only.
- [ ] No endpoint name contains assign, unassign, enroll, excuse, finalize, submit, grade, set, save, update,
      delete, or remove.
- [ ] The parent saw the endpoint list.

## During the inventory

- [ ] Requests run one at a time, with a pause of about 100 to 250 ms.
- [ ] Every response is JSON with the expected shape. Anything else (a login page, a 401, a 403, a 429) stops
      the crawl.
- [ ] Course and unit counts match what the portal shows on screen.
- [ ] `inventory.json` is saved in the private dir.

## During downloads

- [ ] One file at a time, written to `.part` and renamed when complete.
- [ ] Names follow `GRADE_SUBJECT_SHORTTITLE_SERIESNUMBERS_YYYY.<ext>`, ASCII only.
- [ ] Shared courses are stored once under `SHARED/`.
- [ ] Every file gets sha256 and bytes in `manifest.json`.
- [ ] Failures are listed with their URLs; nothing is silently skipped.

## After

- [ ] Totals reported: files, bytes, failures, skipped as unchanged.
- [ ] `git status` in any nearby repo shows no mirror files.
- [ ] Nothing from the mirror was copied into a repo, a commit, or a shared place.
